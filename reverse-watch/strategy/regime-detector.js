// ============== RegimeDetector · 市场状态判断机 ==============
// 每日 1 次判定 (15:35 收盘后), 输出 bull/bear/range, 5 日迟滞避免抖动。
// 三维度投票: D1 趋势 + D2 波动 + D3 宽度; range 细分 strong/weak。

const REGIME_KEY_TODAY = '_rw_regime_today';
const REGIME_KEY_HISTORY = '_rw_regime_history';
const REGIME_KEY_VOTES = '_rw_regime_votes';      // 近 N 日 d1/d2/d3 vote 流
const REGIME_KEY_COOLDOWN = '_rw_regime_cooldown';
const HYSTERESIS_DAYS = 5;

// 仓位倍数表 (空仓是合法状态) — 来自用户立场: 三态仓位倍数
const POSITION_MULTIPLIER = {
  bull: 1.0,
  range_weak: 0.5,
  range_strong: 0.3,
  bear: 0.0
};

function regimeStorageGet(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; }
  catch (e) { console.warn('[regime-detector] kvGet 解析失败:', e.message); return fallback; }
}
function regimeStorageSet(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

// 计算 ATR14
// 数据不足时返回 null (而不是 0) — 0 会被 ATR/close = 0 误判为 weak, 应该让上层忽略该维度
function calcATR(rows, n = 14) {
  if (rows.length < n + 1) return null;
  const trs = [];
  for (let i = 1; i < rows.length; i++) {
    const tr = Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close)
    );
    trs.push(tr);
  }
  const recent = trs.slice(-n);
  return recent.reduce((s, x) => s + x, 0) / n;
}

// 单日投票: 返回 {d1, d2, d3, sum}
// d1: close vs MA20 → +1 多 / -1 空 / 0 震
// d2: ATR14/close → 'strong' / 'weak' / 'normal' (atrPct=null 时回退 'normal')
// d3: 涨停-跌停 → +1 多 / -1 空 / 0 中
function voteDay(indexClose, indexMA20, atrPct, ztMinusDt) {
  const dev = indexMA20 ? (indexClose - indexMA20) / indexMA20 : 0;
  const d1 = dev > 0.03 ? 1 : dev < -0.03 ? -1 : 0;
  const d2 = atrPct == null ? 'normal'
    : atrPct > 0.025 ? 'strong'
    : atrPct < 0.012 ? 'weak' : 'normal';
  const d3 = ztMinusDt > 50 ? 1 : ztMinusDt < -30 ? -1 : 0;
  return { d1, d2, d3, sum: d1 + d3, atrPct: atrPct ?? 0, dev };
}

// 5 日迟滞: 新判定需最近 5 天投票中 ≥ 4 天同向才允许切换
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
  // 切换需要 ≥ 4 天同向
  if (prevRegime === 'bull' && raw !== 'bull' && counts.bull < 4) raw = 'bull';
  if (prevRegime === 'bear' && raw !== 'bear' && counts.bear < 4) raw = 'bear';
  return raw;
}

function todayStr() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// 主入口: 检测今日状态 (调用方传入 indexRows, ztMinusDt)
function checkRegime(indexRows, ztMinusDt) {
  const ma20 = indexRows.length >= 20 ? indexRows.slice(-20).reduce((s, r) => s + r.close, 0) / 20 : indexRows[indexRows.length - 1]?.close || 0;
  const lastClose = indexRows[indexRows.length - 1]?.close || 0;
  const atr = calcATR(indexRows, 14);
  // ATR 缺失 → d2 用 'normal' (中性), 不误判 weak
  const atrPct = atr != null ? atr / lastClose : null;
  const v = voteDay(lastClose, ma20, atrPct, ztMinusDt);
  const prev = regimeStorageGet(REGIME_KEY_TODAY, null);
  const prevRegime = prev?.regime || 'range';
  // 维护近 5 日 vote 流 (按 date 去重), 让 5 日迟滞真正生效
  const votes = regimeStorageGet(REGIME_KEY_VOTES, []);
  votes.push({ date: todayStr(), d1: v.d1, d2: v.d2, d3: v.d3, sum: v.sum });
  const dates = new Set();
  const recentVotes = [];
  for (let i = votes.length - 1; i >= 0 && recentVotes.length < HYSTERESIS_DAYS; i--) {
    if (dates.has(votes[i].date)) continue;
    dates.add(votes[i].date);
    recentVotes.unshift(votes[i]);
  }
  if (votes.length > 30) votes.splice(0, votes.length - 30);
  regimeStorageSet(REGIME_KEY_VOTES, votes);
  const rawRegime = applyHysteresis(recentVotes, prevRegime);
  let regime = rawRegime;
  let subRange = null;
  if (regime === 'range') {
    subRange = v.d2 === 'strong' ? 'range_strong' : v.d2 === 'weak' ? 'range_weak' : 'range';
    regime = subRange;
  }
  const confidence = Math.min(1, Math.abs(v.sum) / 3 * 0.6 + (v.d2 === 'strong' || v.d2 === 'weak' ? 0.4 : 0.2));
  const hint = `MA20偏离 ${(v.dev * 100).toFixed(1)}%, ATR14=${(v.atrPct * 100).toFixed(2)}%, 涨跌停差 ${ztMinusDt >= 0 ? '+' : ''}${ztMinusDt}`;
  const result = { date: todayStr(), regime, rawRegime, d1: v.d1, d2: v.d2, d3: v.d3, sum: v.sum, confidence, hint };
  regimeStorageSet(REGIME_KEY_TODAY, result);
  // 切换历史
  const hist = regimeStorageGet(REGIME_KEY_HISTORY, []);
  if (prev && prev.regime !== regime) {
    hist.unshift({ date: result.date, from: prev.regime, to: regime, hint });
    if (hist.length > 20) hist.length = 20;
    regimeStorageSet(REGIME_KEY_HISTORY, hist);
  }
  return result;
}

// 便捷读取: 不重算, 直接读今日结果
function getTodayRegime() {
  const t = regimeStorageGet(REGIME_KEY_TODAY, null);
  if (t && t.date === todayStr()) return t;
  return null;
}

// 仓位倍数
function positionMultiplier(regime) {
  return POSITION_MULTIPLIER[regime] ?? 0.5;
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.RegimeDetector = { checkRegime, getTodayRegime, positionMultiplier, calcATR, voteDay, applyHysteresis, todayStr, POSITION_MULTIPLIER };