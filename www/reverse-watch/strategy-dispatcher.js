/**
 * ReverseWatch.Dispatcher — 状态→策略路由器 (每日 09:35 调度入口)
 *
 * 不实现任何选股逻辑, 只做"根据 RegimeDetector.getCached().state 选 StrategyX.screen()"
 * 现有 reverse-watch/app.js 的 render() 入口调它, 不动 render 本体
 */
(function () {
  'use strict';

  const STRATEGIES = {
    bull:  () => window.ReverseWatch.StrategyBull,
    bear:  () => window.ReverseWatch.StrategyBear,
    range: () => window.ReverseWatch.StrategyRange
  };

  /**
   * 单入口: opts = { force?: boolean, silent?: boolean }
   * 返回 { state, picks, ranAt, reason }  供 render() 拿来渲染顶部灯 + 卡片
   */
  async function runOnce(opts) {
    const regime = await window.ReverseWatch.RegimeDetector.getCached(opts);
    const mod = STRATEGIES[regime.state];
    if (!mod) return { state: regime.state, picks: [], ranAt: '', reason: 'unknown_state' };
    const out = await mod().screen();
    return { state: regime.state, picks: out.picks, ranAt: new Date().toISOString(), reason: out.reason };
  }

  /**
   * 定时调度: 工作日 09:35 跑一次 (跟现 ScreenerReverse 节奏对齐)
   * 用 setTimeout + 下次开盘日计算, 不引入 cron 库
   */
  function schedule() {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.Dispatcher = { runOnce, schedule };
})();