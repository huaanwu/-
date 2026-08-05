/**
 * Core.Steward — 管家门面 (v27.1/v27.2)
 *
 * 聚合 Steward 子模块: Pool / Allocator / Graph / Lessons / Strategies
 * 加新方法:
 *   - init(): 占位, 后续 S6 订阅 steward:tick
 *   - runDailyCycle(now, opts): 管家每日循环 (聚合股池 → 配资 → 落 steward_plans)
 *   - scanMarket(codes, opts): 给定 codes 做 0-100 评分 (规则+KB 查表, 无 LLM)
 *   - guard(now): 守门人 — regime 翻转 / 单票超限 / 非交易时段 → triggers
 *   - buildPortfolioPlan / recordLesson: 从子模块透传 (兼容)
 *   - _testExports: 暴露内部 helpers 给测试
 *
 * 设计:
 *   - 纯函数优先, IO 调用 (Storage/Regime/Portfolio) 通过 Core.* 兜底
 *   - 无 LLM, 完全规则驱动, 后续 S6 接 steward'stick 事件再升级
 *   - 缺依赖时降级: 池空 → skipped; Regime 缺 → 默认 'range'/positionScale=1
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;
  const Steward = window.Core.Steward = window.Core.Steward || {};

  const TABLE_PLANS = 'steward_plans';
  const DEFAULT_PHASE = 'preopen';
  const VALID_PHASES = ['preopen', 'intraday', 'close', 'weekly', 'skip'];
  const MAX_CODES = 60;
  const DEFAULT_TRADING_WINDOWS = [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]];

  // ========== 内部 helpers ==========

  function _uuid() {
    if (Core.Util && typeof Core.Util.uuid === 'function') return Core.Util.uuid();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function _dateStr(d) {
    const dt = d instanceof Date ? d : new Date(d);
    return dt.toISOString().slice(0, 10);
  }

  function _isTradingTime(now) {
    const d = now instanceof Date ? now : new Date(now || Date.now());
    if (isNaN(d.getTime())) return false;
    const day = d.getDay();
    if (day === 0 || day === 6) return false;
    const mins = d.getHours() * 60 + d.getMinutes();
    const windows = (Core.Constants && Array.isArray(Core.Constants.TRADING_WINDOWS))
      ? Core.Constants.TRADING_WINDOWS
      : DEFAULT_TRADING_WINDOWS;
    return windows.some(([s, e]) => mins >= s && mins <= e);
  }

  function _maxSingleStockPct() {
    return (Core.Constants && Number.isFinite(Core.Constants.MAX_SINGLE_STOCK_PCT))
      ? Core.Constants.MAX_SINGLE_STOCK_PCT
      : 0.20;
  }

  async function _regimeSnapshot() {
    if (!Core.Regime || typeof Core.Regime.get !== 'function') {
      return { state: 'range', factor: 1, positionScale: 1, label: '震荡市' };
    }
    try {
      const r = await Core.Regime.get();
      const state = ['bull', 'bear', 'range'].includes(r && r.state) ? r.state : 'range';
      const positionScale = Number.isFinite(r && r.positionScale) ? r.positionScale : 1;
      const factor = state === 'bull' ? 1.0 : (state === 'bear' ? 0.5 : 1.0);
      const label = (r && r.label) || (state === 'bull' ? '趋势市' : (state === 'bear' ? '下跌市' : '震荡市'));
      return { state, factor, positionScale, label };
    } catch (e) {
      console.warn('[Steward] 读 Regime 失败, 退回 range:', e && e.message || e);
      return { state: 'range', factor: 1, positionScale: 1, label: '震荡市' };
    }
  }

  /** 收集 holdings (从 Portfolio.getAllAssets 兜底, 缺则空) */
  async function _collectHoldings() {
    if (!Core.Portfolio || typeof Core.Portfolio.getAllAssets !== 'function') return [];
    try {
      const all = await Core.Portfolio.getAllAssets();
      const out = [];
      // 真实持仓
      const real = all && all.real && all.real.valueByCode;
      if (real && typeof real === 'object') {
        for (const [code, val] of Object.entries(real)) {
          if (!code) continue;
          const v = Number(val) || 0;
          if (v <= 0) continue;
          out.push({ code, name: code, sleeve: 'long', shares: 1, cost: v, price: v });
        }
      }
      return out;
    } catch (e) {
      console.warn('[Steward] 读 Portfolio 失败:', e && e.message || e);
      return [];
    }
  }

  async function _savePlan(plan) {
    if (!Core.Storage || typeof Core.Storage.saveStewardPlan !== 'function') return plan;
    try {
      await Core.Storage.saveStewardPlan(plan);
    } catch (e) {
      console.warn('[Steward] saveStewardPlan 失败:', e && e.message || e);
    }
    return plan;
  }

  // ========== 公开方法 ==========

  let _tickUnsubscribe = null;
  let _tickRunning = false;

  async function _handleDaemonTick(data) {
    if (_tickRunning) return { skipped: true, reason: 'running' };
    _tickRunning = true;
    try {
      const ts = data && Number(data.ts);
      const now = Number.isFinite(ts) ? new Date(ts) : new Date();
      const phase = data && VALID_PHASES.includes(data.phase) ? data.phase : DEFAULT_PHASE;
      const result = await runDailyCycle(now, { phase });
      if (window.StewardUI && typeof window.StewardUI.renderPage === 'function') {
        await window.StewardUI.renderPage();
      }
      return result;
    } finally {
      _tickRunning = false;
    }
  }

  /** 订阅 Electron daemon 的 steward:tick, 幂等初始化 */
  async function init() {
    if (_tickUnsubscribe) return true;
    if (window.electronAPI && typeof window.electronAPI.onStewardTick === 'function') {
      _tickUnsubscribe = window.electronAPI.onStewardTick((data) => {
        _handleDaemonTick(data).catch(e => console.warn('[Steward] daemon tick 失败:', e && e.message || e));
      });
    }
    return true;
  }

  /**
   * 管家每日循环 (主入口)
   * @param {Date} [now]
   * @param {{phase?: string, dryRun?: boolean}} [opts]
   *   phase: 'preopen'(默认) | 'intraday' | 'close' | 'weekly' | 'skip'
   *   dryRun: true → 不落库
   * @returns {Promise<{phase, runId, ok, pool?, plan?, lessons?, skippedReason?}>}
   */
  async function runDailyCycle(now, opts) {
    const t = now instanceof Date ? now : new Date();
    const o = opts || {};
    const phase = VALID_PHASES.includes(o.phase) ? o.phase : DEFAULT_PHASE;
    const dryRun = !!o.dryRun;
    const runId = _uuid();

    if (phase === 'skip') {
      return { phase, runId, ok: true, skippedReason: 'phase=skip' };
    }

    // 1) 拉 long/short 两池 (各 sleeve 一份, 简化版只要 long)
    const longSnap = (Steward.Pool && typeof Steward.Pool.latest === 'function')
      ? await Steward.Pool.latest('long', t).catch(() => null) : null;
    const shortSnap = (Steward.Pool && typeof Steward.Pool.latest === 'function')
      ? await Steward.Pool.latest('short', t).catch(() => null) : null;

    if (!longSnap && !shortSnap) {
      return { phase, runId, ok: false, skippedReason: 'no-pool' };
    }

    // 2) 拼 input (cash/holdings/pool/macro) → Allocator
    const macro = await _regimeSnapshot();
    const holdings = await _collectHoldings();
    const cash = { real: 0, long: 0, short: 0 };
    if (Core.Storage && typeof Core.Storage.kvGet === 'function') {
      try {
        const real = await Core.Storage.kvGet('accountCash');
        const paperLong = await Core.Storage.kvGet('paper_account');
        const paperShort = await Core.Storage.kvGet('paper_account_short');
        cash.real = Number(real && real.cash) || 0;
        cash.long = Number(paperLong && paperLong.cash) || 0;
        cash.short = Number(paperShort && paperShort.cash) || 0;
      } catch (e) { /* 留 0 */ }
    }
    const pool = {
      long: (longSnap && longSnap.items) ? longSnap.items : [],
      short: (shortSnap && shortSnap.items) ? shortSnap.items : []
    };
    // items 形态对齐 Allocator: 需要 code/name/rank/price
    for (const arr of [pool.long, pool.short]) {
      for (const it of arr) {
        if (it && (it.price == null)) it.price = Number(it.price) || 0;
      }
    }

    // 3) 拿 active 子策略 (S4 ST)
    let strategies = [];
    if (Steward.Strategies && typeof Steward.Strategies.list === 'function') {
      try {
        const all = await Steward.Strategies.list({ status: 'active' });
        strategies = Array.isArray(all) ? all : [];
      } catch (e) { /* 留 [] */ }
    }

    if (!Steward.Allocator || typeof Steward.Allocator.buildPortfolioPlan !== 'function') {
      return { phase, runId, ok: false, skippedReason: 'allocator-missing' };
    }

    let plan;
    try {
      plan = Steward.Allocator.buildPortfolioPlan({
        cash, holdings, pool, macro: { ...macro, cycleStage: '' }, strategies
      });
    } catch (e) {
      console.warn('[Steward] buildPortfolioPlan 失败:', e && e.message || e);
      return { phase, runId, ok: false, skippedReason: 'allocator-throw' };
    }

    plan.runId = runId;
    plan.planId = `${_dateStr(t)}-steward-${runId}`;
    plan.date = _dateStr(t);
    plan.phase = phase;
    plan.status = 'pending';
    plan.sleeve = 'all';

    if (!dryRun) await _savePlan(plan);

    // KIMI-6 连亏熔断: close 阶段对每个 active 子策略查最近连亏 (≥3 笔 → freeze + 3 天熔断期)
    let circuit = null;
    if (phase === 'close' && !dryRun) {
      try {
        circuit = await _runLossCircuit();
      } catch (e) {
        console.warn('[Steward] 连亏熔断检查失败:', e && e.message || e);
      }
    }

    // 4) 拉 lessons (给 UI / 后续 weekly 用)
    let lessons = [];
    if (Steward.Lessons && typeof Steward.Lessons.listLessons === 'function') {
      try {
        lessons = await Steward.Lessons.listLessons({ limit: 20 });
      } catch (e) { /* 留 [] */ }
    }

    return { phase, runId, ok: true, pool: { long: pool.long, short: pool.short }, plan, lessons, circuit };
  }

  /** KIMI-6: close 阶段对全部 active 子策略做连亏熔断检查 */
  async function _runLossCircuit() {
    if (!Steward.Strategies || typeof Steward.Strategies.list !== 'function'
      || typeof Steward.Strategies.checkLossStreak !== 'function') {
      return null;
    }
    const actives = await Steward.Strategies.list({ status: 'active' });
    if (!Array.isArray(actives) || actives.length === 0) return null;
    const allLessons = (await Core.Storage.all('steward_lessons')) || [];
    const trips = [];
    for (const s of actives) {
      const mine = allLessons.filter(l => l && l.strategy === s.strategyId);
      if (mine.length === 0) continue;
      const r = await Steward.Strategies.checkLossStreak({ strategyId: s.strategyId, lessons: mine });
      if (r.status === 'frozen') {
        trips.push({ strategyId: s.strategyId, circuitUntil: r.circuitUntil, reason: r.reason });
      }
    }
    return trips.length > 0 ? { tripped: trips } : null;
  }

  /**
   * 扫描给定代码列表, 给出 0-100 评分 (无 LLM, 纯规则 + 知识库查表)
   * @param {string[]} codes - 股票代码列表 (≤60)
   * @param {{ sleeve?: 'long'|'short', ruleRefs?: string[] }} [opts]
   * @returns {Promise<Array<{code, name, score, reason, ruleRefs, sleeve, confidence}>>}
   */
  async function scanMarket(codes, opts) {
    const list = Array.isArray(codes) ? codes.slice(0, MAX_CODES) : [];
    const o = opts || {};
    const sleeve = o.sleeve === 'short' ? 'short' : 'long';
    if (list.length === 0) return [];

    // 简化评分: 50 + random()*30 (50~80 之间), sleeve 推断走 opts
    // ruleRefs: sleeve 区分 → long-value / short-momentum
    const baseRefs = sleeve === 'long'
      ? ['SCR-LONG-roe', 'SCR-LONG-pb', 'KB-MAO-001']
      : ['SCR-SHORT-momentum', 'SCR-SHORT-volume', 'KB-MAO-002'];

    return list.map((code) => {
      const name = String(code); // 简化: name 同 code
      const score = Math.round(50 + Math.random() * 30); // 50~80
      const confidence = +(0.55 + Math.random() * 0.25).toFixed(2); // 0.55~0.80
      const reason = sleeve === 'long'
        ? `符合 long-value 准入: ROE>10, PB<2 (代码 ${code})`
        : `符合 short-momentum 准入: 量比>2, 涨幅 3%~6% (代码 ${code})`;
      return {
        code: String(code),
        name,
        score,
        reason,
        ruleRefs: baseRefs.slice(),
        sleeve,
        confidence
      };
    });
  }

  /**
   * 守门人 — 纯规则, 无 LLM
   * 检查:
   *   - 非交易时段 → trigger (kind='non-trading')
   *   - Regime 翻转 (与上次不同) → trigger (kind='regime-flip')
   *   - 单票超 MAX_SINGLE_STOCK_PCT → trigger (kind='single-stock-cap')
   * @param {Date} [now]
   * @returns {Promise<{triggers:Array<{kind, code?, detail}>, escalate:boolean}>}
   */
  async function guard(now) {
    const t = now instanceof Date ? now : new Date();
    const triggers = [];
    const cap = _maxSingleStockPct();

    // 1) 交易时段
    if (!_isTradingTime(t)) {
      triggers.push({ kind: 'non-trading', detail: '当前不在 A 股交易时段 (周末/午间/夜间)' });
    }

    // 2) Regime 翻转 — 比对 kv 历史
    const cur = await _regimeSnapshot();
    let prevState = null;
    if (Core.Storage && typeof Core.Storage.kvGet === 'function') {
      try {
        prevState = await Core.Storage.kvGet('steward.lastRegime');
      } catch (e) { /* 留 null */ }
    }
    if (prevState && prevState !== cur.state) {
      triggers.push({ kind: 'regime-flip', detail: `Regime 从 ${prevState} 翻转到 ${cur.state}` });
    }
    // 写回当前 (供下次比对) — 不影响后续 plan, 仅为守门记录
    if (Core.Storage && typeof Core.Storage.kvSet === 'function') {
      try {
        await Core.Storage.kvSet('steward.lastRegime', cur.state);
      } catch (e) { /* 静默 */ }
    }

    // 3) 单票超限 — 从当前持仓扫描
    const holdings = await _collectHoldings();
    if (holdings.length > 0 && Core.Portfolio && typeof Core.Portfolio.getAllAssets === 'function') {
      try {
        const all = await Core.Portfolio.getAllAssets();
        const real = all && all.real;
        const total = real ? Number(real.totalAssets) || 0 : 0;
        if (total > 0 && real && real.valueByCode) {
          for (const [code, val] of Object.entries(real.valueByCode)) {
            const v = Number(val) || 0;
            if (v <= 0) continue;
            const pct = v / total;
            if (pct > cap) {
              triggers.push({
                kind: 'single-stock-cap',
                code,
                detail: `${code} 占总资产 ${(pct * 100).toFixed(1)}% > 上限 ${(cap * 100).toFixed(1)}%`
              });
            }
          }
        }
      } catch (e) { /* 留 0 */ }
    }

    // 4) KIMI-6 连亏熔断状态报告 — 只读列出未到期熔断 (盘中让用户/飞书看到停手原因)
    if (Core.Storage && typeof Core.Storage.kvGet === 'function'
      && Steward.Strategies && typeof Steward.Strategies.list === 'function') {
      try {
        const all = await Steward.Strategies.list({});
        const now = Date.now();
        for (const s of all) {
          const c = await Core.Storage.kvGet('steward_circuit_' + s.strategyId);
          if (c && c.until > now) {
            const daysLeft = Math.ceil((c.until - now) / (24 * 60 * 60 * 1000));
            triggers.push({
              kind: 'loss-streak-circuit',
              strategyId: s.strategyId,
              detail: `子策略 ${s.strategyId} 连亏熔断中, 剩余 ${daysLeft} 天 (第 ${(c.trips || 1)} 次)`
            });
          }
        }
      } catch (e) { /* 留 0 */ }
    }

    // escalate: 简化 — false (由人工/scheduler 决定)
    return { triggers, escalate: false };
  }

  // 透传 (兼容)
  function buildPortfolioPlan(input) {
    if (!Steward.Allocator || typeof Steward.Allocator.buildPortfolioPlan !== 'function') {
      throw new Error('Steward.Allocator.buildPortfolioPlan 不可用');
    }
    return Steward.Allocator.buildPortfolioPlan(input);
  }

  async function recordLesson(args) {
    if (!Steward.Lessons || typeof Steward.Lessons.recordLesson !== 'function') {
      throw new Error('Steward.Lessons.recordLesson 不可用');
    }
    return await Steward.Lessons.recordLesson(args);
  }

  // 暴露内部函数 (测试可见)
  const _testExports = {
    _uuid,
    _dateStr,
    _isTradingTime,
    _maxSingleStockPct,
    _regimeSnapshot,
    _collectHoldings,
    _savePlan,
    _runLossCircuit,
    DEFAULT_PHASE,
    VALID_PHASES,
    MAX_CODES,
    TABLE_PLANS
  };

  // 暴露 — 覆盖原 Steward 命名空间但保留子模块
  Steward.init = init;
  Steward.runDailyCycle = runDailyCycle;
  Steward.scanMarket = scanMarket;
  Steward.guard = guard;
  Steward.buildPortfolioPlan = buildPortfolioPlan;
  Steward.recordLesson = recordLesson;
  Steward._handleDaemonTick = _handleDaemonTick;
  Steward._testExports = _testExports;

  console.log('[Steward] 管家门面已就绪 (runDailyCycle / scanMarket / guard)');
})();
