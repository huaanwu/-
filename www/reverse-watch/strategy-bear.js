/**
 * ReverseWatch.StrategyBear — 熊市子策略 (防御 + 抢超跌反弹)
 *
 * 与 Bull 对称: state === 'bear' 才执行, 入 base 池 (债性底仓)
 * 强调"不接飞刀"——只在 RSI<30 + 缩量止跌 2 日后才纳入候选
 */
(function () {
  'use strict';

  const POOL_SLOT = 'base';
  const RSI_OVERSOLD = 30;
  const VOLUME_SHRINK_DAYS = 2;

  /**
   * 选超跌候选: 必须 RSI<30 连续 2 日 + 量比 < 0.6
   * 复用 fetchKLine() + calcTechs() 算 RSI/量比
   * 返回 { picks: [{tsCode, name, rsi, volRatio, score}], skipped, reason }
   */
  async function screen() {
    return { picks: [], skipped: 0, reason: '' };
  }

  /**
   * 熊市闸更严: 仓位上限 ×0.5 (来自 Core.Regime.gateMultipliers)
   * 复用 HoldingRules.maxPositionPct() + Core.ReverseDiscipline.preCheckOne()
   */
  async function preCheck(pick, ctx) {
    return { passed: true, blockers: [], warnings: [], maxPct: 0.05 };
  }

  /**
   * 入 base 池, snapId = `${date}-${POOL_SLOT}`
   * 复用 Core.ReversePool.add() + Core.Storage.kvSet
   */
  async function commit(pick) {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.StrategyBear = { screen, preCheck, commit };
})();