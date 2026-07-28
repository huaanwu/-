/**
 * LongTrader - AI 长线操盘手 (Phase L)
 * 跟 T2-T5 短线操盘手形成一快一慢双层, 长期 sleeve 自动选股 + 自动成交
 *
 * 设计:
 *   - 30 分钟轮询, 检查触发条件: 周一 + 距上次 ≥ RERUN_DAYS 天 + long sleeve 现金 ≥ MIN_CASH
 *   - 拉全市场行情 → 取涨跌幅前 30 → LLM 解读挑 TOP_N picks
 *   - 每只调 Paper.autoTradeFromPick({ code, name, sleeve: 'long' })
 *     → 纪律引擎自动卡 (单票上限/月度回撤/重复错误) → 写 transactions (auto:true)
 *   - 决策日志: kv paper_long_trader_log (上限 LONG_TRADER_LOG_LIMIT, 滚动截断)
 *   - 最后运行: kv paper_long_trader_last { date, ts } 防重复
 *
 * 不接实盘: 只操作 isPaper=true && sleeve==='long' 模拟盘
 * 跟 T2-T3 短线 (sleeve='short') 物理隔离, 互不影响
 */
(function() {
  'use strict';

  const CHECK_MS = Core.Constants.LONG_TRADER_CHECK_MS;
  const TOP_N = Core.Constants.LONG_TRADER_TOP_N;
  const HARD_TOP = Core.Constants.LONG_TRADER_HARD_SCREEN_TOP;
  const RERUN_DAYS = Core.Constants.LONG_TRADER_RERUN_DAYS;
  const MIN_CASH = Core.Constants.LONG_TRADER_MIN_CASH;
  const LOG_LIMIT = Core.Constants.LONG_TRADER_LOG_LIMIT;
  const LOG_KEY = 'paper_long_trader_log';
  const LAST_RUN_KEY = 'paper_long_trader_last';

  const LongTrader = {

    _timers: { check: null },
    _setInterval: (fn, ms) => setInterval(fn, ms),
    _clearInterval: (t) => clearInterval(t),
    _running: false,

    async init() {
      // 启动时跑一轮 (不阻塞, 失败吞)
      this.runNow().catch(e => console.warn('[LongTrader] 启动失败:', e));
      // 30 分钟轮询
      if (!this._timers.check) {
        this._timers.check = this._setInterval(
          () => this.runNow().catch(e => console.warn('[LongTrader] 轮询失败:', e)),
          CHECK_MS
        );
      }
      // Phase L1: 启动时跑一轮 verify (不阻塞, 失败吞)
      this.verifyLongTrades().catch(e => console.warn('[LongTrader] 启动 verify 失败:', e));
    },

    stopPolling() {
      if (this._timers.check) { this._clearInterval(this._timers.check); this._timers.check = null; }
    },

    /**
     * 跑一轮长线选股 (公开给 app.js init / 手动调用)
     * 流程: 检查触发 → 拉行情 → 硬筛 top 30 → LLM 挑 TOP_N → 调 Paper.autoTradeFromPick
     * 整轮异常吞, 失败不影响下次
     */
    async runNow(opts = {}) {
      if (this._running) return;
      this._running = true;
      try {
        const now = opts.now || new Date();
        // 1. 触发条件: 周一 + 距上次 ≥ RERUN_DAYS 天
        const lastRun = (await Core.Storage.kvGet(LAST_RUN_KEY)) || null;
        if (!this._shouldRun(now, lastRun && lastRun.ts)) return;
        // 2. long sleeve 现金下限
        const acc = await Paper._getAccountRaw('long');
        if ((acc.cash || 0) < MIN_CASH) {
          console.log(`[LongTrader] long sleeve 现金 ${acc.cash} < ${MIN_CASH}, 跳过`);
          return;
        }
        // Bug #1 修复 (跑空防护): 跑前用 _planAutoTrade 探测 1 手 30 元股能否成交
        // 比硬定 MIN_CASH 数字更鲁棒 — 30 元是中盘股典型价, 1 手 3000 块 + 仓位 10% 要求 ≥ 3 万 cash
        // 现金不够买 1 手 → 跳过, 避免 LLM 推 N 只全部 autoTradeFromPick 返 null
        // (此处的 30 元是兜底值, 等 sorted 算完后会用中位价重新探测一次)
        const testSharesProbe = Paper._planAutoTrade(acc.cash, acc.positionPct || 0.10, 30);
        if (!testSharesProbe || testSharesProbe < Core.Constants.LOT_SIZE) {
          console.log(`[LongTrader] 现金 ${acc.cash} × ${acc.positionPct || 0.10} 买不起 1 手 30 元股, 跳过`);
          return;
        }
        // Bug #2 修复 (Regime gate): 熊市 → 跳过, 防买在反弹半山腰
        try {
          const rec = await Core.Regime.get();
          const gate = Core.Regime.gateMultipliers();
          if (rec && rec.state === 'bear' && gate && gate.positionScale <= 0.5) {
            console.log(`[LongTrader] Regime bear + positionScale ${gate.positionScale} < 0.5, 跳过`);
            return;
          }
        } catch (e) { console.warn('[LongTrader] Regime 检查跳过:', e); }
        // 3. 拉全市场行情
        let all;
        try {
          all = await Core.Data.getStockSpot();
        } catch (e) {
          console.warn('[LongTrader] 拉全市场行情失败:', e);
          return;
        }
        if (!Array.isArray(all) || all.length === 0) return;
        // Bug #3 修复 (排除已持仓): 防反复追涨已持仓 (靠纪律引擎挡单票上限是兜底,
        // 但用户疑惑"为啥又推同一只" — 直接从候选池里去掉)
        let heldCodes = new Set();
        try {
          const held = (await Paper._getPaperHoldings('long')) || [];
          heldCodes = new Set(held.map(h => h.code).filter(Boolean));
        } catch (e) { /* */ }
        // 4. 简单硬筛: 换手率 ≥ 1% (有真实成交) + 不在已持仓
        //    Bug #6 修复: 弃用'涨跌幅 > 0' (与长线理念冲突), 改用流动性指标
        //    长线 sleeve 也要避免长期不动的僵尸股
        const sorted = all
          .filter(s => s && s.代码 && s.名称 && parseFloat(s.换手率 || 0) >= 1 && !heldCodes.has(s.代码))
          .sort((a, b) => parseFloat(b.涨跌幅) - parseFloat(a.涨跌幅))
          .slice(0, HARD_TOP);
        if (sorted.length === 0) return;
        // Bug #5 修复 (跑空防护): 用 sorted 池中位价估算, 适配茅台/低价股
        const samplePrice = (() => {
          const prices = sorted.map(s => parseFloat(s.最新价 || s.收盘 || 0)).filter(p => p > 0).sort((a, b) => a - b);
          if (prices.length === 0) return 30;
          return prices[Math.floor(prices.length / 2)];
        })();
        const testShares = Paper._planAutoTrade(acc.cash, acc.positionPct || 0.10, samplePrice);
        if (!testShares || testShares < Core.Constants.LOT_SIZE) {
          console.log(`[LongTrader] 现金 ${acc.cash} × ${acc.positionPct || 0.10} 买不起 1 手 ${samplePrice.toFixed(2)} 元股 (池中位价), 跳过`);
          return;
        }
        // Phase 5: 预拉前 30 只基本面 (并发 5 逐批)
        let finMap = new Map();
        try {
          finMap = await Core.Data.getStockFinancialBatch(sorted.map(s => s.代码));
        } catch (e) { console.warn('[LongTrader] 基本面拉取失败:', e); }
        // Phase 5 Commit D: 批量拉行业归属
        let industryMap = new Map();
        try {
          industryMap = await Core.Data.getStockIndustryBatch(sorted.map(s => s.代码));
        } catch (e) { console.warn('[LongTrader] 行业拉取失败:', e); }
        // Phase 5 Commit C: 基本面硬筛 — 排除 ROE<5% 和毛利率<10%
        const finFiltered = [];
        for (const s of sorted) {
          const raw = finMap.get(s.代码);
          if (!raw) { finFiltered.push(s); continue; }
          const fe = _extractFundamentals(raw);
          if (!fe) { finFiltered.push(s); continue; }
          if (fe.roe != null && fe.roe < 5) continue;
          if (fe.grossProfitMargin != null && fe.grossProfitMargin < 10) continue;
          finFiltered.push(s);
        }
        // Bug #4 修复: finFiltered < 3 只时, 不要再全部用 sorted 回退
        // 至少剔除已确认不达标的 (有数据但 ROE<5%/毛利率<10%)
        let pool;
        if (finFiltered.length >= 3) {
          pool = finFiltered;
        } else {
          const knownBadCodes = new Set();
          for (const s of sorted) {
            const raw = finMap.get(s.代码);
            if (!raw) continue;
            const fe = _extractFundamentals(raw);
            if (fe && ((fe.roe != null && fe.roe < 5) || (fe.grossProfitMargin != null && fe.grossProfitMargin < 10)))
              knownBadCodes.add(s.代码);
          }
          const filtered = sorted.filter(s => !knownBadCodes.has(s.代码));
          console.warn(`[LongTrader] 基本面硬筛仅通过 ${finFiltered.length} 只, 回退到 ${filtered.length} 只 (剔除已知不达标 ${knownBadCodes.size} 只)`);
          pool = filtered;
        }
        if (pool.length === 0) return;
        // Phase 5 Commit D: 行业集中度检测
        let heldList = [];
        try {
          heldList = (await Paper._getPaperHoldings('long')) || [];
        } catch (e) { /* 无需处理 */ }
        // Bug #1 修复: industryMap 必须覆盖 sorted + heldList 去重并集
        // (否则已持仓但不在今日 top30 的股票, 行业市值会被漏算)
        const allCodes = [...new Set([
          ...sorted.map(s => s.代码),
          ...heldList.map(h => h.code).filter(Boolean)
        ])];
        try {
          industryMap = await Core.Data.getStockIndustryBatch(allCodes);
        } catch (e) { console.warn('[LongTrader] 行业补拉失败:', e); }
        const heldByInd = {};
        for (const h of heldList) {
          const ind = industryMap.get(h.code);
          if (ind) heldByInd[ind] = (heldByInd[ind] || 0) + (h.mkt || 0);
        }
        const totalAssets = acc.cash + (acc.stockMkt || 0);
        const indCap = 0.25;                                    // 单个行业 ≤ 25%
        // 5. LLM 挑 TOP_N (带基本面)
        const picks = await this._llmPickTop(pool, TOP_N, finMap);
        if (!picks || picks.length === 0) return;
        // 6. 自动成交到 long sleeve (纪律引擎自动卡)
        const cashBefore = acc.cash;
        const results = [];
        // Bug #2 修复: 维护 cashRemaining, 每成交一只后扣减, 行业 cap 用递减后的现金重算
        let cashRemaining = acc.cash;
        for (const p of picks) {
          // Phase 5 Commit D: 行业集中度 cap 检测
          const pInd = industryMap.get(p.code);
          if (pInd) {
            const currentIndValue = heldByInd[pInd] || 0;
            const pMkt = acc.positionPct * cashRemaining;       // 估算单票买入市值 (用递减后的现金)
            if ((currentIndValue + pMkt) / totalAssets > indCap) {
              console.log('[LongTrader] ' + p.code + ' 行业 ' + pInd + ' 集中度超标,跳过');
              results.push({ code: p.code, name: p.name, ok: false, reason: p.reason, error: '行业集中度超标' });
              continue;
            }
            // 占位: 即便通过 cap, 也要在 heldByInd 里先记账, 下一只同行业的能正确感知
            heldByInd[pInd] = currentIndValue + pMkt;
          }
          try {
            const h = await Paper.autoTradeFromPick({ code: p.code, name: p.name, sleeve: 'long' });
            results.push({ code: p.code, name: p.name, ok: !!h, reason: p.reason, costPrice: h && h.costPrice, shares: h && h.shares });
            // Phase L1: 写 journal 行 (verify 后续归因用)
            if (h) await this._writeLongJournal({ ...p, costPrice: h.costPrice, shares: h.shares });
          } catch (e) {
            console.warn(`[LongTrader] autoTradeFromPick 失败 ${p.code}:`, e);
            results.push({ code: p.code, name: p.name, ok: false, reason: p.reason, error: String(e.message || e) });
          }
        }
        // 7. 写决策日志
        const accAfter = await Paper._getAccountRaw('long');
        await this._appendLog({
          ts: Date.now(),
          date: fmtDate(now),
          trigger: opts.manual ? 'manual' : 'scheduled',
          picks: results,
          cashBefore,
          cashAfter: accAfter.cash,
          cashUsed: +(cashBefore - accAfter.cash).toFixed(2)
        });
        // 8. 记录最后运行
        await Core.Storage.kvSet(LAST_RUN_KEY, { date: fmtDate(now), ts: Date.now() });
      } catch (e) {
        console.warn('[LongTrader] 跑一轮失败:', e);
      } finally {
        this._running = false;
      }
    },

    /**
     * 触发判定: 周一 + 距上次 ≥ RERUN_DAYS 天 (纯函数可测)
     * @param {Date} now 当前时间
     * @param {number} lastRunTs 上次运行时间戳 (ms), 无则视为从未跑过
     */
    _shouldRun(now, lastRunTs) {
      if (!now) return false;
      const day = now.getDay();
      if (day !== 1) return false;  // 周一 (周日=0, 周一=1)
      if (lastRunTs) {
        const daysSince = (now.getTime() - lastRunTs) / (24 * 60 * 60 * 1000);
        if (daysSince < RERUN_DAYS) return false;
      }
      return true;
    },

    /**
     * LLM 解读: 从硬筛池挑 TOP_N
     * @returns {Promise<Array<{code, name, reason}>|null>}
     */
    async _llmPickTop(stocks, topN, finMap) {
      try {
        const list = stocks.map((s, i) => {
          const code = s.代码;
          const name = s.名称;
          const chg = parseFloat(s.涨跌幅).toFixed(2);
          const turn = parseFloat(s.换手率 || 0).toFixed(2);
          const mcap = parseFloat(s.总市值 || 0);
          const mcapStr = isNaN(mcap) || mcap === 0 ? '?' : (mcap / 1e8).toFixed(1) + '亿';
          // Phase 5: 基本面
          let finPart = '';
          if (finMap && finMap instanceof Map) {
            const raw = finMap.get(s.代码);
            if (raw) {
              const fe = _extractFundamentals(raw);
              if (fe) {
                finPart = ` | ROE=${fe.roe ?? '?'}% PE=${fe.pe ?? '?'} PB=${fe.pb ?? '?'} 毛利=${fe.grossProfitMargin ?? '?'}%`;
              }
            }
          }
          return `[${i}] ${code} ${name} | 涨跌幅=${chg}% | 换手=${turn}% | 市值=${mcapStr}${finPart}`;
        }).join('\n');

        // H3 大盘状态机 (commit 6): 仅一行提示, 不影响 schema (只返 {code, name, reason})
        // 长线 sleeve 也没自动仓位系数 (acc.positionPct 是固定的), 只供 LLM 在趋势/下跌市收紧
        let regimeLine = '【大盘状态】默认震荡市';
        try {
          if (window.Core && Core.Regime && Core.Regime.gateMultipliers) {
            const g = Core.Regime.gateMultipliers();
            regimeLine = `【大盘状态】${g.label} (${g.state})${g.stale ? ' ⚠ 数据源失灵' : ''}, 仓位系数 ×${g.positionScale}, ${g.state === 'bear' ? '仅胜率显著才加仓' : (g.state === 'bull' ? '趋势市正常加仓' : '震荡市严控新仓')}`;
          }
        } catch (e) { console.warn('[LongTrader] regime 取值失败:', e); }

        // P3 全系统学习池
        let poolText = '';
        try {
          poolText = (await Core.LearningPool.format()) || '';
        } catch (e) { console.warn('[LongTrader] 学习池渲染失败:', e); }

        const systemPrompt = '你是 A 股长线选股助手, 帮用户从硬筛池里挑 ' + topN + ' 只作为本周模拟盘长线 sleeve 的买入标的。' +
          '\n- 选有真实上涨逻辑的 (题材/业绩/资金/技术突破)' +
          '\n- 优先选市值 ≥ 50 亿的 (流动性好)' +
          '\n- 候选池已按换手率 ≥ 1% 过滤 (有真实成交), 可在池内自由挑选不看单日涨幅' +
          '\n- 优先选 ROE > 10% 且 PE 不极端（< 80）的（盈利质量）' +
          '\n- 避免选高负债率（> 70%）且 ROE < 5% 的（价值陷阱）' +
          '\n- 硬筛已排除: ROE < 5%、毛利率 < 10% 的股票' +
          '\n- 排除 ST/退市风险股' +
          '\n' + regimeLine +
          (poolText ? '\n- 【全系统学习池】' + poolText.replace(/\n/g, ' ').slice(0, 200) : '') +
          '\n- 输出严格 JSON, 不要其他文字';

        const userPrompt = `硬筛池 (今日涨幅前 ${stocks.length}):

	${list}

	输出 JSON:
	{
	  "picks": [
	    { "code": "000001", "name": "平安银行", "reason": "一句话理由" }
	  ]
	}
	只输出 picks 数组 (${topN} 只以内), 不要其他字段。`;

        const raw = await Core.AI.callWithTimeout({
          systemPrompt,
          prompt: userPrompt,
          temperature: 0.5,
          maxTokens: 800,
          timeoutMs: 60000,
          page: 'long-trader',
          purpose: 'long-trader-pick'
        });
        if (!raw) return null;
        const parsed = await Core.AI.parseJsonOutput(raw, 'long-trader');
        if (!parsed || !parsed.ok || !parsed.obj) return null;
        const arr = (parsed.obj.picks || []);
        const bullPicks = arr.slice(0, topN).map(p => ({
          code: String(p.code || '').padStart(6, '0'),
          name: String(p.name || ''),
          reason: String(p.reason || '').slice(0, 200)
        })).filter(p => /^\d{6}$/.test(p.code));
        if (bullPicks.length === 0) return null;

        // Phase 5 Commit B: Bear agent 双视角辩论 — 质疑 bull 选股
        let warnings = [];
        try {
          warnings = await this._bearReview(bullPicks);
        } catch (e) { console.warn('[LongTrader] bear 审查失败:', e); }

        // 综合: 过滤 high-severity 警告的 picks, medium/low 只标记不剔除
        const final = bullPicks.filter(p => {
          const w = warnings.find(w => w.code === p.code);
          return !w || w.severity !== 'high';
        });
        // 对 medium/low 警告注入 reason 后缀
        for (const p of final) {
          const w = warnings.find(w => w.code === p.code);
          if (w && w.severity !== 'high') p.reason += ' ⚠' + w.risk;
        }
        return final;
      } catch (e) {
        console.warn('[LongTrader] LLM pick 失败:', e);
        return null;
      }
    },

    /**
     * Phase 5 Commit B: Bear agent — 质疑 bull 选股的价值陷阱/成长陷阱
     */
    async _bearReview(picks) {
      const candidates = picks.map((p, i) => '[' + i + '] ' + p.code + ' ' + p.name + ' — bull认为:' + p.reason).join('\n');
      const prompt = '你是风控专家, 对以下 bull agent 的选股提出质疑, 找价值陷阱/成长陷阱/追高风险:\n\n' +
        candidates + '\n\n针对每只, 判断:\n' +
        '- value_trap: ROE<5% 的高负债股票, 低 PE 陷阱\n' +
        '- growth_trap: 高市盈率但盈利质量差\n' +
        '- chase_risk: 近期涨幅过大, 追高在半山腰\n\n' +
        '输出 JSON: { "warnings": [{ "code": "000001", "risk": "简短风险描述", "severity": "high"|"medium"|"low" }] }\n' +
        '无风险则 warnings: []。只输出 JSON。';
      const raw = await Core.AI.callWithTimeout({
        prompt,
        temperature: 0.3,
        maxTokens: 800,
        timeoutMs: 60000,
        page: 'long-trader',
        purpose: 'long-trader-bear'
      });
      if (!raw) return [];
      const parsed = await Core.AI.parseJsonOutput(raw, 'long-trader-bear');
      if (!parsed || !parsed.ok || !parsed.obj) return [];
      const arr = parsed.obj.warnings || [];
      return arr.map(w => ({
        code: String(w.code || '').padStart(6, '0'),
        risk: String(w.risk || '').slice(0, 100),
        severity: ['high', 'medium', 'low'].includes(w.severity) ? w.severity : 'low'
      })).filter(w => /^\d{6}$/.test(w.code));
    },

    /**
     * Phase 5 Commit D: 持股再评估 — 检查持有逻辑是否仍成立
     */
    async reviewHoldings() {
      try {
        const held = (await Paper._getPaperHoldings('long')) || [];
        if (held.length === 0) return { reviewed: 0, actions: [] };
        const codes = held.map(h => h.code).filter(Boolean);
        const finMap = await Core.Data.getStockFinancialBatch(codes);
        const actions = [];
        for (const h of held) {
          const raw = finMap.get(h.code);
          if (!raw) continue;
          const fe = _extractFundamentals(raw);
          if (!fe) continue;
          // 恶化信号: ROE < 3% 或毛利率 < 5%
          if ((fe.roe != null && fe.roe < 3) || (fe.grossProfitMargin != null && fe.grossProfitMargin < 5)) {
            actions.push({ code: h.code, name: h.name, action: 'reduce', reason: '基本面恶化: ROE=' + fe.roe + '% 毛利率=' + fe.grossProfitMargin + '%' });
          }
        }
        console.log('[LongTrader] reviewHoldings:', actions.length + '/' + held.length + ' 需处理');
        return { reviewed: held.length, actions };
      } catch (e) {
        console.warn('[LongTrader] reviewHoldings 失败:', e);
        return { reviewed: 0, actions: [] };
      }
    },

    async _appendLog(entry) {
      try {
        const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
        list.push(entry);
        await Core.Storage.kvSet(LOG_KEY, list.slice(-LOG_LIMIT));
      } catch (e) {
        console.warn('[LongTrader] 写日志失败:', e);
      }
    },

    /** 决策日志列表 (UI 用, 按时间倒序) */
    async listLog(limit) {
      const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
      const sorted = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return limit ? sorted.slice(0, limit) : sorted;
    },

    // ========== Phase L1: 长线业绩归因 (journal + 机械 verify + 8 类归因) ==========

    /**
     * 写长线建仓 journal (sleeve='long', auto=true), 跟 T3 _writeCondJournal 模式一致
     * @param {{code, name, reason, costPrice, shares, entryDate}} pick - autoTradeFromPick 返的持仓行
     */
    async _writeLongJournal(pick) {
      if (!pick || !pick.code) return null;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cost = parseFloat(pick.costPrice || pick.price || 0);
        const shares = parseInt(pick.shares || 0, 10);
        const reason = String(pick.reason || 'AI 长线选股').slice(0, 200);
        const content = '# AI 长线自动建仓\n\n' +
          '- 代码: ' + pick.code + '\n' +
          '- 名称: ' + (pick.name || '') + '\n' +
          '- 成本价: ¥' + cost.toFixed(2) + '\n' +
          '- 股数: ' + shares + ' (' + (shares / 100) + '手)\n' +
          '- 选股理由: ' + reason + '\n' +
          '- 成交日期: ' + today + '\n\n' +
          '> 本条由 LongTrader 自动写入, 后续 verify 用于归因';
        const row = {
          id: 'lt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          date: today,
          title: '📈 长线建仓: ' + pick.code + ' ' + (pick.name || ''),
          content,
          code: pick.code,
          assumption: reason,
          emotion: 'neutral',
          verify: 'pending',
          verifyOutcome: null,
          sleeve: 'long',
          auto: true,
          costPrice: cost,
          shares,
          entryDate: today,
          createdAt: Date.now()
        };
        await Core.Storage.add('journals', row);
        return row;
      } catch (e) {
        console.warn('[LongTrader] 写 journal 失败:', e);
        return null;
      }
    },

    /**
     * 长线归因纯函数 (复用 VERIFY_FAILURE_REASONS 8 类, 长线简化为 3 类)
     * @param {number} pnlPct 浮盈浮亏 (小数, 0.05=5%)
     * @returns {{outcome: 'correct'|'wrong'|'partial', reason: string}}
     */
    _judgeLongOutcome(pnlPct) {
      const thr = Core.Constants.LONG_VERIFY_THRESHOLD_PCT;
      const badThr = Core.Constants.LONG_VERIFY_THRESHOLD_BAD_PCT;
      const goodThr = Core.Constants.LONG_VERIFY_TIMING_GOOD_PCT;
      if (!isFinite(pnlPct)) return { outcome: 'partial', reason: '数据不足' };
      if (pnlPct >= goodThr) return { outcome: 'correct', reason: 'timingGood' };
      if (pnlPct >= thr) return { outcome: 'correct', reason: '选股对' };
      if (pnlPct <= -badThr) return { outcome: 'wrong', reason: '假设错误' };
      if (pnlPct <= -thr) return { outcome: 'wrong', reason: '选股错' };
      return { outcome: 'partial', reason: '时机过早' };
    },

    /**
     * 长线 verify 主流程: 拉 journal 表, long+auto+无 verify 的, 拉后续 K 线判定 outcome
     */
    async verifyLongTrades(opts = {}) {
      const daysBack = parseInt(opts.daysBack) || 90;
      const now = opts.now || new Date();
      const fetcher = opts.fetcher || (Core.Data && Core.Data.getStockKLine);
      if (typeof fetcher !== 'function') {
        console.warn('[LongTrader] verifyLongTrades 缺 fetcher, 跳过');
        return { scanned: 0, verified: 0, skipped: 0 };
      }
      const todayStr = (function(d) {
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      })(now);
      let scanned = 0, verified = 0, skipped = 0;
      try {
        const all = (await Core.Storage.all('journals')) || [];
        const cutoff = (function(d) {
          const dt = new Date(d.getTime() - daysBack * 24 * 3600 * 1000);
          return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
        })(now);
        const targets = all.filter(function(j) {
          return j && (j.sleeve || '') === 'long' && j.auto === true
            && j.code && j.entryDate && j.entryDate >= cutoff && j.entryDate < todayStr
            && (!j.verifyOutcome || j.verifyOutcome === null);
        });
        for (const j of targets) {
          scanned++;
          try {
            // adjust='': 显式用不复权真实价格 (与 costPrice 对账, 避免分红配股带来的偏差)
            const kline = await fetcher(j.code, 'daily', undefined, undefined, '').catch(function() { return null; });
            if (!Array.isArray(kline) || kline.length < 5) { skipped++; continue; }
            const closes = kline.map(function(b) { return parseFloat(b.收盘 || b.close); }).filter(function(c) { return c > 0; });
            if (closes.length < 5) { skipped++; continue; }
            const dates = kline.map(function(b) { return String(b.日期 || b.date || '').slice(0, 10); });
            const entryIdx = dates.findIndex(function(d) { return d >= j.entryDate; });
            if (entryIdx < 0 || entryIdx >= closes.length) { skipped++; continue; }
            const entryPrice = j.costPrice || closes[entryIdx];
            const lastPrice = closes[closes.length - 1];
            if (!(entryPrice > 0) || !(lastPrice > 0)) { skipped++; continue; }
            const pnlPct = (lastPrice - entryPrice) / entryPrice;
            const outcome = this._judgeLongOutcome(pnlPct);
            await Core.Storage.update('journals', j.id, {
              verifyOutcome: outcome.outcome,
              verifyFailureReason: outcome.reason,
              verifiedAt: Date.now(),
              pnlPct: +pnlPct.toFixed(4),
              lastPrice: +lastPrice.toFixed(2)
            });
            verified++;
          } catch (e) {
            console.warn('[LongTrader] verify ' + j.code + ' 失败:', e.message || e);
            skipped++;
          }
        }
        return { scanned, verified, skipped };
      } catch (e) {
        console.warn('[LongTrader] verifyLongTrades 总流程失败:', e);
        return { scanned, verified, skipped };
      }
    },

    /**
     * 长线成绩单 (按 reason 关键词分组胜率)
     */
    _buildLongTrackRecord(trades) {
      const list = (Array.isArray(trades) ? trades : []).filter(function(t) { return t && t.outcome; });
      const minSamples = Core.Constants.LONG_VERIFY_MIN_SAMPLES;
      if (list.length < minSamples) return null;
      var catOf = function(r) {
        var s = String(r || '');
        if (/题材|概念|事件/.test(s)) return '题材';
        if (/业绩|财报|利润|营收/.test(s)) return '业绩';
        if (/资金|流入|主力|北向/.test(s)) return '资金';
        if (/技术|突破|均线|金叉/.test(s)) return '技术';
        return '其他';
      };
      var score = function(o) { return o === 'correct' ? 1 : (o === 'partial' ? 0.5 : 0); };
      var groups = {};
      for (var t = 0; t < list.length; t++) {
        var tr = list[t];
        var cat = catOf(tr.reason);
        var g = groups[cat] || (groups[cat] = { total: 0, scoreSum: 0, pnlSum: 0, reasons: {} });
        g.total++;
        g.scoreSum += score(tr.outcome);
        g.pnlSum += (tr.pnlPct || 0);
        if (tr.reason) g.reasons[tr.reason] = (g.reasons[tr.reason] || 0) + 1;
      }
      var byReason = Object.entries(groups).map(function(entry) {
        var cat = entry[0], g = entry[1];
        return {
          category: cat,
          total: g.total,
          correctRate: +(g.scoreSum / g.total).toFixed(2),
          avgPnl: +(g.pnlSum / g.total * 100).toFixed(2),
          topReason: Object.entries(g.reasons).sort(function(a, b) { return b[1] - a[1]; })[0]?.[0] || null
        };
      }).sort(function(a, b) { return b.total - a.total; });
      var totalScore = list.reduce(function(s, t) { return s + score(t.outcome); }, 0);
      return {
        total: list.length,
        correctRate: +(totalScore / list.length).toFixed(2),
        byReason
      };
    },

    /**
     * Phase L1.6: 渲染长线业绩归因卡片 (挂载 #longTraderTrackSection, 模拟盘长线 tab)
     * - 拉 journal 表: long + auto + 有 verifyOutcome
     * - 调 _buildLongTrackRecord 聚合
     * - 样本 < 3 → 显示 "积累中" 提示
     * - 全程 escapeHtml, 错误吞 (不阻塞 renderPage)
     */
    async renderTrackRecord() {
      const el = document.getElementById('longTraderTrackSection');
      if (!el) return;
      try {
        const all = (await Core.Storage.all('journals')) || [];
        const trades = all
          .filter(j => j && (j.sleeve || '') === 'long' && j.auto === true
                  && j.verifyOutcome && j.pnlPct != null)
          .map(j => ({
            code: j.code,
            reason: j.assumption || '',
            outcome: j.verifyOutcome,
            pnlPct: j.pnlPct,
            verifiedAt: j.verifiedAt || 0
          }));
        const minSamples = Core.Constants.LONG_VERIFY_MIN_SAMPLES;
        const rec = this._buildLongTrackRecord(trades);
        if (!rec) {
          const scanned = trades.length;
          const remain = Math.max(0, minSamples - scanned);
          el.style.display = '';
          el.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">📊 长线业绩归因</div>' +
            '<div style="font-size:12px;color:var(--text-muted);">已 verify ' + scanned +
            ' 笔, 积累中 (还差 ' + remain + ' 笔达到最低样本 ' + minSamples + ')</div>';
          return;
        }
        // 累计 verify 笔数 + 综合胜率
        const pctClass = (window.Core && Core.Util && Core.Util.pctClass)
          || ((x) => x > 0 ? 'var(--up)' : (x < 0 ? 'var(--down)' : 'var(--text-muted)'));
        const esc = (s) => Core.Util.escapeHtml(String(s));
        const rows = rec.byReason.map(r =>
          '<tr>' +
            '<td style="padding:4px 8px;">' + esc(r.category) + '</td>' +
            '<td style="padding:4px 8px;text-align:right;">' + r.total + '</td>' +
            '<td style="padding:4px 8px;text-align:right;color:' + pctClass(r.correctRate - 0.5) + ';">' +
              (r.correctRate * 100).toFixed(0) + '%</td>' +
            '<td style="padding:4px 8px;text-align:right;color:' + pctClass(r.avgPnl / 100) + ';">' +
              (r.avgPnl >= 0 ? '+' : '') + r.avgPnl.toFixed(2) + '%</td>' +
            '<td style="padding:4px 8px;color:var(--text-muted);font-size:11px;">' +
              esc(r.topReason || '-') + '</td>' +
          '</tr>'
        ).join('');
        el.style.display = '';
        el.innerHTML =
          '<div style="font-weight:600;margin-bottom:8px;">📊 长线业绩归因</div>' +
          '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">' +
            '累计 verify <b>' + rec.total + '</b> 笔, 综合胜率 ' +
            '<b style="color:' + pctClass(rec.correctRate - 0.5) + ';">' +
            (rec.correctRate * 100).toFixed(0) + '%</b>' +
            ' (correct=1 / partial=0.5 / wrong=0)' +
          '</div>' +
          '<table style="width:100%;font-size:12px;border-collapse:collapse;">' +
            '<thead><tr style="border-bottom:1px solid var(--border-color, #333);">' +
              '<th style="padding:4px 8px;text-align:left;">类型</th>' +
              '<th style="padding:4px 8px;text-align:right;">笔数</th>' +
              '<th style="padding:4px 8px;text-align:right;">胜率</th>' +
              '<th style="padding:4px 8px;text-align:right;">平均涨跌</th>' +
              '<th style="padding:4px 8px;text-align:left;">主因</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>';
      } catch (e) {
        console.warn('[LongTrader] renderTrackRecord 失败:', e);
        el.style.display = 'none';
      }
    }
  };

  /**
   * 从 stock_financial_abstract 提取关键字段 (同 stock-advisor.js _extractFundamentals)
   */
  function _extractFundamentals(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const fields = {
      pe: ['市盈率', 'PE', 'pe', 'pe_ttm'],
      pb: ['市净率', 'PB', 'pb'],
      roe: ['净资产收益率', 'ROE', 'roe', '加权平均净资产收益率'],
      grossProfitMargin: ['销售毛利率', '毛利率'],
      revenueGrowth: ['营业总收入同比增长', '营收增速', 'revenue_yoy'],
      netProfitGrowth: ['净利润同比增长', '净利增速', 'profit_yoy']
    };
    const out = {};
    for (const [k, keys] of Object.entries(fields)) {
      for (const key of keys) {
        if (raw[key] != null && !isNaN(parseFloat(raw[key]))) {
          out[k] = parseFloat(raw[key]);
          break;
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  window.LongTrader = LongTrader;
})();
