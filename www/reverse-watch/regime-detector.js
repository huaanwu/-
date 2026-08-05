/**
 * ReverseWatch.RegimeDetector — 市场状态判断层 (3 态: bull/bear/range)
 *
 * 复用: Core.Regime.gateMultipliers() 已有 3 态结果, 本模块只做"封装 + 切换迟滞"
 *       Core.Data.getIndexKLine() 取 HS300/CSI1000/CSI2000 三指数共识
 */
(function () {
  'use strict';

  const MIN_HOLD_DAYS = 5;          // 状态切换迟滞: 至少持续 5 个交易日
  const STORAGE_KEY = 'reverse_regime';

  /**
   * 每日 1 次评估, 返回 { state, since, confidence, indices, stale }
   * 依赖 Core.Regime.snapshot() (已有 3 态) + Core.Storage.kvGet/Set 做迟滞
   */
  async function detect() {
    // 复用 Core.Regime.gateMultipliers() 拿到基础 3 态
    // 在此之上叠 5 日迟滞: 当前 state 必须连续 MIN_HOLD_DAYS 才允许切
    return { state: 'range', since: '', confidence: 0, indices: {}, stale: false };
  }

  /**
   * 取上次状态。hit cache 则直接返回, miss 才调 detect()
   * 输入 { force?: boolean } → 输出与 detect 同形
   */
  async function getCached(opts) {
    return { state: 'range', since: '', confidence: 0, indices: {}, stale: false };
  }

  /**
   * 顶栏订阅: 状态变更时回调 onChange(newState, oldState)
   * 用 EventTarget 模式, UI 模块监听 (避免强耦合)
   */
  function subscribe(onChange) {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.RegimeDetector = { detect, getCached, subscribe };
})();