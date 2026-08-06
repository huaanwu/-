// ============== auto-tuner-pure.mjs · 自动调参纯函数 (signals/guard/decide) ==============
// 浏览器 + Node 通用: 注入 deps (signal source fns) + state (state 读写)
// execute / rollbackAll / approvePending / scheduleWeekly 留在浏览器侧 (auto-tuner.js),
// 因依赖 AIFeedback.applyAdjustments (落盘 + 派事件), daemon 会另写自己的 execute 通道。
//
// 重构 ( ): 把 _computeSignals / _shouldSkip / _decide 抽出来, 让 daemon 跑同款判定

import { makeStateAdapter, IS_NODE } from './state-adapter.mjs';

const TTL_7D = 7 * 24 * 60 * 60 * 1000;
const TTL_24H = 24 * 60 * 60 * 1000;
const MIN_SAMPLE = 20;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ----- 节流 helper: 近 7d 内"系统+用户"都调过的 target 集合 -----
function getRecentlyTunedTargets(opts = {}) {
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const out = new Set();
  // 1) 系统 log
  const auto = state.safeReadJson('_rw_auto_adjustments_log', []);
  if (Array.isArray(auto)) {
    auto.forEach(e => {
      if (e && e.ts && (now - e.ts) < TTL_7D && e.status !== 'rolledBack' && e.adjustment?.target) {
        out.add(e.adjustment.target);
      }
    });
  }
  // 2) 用户 log (chat + applyAdjustments 写入 _rw_adjustments_log)
  const user = state.safeReadJson('_rw_adjustments_log', []);
  if (Array.isArray(user)) {
    user.forEach(e => {
      if (e && e.ts && (now - e.ts) < TTL_7D && e.status !== 'reverted' && e.target) {
        out.add(e.target);
      }
    });
  }
  return out;
}

// ----- 信号聚合 (4 项) -----
// opts: { state, now, deps }
//   deps.loadActiveFeedback(now) → {code: {verdict, ts, note}}  (7d TTL 已应用)
//   deps.loadHoldingFb()        → {ruleId: [{verdict, ts}]}
//   deps.getHolding()           → {holdings: [...]}
//   deps.getUserAdjustments()    → [{ts, target, status}, ...]
function computeSignals(opts = {}) {
  const deps = opts.deps || {};
  const now = opts.now || Date.now();
  // ① down/up 比率
  let down = 0, up = 0;
  try {
    const fb = (typeof deps.loadActiveFeedback === 'function') ? deps.loadActiveFeedback(now) : {};
    Object.values(fb || {}).forEach(r => {
      if (!r) return;
      if (r.verdict === 'down') down++;
      else if (r.verdict === 'up') up++;
    });
  } catch (e) { console.warn('[auto-tuner-pure] 信号① 读 feedback 失败:', e.message); }
  const sampleSize = down + up;
  const downRatio = sampleSize > 0 ? down / sampleSize : null;
  // ② holding 否定率
  const ruleDownRate = {};
  try {
    const hb = (typeof deps.loadHoldingFb === 'function') ? deps.loadHoldingFb() : {};
    Object.entries(hb || {}).forEach(([rid, records]) => {
      if (!Array.isArray(records) || records.length < 2) return;
      const d = records.filter(r => r && r.verdict === 'down').length;
      ruleDownRate[rid] = d / records.length;
    });
  } catch (e) { console.warn('[auto-tuner-pure] 信号② 读 holdingFb 失败:', e.message); }
  // ③ 池子吞吐率
  const state = opts.state || makeStateAdapter();
  let passRate = null;
  try {
    const stats = state.safeReadJson('_rw_screener_stats', {});
    const p = stats.passed || 0, b = stats.blocked || 0;
    if ((p + b) > 0) passRate = p / (p + b);
  } catch (e) { console.warn('[auto-tuner-pure] 信号③ 读 screener_stats 失败:', e.message); }
  // ④ 用户最近手动调
  let userAdjusted = [];
  try {
    const adjLog = (typeof deps.getUserAdjustments === 'function') ? deps.getUserAdjustments() : [];
    userAdjusted = (adjLog || []).filter(e => e && e.ts && (now - e.ts) < TTL_7D).map(e => e.target).filter(Boolean);
  } catch (e) { console.warn('[auto-tuner-pure] 信号④ 读 adjustments 失败:', e.message); }
  return { downRatio, downCount: down, upCount: up, ruleDownRate, passRate, userAdjusted, sampleSize };
}

