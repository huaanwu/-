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

        // Regime 状态 (失败保持 range 档 = 不缩放)
        let regimeText = 'Regime: 震荡市 (默认)';
        try {
          const rec = await Core.Regime.get();
          const gate = Core.Regime.gateMultipliers();
          regimeText = `Regime: ${rec.state} (${gate.label}, 仓位系数 ${gate.positionScale})`;
        } catch (e) { /* */ }

        // 成绩单 (样本不足返空)
        let trackText = '';
        try {
          if (window.ShortTrader && ShortTrader._formatTrackRecord) {
            const rec = await ShortTrader._buildTrackRecord();
            if (rec) trackText = await ShortTrader._formatTrackRecord(rec);
          }
        } catch (e) { /* */ }

        const systemPrompt = this._buildSystemPrompt();
        const userPrompt = `【持仓: ${p.code} ${p.name || ''}】
成本价: ${cost} | 现价: ${currentPrice} | 浮盈: ${(plPct * 100).toFixed(2)}%
止损价: ${stop} | 目标价: ${target}
股数: ${p.shares}
今天涨跌: ${quote['涨跌幅'] ?? quote.changePct ?? '?'}%
换手率: ${quote['换手率'] ?? '?'}%

【近 5 日 K】
${klineText}

【市场状态】
${regimeText}

【你的历史成绩单 (短线)】
${trackText || '(样本不足, 不显示)'}

【请决策】`;
        const raw = await Core.AI.callWithTimeout({
          systemPrompt,
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
        return {
          action: String(parsed.obj.action || 'hold').toLowerCase(),
          shares: parseFloat(parsed.obj.shares) || 0,
          reason: String(parsed.obj.reason || '').slice(0, 200),
          confidence: String(parsed.obj.confidence || 'low')
        };
      } catch (e) {
        console.warn('[IntradayTrader] LLM 决策失败:', e);
        return null;
      }
    },

    _buildSystemPrompt() {
      // TODO H1 凯利 接入: 当前 LLM schema 只返 confidence (low/mid/high 类别),
      // 没有 numeric probability 也没有 triggerPrice/stopLoss/targetPrice —
      // 凯利公式 (Core.PositionSizing._kellyFraction) 需要 4 个数值字段。
      // 等以后 schema 扩展 (LLM 报 probability 0-100 + 3 件套价格), 在这里
      // 拼一段 schema 描述, 在 _aiDecide 出口前调 _kellyFraction 重算
      // 决策仓位 (shares 或 trim% 而非 shares 数)。
      //
      // TODO H2 校准 接入: 当前 intraday-trader 没有出 (predict → actual) 机械
      // 验证数据 (不像 short-trader T4 学习环有完整闭环), 校准注入会误导 LLM。
      // 等以后 settleIntraday(hold-trader 走 paper_cond_orders 验证) 落实后,
      // 在这里拼 _calibrationBuckets → Core.Calibration._formatCalibrationPrompt
      // 段, 复用 short-trader 的 _buildLearningPromptText 模式。
      return `你是短线操盘手, 正在做"盘中实时盯盘"决策。

【职责】
- 对**已持仓**的股票, 决定该不该: 加仓(add) / 减仓(trim) / 平仓(close) / 持有观望(hold)
- **不开新仓** (新仓由其他模块负责, 你只管持仓)
- 严格遵守"止损必跑"原则: 即便 LLM 想 hold, 现价已 ≤ 止损, 系统会机械平仓, 不用你操心

【决策输入】
- 持仓: 代码/成本/现价/浮盈浮亏/止盈止损
- 近 5 日 K 线
- 市场状态 (Regime)
- 你的历史成绩单 (基于机械 verify)

【输出】严格 JSON, 字段:
{
  "action": "hold" | "trim" | "add" | "close",
  "shares": 100,           // trim/add 时填具体股数, hold/close 时可省
  "reason": "一句话理由",   // ≤ 50 字
  "confidence": "low"|"mid"|"high"
}

【约束】
- 决策保守: 没有明确信号就 hold
- 加仓/减仓股数必须是 100 的倍数
- 同一只持仓 10 分钟内只能决策 1 次, 1 天最多 4 次
- trim/add 占比建议: 单次不超过当前持仓 ±30%

【不要】
- 不要预测大盘走势 (那是 Regime 的事)
- 不要给目标价/止损价建议 (那是开仓时定的)
- 不要在浮亏 < 2% 时主动 close (给交易一点空间)`;
    },

    /**
     * 调仓落地: 写日志 + 更新冷却 + 调 Paper.buy/sell (纪律引擎自动卡)
     * shares 正数=加仓, 负数=减仓, close=全平
     */
    async _executeAction(p, action, { price, shares, reason, source, confidence, cooldownMap, today }) {
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
          confidence: String(obj.confidence || 'low')
        };
      } catch (e) { return null; }
    }
  };

  window.IntradayTrader = IntradayTrader;
})();
