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

  // ==================== AI 短线操盘手 T3: 日线级条件单 ====================

  /** 条件单存储上限 (kv paper_cond_orders, 滚动截断最旧) */
  const COND_ORDER_LIMIT = 100;

  /** 条件单有效期: createdAt 后第 N 个交易日仍未触发 → expired
   *  判定走 K 线交易日计数 (paper.js _tradingDaysAfter), 非自然日 */
  const COND_ORDER_EXPIRE_DAYS = 3;

  /** 短线持仓最长持有交易日数: 止损/止盈都未触发且持满 N 日 → 按当日收盘价强平 */
  const SHORT_MAX_HOLD_DAYS = 5;

  // ==================== 盘中操盘手 (Intraday Trader) ====================
  // AI 短线操盘手的盘中实时层: 1 分钟轮询, 本地 LLM 实时决策已持仓的止盈/止损/加仓/减仓
  // 新仓仍走 T2-T3 条件单, 跟盘中盯盘并存, 不替换

  /** 盘中操盘手轮询间隔: 1 分钟 (与 alerts.js 短线规则同节奏, 共享交易时段守卫) */
  const INTRADAY_TICK_MS = 60 * 1000;

  /** 拉多少根 5 分钟 K 线喂给本地 LLM 看盘 (近 30 根 ≈ 2.5 小时, 覆盖上午 + 下午开盘) */
  const INTRADAY_KLINE_BARS = 30;

  /** 单只持仓的最小持有分钟数: 不足不调仓 (防开仓后立刻被 LLM 反悔) */
  const INTRADAY_MIN_HOLD_MINUTES = 15;

  /** 同一只持仓相邻两次调仓的冷却期: 10 分钟 (防 LLM 反复横跳) */
  const INTRADAY_COOLDOWN_MS = 10 * 60 * 1000;

  /** 单次盘中决策本地 LLM 调用超时: 20 秒 (盯盘场景, 超时即放弃本轮不调仓) */
  const INTRADAY_LLM_TIMEOUT_MS = 20 * 1000;

  /** kv paper_intraday_log: 调仓决策日志, 上限 (滚动截断) */
  const INTRADAY_LOG_LIMIT = 200;

  /** 调仓动作上限: 单只持仓 1 天内最多调仓 N 次 (额外冷却, 跟 cooldown 互补) */
  const INTRADAY_MAX_DAILY_ACTIONS = 4;

  // ==================== 长线操盘手 (Long Trader) ====================
  // AI 长线 sleeve 自动选股 (对接 Screener 选股逻辑): 周一开盘前自动跑 AI 选股
  // → top N picks 自动成交到 long sleeve → 纪律引擎自动卡

  /** 长线操盘手检查间隔: 30 分钟 (不需要分钟级, 周频触发) */
  const LONG_TRADER_CHECK_MS = 30 * 60 * 1000;

  /** 自动选股挑几只成交到 long sleeve (默认 3 只, 适配 10 万现金 + 单票上限 20%) */
  const LONG_TRADER_TOP_N = 3;

  /** 喂 LLM 的硬筛上限: 取全市场涨跌幅前 30 只 (避免 token 爆) */
  const LONG_TRADER_HARD_SCREEN_TOP = 30;

  /** 重新运行间隔: 一周内已跑过不重复 (避免频繁调仓) */
  const LONG_TRADER_RERUN_DAYS = 7;

  /** long sleeve 现金下限: 不足 5000 不跑 (买不起单票) */
  const LONG_TRADER_MIN_CASH = 5000;

  /** kv paper_long_trader_log: 选股决策日志上限 (滚动截断) */
  const LONG_TRADER_LOG_LIMIT = 100;

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

  /** AI 验证归因枚举 (journals.verifyFailureReason, 非索引字段)
   *  P0-2 升级: 从 5 类扩到 8 类, 区分选股/择时/仓位三环
   *   - 选股错: 个股/行业问题, 同行业其他股票也跌 (说明入场时就该避开)
   *   - 择时错: 入场时机早或晚 (持有期 < 1 个交易日 = 择时过短)
   *   - 仓位过重: 单笔拖累 (亏损 > 资产 5% 但仓位占比 < 20%)
   *   - 追高/假设错误/时机过早/过度分析/其他: 保留 (兼容历史) */
  const VERIFY_FAILURE_REASONS = ['选股错', '择时错', '仓位过重', '追高', '假设错误', '时机过早', '过度分析', '其他'];
  /** 成绩单注入最少已验证样本数: 低于此数不注入, 避免误导 */
  const SCORECARD_MIN_SAMPLES = 3;

  /** 成绩单 prompt 文本缓存 TTL: 10 分钟 (内存缓存) */
  const SCORECARD_CACHE_TTL_MS = 10 * 60 * 1000;

  /** Brier / 校准最少样本数: 低于此数 UI 显示"积累中" */
  const BRIER_MIN_SAMPLES = 5;

  /** 校准分桶边界 (probability 百分比, lo 含 hi 不含): <40 / 40-60 / 60-80 / ≥80 */
  const CALIBRATION_BUCKET_EDGES = [0, 40, 60, 80, 101];

  // ==================== AI 短线操盘手 T2 (ShortTrader): 盘前计划生成 ====================

  /** ShortTrader 计划丢弃留痕上限 (kv paper_plan_log, 滚动截断最旧) */
  const SHORT_PLAN_LOG_LIMIT = 100;

  /** ShortTrader 盘前计划 prompt 注入的近 N 天短线 journal 摘要天数 */
  const SHORT_PLAN_JOURNAL_DAYS = 3;

  // ==================== AI 短线操盘手 T4 (ShortTrader): 学习环 ====================
  // 注: paper.js 旧版 T4 短线学习环 (kv paper_short_lessons 数组结构) 已下线,
  //   本套是唯一实现, 走"平仓机械 verify → 成绩单 → 周末教训提炼"路线, kv short_trader_lessons;
  //   旧 kv paper_morning_plan / paper_short_lessons 已废弃 (IndexedDB 残留数据无害, 代码不再读写)

  /** 平仓机械 verify: 平仓后至少 N 根后续日 K 才判定 (默认 1, 配合 10 根 K 窗口最多等 3 天数据齐) */
  const SHORT_VERIFY_DELAY_DAYS = 1;

  /** 平仓机械 verify: 出场后观察窗口 (止损收复 / 止盈续涨判定看的后续 K 线数) */
  const SHORT_VERIFY_LOOKAHEAD_BARS = 3;

  /** 平仓机械 verify: 每次拉取的日 K 根数 (只读, 不复权) */
  const SHORT_VERIFY_KLINE_BARS = 10;

  /** 止盈出场判定"卖早"的续涨阈值: 出场后观察窗内 high 超出场价 ×(1+N) → partial */
  const SHORT_TARGET_RUNUP_PCT = 0.05;

  /** 成绩单 prompt 注入文本上限 (字) */
  const SHORT_TRACK_RECORD_MAX_LEN = 400;

  /** 教训 items 上限 (kv short_trader_lessons.items, 新的挤掉最旧) */
  const SHORT_LESSONS_LIMIT = 20;

  /** 教训提炼间隔: 距上次 ≥7 天才再提炼 (周末错误模式提炼) */
  const SHORT_LESSONS_DISTILL_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

  /** 教训提炼触发门槛: 自上次以来新增已验证交易 ≥N 条 */
  const SHORT_LESSONS_MIN_NEW_SAMPLES = 5;

  /** 教训提炼喂给 LLM 的最近已验证交易条数 */
  const SHORT_LESSONS_FEED_MAX = 20;

  /** 单次提炼输出的教训条数上限 (2-3 条) */
  const SHORT_LESSONS_PER_DISTILL_MAX = 3;

  /** 单条教训文本上限 (字) */
  const SHORT_LESSONS_TEXT_MAX_LEN = 40;

  // ==================== 大盘状态机 (H3) ====================

  /** 大盘状态机监控的 3 只指数 (H3: 多指数共识)
   *  必须带 sh/sz 前缀 (data.js getIndexKLine 强制要求, 腾讯源规则)
   *  沪深 300 (大盘蓝筹) + 中证 1000 (中盘成长) + 国证 2000 (小微盘)
   *  2/3 多数共识 = MIN_INDEX_AGREE 决定最终 state */
  const REGIME_INDEX_CODES = ['sh000300', 'sh000852', 'sz399303'];

  /** 多指数共识门槛: 3 指数中至少 N 个同意, 才确认最终 state
   *  MIN_INDEX_AGREE=2 = 简单多数 (3 进 2 即可)
   *  兜底: 只剩 1 指数可用时 (其他失败), 该 1 指数本身即可决定 (1/1=100%) */
  const MIN_INDEX_AGREE = 2;

  /** 连续失灵熔断阈值 (H3: 数据源静默失效修复)
   *  refresh 连续失败 N 次 → 强制降级 range + stale:true (不再相信旧 state)
   *  成功一次 _staleFails = 0 (重置) */
  const STALE_FAIL_THRESHOLD = 3;

  /** ATR 计算回看周期 (与 _atr14 trueRange 均值一致) */
  const ATR_PERIOD = 14;

  /** ATR/close 动态阈值带边界 (H3: 替代固定 MA60×3% BAND)
   *  clamp(ATR14/close, [ATR_MIN_BAND, ATR_MAX_BAND])
   *  高波动市场 (ATR/close>6%) 上限夹 6%, 低波 (ATR/close<1%) 下限夹 1%
   *  K 线根数 < 14 → fallback BAND=0.03 旧固定值 */
  const ATR_MIN_BAND = 0.01;
  const ATR_MAX_BAND = 0.06;

  /** Regime legacy BAND 兜底值 (K 线 < 14 根时用, 与旧固定 MA60×(1-BAND) 等价) */
  const REGIME_FALLBACK_BAND = 0.03;

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
    COND_ORDER_LIMIT,
    COND_ORDER_EXPIRE_DAYS,
    SHORT_MAX_HOLD_DAYS,
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
    SHORT_PLAN_LOG_LIMIT,
    SHORT_PLAN_JOURNAL_DAYS,
    SHORT_VERIFY_DELAY_DAYS,
    SHORT_VERIFY_LOOKAHEAD_BARS,
    SHORT_VERIFY_KLINE_BARS,
    SHORT_TARGET_RUNUP_PCT,
    SHORT_TRACK_RECORD_MAX_LEN,
    SHORT_LESSONS_LIMIT,
    SHORT_LESSONS_DISTILL_INTERVAL_MS,
    SHORT_LESSONS_MIN_NEW_SAMPLES,
    SHORT_LESSONS_FEED_MAX,
    SHORT_LESSONS_PER_DISTILL_MAX,
    SHORT_LESSONS_TEXT_MAX_LEN,
    REGIME_INDEX_CODES,
    MIN_INDEX_AGREE,
    STALE_FAIL_THRESHOLD,
    ATR_PERIOD,
    ATR_MIN_BAND,
    ATR_MAX_BAND,
    REGIME_FALLBACK_BAND,
    MODULE_TAG
  };
})();
