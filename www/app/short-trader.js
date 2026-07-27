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
 *
 * T4 学习环 (本文档下半部分实现):
 *   - verifyClosedTrades(): 扫描 journals 里 sleeve='short'+auto:true 的卖出退出行 (含退出信息且
 *     verifyOutcome 缺失), 平仓满 SHORT_VERIFY_DELAY_DAYS 根后续日 K → 拉近 10 根日 K 机械判定
 *     (不用 LLM): 止损收复→wrong/时机过早, 止损未收复→wrong/假设错误, 止盈续涨超 5%→partial,
 *     强平盈利→correct / 强平亏损→partial/时机过早, 兜底按盈亏; 写回 verifyOutcome /
 *     verifyFailureReason / verifiedAt / postExitNote (枚举复用 Core.Constants.VERIFY_OUTCOMES /
 *     VERIFY_FAILURE_REASONS, 与 Z2 对齐); K 线拉不到跳过下轮再试, 不写失败态
 *   - 成绩单: _linkVerifiedTrades (journal ↔ paper_short_positions ↔ paper_cond_orders 关联出
 *     assumption/probability) → _buildTrackRecord 聚合 (按 assumption 分组/Top3 归因/最近 wrong),
 *     样本 < SCORECARD_MIN_SAMPLES 不注入; generatePlan prompt 追加 【你的历史成绩单】+【我的教训】
 *   - maybeDistillLessons(): 距上次 ≥7 天且新增已验证 ≥5 条 → LLM 提炼 2-3 条第一人称错误模式,
 *     kv short_trader_lessons { items: [{text, createdAt, basedOn}], lastDistill } (上限 20);
 *     JSON 校验失败只 console.warn 不动旧 lessons
 *     (注: 与 paper.js 的 kv paper_short_lessons 数组结构是两套并存, key 不同互不干扰)
 *   - UI: 短线 tab "📊 学习曲线" 区块 (Brier / 校准分桶 / 最近 10 条已验证 / 我的教训)
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
  // ---- T4 学习环常量 ----
  const SHORT_LESSONS_KEY = 'short_trader_lessons';   // kv: { items:[{text,createdAt,basedOn}], lastDistill }
  const VERIFY_DELAY = Core.Constants.SHORT_VERIFY_DELAY_DAYS;                 // 平仓后至少 N 根后续 K 才判定
  const VERIFY_LOOKAHEAD = Core.Constants.SHORT_VERIFY_LOOKAHEAD_BARS;         // 出场后观察窗 (3)
  const VERIFY_KLINE_BARS = Core.Constants.SHORT_VERIFY_KLINE_BARS;            // 拉近 10 根日 K
  const RUNUP_PCT = Core.Constants.SHORT_TARGET_RUNUP_PCT;                     // 止盈续涨 5% 阈值
  const TRACK_RECORD_MAX_LEN = Core.Constants.SHORT_TRACK_RECORD_MAX_LEN;      // 成绩单注入 ≤400 字
  const LESSONS_LIMIT = Core.Constants.SHORT_LESSONS_LIMIT;                    // lessons items 上限 20
  const DISTILL_INTERVAL = Core.Constants.SHORT_LESSONS_DISTILL_INTERVAL_MS;   // 提炼间隔 7 天
  const DISTILL_MIN_NEW = Core.Constants.SHORT_LESSONS_MIN_NEW_SAMPLES;        // 新增已验证 ≥5 条
  const DISTILL_FEED_MAX = Core.Constants.SHORT_LESSONS_FEED_MAX;              // 喂 LLM 最近 20 条
  const DISTILL_MAX_ITEMS = Core.Constants.SHORT_LESSONS_PER_DISTILL_MAX;      // 单次 2-3 条
  const LESSON_TEXT_MAX = Core.Constants.SHORT_LESSONS_TEXT_MAX_LEN;           // 每条 ≤40 字
  const SCORECARD_MIN = Core.Constants.SCORECARD_MIN_SAMPLES;                  // 成绩单样本门槛 3
  const BRIER_MIN = Core.Constants.BRIER_MIN_SAMPLES;                          // Brier 样本门槛 5
  const RECENT_VERIFIED_UI = 10;                                               // UI 最近已验证交易条数

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

    // ========== T4 学习环: 纯函数 (机械判定 / 关联 / 聚合 / 校准, Node 沙箱可测) ==========

    /** 日 K 行标准化 (与 Paper._barOf 同构, 本模块独立一份避免跨域耦合) */
    _barOf(row) {
      if (!row) return null;
      const open = parseFloat(row.开盘), high = parseFloat(row.最高);
      const low = parseFloat(row.最低), close = parseFloat(row.收盘);
      const date = String(row.日期 || '').slice(0, 10);
      if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0) || !date) return null;
      return { open, high, low, close, date };
    },

    /**
     * 从 T3 结算写的退出 journal 行解析结构化信息 (纯函数)
     * 只认"卖出成交"类 (content 含 卖出日期/原因/入场/出场 四要素), 买入/过期/取消行返 null
     * @returns {{code, exitReason, exitDate, entryDate, entryPrice, exitPrice, pnl} | null}
     *   pnl 为每股盈亏 (exitPrice-entryPrice), 判定只用符号
     */
    _extractExitInfo(row) {
      if (!row || typeof row.content !== 'string') return null;
      const c = row.content;
      const mDate = c.match(/卖出日期\**\s*[:：]\s*(\d{4}-\d{2}-\d{2})/);
      const mReason = c.match(/原因\**\s*[:：]\s*(.+)/);
      const mEntry = c.match(/入场\**\s*[:：]\s*(\d{4}-\d{2}-\d{2})\s*@\s*([\d.]+)/);
      const mExit = c.match(/出场\**\s*[:：]\s*([\d.]+)/);
      if (!mDate || !mReason || !mEntry || !mExit) return null;
      const entryPrice = parseFloat(mEntry[2]), exitPrice = parseFloat(mExit[1]);
      if (!(entryPrice > 0) || !(exitPrice > 0)) return null;
      return {
        code: this._normCode6(row.code),
        exitReason: mReason[1].trim(),
        exitDate: mDate[1],
        entryDate: mEntry[1],
        entryPrice,
        exitPrice,
        pnl: +(exitPrice - entryPrice).toFixed(4)
      };
    },

    /**
     * 平仓机械判定 (纯函数, 不用 LLM, 确定性强)
     * 判定表 (outcome/reason 枚举复用 Core.Constants.VERIFY_OUTCOMES / VERIFY_FAILURE_REASONS):
     *   止损: 出场后 3 个交易日内收盘价收复入场价 → wrong + 时机过早 (被扫止损后回升);
     *         未收复 → wrong + 假设错误
     *   止盈: 出场后 3 日内 high 续涨超出场价 5% → partial (对但卖早, 归因留空); 否则 correct
     *   到期强平: 盈利 → correct; 亏损 → partial + 时机过早
     *   其他/未知退出: 盈利 → correct; 亏损 → wrong + 假设错误 (兜底)
     * @param {{exitReason, pnl, entryPrice, exitPrice, exitDate, bars}} input
     *   bars 为含出场日在内的日 K 序列, 函数内部只取 date > exitDate 的最多 3 根
     * @returns {{outcome: string, reason: string|null, note: string}}
     */
    _judgeClosedTrade({ exitReason, pnl, entryPrice, exitPrice, exitDate, bars }) {
      const after = (Array.isArray(bars) ? bars : [])
        .filter(b => b && b.date && b.date > exitDate)
        .slice(0, VERIFY_LOOKAHEAD);
      const reason = String(exitReason || '');
      const gain = (parseFloat(pnl) || 0) > 0;
      if (reason.includes('止损')) {
        const idx = after.findIndex(b => b.close >= entryPrice);
        if (idx >= 0) {
          return { outcome: 'wrong', reason: '时机过早', note: `止损后 ${idx + 1} 日收复入场价, 属时机过早` };
        }
        return { outcome: 'wrong', reason: '假设错误', note: `止损后 ${after.length} 日内未收复入场价, 假设不成立` };
      }
      if (reason.includes('止盈')) {
        const runup = exitPrice * (1 + RUNUP_PCT);
        const idx = after.findIndex(b => b.high >= runup);
        if (idx >= 0) {
          return { outcome: 'partial', reason: null, note: `止盈后 ${idx + 1} 日内续涨超 ${(RUNUP_PCT * 100).toFixed(0)}%, 方向对但卖早` };
        }
        return { outcome: 'correct', reason: null, note: '止盈后未续涨, 出场正确' };
      }
      if (reason.includes('强平')) {
        if (gain) return { outcome: 'correct', reason: null, note: '到期强平仍盈利, 方向正确' };
        return { outcome: 'partial', reason: '时机过早', note: '到期强平亏损, 入场时机偏早' };
      }
      if (gain) return { outcome: 'correct', reason: null, note: '平仓盈利' };
      return { outcome: 'wrong', reason: '假设错误', note: '平仓亏损, 假设不成立' };
    },

    /**
     * 已验证短线交易关联 (纯函数):
     * journals (sleeve=short + auto + 有 verifyOutcome + 可解析退出信息)
     *   ↔ paper_short_positions (code+exitDate 匹配出 planOrderId)
     *   ↔ paper_cond_orders (取 assumption / probability, Brier 与分组的数据来源)
     * @returns Array 按 exitDate 升序
     */
    _linkVerifiedTrades(journals, positions, orders) {
      const orderById = {};
      (Array.isArray(orders) ? orders : []).forEach(o => { if (o && o.id) orderById[o.id] = o; });
      const out = [];
      for (const j of (Array.isArray(journals) ? journals : [])) {
        if (!j || (j.sleeve || '') !== 'short' || !j.auto || !j.verifyOutcome) continue;
        const info = this._extractExitInfo(j);
        if (!info) continue;
        // 仓位跟踪行匹配: 同代码 + 同出场日 (多单同日出场的极端情况取入场日最新的一笔)
        const pos = (Array.isArray(positions) ? positions : [])
          .filter(p => p && p.closed && p.code === info.code && p.exitDate === info.exitDate)
          .sort((a, b) => String(b.entryDate || '').localeCompare(String(a.entryDate || '')))[0];
        const order = (pos && pos.planOrderId) ? (orderById[pos.planOrderId] || null) : null;
        // 名称从 title 兜底解析 ("⚡ 短线止损: 600519 贵州茅台")
        const mName = String(j.title || '').match(/\d{6}\s*(.+)$/);
        out.push({
          journalId: j.id,
          code: info.code,
          name: mName ? mName[1].trim() : '',
          assumption: (order && order.assumption) || '',
          probability: (order && order.probability != null && isFinite(order.probability)) ? Number(order.probability) : null,
          outcome: j.verifyOutcome,
          reason: j.verifyFailureReason || null,
          note: j.postExitNote || '',
          exitDate: info.exitDate,
          entryDate: info.entryDate,
          entryPrice: info.entryPrice,
          exitPrice: info.exitPrice,
          exitReason: info.exitReason,
          pnl: info.pnl,
          verifiedAt: j.verifiedAt || 0
        });
      }
      return out.sort((a, b) => String(a.exitDate).localeCompare(String(b.exitDate)));
    },

    /**
     * 短线成绩单聚合 (纯函数): 按 assumption 分组 + 全局 Top3 归因 + 最近 1 条 wrong 摘要
     * 样本 < SCORECARD_MIN_SAMPLES (3) 返 null (不注入, 避免误导)
     * correctRate 口径: correct=1 / partial=0.5 / wrong=0 的均值
     */
    _buildTrackRecord(trades) {
      const list = (Array.isArray(trades) ? trades : []).filter(t => t && t.outcome);
      if (list.length < SCORECARD_MIN) return null;
      const score = (o) => this._outcomeScore(o);
      const groups = {};
      for (const t of list) {
        const key = t.assumption || '未标注';
        const g = groups[key] || (groups[key] = { assumption: key, total: 0, scoreSum: 0, reasons: {} });
        g.total++;
        g.scoreSum += score(t.outcome);
        if (t.reason) g.reasons[t.reason] = (g.reasons[t.reason] || 0) + 1;
      }
      const topOf = (rs) => {
        const e = Object.entries(rs).sort((a, b) => b[1] - a[1])[0];
        return e ? e[0] : null;
      };
      const byAssumption = Object.values(groups)
        .map(g => ({ assumption: g.assumption, total: g.total,
          correctRate: +(g.scoreSum / g.total).toFixed(2), topReason: topOf(g.reasons) }))
        .sort((a, b) => b.total - a.total);
      const allReasons = {};
      list.forEach(t => { if (t.reason) allReasons[t.reason] = (allReasons[t.reason] || 0) + 1; });
      const topReasons = Object.entries(allReasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
        .map(([reason, count]) => ({ reason, count }));
      const lastWrongT = [...list].reverse().find(t => t.outcome === 'wrong') || null;
      const totalScore = list.reduce((s, t) => s + score(t.outcome), 0);
      return {
        total: list.length,
        correctRate: +(totalScore / list.length).toFixed(2),
        byAssumption,
        topReasons,
        lastWrong: lastWrongT ? { code: lastWrongT.code, assumption: lastWrongT.assumption || '',
          note: lastWrongT.note || '', exitDate: lastWrongT.exitDate } : null
      };
    },

    /** 成绩单 → prompt 注入文本 (纯函数, ≤ TRACK_RECORD_MAX_LEN 字) */
    _formatTrackRecord(rec) {
      if (!rec) return '';
      const L = [];
      L.push(`【你的历史成绩单】短线已验证 ${rec.total} 笔, 综合胜率 ${(rec.correctRate * 100).toFixed(0)}% (partial 计 0.5)`);
      if (rec.byAssumption.length) {
        L.push('分假设: ' + rec.byAssumption.map(g =>
          `${g.assumption} ${g.total}笔 胜率${(g.correctRate * 100).toFixed(0)}%` +
          (g.topReason ? ` 主因:${g.topReason}` : '')).join('; '));
      }
      if (rec.topReasons.length) {
        L.push('常见错误: ' + rec.topReasons.map(r => `${r.reason}×${r.count}`).join(' / '));
      }
      if (rec.lastWrong) {
        L.push(`最近错误: ${rec.lastWrong.code} ${rec.lastWrong.assumption || '-'} — ${rec.lastWrong.note || ''}`);
      }
      let text = L.join('\n');
      if (text.length > TRACK_RECORD_MAX_LEN) text = text.slice(0, TRACK_RECORD_MAX_LEN - 1) + '…';
      return text;
    },

    /** verifyOutcome → 数值 (Brier/校准共用): correct=1 / partial=0.5 / wrong=0 */
    _outcomeScore(outcome) {
      return outcome === 'correct' ? 1 : (outcome === 'partial' ? 0.5 : 0);
    },

    /** Brier score (纯函数): mean((prob/100 - outcomeScore)^2), 0 最好; 空样本返 null */
    _brierScore(pairs) {
      const list = (Array.isArray(pairs) ? pairs : []).filter(p => p && isFinite(p.probability) && p.outcome);
      if (!list.length) return null;
      const sum = list.reduce((s, p) => s + Math.pow(p.probability / 100 - this._outcomeScore(p.outcome), 2), 0);
      return +(sum / list.length).toFixed(4);
    },

    /** 校准分桶 (纯函数): 按 CALIBRATION_BUCKET_EDGES (<40/40-60/60-80/≥80) 预测均值 vs 实际命中率 */
    _calibrationBuckets(pairs) {
      const edges = Core.Constants.CALIBRATION_BUCKET_EDGES || [0, 40, 60, 80, 101];
      const labels = ['<40', '40-60', '60-80', '≥80'];
      const list = (Array.isArray(pairs) ? pairs : []).filter(p => p && isFinite(p.probability) && p.outcome);
      const buckets = [];
      for (let i = 0; i < edges.length - 1; i++) {
        const inBucket = list.filter(p => p.probability >= edges[i] && p.probability < edges[i + 1]);
        buckets.push({
          label: labels[i] || `${edges[i]}-${edges[i + 1]}`,
          n: inBucket.length,
          predMean: inBucket.length ? +(inBucket.reduce((s, p) => s + p.probability, 0) / inBucket.length).toFixed(1) : null,
          hitRate: inBucket.length ? +(inBucket.reduce((s, p) => s + this._outcomeScore(p.outcome), 0) / inBucket.length * 100).toFixed(1) : null
        });
      }
      return buckets;
    },

    // ========== T4 学习环: 业务入口 ==========

    /** 已验证短线交易汇总 (journals + 仓位跟踪 + 条件单 三源关联, 各块独立降级) */
    async _collectVerifiedTrades() {
      const journals = (await Core.Storage.all('journals')) || [];
      let positions = [], orders = [];
      try { positions = (await Core.Storage.kvGet('paper_short_positions')) || []; }
      catch (e) { console.warn('[ShortTrader] 读短线仓位跟踪失败:', e); }
      try { orders = (await Core.Storage.kvGet('paper_cond_orders')) || []; }
      catch (e) { console.warn('[ShortTrader] 读条件单失败:', e); }
      return this._linkVerifiedTrades(journals, positions, orders);
    },

    /**
     * 平仓后机械 verify (app init 异步调用, 不阻塞启动):
     * 扫描 journals sleeve='short'+auto:true + 含退出信息 + verifyOutcome 缺失的行,
     * 平仓满 VERIFY_DELAY 根后续日 K → 机械判定写回 verifyOutcome/verifyFailureReason/verifiedAt/postExitNote;
     * K 线拉不到 → 跳过下轮再试 (不写失败态)
     * @param {{ getBars?: function }} [deps] getBars(code) => [{open,high,low,close,date}] (测试注入)
     * @returns {{ verified, pending, skipped } | null}
     */
    async verifyClosedTrades(deps = {}) {
      const summary = { verified: 0, pending: 0, skipped: 0 };
      try {
        const rows = (await Core.Storage.all('journals')) || [];
        const getBars = deps.getBars || (async (code) => {
          const krows = await Core.Data.getStockKLine(code, 'daily', undefined, undefined, '');
          return (krows || []).map(r => this._barOf(r)).filter(b => b).slice(-VERIFY_KLINE_BARS);
        });
        for (const row of rows) {
          if (!row || (row.sleeve || '') !== 'short' || !row.auto || row.verifyOutcome) continue;
          const info = this._extractExitInfo(row);
          if (!info || !info.code) continue;
          let bars = null;
          try { bars = await getBars(info.code); }
          catch (e) { console.warn(`[ShortTrader] verify 拉 K 失败, 本轮跳过 ${info.code}:`, e); }
          if (!bars || !bars.length) { summary.skipped++; continue; }
          const afterCnt = bars.filter(b => b.date > info.exitDate).length;
          if (afterCnt < VERIFY_DELAY) { summary.pending++; continue; }   // 平仓未满观察期
          const judged = this._judgeClosedTrade({ ...info, bars });
          row.verifyOutcome = judged.outcome;
          row.verifyFailureReason = judged.reason || null;
          row.verifiedAt = Date.now();
          row.postExitNote = judged.note;
          row.updatedAt = Date.now();
          await Core.Storage.put('journals', row);
          summary.verified++;
        }
        return summary;
      } catch (e) {
        console.warn('[ShortTrader] 平仓 verify 失败:', e);
        return null;
      }
    },

    /**
     * 周末错误模式提炼 (app init 异步调用):
     * 距上次 ≥7 天 且 自上次以来新增已验证交易 ≥5 条 → LLM 提炼 2-3 条第一人称可执行错误模式;
     * 严格 JSON {lessons:[...]} 走 parseJsonOutput, 校验失败只 console.warn 不动旧 lessons
     * @param {{ callLLM?: function }} [deps] 测试注入
     */
    async maybeDistillLessons(now = new Date(), deps = {}) {
      try {
        const nowMs = now.getTime();
        const data = (await Core.Storage.kvGet(SHORT_LESSONS_KEY)) || { items: [], lastDistill: 0 };
        const items = Array.isArray(data.items) ? data.items : [];
        const lastDistill = data.lastDistill || 0;
        if (nowMs - lastDistill < DISTILL_INTERVAL) return { skipped: true, reason: 'interval' };
        const trades = await this._collectVerifiedTrades();
        const newSince = trades.filter(t => (t.verifiedAt || 0) > lastDistill);
        if (newSince.length < DISTILL_MIN_NEW) return { skipped: true, reason: 'samples', count: newSince.length };
        const feed = trades.slice(-DISTILL_FEED_MAX).map(t =>
          `- ${t.code} ${t.assumption || '-'} 盈亏${t.pnl >= 0 ? '+' : ''}${t.pnl} (${t.outcome}${t.reason ? '/' + t.reason : ''}) ${t.note || ''}`);
        const systemPrompt = [
          '你是 A 股短线操盘手, 正在复盘自己的已验证交易记录, 提炼"我自己的系统性错误模式"。',
          `【输出】严格 JSON: {"lessons": ["...", "..."]}, 2-${DISTILL_MAX_ITEMS} 条, 每条 ≤${LESSON_TEXT_MAX} 字,`,
          '第一人称, 可执行 (含场景+频率+今后动作), 例: "我在放量突破日的追高买入 5 次亏 4 次, 今后突破单仓位减半"。',
          '不要输出 JSON 以外的内容。'
        ].join('\n');
        const prompt = `# 最近已验证交易 (${feed.length} 笔)\n` + feed.join('\n');
        const callLLM = (deps && deps.callLLM)
          || (async ({ systemPrompt: sp, prompt: pr }) => Core.AI.callWithTimeout({ systemPrompt: sp, prompt: pr, timeout: LLM_TIMEOUT_MS }));
        const text = await callLLM({ systemPrompt, prompt });
        const parsed = Core.AI.parseJsonOutput(text, { required: ['lessons'], types: { lessons: 'array' } });
        if (!parsed.ok) {
          console.warn('[ShortTrader] 教训提炼 JSON 校验失败, 保留旧 lessons:', parsed.errors);
          return { skipped: true, reason: 'invalid-json' };
        }
        const seen = new Set();
        const lessons = (parsed.obj.lessons || [])
          .map(s => String(s == null ? '' : s).trim().slice(0, LESSON_TEXT_MAX))
          .filter(s => s && !seen.has(s) && seen.add(s))
          .slice(0, DISTILL_MAX_ITEMS);
        if (!lessons.length) {
          console.warn('[ShortTrader] 教训提炼结果为空, 保留旧 lessons');
          return { skipped: true, reason: 'empty' };
        }
        const today = this._todayStr(now);
        const newItems = lessons.map(t => ({ text: t, createdAt: nowMs, basedOn: today }));
        await Core.Storage.kvSet(SHORT_LESSONS_KEY, {
          items: [...items, ...newItems].slice(-LESSONS_LIMIT),
          lastDistill: nowMs
        });
        return { skipped: false, added: lessons.length };
      } catch (e) {
        console.warn('[ShortTrader] 教训提炼失败:', e);
        return { skipped: true, reason: 'error' };
      }
    },

    /** 盘前 prompt 注入文本: 【你的历史成绩单】(样本 ≥3 才有) +【我的教训】; 任何失败返 '' 不影响主流程 */
    async _buildLearningPromptText() {
      try {
        const trades = await this._collectVerifiedTrades();
        const parts = [];
        const recText = this._formatTrackRecord(this._buildTrackRecord(trades));
        if (recText) parts.push('', recText);
        let lessons = null;
        try { lessons = await Core.Storage.kvGet(SHORT_LESSONS_KEY); }
        catch (e) { console.warn('[ShortTrader] 读 lessons 失败:', e); }
        const items = lessons && Array.isArray(lessons.items) ? lessons.items : [];
        if (items.length) {
          parts.push('', '【我的教训】');
          items.forEach((it, i) => parts.push(`${i + 1}. ${it.text}`));
        }
        return parts.join('\n');
      } catch (e) {
        console.warn('[ShortTrader] 学习上下文组装失败:', e);
        return '';
      }
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
      // T4: 既有上下文后追加成绩单 + 我的教训 (样本不足/读取失败自动为空串, 不影响主流程)
      const learningText = await this._buildLearningPromptText();
      const prompt = this._buildUserPrompt({ ...ctx, today }) + learningText;
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
    },

    /** T4 UI: 短线 tab "📊 学习曲线" 区块 (Brier / 校准分桶 / 最近已验证 / 我的教训, 全 escapeHtml) */
    async renderLearningCurve() {
      const el = document.getElementById('shortTraderLearning');
      if (!el) return;
      let trades = [];
      try { trades = await this._collectVerifiedTrades(); }
      catch (e) { console.warn('[ShortTrader] 学习曲线数据读取失败:', e); }
      const pairs = trades.filter(t => t.probability != null)
        .map(t => ({ probability: t.probability, outcome: t.outcome }));
      let html = '';
      // Brier score (样本 < BRIER_MIN 显示积累中)
      const brier = this._brierScore(pairs);
      if (brier == null || pairs.length < BRIER_MIN) {
        html += `<div style="font-size:13px;">📈 Brier 概率校准分: <span style="color:var(--text-muted);">积累中 (已有 ${pairs.length} 条, 还需 ${Math.max(0, BRIER_MIN - pairs.length)} 条)</span></div>`;
      } else {
        html += `<div style="font-size:13px;">📈 Brier 概率校准分: <strong>${brier.toFixed(3)}</strong> <span style="font-size:11px;color:var(--text-muted);">(0 最好, 样本 ${pairs.length})</span></div>`;
      }
      // 校准分桶表 (预测均值 vs 实际命中率)
      const buckets = this._calibrationBuckets(pairs);
      html += '<table style="width:100%;font-size:12px;margin-top:8px;border-collapse:collapse;">' +
        '<tr style="color:var(--text-muted);"><th align="left">预测胜率</th><th align="right">样本</th><th align="right">预测均值</th><th align="right">实际命中</th></tr>' +
        buckets.map(b => `<tr><td>${escapeHtml(b.label)}</td><td align="right">${b.n}</td>` +
          `<td align="right">${b.predMean == null ? '-' : b.predMean + '%'}</td>` +
          `<td align="right">${b.hitRate == null ? '-' : b.hitRate + '%'}</td></tr>`).join('') +
        '</table>';
      // 最近 10 条已验证交易对照表
      const recent = trades.slice(-RECENT_VERIFIED_UI).reverse();
      if (recent.length) {
        const outcomeLabel = { correct: '✅对', partial: '🟡半对', wrong: '❌错' };
        html += '<div style="margin-top:10px;font-size:12px;color:var(--text-muted);">最近已验证交易:</div>' +
          '<table style="width:100%;font-size:12px;margin-top:4px;border-collapse:collapse;">' +
          '<tr style="color:var(--text-muted);"><th align="left">代码</th><th align="left">假设</th><th align="right">预测</th><th align="left">结果</th><th align="left">归因/结论</th></tr>' +
          recent.map(t => `<tr><td>${escapeHtml(t.code)}</td><td>${escapeHtml(t.assumption || '-')}</td>` +
            `<td align="right">${t.probability == null ? '-' : escapeHtml(String(t.probability)) + '%'}</td>` +
            `<td>${outcomeLabel[t.outcome] || escapeHtml(t.outcome)}</td>` +
            `<td>${escapeHtml([t.reason, t.note].filter(Boolean).join(': ') || '-')}</td></tr>`).join('') +
          '</table>';
      } else {
        html += '<div style="margin-top:10px;font-size:12px;color:var(--text-muted);">暂无已验证交易 (平仓后自动机械验证)</div>';
      }
      // 我的教训
      let lessons = null;
      try { lessons = await Core.Storage.kvGet(SHORT_LESSONS_KEY); }
      catch (e) { console.warn('[ShortTrader] 读 lessons 失败:', e); }
      const items = lessons && Array.isArray(lessons.items) ? lessons.items : [];
      if (items.length) {
        html += '<div style="margin-top:10px;font-size:12px;color:var(--text-muted);">【我的教训】</div>' +
          '<ul style="font-size:12px;margin:4px 0;padding-left:18px;">' +
          items.map(it => `<li>${escapeHtml(it.text)} <span style="color:var(--text-muted);font-size:11px;">(${escapeHtml(it.basedOn || '')})</span></li>`).join('') +
          '</ul>';
      }
      el.innerHTML = html;
    }
  };

  window.ShortTrader = ShortTrader;
})();
