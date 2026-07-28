/**
 * IntradayTrader - AI 短线操盘手: 盘中盯盘层
 *
 * 设计 (跟 T2-T3 条件单并存, 不替换):
 *   - 1 分钟轮询, 交易时段守卫 (复用 Core.Constants.TRADING_WINDOWS)
 *   - 只盯 sleeve='short' 的模拟持仓
 *   - 机械止盈/止损先行 (不调 LLM, 强平风控)
 *   - 加仓/减仓/持有观望 → 调本地 LLM 决策
 *   - LLM 输入: 现价/成本/止盈/止损/浮盈/Regime/日 K 末根/成绩单 (单 subset)
 *   - LLM 输出 JSON: { action: 'hold'|'trim'|'add'|'close', shares?, reason, confidence }
 *   - 调仓走 Paper.buy/sell (纪律引擎自动卡: blocks 命中 → 拒绝)
 *   - 冷却: 同代码 10 分钟内不重复决策 (防 LLM 反复横跳)
 *   - 日动作上限: 单只 1 天最多 4 次调仓
 *   - 决策日志: kv paper_intraday_log (上限 INTRADAY_LOG_LIMIT, 滚动截断)
 *
 * 不接实盘: 只操作 isPaper=true 持仓, 走 Paper.buy/sell 自动过滤
 * 不开新仓: 新仓仍走 T2-T3 条件单 (盘前计划 + 日 K 触发)
 */
