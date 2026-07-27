/**
 * Paper - 模拟盘 (Paper Trading, Phase A)
 * 虚拟资金 + 独立持仓, 用于验证 AI 建议的真实胜率/回撤
 *
 * 设计:
 *   - 模拟账户: kv 'paper_account' = { initialCash, cash, createdAt, positionPct }
 *   - T1 分账户 (sleeve): 'long' 长线模拟 (存量, 沿用 paper_account) + 'short' AI 短线
 *     (新 kv 'paper_account_short', 初始 3 万); holdings/transactions 行加非索引字段
 *     sleeve ('long'|'short'), 存量行无此字段一律视为 'long' —— 所有过滤用
 *     (row.sleeve || 'long') === sleeve 的写法, 不改 DB schema 不做数据迁移
 *   - 每日快照: kv 'paper_snapshots' = [{ date, paperTotal, realTotal, csi300, shortTotal }]
 *     (shortTotal = 短线子账户总资产, T1 新增; 老快照无此字段, 图表端容错) (上限 365 条)
 *   - 模拟持仓: 复用 holdings 表, 行上 isPaper=true (真实持仓无此字段, undefined 即真实)
 *   - 模拟交易: 复用 transactions 表, 同样 isPaper=true
 *   - 费用: 佣金万三 (最低 5 元), 卖出另加印花税万五
 *   - A股整手: 买入股数向下取整到 100 的倍数
 *   - 隔离: 真实视图 (holdings/account/journal/app.js) 读取时 .filter(h => !h.isPaper)
 *   - Phase B: 手动/AI 自动买入前走 Core.Discipline.preBuyCheck (isPaper=true, 模拟口径独立锚定)
 *   - Phase C: 日终小结 (kv paper_eod_reports, 上限 60 条): 工作日 15:30 后自动生成
 *     (app 启动 + 页面展示时检查); 纪律拦截日志 kv paper_discipline_log (上限 100 条);
 *     kv feishu_webhook 配置后自动推送飞书
 *   - Phase T3: 日线级条件单引擎 (AI 短线操盘手):
 *     kv paper_cond_orders (上限 100) 条件单 + kv paper_short_positions 在持仓位跟踪
 *     + kv paper_cond_settle { lastSettleDate } 当日防重复;
 *     settleCondOrders() 每日结算 (app 启动 + 模拟盘页展示时异步调), 用最新一根
 *     已收盘日 K 判定买入触发/止损/止盈/到期强平/过期, 全程不调实时行情
 *   - Phase T2: 盘前 AI 计划 (AI 短线操盘手):
 *     kv paper_morning_plan (上限 10) 每日缓存 + 强制刷新; 候选条件单 ≤3 笔
 *     (回调 below / 突破 above), 走纪律预演 + 用户手动确认创建; lessons 自动
 *     注入 (T4 闭环, lessons 未落地前空降级); LLM 入口 Core.AI.call, 可注入
 *     opts.deps.callLLM 走 mock
 *   - Phase T4: 短线学习环 (AI 短线操盘手):
 *     kv paper_short_lessons (上限 50) 提炼当日短线交易 + 持仓盈亏 + 纪律拦截
 *     为 ≤5 条 lessons (category/severity/refCode); 工作日 ≥15:30 自动 + 手动
 *     [🪞 立刻提炼] 双触发; lessons 自动注入到 T2 prompt
 */
