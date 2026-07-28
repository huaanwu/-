/**
 * Core.PositionSizing - AI 仓位公式 (H1 凯利)
 *
 * 把 LLM 自评的 probability (0-100) 翻译成仓位比例, 让 AI 的"信心"
 * 真的影响下多少钱, 不再是装饰。
 *
 * 公式 (半凯利, 业界保守版):
 *   R = (targetPrice - triggerPrice) / (triggerPrice - stopLoss)   // 盈亏比
 *   raw = (p - (1-p) / R) / R                                     // 全凯利
 *   f = max(0, raw) * KELLY_FRACTION                              // 半凯利
 *
 * p < 0.5 → f 通常为 0 (凯利公式不押注期望值负的赌局)
 * R ≤ 0 (止损 ≥ 触发价) → 兜底 0
 * tp ≤ 0 或缺失 → 兜底 0
 *
 * 设计原则:
 *   - core 层不反向依赖 trader 层 (KELLY_MAX_PCT 由调用方通过参数传入)
 *   - 纯函数 (Node 可测)
 *   - 失败兜底返 0 (调用方会走 _scalePositionPct 默认 0.20 上限)
 */
(function() {
  'use strict';
  window.Core = window.Core || {};

  // 半凯利 (业界共识: 全凯利方差太大, 半凯利收益近全凯利但稳一倍)
  const KELLY_FRACTION = 0.5;

  // 凯利算出的仓位下限: 小于这个值的建议等于无效信号, 走上限兜底
  const KELLY_MIN_PCT = 0.02;

  /**
   * 半凯利仓位 (纯函数)
   * @param {{ probability: number, triggerPrice: number, stopLoss: number, targetPrice: number }} input
   *   probability: 0-100 的胜率自评 (LLM 给的整数)
   *   triggerPrice / stopLoss / targetPrice: 必须满足 sl < tp < tg (调用方已校验)
   * @returns {{ f: number, payoffRatio: number, rawKelly: number }}
   *   f: 仓位比例 (小数, 已应用 KELLY_FRACTION, 已 clamp 到 ≥0)
   *   payoffRatio: 盈亏比 R = (tg-tp)/(tp-sl)
   *   rawKelly: 全凯利原始值 (调试 / 显示用)
   */
  function _kellyFraction(input) {
    const out = { f: 0, payoffRatio: 0, rawKelly: 0 };
    if (!input || typeof input !== 'object') return out;
    const tp = parseFloat(input.triggerPrice);
    const sl = parseFloat(input.stopLoss);
    const tg = parseFloat(input.targetPrice);
    const prob = parseFloat(input.probability);
    if (!(tp > 0) || !(sl > 0) || !(tg > 0) || !(sl < tp && tp < tg)) {
      return out;  // 价格关系不满足, 兜底 0
    }
    if (!(prob >= 0 && prob <= 100)) return out;
    const p = prob / 100;
    const risk = tp - sl;
    const reward = tg - tp;
    if (!(risk > 0) || !(reward > 0)) return out;
    const R = reward / risk;
    out.payoffRatio = +R.toFixed(2);
    // 全凯利: f = (p(b+1) - 1) / b, 简化: f = (p - (1-p)/R) / R
    const raw = (p - (1 - p) / R) / R;
    out.rawKelly = +raw.toFixed(4);
    // 半凯利 + 下限 clamp (凯利公式期望值 < 0 时负值, 一律不下注)
    out.f = +Math.max(0, raw * KELLY_FRACTION).toFixed(4);
    return out;
  }

  /**
   * 把凯利原始值夹到 [KELLY_MIN_PCT, maxPct] 区间 (纯函数)
   *   raw < KELLY_MIN_PCT → 兜底走 maxPct (小信号按上限, 至少不会空手)
   *   raw > maxPct → 收敛到 maxPct (硬顶)
   * @param {number} raw - 凯利原始值 (0-1 小数)
   * @param {number} maxPct - 上限 (默认 0.20, 调用方注入 MAX_SINGLE_STOCK_PCT)
   * @returns {number}
   */
  function _clampKelly(raw, maxPct = 0.20) {
    const r = parseFloat(raw);
    const cap = parseFloat(maxPct);
    const cap_ = (isFinite(cap) && cap > 0 && cap <= 1) ? cap : 0.20;
    if (!(r > 0)) return cap_;  // 兜底: 凯利返 0 → 走上限 (跟旧 _scalePositionPct 一致)
    if (r < KELLY_MIN_PCT) return cap_;  // 信号太弱, 按上限试探
    return +Math.min(r, cap_).toFixed(4);
  }

  window.Core.PositionSizing = {
    KELLY_FRACTION,
    KELLY_MIN_PCT,
    _kellyFraction,
    _clampKelly
  };
})();