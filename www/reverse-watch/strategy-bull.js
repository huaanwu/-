/**
 * ReverseWatch.StrategyBull — 牛市子策略 (主升浪接力)
 *
 * 复用: aiChiefAnalyst() (现 reverse-watch/app.js) 做品种筛选
 *       fetchKLine() / calcTechs() 做趋势确认
 *       HoldingRules.match() 做仓位冲突检查
 */
(function () {
  'use strict';

  const POOL_SLOT = 'dragon';       // 入 Core.ReversePool 的 dragon 池

  /**
   * 每日 09:35 跑一次: 选 top 3 主升浪候选
   * 依赖 Core.Regime.state === 'bull' 才执行
   * 返回 { picks: [{tsCode, name, score, rationale}], skipped, reason }
   */
  async function screen() {
    return { picks: [], skipped: 0, reason: '' };
  }

  /**
   * 入池前 4 闸检查 (复用 HoldingRules / Core.ReverseDiscipline.preCheckOne)
   * 输入 pick + holdingContext → 输出 { passed: bool, blockers: [], warnings: [] }
   */
  async function preCheck(pick, ctx) {
    return { passed: true, blockers: [], warnings: [] };
  }

  /**
   * 命中入 dragon 池: Core.ReversePool.add(POOL_SLOT, pick)
   * 5 日无动作自动出 (复用 DRAGON_KEEP_DAYS 常量)
   */
  async function commit(pick) {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.StrategyBull = { screen, preCheck, commit };
})();