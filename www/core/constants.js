/**
 * Core.Constants - 全局业务常量集中地 (FIX-2)
 *
 * 之前散落在各域脚本的硬编码阈值 / 系数统一收口到这里,
 * 避免:
 *   - 同一阈值改一处忘改另一处 (例: paper 0.10 vs pending 0.05)
 *   - magic number 散布无注释, 业务含义靠 grep 反查
 *
 * 接入原则:
 *   - 只放"业务规则"型常量 (持仓比例 / 止损系数 / 再平衡目标等)
 *   - 业务模块自己的内部默认 (例: discipline 单票上限走 Core.Discipline.DEFAULT_CONFIG)
 *     仍保留在各自模块,这里只收"跨模块共用 / 容易改"的部分
 *   - 加新常量先考虑: 这是单模块内部细节还是跨模块契约?
 *     前者放模块内,后者放这里
 *
 * 加载顺序: 在 storage.js / data.js 之后、discipline.js / pending.js 之前加载
 */
(function() {
  'use strict';
  window.Core = window.Core || {};

  // ==================== A 股交易规则 ====================

  /** A 股一手 = 100 股, paper / pending / backtest 都用 */
  const LOT_SIZE = 100;

  // ==================== AI 自动成交默认行为 ====================

  /** 自动成交默认止损系数: 现价 × 0.92 = -8% 止损
   *  paper.js 自动成交路径 + screener 待确认卡片生成路径共用 */
  const STOP_LOSS_RATIO_AUTO = 0.92;

  /** 模拟盘 AI 自动成交单次仓位比例 (paper.js)
   *  比实盘建议位大,给 AI 更大自主权 */
  const SUGGEST_PCT_PAPER = 0.10;

  /** 实盘待确认卡片建议仓位 (pending.js)
   *  比模拟盘小,留人工加码空间 */
  const SUGGEST_PCT_PENDING = 0.05;

  // ==================== 基金再平衡 ====================

  /** 默认基金组合再平衡目标配置
   *  fund.js / fund/rebalance.js / alerts.js 三处共用 */
  const REBALANCE_TARGET_DEFAULT = { short_bond: 0.20, pure_bond: 0.80 };

  /** 基金组合偏离触发再平衡的阈值 (5%)
   *  alerts.js / fund.js / fund/portfolio-risk.js 共用 */
  const REBALANCE_DRIFT_THRESHOLD = 0.05;

  // ==================== 风险控制 ====================

  /** 月度回撤熔断线 (10%)
   *  discipline.js DEFAULT_CONFIG.maxMonthlyDrawdownPct 同值, 改时同步 */
  const MAX_MONTHLY_DRAWDOWN_PCT = 0.10;

  /** 单票集中度上限 (20%) — discipline 默认值 */
  const MAX_SINGLE_STOCK_PCT = 0.20;

  /** 单行业集中度上限 (30%) — 预留字段: 暂无行业数据源, 待接入后启用 */
  const MAX_SINGLE_INDUSTRY_PCT = 0.30;

  // ==================== 调试辅助 ====================

  /** 给 console.log 打 tag 用: 让日志快速定位模块 */
  const MODULE_TAG = {
    paper: '[Paper]',
    pending: '[Pending]',
    discipline: '[Discipline]',
    fund: '[Fund]',
    alerts: '[Alerts]',
    screener: '[Screener]'
  };

  window.Core.Constants = {
    LOT_SIZE,
    STOP_LOSS_RATIO_AUTO,
    SUGGEST_PCT_PAPER,
    SUGGEST_PCT_PENDING,
    REBALANCE_TARGET_DEFAULT,
    REBALANCE_DRIFT_THRESHOLD,
    MAX_MONTHLY_DRAWDOWN_PCT,
    MAX_SINGLE_STOCK_PCT,
    MAX_SINGLE_INDUSTRY_PCT,
    MODULE_TAG
  };
})();