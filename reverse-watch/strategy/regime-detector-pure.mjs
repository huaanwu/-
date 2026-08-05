// ============== regime-detector-pure.mjs · 市场状态判断机 (纯函数) ==============
// 浏览器 + Node 通用: 注入 state 适配器, 把 localStorage 替换为 adapter
// 原 strategy/regime-detector.js:25-119 抽出来, 行为 100% 一致

import { makeStateAdapter, IS_NODE } from '../state-adapter.mjs';

const HYSTERESIS_DAYS = 5;

const POSITION_MULTIPLIER = {
  bull: 1.0,
  range_weak: 0.5,
  range_strong: 0.3,
  bear: 0.0
};

// 计算 ATR14 — null 而非 0 (避免 weak 误判)
function calcATR(rows, n = 14) {
  if (!Array.isArray(rows) || rows.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const tr = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    );
    trs.push(tr);
  }
  return trs.slice(-n).reduce((s, x) => s + x, 0) / n;
}

// 单日投票
function voteDay(indexClose, indexMA20, atrPct, ztMinusDt) {
  const dev = indexMA20 ? (indexClose - indexMA20) / indexMA20 : 0;
  const d1 = dev > 0.03 ? 1 : dev < -0.03 ? -1 : 0;
  const d2 = atrPct == null ? 'normal'
    : atrPct > 0.025 ? 'strong'
    : atrPct < 0.012 ? 'weak' : 'normal';
  const d3 = ztMinusDt > 50 ? 1 : ztMinusDt < -30 ? -1 : 0;
  return { d1, d2, d3, sum: d1 + d3, atrPct: atrPct ?? 0, dev };
}

// 5 日迟滞
function applyHysteresis(recentVotes, prevRegime) {
  const counts = { bull: 0, bear: 0, range: 0 };
  for (const v of recentVotes) {
    if (v.sum >= 2) counts.bull++;
    else if (v.sum <= -2) counts.bear++;
    else counts.range++;
  }
  let raw;
  if (counts.bull >= 3) raw = 'bull';
  else if (counts.bear >= 3) raw = 'bear';
  else raw = 'range';
  if (prevRegime === 'bull' && raw !== 'bull' && counts.bull < 4) raw = 'bull';
  if (prevRegime === 'bear' && raw !== 'bear' && counts.bear < 4) raw = 'bear';
  return raw;
}

function todayStr(date = new Date()) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

// 主入口: 检测今日状态
// opts: { indexRows, ztMinusDt, now, state }
//   indexRows 必须有 [{close, high, low}, ...] 至少 14+1 行
//   ztMinusDt = 涨停数 - 跌停数 (整数)
//   now: Date.now() 默认
//   state: makeStateAdapter() 默认
function checkRegime(opts) {
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const indexRows = opts.indexRows || [];
  const ztMinusDt = opts.ztMinusDt ?? 0;

  const lastClose = indexRows[indexRows.length - 1]?.close || 0;
  const ma20 = indexRows.length >= 20 ? indexRows.slice(-20).reduce((s, r) => s + r.close, 0) / 20 : lastClose;
  const atr = calcATR(indexRows, 14);
  const atrPct = atr != null ? atr / lastClose : null;
  const v = voteDay(lastClose, ma20, atrPct, ztMinusDt);

  const prev = state.safeReadJson('_rw_regime_today', null);
  const prevRegime = prev?.regime || 'range';

  // 维护近 5 日 vote 流
  const today = todayStr(new Date(now));
  const votes = state.safeReadJson('_rw_regime_votes', []);
  votes.push({ date: today, d1: v.d1, d2: v.d2, d3: v.d3, sum: v.sum });
  const dates = new Set();
  const recentVotes = [];
  for (let i = votes.length - 1; i >= 0 && recentVotes.length < HYSTERESIS_DAYS; i--) {
    if (dates.has(votes[i].date)) continue;
    dates.add(votes[i].date);
    recentVotes.unshift(votes[i]);
  }
  if (votes.length > 30) votes.splice(0, votes.length - 30);
  state.safeWrite('_rw_regime_votes', votes);

  const rawRegime = applyHysteresis(recentVotes, prevRegime);
  let regime = rawRegime;
  let subRange = null;
  if (regime === 'range') {
    subRange = v.d2 === 'strong' ? 'range_strong' : v.d2 === 'weak' ? 'range_weak' : 'range';
    regime = subRange;
  }
  const confidence = Math.min(1, Math.abs(v.sum) / 3 * 0.6 + (v.d2 === 'strong' || v.d2 === 'weak' ? 0.4 : 0.2));
  const hint = `MA20偏离 ${(v.dev * 100).toFixed(1)}%, ATR14=${(v.atrPct * 100).toFixed(2)}%, 涨跌停差 ${ztMinusDt >= 0 ? '+' : ''}${ztMinusDt}`;
  const result = { date: today, regime, rawRegime, d1: v.d1, d2: v.d2, d3: v.d3, sum: v.sum, confidence, hint };

  state.safeWrite('_rw_regime_today', result);

  // 切换历史
  const hist = state.safeReadJson('_rw_regime_history', []);
  if (prev && prev.regime !== regime) {
    hist.unshift({ date: result.date, from: prev.regime, to: regime, hint });
    if (hist.length > 20) hist.length = 20;
    state.safeWrite('_rw_regime_history', hist);
  }
  return result;
}

function getTodayRegime(opts = {}) {
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const t = state.safeReadJson('_rw_regime_today', null);
  if (t && t.date === todayStr(new Date(now))) return t;
  return null;
}

function positionMultiplier(regime) {
  return POSITION_MULTIPLIER[regime] ?? 0.5;
}

// 浏览器侧暴露 (供 app.js 调)
if (!IS_NODE) {
  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.RegimeDetectorPure = { checkRegime, getTodayRegime, positionMultiplier, calcATR, voteDay, applyHysteresis, todayStr, POSITION_MULTIPLIER };
}

export { checkRegime, getTodayRegime, positionMultiplier, calcATR, voteDay, applyHysteresis, todayStr, POSITION_MULTIPLIER };