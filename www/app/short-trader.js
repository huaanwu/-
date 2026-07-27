/**
 * ShortTrader - AI 短线操盘手 T2: 盘前 AI 交易计划生成
 * 依赖: Core.Storage (kv) / Core.AI (callWithTimeout + parseJsonOutput) /
 *       Core.Premortem (pre-mortem 校验) / Core.Regime (大盘状态 gate) /
 *       Core.Data (指数快照, 只用已验证现有接口) / Paper (条件单落地 + _roundLot)
 *
 * 设计:
 *   - kv paper_short_plan = { date, marketView, plans, dropped, generatedAt, error? }
 *     单条记录, 同日覆盖 (重新生成); 无今日记录 + 交易日 → app 启动自动生成
 *   - kv paper_plan_log = [{ date, code, stage, reason }] 丢弃留痕 (上限 SHORT_PLAN_LOG_LIMIT)
 *   - 候选池 = watchlist 全部代码 + 当前 short 持仓代码 (幻觉防护: 池外代码直接丢弃)
 *   - 校验管线 (全纯函数可测):
 *       a. JSON schema (Core.AI.parseJsonOutput, Phase T 模式) + Core.Premortem.checkPick
 *       b. 幻觉防护: code ∈ 候选池
 *       c. 价格关系: stopLoss < triggerPrice < targetPrice
 *       d. 短线纪律: 今日已建条件单 + 本轮 ≤ maxDailyTrades(3) / 同代码 48h 冷却 /
 *          positionPct ≤ PAPER_SHORT_POSITION_PCT (超限收敛不丢弃) / regime bear 仓位 × positionScale
 *       e. 每条丢弃写 paper_plan_log
 *   - 落地: 通过的 plans 逐条 Paper.addCondOrder({ ..., source:'ai' }) 自动转条件单,
 *     shares = Paper._roundLot(短线现金 × positionPct / triggerPrice), 不足一手丢弃留痕
 *   - 失败不打扰: console.warn + kv 写 error 记录, UI 显示"生成失败可手动重试"
 *
 * 备注: 与 Paper.generateMorningPlan (T2 盘前计划, 手动确认流) 是两套独立实现,
 *   本模块走"自动生成 + 自动转条件单"路线, kv/逻辑互不干扰。
 */
