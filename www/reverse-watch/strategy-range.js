/**
 * ReverseWatch.StrategyRange — 震荡市子策略 (反向骨架, 破羊群)
 *
 * 是 3 套里最复杂的一个: 必须是"与共识反向"才有 alpha
 * 复用现有 Core.ReversePool (proxy/trap 池就是为它而设)
 * 与 ScreenerReverse.run() 接驳 (V13 拍板已用它产出 5 只)
 */
(function () {
  'use strict';

  const POOL_PROXY = 'proxy';
  const POOL_TRAP = 'trap';
  const HERD_LOOKBACK_DAYS = 20;    // 看 20 日资金/换手共识

  /**
   * 核心: 找"被冷落但基本面不差"的票 (破羊群)
   * 复用 aiChiefAnalyst() (已有反向 prompt) + fetchKLine()
   * 返回 { picks: [{tsCode, name, herdScore, alphaScore}], skipped, reason }
   */
  async function screen() {
    return { picks: [], skipped: 0, reason: '' };
  }

  /**
   * 反向闸: 4 闸基础上加 "共识反向度" 第 5 闸
   * 复用 HoldingRules.match() + 自定义的 herdDivergenceCheck()
   */
  async function preCheck(pick, ctx) {
    return { passed: true, blockers: [], warnings: [], herdDiv: 0 };
  }

  /**
   * 入 proxy 池 (通过) / trap 池 (被规则 4/5/6 踢出, 24h 锁)
   * 复用 Core.ReversePool.add() (已有 trap 24h 自动出逻辑)
   */
  async function commit(pick, passed) {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.StrategyRange = { screen, preCheck, commit };
})();