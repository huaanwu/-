/**
 * Core.Steward.Allocator — 持仓调配计划生成器 (S4 配资 + 计划)
 *
 * 纯函数 buildPortfolioPlan({cash, holdings, pool, macro}) → StewardPlan
 *
 * 目标:
 *   - 把基金/股票池 + 宏观状态 + 当前持仓 → 具体的"该买/加/减/卖/持"操作清单
 *   - 严格走纪律引擎 (单票上限 / 行业集中 / 现金不足一手不成交 / 缺价不入)
 *   - bear 行情强制 short sleeve 仓位 0
 *   - S5 接管后会拿到窗口里的用户批准驳回事件
 *
 * 加载顺序: 依赖 Core.Constants / Core.Storage, 在 pool.js 之后
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;
  const Const = (Core.Constants) || {};
  const LOT_SIZE = Const.LOT_SIZE || 100;
  const MAX_SINGLE_STOCK_PCT = Const.MAX_SINGLE_STOCK_PCT || 0.20;
  const MAX_SINGLE_INDUSTRY_PCT = Const.MAX_SINGLE_INDUSTRY_PCT || 0.30;
  const STOP_LOSS_RATIO_AUTO = Const.STOP_LOSS_RATIO_AUTO || 0.92;
  const SLEEVE_CAP = 0.50;             // 单 sleeve 仓位上限 (Kelly clamp)
  const BASE_PCT = 0.10;               // Kelly 基线 (满 baseline 仓位)
  const DEFAULT_TOL = 1e-6;
  const EXPERIMENT_CAP = 0.30;         // ST: 实验期 sub-strategy 合计仓位 ≤ sleeve 现金 × 此值
  // KIMI-1: Regime → 短线总仓位上限 (对齐《短线选股策略手册》第三节: 大盘三信号 → 仓位 0/30/50/70%)
  //   bull ≈ 3 绿灯 (70%), range ≈ 1-2 绿灯 (50%), bear ≈ 红灯 (0%)
  //   与现有 BEAR_SHORT_FORBIDDEN (bear short 全禁) 一致, 这里把 range 也封到半仓
  const POSITION_CAP_BY_REGIME = { bull: 0.70, range: 0.50, bear: 0 };

  function _uuid() {
    if (Core.Util && typeof Core.Util.uuid === 'function') return Core.Util.uuid();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /** 限幅: clamp(x, lo, hi) */
  function _clamp(x, lo, hi) {
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  /** Kelly 仓位: baseline × factor × regimeMul, clamp [MIN, SLEEVE_CAP] */
  function _kellyClamp(factor, regimeMul) {
    const f = Number.isFinite(factor) ? _clamp(factor, 0, 1) : 1;
    const r = Number.isFinite(regimeMul) ? _clamp(regimeMul, 0, 2) : 1;
    return _clamp(BASE_PCT * f * r, 0, SLEEVE_CAP);
  }

  /** 计算 sleeve 总资产 (现金 + 持仓市值) */
  function _sleeveTotal(cash, holdings) {
    let mkt = 0;
    for (const h of holdings) {
      const sh = Math.max(0, Number(h.shares) || 0);
      const px = Math.max(0, Number(h.price) || 0);
      mkt += sh * px;
    }
    return Math.max(0, Number(cash) || 0) + mkt;
  }

  /** KIMI-1: 短线总仓位上限 (Regime → 仓位表)
   * 输入 regime + 短线当前状态, 输出本轮新买入可用的现金预算
   * 总仓位 (保留持仓市值 + 新买入) 不得超过 capPct × 短线总资产
   * capped=true 仅当「已有持仓 且 现金被 cap 截断」— 纯空仓现金多不报 (空仓也是仓位)
   * @returns {{budget:number, capPct:number, capped:boolean}}
   *   budget 已 clamp 到 cap 内; capped=true 表示已持仓仍超限, 触发 SHORT_POSITION_CAP_EXCEEDED */
  function _shortCapBudget({ regime, cashShort, retainedShortValue }) {
    const capPct = Number.isFinite(POSITION_CAP_BY_REGIME[regime])
      ? POSITION_CAP_BY_REGIME[regime] : 0.5;
    const cash = Math.max(0, Number(cashShort) || 0);
    const retained = Math.max(0, Number(retainedShortValue) || 0);
    const total = cash + retained;
    const budget = Math.max(0, total * capPct - retained);
    const capped = retained > DEFAULT_TOL && budget < cash - DEFAULT_TOL;
    return { budget, capPct, capped };
  }

  /**
   * 持仓决策: 价格新高 → add, 新低 → trim, 跌超止损 → sell, 默认 hold
   * 需要 cost + 当前 price 比较,没有 high52w/low52w 时用 cost 替代
   */
  function _classifyHolding(h, stopLossRatio) {
    const sh = Math.max(0, Number(h.shares) || 0);
    if (sh === 0) return null;
    const cost = Math.max(0, Number(h.cost) || 0);
    const price = Math.max(0, Number(h.price) || 0);
    if (price === 0) return null;
    // 缺价 (price=0) 不入 targets — 写到 violations
    if (cost === 0) return 'hold';
    const sl = Number.isFinite(stopLossRatio) ? stopLossRatio : STOP_LOSS_RATIO_AUTO;
    // 跌超止损线: 现价 ≤ cost × sl
    if (price <= cost * sl) return 'sell';
    // 假设的"52 周高/低"用 cost 当中心参考: -8% 算新低, +15% 算新高
    if (price >= cost * 1.15) return 'add';
    if (price <= cost * 0.92) return 'trim';
    return 'hold';
  }

  /**
   * 收集 violations, 不做裁剪 (单票/行业超限只告警让人手动处理)
   * @returns {Array<{rule,detail}>}
   */
  function _violations(plan, holdings, pool) {
    const out = [];
    // 单票 — 用 ctx 覆盖后的上限
    const cap = _ctx().maxSingleStockPct;
    const capInd = _ctx().maxSingleIndustryPct;
    const total = _sleeveTotal(0, plan._allHoldings || holdings);
    for (const t of plan.targets) {
      const val = (Number(t.targetAmount) || 0);
      if (total > 0 && val / total > cap + DEFAULT_TOL) {
        out.push({ rule: 'MAX_SINGLE_STOCK_PCT', detail: `${t.code} targetPct=${(val / total).toFixed(3)} > ${cap}` });
      }
    }
    // 行业集中度 — 仅在持仓里有 industry 字段时检查
    const byIndustry = {};
    for (const h of (holdings || [])) {
      const ind = h.industry;
      if (!ind) continue;
      const v = Math.max(0, Number(h.shares) || 0) * Math.max(0, Number(h.price) || 0);
      byIndustry[ind] = (byIndustry[ind] || 0) + v;
    }
    for (const [ind, v] of Object.entries(byIndustry)) {
      if (total > 0 && v / total > capInd + DEFAULT_TOL) {
        out.push({ rule: 'MAX_SINGLE_INDUSTRY_PCT', detail: `行业 ${ind} 占 ${(v / total).toFixed(3)} > ${capInd}` });
      }
    }
    // 缺价不入
    for (const h of (holdings || [])) {
      if (Math.max(0, Number(h.shares) || 0) > 0 && Math.max(0, Number(h.price) || 0) === 0) {
        out.push({ rule: 'MISSING_PRICE', detail: `${h.code} 缺价, 不入 targets` });
      }
    }
    return out;
  }

  // ========== V14 G3: rule_overrides 临时覆盖 ==========

  /** 上下文: 各阈值的 effective 值 (支持临时 override) */
  let _overrideCtx = null;
  function _ctx() {
    if (_overrideCtx) return _overrideCtx;
    _overrideCtx = {
      maxSingleStockPct: MAX_SINGLE_STOCK_PCT,
      maxSingleIndustryPct: MAX_SINGLE_INDUSTRY_PCT,
      stopLossRatioAuto: STOP_LOSS_RATIO_AUTO,
      bearShortForbid: true,
      lotSize: LOT_SIZE,
      basePct: BASE_PCT,
      sleeveCap: SLEEVE_CAP
    };
    return _overrideCtx;
  }

  /** 从 Storage 拉 active overrides 并填充 ctx, 打印 N>0 日志 */
  async function _applyOverrides() {
    const ctx = _ctx();
    let n = 0;
    try {
      if (!window.Core || !Core.Storage) return ctx;
      const all = await Core.Storage.all('rule_overrides');
      const active = (all || []).filter(o => o && o.status === 'active');
      for (const o of active) {
        const v = o.payload && o.payload.value;
        if (v == null) continue;
        if (o.refId === 'MAX_SINGLE_STOCK_PCT' && Number.isFinite(v)) {
          ctx.maxSingleStockPct = _clamp(v, 0, 1);
        } else if (o.refId === 'MAX_SINGLE_INDUSTRY_PCT' && Number.isFinite(v)) {
          ctx.maxSingleIndustryPct = _clamp(v, 0, 1);
        } else if (o.refId === 'STOP_LOSS_RATIO_AUTO' && Number.isFinite(v)) {
          ctx.stopLossRatioAuto = _clamp(v, 0.5, 1);
        } else if (o.refId === 'BASE_PCT' && Number.isFinite(v)) {
          ctx.basePct = _clamp(v, 0, 0.5);
        } else if (o.refId === 'SLEEVE_CAP' && Number.isFinite(v)) {
          ctx.sleeveCap = _clamp(v, 0, 1);
        } else if (o.refId === 'allocator.bearShortForbid') {
          ctx.bearShortForbid = !!v;
        } else if (o.refId === 'LOT_SIZE' && Number.isFinite(v)) {
          ctx.lotSize = Math.max(1, Math.floor(v));
        }
        n++;
      }
    } catch (e) {
      console.warn('[Allocator] 读 rule_overrides 失败:', e);
    }
    // 清缓存: 下次 build 重新读
    _overrideCtx = null;
    if (n > 0) console.log('[Allocator] 应用 ' + n + ' 个 active override');
    return ctx;
  }

  /** 同步重置 — 用于测试或显式重置缓存 */
  function _resetOverrideCtx() { _overrideCtx = null; }

  /**
   * 同步兜底: buildPortfolioPlan 是 sync, 但 _applyOverrides 是 async
   * 这里提供 fire-and-forget 异步刷新 + 同步返回当前缓存
   *   - 已 populate 过 (await _applyOverrides() 先) → 直接用 _ctx() 缓存
   *   - 未 populate → 同步走 _ctx() 默认值, 后台 fire _applyOverrides 刷新下次
   */
  let _pendingRefresh = null;
  function _ensureOverrides() {
    if (_overrideCtx) return _overrideCtx;
    // 已触发后台刷新中 → 等它完成, 但 buildPortfolioPlan 仍 sync 返回默认
    if (_pendingRefresh) return _ctx();
    if (!window.Core || !Core.Storage || typeof Core.Storage.all !== 'function') return _ctx();
    _pendingRefresh = _applyOverrides()
      .then(() => { _pendingRefresh = null; })
      .catch((e) => {
        _pendingRefresh = null;
        console.warn('[Allocator] 后台刷 overrides 失败:', e && e.message || e);
      });
    return _ctx();
  }

  /**
   * 内部用: 由 _recomputePlan 调用, await 一次 overrides 再同步 build
   */
  async function _buildAsync(input) {
    const ctx = await _applyOverrides();
    // 应用 ctx 覆盖到常量 (局部变量, 不污染原 Const)
    const REGIME = ['bull', 'bear', 'range'].includes((input && input.macro && input.macro.regime) || 'range') ? (input.macro.regime) : 'range';
    const factor = Number.isFinite(input && input.macro && input.macro.factor) ? input.macro.factor : 1;
    const regimeMul = Number.isFinite(input && input.macro && input.macro.positionScale) ? input.macro.positionScale : 1;
    const basePctC = _clamp(ctx.basePct * _clamp(factor, 0, 1) * _clamp(regimeMul, 0, 2), 0, ctx.sleeveCap);
    return { ctx, basePctC };
  }

  /**
   * V14 G4: 重跑一条 plan, 返回 { oldPlan, newPlan, diff: { added, removed, changed } }
   * 旧 plan 由外部传入 (从 DB 拉), 新 plan 复用同 input 模板重 build
   * @param {string} planId
   * @param {object} [opts] - { input?: { cash, holdings, pool, macro } } 缺则从 oldPlan 字段反推
   * @returns {Promise<{oldPlan, newPlan, diff: {added, removed, changed}}>}
   */
  async function _recomputePlan(planId, opts) {
    if (!window.Core || !Core.Storage) throw new Error('Storage not ready');
    const oldPlan = await Core.Storage.getStewardPlan(planId);
    if (!oldPlan) throw new Error('recomputePlan: 找不到 planId=' + planId);
    const input = (opts && opts.input) || _rebuildInputFromPlan(oldPlan);
    const newPlan = buildPortfolioPlan(input);
    newPlan.planId = planId; // 复用旧 planId
    newPlan.previousTs = oldPlan.ts;
    const diff = _diffTargets(oldPlan.targets || [], newPlan.targets || []);
    return { oldPlan, newPlan, diff };
  }

  /** 从 plan 反推 input 模板 (best-effort, 用于 _recomputePlan) */
  function _rebuildInputFromPlan(plan) {
    const cash = (plan.cashReserve && {
      real: 0,
      long: Number(plan.cashReserve.long) || 0,
      short: Number(plan.cashReserve.short) || 0
    }) || { real: 0, long: 0, short: 0 };
    const holdings = (plan.targets || []).filter(t => t.action !== 'buy').map(t => ({
      code: t.code, name: t.name, sleeve: t.sleeve,
      shares: (t.shares != null) ? t.shares : 0,
      cost: Number(t.price) || 0,
      price: Number(t.price) || 0
    }));
    const longBuy = (plan.targets || []).filter(t => t.action === 'buy' && t.sleeve === 'long');
    const shortBuy = (plan.targets || []).filter(t => t.action === 'buy' && t.sleeve === 'short');
    const pool = {
      long: longBuy.map((t, i) => ({ code: t.code, name: t.name, rank: i + 1, price: t.price })),
      short: shortBuy.map((t, i) => ({ code: t.code, name: t.name, rank: i + 1, price: t.price }))
    };
    const macro = { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 };
    if (plan.notes) {
      const m = /regime=(\w+)/.exec(plan.notes);
      if (m) macro.regime = m[1];
    }
    return { cash, holdings, pool, macro };
  }

  /** 计算两个 targets 数组的 diff (按 code+sleeve 配对) */
  function _diffTargets(oldT, newT) {
    const key = (t) => (t.sleeve || 'long') + ':' + (t.code || '');
    const oMap = new Map(oldT.map(t => [key(t), t]));
    const nMap = new Map(newT.map(t => [key(t), t]));
    const added = [], removed = [], changed = [];
    for (const [k, n] of nMap) {
      if (!oMap.has(k)) { added.push(n); continue; }
      const o = oMap.get(k);
      // 比较 shares / targetAmount / action
      const oSig = (o.shares || 0) + ':' + (o.targetAmount || 0) + ':' + (o.action || '');
      const nSig = (n.shares || 0) + ':' + (n.targetAmount || 0) + ':' + (n.action || '');
      if (oSig !== nSig) changed.push({ code: n.code, sleeve: n.sleeve, old: o, new: n });
    }
    for (const [k, o] of oMap) {
      if (!nMap.has(k)) removed.push(o);
    }
    return { added, removed, changed };
  }

  /**
   * 主入口: buildPortfolioPlan
   * @param {object} input
   *   cash: { real, long, short }                  三个 sleeve 现金
   *   holdings: [{code,name,sleeve,shares,cost,price}]
   *   pool: { long:[{code,name,rank}], short:[{code,name,rank}] }
   *   macro: { regime, factor, cycleStage, positionScale }
   *   strategies: [{strategyId, sleeve, status, experimentWeeks}]  ST: 子策略清单 (可空 → 老行为)
   * @returns {object} StewardPlan
   */
  function buildPortfolioPlan(input) {
    const cash = (input && input.cash) || { real: 0, long: 0, short: 0 };
    const holdings = Array.isArray(input && input.holdings) ? input.holdings : [];
    const pool = (input && input.pool) || { long: [], short: [] };
    const macro = (input && input.macro) || { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 };
    // ST: 只认 active 的子策略; 空数组/缺省 → 退回 S4 的整 sleeve 分配
    const strategies = (Array.isArray(input && input.strategies) ? input.strategies : [])
      .filter(s => s && s.strategyId && s.status !== 'frozen');
    const experimentCap = Number.isFinite(input && input.experimentCap)
      ? _clamp(input.experimentCap, 0, 1) : EXPERIMENT_CAP;

    // V14 G3: 兜底 — 缓存空时 sync 拉一次 active overrides (走规则 ctx 应用)
    //   真异步路径仍由 _applyOverrides() 提供 (test/UI 可显式 await 提前)
    //   这里 await 不可行 (函数仍 sync); 改用 _ensureOverrides 兜底
    _ensureOverrides();
    const ctx = _ctx();
    const lotSize = ctx.lotSize;

    const regime = ['bull', 'bear', 'range'].includes(macro.regime) ? macro.regime : 'range';
    const factor = Number.isFinite(macro.factor) ? macro.factor : 1;
    const regimeMul = Number.isFinite(macro.positionScale) ? macro.positionScale : 1;
    const basePct = _clamp(ctx.basePct * _clamp(factor, 0, 1) * _clamp(regimeMul, 0, 2), 0, ctx.sleeveCap);

    // 1) 已有持仓 → 决定 hold / add / trim / sell
    const targets = [];
    const violations = [];
    for (const h of holdings) {
      const sleeve = (h.sleeve === 'short') ? 'short' : 'long';
      const sh = Math.max(0, Number(h.shares) || 0);
      const cost = Math.max(0, Number(h.cost) || 0);
      const price = Math.max(0, Number(h.price) || 0);
      if (sh === 0) continue;                        // 空持仓跳过
      if (price === 0) {
        violations.push({ rule: 'MISSING_PRICE', detail: `${h.code} 缺价, 不入 targets` });
        continue;
      }
      const action = _classifyHolding(h, ctx.stopLossRatioAuto) || 'hold';
      const marketValue = sh * price;
      const targetPct = basePct;                     // 仓位目标 = sleeve 内均分
      const targetAmount = targetPct * (cash[sleeve] + marketValue);
      const shares = action === 'sell' ? 0 : sh;
      const tradeShares = action === 'sell'
        ? sh
        : (action === 'trim' ? Math.max(1, Math.floor(sh / 3))
          : (action === 'add' ? lotSize : 0));
      targets.push({
        code: h.code,
        name: h.name || h.code,
        sleeve,
        strategy: h.strategy || 'manual',
        action,
        holdingId: h.id || null,
        currentShares: sh,
        tradeShares,
        decisionStatus: 'pending',
        targetPct: +targetPct.toFixed(4),
        targetAmount: +targetAmount.toFixed(2),
        shares,
        price,
        reason: action === 'sell'
          ? `现价 ≤ cost×${ctx.stopLossRatioAuto}, 触发止损`
          : (action === 'add' ? '价格新高 (≥ cost×1.15), 加仓'
            : (action === 'trim' ? '价格新低 (≤ cost×0.92), 减仓'
              : '持仓维持, 观察')),
        ruleRefs: ['MAX_SINGLE_STOCK_PCT', 'STOP_LOSS_RATIO_AUTO']
      });
    }

    // 2) 已有 sleeve 的 cash 余额 → 按 pool 顺序分配新票
    const sleeveCashLeft = {
      long: Math.max(0, Number(cash.long) || 0),
      short: Math.max(0, Number(cash.short) || 0)
    };
    for (const t of targets) {
      // 卖出回收现金 (假设按当前价, 后续实盘再扣费用)
      if (t.action === 'sell') {
        sleeveCashLeft[t.sleeve] += Math.max(0, Number(t.tradeShares) || 0) * Math.max(0, Number(t.price) || 0);
      }
      // 减仓释放部分现金 (按 trim 释放 1/3 仓位估算)
      if (t.action === 'trim') {
        const release = Math.max(0, Number(t.tradeShares) || 0) * Math.max(0, Number(t.price) || 0);
        sleeveCashLeft[t.sleeve] += release;
      }
    }

    // 已持仓 codeSet — 跳过 pool 里重复的
    const heldCodes = new Set(holdings.map(h => h.code));

    // 3) 新票分配 (按 rank 顺序)
    // budget: 本轮最多能花的钱 (缺省 = sleeve 剩余现金); items: 候选池 (缺省 = 整个 sleeve 池)
    // 返回本轮实际花掉的金额
    function _dispatch(sleeve, budget, itemsIn, tag) {
      const items = Array.isArray(itemsIn) ? itemsIn : (Array.isArray(pool[sleeve]) ? pool[sleeve] : []);
      let left = Number.isFinite(budget) ? Math.min(budget, sleeveCashLeft[sleeve]) : sleeveCashLeft[sleeve];
      let spent = 0;
      const sorted = items.slice().sort((a, b) => (a.rank || 0) - (b.rank || 0));
      for (const it of sorted) {
        if (!it || !it.code) continue;
        if (heldCodes.has(it.code)) continue;
        // bear 行情: short 强制 0 (可被 override allocator.bearShortForbid=false 关闭)
        if (sleeve === 'short' && regime === 'bear' && ctx.bearShortForbid) {
          violations.push({ rule: 'BEAR_SHORT_FORBIDDEN', detail: `bear 行情跳过 short sleeve 新票 ${it.code}` });
          continue;
        }
        const px = Math.max(0, Number(it.price) || 0);
        if (px === 0) {
          violations.push({ rule: 'MISSING_PRICE', detail: `${it.code} (pool) 缺价, 跳过` });
          continue;
        }
        // 现金不足一手 (lotSize 由 ctx.lotSize 提供, 可被 override) → 跳过
        const lots = Math.floor(left / (px * lotSize));
        if (lots <= 0) {
          violations.push({ rule: 'INSUFFICIENT_CASH', detail: `${it.code} 现金不足一手 (${left.toFixed(2)} < ${(px * lotSize).toFixed(2)})` });
          continue;
        }
        const shares = lots * lotSize;
        const amount = shares * px;
        left -= amount;
        spent += amount;
        sleeveCashLeft[sleeve] -= amount;
        heldCodes.add(it.code);           // 同一票不被两个子策略重复买
        targets.push({
          code: it.code,
          name: it.name || it.code,
          sleeve,
          strategy: it.strategy || null,
          action: 'buy',
          holdingId: null,
          currentShares: 0,
          tradeShares: shares,
          decisionStatus: 'pending',
          targetPct: +basePct.toFixed(4),
          targetAmount: +amount.toFixed(2),
          shares,
          price: px,
          reason: `Pool rank #${it.rank || '?'}, 分配 ${lots} 手${tag ? ` [${tag}]` : ''}`,
          ruleRefs: ['LOT_SIZE', 'MAX_SINGLE_STOCK_PCT']
        });
      }
      return spent;
    }

    /**
     * ST: 一个 sleeve 内按 sub-strategy 分桶下单
     *   - 实验期 (experimentWeeks>0) 子策略合计预算 ≤ sleeve 现金 × experimentCap
     *   - 非实验期子策略等权瓜分剩下的 sleeve 现金
     */
    // KIMI-1: short sleeve 总仓位上限 — 计算本轮可花预算, clamp 现金 + 记录 capped
    // 返回 { budget, capPct, capped }; capped=true 时已推 violation
    function _clampShortCap() {
      if (shortCapInfo) return shortCapInfo;
      const retained = holdings
        .filter(h => (h.sleeve || 'long') === 'short')
        .reduce((s, h) => s + Math.max(0, Number(h.shares) || 0) * Math.max(0, Number(h.price) || 0), 0);
      const sb = _shortCapBudget({ regime, cashShort: cash.short, retainedShortValue: retained });
      shortCapInfo = sb;
      if (sb.capped) {
        violations.push({
          rule: 'SHORT_POSITION_CAP_EXCEEDED',
          detail: `Kimi 手册大盘开关: ${regime} 短线仓位上限 ${(sb.capPct * 100).toFixed(0)}%, 现金 ${cash.short.toFixed(2)} 超预算 ${sb.budget.toFixed(2)}, 新买入被截断`
        });
        sleeveCashLeft.short = Math.min(sleeveCashLeft.short, sb.budget);
      }
      return sb;
    }

    function _dispatchBySubStrategy(sleeve) {
      const mine = strategies.filter(s => s.sleeve === sleeve);
      if (mine.length === 0) { _dispatch(sleeve); return; }

      // KIMI-1: short sleeve 先应用总仓位上限 (clamp 现金, 可能推 violation)
      if (sleeve === 'short') _clampShortCap();

      const startCash = sleeveCashLeft[sleeve];
      const items = Array.isArray(pool[sleeve]) ? pool[sleeve] : [];
      const byStrategy = new Map();
      for (const it of items) {
        if (!it || !it.strategy) continue;
        if (!byStrategy.has(it.strategy)) byStrategy.set(it.strategy, []);
        byStrategy.get(it.strategy).push(it);
      }

      const experimental = mine.filter(s => Number(s.experimentWeeks) > 0);
      const formal = mine.filter(s => !(Number(s.experimentWeeks) > 0));

      // 实验期总盘子 (硬上限)
      const expBudgetTotal = startCash * experimentCap;
      const expEach = experimental.length > 0 ? expBudgetTotal / experimental.length : 0;
      let expSpent = 0;
      for (const s of experimental) {
        const bucket = byStrategy.get(s.strategyId) || [];
        if (bucket.length === 0) {
          violations.push({ rule: 'SUB_STRATEGY_EMPTY', detail: `${s.strategyId} (${sleeve}) 实验期但股池里没有归属它的候选` });
          continue;
        }
        expSpent += _dispatch(sleeve, expEach, bucket, s.strategyId);
      }
      if (expSpent > expBudgetTotal + DEFAULT_TOL) {
        violations.push({
          rule: 'SUB_STRATEGY_OVERFLOW',
          detail: `${sleeve} 实验期子策略合计 ${expSpent.toFixed(2)} > 上限 ${expBudgetTotal.toFixed(2)} (cap=${experimentCap})`
        });
      }

      // 非实验期: 等权瓜分剩余现金
      const formalPool = sleeveCashLeft[sleeve];
      const formalEach = formal.length > 0 ? formalPool / formal.length : 0;
      for (const s of formal) {
        const bucket = byStrategy.get(s.strategyId) || [];
        if (bucket.length === 0) {
          violations.push({ rule: 'SUB_STRATEGY_EMPTY', detail: `${s.strategyId} (${sleeve}) 正式生效但股池里没有归属它的候选` });
          continue;
        }
        _dispatch(sleeve, formalEach, bucket, s.strategyId);
      }
    }

    // KIMI-1: 当前 short 仓位上限快照 (供 notes/测试读)
    let shortCapInfo = null;

    if (strategies.length > 0) {
      _dispatchBySubStrategy('long');
      _dispatchBySubStrategy('short');
    } else {
      _dispatch('long');
      // KIMI-1: 无子策略分支 — _dispatch('short') 前先应用总仓位上限
      _clampShortCap();
      _dispatch('short');
    }

    // 4) 单票超限 violations (保留警告不裁剪)
    const enrichedViolations = _violations({ targets, _allHoldings: holdings }, holdings, pool).concat(violations);

    return {
      asOf: new Date().toISOString(),
      runId: _uuid(),
      targets,
      cashReserve: {
        long: +sleeveCashLeft.long.toFixed(2),
        short: +sleeveCashLeft.short.toFixed(2)
      },
      violations: enrichedViolations,
      notes: `regime=${regime} factor=${factor} cycleStage=${macro.cycleStage || ''} basePct=${basePct.toFixed(3)}`
        + (shortCapInfo ? ` shortCap=${(shortCapInfo.capPct * 100).toFixed(0)}% capped=${shortCapInfo.capped}` : '')
    };
  }

  // 暴露
  window.Core.Steward = window.Core.Steward || {};
  window.Core.Steward.Allocator = {
    buildPortfolioPlan,
    _recomputePlan,
    _applyOverrides,
    _ensureOverrides,
    _resetOverrideCtx,
    _diffTargets,
    _rebuildInputFromPlan,
    _kellyClamp,
    _sleeveQuota: _sleeveTotal,
    _classifyHolding,
    _violations,
    _shortCapBudget,
    POSITION_CAP_BY_REGIME,
    EXPERIMENT_CAP
  };

  console.log('[Steward/Allocator] 配资计划生成器已就绪 (S4 + V14 G3/G4 + ST 子策略)');
})();