(function() {
  'use strict';

  const TICK_MS = Core.Constants.INTRADAY_TICK_MS;
  const KLINE_BARS = Core.Constants.INTRADAY_KLINE_BARS;
  const MIN_HOLD_MINUTES = Core.Constants.INTRADAY_MIN_HOLD_MINUTES;
  const COOLDOWN_MS = Core.Constants.INTRADAY_COOLDOWN_MS;
  const LLM_TIMEOUT_MS = Core.Constants.INTRADAY_LLM_TIMEOUT_MS;
  const LOG_LIMIT = Core.Constants.INTRADAY_LOG_LIMIT;
  const MAX_DAILY_ACTIONS = Core.Constants.INTRADAY_MAX_DAILY_ACTIONS;
  const LOG_KEY = 'paper_intraday_log';
  const COOLDOWN_KEY = 'paper_intraday_cooldown';

  const IntradayTrader = {

    _timers: { tick: null },
    _setInterval: (fn, ms) => setInterval(fn, ms),
    _clearInterval: (t) => clearInterval(t),
    _running: false,
    _lastTickAt: 0,

    async init() {
      // 启动时立刻跑一轮 (不阻塞, 失败吞)
      this.runNow().catch(e => console.warn('[IntradayTrader] 启动 runNow 失败:', e));
      // 1 分钟轮询, 起定时器
      if (!this._timers.tick) {
        this._timers.tick = this._setInterval(
          () => this.runNow().catch(e => console.warn('[IntradayTrader] tick 失败:', e)),
          TICK_MS
        );
      }
      // P0: 启动时跑一轮机械验证 (异步, 不阻塞)
      this.verifyIntradayDecisions().then(r => {
        if (r && r.verified > 0) console.log(`[IntradayTrader] 启动 verify: 扫描${r.scanned} 验证${r.verified} 跳过${r.skipped}`);
      }).catch(e => console.warn('[IntradayTrader] 启动 verify 失败:', e));
    },

    stopPolling() {
      if (this._timers.tick) { this._clearInterval(this._timers.tick); this._timers.tick = null; }
    },

    /**
     * 跑一轮盘中检查 (公开给 paper.js 页面展示时也调一次, 不止靠定时器)
     * 流程: 交易时段守卫 → 拉 short 持仓 → 逐只: 拉实时价 → 机械止盈止损 → LLM 决策
     */
    async runNow() {
      if (this._running) return;  // 防重叠
      this._running = true;
      try {
        const t0 = Date.now();
        // 1. 交易时段守卫
        if (!this._isTradingTime(new Date())) return;
        // 2. 拉 short sleeve 持仓
        const positions = (await Paper.getPositions('short')) || [];
        if (positions.length === 0) return;
        // 3. 拉当日冷却 map
        const cooldownMap = (await Core.Storage.kvGet(COOLDOWN_KEY)) || {};
        const today = fmtDate(new Date());
        // 4. 逐只处理
        for (const p of positions) {
          try {
            await this._processPosition(p, cooldownMap, today);
          } catch (e) {
            console.warn(`[IntradayTrader] 处理 ${p.code} 失败:`, e);
          }
        }
        // 5. 写回冷却
        await Core.Storage.kvSet(COOLDOWN_KEY, cooldownMap);
        this._lastTickAt = t0;
      } finally {
        this._running = false;
      }
    },

    /**
     * 处理单只持仓: 拉价 → 机械止盈止损 → LLM 决策
     * @param {object} p 持仓行 (含 id/code/name/costPrice/shares/stopLoss/targetPrice/createdAt)
     * @param {object} cooldownMap { [code]: { lastAt, today, todayCount } } 冷却 + 日动作计数
     * @param {string} today YYYY-MM-DD
     */
    async _processPosition(p, cooldownMap, today) {
      // 1. 拉实时价
      let quote;
      try {
        quote = await Core.Data.getStockQuote(p.code);
      } catch (e) { return; }
      const price = parseFloat(quote && (quote['最新价'] || quote.price || quote.last || quote.close)) || 0;
      if (!(price > 0)) return;

      const cost = parseFloat(p.costPrice) || 0;
      const stop = parseFloat(p.stopLoss) || 0;
      const target = parseFloat(p.targetPrice) || 0;
      const plPct = cost > 0 ? (price - cost) / cost : 0;
      const shares = parseFloat(p.shares) || 0;

      // 2. 最小持有时间守卫: 不足 INTRADAY_MIN_HOLD_MINUTES 分钟不让 LLM 决策
      const heldMs = Date.now() - (p.createdAt || Date.now());
      if (heldMs < MIN_HOLD_MINUTES * 60 * 1000) return;

      // 3. 机械止盈止损: 优先级最高, 不调 LLM
      if (stop > 0 && price <= stop) {
        await this._executeAction(p, 'close', { price, shares, reason: `机械止损: 现价 ${price} ≤ 止损 ${stop} (浮亏 ${(plPct * 100).toFixed(2)}%)`, source: 'mechanical-stop', cooldownMap, today });
        return;
      }
      if (target > 0 && price >= target) {
        await this._executeAction(p, 'close', { price, shares, reason: `机械止盈: 现价 ${price} ≥ 目标 ${target} (浮盈 ${(plPct * 100).toFixed(2)}%)`, source: 'mechanical-target', cooldownMap, today });
        return;
      }

      // 4. 冷却 / 日动作上限检查
      const cd = cooldownMap[p.code] || {};
      if (cd.date !== today) { cd.date = today; cd.todayCount = 0; }
      if (cd.lastAt && (Date.now() - cd.lastAt) < COOLDOWN_MS) return;  // 冷却中
      if ((cd.todayCount || 0) >= MAX_DAILY_ACTIONS) return;  // 日动作上限

      // 5. LLM 决策: 加仓/减仓/持有观望
      const decision = await this._decideWithLlm(p, price, plPct, quote);
      if (!decision || !decision.action || decision.action === 'hold') return;

      // 6. 落地
      if (decision.action === 'close') {
        await this._executeAction(p, 'close', {
          price, shares,
          reason: `LLM 平仓: ${decision.reason || '(无原因)'}`,
          source: 'llm-close',
          confidence: decision.confidence,
          probability: decision.probability,
          cooldownMap, today
        });
      } else if (decision.action === 'trim' || decision.action === 'add') {
        const llmShares = Math.floor(parseFloat(decision.shares) || 0);
        // add 不足一手直接跳过 (buy 内部也卡); trim 不足一手交给 _executeAction
        // 内部判断 (1 手时改 close, > 1 手时按规则 trim)
        if (decision.action === 'add' && llmShares < Core.Constants.LOT_SIZE) return;
        if (llmShares <= 0) return;  // 0 或负数直接跳过
        const actShares = decision.action === 'trim' ? -llmShares : llmShares;
        await this._executeAction(p, decision.action === 'trim' ? 'trim' : 'add', {
          price, shares: actShares,  // 正=加仓, 负=减仓
          reason: `LLM ${decision.action === 'trim' ? '减仓' : '加仓'}: ${decision.reason || '(无原因)'}`,
          source: 'llm',
          confidence: decision.confidence,
          probability: decision.probability,
          cooldownMap, today
        });
      }
    },

    /**
     * 调本地 LLM 决策 (hold / trim / add / close)
     * 显式 local:true (盯盘场景, 优先本地)
     * @returns {Promise<{action, shares?, reason, confidence}|null>}
     */
    async _decideWithLlm(p, currentPrice, plPct, quote) {
      try {
        const cost = parseFloat(p.costPrice) || 0;
        const stop = parseFloat(p.stopLoss) || 0;
        const target = parseFloat(p.targetPrice) || 0;
        // 拉近 5 根日 K 补充趋势 (不查 5 分钟, 减少数据源压力)
        let klineText = 'K线数据不可用';
        try {
          const bars = (await Core.Data.getStockKLine(p.code, 'daily', '', '', '')) || [];
          const tail = bars.slice(-5);
          if (tail.length) {
            klineText = tail.map(b => `${b.日期} 开${b['开盘']} 收${b['收盘']} 最高${b['最高']} 最低${b['最低']} 涨跌${b['涨跌幅']}%`).join('\n');
          }
        } catch (e) { /* 拉不到不致命 */ }

        // H3 Regime 状态块 (失败保持 range 档 = 不缩放)
        let regimeText = '';
        try {
          if (Core.Regime && Core.Regime._formatRegimeBlock) {
            regimeText = Core.Regime._formatRegimeBlock();
          }
        } catch (e) { regimeText = ''; /* 兜底走老的纯标签 */ }
        if (!regimeText) {
          try {
            const rec = await Core.Regime.get();
            const gate = Core.Regime.gateMultipliers();
            regimeText = `Regime: ${rec.state} (${gate.label}, 仓位系数 ${gate.positionScale})`;
          } catch (e) { regimeText = 'Regime: 震荡市 (默认)'; }
        }

        // 盘中验证闭环学习文本 (校准偏差 + 成绩单)
        let learningText = '';
        try {
          learningText = await this._buildIntradayLearningPrompt();
        } catch (e) { /* */ }
        // P3 全系统学习池
        let poolText = '';
        try {
          const pt = await Core.LearningPool.format();
          if (pt) poolText = '\n\n【全系统学习池】' + pt;
        } catch (e) { /* 学习池可选 */ }
        // 短线教训借镜
        let shortLessons = '';
        try {
          shortLessons = await this._borrowShortTraderLessons();
        } catch (e) { /* */ }

        // P0-3: 显式市场状态前缀
        const regimePrefix = regimeText ? '【当前市场状态】' + regimeText.replace('Regime:', '').trim() + '\n\n' : '';
        // P0-4: 市场宽度信号
        let widthText = '';
        try {
          if (Core.MarketWidth && Core.MarketWidth.get) {
            const mw = await Core.MarketWidth.get();
            if (mw && mw.status !== 'unknown') {
              widthText = '【市场宽度】上涨: ' + mw.advance + ' 下跌: ' + mw.decline + ' | 涨跌比 ' + (mw.advancePct != null ? (mw.advancePct * 100).toFixed(0) + '%' : 'N/A') + '\n';
              // 极端宽度 → 强制 hold
              if (mw.advancePct != null) {
                if (mw.advancePct < 0.15) widthText += '⚠ 上涨不足 15%, 极端弱势, 不做任何买入动作\n';
                if (mw.advancePct > 0.85) widthText += '⚠ 上涨超过 85%, 极端强势, 不追高\n';
              }
            }
          }
        } catch (e) { /* 市场宽度可选 */ }

        const systemPrompt = this._buildSystemPrompt(learningText + poolText);
        const finalSystemPrompt = regimePrefix + systemPrompt;
        // Tier 2: 单只北向 (24h 缓存; 龙虎 T+1 盘中无意义, 不注)
        let northLine = '';
        try {
          const nf = await Core.Data.getNorthboundFlow(p.code).catch(() => null);
          if (nf) {
            const sign = nf.todayNet >= 0 ? '+' : '';
            const sign5 = nf.net5d >= 0 ? '+' : '';
            northLine = `\n【北向资金 T+1】今日${sign}${nf.todayNet}亿 | 5日${sign5}${nf.net5d}万股 | 占A股${nf.pct}%`;
          }
        } catch (e) { /* 盘中可选, 静默 */ }
        const userPrompt = `【持仓: ${p.code} ${p.name || ''}】
成本价: ${cost} | 现价: ${currentPrice} | 浮盈: ${(plPct * 100).toFixed(2)}%
止损价: ${stop} | 目标价: ${target}
股数: ${p.shares}
今天涨跌: ${quote['涨跌幅'] ?? quote.changePct ?? '?'}%
换手率: ${quote['换手率'] ?? '?'}%
${shortLessons ? `\n【短线操盘手最近教训】\n${shortLessons}` : ''}

【近 5 日 K】
${klineText}${northLine}

【市场状态】
${regimeText}

${widthText || '【市场宽度】数据不可用\n'}

【请决策】`;
        const raw = await Core.AI.callWithTimeout({
          systemPrompt: finalSystemPrompt,
          prompt: userPrompt,
          local: true,                  // 显式本地优先
          temperature: 0.3,             // 决策类用低温
          maxTokens: 400,               // 短决策, 小 token
          timeoutMs: LLM_TIMEOUT_MS,
          page: 'intraday-trader',
          purpose: 'intraday-decision'
        });
        if (!raw) return null;
        // 解析 JSON: Core.AI.parseJsonOutput 返 { ok, obj, errors, raw }
        const parsed = await Core.AI.parseJsonOutput(raw, 'intraday');
        if (!parsed || !parsed.ok || !parsed.obj) return null;
        const probability = parseFloat(parsed.obj.probability);
        return {
          action: String(parsed.obj.action || 'hold').toLowerCase(),
          shares: parseFloat(parsed.obj.shares) || 0,
          reason: String(parsed.obj.reason || '').slice(0, 200),
          confidence: String(parsed.obj.confidence || 'low'),
          probability: (probability >= 0 && probability <= 100) ? probability : null
        };
      } catch (e) {
        console.warn('[IntradayTrader] LLM 决策失败:', e);
        return null;
      }
    },

    _buildSystemPrompt(learningText = '') {
      let prompt = `你是短线操盘手, 正在做"盘中实时盯盘"决策。

【职责】
- 对**已持仓**的股票, 决定该不该: 加仓(add) / 减仓(trim) / 平仓(close) / 持有观望(hold)
- **不开新仓** (新仓由其他模块负责, 你只管持仓)
- 严格遵守"止损必跑"原则: 即便 LLM 想 hold, 现价已 ≤ 止损, 系统会机械平仓, 不用你操心

【决策输入】
- 持仓: 代码/成本/现价/浮盈浮亏/止盈止损
- 近 5 日 K 线
- 市场状态 (Regime)
- 你的历史成绩单 (基于机械 verify)
- 概率校准偏差 (system 自动注入, 帮助你把自评 probability 对准实际命中率)

【输出】严格 JSON, 字段:
{
  "action": "hold" | "trim" | "add" | "close",
  "shares": 100,           // trim/add 时填具体股数, hold/close 时可省
  "reason": "一句话理由",   // ≤ 50 字
  "confidence": "low"|"mid"|"high",
  "probability": 65        // 你的胜率自评 (0-100), 必填; 系统用此校准反馈, close/add 必须填
}

【约束】
- 决策保守: 没有明确信号就 hold
- 加仓/减仓股数必须是 100 的倍数
- 同一只持仓 10 分钟内只能决策 1 次, 1 天最多 4 次
- trim/add 占比建议: 单次不超过当前持仓 ±30%
- probability 必填, 不自评视为无效输出

【不要】
- 不要预测大盘走势 (那是 Regime 的事)
- 不要给目标价/止损价建议 (那是开仓时定的)
- 不要在浮亏 < 2% 时主动 close (给交易一点空间)`;
      if (learningText) {
        prompt += '\n\n' + learningText;
      }
      return prompt;
    },

    /**
     * 调仓落地: 写日志 + 更新冷却 + 调 Paper.buy/sell (纪律引擎自动卡)
     * shares 正数=加仓, 负数=减仓, close=全平
     */
    async _executeAction(p, action, { price, shares, reason, source, confidence, probability, cooldownMap, today }) {
      let result = null;
      try {
        if (action === 'close') {
          result = await Paper.sell(p.id, Math.abs(p.shares), { price, reason: 'intraday-' + (source || 'close') });
        } else if (action === 'trim') {
          // Bug #1 修复: LLM trim 超限 (如想 trim 150 但持仓 100) → 旧逻辑会全平 100 (违反 LLM 意图)
          // 新逻辑: trimShares = min(LLM shares, p.shares - LOT_SIZE) 保证至少留 1 手
          //   边界: p.shares = 1 手 (100) 且要 trim → 留 0 < 1 手 → 改走 close
          const maxKeepOneLot = p.shares - Core.Constants.LOT_SIZE;
          if (maxKeepOneLot < Core.Constants.LOT_SIZE) {
            // 持仓仅 1 手, 不能 trim (减完会剩 0) → 改 close
            result = await Paper.sell(p.id, p.shares, { price, reason: 'intraday-trim-to-close' });
          } else {
            const trimShares = Math.min(Math.abs(shares), maxKeepOneLot);
            if (trimShares >= Core.Constants.LOT_SIZE) {
              result = await Paper.sell(p.id, trimShares, { price, reason: 'intraday-trim' });
            }
          }
        } else if (action === 'add') {
          const addShares = Math.abs(shares);
          result = await Paper.buy(p.code, p.name, p.market, addShares, {
            sleeve: 'short', auto: true, price, tradeDate: today,
            assumption: '盘中加仓: ' + (reason || '').slice(0, 50),
            stopLoss: parseFloat(p.stopLoss) || 0,
            targetPrice: parseFloat(p.targetPrice) || 0
          });
        }
      } catch (e) {
        console.warn(`[IntradayTrader] 调仓执行失败 ${p.code} ${action}:`, e);
      }

      // 写决策日志 (无论成功失败, 留痕)
      const logEntry = {
        ts: Date.now(),
        date: today,
        code: p.code,
        name: p.name || '',
        action,
        shares: action === 'close' ? -p.shares : (action === 'trim' ? -Math.abs(shares) : Math.abs(shares)),
        price,
        reason: String(reason || '').slice(0, 200),
        source: source || 'unknown',
        confidence: confidence || null,
        probability: probability != null ? probability : null,
        ok: !!(result && result.id)
      };
      await this._appendLog(logEntry);

      // 更新冷却 + 日动作计数 (仅成功动作计入, 失败重试下次还有机会)
      if (logEntry.ok) {
        cooldownMap[p.code] = {
          date: today,
          lastAt: Date.now(),
          todayCount: ((cooldownMap[p.code] && cooldownMap[p.code].date === today) ? cooldownMap[p.code].todayCount : 0) + 1
        };
      }
    },

    async _appendLog(entry) {
      try {
        const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
        list.push(entry);
        await Core.Storage.kvSet(LOG_KEY, list.slice(-LOG_LIMIT));
      } catch (e) {
        console.warn('[IntradayTrader] 写日志失败:', e);
      }
    },

    /** 决策日志列表 (UI 用, 按时间倒序) */
    async listLog(limit) {
      const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
      const sorted = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return limit ? sorted.slice(0, limit) : sorted;
    },

    // ============== 纯函数 (测试用) ==============

    /**
     * 交易时段守卫: 周一~周五 09:30~11:30 / 13:00~15:00
     * 边界含端点, 与 alerts.js 同款判定
     */
    _isTradingTime(now) {
      if (!now) return false;
      const d = (now instanceof Date) ? now : new Date(now);
      const day = d.getDay();
      if (day === 0 || day === 6) return false;  // 周日/周六
      const mins = d.getHours() * 60 + d.getMinutes();
      const windows = Core.Constants.TRADING_WINDOWS;
      for (const [start, end] of windows) {
        if (mins >= start && mins <= end) return true;
      }
      return false;
    },

    /**
     * 冷却判定 (纯函数)
     * @returns {boolean} true=可决策, false=冷却中
     */
    _isCooldownOver(cd, now = Date.now()) {
      if (!cd || !cd.lastAt) return true;
      return (now - cd.lastAt) >= COOLDOWN_MS;
    },

    /**
     * 日动作上限判定 (纯函数)
     * @returns {boolean} true=可执行, false=已达上限
     */
    _isUnderDailyLimit(cd, today) {
      if (!cd || cd.date !== today) return true;
      return (cd.todayCount || 0) < MAX_DAILY_ACTIONS;
    },

    /**
     * 机械止盈止损判定 (纯函数, 不调 LLM)
     * @returns {'stop'|'target'|null}
     */
    _mechanicalExit(price, stop, target) {
      if (stop > 0 && price <= stop) return 'stop';
      if (target > 0 && price >= target) return 'target';
      return null;
    },

    /**
     * 最小持有时间判定 (纯函数)
     * @returns {boolean} true=已过最短持有期
     */
    _isMinHoldPassed(createdAt, now = Date.now()) {
      if (!createdAt) return true;
      return (now - createdAt) >= MIN_HOLD_MINUTES * 60 * 1000;
    },

    /**
     * 解析 LLM 输出 (纯函数, 测试可注入字符串)
     * 复用 Core.AI.parseJsonOutput 的 Phase T 模式 (intraday 模式)
     */
    _parseDecision(raw) {
      if (typeof raw !== 'string') return null;
      try {
        // 简单 JSON 抽取 (与 Core.AI.parseJsonOutput 同款: 找首个 { 最后一个 })
        const i = raw.indexOf('{');
        const j = raw.lastIndexOf('}');
        if (i < 0 || j < 0 || j <= i) return null;
        const obj = JSON.parse(raw.slice(i, j + 1));
        const action = String(obj.action || 'hold').toLowerCase();
        if (!['hold', 'trim', 'add', 'close'].includes(action)) return null;
        return {
          action,
          shares: parseFloat(obj.shares) || 0,
          reason: String(obj.reason || '').slice(0, 200),
          confidence: String(obj.confidence || 'low'),
          probability: (() => { const p = parseFloat(obj.probability); return (p >= 0 && p <= 100) ? p : null; })()
        };
      } catch (e) { return null; }
    },

    // ============== 机械验证闭环 (P0) ==============
    // 复用 ShortTrader T4 模式: 平仓后拉 K 线 → 纯函数判定 → 校准分桶 → 注入下次 prompt

    /**
     * 验证已平仓决策 (close / trim), 拉后续 K 线机械判定
     * 在 startup / 手工触发时跑, 异步不阻塞
     * @returns {Promise<{scanned: number, verified: number, skipped: number}>}
     */
    async verifyIntradayDecisions(opts = {}) {
      const fetcher = opts.fetcher || (Core.Data && Core.Data.getStockKLine);
      if (typeof fetcher !== 'function') {
        console.warn('[IntradayTrader] verifyIntradayDecisions 缺 fetcher, 跳过');
        return { scanned: 0, verified: 0, skipped: 0 };
      }
      const now = opts.now || new Date();
      const todayStr = (d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)(now);
      const lookbackDays = opts.lookbackDays || 30;
      const cutoffTs = now.getTime() - lookbackDays * 24 * 3600 * 1000;
      const delayBars = Core.Constants.INTRADAY_VERIFY_DELAY_BARS;
      const lookaheadBars = Core.Constants.INTRADAY_VERIFY_LOOKAHEAD_BARS;
      let scanned = 0, verified = 0, skipped = 0;
      try {
        const log = (await Core.Storage.kvGet(LOG_KEY)) || [];
        // 筛选: 距今天 ≥ delayBars 日 + 未验证 + 有 probability 的 close/trim
        const targets = log.filter(e => {
          if (!e || !e.code) return false;
          if (e.date >= todayStr) return false;
          if (e.ts < cutoffTs) return false;
          if (!e.probability || e.probability == null) return false;
          if (e.verified) return false;
          return e.action === 'close' || e.action === 'trim';
        });

        for (const e of targets) {
          scanned++;
          try {
            const kline = await fetcher(e.code, 'daily', undefined, undefined, '');
            if (!Array.isArray(kline) || kline.length < delayBars + 1) { skipped++; continue; }
            const dates = kline.map(b => String(b.日期 || b.date || '').slice(0, 10));
            const closePrices = kline.map(b => parseFloat(b.收盘 || b.close)).filter(c => c > 0);
            if (closePrices.length < delayBars + 1) { skipped++; continue; }
            const decIdx = dates.findIndex(d => d > e.date);
            if (decIdx < 0 || decIdx >= closePrices.length - delayBars) { skipped++; continue; }
            const startIdx = decIdx + delayBars;
            const windowCloses = closePrices.slice(startIdx, startIdx + lookaheadBars);
            if (windowCloses.length < 1) { skipped++; continue; }
            const windowHighs = kline.slice(startIdx, startIdx + lookaheadBars)
              .map(b => parseFloat(b.最高 || b.high)).filter(h => h > 0);
            const windowLows = kline.slice(startIdx, startIdx + lookaheadBars)
              .map(b => parseFloat(b.最低 || b.low)).filter(l => l > 0);

            const decisionPrice = parseFloat(e.price) || 0;
            if (!(decisionPrice > 0)) { skipped++; continue; }
            const exitPrice = decisionPrice;

            const outcome = this._judgeIntradayDecision({
              action: e.action,
              exitPrice,
              windowCloses,
              windowHighs,
              windowLows
            });
            if (!outcome) { skipped++; continue; }

            await this._patchLogOutcome(e.ts, e.code, {
              verified: true,
              verifyOutcome: outcome.outcome,
              verifyReason: outcome.reason
            });
            verified++;
          } catch (err) {
            console.warn(`[IntradayTrader] verify ${e.code} ${e.date} 失败:`, err.message || err);
            skipped++;
          }
        }
        return { scanned, verified, skipped };
      } catch (err) {
        console.warn('[IntradayTrader] verifyIntradayDecisions 总流程失败:', err);
        return { scanned, verified, skipped };
      }
    },

    /**
     * 判定单条盘中决策是否正确 (纯函数, 决策表)
     * close/trim = 出场动作, 判断"是否卖对了"
     * @returns {{outcome: 'correct'|'wrong'|'partial', reason: string}|null}
     */
    _judgeIntradayDecision({ action, exitPrice, windowCloses, windowHighs, windowLows }) {
      if (!exitPrice || exitPrice <= 0 || !Array.isArray(windowCloses) || windowCloses.length < 1) return null;
      if (!['close', 'trim'].includes(action)) return null;
      const lastClose = windowCloses[windowCloses.length - 1];
      const maxHigh = windowHighs.length ? Math.max(...windowHighs) : lastClose;
      const minLow = windowLows.length ? Math.min(...windowLows) : lastClose;
      const finalChg = (lastClose - exitPrice) / exitPrice;
      const maxDown = (minLow - exitPrice) / exitPrice;
      const maxUp = (maxHigh - exitPrice) / exitPrice;

      // 出场 = 卖出, correct=卖后继续跌, wrong=卖后大幅反弹
      if (finalChg <= -0.05) return { outcome: 'correct', reason: '卖得对: 出场后继续跌超 5%' };
      if (maxDown <= -0.08) return { outcome: 'correct', reason: '卖得对: 出场后最低跌超 8%' };
      if (maxUp >= 0.08)   return { outcome: 'wrong', reason: '卖早了: 出场后反弹超 8%' };
      if (finalChg >= 0.05) return { outcome: 'wrong', reason: '卖错了: 出场后续涨超 5%' };
      if (finalChg >= 0.02) return { outcome: 'partial', reason: '部分错: 出场后小幅涨 2-5%' };
      if (finalChg >= -0.02)return { outcome: 'partial', reason: '基本平: 出场后横盘 ±2%' };
      return { outcome: 'correct', reason: '卖得对: 出场后下跌' };
    },

    /** 写回验证结果到日志条目 */
    async _patchLogOutcome(ts, code, patch) {
      try {
        const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
        let changed = false;
        for (const e of list) {
          if (e.ts === ts && e.code === code && !e.verified) {
            Object.assign(e, patch);
            changed = true;
            break;
          }
        }
        if (changed) await Core.Storage.kvSet(LOG_KEY, list);
      } catch (err) {
        console.warn('[IntradayTrader] patchLogOutcome 失败:', err);
      }
    },

    /**
     * 概率校准分桶 (复用 ShortTrader T4 算法)
     */
    _calibrationBuckets(log) {
      const edges = Core.Constants.CALIBRATION_BUCKET_EDGES;
      const rows = (Array.isArray(log) ? log : []).filter(e => e && e.verified && e.probability != null && e.verifyOutcome);
      const buckets = [];
      for (let i = 0; i < edges.length - 1; i++) {
        const lo = edges[i];
        const hi = edges[i + 1];
        const bucket = rows.filter(e => e.probability >= lo && e.probability < hi);
        const n = bucket.length;
        const correct = bucket.filter(e => e.verifyOutcome === 'correct').length;
        const partial = bucket.filter(e => e.verifyOutcome === 'partial').length;
        const predMean = n ? bucket.reduce((s, e) => s + e.probability, 0) / n : 0;
        const hitRate = n ? (correct + partial * 0.5) / n : 0;
        buckets.push({ range: `${lo}-${hi-1}%`, lo, hi, n, correct, partial, predMean: +predMean.toFixed(1), hitRate: +hitRate.toFixed(2) });
      }
      const total = rows.length;
      const totalCorrect = rows.filter(e => e.verifyOutcome === 'correct').length;
      const totalPartial = rows.filter(e => e.verifyOutcome === 'partial').length;
      const hitRate = total ? (totalCorrect + totalPartial * 0.5) / total : 0;
      return { hitRate: +hitRate.toFixed(2), total, buckets };
    },

    /**
     * Brier score (概率校准质量)
     */
    _brierScore(log) {
      const rows = (Array.isArray(log) ? log : []).filter(e => e && e.verified && e.probability != null && e.verifyOutcome);
      if (!rows.length) return null;
      const scoreOf = (o) => o === 'correct' ? 1 : (o === 'partial' ? 0.5 : 0);
      const sum = rows.reduce((s, e) => {
        const diff = e.probability / 100 - scoreOf(e.verifyOutcome);
        return s + diff * diff;
      }, 0);
      return +(sum / rows.length).toFixed(4);
    },

    /**
     * 构建学习 prompt 注入文本 (校准偏差 + 成绩单)
     */
    async _buildIntradayLearningPrompt() {
      try {
        const log = (await Core.Storage.kvGet(LOG_KEY)) || [];
        const minSamples = Core.Constants.INTRADAY_VERIFY_MIN_SAMPLES;
        const verified = log.filter(e => e && e.verified && e.verifyOutcome);
        if (verified.length < minSamples) return null;
        const cb = this._calibrationBuckets(log);
        const brier = this._brierScore(log);
        let text = '';
        if (Core.Calibration && Core.Calibration._formatCalibrationPrompt) {
          const calBlock = Core.Calibration._formatCalibrationPrompt(cb.buckets, minSamples);
          if (calBlock) text += '\n【你的概率校准偏差 (盘中决策)】\n' + calBlock;
        }
        text += `\n【你的盘中决策成绩单】\n`
          + `总验证: ${cb.total} 笔 | 综合命中率: ${(cb.hitRate * 100).toFixed(0)}%`
          + (brier != null ? ` | Brier: ${brier}` : '');
        for (const b of cb.buckets) {
          if (b.n === 0) continue;
          const bias = b.predMean - b.hitRate * 100;
          const tag = Math.abs(bias) >= 10 ? (bias > 0 ? ' ⚠ 系统性高估' : ' ⚠ 系统性低估') : '';
          text += `\n  ${b.range}: ${b.n}笔 命中${b.hitRate} 均自评${b.predMean}%${tag}`;
        }
        return text;
      } catch (e) {
        console.warn('[IntradayTrader] buildIntradayLearningPrompt 失败:', e);
        return null;
      }
    },

    /**
     * 从 ShortTrader 学习环借教训 (跨模块)
     */
    async _borrowShortTraderLessons() {
      try {
        if (!window.ShortTrader || typeof ShortTrader._distillLessons !== 'function') return null;
        const lessons = await Core.Storage.kvGet('short_trader_lessons');
        if (!lessons || !Array.isArray(lessons.items) || lessons.items.length === 0) return null;
        return lessons.items.slice(0, 3).map(l => l.text || '').filter(Boolean).join('；');
      } catch (e) { return null; }
    }
  };

  window.IntradayTrader = IntradayTrader;
})();