(function() {
  'use strict';

  const COMMISSION_RATE = 0.0003;      // 佣金万三
  const COMMISSION_MIN = 5;            // 佣金最低 5 元
  const STAMP_TAX_RATE = 0.0005;       // 印花税万五 (仅卖出)
  const LOT_SIZE = Core.Constants.LOT_SIZE;   // A 股一手
  const SNAPSHOT_LIMIT = 365;          // 快照上限
  const EOD_LIMIT = 60;                // 日终小结上限 (kv paper_eod_reports)
  const DISCIPLINE_LOG_LIMIT = 100;    // 纪律拦截日志上限 (kv paper_discipline_log)
  const EOD_MINUTES = 15 * 60 + 30;    // 日终小结生成时间: 工作日 15:30 后
  const DEFAULT_CASH = 100000;         // 默认初始虚拟资金 (长线子账户)
  const DEFAULT_POSITION_PCT = Core.Constants.SUGGEST_PCT_PAPER;  // AI 自动成交单次仓位比例
  const SHORT_CASH = Core.Constants.PAPER_SHORT_CASH;             // AI 短线子账户初始资金 (T1)
  const SHORT_POSITION_PCT = Core.Constants.PAPER_SHORT_POSITION_PCT;  // 短线单笔仓位比例 (T1)
  const COND_ORDER_LIMIT = Core.Constants.COND_ORDER_LIMIT;            // 条件单上限 (T3)
  const COND_ORDER_EXPIRE_DAYS = Core.Constants.COND_ORDER_EXPIRE_DAYS;  // 条件单有效期 (交易日, T3)
  const SHORT_MAX_HOLD_DAYS = Core.Constants.SHORT_MAX_HOLD_DAYS;      // 短线最长持有交易日 (T3)
  const MARKET_CLOSE_MINUTES = 15 * 60;   // A 股 15:00 收盘: 之后当日 K 视为已收盘 (T3 结算语义)
  // T2: 盘前 AI 计划
  const PLAN_LIMIT = Core.Constants.PLAN_LIMIT;                       // 盘前计划滚动上限
  const PLAN_CANDIDATES_MAX = Core.Constants.PLAN_CANDIDATES_MAX;     // 单份计划最大候选数
  const PLAN_LESSON_INJECT_MAX = Core.Constants.PLAN_LESSON_INJECT_MAX;  // 注入 lessons 条数 (T4 闭环)
  // T4: 短线学习环
  const LESSON_LIMIT = Core.Constants.LESSON_LIMIT;                   // lessons 滚动上限
  const LESSON_EXTRACT_MAX = Core.Constants.LESSON_EXTRACT_MAX;       // 单次提炼最大条数
  const LESSON_LAST_RUN_DATE_KEY = Core.Constants.LESSON_LAST_RUN_DATE_KEY;  // 当日去重 kv
  const LESSON_MIN_HOLD_MIN = Core.Constants.LESSON_MIN_HOLD_MIN;     // 最小持有分钟 (过滤逃命单)
  const LESSON_CATEGORIES = Core.Constants.LESSON_CATEGORIES;         // category 白名单
  const LESSON_SEVERITIES = Core.Constants.LESSON_SEVERITIES;         // severity 枚举 (权重升序)

  const Paper = {

    async init() {
      // T1: 两个子账户各自初始化, 已存在则不覆盖
      for (const sleeve of ['long', 'short']) {
        const acc = await Core.Storage.kvGet(this._accountKey(sleeve));
        if (!acc) await this._saveAccountRaw(sleeve, this._defaultAccount(sleeve));
      }
      // 启动时尝试记当日快照 (失败不阻塞启动)
      this.snapshotIfNeeded().catch(e => console.warn('[Paper] 启动快照失败:', e));
      // T4: 启动时检查是否该跑学习环 (工作日 15:30 后 + 今日未跑)
      this.maybeRunShortLearningLoop().catch(e => console.warn('[Paper] T4 启动追跑失败:', e));
    },

    // ========== 纯函数 (不依赖 DOM/IndexedDB, Node 沙箱可测) ==========

    /**
     * 交易费用: 佣金万三 (最低 5 元) + 卖出印花税万五
     * @param {number} amount 成交金额
     * @param {string} side 'buy' | 'sell'
     * @returns {{ commission: number, stampTax: number, total: number }}
     */
    _calcFee(amount, side) {
      // 金额四舍五入到分, 避免浮点尾差 (如 100000×0.0003=29.999...)
      const commission = +Math.max(amount * COMMISSION_RATE, COMMISSION_MIN).toFixed(2);
      const stampTax = side === 'sell' ? +(amount * STAMP_TAX_RATE).toFixed(2) : 0;
      return { commission, stampTax, total: +(commission + stampTax).toFixed(2) };
    },

    /** A股整手: 向下取整到 100 的倍数 */
    _roundLot(shares) {
      return Math.floor((parseFloat(shares) || 0) / LOT_SIZE) * LOT_SIZE;
    },

    /**
     * 快照 append: 同日去重, 上限 SNAPSHOT_LIMIT 条 (滚动截断最旧)
     * 纯函数, 返回新数组, 不改入参
     */
    _pushSnapshot(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.date && !arr.some(s => s.date === entry.date)) arr.push(entry);
      return arr.slice(-SNAPSHOT_LIMIT);
    },

    /**
     * AI 自动成交计划: 买入金额 = 现金 × positionPct, 换算整手股数
     * 现金不够付 (含手续费) 或不足一手 → null (调用方 console.warn 跳过)
     */
    _planAutoTrade(cash, positionPct, price) {
      cash = parseFloat(cash) || 0;
      price = parseFloat(price) || 0;
      if (cash <= 0 || price <= 0) return null;
      let shares = this._roundLot(cash * positionPct / price);
      // 手续费可能把总金额顶过现金, 逐手递减
      while (shares >= LOT_SIZE) {
        const amount = shares * price;
        if (amount + this._calcFee(amount, 'buy').total <= cash) return shares;
        shares -= LOT_SIZE;
      }
      return null;
    },

    // ---- Phase C: 日终小结 (EOD) 纯函数 ----

    /**
     * 是否该生成日终小结: 工作日 (周一至周五) 且 ≥15:30 且今日无记录
     * 纯函数, 时间/已有记录都注入 (节假日判断本期不做, 周末硬排除)
     * @param {Date|number|string} now
     * @param {Array} existing kv paper_eod_reports 当前值
     */
    _shouldGenerateEod(now, existing) {
      const d = now instanceof Date ? now : new Date(now);
      if (isNaN(d.getTime())) return false;
      const wd = d.getDay();
      if (wd === 0 || wd === 6) return false;  // 周末
      if (d.getHours() * 60 + d.getMinutes() < EOD_MINUTES) return false;  // 15:30 前
      const today = fmtDate(d);
      return !(Array.isArray(existing) && existing.some(r => r && r.date === today));
    },

    /** 日终小结 append: 同日去重, 上限 EOD_LIMIT 条 (滚动截断最旧), 纯函数 */
    _pushEodReport(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.date && !arr.some(r => r.date === entry.date)) arr.push(entry);
      return arr.slice(-EOD_LIMIT);
    },

    /** 纪律拦截日志 append: 上限 DISCIPLINE_LOG_LIMIT 条, 纯函数 */
    _appendDisciplineLog(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.code) arr.push(entry);
      return arr.slice(-DISCIPLINE_LOG_LIMIT);
    },

    // ========== 账户与持仓 ==========

    // ---- T1: 账户读写私有助手 (按 sleeve 分 kv, 收口于此避免 if-else 散落) ----

    /** sleeve → kv key ('long' 沿用存量 paper_account 不迁移, 'short' 用新 key) */
    _accountKey(sleeve) {
      return sleeve === 'short' ? 'paper_account_short' : 'paper_account';
    },

    /** sleeve → 出厂默认账户 (kv 缺失时用; 现金/仓位比例默认值都在 Core.Constants) */
    _defaultAccount(sleeve) {
      const cash = sleeve === 'short' ? SHORT_CASH : DEFAULT_CASH;
      return {
        initialCash: cash,
        cash,
        createdAt: Date.now(),
        positionPct: sleeve === 'short' ? SHORT_POSITION_PCT : DEFAULT_POSITION_PCT
      };
    },

    /** 读账户原始对象 (kv 缺失返回默认值, 不写回) */
    async _getAccountRaw(sleeve = 'long') {
      const acc = await Core.Storage.kvGet(this._accountKey(sleeve));
      return acc || this._defaultAccount(sleeve);
    },

    /** 写账户 */
    async _saveAccountRaw(sleeve, acc) {
      await Core.Storage.kvSet(this._accountKey(sleeve), acc);
    },

    /** 模拟账户 (sleeve 默认 'long' 向后兼容; kv 不存在时返回默认值) */
    async getAccount(sleeve = 'long') {
      return this._getAccountRaw(sleeve);
    },

    /** 模拟持仓原始行 (holdings 表 isPaper=true, 按 sleeve 过滤; 存量行无 sleeve 字段 = 'long') */
    async _getPaperHoldings(sleeve = 'long') {
      const all = await Core.Storage.all('holdings');
      return (all || []).filter(h => h.isPaper && (h.sleeve || 'long') === sleeve);
    },

    /**
     * 模拟持仓 + 实时行情: [{ ...h, shares, costPrice, price, cost, mkt, pl, plPct }]
     * 单只行情失败 → price/mkt/pl 为 null, 不阻塞其他
     */
    async getPositions(sleeve = 'long') {
      const rows = await this._getPaperHoldings(sleeve);
      const quotes = {};
      await Promise.all(rows.map(async h => {
        try {
          const q = await Core.Data.getStockQuote(h.code);
          if (q) quotes[h.code] = parseFloat(q.最新价 ?? q.price ?? 0) || null;
        } catch (e) {
          console.warn('[Paper] 拉行情失败:', h.code, e);
        }
      }));
      return rows.map(h => {
        const shares = parseFloat(h.shares) || 0;
        const costPrice = parseFloat(h.costPrice) || 0;
        const price = quotes[h.code] ?? null;
        const cost = shares * costPrice;
        const mkt = price !== null ? shares * price : null;
        const pl = mkt !== null ? mkt - cost : null;
        const plPct = pl !== null && cost > 0 ? pl / cost : null;
        return { ...h, shares, costPrice, price, cost, mkt, pl, plPct };
      });
    },

    // ========== 交易 ==========

    /**
     * 模拟买入 (实时价成交, 计手续费)
     * @param {string} code 6 位代码
     * @param {string} name 名称 (可空)
     * @param {string} market sh/sz (可空, 自动按代码前缀推导)
     * @param {number} shares 股数 (自动向下取整到整手)
     * @param {{ assumption?: string, stopLoss?: number, targetPrice?: number, disciplineWarns?: string[], auto?: boolean,
     *           falsifyCondition?: string, invalidation?: string, sleeve?: 'long'|'short',
     *           price?: number, tradeDate?: string }} [opts]
     *        Phase B 纪律信息: 非索引字段, 写到 holdings/transactions 行上 (不改 schema);
     *        auto=true 标记 AI 自动成交 (Phase C 日终小结 🤖 标注用);
     *        falsifyCondition/invalidation 为 Phase D1 pre-mortem 沉淀 (只写 transactions 行);
     *        sleeve 子账户 (T1), 默认 'long' 向后兼容;
     *        targetPrice 止盈价 (T3 条件单, 与 stopLoss 同款写 holdings 行);
     *        price/tradeDate 成交价与成交日期覆盖 (T3 日线结算按 K 线价成交, 缺省 = 实时价/今天)
     * @returns 持仓行 | null (失败 toast + 返回 null)
     */
    async buy(code, name, market, shares, opts = {}) {
      try {
        const sleeve = opts.sleeve === 'short' ? 'short' : 'long';
        shares = this._roundLot(shares);
        if (shares < LOT_SIZE) { toastError(`买入不足一手 (${LOT_SIZE} 股)`); return null; }
        // T3: 结算传入 K 线成交价时跳过实时行情 (拉不到价也能成交)
        const overridePrice = parseFloat(opts.price) || 0;
        const q = overridePrice > 0 ? null : await Core.Data.getStockQuote(code);
        const price = overridePrice > 0 ? overridePrice : (q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0);
        if (!price) { toastError('拉不到实时价, 无法成交'); return null; }
        const amount = shares * price;
        const fee = this._calcFee(amount, 'buy');
        const acc = await this._getAccountRaw(sleeve);
        if (amount + fee.total > acc.cash) {
          toastError(`现金不足: 需 ${fmtMoney(amount + fee.total)} (含费), 可用 ${fmtMoney(acc.cash)}`);
          return null;
        }

        // 移动加权成本 (与真实持仓 Holdings.saveTx 一致; 费用不摊入成本, 只扣现金)
        const now = Date.now();
        const rows = await this._getPaperHoldings(sleeve);
        // 同 code 不同子账户各自成行 (rows 已按 sleeve 过滤)
        let h = rows.find(x => x.code === code) || null;
        if (h) {
          const totalShares = h.shares + shares;
          h.costPrice = (h.shares * h.costPrice + shares * price) / totalShares;
          h.shares = totalShares;
          if (name && !h.name) h.name = name;
          // Phase B: 加仓时若调用方给了新的假设/止损, 一并更新 (非索引字段)
          if (opts.assumption) h.assumption = opts.assumption;
          if (opts.stopLoss) h.stopLoss = opts.stopLoss;
          if (opts.targetPrice) h.targetPrice = opts.targetPrice;  // T3: 止盈价
          h.updatedAt = now;
          await Core.Storage.put('holdings', h);
        } else {
          h = {
            id: uuid(),
            code,
            name: name || (q && q.名称) || '',
            market: market || Core.Util.stockCodePrefix(code),
            shares,
            costPrice: price,
            isPaper: true,
            sleeve,   // T1: 新行总是写 sleeve (非索引字段); 存量老行无此字段按 'long' 处理
            createdAt: now,
            updatedAt: now
          };
          if (opts.assumption) h.assumption = opts.assumption;
          if (opts.stopLoss) h.stopLoss = opts.stopLoss;
          if (opts.targetPrice) h.targetPrice = opts.targetPrice;  // T3: 止盈价
          await Core.Storage.add('holdings', h);
        }
        const tx = {
          id: uuid(), holdingId: h.id, code,
          type: 'buy', date: opts.tradeDate || fmtDate(new Date()),
          price, shares, fee: fee.total,
          isPaper: true, sleeve, createdAt: now
        };
        // Phase B 纪律信息 (非索引字段): 假设/止损/警告快照
        if (opts.assumption) tx.assumption = opts.assumption;
        if (opts.stopLoss) tx.stopLoss = opts.stopLoss;
        if (opts.disciplineWarns && opts.disciplineWarns.length) tx.disciplineWarns = opts.disciplineWarns;
        if (opts.auto) tx.auto = true;  // Phase C: AI 自动成交标记 (日终小结 🤖)
        // Phase D1: pre-mortem 证伪/失效条件 (非索引字段, 事后验证对照用)
        if (opts.falsifyCondition) tx.falsifyCondition = opts.falsifyCondition;
        if (opts.invalidation) tx.invalidation = opts.invalidation;
        await Core.Storage.add('transactions', tx);
        acc.cash = +(acc.cash - amount - fee.total).toFixed(2);
        await this._saveAccountRaw(sleeve, acc);
        toastSuccess(`模拟买入 ${code} ${shares} 股 @ ${price} (费 ${fmtMoney(fee.total)})`);
        return h;
      } catch (e) {
        console.warn('[Paper] 买入失败:', e);
        toastError('模拟买入失败: ' + e.message);
        return null;
      }
    },

    /**
     * 模拟卖出 (实时价成交, 计佣金 + 印花税)
     * @param {string} holdingId 模拟持仓行 id
     * @param {number} shares 股数 (卖出不限整手, 但不得超过持仓)
     * @param {{ price?: number, tradeDate?: string, reason?: string }} [opts]
     *        T3 日线结算: price 覆盖成交价 (K 线价, 跳过实时行情),
     *        tradeDate 覆盖交易日期 (K 线日期), reason 卖出原因 (写 transactions 行 exitReason)
     * @returns 持仓行 | null (失败 toast + 返回 null)
     */
    async sell(holdingId, shares, opts = {}) {
      try {
        const h = await Core.Storage.get('holdings', holdingId);
        if (!h || !h.isPaper) { toastError('模拟持仓不存在'); return null; }
        // T1: sleeve 从持仓行读 (存量行无字段 = 'long'), 现金自动回笼到对应子账户
        const sleeve = h.sleeve === 'short' ? 'short' : 'long';
        shares = parseFloat(shares) || 0;
        if (shares <= 0) { toastError('卖出股数必须 > 0'); return null; }
        if (shares > h.shares) { toastError(`卖出股数超过持仓 (持有 ${h.shares})`); return null; }
        // T3: 结算传入 K 线成交价时跳过实时行情
        const overridePrice = parseFloat(opts.price) || 0;
        const q = overridePrice > 0 ? null : await Core.Data.getStockQuote(h.code);
        const price = overridePrice > 0 ? overridePrice : (q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0);
        if (!price) { toastError('拉不到实时价, 无法成交'); return null; }
        const amount = shares * price;
        const fee = this._calcFee(amount, 'sell');
        const now = Date.now();
        h.shares -= shares;
        if (h.shares <= 0) {
          // 清仓: 删持仓行 (交易记录保留)
          await Core.Storage.remove('holdings', h.id);
        } else {
          h.updatedAt = now;
          await Core.Storage.put('holdings', h);
        }
        await Core.Storage.add('transactions', {
          id: uuid(), holdingId: h.id, code: h.code,
          type: 'sell', date: opts.tradeDate || fmtDate(new Date()),
          price, shares, fee: fee.total,
          isPaper: true, sleeve, createdAt: now,
          ...(opts.reason ? { exitReason: opts.reason } : {})   // T3: 卖出原因 (止损/止盈/强平)
        });
        const acc = await this._getAccountRaw(sleeve);
        acc.cash = +(acc.cash + amount - fee.total).toFixed(2);
        await this._saveAccountRaw(sleeve, acc);
        toastSuccess(`模拟卖出 ${h.code} ${shares} 股 @ ${price} (费 ${fmtMoney(fee.total)})`);
        return h;
      } catch (e) {
        console.warn('[Paper] 卖出失败:', e);
        toastError('模拟卖出失败: ' + e.message);
        return null;
      }
    },

    /** 重置模拟盘子账户: 只清对应 sleeve 的持仓/交易, 现金恢复该账户初始值 (confirm 确认) */
    async resetAccount(sleeve = 'long') {
      sleeve = sleeve === 'short' ? 'short' : 'long';
      const label = sleeve === 'short' ? 'AI 短线' : '长线模拟';
      if (!confirm(`确定重置${label}子账户? 该账户的模拟持仓/交易记录清空, 现金恢复初始值 (另一子账户不受影响)`)) return;
      try {
        for (const h of await this._getPaperHoldings(sleeve)) {
          await Core.Storage.remove('holdings', h.id);
        }
        const txs = ((await Core.Storage.all('transactions')) || [])
          .filter(t => t.isPaper && (t.sleeve || 'long') === sleeve);
        for (const t of txs) {
          await Core.Storage.remove('transactions', t.id);
        }
        const acc = await this._getAccountRaw(sleeve);
        acc.cash = acc.initialCash;
        await this._saveAccountRaw(sleeve, acc);
        // 快照是双账户合并口径 (含 shortTotal), 只在重置长线时清空 (保持历史行为);
        // 短线重置不动曲线, 次日起 shortTotal 自然回到初始资金
        if (sleeve === 'long') await Core.Storage.kvSet('paper_snapshots', []);
        // T3: 短线重置连带清空条件单/在持仓位跟踪/结算记录 (与持仓同属短线账本)
        if (sleeve === 'short') {
          await Core.Storage.kvSet('paper_cond_orders', []);
          await Core.Storage.kvSet('paper_short_positions', []);
          await Core.Storage.kvSet('paper_cond_settle', {});
        }
        toastSuccess(`${label}子账户已重置`);
        this.renderPage();
      } catch (e) {
        console.warn('[Paper] 重置失败:', e);
        toastError('重置失败: ' + e.message);
      }
    },

    // ========== 每日快照 ==========

    /**
     * 每日快照 (每天一次, 当天已存在则跳过)
     * 口径:
     *   - paperTotal = 长线模拟现金 + 长线模拟持仓市值
     *   - shortTotal = 短线模拟现金 + 短线模拟持仓市值 (T1 新增; 老快照无此字段, 图表端容错)
     *   - realTotal  = 真实持仓市值 (仅股票市值, 不含现金/基金)
     *   - csi300     = 沪深300 现价点位 (拉不到则 null)
     */
    async snapshotIfNeeded() {
      const today = fmtDate(new Date());
      const snaps = (await Core.Storage.kvGet('paper_snapshots')) || [];
      if (snaps.some(s => s.date === today)) return snaps;

      const acc = await this._getAccountRaw('long');
      const positions = await this.getPositions('long');
      const paperTotal = acc.cash + positions.reduce((s, p) => s + (p.mkt || 0), 0);

      // T1: 短线子账户总资产
      const shortAcc = await this._getAccountRaw('short');
      const shortPositions = await this.getPositions('short');
      const shortTotal = shortAcc.cash + shortPositions.reduce((s, p) => s + (p.mkt || 0), 0);

      // 真实持仓市值 (与 account.js 同款: 逐只 getStockQuote; 排除模拟盘行)
      let realTotal = 0;
      try {
        const realHoldings = ((await Core.Storage.all('holdings')) || []).filter(h => !h.isPaper);
        await Promise.all(realHoldings.map(async h => {
          try {
            const q = await Core.Data.getStockQuote(h.code);
            const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
            realTotal += (parseFloat(h.shares) || 0) * price;
          } catch (e) { /* 单只失败按 0 计 */ }
        }));
      } catch (e) {
        console.warn('[Paper] 真实持仓市值计算失败:', e);
      }

      // 沪深300 现价 (getIndexSpot: 腾讯优先, 失败降级 aktools)
      let csi300 = null;
      try {
        const idx = await Core.Data.getIndexSpot();
        const row = (idx || []).find(i => (i.代码 || i.code) === '000300');
        if (row) csi300 = parseFloat(row.最新价 ?? row.price ?? 0) || null;
      } catch (e) {
        console.warn('[Paper] 沪深300 拉取失败:', e);
      }

      const next = this._pushSnapshot(snaps, {
        date: today,
        paperTotal: +paperTotal.toFixed(2),
        realTotal: +realTotal.toFixed(2),
        csi300,
        shortTotal: +shortTotal.toFixed(2)
      });
      await Core.Storage.kvSet('paper_snapshots', next);
      return next;
    },

    // ========== AI 自动成交钩子 ==========

    /**
     * AI 选股自动成交 (screener._addWatchlistFromPick 加自选成功后调用)
     * @param {{ code: string, name?: string, market?: string, sleeve?: 'long'|'short',
     *           falsifyCondition?: string, invalidation?: string }} pick
     *        falsifyCondition/invalidation: Phase D1 pre-mortem 沉淀, 透传到 transactions 行;
     *        sleeve: T1 预留 (T2 AI 短线计划传 'short'), 默认 'long' 维持现状
     * 买入金额 = 模拟现金 × positionPct; 现金不足/不足一手/任何失败 → console.warn 跳过, 不 throw
     */
    async autoTradeFromPick(pick) {
      try {
        if (!pick || !pick.code) return null;
        const sleeve = pick.sleeve === 'short' ? 'short' : 'long';
        const acc = await this._getAccountRaw(sleeve);
        const q = await Core.Data.getStockQuote(pick.code);
        const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        const shares = this._planAutoTrade(acc.cash, acc.positionPct, price);
        if (!shares) {
          console.warn(`[Paper] 自动成交跳过 ${pick.code}: 现金 ${acc.cash} 买不起一手 (价 ${price})`);
          return null;
        }
        // Phase B 交易纪律: AI 自动成交走同一套 preBuyCheck (T1: 按 sleeve 分账户口径)
        // blocks 命中 → console.warn 跳过该笔 (不打扰用户); warns 无人确认不阻塞, 写入交易行 disciplineWarns
        if (Core.Discipline && Core.Discipline.preBuyCheck) {
          // AI 场景无人工假设: 固定归到"题材催化"; 止损默认 成交价 × 0.92 (-8%)
          const assumption = '题材催化';
          const stopLoss = +(price * Core.Constants.STOP_LOSS_RATIO_AUTO).toFixed(2);
          const chk = await Core.Discipline.preBuyCheck({
            code: pick.code, name: pick.name || '', market: pick.market || '',
            price, shares, amount: shares * price,
            isPaper: true, sleeve, assumption, stopLoss
          });
          if (!chk.ok) {
            console.warn(`[Paper] 自动成交被纪律引擎拦截 ${pick.code}:`, chk.blocks.join('；'));
            // Phase C: 拦截写 kv paper_discipline_log, 日终小结回溯用 (console.warn 无法回溯)
            await this._logDisciplineBlock(pick.code, chk.blocks);
            return null;
          }
          return await this.buy(pick.code, pick.name || '', pick.market || '', shares,
            { assumption, stopLoss, disciplineWarns: chk.warns, auto: true, sleeve,
              falsifyCondition: pick.falsifyCondition, invalidation: pick.invalidation });
        }
        return await this.buy(pick.code, pick.name || '', pick.market || '', shares,
          { auto: true, sleeve, falsifyCondition: pick.falsifyCondition, invalidation: pick.invalidation });
      } catch (e) {
        console.warn('[Paper] 自动成交失败:', e);
        return null;
      }
    },

    // ========== Phase C: 日终小结 (EOD) ==========

    /**
     * 纪律拦截日志: AI 自动成交被 blocks 跳过时 append kv paper_discipline_log
     * { date, code, reasons }, 上限 100 条; 写失败只 warn 不影响交易流程
     */
    async _logDisciplineBlock(code, reasons) {
      try {
        const log = (await Core.Storage.kvGet('paper_discipline_log')) || [];
        const next = this._appendDisciplineLog(log, {
          date: fmtDate(new Date()),
          code,
          reasons: Array.isArray(reasons) ? reasons : [String(reasons)]
        });
        await Core.Storage.kvSet('paper_discipline_log', next);
      } catch (e) {
        console.warn('[Paper] 纪律拦截日志写入失败:', e);
      }
    },

    /**
     * 日终小结入口: app 启动 (init 后不 await) + 模拟盘页面展示时调用
     * 条件: 工作日 且 ≥15:30 且 kv paper_eod_reports 无今日记录 (_shouldGenerateEod)
     * 生成失败只 warn 返回 null, 不 throw 不阻塞启动/页面
     * @param {Date} [now] 可注入 (测试用)
     * @returns 报告对象 | null
     */
    async maybeGenerateEodReport(now = new Date()) {
      try {
        const reports = (await Core.Storage.kvGet('paper_eod_reports')) || [];
        if (!this._shouldGenerateEod(now, reports)) return null;
        const report = await this._buildEodReport(now);
        await Core.Storage.kvSet('paper_eod_reports', this._pushEodReport(reports, report));
        // 飞书推送 (kv feishu_webhook 已配置才推; 失败只 warn 不影响功能)
        await this._pushEodToFeishu(report);
        return report;
      } catch (e) {
        console.warn('[Paper] 日终小结生成失败:', e);
        return null;
      }
    },

    /**
     * 汇总当日小结数据 (纯数据, 不调 LLM):
     *   现金/持仓市值/总资产/当日盈亏 (对照昨日快照) + 当日成交 (🤖=AI 自动) + 纪律拦截 + 持仓盈亏 Top/Bottom
     *   T1: 主报告口径 = 长线子账户 (保持既有字段不变); 短线子账户聚成 short 段, 合并卡片分段展示
     */
    async _buildEodReport(now) {
      const today = fmtDate(now);
      const acc = await this._getAccountRaw('long');
      const positions = await this.getPositions('long');
      const mktValue = +(positions.reduce((s, p) => s + (p.mkt || 0), 0)).toFixed(2);
      // FIX-3: 总资产口径与纪律检查对齐 (paper: cash + stockMkt, 不含基金)
      const totalAssets = +(acc.cash + mktValue).toFixed(2);

      // 当日盈亏 = 当前总资产 - 最近一条早于今日的快照 paperTotal (无快照则 null)
      const snaps = (await Core.Storage.kvGet('paper_snapshots')) || [];
      const prev = [...snaps].reverse().find(s => s.date && s.date < today) || null;
      const dayPnl = prev && typeof prev.paperTotal === 'number'
        ? +(totalAssets - prev.paperTotal).toFixed(2)
        : null;

      // 当日成交 (isPaper + 本 sleeve 且 date=今天; AI 自动成交: auto 标记, 兼容旧数据用 assumption='题材催化' 推断)
      const allTx = (await Core.Storage.all('transactions')) || [];
      const tradeOf = (sleeve) => allTx
        .filter(t => t.isPaper && t.date === today && (t.sleeve || 'long') === sleeve)
        .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
        .map(t => ({
          type: t.type, code: t.code,
          price: t.price, shares: t.shares, fee: t.fee,
          auto: t.auto === true || t.assumption === '题材催化'
        }));
      const trades = tradeOf('long');

      // 当日纪律拦截 (kv paper_discipline_log 里今天的部分)
      const dlog = (await Core.Storage.kvGet('paper_discipline_log')) || [];
      const discipline = dlog.filter(x => x && x.date === today);

      // 持仓盈亏 Top/Bottom 各 1 (按 plPct; 只有 1 只持仓时 Bottom 省略)
      const sorted = positions.filter(p => p.plPct !== null).sort((a, b) => b.plPct - a.plPct);
      const pickPl = p => p ? { code: p.code, name: p.name || '', pl: +p.pl.toFixed(2), plPct: p.plPct } : null;
      const top = pickPl(sorted[0]);
      const bottom = sorted.length > 1 ? pickPl(sorted[sorted.length - 1]) : null;

      // T1: 短线子账户段 (现金/市值/总资产/当日盈亏对照 prev.shortTotal, 老快照无此字段则 null)
      const shortAcc = await this._getAccountRaw('short');
      const shortPositions = await this.getPositions('short');
      const shortMktValue = +(shortPositions.reduce((s, p) => s + (p.mkt || 0), 0)).toFixed(2);
      const shortTotalAssets = +(shortAcc.cash + shortMktValue).toFixed(2);
      const short = {
        cash: +shortAcc.cash.toFixed(2),
        mktValue: shortMktValue,
        totalAssets: shortTotalAssets,
        dayPnl: prev && typeof prev.shortTotal === 'number'
          ? +(shortTotalAssets - prev.shortTotal).toFixed(2)
          : null,
        trades: tradeOf('short')
      };

      return {
        date: today,
        generatedAt: Date.now(),
        cash: +acc.cash.toFixed(2),
        mktValue,
        totalAssets,
        prevDate: prev ? prev.date : null,
        dayPnl,
        trades,
        discipline,
        top,
        bottom,
        short
      };
    },

    /** 小结纯文本版 (飞书推送用) */
    _formatEodReportText(report) {
      const L = [`📋 模拟盘日终小结 ${report.date}`];
      L.push(`💵 现金 ${report.cash} | 📊 持仓市值 ${report.mktValue} | 💰 总资产 ${report.totalAssets}`);
      L.push(report.dayPnl !== null
        ? `📈 当日盈亏 ${report.dayPnl >= 0 ? '+' : ''}${report.dayPnl} (对照 ${report.prevDate} 快照)`
        : '📈 当日盈亏: 无昨日快照可对照');
      if (report.trades.length > 0) {
        L.push(`💸 当日成交 ${report.trades.length} 笔:`);
        for (const t of report.trades) {
          L.push(`  ${t.auto ? '🤖 ' : ''}${t.type === 'buy' ? '买入' : '卖出'} ${t.code} @${t.price} ×${t.shares} 费${t.fee}`);
        }
      } else {
        L.push('💸 当日无成交');
      }
      if (report.discipline.length > 0) {
        L.push(`🛡 纪律拦截 ${report.discipline.length} 笔:`);
        for (const d of report.discipline) {
          L.push(`  ${d.code}: ${(d.reasons || []).join('；')}`);
        }
      }
      if (report.top) L.push(`🏆 最佳持仓 ${report.top.code} ${report.top.name} ${(report.top.plPct * 100).toFixed(2)}%`);
      if (report.bottom) L.push(`📉 最差持仓 ${report.bottom.code} ${report.bottom.name} ${(report.bottom.plPct * 100).toFixed(2)}%`);
      // T1: 短线子账户段 (有 short 字段才输出, 兼容旧报告)
      if (report.short) {
        const s = report.short;
        L.push(`⚡ AI 短线: 💵 现金 ${s.cash} | 📊 市值 ${s.mktValue} | 💰 总资产 ${s.totalAssets}`
          + (s.dayPnl !== null ? ` | 📈 当日盈亏 ${s.dayPnl >= 0 ? '+' : ''}${s.dayPnl}` : ''));
        if (s.trades && s.trades.length > 0) {
          L.push(`  短线成交 ${s.trades.length} 笔:`);
          for (const t of s.trades) {
            L.push(`  ${t.auto ? '🤖 ' : ''}${t.type === 'buy' ? '买入' : '卖出'} ${t.code} @${t.price} ×${t.shares} 费${t.fee}`);
          }
        }
      }
      return L.join('\n');
    },

    /**
     * 飞书推送小结: kv feishu_webhook 已配置才 POST
     * CORS/网络失败 console.warn 返回 false, 不影响功能
     */
    async _pushEodToFeishu(report) {
      let webhook = null;
      try {
        webhook = await Core.Storage.kvGet('feishu_webhook');
      } catch (e) {
        console.warn('[Paper] 读 feishu_webhook 失败:', e);
      }
      if (!webhook) return false;
      try {
        const resp = await fetch(webhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            msg_type: 'text',
            content: { text: this._formatEodReportText(report) }
          })
        });
        if (!resp.ok) {
          console.warn('[Paper] 飞书推送 HTTP', resp.status);
          return false;
        }
        return true;
      } catch (e) {
        console.warn('[Paper] 飞书推送失败 (CORS/网络):', e);
        return false;
      }
    },

    /** 模拟盘页面"日终小结"区块: 展示最近一条 + 飞书配置提示 */
    async _renderEodReport() {
      const el = document.getElementById('paperEod');
      if (!el) return;
      const hint = `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">配置飞书 webhook 可自动推送 (控制台执行 Core.Storage.kvSet('feishu_webhook','https://open.feishu.cn/...'))</div>`;
      const reports = (await Core.Storage.kvGet('paper_eod_reports')) || [];
      const r = reports[reports.length - 1];
      if (!r) {
        el.innerHTML = `
          <div class="card-title">📋 日终小结</div>
          <div class="empty" style="padding:16px;">工作日 15:30 后自动生成当日小结</div>
          ${hint}
        `;
        return;
      }
      const tradesHtml = r.trades.length > 0
        ? r.trades.map(t => `
            <tr>
              <td>${t.auto ? '🤖 ' : ''}${t.type === 'buy' ? '买入' : '卖出'}</td>
              <td><span class="code">${escapeHtml(t.code)}</span></td>
              <td>${fmtNum(t.price, 2)}</td>
              <td>${fmtNum(t.shares, 0)}</td>
              <td>${fmtMoney(t.fee)}</td>
            </tr>
          `).join('')
        : '<tr><td colspan="5" style="color:var(--text-muted);">当日无成交</td></tr>';
      const disciplineHtml = r.discipline.length > 0
        ? `<div style="margin-top:8px;font-size:12px;">🛡 纪律拦截 ${r.discipline.length} 笔: ${r.discipline.map(d =>
            `<span class="code">${escapeHtml(d.code)}</span> (${escapeHtml((d.reasons || []).join('；'))})`
          ).join(' / ')}</div>`
        : '';
      const plHtml = (r.top || r.bottom)
        ? `<div style="margin-top:8px;font-size:12px;">
            ${r.top ? `🏆 最佳 <span class="code">${escapeHtml(r.top.code)}</span> ${escapeHtml(r.top.name)} <span class="${pctClass(r.top.plPct)}">${fmtPct(r.top.plPct)}</span>` : ''}
            ${r.bottom ? `&nbsp;&nbsp;📉 最差 <span class="code">${escapeHtml(r.bottom.code)}</span> ${escapeHtml(r.bottom.name)} <span class="${pctClass(r.bottom.plPct)}">${fmtPct(r.bottom.plPct)}</span>` : ''}
          </div>`
        : '';
      // T1: 短线子账户段 (合并卡片分段, 有 short 字段才渲染)
      const shortHtml = r.short
        ? `<div style="margin-top:8px;padding-top:8px;border-top:1px dashed var(--border, #30363d);font-size:12px;">
            ⚡ AI 短线: 💵 ${fmtMoney(r.short.cash)} | 📊 ${fmtMoney(r.short.mktValue)} | 💰 ${fmtMoney(r.short.totalAssets)}
            ${r.short.dayPnl !== null ? `| 📈 <span class="${pctClass(r.short.dayPnl)}">${fmtMoney(r.short.dayPnl)}</span>` : ''}
            ${r.short.trades && r.short.trades.length ? `| 成交 ${r.short.trades.length} 笔` : ''}
          </div>`
        : '';
      el.innerHTML = `
        <div class="card-title">📋 日终小结 ${escapeHtml(r.date)}</div>
        <div class="summary-cards" style="margin-top:8px;">
          <div class="summary-card"><div class="label">💵 现金</div><div class="value">${fmtMoney(r.cash)}</div></div>
          <div class="summary-card"><div class="label">📊 持仓市值</div><div class="value">${fmtMoney(r.mktValue)}</div></div>
          <div class="summary-card"><div class="label">💰 总资产</div><div class="value">${fmtMoney(r.totalAssets)}</div></div>
          <div class="summary-card">
            <div class="label">📈 当日盈亏</div>
            ${r.dayPnl !== null
              ? `<div class="value ${pctClass(r.dayPnl)}">${fmtMoney(r.dayPnl)}</div><div class="delta" style="font-size:11px;color:var(--text-muted);">对照 ${escapeHtml(r.prevDate)} 快照</div>`
              : `<div class="value">-</div><div class="delta" style="font-size:11px;color:var(--text-muted);">无昨日快照</div>`}
          </div>
        </div>
        <table style="margin-top:8px;">
          <thead><tr><th>成交</th><th>代码</th><th>价格</th><th>股数</th><th>费用</th></tr></thead>
          <tbody>${tradesHtml}</tbody>
        </table>
        ${disciplineHtml}
        ${plHtml}
        ${shortHtml}
        ${hint}
      `;
    },

    // ========== Phase T3: 日线级条件单引擎 ==========

    // ---- T3 纯函数 (不依赖 DOM/IndexedDB, Node 沙箱可测) ----

    /**
     * K 线行 (data.js 中文键) → 结算用 bar { open, high, low, close, date }
     * 字段缺失/非正数 → null (该根 K 不参与判定, 宁缺毋假)
     */
    _barOf(row) {
      if (!row) return null;
      const open = parseFloat(row.开盘), high = parseFloat(row.最高);
      const low = parseFloat(row.最低), close = parseFloat(row.收盘);
      const date = String(row.日期 || '').slice(0, 10);
      if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || !date) return null;
      return { open, high, low, close, date };
    },

    /**
     * 取最新一根"已收盘"日 K:
     *   - bar.date < today → 已收盘, 直接用
     *   - bar.date === today → 仅当 now ≥ 15:00 (A 股收盘) 才视为已收盘
     *   - 其余 (盘中/无数据) → null, 本轮不结算
     * 时序语义: 结算永远只针对已完成交易日的 K 线, 不碰盘中未走完的 bar
     */
    _lastClosedBar(bars, now = new Date()) {
      if (!Array.isArray(bars) || !bars.length) return null;
      const today = fmtDate(now);
      const closed = now.getHours() * 60 + now.getMinutes() >= MARKET_CLOSE_MINUTES;
      for (let i = bars.length - 1; i >= 0; i--) {
        const b = bars[i];
        if (!b || !b.date) continue;
        if (b.date < today) return b;
        if (b.date === today && closed) return b;
      }
      return null;
    },

    /**
     * 条件单对某根 K 是否生效:
     *   - 创建当天收盘前创建 → 当日 K 可判定 (bar.date >= createdDate)
     *   - 收盘后 (≥15:00) 或非交易时间创建 → 当日 K 发生在创建之前, 不可回溯成交 (bar.date > createdDate)
     */
    _orderEligible(order, bar) {
      if (!order || !bar || !bar.date) return false;
      const cd = order.createdDate || '';
      if (!cd) return true;  // 老数据无字段不拦
      return order.createdAfterClose ? bar.date > cd : bar.date >= cd;
    },

    /** 创建日之后的交易日数 (用 K 线数, 不按自然日; 过期判定用) */
    _tradingDaysAfter(bars, dateStr) {
      if (!Array.isArray(bars) || !dateStr) return 0;
      return bars.filter(b => b && b.date && b.date > dateStr).length;
    },

    /** 跳空低开: 开盘价直接击穿止损价 (卖出按开盘价, 比止损价更真实) */
    _isGapDown(bar, stop) {
      return !!bar && stop > 0 && bar.open <= stop;
    },

    /** 跳空高开: 开盘价直接越过目标价 (止盈按开盘价) */
    _isGapUp(bar, target) {
      return !!bar && target > 0 && bar.open >= target;
    },

    /**
     * 买入条件单触发判定 (单根已收盘日 K):
     *   below (回调买入): open ≤ trigger → 开盘价成交; 否则 low ≤ trigger → 触发价成交
     *   above (突破买入): open ≥ trigger → 开盘价成交; 否则 high ≥ trigger → 触发价成交
     * @returns {{ fill: boolean, price: number|null }}
     */
    _fillCheck(order, bar) {
      const tp = parseFloat(order && order.triggerPrice);
      if (!(tp > 0) || !bar) return { fill: false, price: null };
      if (order.triggerDirection === 'below') {
        if (bar.open <= tp) return { fill: true, price: bar.open };
        if (bar.low <= tp) return { fill: true, price: tp };
      } else {
        if (bar.open >= tp) return { fill: true, price: bar.open };
        if (bar.high >= tp) return { fill: true, price: tp };
      }
      return { fill: false, price: null };
    },

    /**
     * 在持仓位出场判定 (单根已收盘日 K):
     *   止损: open ≤ stop (跳空) → 开盘价卖; 否则 low ≤ stop → 止损价卖
     *   止盈: open ≥ target (跳空) → 开盘价卖; 否则 high ≥ target → 目标价卖
     *   同根 K low/high 都触及 (止损止盈同日) → 保守原则一律按止损算:
     *     日线数据无法分辨日内先后, 按止损估可以避免高估策略胜率
     * @returns {{ exit: boolean, price: number|null, reason: string }}
     */
    _exitCheck(pos, bar) {
      const stop = parseFloat(pos && pos.stopLoss), target = parseFloat(pos && pos.targetPrice);
      if (!bar) return { exit: false, price: null, reason: '' };
      if (this._isGapDown(bar, stop)) return { exit: true, price: bar.open, reason: '止损(跳空)' };
      if (stop > 0 && bar.low <= stop) return { exit: true, price: stop, reason: '止损' };
      if (this._isGapUp(bar, target)) return { exit: true, price: bar.open, reason: '止盈(跳空)' };
      if (target > 0 && bar.high >= target) return { exit: true, price: target, reason: '止盈' };
      return { exit: false, price: null, reason: '' };
    },

    /**
     * 条件单创建校验 (纯函数)
     * 价格关系: 两个方向统一要求 stopLoss < triggerPrice < targetPrice
     *   (brief 对 below 单只硬性要求 stopLoss < triggerPrice, 但回调买入后目标价
     *    理应高于买入价, 否则止盈判定无意义, 故收紧为同一约束)
     * @returns string[] 错误文案 (空 = 通过)
     */
    _checkCondOrder(order, cash) {
      const errs = [];
      order = order || {};
      if (!/^\d{6}$/.test(String(order.code || ''))) errs.push('代码必须是 6 位数字');
      if (order.triggerDirection !== 'below' && order.triggerDirection !== 'above') {
        errs.push('触发方向必须是 below (回调买入) 或 above (突破买入)');
      }
      const tp = parseFloat(order.triggerPrice), sl = parseFloat(order.stopLoss), tg = parseFloat(order.targetPrice);
      if (!(tp > 0)) errs.push('触发价必须 > 0');
      if (!(sl > 0)) errs.push('止损价必须 > 0');
      if (!(tg > 0)) errs.push('目标价必须 > 0');
      if (tp > 0 && sl > 0 && !(sl < tp)) errs.push(`止损价 ${sl} 必须低于触发价 ${tp}`);
      if (tp > 0 && tg > 0 && !(tg > tp)) errs.push(`目标价 ${tg} 必须高于触发价 ${tp}`);
      const shares = parseFloat(order.shares) || 0;
      if (shares < LOT_SIZE || shares % LOT_SIZE !== 0) errs.push(`股数必须是 ${LOT_SIZE} 的整数倍`);
      if (tp > 0 && shares >= LOT_SIZE) {
        const amount = shares * tp;
        if (amount + this._calcFee(amount, 'buy').total > (parseFloat(cash) || 0)) {
          errs.push(`买入约需 ${fmtMoney(amount)} (含费), 超短线可用现金 ${fmtMoney(parseFloat(cash) || 0)}`);
        }
      }
      return errs;
    },

    // ---- T3 条件单存储 (kv paper_cond_orders) ----

    /**
     * 新建条件单 (校验失败 toast + 返回 { ok:false, errors })
     * @param {{ code, name?, market?, triggerDirection, triggerPrice, stopLoss, targetPrice,
     *           shares, assumption?, falsifyCondition?, invalidation?, probability?, source? }} order
     * @returns {Promise<{ ok: boolean, order?: object, errors?: string[] }>}
     */
    async addCondOrder(order) {
      try {
        const acc = await this._getAccountRaw('short');
        const errs = this._checkCondOrder(order, acc.cash);
        if (errs.length) {
          toastError('条件单校验失败: ' + errs[0]);
          return { ok: false, errors: errs };
        }
        const shares = this._roundLot(order.shares);
        const now = Date.now();
        const d = new Date(now);
        const rec = {
          id: uuid(),
          code: String(order.code),
          name: order.name || '',
          market: order.market || Core.Util.stockCodePrefix(String(order.code)),
          sleeve: 'short',
          triggerDirection: order.triggerDirection,
          triggerPrice: +parseFloat(order.triggerPrice).toFixed(2),
          stopLoss: +parseFloat(order.stopLoss).toFixed(2),
          targetPrice: +parseFloat(order.targetPrice).toFixed(2),
          shares,
          amount: +(shares * parseFloat(order.triggerPrice)).toFixed(2),
          assumption: order.assumption || '',
          falsifyCondition: order.falsifyCondition || '',
          invalidation: order.invalidation || '',
          probability: order.probability ?? null,
          source: order.source === 'ai' ? 'ai' : 'manual',
          status: 'pending',
          createdAt: now,
          createdDate: fmtDate(d),
          // 收盘后创建: 当日 K 线已走完, 不可回溯成交, 下一根 K 才生效 (_orderEligible)
          createdAfterClose: d.getHours() * 60 + d.getMinutes() >= MARKET_CLOSE_MINUTES,
          // 展示用预计到期时刻 (真实过期按交易日数判定, 见 _tradingDaysAfter)
          expireAt: now + COND_ORDER_EXPIRE_DAYS * 24 * 60 * 60 * 1000,
          filledAt: null, fillPrice: null, holdingId: null
        };
        const list = (await Core.Storage.kvGet('paper_cond_orders')) || [];
        list.push(rec);
        await Core.Storage.kvSet('paper_cond_orders', list.slice(-COND_ORDER_LIMIT));
        toastSuccess(`条件单已创建: ${rec.code} ${rec.triggerDirection === 'below' ? '回调到' : '突破'} ${rec.triggerPrice} 买入 ${shares} 股`);
        return { ok: true, order: rec };
      } catch (e) {
        console.warn('[Paper] 条件单创建失败:', e);
        toastError('条件单创建失败: ' + e.message);
        return { ok: false, errors: [e.message] };
      }
    },

    /** 条件单列表 (status 过滤: pending/filled/cancelled/expired, 缺省全部) */
    async listCondOrders(status) {
      const list = (await Core.Storage.kvGet('paper_cond_orders')) || [];
      return status ? list.filter(o => o.status === status) : list;
    },

    /** 取消条件单 (只改状态, 不删行, 便于回溯) */
    async cancelCondOrder(id) {
      try {
        const list = (await Core.Storage.kvGet('paper_cond_orders')) || [];
        const o = list.find(x => x.id === id);
        if (!o) { toastError('条件单不存在'); return false; }
        if (o.status !== 'pending') { toastWarning('只有待触发单可取消'); return false; }
        o.status = 'cancelled';
        o.cancelReason = '手动取消';
        await Core.Storage.kvSet('paper_cond_orders', list);
        toastSuccess(`已取消条件单: ${o.code}`);
        this.renderPage();
        return true;
      } catch (e) {
        console.warn('[Paper] 条件单取消失败:', e);
        toastError('取消失败: ' + e.message);
        return false;
      }
    },

    // ---- T3 每日结算 ----

    /**
     * 结算动作统一记复盘 (参照 screener._addWatchlistFromPick 的 journal 模式):
     * 行上 sleeve:'short' + auto:true (非索引字段), content 含计划原文要素 + 成交明细 + 原因
     */
    async _writeCondJournal({ code, name, title, lines }) {
      try {
        await Core.Storage.add('journals', {
          id: uuid(),
          title,
          content: lines.join('\n'),
          code,
          date: fmtDate(new Date()),
          tags: ['AI短线', '条件单'],
          mood: 'neutral',
          source: 'paper-cond',   // 标记来源, 后续可识别/清理
          sleeve: 'short',
          auto: true,
          createdAt: Date.now(),
          updatedAt: Date.now()
        });
      } catch (e) {
        console.warn('[Paper] 条件单 journal 写入失败:', e);
      }
    },

    /** 计划原文要素行 (成交/过期/取消的 journal 共用) */
    _condPlanLines(o) {
      const L = [];
      L.push(`**方向**: ${o.triggerDirection === 'below' ? '回调买入 (below)' : '突破买入 (above)'}`);
      L.push(`**触发/止损/目标**: ${o.triggerPrice} / ${o.stopLoss} / ${o.targetPrice}`);
      L.push(`**股数**: ${o.shares} (约 ${fmtMoney(o.amount || o.shares * o.triggerPrice)})`);
      if (o.assumption) L.push(`**买入假设**: ${o.assumption}`);
      if (o.falsifyCondition) L.push(`**证伪条件**: ${o.falsifyCondition}`);
      if (o.invalidation) L.push(`**失效条件**: ${o.invalidation}`);
      return L;
    },

    /**
     * 每日结算入口: app 启动 (init 后不 await) + 模拟盘页面展示时异步调用
     * kv paper_cond_settle.lastSettleDate 防当日重复; 整轮异常不外抛, 单代码拉 K 失败跳过
     * @param {Date} [now] 可注入 (测试用)
     * @returns 结算汇总 { skipped?, filled, exited, expired, cancelled, skippedCodes } | null
     */
    async settleCondOrders(now = new Date()) {
      try {
        const today = fmtDate(now);
        const settleMeta = (await Core.Storage.kvGet('paper_cond_settle')) || {};
        if (settleMeta.lastSettleDate === today) {
          return { skipped: true, filled: 0, exited: 0, expired: 0, cancelled: 0, skippedCodes: [] };
        }
        const summary = { filled: 0, exited: 0, expired: 0, cancelled: 0, skippedCodes: [] };

        const orders = (await Core.Storage.kvGet('paper_cond_orders')) || [];
        const positions = (await Core.Storage.kvGet('paper_short_positions')) || [];

        // 需要拉 K 的代码: pending 买单 + 在持仓位
        const codes = new Set();
        for (const o of orders) if (o.status === 'pending') codes.add(o.code);
        for (const p of positions) if (!p.closed) codes.add(p.code);

        if (codes.size === 0) {
          await Core.Storage.kvSet('paper_cond_settle', { lastSettleDate: today });
          return summary;
        }

        // 逐代码拉最近日 K (不复权, 判定真实成交价; 末尾 10 根足够数 3 个交易日有效期)
        // 失败代码本轮跳过 + warn, 不影响其他代码
        const barsByCode = {};
        for (const code of codes) {
          try {
            const rows = await Core.Data.getStockKLine(code, 'daily', undefined, undefined, '');
            const bars = (rows || []).map(r => this._barOf(r)).filter(b => b).slice(-10);
            if (bars.length) barsByCode[code] = bars;
          } catch (e) {
            console.warn(`[Paper] 条件单结算拉 K 失败, 本轮跳过 ${code}:`, e);
            summary.skippedCodes.push(code);
          }
        }

        // 1) pending 买入单: 最新一根已收盘日 K 判定触发; 超期未触发 → expired
        for (const o of orders) {
          if (o.status !== 'pending') continue;
          const bars = barsByCode[o.code];
          if (!bars) continue;  // 拉 K 失败/无数据, 本轮跳过
          const bar = this._lastClosedBar(bars, now);
          if (!bar) continue;   // 盘中无已收盘 K, 不结算

          // 触发判定 (只对生效后的 K 线, 防止回溯成交)
          if (this._orderEligible(o, bar)) {
            const chk = this._fillCheck(o, bar);
            if (chk.fill) {
              await this._settleFill(o, bar, chk.price, summary);
              continue;
            }
          }
          // 过期判定: createdAt 后第 COND_ORDER_EXPIRE_DAYS 个交易日仍未成交
          if (this._tradingDaysAfter(bars, o.createdDate) >= COND_ORDER_EXPIRE_DAYS) {
            o.status = 'expired';
            summary.expired++;
            console.warn(`[Paper] 条件单过期 ${o.code}: ${COND_ORDER_EXPIRE_DAYS} 个交易日未触发`);
            await this._writeCondJournal({
              code: o.code, name: o.name,
              title: `⚡ 短线条件单过期: ${o.code} ${o.name || ''}`,
              lines: [
                `## ⚡ 短线条件单过期 - ${o.code} ${o.name || ''}`, '',
                `**判定 K 线**: ${bar.date}`,
                `**原因**: ${COND_ORDER_EXPIRE_DAYS} 个交易日内未触发的买单自动过期`, '',
                '### 📋 原计划',
                ...this._condPlanLines(o), '',
                '---',
                '*本条由 StockMaster 条件单引擎 (T3) 自动记录*'
              ]
            });
          }
        }
        await Core.Storage.kvSet('paper_cond_orders', orders);

        // 2) 在持短线仓位: 同一根已收盘日 K 判定止损/止盈/到期强平
        let posDirty = false;
        for (const p of positions) {
          if (p.closed) continue;
          const bars = barsByCode[p.code];
          if (!bars) continue;
          const bar = this._lastClosedBar(bars, now);
          if (!bar) continue;
          // 该根 K 已结算过 (同日多次进入/隔夜重复) → 跳过, 防 holdDays 重复递增
          if (p.lastSettleBarDate && bar.date <= p.lastSettleBarDate) continue;

          let act = this._exitCheck(p, bar);
          if (!act.exit) {
            // 未触发止损/止盈 → 持有天数 +1, 满 SHORT_MAX_HOLD_DAYS 按收盘价强平
            p.holdDays = (p.holdDays || 0) + 1;
            p.lastSettleBarDate = bar.date;
            posDirty = true;
            if (p.holdDays >= SHORT_MAX_HOLD_DAYS) {
              act = { exit: true, price: bar.close, reason: '到期强平' };
            } else {
              continue;
            }
          }
          await this._settleExit(p, bar, act, summary);
          posDirty = true;
        }
        if (posDirty) await Core.Storage.kvSet('paper_short_positions', positions);

        await Core.Storage.kvSet('paper_cond_settle', { lastSettleDate: today });
        return summary;
      } catch (e) {
        console.warn('[Paper] 条件单结算失败:', e);
        return null;
      }
    },

    /** 结算子动作: 条件单成交 (纪律检查 → Paper.buy 落持仓 → 仓位跟踪 + journal) */
    async _settleFill(o, bar, fillPrice, summary) {
      const assumption = o.assumption || '技术突破';
      // 纪律检查: 与手动/AI 自动成交同一套 preBuyCheck (短线子账户口径);
      // blocks 命中 → cancelled + cancelReason, 不成交
      if (Core.Discipline && Core.Discipline.preBuyCheck) {
        const chk = await Core.Discipline.preBuyCheck({
          code: o.code, name: o.name || '', market: o.market || '',
          price: fillPrice, shares: o.shares, amount: o.shares * fillPrice,
          isPaper: true, sleeve: 'short', assumption, stopLoss: o.stopLoss
        });
        if (!chk.ok) {
          o.status = 'cancelled';
          o.cancelReason = '纪律拦截: ' + chk.blocks.join('；');
          summary.cancelled++;
          console.warn(`[Paper] 条件单成交被纪律引擎拦截 ${o.code}:`, chk.blocks.join('；'));
          await this._writeCondJournal({
            code: o.code, name: o.name,
            title: `⚡ 短线条件单取消: ${o.code} ${o.name || ''}`,
            lines: [
              `## ⚡ 短线条件单取消 (纪律拦截) - ${o.code} ${o.name || ''}`, '',
              `**判定 K 线**: ${bar.date} (触发价 ${o.triggerPrice} 已触及, 按 ${fillPrice} 拟成交)`,
              `**取消原因**: ${o.cancelReason}`, '',
              '### 📋 原计划',
              ...this._condPlanLines(o), '',
              '---',
              '*本条由 StockMaster 条件单引擎 (T3) 自动记录*'
            ]
          });
          return;
        }
      }
      const h = await this.buy(o.code, o.name, o.market, o.shares, {
        sleeve: 'short', assumption, stopLoss: o.stopLoss, targetPrice: o.targetPrice,
        auto: true, price: fillPrice, tradeDate: bar.date,
        falsifyCondition: o.falsifyCondition, invalidation: o.invalidation
      });
      if (!h) {
        // buy 内部已 toast (现金不足等); 条件单转 cancelled, 原因可查
        o.status = 'cancelled';
        o.cancelReason = '成交失败 (现金不足或行情不可用)';
        summary.cancelled++;
        console.warn(`[Paper] 条件单成交失败 ${o.code}: buy 返回 null`);
        return;
      }
      o.status = 'filled';
      o.filledAt = Date.now();
      o.fillPrice = fillPrice;
      o.holdingId = h.id;
      summary.filled++;
      // 在持仓位跟踪: 止损/止盈/持有天数锚点 (lastSettleBarDate=成交 K, 当日不再重复结算)
      const positions = (await Core.Storage.kvGet('paper_short_positions')) || [];
      positions.push({
        holdingId: h.id, code: o.code, name: o.name || '',
        stopLoss: o.stopLoss, targetPrice: o.targetPrice,
        entryDate: bar.date, entryPrice: fillPrice,
        planOrderId: o.id, shares: o.shares,
        holdDays: 0, lastSettleBarDate: bar.date, closed: false
      });
      await Core.Storage.kvSet('paper_short_positions', positions);
      await this._writeCondJournal({
        code: o.code, name: o.name,
        title: `⚡ 短线条件单成交: ${o.code} ${o.name || ''}`,
        lines: [
          `## ⚡ 短线条件单成交 - ${o.code} ${o.name || ''}`, '',
          `**成交日期**: ${bar.date} (日 K 结算)`,
          `**成交价**: ${fillPrice} × ${o.shares} 股 = ${fmtMoney(fillPrice * o.shares)}`, '',
          '### 📋 原计划',
          ...this._condPlanLines(o), '',
          '---',
          '*本条由 StockMaster 条件单引擎 (T3) 自动记录*'
        ]
      });
    },

    /** 结算子动作: 在持仓位卖出 (止损/止盈/强平 → Paper.sell + 仓位关闭 + journal) */
    async _settleExit(p, bar, act, summary) {
      const h = await Core.Storage.get('holdings', p.holdingId);
      if (!h || !h.isPaper) {
        // 持仓已被手动卖掉/重置 → 跟踪行直接关闭, 不再卖
        p.closed = true;
        p.exitDate = bar.date;
        p.exitReason = '持仓已不存在 (手动卖出或重置)';
        console.warn(`[Paper] 短线仓位跟踪关闭 ${p.code}: 持仓行不存在`);
        return;
      }
      const shares = Math.min(p.shares || h.shares, h.shares);
      const r = await this.sell(h.id, shares, { price: act.price, tradeDate: bar.date, reason: act.reason });
      if (!r) {
        console.warn(`[Paper] 短线仓位卖出失败 ${p.code} (${act.reason}), 下轮重试`);
        return;  // 不标 closed, 下个交易日重试
      }
      p.closed = true;
      p.exitDate = bar.date;
      p.exitPrice = act.price;
      p.exitReason = act.reason;
      summary.exited++;
      const pl = +((act.price - p.entryPrice) * shares).toFixed(2);
      await this._writeCondJournal({
        code: p.code, name: p.name,
        title: `⚡ 短线${act.reason}: ${p.code} ${p.name || ''}`,
        lines: [
          `## ⚡ 短线${act.reason} - ${p.code} ${p.name || ''}`, '',
          `**卖出日期**: ${bar.date} (日 K 结算)`,
          `**原因**: ${act.reason}`,
          `**入场**: ${p.entryDate} @ ${p.entryPrice} → **出场**: ${act.price} × ${shares} 股 (浮动盈亏 ${fmtMoney(pl)}, 未扣费)`,
          `**持有**: ${p.holdDays || 0} 个交易日`,
          `**止损/目标**: ${p.stopLoss} / ${p.targetPrice}`, '',
          '---',
          '*本条由 StockMaster 条件单引擎 (T3) 自动记录*'
        ]
      });
    },

    // ---- T3 UI: 条件单区块 (短线 tab) ----

    /** 手动建条件单表单: 校验 + 纪律检查 → addCondOrder */
    async addCondOrderFromForm() {
      const parsed = parseStockInput(document.getElementById('pcCode').value);
      if (!parsed) { toastError('代码格式不对 (6 位数字开头)'); return; }
      const order = {
        code: parsed.code,
        name: parsed.name || '',
        triggerDirection: document.getElementById('pcDirection').value,
        triggerPrice: parseFloat(document.getElementById('pcTrigger').value),
        stopLoss: parseFloat(document.getElementById('pcStopLoss').value),
        targetPrice: parseFloat(document.getElementById('pcTarget').value),
        shares: parseFloat(document.getElementById('pcShares').value),
        assumption: document.getElementById('pcAssumption').value,
        source: 'manual'
      };
      const resultEl = document.getElementById('paperCondCheckResult');
      // 先走纪律检查 (短线子账户口径; 价格按触发价估)
      if (Core.Discipline && Core.Discipline.preBuyCheck) {
        const acc = await this._getAccountRaw('short');
        const errs = this._checkCondOrder(order, acc.cash);
        if (errs.length) {
          if (resultEl) resultEl.innerHTML = `<div style="color:var(--down);font-size:12px;">⛔ ${escapeHtml(errs.join('；'))}</div>`;
          toastError('条件单校验失败: ' + errs[0]);
          return;
        }
        const sharesLot = this._roundLot(order.shares);
        const chk = await Core.Discipline.preBuyCheck({
          code: order.code, name: order.name, market: '',
          price: order.triggerPrice, shares: sharesLot, amount: sharesLot * order.triggerPrice,
          isPaper: true, sleeve: 'short', assumption: order.assumption, stopLoss: order.stopLoss
        });
        if (!chk.ok) {
          if (resultEl) resultEl.innerHTML = Core.Discipline.renderCheckResult(chk);
          toastError('交易纪律检查未通过, 已拦截');
          return;
        }
        if (chk.warns.length && !confirm(Core.Discipline._resultToText(chk) + '\n\n确认创建条件单?')) return;
      }
      const r = await this.addCondOrder(order);
      if (r.ok) {
        if (resultEl) resultEl.innerHTML = '';
        this.renderPage();
      }
    },

    /** 条件单区块渲染: pending 单 + 近期已结算单 (全 escapeHtml) */
    async _renderCondOrders() {
      const el = document.getElementById('paperCondOrders');
      if (!el) return;
      const all = await this.listCondOrders();
      const pending = all.filter(o => o.status === 'pending');
      const settled = all.filter(o => o.status !== 'pending').slice(-10).reverse();

      const dirLabel = d => d === 'below' ? '回调买入' : '突破买入';
      const statusBadge = s => ({
        filled: '<span style="color:var(--up);">✅ 已成交</span>',
        expired: '<span style="color:var(--text-muted);">⌛ 已过期</span>',
        cancelled: '<span style="color:var(--warn, #d29922);">🚫 已取消</span>'
      }[s] || escapeHtml(s));

      const pendingHtml = pending.length === 0
        ? '<div class="empty" style="padding:12px;">没有待触发的条件单</div>'
        : `<table>
            <thead><tr><th>代码/名称</th><th>方向</th><th>触发价</th><th>止损/目标</th><th>股数</th><th>有效期至</th><th>操作</th></tr></thead>
            <tbody>${pending.map(o => `
              <tr>
                <td><span class="code">${escapeHtml(o.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(o.name || '')}${o.source === 'ai' ? ' 🤖' : ''}</span></td>
                <td>${dirLabel(o.triggerDirection)}</td>
                <td>${fmtNum(o.triggerPrice, 2)}</td>
                <td>${fmtNum(o.stopLoss, 2)} / ${fmtNum(o.targetPrice, 2)}</td>
                <td>${fmtNum(o.shares, 0)}</td>
                <td>${escapeHtml(fmtDate(new Date(o.expireAt)))}<br><span style="font-size:11px;color:var(--text-muted);">(按交易日计)</span></td>
                <td><button class="btn btn-sm" onclick="Paper.cancelCondOrder('${escapeHtml(o.id)}')">取消</button></td>
              </tr>`).join('')}
            </tbody>
          </table>`;

      const settledHtml = settled.length === 0
        ? ''
        : `<div style="margin-top:10px;font-size:12px;color:var(--text-muted);">近期已结算</div>
           <table>
            <thead><tr><th>代码</th><th>状态</th><th>成交价</th><th>原因</th></tr></thead>
            <tbody>${settled.map(o => `
              <tr>
                <td><span class="code">${escapeHtml(o.code)}</span></td>
                <td>${statusBadge(o.status)}</td>
                <td>${o.fillPrice ? fmtNum(o.fillPrice, 2) : '-'}</td>
                <td style="font-size:11px;">${escapeHtml(o.cancelReason || (o.status === 'expired' ? `${COND_ORDER_EXPIRE_DAYS} 个交易日未触发` : ''))}</td>
              </tr>`).join('')}
            </tbody>
          </table>`;

      el.innerHTML = `
        <div class="card-title">📋 条件单 (日线级, 每日收盘后结算)</div>
        ${pendingHtml}
        ${settledHtml}
      `;
    },

    // ========== Phase T2: 盘前 AI 计划 ==========

    // ---- T2 纯函数 (不依赖 DOM/IndexedDB, Node 沙箱可测) ----

    /**
     * 盘前计划 append: 同日去重 (按 date), 上限 PLAN_LIMIT 条 (滚动截断最旧), 纯函数
     * 入参 entry.date 缺失则不入库; 同日重复调用后续覆盖前条 (用户点 [强制刷新] 时)
     */
    _pushMorningPlan(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.date && !arr.some(p => p.date === entry.date)) arr.push(entry);
      return arr.slice(-PLAN_LIMIT);
    },

    /**
     * 候选条件单清洗 (白名单 + 数值归一 + 价格关系校验)
     * 失败/缺字段的丢弃; 触发/止损/目标必须 > 0 且 stopLoss < triggerPrice < targetPrice;
     * shares 向下取整到整手 (LOT_SIZE 倍数)
     * @returns {{ cleaned: object|null, errs: string[] }}
     */
    _cleanCandidate(raw, cash) {
      const errs = [];
      const c = raw || {};
      const code = String(c.code || '').replace(/\D/g, '');
      if (!/^\d{6}$/.test(code)) errs.push('代码格式不对');
      const dir = c.direction === 'below' ? 'below' : (c.direction === 'above' ? 'above' : null);
      if (!dir) errs.push('方向必须是 below/above');
      const tp = parseFloat(c.triggerPrice), sl = parseFloat(c.stopLoss), tg = parseFloat(c.targetPrice);
      if (!(tp > 0)) errs.push('触发价必须 > 0');
      if (!(sl > 0)) errs.push('止损价必须 > 0');
      if (!(tg > 0)) errs.push('目标价必须 > 0');
      if (tp > 0 && sl > 0 && !(sl < tp)) errs.push('止损价必须 < 触发价');
      if (tp > 0 && tg > 0 && !(tg > tp)) errs.push('目标价必须 > 触发价');
      const shares = this._roundLot(parseFloat(c.shares) || 0);
      if (shares < LOT_SIZE) errs.push('股数不足一手');
      if (errs.length) return { cleaned: null, errs };
      const amount = +(shares * tp).toFixed(2);
      const cleaned = {
        code, name: String(c.name || '').slice(0, 20),
        market: c.market || Core.Util.stockCodePrefix(code),
        direction: dir,
        triggerPrice: +tp.toFixed(2),
        stopLoss: +sl.toFixed(2),
        targetPrice: +tg.toFixed(2),
        shares, amount,
        assumption: c.assumption || '其他',
        falsifyCondition: String(c.falsifyCondition || '').slice(0, 80),
        invalidation: String(c.invalidation || '').slice(0, 80),
        reasoning: String(c.reasoning || '').slice(0, 200)
      };
      // 走 T3 价格校验 + 现金约束 (复用 _checkCondOrder)
      const more = this._checkCondOrder({
        code, triggerDirection: dir, triggerPrice: tp, stopLoss: sl, targetPrice: tg, shares
      }, cash);
      if (more.length) return { cleaned: null, errs: more };
      return { cleaned, errs: [] };
    },

    /**
     * LLM 候选 JSON 解析 (宽松): 兼容纯对象 / markdown ```json 围栏 / 截断
     * @returns {{ summary: string, candidates: Array, noTradeReason?: string }|null }
     */
    _parsePlanJson(text) {
      if (!text || typeof text !== 'string') return null;
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || null;
      const jsonText = m ? m[1].trim()
        : (text.indexOf('{') >= 0 ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : null);
      if (!jsonText) return null;
      try {
        const obj = JSON.parse(jsonText);
        if (!obj || typeof obj !== 'object') return null;
        return {
          summary: String(obj.summary || '').slice(0, 500),
          candidates: Array.isArray(obj.candidates) ? obj.candidates : [],
          noTradeReason: obj.noTradeReason ? String(obj.noTradeReason).slice(0, 200) : ''
        };
      } catch (e) {
        console.warn('[Paper] 盘前计划 JSON 解析失败:', e.message);
        return null;
      }
    },

    /**
     * T2 prompt 上下文组装 (纯函数, 注入 LLM 用)
     * 全部 optional 字段失败降级为 null, prompt 段自己渲染
     */
    async _buildT2Context() {
      const ctx = { cash: 0, positions: [], pendingCondCodes: [], lessons: [], marketWidth: null, holdingCodes: [] };
      try {
        const acc = await this._getAccountRaw('short');
        ctx.cash = +acc.cash.toFixed(2);
      } catch (e) { console.warn('[Paper] T2 ctx 读短线现金失败:', e); }
      try {
        const pos = await this.getPositions('short');
        ctx.positions = pos.map(p => ({
          code: p.code, name: p.name || '',
          shares: p.shares || 0, currentPrice: p.price,
          stopLoss: p.stopLoss, targetPrice: p.targetPrice,
          plPct: p.plPct
        })).slice(0, 10);
        ctx.holdingCodes = ctx.positions.map(p => p.code);
      } catch (e) { console.warn('[Paper] T2 ctx 读短线持仓失败:', e); }
      try {
        const pending = await this.listCondOrders('pending');
        ctx.pendingCondCodes = Array.from(new Set(pending.map(o => o.code)));
      } catch (e) { console.warn('[Paper] T2 ctx 读条件单失败:', e); }
      // T4 闭环: lessons 按 score 排序, 取前 N (T4 落地后才有, 落地前空降级)
      try {
        const lessons = (await Core.Storage.kvGet('paper_short_lessons')) || [];
        const sorted = this._sortLessonsByScore(lessons);
        ctx.lessons = this._formatLessonsForPrompt(sorted, PLAN_LESSON_INJECT_MAX);
      } catch (e) { console.warn('[Paper] T2 ctx 读 lessons 失败:', e); }
      // 大盘宽度 (可选, 失败降级 null)
      try {
        if (Core.MarketWidth && typeof Core.MarketWidth.snapshot === 'function') {
          ctx.marketWidth = await Core.MarketWidth.snapshot();
        }
      } catch (e) { console.warn('[Paper] T2 ctx 大盘宽度失败:', e); }
      return ctx;
    },

    // ---- T2 持久化 (kv 读写, 不动 schema) ----

    /** 读盘前计划 (按日期降序, 最新在前) */
    async listMorningPlans(limit = 5) {
      const arr = (await Core.Storage.kvGet('paper_morning_plan')) || [];
      return arr.slice().reverse().slice(0, limit);
    },

    /**
     * 写盘前计划 (滚动截断, 同日覆盖)
     * @param {{ date: string, summary: string, candidates: Array, dryRun?: Array, lessonsInjectedAt?: number, generatedAt?: number }} plan
     */
    async _saveMorningPlan(plan) {
      if (!plan || !plan.date) return;
      const entry = {
        date: plan.date,
        generatedAt: plan.generatedAt || Date.now(),
        summary: plan.summary || '',
        candidates: Array.isArray(plan.candidates) ? plan.candidates : [],
        dryRun: Array.isArray(plan.dryRun) ? plan.dryRun : [],
        lessonsInjectedAt: plan.lessonsInjectedAt || 0
      };
      const list = (await Core.Storage.kvGet('paper_morning_plan')) || [];
      // 同日覆盖: 移除旧同日, prepend 新条
      const filtered = list.filter(p => p.date !== entry.date);
      filtered.push(entry);
      await Core.Storage.kvSet('paper_morning_plan', filtered.slice(-PLAN_LIMIT));
    },

    // ---- T2 业务入口 (UI 触发) ----

    /**
     * 盘前计划主入口: 流式调 AI → 解析 → 纪律预演 → 写 plan → 渲染
     * 默认每日首次走 cachedCall (24h); [强制刷新] 走 forceRefresh + 流式
     * @param {{ force?: boolean, now?: Date, deps?: { callLLM?: function } }} [opts]
     * @returns plan object { date, summary, candidates, dryRun, lessonsInjectedAt }
     */
    async generateMorningPlan(opts = {}) {
      const today = fmtDate(opts.now || new Date());
      const force = !!opts.force;
      const deps = opts.deps || {};
      // 非 force: 已有今日计划直接复用 (同日去重)
      if (!force) {
        try {
          const cached = (await Core.Storage.kvGet('paper_morning_plan')) || [];
          const hit = cached.find(p => p && p.date === today);
          if (hit) {
            await this._renderPrePlan();
            return hit;
          }
        } catch (e) { console.warn('[Paper] 读盘前计划缓存失败:', e); }
      }
      // 1. 拼 prompt
      const ctx = await this._buildT2Context();
      const systemPrompt = [
        '你是 A 股短线纪律交易员, 服务于 sleeve=short 子账户 (本金 30000, 单笔仓位 ≤20%, 止损 ≤8%, 持仓 ≤5 交易日)。',
        '',
        '【任务】基于今日账户状态, 输出 0-3 个今日条件单 (回调买入 below / 突破买入 above) + 一段中文 summary (≤200 字, 讲今日操作思路)。',
        '若不应交易, 返回 candidates: [] + noTradeReason (≤100 字)。',
        '',
        '【硬性规则】',
        '  - 严格 JSON 输出: {"summary": "...", "candidates": [...], "noTradeReason": "..."}',
        '  - 每笔候选必须含: code (6 位), name, direction (below/above),',
        '    triggerPrice, stopLoss, targetPrice, shares (100 倍数),',
        '    assumption (业绩拐点|估值修复|题材催化|技术突破|分红套利|其他),',
        '    falsifyCondition (证伪条件, 1 句), invalidation (失效条件, 1 句),',
        '    reasoning (一句话推荐理由)',
        '  - 价格关系: stopLoss < triggerPrice < targetPrice (回调买单止损低于触发, 突破买单同理)',
        '  - shares × triggerPrice ≤ 短线可用现金 × 0.8 (留 20% 缓冲)',
        '  - 避免与已有持仓/pending 条件单代码重复 (如有充分理由可突破, 但要在 reasoning 说明)',
        '  - 不要给出具体买卖金额, 只解释逻辑与优先级',
        '  - 总长度 ≤ 400 字 (summary + reasoning 之和)',
        '',
        '【教训引用】如 prompt 末尾有 lessons 段, 必须尽量回避已踩过的坑'
      ].join('\n');

      const lines = [
        `# 短线账户`,
        `现金: ¥${ctx.cash}`,
        '',
        `# 当前持仓 (${ctx.positions.length} 笔)`
      ];
      if (ctx.positions.length) {
        for (const p of ctx.positions) {
          const pl = p.plPct != null ? `盈亏 ${(p.plPct * 100).toFixed(1)}%` : '';
          const cp = p.currentPrice != null ? `现价 ${p.currentPrice.toFixed(2)}` : '现价 -';
          const sl = p.stopLoss ? `止损 ${p.stopLoss}` : '止损 -';
          const tp = p.targetPrice ? `目标 ${p.targetPrice}` : '目标 -';
          lines.push(`- ${p.code} ${p.name || ''} ${p.shares}股 | ${cp} | ${sl} | ${tp} | ${pl}`);
        }
      } else {
        lines.push('(空仓)');
      }
      lines.push('', `# 待触发条件单代码 (${ctx.pendingCondCodes.length})`);
      lines.push(ctx.pendingCondCodes.length ? ctx.pendingCondCodes.join(', ') : '(无)');
      if (ctx.marketWidth && ctx.marketWidth.status) {
        lines.push('', `# 大盘宽度: 涨 ${ctx.marketWidth.advance || 0} / 跌 ${ctx.marketWidth.decline || 0} / 状态 ${ctx.marketWidth.status}`);
      }
      if (ctx.lessons && ctx.lessons.length) {
        lines.push('', `# 近期教训 (${ctx.lessons.length} 条, T4 闭环)`);
        for (const l of ctx.lessons) lines.push(l);
      }
      lines.push('', '请输出今日条件单 + summary JSON。');
      const prompt = lines.join('\n');

      // 2. 调 AI (流式, UI 实时显示)
      const planEl = document.getElementById('paperPrePlan');
      const textEl = document.getElementById('paperMorningText');
      if (textEl) textEl.textContent = '⏳ AI 生成中, 大约 10-30 秒...';
      let rawText = '';
      try {
        const callLLM = deps.callLLM || (async (o) => {
          if (o.stream && o.onChunk) {
            // 走 Core.AI.call (内置流式 + onChunk)
            return await Core.AI.call(o);
          }
          return await Core.AI.call({ ...o, stream: false });
        });
        if (force) {
          rawText = await Core.AI.call({
            systemPrompt, prompt, stream: true, maxTokens: 1200,
            page: 'paper', purpose: 'morning-plan',
            onChunk: (delta, full) => { if (textEl) textEl.textContent = full; }
          });
        } else {
          rawText = await Core.AI.cachedCall({
            systemPrompt, prompt, maxTokens: 1200,
            contextHash: today  // 每日一份缓存
          });
        }
        if (textEl) {
          // 完成时切 escapeHtml (防 XSS)
          textEl.innerHTML = window.Core.Util.escapeHtml(rawText);
        }
      } catch (e) {
        console.warn('[Paper] T2 AI 调用失败:', e);
        if (textEl) textEl.textContent = '❌ AI 调用失败: ' + e.message;
        if (window.toastError) toastError('盘前计划生成失败: ' + e.message);
        return null;
      }

      // 3. 解析
      const parsed = this._parsePlanJson(rawText);
      if (!parsed) {
        // 解析失败: 落一条空 plan + 错误 summary
        const failPlan = {
          date: today, generatedAt: Date.now(),
          summary: 'AI 输出无法解析, 请重试或手动建单',
          candidates: [], dryRun: [],
          lessonsInjectedAt: ctx.lessons.length
        };
        await this._saveMorningPlan(failPlan);
        await this._renderPrePlan();
        return failPlan;
      }

      // 4. 纪律预演 + 候选清洗 (复用 addCondOrder 内部的纪律检查)
      const cash = ctx.cash;
      const dryRun = [];
      const cleaned = [];
      for (let i = 0; i < Math.min(parsed.candidates.length, PLAN_CANDIDATES_MAX); i++) {
        const raw = parsed.candidates[i];
        const { cleaned: c, errs } = this._cleanCandidate(raw, cash);
        if (!c) {
          dryRun.push({ index: i, ok: false, blocks: errs, warns: [], raw });
          continue;
        }
        let preCheck = { ok: true, blocks: [], warns: [] };
        if (Core.Discipline && Core.Discipline.preBuyCheck) {
          try {
            preCheck = await Core.Discipline.preBuyCheck({
              code: c.code, name: c.name, market: c.market,
              price: c.triggerPrice, shares: c.shares, amount: c.amount,
              isPaper: true, sleeve: 'short',
              assumption: c.assumption, stopLoss: c.stopLoss
            });
          } catch (e) { console.warn('[Paper] T2 候选纪律预演失败:', e); }
        }
        if (preCheck.ok) {
          cleaned.push(c);
        } else {
          dryRun.push({ index: i, ok: false, code: c.code, blocks: preCheck.blocks, warns: preCheck.warns });
        }
      }
      const finalCandidates = cleaned.slice(0, PLAN_CANDIDATES_MAX);
      const plan = {
        date: today, generatedAt: Date.now(),
        summary: parsed.summary || (finalCandidates.length ? `今日 ${finalCandidates.length} 笔候选` : parsed.noTradeReason || '今日无可建仓位'),
        candidates: finalCandidates,
        dryRun,
        lessonsInjectedAt: ctx.lessons.length
      };
      await this._saveMorningPlan(plan);
      await this._renderPrePlan();
      return plan;
    },

    /**
     * UI 入口: 用户确认创建候选条件单 (按 dryRun.ok=true 的子集)
     * 逐笔 addCondOrder (内部已含纪律 + 价格校验二次拦截)
     * @param {string[]|null} codes null = 全部最终候选; 否则按 code 白名单
     * @returns { ok: number, fail: number, errors: string[] }
     */
    async confirmMorningCandidates(codes = null) {
      const today = fmtDate(new Date());
      const list = (await Core.Storage.kvGet('paper_morning_plan')) || [];
      const plan = list.find(p => p && p.date === today);
      if (!plan || !plan.candidates || !plan.candidates.length) {
        toastWarning('今日没有可创建的候选条件单');
        return { ok: 0, fail: 0, errors: ['no candidates'] };
      }
      const want = codes && codes.length
        ? plan.candidates.filter(c => codes.includes(c.code))
        : plan.candidates;
      const errors = [];
      let ok = 0, fail = 0;
      for (const c of want) {
        const r = await this.addCondOrder({
          code: c.code, name: c.name, market: c.market,
          triggerDirection: c.direction, triggerPrice: c.triggerPrice,
          stopLoss: c.stopLoss, targetPrice: c.targetPrice,
          shares: c.shares, assumption: c.assumption,
          falsifyCondition: c.falsifyCondition, invalidation: c.invalidation,
          source: 'ai'
        });
        if (r && r.ok) ok++;
        else fail++;
      }
      if (ok) toastSuccess(`已创建 ${ok} 笔候选条件单${fail ? `, 失败 ${fail} 笔` : ''}`);
      else if (fail) toastError('所有候选条件单创建失败');
      this.renderPage();
      return { ok, fail, errors };
    },

    /** 取消今日计划 (从 kv 删, 不影响已建的 cond orders) */
    async cancelMorningPlan() {
      const today = fmtDate(new Date());
      const list = (await Core.Storage.kvGet('paper_morning_plan')) || [];
      const next = list.filter(p => p.date !== today);
      await Core.Storage.kvSet('paper_morning_plan', next);
      toastWarning(`已取消 ${today} 盘前计划`);
      this.renderPage();
    },

    // ========== Phase T4: 短线学习环 (纯函数 + 持久化) ==========

    /**
     * lesson 严重度权重 (排序 + score 计算共用)
     * T2 prompt 注入时, critical 排前, warning 中, info 末
     */
    _severityWeight(sev) {
      return ({ critical: 9, warning: 5, info: 2 })[sev] || 2;
    },

    /**
     * lesson 排序: score desc, 同分 date desc
     * score = severity 权重 + (近 7 天 +2 近期加成)
     */
    _sortLessonsByScore(lessons) {
      const arr = Array.isArray(lessons) ? [...lessons] : [];
      const todayMs = Date.now();
      return arr.sort((a, b) => {
        const sa = this._severityWeight(a.severity) + (todayMs - (a.dateMs || 0) < 7 * 24 * 60 * 60 * 1000 ? 2 : 0);
        const sb = this._severityWeight(b.severity) + (todayMs - (b.dateMs || 0) < 7 * 24 * 60 * 60 * 1000 ? 2 : 0);
        if (sb !== sa) return sb - sa;
        return (b.dateMs || 0) - (a.dateMs || 0);
      });
    },

    /**
     * lesson 注入文本: 自然语言列表, LLM 易读 (T2 prompt 段)
     * 每条: - [YYYY-MM-DD][category][severity] lesson (涉及 code)
     * 截断单条 ≤ 200 字; 最多 max 条
     */
    _formatLessonsForPrompt(lessons, max = 7) {
      const arr = Array.isArray(lessons) ? lessons.slice(0, max) : [];
      return arr.map(l => {
        const text = String(l.lesson || '').slice(0, 200);
        const code = l.refCode ? ` (涉及 ${l.refCode})` : '';
        return `- [${l.date || ''}][${l.category || 'other'}][${l.severity || 'info'}] ${text}${code}`;
      });
    },

    /**
     * 原始 lesson 清洗 (LLM 输出 → 落库形态)
     * 字段白名单: date / scope='short' / category (白名单否则 other) /
     *             lesson (≤200 字) / severity (枚举) / refCode (6 位否则空)
     * 缺 date 注入今天; scope 强制 'short'
     */
    _cleanLesson(raw, dateStr) {
      const l = raw || {};
      const cat = LESSON_CATEGORIES.includes(l.category) ? l.category : 'other';
      const sev = LESSON_SEVERITIES.includes(l.severity) ? l.severity : 'info';
      const code = String(l.refCode || '').replace(/\D/g, '');
      return {
        date: dateStr || l.date || fmtDate(new Date()),
        dateMs: new Date(dateStr || l.date || Date.now()).getTime() || Date.now(),
        scope: 'short',
        category: cat,
        lesson: String(l.lesson || '').slice(0, 200),
        severity: sev,
        refCode: /^\d{6}$/.test(code) ? code : ''
      };
    },

    /**
     * lesson append: 上限 LESSON_LIMIT 条, 滚动截断最旧; 纯函数
     * 落库前按 score 排序
     */
    _pushShortLesson(list, lesson) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (lesson && lesson.date) arr.push(lesson);
      const sorted = this._sortLessonsByScore(arr);
      return sorted.slice(0, LESSON_LIMIT);
    },

    /**
     * T4 触发判定: 工作日 (周一至周五) 且 ≥15:30 且今日未跑过
     * 注入 now 便于测试
     */
    _shouldRunShortLearning(now, existing) {
      const d = now instanceof Date ? now : new Date(now);
      if (isNaN(d.getTime())) return false;
      const wd = d.getDay();
      if (wd === 0 || wd === 6) return false;  // 周末跳过
      if (d.getHours() * 60 + d.getMinutes() < EOD_MINUTES) return false;  // 15:30 前跳过
      const today = fmtDate(d);
      return !(typeof existing === 'string' && existing === today);
    },

    /**
     * T4 prompt 上下文组装: 当日短线交易 + 持仓快照 + 纪律拦截
     * 任一环节失败降级, 不阻塞主流程
     */
    async _buildT4Context(dateStr) {
      const ctx = { date: dateStr, trades: [], positions: [], discipline: [] };
      try {
        const allTx = (await Core.Storage.all('transactions')) || [];
        ctx.trades = allTx
          .filter(t => t.isPaper && (t.sleeve || 'long') === 'short' && t.date === dateStr)
          .map(t => ({ type: t.type, code: t.code, price: t.price, shares: t.shares, assumption: t.assumption || '', exitReason: t.exitReason || '' }));
      } catch (e) { console.warn('[Paper] T4 ctx 拉交易失败:', e); }
      try {
        const pos = await this.getPositions('short');
        ctx.positions = pos.map(p => ({
          code: p.code, name: p.name || '', currentPrice: p.price,
          plPct: p.plPct, holdDays: p.holdDays || 0
        }));
      } catch (e) { console.warn('[Paper] T4 ctx 拉持仓失败:', e); }
      try {
        const dlog = (await Core.Storage.kvGet('paper_discipline_log')) || [];
        ctx.discipline = dlog.filter(x => x && x.date === dateStr);
      } catch (e) { console.warn('[Paper] T4 ctx 拉纪律失败:', e); }
      return ctx;
    },

    /** 读 lessons 列表 (按 score 排序) */
    async listShortLessons(limit = 50) {
      const list = (await Core.Storage.kvGet('paper_short_lessons')) || [];
      return this._sortLessonsByScore(list).slice(0, limit);
    },

    /** 写 lessons (滚动截断, 落库前排序) */
    async _saveShortLessons(newLessons) {
      if (!Array.isArray(newLessons) || newLessons.length === 0) return;
      const list = (await Core.Storage.kvGet('paper_short_lessons')) || [];
      let next = list;
      for (const raw of newLessons) {
        const lesson = this._cleanLesson(raw, raw && raw.date);
        if (lesson && lesson.date) next = this._pushShortLesson(next, lesson);
      }
      await Core.Storage.kvSet('paper_short_lessons', next);
    },

    // ---- T4 主入口 + UI ----

    /**
     * T4 自动追跑入口: 工作日 ≥15:30 + 今日未跑过 → 跑 (1 天 1 次, 失败不阻塞下次)
     * 手动模式 manual=true 跳过时间/重复判定
     * @param {{ now?: Date, manual?: boolean, deps?: { callLLM?: function } }} [opts]
     * @returns { ok: boolean, run: boolean, count: number, reason?: string }
     */
    async maybeRunShortLearningLoop(opts = {}) {
      const now = opts.now || new Date();
      const manual = !!opts.manual;
      const today = fmtDate(now);
      let existing = null;
      try { existing = await Core.Storage.kvGet(LESSON_LAST_RUN_DATE_KEY); } catch (e) { console.warn('[Paper] T4 读 lastDate 失败:', e); }
      if (!manual && !this._shouldRunShortLearning(now, existing)) {
        return { ok: true, run: false, count: 0, reason: '未到时间 / 已跑过' };
      }
      return await this.runShortLearningLoop({ date: today, manual, deps: opts.deps });
    },

    /**
     * T4 真正跑提炼: 拉当日数据 → 拼 prompt → 调 AI → 清洗 → 落库 → 记去重日期
     * @param {{ date?: string, manual?: boolean, deps?: { callLLM?: function } }} [opts]
     */
    async runShortLearningLoop(opts = {}) {
      const date = opts.date || fmtDate(new Date());
      const manual = !!opts.manual;
      const deps = opts.deps || {};
      try {
        const ctx = await this._buildT4Context(date);
        if (!ctx.trades.length && !ctx.positions.length && !ctx.discipline.length) {
          if (window.toastWarning) toastWarning(`${date} 短线无交易/持仓/拦截, 跳过提炼`);
          return { ok: true, run: false, count: 0, reason: 'no data' };
        }
        const systemPrompt = [
          '你是 A 股短线复盘助手, 服务于 sleeve=short 子账户 (本金 3 万, 仓位 ≤20%, 止损 ≤8%, 持仓 ≤5 交易日)。',
          '',
          '【任务】基于当日短线交易 + 持仓盈亏 + 纪律拦截日志, 提炼 0-5 条"值得未来 T2 盘前计划参考" 的教训。',
          '',
          '【硬性规则】',
          '  - 严格 JSON 输出: {"lessons": [...]}',
          '  - 每条 lesson 必含: category / severity / lesson / refCode (6 位代码或空)',
          '    category ∈ [assumption, entry-timing, exit-timing, position-size, discipline]',
          '    severity ∈ [info, warning, critical]',
          '  - lesson 一句话 (≤80 字), 描述具体错误模式 + 改进方向',
          '  - 跳过无意义的"市场整体波动"类描述, 聚焦"决策层"问题',
          '  - 总条数 ≤ 5, 按 severity 从高到低排序'
        ].join('\n');
        const prompt = [
          `# 日期: ${date}`,
          '',
          `# 当日短线交易 (${ctx.trades.length} 笔)`,
          ...ctx.trades.map(t => `- ${t.type} ${t.code} ${t.shares}股 @ ${t.price} (假设 ${t.assumption || '-'})  ${t.exitReason ? `[离场 ${t.exitReason}]` : ''}`),
          '',
          `# 当日短线持仓快照 (${ctx.positions.length})`,
          ...ctx.positions.map(p => `- ${p.code} ${p.name || ''} 现价 ${p.currentPrice ?? '-'} 盈亏 ${p.plPct != null ? (p.plPct * 100).toFixed(1) + '%' : '-'}  持有 ${p.holdDays} 日`),
          '',
          `# 当日纪律拦截 (${ctx.discipline.length})`,
          ...ctx.discipline.map(d => `- ${d.code} ${(d.blocks || []).join(';')}`),
          '',
          '请输出 JSON 教训列表。'
        ].join('\n');
        let raw;
        try {
          const callLLM = deps.callLLM || ((o) => Core.AI.call({ ...o, stream: false }));
          raw = await callLLM({ systemPrompt, prompt, maxTokens: 800, page: 'paper', purpose: 'short-learning' });
        } catch (e) {
          console.warn('[Paper] T4 AI 调用失败:', e);
          if (window.toastError) toastError('学习环 AI 调用失败: ' + e.message);
          return { ok: false, run: true, count: 0, reason: e.message };
        }
        // 解析 JSON
        const obj = this._parseLessonsJson(raw);
        const rawLessons = (obj && Array.isArray(obj.lessons)) ? obj.lessons : [];
        const cleaned = rawLessons
          .slice(0, LESSON_EXTRACT_MAX)
          .map(l => this._cleanLesson({ ...l, date }, date))
          .filter(l => l.lesson);
        await this._saveShortLessons(cleaned);
        // 记当日去重
        await Core.Storage.kvSet(LESSON_LAST_RUN_DATE_KEY, date);
        if (window.toastSuccess) toastSuccess(`T4 提炼 ${cleaned.length} 条短线教训`);
        await this._renderShortLessons();
        return { ok: true, run: true, count: cleaned.length };
      } catch (e) {
        console.warn('[Paper] T4 学习环失败:', e);
        if (window.toastError) toastError('学习环失败: ' + e.message);
        return { ok: false, run: true, count: 0, reason: e.message };
      }
    },

    /** JSON 解析 (容错 markdown 围栏 + 截断) */
    _parseLessonsJson(text) {
      if (!text || typeof text !== 'string') return null;
      const m = text.match(/```(?:json)?\s*([\s\S]*?)```/) || null;
      const jsonText = m ? m[1].trim()
        : (text.indexOf('{') >= 0 ? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1) : null);
      if (!jsonText) return null;
      try { return JSON.parse(jsonText); } catch (e) { console.warn('[Paper] T4 JSON 解析失败:', e.message); return null; }
    },

    /**
     * 短线 lessons 渲染: 卡片 + 手动按钮
     * 锚 #paperShortLessons; 容器在 index.html 单独 div
     */
    async _renderShortLessons() {
      const el = document.getElementById('paperShortLessons');
      if (!el) return;
      let list = [];
      try { list = (await Core.Storage.kvGet('paper_short_lessons')) || []; } catch (e) { /* empty */ }
      const sorted = this._sortLessonsByScore(list).slice(0, LESSON_LIMIT);
      const rows = sorted.length === 0
        ? '<div style="padding:12px;color:var(--text-muted);font-size:12px;">尚无短线教训, 15:30 后或点 [🪞 立刻提炼] 自动生成</div>'
        : `<table>
            <thead><tr><th>日期</th><th>分类</th><th>严重度</th><th>教训</th><th>代码</th></tr></thead>
            <tbody>${sorted.map(l => `<tr>
              <td style="font-size:11px;">${escapeHtml(l.date || '')}</td>
              <td style="font-size:11px;">${escapeHtml(l.category || 'other')}</td>
              <td style="font-size:11px;">${escapeHtml(l.severity || 'info')}</td>
              <td style="font-size:12px;max-width:300px;">${escapeHtml(l.lesson || '')}</td>
              <td style="font-size:11px;">${escapeHtml(l.refCode || '-')}</td>
            </tr>`).join('')}</tbody>
          </table>`;
      const today = fmtDate(new Date());
      const lastDate = (() => { try { return null; } catch (e) { return null; } })();  // 占位, 真实 lastDate 由调用方传
      el.innerHTML = `
        <div class="card-title">🪞 短线学习环 (T4, ${sorted.length}/${LESSON_LIMIT})</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
          自动注入到 T2 盘前 prompt (按 score 排序, top ${PLAN_LESSON_INJECT_MAX} 条)
        </div>
        ${rows}
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="Paper.maybeRunShortLearningLoop({ manual: true })">🪞 立刻提炼</button>
        </div>
      `;
    },

    // ---- T2 UI 渲染 ----

    /**
     * 盘前 AI 计划区块: 文案 + 候选 table + 操作按钮
     * 所有用户/AI 输出经 escapeHtml, 按钮 onclick 用单引号
     */
    async _renderPrePlan() {
      const el = document.getElementById('paperPrePlan');
      if (!el) return;
      const today = fmtDate(new Date());
      const list = (await Core.Storage.kvGet('paper_morning_plan')) || [];
      const plan = list.find(p => p && p.date === today);
      if (!plan) {
        el.innerHTML = `
          <div class="card-title">📋 盘前 AI 计划 (T2)</div>
          <div style="padding:16px;">
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
              ⚡ AI 短线子账户每日操作计划 + 候选条件单 (≤3 笔)
            </div>
            <button class="btn btn-sm btn-primary" onclick="Paper.generateMorningPlan()">✨ 生成今日计划</button>
            <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">工作日盘前生成, 自动注入近期教训</span>
          </div>
        `;
        return;
      }
      const cs = (plan.candidates || []).map((c, i) => {
        const dir = c.direction === 'below' ? '回调' : '突破';
        const sl = c.stopLoss ? c.stopLoss : '-';
        const tg = c.targetPrice ? c.targetPrice : '-';
        return `<tr>
          <td><span class="code">${escapeHtml(c.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(c.name || '')}</span></td>
          <td>${escapeHtml(dir)}</td>
          <td>${fmtNum(c.triggerPrice, 2)}</td>
          <td>${fmtNum(sl, 2)}</td>
          <td>${fmtNum(tg, 2)}</td>
          <td>${fmtNum(c.shares, 0)}</td>
          <td style="font-size:11px;">${escapeHtml(c.assumption || '-')}</td>
          <td style="font-size:11px;max-width:240px;">${escapeHtml(c.reasoning || '')}</td>
        </tr>`;
      }).join('');
      const candTable = cs
        ? `<table>
            <thead><tr><th>代码/名称</th><th>方向</th><th>触发价</th><th>止损</th><th>目标</th><th>股数</th><th>假设</th><th>推荐理由</th></tr></thead>
            <tbody>${cs}</tbody>
          </table>`
        : '<div style="padding:8px;color:var(--text-muted);font-size:12px;">无候选条件单 (已通过纪律预演或 AI 未给出有效候选)</div>';
      const dr = plan.dryRun || [];
      const drHtml = dr.length === 0 ? '' : `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">
        🛡 纪律预演: ${dr.filter(d => !d.ok).length} 笔被拦截
        ${dr.some(d => !d.ok) ? '<ul style="margin:4px 0 0 16px;">' + dr.filter(d => !d.ok).map(d =>
          `<li>${escapeHtml(d.code || ('#' + d.index))}: ${(d.blocks || []).map(escapeHtml).join('；')}</li>`
        ).join('') + '</ul>' : ''}
      </div>`;
      el.innerHTML = `
        <div class="card-title">📋 盘前 AI 计划 ${escapeHtml(plan.date)}</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
          生成于 ${fmtDate(new Date(plan.generatedAt))} | 注入教训 ${plan.lessonsInjectedAt || 0} 条
        </div>
        <div id="paperMorningText" style="background:var(--bg-base);border-radius:6px;padding:10px;font-size:12px;line-height:1.6;white-space:pre-wrap;margin-bottom:10px;">${escapeHtml(plan.summary || '')}</div>
        ${candTable}
        ${drHtml}
        <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap;">
          <button class="btn btn-sm btn-primary" onclick="Paper.confirmMorningCandidates()" ${plan.candidates && plan.candidates.length ? '' : 'disabled'}>
            ✅ 确认创建全部 (${(plan.candidates || []).length})
          </button>
          <button class="btn btn-sm" onclick="Paper.generateMorningPlan({ force: true })">🔄 强制刷新</button>
          <button class="btn btn-sm btn-ghost" onclick="Paper.cancelMorningPlan()">✕ 取消计划</button>
        </div>
      `;
    },

    // ========== 页面 UI ==========

    /** 手动交易表单: 买入 (Phase B: 先过 Core.Discipline.preBuyCheck; T1: 走当前 tab 的子账户) */
    async buyFromForm() {
      const parsed = parseStockInput(document.getElementById('paperCode').value);
      if (!parsed) { toastError('代码格式不对 (6 位数字开头)'); return; }
      const shares = parseFloat(document.getElementById('paperShares').value);
      if (!shares || shares <= 0) { toastError('股数必须 > 0'); return; }
      const resultEl = document.getElementById('paperCheckResult');
      const assumption = document.getElementById('paperAssumption').value;
      const stopLoss = parseFloat(document.getElementById('paperStopLoss').value);
      const sleeve = this._sleeve;
      let opts = { sleeve };
      if (Core.Discipline && Core.Discipline.preBuyCheck) {
        // 先拉实时价供止损价/金额校验 (拉不到则 price=0, 检查内部降级为 warn)
        let price = 0;
        try {
          const q = await Core.Data.getStockQuote(parsed.code);
          price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
        } catch (e) {
          console.warn('[Paper] 纪律检查前拉价失败:', e);
        }
        const sharesLot = this._roundLot(shares);
        const chk = await Core.Discipline.preBuyCheck({
          code: parsed.code, name: parsed.name, market: '',
          price, shares: sharesLot, amount: sharesLot * price,
          isPaper: true, sleeve, assumption, stopLoss
        });
        if (!chk.ok) {
          if (resultEl) resultEl.innerHTML = Core.Discipline.renderCheckResult(chk);
          toastError('交易纪律检查未通过, 已拦截');
          return;
        }
        if (chk.warns.length && !confirm(Core.Discipline._resultToText(chk) + '\n\n确认继续买入?')) return;
        opts = { sleeve, assumption, stopLoss, disciplineWarns: chk.warns };
      }
      const r = await this.buy(parsed.code, parsed.name, '', shares, opts);
      if (r) {
        if (resultEl) resultEl.innerHTML = '';
        this.renderPage();
      }
    },

    /** 手动交易表单: 卖出 (按代码找当前子账户的模拟持仓) */
    async sellFromForm() {
      const parsed = parseStockInput(document.getElementById('paperCode').value);
      if (!parsed) { toastError('代码格式不对 (6 位数字开头)'); return; }
      const shares = parseFloat(document.getElementById('paperShares').value);
      if (!shares || shares <= 0) { toastError('股数必须 > 0'); return; }
      const rows = await this._getPaperHoldings(this._sleeve);
      const h = rows.find(x => x.code === parsed.code);
      if (!h) { toastError('当前子账户没有这只持仓'); return; }
      const r = await this.sell(h.id, shares);
      if (r) this.renderPage();
    },

    /** 持仓表行内按钮: 按现价卖出全部 */
    async sellAll(holdingId) {
      const h = await Core.Storage.get('holdings', holdingId);
      if (!h || !h.isPaper) { toastError('模拟持仓不存在'); return; }
      if (!confirm(`按现价卖出全部 ${h.code} ${h.shares} 股?`)) return;
      const r = await this.sell(h.id, h.shares);
      if (r) this.renderPage();
    },

    // T1: 当前展示的子账户 ('long' 长线模拟 / 'short' AI 短线), tab 切换
    _sleeve: 'long',

    /** 切换 长线/短线 tab 并重渲染 */
    switchSleeve(sleeve) {
      this._sleeve = sleeve === 'short' ? 'short' : 'long';
      this.renderPage();
    },

    /** 页面渲染 (挂 window._onShow_pagePaper) */
    async renderPage() {
      const summaryEl = document.getElementById('paperSummary');
      const tableEl = document.getElementById('paperPositions');
      if (!summaryEl || !tableEl) return;

      const sleeve = this._sleeve;

      // T1: tab 高亮 + 短线说明行
      const tabLong = document.getElementById('paperTabLong');
      const tabShort = document.getElementById('paperTabShort');
      if (tabLong) tabLong.classList.toggle('btn-primary', sleeve === 'long');
      if (tabShort) tabShort.classList.toggle('btn-primary', sleeve === 'short');
      const noteEl = document.getElementById('paperSleeveNote');
      if (noteEl) {
        noteEl.textContent = sleeve === 'short'
          ? '⚡ AI 短线: 盘前 AI 计划 (T2) + 条件单日线结算 (T3) + 学习环 (T4, 15:30 后自动追跑)'
          : '';
      }
      // T2: 盘前计划区块只在短线 tab 显示
      const prePlanSection = document.getElementById('paperPrePlanSection');
      if (prePlanSection) prePlanSection.style.display = sleeve === 'short' ? '' : 'none';
      if (sleeve === 'short') await this._renderPrePlan();
      // T4: 学习环区块只在短线 tab 显示
      const lessonsSection = document.getElementById('paperShortLessonsSection');
      if (lessonsSection) lessonsSection.style.display = sleeve === 'short' ? '' : 'none';
      if (sleeve === 'short') await this._renderShortLessons();
      // T3: 条件单区块只在短线 tab 显示
      const condSection = document.getElementById('paperCondSection');
      if (condSection) condSection.style.display = sleeve === 'short' ? '' : 'none';
      if (sleeve === 'short') await this._renderCondOrders();

      // T3: 页面展示时异步触发每日结算 (当日已结算自动跳过; 有动作则重渲染刷新数据)
      this.settleCondOrders()
        .then(r => { if (r && !r.skipped && (r.filled || r.exited || r.expired || r.cancelled)) this.renderPage(); })
        .catch(e => console.warn('[Paper] 条件单结算失败:', e));

      // 页面展示时也尝试记当日快照 (当天已记则跳过)
      this.snapshotIfNeeded().catch(e => console.warn('[Paper] 页面快照失败:', e));

      const [acc, positions] = await Promise.all([this.getAccount(sleeve), this.getPositions(sleeve)]);
      const mktValue = positions.reduce((s, p) => s + (p.mkt || 0), 0);
      const totalAssets = acc.cash + mktValue;
      // 累计盈亏 = 总资产 - 初始资金 (含已实现盈亏与手续费)
      const totalPL = totalAssets - acc.initialCash;
      const totalPLPct = acc.initialCash > 0 ? totalPL / acc.initialCash : 0;

      summaryEl.innerHTML = `
        <div class="summary-card">
          <div class="label">💵 虚拟现金</div>
          <div class="value">${fmtMoney(acc.cash)}</div>
        </div>
        <div class="summary-card">
          <div class="label">📊 持仓市值</div>
          <div class="value">${fmtMoney(mktValue)}</div>
        </div>
        <div class="summary-card">
          <div class="label">💰 总资产</div>
          <div class="value">${fmtMoney(totalAssets)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">初始 ${fmtMoney(acc.initialCash)}</div>
        </div>
        <div class="summary-card">
          <div class="label">📈 累计盈亏</div>
          <div class="value ${pctClass(totalPLPct)}">${fmtMoney(totalPL)}</div>
          <div class="delta ${pctClass(totalPLPct)}">${fmtPct(totalPLPct)}</div>
        </div>
      `;

      if (positions.length === 0) {
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">📋</div>
            <div>模拟盘还没有持仓</div>
            <div style="margin-top:8px;font-size:12px;">AI 选股加自选后会自动买入, 也可以上方手动交易</div>
          </div>
        `;
      } else {
        tableEl.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>代码/名称</th><th>持仓股数</th><th>成本价</th><th>现价</th><th>市值</th><th>盈亏</th><th>操作</th>
              </tr>
            </thead>
            <tbody>
              ${positions.map(p => `
                <tr>
                  <td><span class="code">${escapeHtml(p.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(p.name || '')}</span></td>
                  <td>${fmtNum(p.shares, 0)}</td>
                  <td>${fmtNum(p.costPrice, 3)}</td>
                  <td>${p.price !== null ? fmtNum(p.price, 2) : '-'}</td>
                  <td>${p.mkt !== null ? fmtMoney(p.mkt) : '-'}</td>
                  <td class="${pctClass(p.plPct)}">
                    ${p.pl !== null ? fmtMoney(p.pl) : '-'}<br>
                    <span style="font-size:11px;">${p.plPct !== null ? fmtPct(p.plPct) : ''}</span>
                  </td>
                  <td><button class="btn btn-sm" onclick="Paper.sellAll('${escapeHtml(p.id)}')">卖出</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }

      await this._renderChart();

      // Phase C: 页面展示时也检查是否该生成日终小结 (工作日 15:30 后, 今日无记录才生成)
      this.maybeGenerateEodReport()
        .then(r => { if (r) this._renderEodReport(); })
        .catch(e => console.warn('[Paper] EOD 检查失败:', e));
      await this._renderEodReport();
      // T4: 页面展示时也尝试跑短线学习环 (幂等, 今日已跑会跳过)
      this.maybeRunShortLearningLoop()
        .then(r => { if (r && r.run) this._renderShortLessons(); })
        .catch(e => console.warn('[Paper] T4 检查失败:', e));
    },

    _chart: null,

    /**
     * 表现对比曲线 (ECharts 双轴四线)
     * 左轴: 长线模拟总资产 / AI 短线总资产 / 真实持仓市值 (元, 绝对值)
     * 右轴: 沪深300 (以快照首日 = 100 指数化)
     * 口径差异: 资产线是绝对金额, 沪深300 是指数化相对走势, 两条轴只看各自趋势, 不比绝对高低
     * T1: 短线线取快照 shortTotal 字段, 老快照无此字段 → null (ECharts 自动断点)
     */
    async _renderChart() {
      const chartEl = document.getElementById('paperChart');
      if (!chartEl) return;
      if (this._chart) { this._chart.dispose(); this._chart = null; }
      const snaps = ((await Core.Storage.kvGet('paper_snapshots')) || []).slice(-SNAPSHOT_LIMIT);
      if (snaps.length < 2) {
        chartEl.innerHTML = '<div class="empty" style="padding:24px;">数据积累中, 明天再来看曲线</div>';
        return;
      }
      if (typeof echarts === 'undefined') {
        console.warn('[Paper] echarts 未加载');
        chartEl.innerHTML = '<div class="empty" style="padding:24px;">图表库未加载</div>';
        return;
      }
      chartEl.innerHTML = '<div id="paperChartCanvas" style="width:100%;height:280px;"></div>';
      // 沪深300 指数化基准: 首个有点位的快照 = 100
      const baseRow = snaps.find(s => s.csi300);
      const base = baseRow ? baseRow.csi300 : null;
      const csi300Indexed = snaps.map(s => (s.csi300 && base) ? +(s.csi300 / base * 100).toFixed(2) : null);
      this._chart = echarts.init(document.getElementById('paperChartCanvas'));
      this._chart.setOption({
        tooltip: { trigger: 'axis' },
        legend: {
          data: ['长线模拟总资产', 'AI 短线总资产', '真实持仓市值', '沪深300 (首日=100)'],
          textStyle: { color: '#8b949e', fontSize: 11 }
        },
        grid: { left: 70, right: 60, top: 40, bottom: 30 },
        xAxis: { type: 'category', data: snaps.map(s => s.date), axisLabel: { color: '#8b949e', fontSize: 10 } },
        yAxis: [
          { type: 'value', name: '资产 (元)', axisLabel: { color: '#8b949e', fontSize: 10 }, splitLine: { lineStyle: { color: '#21262d' } } },
          { type: 'value', name: '沪深300 指数化', axisLabel: { color: '#8b949e', fontSize: 10 }, splitLine: { show: false } }
        ],
        series: [
          { name: '长线模拟总资产', type: 'line', data: snaps.map(s => s.paperTotal), smooth: true, showSymbol: false },
          { name: 'AI 短线总资产', type: 'line', data: snaps.map(s => typeof s.shortTotal === 'number' ? s.shortTotal : null), smooth: true, showSymbol: false },
          { name: '真实持仓市值', type: 'line', data: snaps.map(s => s.realTotal), smooth: true, showSymbol: false },
          { name: '沪深300 (首日=100)', type: 'line', yAxisIndex: 1, data: csi300Indexed, smooth: true, showSymbol: false, lineStyle: { type: 'dashed' } }
        ]
      });
    }
  };

  window.Paper = Paper;
  window._onShow_pagePaper = function() { Paper.renderPage(); };
})();