(function() {
  'use strict';

  const PLAN_KEY = 'paper_short_plan';        // kv: 今日计划 (单条, 同日覆盖)
  const PLAN_LOG_KEY = 'paper_plan_log';      // kv: 丢弃留痕
  const PLAN_LOG_LIMIT = Core.Constants.SHORT_PLAN_LOG_LIMIT;      // 留痕上限
  const JOURNAL_LOOKBACK_DAYS = Core.Constants.SHORT_PLAN_JOURNAL_DAYS;  // journal 摘要回看天数
  const LOT_SIZE = Core.Constants.LOT_SIZE;
  const MAX_POSITION_PCT = Core.Constants.PAPER_SHORT_POSITION_PCT;      // 单笔仓位上限 (0.20)
  const LLM_TIMEOUT_MS = 60000;               // AI 调用超时 (走 callWithTimeout)
  // 短线纪律参数 (T1 在 Core.Discipline.DEFAULT_CONFIG.short 预留 {maxDailyTrades:3, cooldownHours:48}, 本期启用)
  const SHORT_RULES = (window.Core && Core.Discipline && Core.Discipline.DEFAULT_CONFIG
    && Core.Discipline.DEFAULT_CONFIG.short) || { maxDailyTrades: 3, cooldownHours: 48 };

  const ShortTrader = {

    /** 无启动副作用: 生成走 maybeGeneratePlan (app.js init 异步调用, 不阻塞启动) */
    init() {},

    // ========== 纯函数 (不依赖 DOM/IndexedDB, Node 沙箱可测) ==========

    /** 本地日期串 'YYYY-MM-DD' (kv date 对账用, 不用 UTC) */
    _todayStr(d = new Date()) {
      const p = n => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    },

    /**
     * 是否交易日: 周一~周五
     * 简化: 法定节假日/调休不做判断 (无可靠本地日历数据源), 周末硬排除;
     * 节假日误判的代价只是多生成一份计划, 条件单仍按 K 线结算不会误成交
     */
    _isTradingDay(now) {
      const d = now instanceof Date ? now : new Date(now);
      if (isNaN(d.getTime())) return false;
      const wd = d.getDay();
      return wd >= 1 && wd <= 5;
    },

    /** 提取 6 位数字代码 (容忍 'sh600519' / '600519 茅台' 等写法), 取不到返 '' */
    _normCode6(v) {
      const m = String(v == null ? '' : v).match(/\d{6}/);
      return m ? m[0] : '';
    },

    /**
     * 候选池: watchlist 全部代码 + 当前 short 持仓代码 (去重, 保序)
     * 纯函数; 幻觉防护的唯一事实来源
     * @param {Array} watchRows watchlist 行 [{code, name}]
     * @param {Array} holdingRows short 持仓行 [{code, name}]
     * @returns {Array<{code, name}>}
     */
    _buildCandidatePool(watchRows, holdingRows) {
      const seen = new Set();
      const pool = [];
      const push = (codeRaw, name) => {
        const code = this._normCode6(codeRaw);
        if (code && !seen.has(code)) {
          seen.add(code);
          pool.push({ code, name: String(name || '') });
        }
      };
      (watchRows || []).forEach(r => push(r && r.code, r && r.name));
      (holdingRows || []).forEach(r => push(r && r.code, r && r.name));
      return pool;
    },

    /**
     * 同代码冷却检查: 48h (SHORT_RULES.cooldownHours) 内有 sleeve='short' 卖出记录 → true
     * 纯函数, transactions 行与时间注入
     */
    _hasRecentShortSell(txs, code, nowMs, cooldownHours) {
      const cutoff = (nowMs || 0) - (cooldownHours || 0) * 3600 * 1000;
      return (txs || []).some(t => t && t.isPaper && (t.sleeve || 'long') === 'short'
        && t.type === 'sell' && t.code === code && (t.createdAt || 0) >= cutoff);
    },

    /**
     * 仓位比例归一 (纯函数):
     *   缺失/非法 → 默认上限; 超上限 → 收敛到上限 (不丢弃, 保住计划);
     *   regime bear → × positionScale (gateMultipliers().positionScale, 默认 0.5)
     */
    _scalePositionPct(pct, regimeState, positionScale) {
      let v = parseFloat(pct);
      if (!(v > 0)) v = MAX_POSITION_PCT;
      v = Math.min(v, MAX_POSITION_PCT);
      if (regimeState === 'bear') {
        const scale = parseFloat(positionScale);
        v = v * (isFinite(scale) && scale > 0 ? scale : 1);
      }
      return +v.toFixed(4);
    },

    /** 丢弃留痕 append: 上限 PLAN_LOG_LIMIT 条 (滚动截断最旧), 纯函数 */
    _appendPlanLog(list, entry) {
      const arr = Array.isArray(list) ? [...list] : [];
      if (entry && entry.stage) arr.push(entry);
      return arr.slice(-PLAN_LOG_LIMIT);
    },

    /**
     * 校验管线 (纯函数): schema 字段 → pre-mortem → 幻觉防护 → 价格关系 → 短线纪律 → 股数换算
     * @param {Array} rawPlans LLM 输出的 plans 数组 (0-3 条, 空仓 = 空数组合法)
     * @param {{ pool: Set<string>, cash: number, quotaLeft: number,
     *           recentSellCodes: Set<string>, regimeState: string, positionScale: number,
     *           roundLot?: function }} ctx
     *        quotaLeft = maxDailyTrades - 今日已建条件单数; roundLot 可注入 (生产传 Paper._roundLot)
     * @returns {{ passed: Array, dropped: Array<{code, stage, reason}> }}
     */
    _validatePlans(rawPlans, ctx) {
      const passed = [];
      const dropped = [];
      const roundLot = ctx.roundLot || ((s) => Math.floor((parseFloat(s) || 0) / LOT_SIZE) * LOT_SIZE);
      const drop = (code, stage, reason) => dropped.push({ code: code || '', stage, reason });
      const plans = Array.isArray(rawPlans) ? rawPlans : [];
      for (const raw of plans) {
        const p = raw || {};
        const code = this._normCode6(p.code);
        // (a) schema 字段校验 (Phase T 模式: parseJsonOutput 之后的逐条字段级校验)
        if (!/^\d{6}$/.test(code)) { drop(code, 'schema', '代码必须是 6 位数字'); continue; }
        if (p.triggerDirection !== 'below' && p.triggerDirection !== 'above') {
          drop(code, 'schema', 'triggerDirection 必须是 below/above'); continue;
        }
        const tp = parseFloat(p.triggerPrice), sl = parseFloat(p.stopLoss), tg = parseFloat(p.targetPrice);
        if (!(tp > 0) || !(sl > 0) || !(tg > 0)) { drop(code, 'schema', '触发/止损/目标价必须 > 0'); continue; }
        const prob = Number(p.probability);
        if (!isFinite(prob) || prob < 0 || prob > 100) { drop(code, 'schema', 'probability 必填 (0-100)'); continue; }
        if (!['低', '中', '高'].includes(p.confidence)) { drop(code, 'schema', 'confidence 必填 (低/中/高)'); continue; }
        if (typeof p.assumption !== 'string' || !p.assumption.trim()) { drop(code, 'schema', 'assumption 必填'); continue; }
        // (a2) pre-mortem 四字段 (复用 Core.Premortem 规范: bullCase/bearCase/falsifyCondition/invalidation)
        const pmErrs = Core.Premortem.checkPick({
          code,
          bullCase: p.bullCase,
          bearCase: p.bearCase,
          falsifyCondition: p.falsifyCondition,
          invalidation: p.invalidation
        });
        if (pmErrs.length) { drop(code, 'premortem', pmErrs.join('; ')); continue; }
        // (b) 幻觉防护: 代码必须在候选池
        if (!ctx.pool.has(code)) { drop(code, 'hallucination', '代码不在候选池 (自选股+短线持仓), 疑似幻觉'); continue; }
        // (c) 价格关系: stopLoss < triggerPrice < targetPrice (双向统一, 与 T3 _checkCondOrder 同口径)
        if (!(sl < tp && tp < tg)) {
          drop(code, 'price', `价格关系不满足 止损 ${sl} < 触发 ${tp} < 目标 ${tg}`); continue;
        }
        // (d) 短线纪律
        if (passed.length >= (ctx.quotaLeft || 0)) {
          drop(code, 'quota', `超过每日最大笔数 ${SHORT_RULES.maxDailyTrades} (含今日已建条件单)`); continue;
        }
        if (ctx.recentSellCodes.has(code)) {
          drop(code, 'cooldown', `${SHORT_RULES.cooldownHours}h 内有短线卖出记录, 冷却期`); continue;
        }
        const positionPct = this._scalePositionPct(p.positionPct, ctx.regimeState, ctx.positionScale);
        // (d2) 股数换算: 短线现金 × positionPct / triggerPrice → 整手, 不足一手丢弃留痕
        const shares = roundLot(ctx.cash * positionPct / tp);
        if (shares < LOT_SIZE) {
          drop(code, 'shares', `按仓位 ${(positionPct * 100).toFixed(1)}% 换算不足一手 (${LOT_SIZE} 股)`); continue;
        }
        passed.push({
          code,
          name: String(p.name || '').slice(0, 20),
          triggerDirection: p.triggerDirection,
          triggerPrice: +tp.toFixed(2),
          stopLoss: +sl.toFixed(2),
          targetPrice: +tg.toFixed(2),
          positionPct,
          shares,
          assumption: p.assumption.trim(),
          falsifyCondition: String(p.falsifyCondition || '').trim(),
          invalidation: String(p.invalidation || '').trim(),
          probability: Math.round(prob),
          confidence: p.confidence,
          reason: String(p.reason || '').slice(0, 200),
          bullCase: p.bullCase,
          bearCase: p.bearCase
        });
      }
      return { passed, dropped };
    },

    /**
     * systemPrompt (纯函数): 短线波段操盘手人设
     * 持有 1-5 天 / 保守 / 宁缺毋滥可空仓; 输出严格 JSON; pre-mortem 字段复用 Core.Premortem 规范
     */
    _buildSystemPrompt() {
      return [
        `你是 A 股短线波段操盘手, 管理模拟盘 AI 短线子账户 (本金 ${Core.Constants.PAPER_SHORT_CASH} 元, 单笔仓位 ≤${MAX_POSITION_PCT * 100}%, 持有 1-${Core.Constants.SHORT_MAX_HOLD_DAYS} 个交易日, 日线级条件单成交)。`,
        '风格: 保守, 宁缺毋滥 —— 没有把握就空仓 (plans 输出空数组), 绝不为了交易而交易。',
        '',
        '【输出】严格 JSON (不要输出 JSON 以外的内容):',
        '{',
        '  "marketView": "今日大盘与短线环境判断 (≤100 字)",',
        '  "plans": [',
        '    {',
        '      "code": "6 位代码 (必须从候选池选)",',
        '      "name": "名称",',
        '      "triggerDirection": "below (回调买入) | above (突破买入)",',
        '      "triggerPrice": 触发买入价 (数字),',
        '      "stopLoss": 止损价 (必须 < triggerPrice),',
        '      "targetPrice": 目标价 (必须 > triggerPrice),',
        '      "positionPct": 仓位比例 (小数, ≤0.20),',
        '      "assumption": "买入假设 (业绩拐点|估值修复|题材催化|技术突破|分红套利|其他)",',
        '      "probability": 胜率自评 (0-100 整数, 必填),',
        '      "confidence": "低|中|高 (必填)",',
        '      "reason": "一句话理由 (引用具体数据)",',
        '      ' + Core.Premortem.PROMPT_SPEC.split('\n').join('\n      '),
        '    }',
        '  ]',
        '}',
        '',
        '【硬性规则】',
        `- plans 0-${SHORT_RULES.maxDailyTrades} 条 (允许 0 条 = 空仓)`,
        '- 价格关系必须满足 stopLoss < triggerPrice < targetPrice',
        '- code 必须从候选池选, 池外代码会被直接丢弃',
        '- probability/confidence 必填, 不自评视为无效输出'
      ].join('\n');
    },

    /**
     * userPrompt (纯函数): 上下文注入
     * 短线账户状态 / 持仓 / pending 条件单 / 近 N 天短线 journal / Regime / 市场快照 / 候选池
     */
    _buildUserPrompt(ctx) {
      const lines = [`# 日期: ${ctx.today}`, ''];
      lines.push('## 短线账户');
      lines.push(`现金: ¥${ctx.cash}`);
      lines.push('');
      lines.push('## 当前持仓 (short 子账户)');
      if (ctx.positions.length) {
        ctx.positions.forEach(p => {
          lines.push(`- ${p.code} ${p.name || ''} ${p.shares}股 成本${p.costPrice} 现价${p.price ?? '未知'}` +
            ` 止损${p.stopLoss ?? '-'} 目标${p.targetPrice ?? '-'} 浮盈${p.plPct != null ? (p.plPct * 100).toFixed(1) + '%' : '未知'}`);
        });
      } else {
        lines.push('(空仓)');
      }
      lines.push('');
      lines.push('## 待触发条件单 (勿重复建仓同代码)');
      if (ctx.pendingOrders.length) {
        ctx.pendingOrders.forEach(o => {
          lines.push(`- ${o.code} ${o.triggerDirection === 'below' ? '回调到' : '突破'} ${o.triggerPrice} 买 ${o.shares}股 (止损${o.stopLoss}/目标${o.targetPrice})`);
        });
      } else {
        lines.push('(无)');
      }
      lines.push('');
      lines.push(`## 近 ${JOURNAL_LOOKBACK_DAYS} 天短线交易摘要`);
      if (ctx.recentJournals.length) {
        ctx.recentJournals.forEach(j => lines.push(`- [${j.date}] ${j.code || ''} ${j.title || ''}`));
      } else {
        lines.push('(近期无短线交易记录)');
      }
      lines.push('');
      lines.push('## 大盘状态机 (Regime)');
      lines.push(`状态: ${ctx.regime.label} (${ctx.regime.state})` +
        (ctx.regime.state === 'bear' ? ' —— 下跌市, 仓位自动减半, 门槛从严' : ''));
      lines.push('');
      lines.push('## 指数快照');
      lines.push(ctx.marketText || '(市场数据不可用, 按常识谨慎判断)');
      lines.push('');
      lines.push('## 候选池 (只能从这里选 code)');
      if (ctx.pool.length) {
        lines.push(ctx.pool.map(x => `${x.code} ${x.name}`.trim()).join(' / '));
      } else {
        lines.push('(候选池为空 → 必须输出 plans: [])');
      }
      return lines.join('\n');
    },

    // ========== 上下文组装 (各块独立 try/catch 降级, 不互相阻塞) ==========

    async _buildPlanContext(now) {
      const nowMs = now.getTime();
      const ctx = {
        cash: 0,
        positions: [],
        pendingOrders: [],
        recentJournals: [],
        regime: { state: 'range', label: '震荡市', positionScale: 1 },
        marketText: '',
        pool: [],
        recentSellCodes: new Set(),
        todayCondCount: 0
      };
      // 短线账户现金
      try {
        const acc = await Paper._getAccountRaw('short');
        ctx.cash = +(+acc.cash).toFixed(2);
      } catch (e) { console.warn('[ShortTrader] ctx 读短线账户失败:', e); }
      // 短线持仓 (含止损/目标/浮盈)
      try {
        ctx.positions = (await Paper.getPositions('short')).map(p => ({
          code: p.code, name: p.name || '', shares: p.shares || 0,
          costPrice: p.costPrice, price: p.price,
          stopLoss: p.stopLoss, targetPrice: p.targetPrice, plPct: p.plPct
        })).slice(0, 10);
      } catch (e) { console.warn('[ShortTrader] ctx 读短线持仓失败:', e); }
      // 条件单: pending 列表 + 今日已建数 (maxDailyTrades 额度扣减)
      try {
        const all = await Paper.listCondOrders();
        const today = this._todayStr(now);
        ctx.pendingOrders = all.filter(o => o.status === 'pending');
        ctx.todayCondCount = all.filter(o => o.createdDate === today).length;
      } catch (e) { console.warn('[ShortTrader] ctx 读条件单失败:', e); }
      // 近 N 天短线 journal 摘要 (sleeve='short')
      try {
        const cutoff = this._todayStr(new Date(nowMs - JOURNAL_LOOKBACK_DAYS * 24 * 3600 * 1000));
        const rows = (await Core.Storage.all('journals')) || [];
        ctx.recentJournals = rows
          .filter(j => j && (j.sleeve || '') === 'short' && typeof j.date === 'string' && j.date >= cutoff)
          .map(j => ({ date: j.date, code: j.code || '', title: String(j.title || '').slice(0, 60) }))
          .slice(-10);
      } catch (e) { console.warn('[ShortTrader] ctx 读 journal 失败:', e); }
      // Regime 状态与 gate (失败保持 range 档 = 不缩放)
      try {
        const rec = await Core.Regime.get();
        const gate = Core.Regime.gateMultipliers();
        ctx.regime = { state: rec.state, label: gate.label, positionScale: gate.positionScale };
      } catch (e) { console.warn('[ShortTrader] ctx 读 Regime 失败:', e); }
      // 市场快照: 只用 Core.Data 已验证接口 getIndexSpot (腾讯优先, 失败降级 aktools)
      try {
        const idx = (await Core.Data.getIndexSpot()) || [];
        ctx.marketText = idx.slice(0, 8).map(i => {
          const name = i.名称 ?? i.name ?? (i.代码 ?? i.code ?? '');
          const price = i.最新价 ?? i.price ?? '-';
          const pct = i.涨跌幅 ?? i.changePct;
          return `${name} ${price}${pct != null ? ` (${pct}%)` : ''}`;
        }).join('; ');
      } catch (e) { console.warn('[ShortTrader] ctx 指数快照失败:', e); }
      // 候选池 = watchlist 全部 + short 持仓代码
      try {
        const wl = (await Core.Storage.all('watchlist')) || [];
        ctx.pool = this._buildCandidatePool(wl, ctx.positions);
      } catch (e) { console.warn('[ShortTrader] ctx 读自选股失败:', e); }
      // 同代码 48h 冷却集合 (transactions 表短线卖出)
      try {
        const txs = (await Core.Storage.all('transactions')) || [];
        ctx.recentSellCodes = new Set(
          txs.filter(t => this._hasRecentShortSell([t], t && t.code, nowMs, SHORT_RULES.cooldownHours))
            .map(t => t.code)
        );
      } catch (e) { console.warn('[ShortTrader] ctx 读交易流水失败:', e); }
      return ctx;
    },

    // ========== 业务入口 ==========

    /**
     * app init 异步调用 (参照 Paper.settleCondOrders 写法, 不阻塞启动):
     * 交易日 + kv 无今日记录 → 自动生成; 失败不打扰 (console.warn + kv error 记录,
     * UI 区块显示"今日计划生成失败, 可手动重试")
     */
    async maybeGeneratePlan(now = new Date()) {
      try {
        if (!this._isTradingDay(now)) return { skipped: true, reason: 'non-trading-day' };
        const today = this._todayStr(now);
        let existing = null;
        try { existing = await Core.Storage.kvGet(PLAN_KEY); }
        catch (e) { console.warn('[ShortTrader] 读今日计划失败:', e); }
        if (existing && existing.date === today) return { skipped: true, reason: 'exists', plan: existing };
        const plan = await this.generatePlan({ now });
        return { skipped: false, plan };
      } catch (e) {
        console.warn('[ShortTrader] 今日计划生成失败:', e);
        await this._saveFailure(this._todayStr(now), e);
        return { skipped: false, error: String((e && e.message) || e) };
      }
    },

    /**
     * 生成今日计划: 上下文组装 → LLM (callWithTimeout) → schema 校验 → 校验管线 →
     * 通过的逐条 Paper.addCondOrder(source:'ai') → 存 kv + 丢弃留痕
     * @param {{ now?: Date, deps?: { callLLM?: function } }} [opts]
     *        deps.callLLM 可注入 mock ({systemPrompt, prompt}) => string (测试用)
     * @returns plan object { date, marketView, plans, dropped, generatedAt }
     */
    async generatePlan(opts = {}) {
      const now = opts.now || new Date();
      const today = this._todayStr(now);
      const ctx = await this._buildPlanContext(now);
      const systemPrompt = this._buildSystemPrompt();
      const prompt = this._buildUserPrompt({ ...ctx, today });
      const callLLM = (opts.deps && opts.deps.callLLM)
        || (async ({ systemPrompt: sp, prompt: pr }) => Core.AI.callWithTimeout({ systemPrompt: sp, prompt: pr, timeout: LLM_TIMEOUT_MS }));
      const text = await callLLM({ systemPrompt, prompt });

      // (a) JSON schema 校验 (Phase T 模式: parseJsonOutput + required/types/arrayItemTypes)
      const parsed = Core.AI.parseJsonOutput(text, {
        required: ['marketView', 'plans'],
        types: { marketView: 'string', plans: 'array' },
        arrayItemTypes: { plans: 'object' }
      });
      if (!parsed.ok) throw new Error('AI 输出未通过 JSON schema 校验: ' + parsed.errors.join('; '));

      // (b)-(e) 校验管线 (纯函数)
      const { passed, dropped } = this._validatePlans(parsed.obj.plans, {
        pool: new Set(ctx.pool.map(x => x.code)),
        cash: ctx.cash,
        quotaLeft: Math.max(0, SHORT_RULES.maxDailyTrades - ctx.todayCondCount),
        recentSellCodes: ctx.recentSellCodes,
        regimeState: ctx.regime.state,
        positionScale: ctx.regime.positionScale,
        roundLot: (s) => Paper._roundLot(s)
      });

      // 落地: 通过的 plans 逐条自动转条件单 (addCondOrder 内部二次校验价格/现金)
      const plans = [];
      for (const p of passed) {
        const r = await Paper.addCondOrder({
          code: p.code,
          name: p.name,
          market: Core.Util.stockCodePrefix(p.code),
          triggerDirection: p.triggerDirection,
          triggerPrice: p.triggerPrice,
          stopLoss: p.stopLoss,
          targetPrice: p.targetPrice,
          shares: p.shares,
          assumption: p.assumption,
          falsifyCondition: p.falsifyCondition,
          invalidation: p.invalidation,
          probability: p.probability,
          source: 'ai',
          sleeve: 'short'
        });
        if (r && r.ok) {
          plans.push({ ...p, condOrderId: r.order.id });
        } else {
          dropped.push({ code: p.code, stage: 'addCondOrder', reason: (r && r.errors && r.errors[0]) || '条件单创建失败' });
        }
      }

      const plan = {
        date: today,
        marketView: String(parsed.obj.marketView || ''),
        plans,
        dropped,
        generatedAt: Date.now()
      };
      await Core.Storage.kvSet(PLAN_KEY, plan);
      // 每条丢弃写 paper_plan_log (上限 SHORT_PLAN_LOG_LIMIT)
      if (dropped.length) {
        let log = [];
        try { log = (await Core.Storage.kvGet(PLAN_LOG_KEY)) || []; }
        catch (e) { console.warn('[ShortTrader] 读丢弃留痕失败:', e); }
        for (const d of dropped) {
          log = this._appendPlanLog(log, { date: today, code: d.code, stage: d.stage, reason: d.reason });
        }
        await Core.Storage.kvSet(PLAN_LOG_KEY, log);
      }
      return plan;
    },

    /** 失败记录: kv 写 error 条 (同日覆盖), UI 据此显示"生成失败可手动重试" */
    async _saveFailure(today, e) {
      try {
        await Core.Storage.kvSet(PLAN_KEY, {
          date: today,
          error: String((e && e.message) || e),
          marketView: '',
          plans: [],
          dropped: [],
          generatedAt: Date.now()
        });
      } catch (e2) { console.warn('[ShortTrader] 失败记录写库失败:', e2); }
    },

    /** 🔄 重新生成按钮: confirm 后覆盖今日记录 (已创建的条件单不受影响) */
    async regenerate() {
      if (!confirm('重新生成将覆盖今日计划 (已创建的条件单不受影响), 继续?')) return null;
      try {
        const plan = await this.generatePlan();
        await this.renderTodayPlan();
        return plan;
      } catch (e) {
        console.warn('[ShortTrader] 手动重新生成失败:', e);
        await this._saveFailure(this._todayStr(new Date()), e);
        await this.renderTodayPlan();
        return null;
      }
    },

    // ========== UI (模拟盘短线 tab "🤖 今日计划" 区块; 渲染逻辑收口于此, paper.js 只负责挂载) ==========

    async renderTodayPlan() {
      const el = document.getElementById('shortTraderPlan');
      if (!el) return;
      let plan = null;
      try { plan = await Core.Storage.kvGet(PLAN_KEY); }
      catch (e) { console.warn('[ShortTrader] 读计划失败:', e); }
      const today = this._todayStr(new Date());
      const retryBtn = '<button class="btn btn-sm" onclick="ShortTrader.regenerate()">🔄 重新生成</button>';

      if (!plan || plan.date !== today) {
        el.innerHTML = `<div class="empty" style="padding:16px;">今日暂无计划${this._isTradingDay(new Date()) ? ' (启动时自动生成)' : ' (非交易日)'}</div>` +
          `<div style="margin-top:8px;">${retryBtn}</div>`;
        return;
      }
      if (plan.error) {
        el.innerHTML = `<div style="color:var(--down);font-size:13px;">今日计划生成失败, 可手动重试: ${escapeHtml(plan.error)}</div>` +
          `<div style="margin-top:8px;">${retryBtn}</div>`;
        return;
      }

      let html = '';
      if (plan.marketView) {
        html += `<div style="margin-bottom:8px;font-size:13px;"><strong>📈 大盘观点</strong>: ${escapeHtml(plan.marketView)}</div>`;
      }
      if (!plan.plans || plan.plans.length === 0) {
        html += '<div style="color:var(--text-muted);font-size:12px;margin-bottom:8px;">🧘 今日空仓 / 无通过校验的计划 (宁缺毋滥)</div>';
      }
      html += (plan.plans || []).map(p => {
        const dirBadge = p.triggerDirection === 'below' ? '回调买入' : '突破买入';
        return `<div class="ai-pick" style="margin-bottom:8px;">` +
          `<div class="ai-pick-head">` +
          `<strong>${escapeHtml(p.code)} ${escapeHtml(p.name || '')}</strong>` +
          `<span style="font-size:11px;color:var(--text-muted);">${dirBadge} · 胜率 ${escapeHtml(String(p.probability))}% · 信心${escapeHtml(p.confidence || '')}</span>` +
          `</div>` +
          `<div style="font-size:12px;margin-top:4px;">` +
          `触发 ${fmtNum(p.triggerPrice, 2)} / 止损 ${fmtNum(p.stopLoss, 2)} / 目标 ${fmtNum(p.targetPrice, 2)} / ` +
          `仓位 ${(p.positionPct * 100).toFixed(1)}% (${fmtNum(p.shares, 0)} 股) ` +
          (p.condOrderId ? '<span style="font-size:11px;color:var(--up);">✅ 已转条件单</span>' : '') +
          `</div>` +
          (p.reason ? `<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">${escapeHtml(p.reason)}</div>` : '') +
          Core.Premortem.renderBlock(p) +
          `</div>`;
      }).join('');
      if (plan.dropped && plan.dropped.length) {
        html += `<details style="margin-top:6px;"><summary style="font-size:12px;color:var(--text-muted);cursor:pointer;">🗑 已丢弃 ${plan.dropped.length} 条 (校验未通过)</summary>` +
          `<ul style="font-size:12px;color:var(--text-muted);margin:4px 0;padding-left:18px;">` +
          plan.dropped.map(d => `<li>${escapeHtml(d.code || '-')} [${escapeHtml(d.stage)}] ${escapeHtml(d.reason)}</li>`).join('') +
          `</ul></details>`;
      }
      html += `<div style="margin-top:8px;display:flex;gap:8px;align-items:center;">${retryBtn}` +
        `<span style="font-size:11px;color:var(--text-muted);">生成于 ${escapeHtml(fmtDateTime(new Date(plan.generatedAt || Date.now())))}</span></div>`;
      el.innerHTML = html;
    }
  };

  window.ShortTrader = ShortTrader;
})();
