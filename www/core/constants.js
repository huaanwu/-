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

  // ==================== 模拟盘分账户 (sleeve, AI 短线操盘手 T1) ====================

  /** AI 短线模拟子账户初始资金 (kv paper_account_short)
   *  与长线模拟 (kv paper_account, 10 万) 独立核算, 互不影响 */
  const PAPER_SHORT_CASH = 30000;

  /** AI 短线子账户单笔仓位比例
   *  比长线 0.10 高: 短线账户本金小, 比例太低会买不起一手 */
  const PAPER_SHORT_POSITION_PCT = 0.20;

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

  // ==================== 中长线盯盘 (alerts.js 分层轮询) ====================

  /** 短线规则 (价格/涨跌幅/成交量) 轮询间隔: 1 分钟
   *  只在存在启用的短线规则时才起这个定时器 */
  const ALERT_TICK_SHORT_MS = 60 * 1000;

  /** 中长线规则频率兜底值 (30 分钟)
   *  历史上曾是 30 分钟调度定时器的间隔; P1 起中长线改事件驱动 (app 启动/页面展示触发),
   *  定时器已删除, 此常量仅作 _freqMs 找不到对应频率时的兜底 */
  const ALERT_TICK_LONG_MS = 30 * 60 * 1000;

  /** A 股连续竞价交易时段 (分钟数, 本地时间): [ [09:30, 11:30], [13:00, 15:00] ]
   *  边界含端点 (09:30/11:30/13:00/15:00 均视为交易时间)
   *  alerts.js _isTradingTime 用: 短线轮询非交易时段不发请求 */
  const TRADING_WINDOWS = [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]];

  /** 短线提醒通知冷却期 (30 分钟)
   *  防 flapping: 振荡价在阈值附近反复穿越, triggered 复位后立刻再命中,
   *  冷却期内只落 triggered 不发通知, 超过冷却期才恢复通知 */
  const ALERT_NOTIFY_COOLDOWN_MS = 30 * 60 * 1000;

  /** 中长线规则各自的检查频率 (毫秒)
   *  rebalance_quarterly 不在此列: 用规则行自带的 intervalDays */
  const ALERT_LONG_FREQ_MS = {
    earnings_disclosure: 24 * 60 * 60 * 1000,        // 财报披露日历: 日频足够
    earnings_warning:    7 * 24 * 60 * 60 * 1000,    // 业绩预告异动: 周频
    regime_change:       24 * 60 * 60 * 1000,        // 大盘趋势迁移: 日频 (Regime 本身每日只重算一次)
    valuation:           14 * 24 * 60 * 60 * 1000    // 估值偏离: 双周频
  };

  /** 中长线规则拉数缓存 TTL (6h, 与 data.js _CTX_TTL 对齐, 共享 cache key 时不打架) */
  const ALERT_LONG_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

  /** 业绩预告异动: 负面预告类型名单
   *  来源: stock_yjyg_em 的「业绩预告类型」枚举 (预增/略增/预减/略减/扭亏/首亏/续亏/续盈),
   *  与 data.js _fetchEarningsCalendar 的正则 /增|减|扭亏|首亏|续亏|续盈/ 同一份数据口径 */
  const EARNINGS_WARNING_NEGATIVE_TYPES = ['预减', '略减', '首亏', '续亏'];

  /** 业绩预告/估值的新鲜度窗口: 公告日期超过半年视为陈旧回填数据, 丢弃 (与 data.js Y1 防御一致) */
  const EARNINGS_WARNING_FRESH_MS = 180 * 24 * 60 * 60 * 1000;

  /** 估值偏离: 单只指数当前 PE 在近 N 个月历史序列里的分位 ≥ 此值视为"偏贵", 与低估值买入逻辑相悖 */
  const VALUATION_PERCENTILE_WARN = 80;

  /** 估值偏离监控的指数 (stock_market_pe_lg 接口为单只指数月度 PE 历史,
   *  akshare 0.0.91 实测返回深证综指 1997-2026 的 {日期, 指数, 平均市盈率} 时序,
   *  不返回指数名/快照字段, 因此这里只盯单只深证综指, 不列表多只)
   *  若 akshare 后续接口扩展多指数快照, 再扩成数组逐个检查 */
  const VALUATION_INDEX_NAMES = ['深证'];

  /** 估值偏离: 计算分位时取近 N 个月的 PE 序列 (默认 60 ≈ 5 年月度数据) */
  const VALUATION_PE_LOOKBACK_MO = 60;

  // ==================== AI 历史成绩单 + 概率校准 (Scorecard) ====================

  /** AI 验证结论枚举 (journals.verifyOutcome, 非索引字段)
   *  与 daily_summary.mjs VERDICT_TO_OUTCOME 对齐: 对→correct / 错→wrong / 部分→partial */
  const VERIFY_OUTCOMES = ['correct', 'wrong', 'partial'];

  /** AI 验证错误归因枚举 (journals.verifyFailureReason, 非索引字段)
   *  与 daily_summary.mjs ATTRIBUTION_TO_REASON 对齐 */
  const VERIFY_FAILURE_REASONS = ['追高', '假设错误', '时机过早', '大盘拖累', '黑天鹅'];

  /** 成绩单注入最少已验证样本数: 低于此数不注入, 避免误导 */
  const SCORECARD_MIN_SAMPLES = 3;

  /** 成绩单 prompt 文本缓存 TTL: 10 分钟 (内存缓存) */
  const SCORECARD_CACHE_TTL_MS = 10 * 60 * 1000;

  /** Brier / 校准最少样本数: 低于此数 UI 显示"积累中" */
  const BRIER_MIN_SAMPLES = 5;

  /** 校准分桶边界 (probability 百分比, lo 含 hi 不含): <40 / 40-60 / 60-80 / ≥80 */
  const CALIBRATION_BUCKET_EDGES = [0, 40, 60, 80, 101];

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
    PAPER_SHORT_CASH,
    PAPER_SHORT_POSITION_PCT,
    REBALANCE_TARGET_DEFAULT,
    REBALANCE_DRIFT_THRESHOLD,
    MAX_MONTHLY_DRAWDOWN_PCT,
    MAX_SINGLE_STOCK_PCT,
    MAX_SINGLE_INDUSTRY_PCT,
    ALERT_TICK_SHORT_MS,
    ALERT_TICK_LONG_MS,
    TRADING_WINDOWS,
    ALERT_NOTIFY_COOLDOWN_MS,
    ALERT_LONG_FREQ_MS,
    ALERT_LONG_CACHE_TTL_MS,
    EARNINGS_WARNING_NEGATIVE_TYPES,
    EARNINGS_WARNING_FRESH_MS,
    VALUATION_PERCENTILE_WARN,
    VALUATION_INDEX_NAMES,
    VALUATION_PE_LOOKBACK_MO,
    VERIFY_OUTCOMES,
    VERIFY_FAILURE_REASONS,
    SCORECARD_MIN_SAMPLES,
    SCORECARD_CACHE_TTL_MS,
    BRIER_MIN_SAMPLES,
    CALIBRATION_BUCKET_EDGES,
    MODULE_TAG
  };
})();