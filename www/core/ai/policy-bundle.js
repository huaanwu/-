/**
 * Core.AI.PolicyBundle — 宏观策略注入层 (P6.2)
 *
 * 把 5 个已经存在的模块缝合成一个 sleeve 专属的「宏观策略指令块」,
 * 4 个 strategy handler (long / short / fund / alerts) 在调 LLM 前
 * await PolicyBundle.load({strategy, ctx}) → 拿到一段 markdown,
 * 直接拼到 systemPrompt 头部,代替现在各自散落的 Regime/Cycle/StateMatrix/KB/MAO 拼接。
 *
 * 关联模块(已存在,本文件只读不写):
 *   Core.Regime        → gateMultipliers() / _formatRegimeBlock()   (同步, 含 stale)
 *   Core.Cycle         → getCyclePosition() / formatForPrompt()      (异步, 5 维宏观)
 *   Core.StateMatrix   → getPositionScale() / formatForPrompt()      (异步, 价×时 12 格)
 *   Core.KB            → get(category) / pickRelevant(opts) / formatForPrompt()
 *   Core.Discipline    → getConfig()                                  (异步, 合并 kv)
 *   Core.Constants     → LONG_TRADER_TOP_N
 *   Core.AI.Orchestrator 内部已有 _loadMaoDiscipline (3 agent 共用),
 *                       但 agents strategy 走 Orchestrator,本文件不替代它。
 *
 * 设计要点:
 *   1. 失败全兜底, 任一上游抛错都返 '数据不可用' 占位文本, 不阻断 sleeve 主流程
 *   2. 不抢 Orchestrator 的 MAO 拼接 — agents strategy 仍走 Orchestrator._loadMaoDiscipline
 *   3. sleeve 仓位系数表内嵌 (regime state × sleeve 风险偏好 → factor)
 *   4. sleeve 专属 KB category 由 _kbCategoriesFor(strategy) 选, 不让 caller 传
 *   5. toSystemPrompt() 返**纯字符串**, caller 模板字符串或数组 join 都行
 *   6. 测试用 vm sandbox + stub window.Core, 不依赖 DOM/IndexedDB
 *
 * 加载顺序: 必须 Core.Regime + Core.Cycle + Core.StateMatrix + Core.KB + Core.Discipline + Core.Constants 之后
 *
 * P6.x 已知差异 vs Kimi 蓝图:
 *   - Kimi 是单层 detector; stock-master 多 sleeve, 需要 sleeve-specific factor 表
 *   - Kimi 是 Python DuckDB; 我们是 Dexie, 跨进程要走 IndexedDB cache
 *   - Kimi 的 position_factor 是单值; 我们的 factor 是 sleeve × regime 二维表的乘积
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  // ========== 常量 (13 个 KB category 实际值, kb.categories() 只返 7 个老的) ==========
  const ALL_KB_CATEGORIES = [
    'valuation', 'risk', 'cycle', 'position', 'policy',
    'behavior', 'case', 'fixed_income', 'fund',
    'rule', 'discipline', 'macro_signal', 'history_analog'
  ];

  // sleeve → 4 个 KB category (按 strategy 偏好选)
  const KB_BY_STRATEGY = {
    long:   ['valuation', 'cycle', 'position', 'risk'],
    short:  ['risk', 'behavior', 'case', 'macro_signal'],
    fund:   ['fund', 'fixed_income', 'policy', 'macro_signal'],
    alerts: ['risk', 'policy', 'macro_signal', 'history_analog'],
    agents: ['cycle', 'risk', 'position', 'behavior', 'policy']
  };

  // sleeve → regime → 仓位系数 (Kimi 1.0/0.6/0.2 的 sleeve 特化版)
  // 注: Regime.gateMultipliers.positionScale 是 baseline, 这里按 sleeve 风险偏好加权
  //   long  (扛熊市)   bull=1.0 / range=0.7 / bear=0.3
  //   short (不抢反弹) bull=0.8 / range=0.6 / bear=0.0 (熊市不开仓)
  //   fund  (按月调)   bull=1.0 / range=0.8 / bear=0.5
  //   alerts (提醒照常) bull=1.0 / range=1.0 / bear=1.0 (提醒不仓位化)
  const FACTOR_TABLE = {
    long:   { bull: 1.0, range: 0.7, bear: 0.3 },
    short:  { bull: 0.8, range: 0.6, bear: 0.0 },
    fund:   { bull: 1.0, range: 0.8, bear: 0.5 },
    alerts: { bull: 1.0, range: 1.0, bear: 1.0 }
  };
  const FACTOR_DEFAULT = 0.6;

  // MAO 7 条硬编码 fallback (Orchestrator._loadMaoDiscipline 同源, PolicyBundle 单独维护一份)
  const MAO_FALLBACK = `## 交易纪律元规则 (毛选 + 行为金融提炼)
1. **抓主要矛盾** (《矛盾论》): 每轮牛熊只抓 1-2 个主线, 不撒胡椒面; 拒绝「平均分配仓位」
2. **没有调查就没有发言权** (《调查研究》): 每只票必须看过 PE 自身历史分位 + 行业产能 + 公告才给结论, 没数据不交易
3. **集中优势兵力** (《战略战术》): 研究池 ≤50 只, 单只仓位 ≤2%, 不均摊; 重仓高确定性
4. **敌进我退** (《论持久战》): 跌破 20 日线 / -8% 强制止损, 不抢反弹; 熊市状态强制降仓
5. **持久战哲学** (《论持久战》): 长期池以年为单位持有, 不被日线波动带偏; 短期池快进快出
6. **实事求是** (《矛盾论》): 拒绝套用通用策略; 每只票单独判断 4 阶段 (周期/估值/资金/消息)
7. **反人性** (行为金融): 警惕处置效应/确认偏误/沉没成本/回本妄想/锚定/FOMO, 这些是你的本能陷阱, 不是「坚持」`;

  // ========== 内部 helper ==========

  /** 安全取 Core.X.Y() — 失败返 fallback */
  async function _safe(name, fn, fallback) {
    try {
      const v = await fn();
      if (v == null) return fallback;
      return v;
    } catch (e) {
      console.warn('[PolicyBundle] ' + name + ' 取值失败:', e && e.message || e);
      return fallback;
    }
  }

  /** 兼容 browser / vm sandbox: 取 Core 命名空间, window.Core 优先 */
  function _Core() {
    return (typeof window !== 'undefined' && window.Core) || (typeof Core !== 'undefined' ? Core : null);
  }

  /** 取 sleeve 仓位系数 (regime × sleeve 风险偏好) */
  function _factorFor(strategy, regimeState) {
    const sleeveTable = FACTOR_TABLE[strategy] || {};
    const factor = sleeveTable[regimeState];
    return typeof factor === 'number' ? factor : FACTOR_DEFAULT;
  }

  /** 取 sleeve 专属 KB category 列表 */
  function _kbCategoriesFor(strategy) {
    return KB_BY_STRATEGY[strategy] || ['risk'];
  }

  /**
   * 拿 sleeve 配置 (从 Discipline 合并的 config + Constants 补字段)
   * 长线 topN 走 Constants, 短线的 maxDailyTrades/cooldownHours 走 Discipline.short 子段
   */
  async function _sleeveConfig(strategy) {
    const out = { strategy, topN: 3, maxDailyTrades: null, cooldownHours: null,
                  maxSingleStockPct: null, maxTotalPositionPct: null,
                  chaseWarnPct: null, maxMonthlyDrawdownPct: null };
    const C = _Core();
    // 从 Constants 拿 long topN
    try {
      if (strategy === 'long' && C && C.Constants && C.Constants.LONG_TRADER_TOP_N) {
        out.topN = C.Constants.LONG_TRADER_TOP_N;
      }
    } catch (e) { /* 静默 */ }
    // 从 Discipline 拿全量字段
    try {
      if (C && C.Discipline && typeof C.Discipline.getConfig === 'function') {
        const cfg = await C.Discipline.getConfig();
        if (cfg) {
          if (cfg.maxSingleStockPct != null) out.maxSingleStockPct = cfg.maxSingleStockPct;
          if (cfg.maxTotalPositionPct != null) out.maxTotalPositionPct = cfg.maxTotalPositionPct;
          if (cfg.chaseWarnPct != null) out.chaseWarnPct = cfg.chaseWarnPct;
          if (cfg.maxMonthlyDrawdownPct != null) out.maxMonthlyDrawdownPct = cfg.maxMonthlyDrawdownPct;
          if (cfg.short) {
            if (cfg.short.maxDailyTrades != null) out.maxDailyTrades = cfg.short.maxDailyTrades;
            if (cfg.short.cooldownHours != null) out.cooldownHours = cfg.short.cooldownHours;
          }
        }
      }
    } catch (e) {
      console.warn('[PolicyBundle] sleeveConfig 拉取失败:', e && e.message || e);
    }
    return out;
  }

  /** 拼 sleeve 配额段 (markdown) */
  function _quotaBlock(sleeveCfg, factor) {
    const lines = [];
    lines.push('## sleeve 配额与仓位系数');
    lines.push(`- **当前策略**: ${sleeveCfg.strategy}`);
    if (sleeveCfg.topN != null) lines.push(`- **选股 topN**: ${sleeveCfg.topN} 只`);
    if (sleeveCfg.maxSingleStockPct != null) lines.push(`- **单票集中度上限**: ${(sleeveCfg.maxSingleStockPct * 100).toFixed(0)}%`);
    if (sleeveCfg.maxTotalPositionPct != null) lines.push(`- **总仓位上限**: ${(sleeveCfg.maxTotalPositionPct * 100).toFixed(0)}%`);
    if (sleeveCfg.chaseWarnPct != null) lines.push(`- **追高警戒线**: 当日涨幅 > ${(sleeveCfg.chaseWarnPct * 100).toFixed(0)}%`);
    if (sleeveCfg.maxMonthlyDrawdownPct != null) lines.push(`- **月度回撤熔断**: ${(sleeveCfg.maxMonthlyDrawdownPct * 100).toFixed(0)}%`);
    if (sleeveCfg.maxDailyTrades != null) lines.push(`- **短线每日最大笔数**: ${sleeveCfg.maxDailyTrades} 笔`);
    if (sleeveCfg.cooldownHours != null) lines.push(`- **短线同票冷却**: ${sleeveCfg.cooldownHours} 小时`);
    lines.push(`- **当前宏观仓位系数**: ×${factor.toFixed(2)} (regime × sleeve 风险偏好)`);
    lines.push(`- **解读**: 宏观判定 → 仓位系数 → 实际下仓时按 maxSingleStockPct × positionScale 算建议仓位`);
    return lines.join('\n');
  }

  /** 拼 sleeve 专属 KB 段 (markdown) */
  function _kbBlock(strategy, kbEntries) {
    if (!kbEntries || kbEntries.length === 0) return '';
    const C = _Core();
    const cats = _kbCategoriesFor(strategy).join(', ');
    const lines = [];
    lines.push('## sleeve 专属知识库 (来自 KB, 引用条目号)');
    lines.push(`- **本 sleeve 关注类目**: ${cats}`);
    // 复用 Core.KB.formatForPrompt 已有格式 (含 CATEGORY_ICON + 来源标签)
    if (C && C.KB && typeof C.KB.formatForPrompt === 'function') {
      lines.push(C.KB.formatForPrompt(kbEntries));
    } else {
      for (const e of kbEntries) {
        lines.push(`- **${e.id} ${e.title || ''}**: ${(e.summary || '').split(/[。\n]/)[0]}`);
      }
    }
    return lines.join('\n');
  }

  /** 拼毛选元规则 (markdown) — 复用 Orchestrator 同源逻辑 */
  async function _maoBlock() {
    const C = _Core();
    try {
      if (C && C.KB && typeof C.KB.get === 'function') {
        const entries = await C.KB.get('rule');
        const mao = (entries || []).filter(e => /^MAO-/.test(e.id));
        if (mao && mao.length > 0) {
          const lines = ['## 交易纪律元规则 (毛选提炼, 从 KB.rule 取)'];
          mao.sort((a, b) => a.id.localeCompare(b.id)).forEach(e => {
            lines.push(`- **${e.id} ${e.title}**: ${(e.summary || '').split(/[。\n]/)[0]}`);
          });
          return lines.join('\n');
        }
      }
    } catch (e) {
      console.warn('[PolicyBundle] MAO 加载失败, 用 fallback:', e && e.message || e);
    }
    return MAO_FALLBACK;
  }

  // ========== 主入口 ==========

  /**
   * 加载一个 strategy 的完整宏观策略指令块
   * @param {object} opts
   * @param {'long'|'short'|'fund'|'alerts'} opts.strategy
   * @param {object} [opts.ctx] - 业务上下文 (sleeve 资产/持仓等), 当前未用, 保留扩展位
   * @returns {Promise<{
   *   strategy: string,
   *   regime: {state, label, positionScale, stale}|null,
   *   cycle: object|null,
   *   stateMatrix: object|null,
   *   factor: number,
   *   sleeveConfig: object,
   *   kbEntries: Array,
   *   maoBlock: string,
   *   toSystemPrompt: () => string
   * }>}
   */
  async function load(opts) {
    const o = opts || {};
    const strategy = (o.strategy && typeof o.strategy === 'string') ? o.strategy.toLowerCase() : 'agents';
    const C = _Core();

    // 1. 拉 sleeve 配置 (long/short/fund/alerts 配额)
    const sleeveConfig = await _sleeveConfig(strategy);

    // 2. 拉 Regime (同步, 含 stale 兜底)
    let regime = null;
    try {
      if (C && C.Regime && typeof C.Regime.gateMultipliers === 'function') {
        regime = C.Regime.gateMultipliers();
      }
    } catch (e) {
      console.warn('[PolicyBundle] Regime 拉取失败:', e && e.message || e);
    }
    if (!regime) {
      regime = { state: 'range', label: '震荡市', positionScale: 0.6, stale: false, staleFailures: 0, indices: {} };
    }

    // 3. 拉 Cycle + StateMatrix (异步)
    const cycle = await _safe('Cycle', () => (C && C.Cycle && C.Cycle.getCyclePosition ? C.Cycle.getCyclePosition() : null), null);
    const stateMatrix = await _safe('StateMatrix', () => (C && C.StateMatrix && C.StateMatrix.getPositionScale ? C.StateMatrix.getPositionScale() : null), null);

    // 4. 算 sleeve-specific 仓位系数
    const factor = _factorFor(strategy, regime.state);

    // 5. 取 sleeve 专属 KB (兜底 5 类)
    let kbEntries = [];
    try {
      if (C && C.KB && typeof C.KB.get === 'function') {
        const cats = _kbCategoriesFor(strategy);
        const all = await C.KB.get();
        const list = Array.isArray(all) ? all : [];
        kbEntries = list
          .filter(e => cats.includes(e.category))
          .slice(0, 5);  // 上限 5 条避免 prompt 暴涨
      }
    } catch (e) {
      console.warn('[PolicyBundle] KB 取条失败:', e && e.message || e);
    }

    // 6. 拿毛选元规则
    const maoBlock = await _maoBlock();

    // 7. 拼 systemPrompt 字符串 (caller 直接拼到自己的模板里)
    function toSystemPrompt() {
      const lines = [];
      // (a) 毛选元规则 (放最前, 战略层先于战术)
      lines.push(maoBlock);
      lines.push('');
      // (b) Regime 大盘状态
      try {
        if (C && C.Regime && typeof C.Regime._formatRegimeBlock === 'function') {
          lines.push(C.Regime._formatRegimeBlock());
        } else {
          lines.push(`## 大盘状态机 (Regime)\n当前: ${regime.label} (${regime.state}), 仓位系数 ×${regime.positionScale || 0.6}${regime.stale ? ' (⚠ 数据源失灵)' : ''}`);
        }
      } catch (e) { /* 静默 */ }
      lines.push('');
      // (c) Cycle 宏观周期
      try {
        if (cycle && C && C.Cycle && typeof C.Cycle.formatForPrompt === 'function') {
          const t = C.Cycle.formatForPrompt(cycle);
          if (t) { lines.push(t); lines.push(''); }
        }
      } catch (e) { /* 静默 */ }
      // (d) StateMatrix 价×时
      try {
        if (stateMatrix && C && C.StateMatrix && typeof C.StateMatrix.formatForPrompt === 'function') {
          const t = C.StateMatrix.formatForPrompt(stateMatrix);
          if (t) { lines.push(t); lines.push(''); }
        }
      } catch (e) { /* 静默 */ }
      // (e) sleeve 配额与仓位系数 (PolicyBundle 独有)
      lines.push(_quotaBlock(sleeveConfig, factor));
      lines.push('');
      // (f) sleeve 专属 KB
      const kbB = _kbBlock(strategy, kbEntries);
      if (kbB) { lines.push(kbB); lines.push(''); }
      return lines.join('\n');
    }

    return {
      strategy,
      regime,
      cycle,
      stateMatrix,
      factor,
      sleeveConfig,
      kbEntries,
      maoBlock,
      toSystemPrompt
    };
  }

  // ========== 暴露 ==========
  window.Core.AI = window.Core.AI || {};
  window.Core.AI.PolicyBundle = {
    load,
    // 测试用: 暴露常量
    _FACTOR_TABLE: FACTOR_TABLE,
    _KB_BY_STRATEGY: KB_BY_STRATEGY,
    _ALL_KB_CATEGORIES: ALL_KB_CATEGORIES,
    _FACTOR_DEFAULT: FACTOR_DEFAULT,
    _MAO_FALLBACK: MAO_FALLBACK,
    // 测试用: 暴露 helper
    _factorFor,
    _kbCategoriesFor,
    _sleeveConfig,
    _quotaBlock,
    _kbBlock,
    _maoBlock,
    _safe,
    // V9: KBFeedback 应用 reorder 时调这个 setter 改 KB_BY_STRATEGY (内存生效)
    _setKbOrder(strategy, newOrder) {
      if (!strategy || !Array.isArray(newOrder)) return false;
      KB_BY_STRATEGY[strategy] = newOrder.slice();
      return true;
    }
  };
})();