// ----- 安全阀: 任一命中即拒 -----
function shouldSkip(opts = {}) {
  const deps = opts.deps || {};
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  // 1. 持仓 ≥ 1 票
  try {
    const h = (typeof deps.getHolding === 'function') ? deps.getHolding() : {};
    if (Array.isArray(h.holdings) && h.holdings.length > 0) return { skip: true, reason: '持仓中有股, 用户决定优先' };
  } catch (e) { console.warn('[auto-tuner-pure] shouldSkip 读 holding 失败:', e.message); }
  // 2. 用户最近 24h 手动改过 SETTINGS
  try {
    const adjLog = (typeof deps.getUserAdjustments === 'function') ? deps.getUserAdjustments() : [];
    const recent = adjLog.find(e => e && e.ts && (now - e.ts) < TTL_24H && /^gates\.|^holding\./.test(e.target || ''));
    if (recent) return { skip: true, reason: '24h 内用户手动改过 SETTINGS' };
  } catch (e) { console.warn('[auto-tuner-pure] shouldSkip 读 adjustments 失败:', e.message); }
  // 3. 距上次自动调 < 7d
  try {
    const auto = state.safeReadJson('_rw_auto_adjustments_log', []);
    const lastAuto = Array.isArray(auto) ? auto[0] : null;
    if (lastAuto && lastAuto.ts && (now - lastAuto.ts) < TTL_7D) return { skip: true, reason: '距上次自动调 < 7d' };
  } catch (e) { console.warn('[auto-tuner-pure] shouldSkip 读 log 失败:', e.message); }
  // 4. 最小样本
  const signals = computeSignals({ deps, state, now });
  if (signals.sampleSize < MIN_SAMPLE) return { skip: true, reason: `样本不足 (${signals.sampleSize} < ${MIN_SAMPLE})`, signals };
  return { skip: false, signals };
}

// ----- 决策 (5 条规则) -----
function decide(signals, opts = {}) {
  const state = opts.state || makeStateAdapter();
  const deps = opts.deps || {};
  const G = (typeof deps.getSettings === 'function' ? deps.getSettings() : {}) || {};
  // 读 holding 现状 (P1 #15 bear 联动 cashReservePct / singleStockMaxPct 用)
  const H = (typeof deps.getHolding === 'function' ? deps.getHolding() : {}) || {};
  const adj = [];
  // bear 护栏
  // [P0 #3] 修: regime-detector 用 unshift 把最新 push 到 index 0, 不是 length-1
  // 旧 bug: 永远读最老, bear 护栏永不出
  let isBear = false;
  try {
    const regimeHist = state.safeReadJson('_rw_regime_history', []);
    // 取最新一条: unshift → [0] 是最新, length-1 是最老
    const latest = Array.isArray(regimeHist) && regimeHist.length > 0 ? regimeHist[0] : null;
    if (latest && latest.regime === 'bear') isBear = true;
    else if (typeof opts.regime === 'string') isBear = opts.regime === 'bear';  // 显式传入 (daemon 用)
  } catch (e) { console.warn('[auto-tuner-pure] decide 读 regime 失败:', e.message); }
  function filterByRecent(adjustments) {
    const recent = getRecentlyTunedTargets({ state });
    if (recent.size === 0 || adjustments.length === 0) return adjustments;
    const skipped = [];
    const filtered = adjustments.filter(a => {
      if (recent.has(a.target)) { skipped.push(a.target); return false; }
      return true;
    });
    if (skipped.length > 0) console.log('[auto-tuner-pure] per-field 节流跳过:', skipped.join(', '), '(7d 内已调)');
    return filtered;
  }
  if (isBear) {
    // [P0 #3] 仓位倍数归 0 (空仓合法)
    adj.push({ target: 'holding.positionMultiplier', value: 0,
      reason: 'bear 信号, 仓位倍数归 0 (空仓合法)' });
    // [P1 #15] bear 联动 cashReservePct: 现金储备上调 (留更多现金)
    //   当前值 < 0.15 → 上调到 0.15; 已 ≥ 0.15 不动
    const curCashReserve = H.cashReservePct ?? 0.10;
    if (curCashReserve < 0.15) {
      adj.push({ target: 'holding.cashReservePct', value: 0.15,
        reason: `bear 信号, 现金储备从 ${(curCashReserve*100).toFixed(0)}% 上调到 15% (留更多现金应对回撤)` });
    }
    // [P1 #15] bear 联动 singleStockMaxPct: 单票上限下调 (更分散)
    //   当前值 > 0.03 → 下调到 0.03; 已 ≤ 0.03 不动
    const curSingleMax = H.singleStockMaxPct ?? 0.05;
    if (curSingleMax > 0.03) {
      adj.push({ target: 'holding.singleStockMaxPct', value: 0.03,
        reason: `bear 信号, 单票上限从 ${(curSingleMax*100).toFixed(0)}% 下调到 3% (更分散降低单票风险)` });
    }
    return filterByRecent(adj);
  }
  // 规则 1: down↑ + 池子松 → sectorMin 拉严
  if (signals.downRatio != null && signals.downRatio >= 0.6 && signals.passRate != null && signals.passRate > 0.4) {
    adj.push({ target: 'gates.sectorMin', value: clamp((G.sectorMin ?? 0.55) + 0.02, 0.3, 0.8),
      reason: `down 比率 ${(signals.downRatio*100).toFixed(0)}% 偏高, 通过率 ${(signals.passRate*100).toFixed(0)}% 偏松 → 收紧` });
  }
  // 规则 2: down↑ + 池子紧 → 拉严但步长减半
  else if (signals.downRatio != null && signals.downRatio >= 0.6 && signals.passRate != null && signals.passRate < 0.1) {
    adj.push({ target: 'gates.sectorMin', value: clamp((G.sectorMin ?? 0.55) + 0.01, 0.3, 0.8),
      reason: 'down 偏高但池子已紧, 步长减半 → 微调' });
  }
  // 规则 3: down↓ + 池子太严 → 放低门槛
  else if (signals.downRatio != null && signals.downRatio < 0.3 && signals.passRate != null && signals.passRate < 0.05) {
    adj.push({ target: 'gates.sectorMin', value: clamp((G.sectorMin ?? 0.55) - 0.03, 0.3, 0.8),
      reason: `池子通过率仅 ${(signals.passRate*100).toFixed(0)}% 过严 → 放低` });
    adj.push({ target: 'gates.pbDeltaMin', value: clamp((G.pbDeltaMin ?? 15) - 2, 5, 30),
      reason: '同步放低 PB 差' });
  }
  // 规则 4: RiskMine 命中率高 → PB 放宽
  try {
    const riskCache = state.safeReadJson('_rw_risk_cache', {});
    const totalCodes = Object.keys(riskCache).length;
    const hitCodes = Object.values(riskCache).filter(c => c && c.status === 'ok' && Array.isArray(c.reasons) && c.reasons.length > 0).length;
    if (totalCodes > 0 && hitCodes / totalCodes >= 0.6) {
      adj.push({ target: 'gates.pbDeltaMin', value: clamp((G.pbDeltaMin ?? 15) + 2, 5, 30),
        reason: `RiskMine 命中率 ${(hitCodes/totalCodes*100).toFixed(0)}% 高 → 抬高 PB 差阈值` });
    }
  } catch (e) { console.warn('[auto-tuner-pure] decide RiskMine 解析失败:', e.message); }
  return filterByRecent(adj);
}

// 浏览器侧暴露
if (!IS_NODE) {
  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.AutoTunerPure = { computeSignals, shouldSkip, decide, getRecentlyTunedTargets };
}

export { computeSignals, shouldSkip, decide, getRecentlyTunedTargets, clamp };