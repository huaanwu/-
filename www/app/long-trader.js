/**
 * LongTrader - AI 长线操盘手 (Phase L)
 * 跟 T2-T5 短线操盘手形成一快一慢双层, 长期 sleeve 自动选股 + 自动成交
 *
 * 设计:
 *   - 30 分钟轮询, 检查触发条件: 周一 + 距上次 ≥ RERUN_DAYS 天 + long sleeve 现金 ≥ MIN_CASH
 *   - 拉全市场行情 → 取涨跌幅前 30 → LLM 解读挑 TOP_N picks
 *   - 每只调 Paper.autoTradeFromPick({ code, name, sleeve: 'long' })
 *     → 纪律引擎自动卡 (单票上限/月度回撤/重复错误) → 写 transactions (auto:true)
 *   - 决策日志: kv paper_long_trader_log (上限 LONG_TRADER_LOG_LIMIT, 滚动截断)
 *   - 最后运行: kv paper_long_trader_last { date, ts } 防重复
 *
 * 不接实盘: 只操作 isPaper=true && sleeve==='long' 模拟盘
 * 跟 T2-T3 短线 (sleeve='short') 物理隔离, 互不影响
 */
(function() {
  'use strict';

  const CHECK_MS = Core.Constants.LONG_TRADER_CHECK_MS;
  const TOP_N = Core.Constants.LONG_TRADER_TOP_N;
  const HARD_TOP = Core.Constants.LONG_TRADER_HARD_SCREEN_TOP;
  const RERUN_DAYS = Core.Constants.LONG_TRADER_RERUN_DAYS;
  const MIN_CASH = Core.Constants.LONG_TRADER_MIN_CASH;
  const LOG_LIMIT = Core.Constants.LONG_TRADER_LOG_LIMIT;
  const LOG_KEY = 'paper_long_trader_log';
  const LAST_RUN_KEY = 'paper_long_trader_last';

  const LongTrader = {

    _timers: { check: null },
    _setInterval: (fn, ms) => setInterval(fn, ms),
    _clearInterval: (t) => clearInterval(t),
    _running: false,

    async init() {
      // 启动时跑一轮 (不阻塞, 失败吞)
      this.runNow().catch(e => console.warn('[LongTrader] 启动失败:', e));
      // 30 分钟轮询
      if (!this._timers.check) {
        this._timers.check = this._setInterval(
          () => this.runNow().catch(e => console.warn('[LongTrader] 轮询失败:', e)),
          CHECK_MS
        );
      }
      // Phase L1: 启动时跑一轮 verify (不阻塞, 失败吞)
      this.verifyLongTrades().catch(e => console.warn('[LongTrader] 启动 verify 失败:', e));
    },

    stopPolling() {
      if (this._timers.check) { this._clearInterval(this._timers.check); this._timers.check = null; }
    },

    /**
     * 跑一轮长线选股 (公开给 app.js init / 手动调用)
     * 流程: 检查触发 → 拉行情 → 硬筛 top 30 → LLM 挑 TOP_N → 调 Paper.autoTradeFromPick
     * 整轮异常吞, 失败不影响下次
     */
    async runNow(opts = {}) {
      if (this._running) return;
      this._running = true;
      try {
        const now = opts.now || new Date();
        // 1. 触发条件: 周一 + 距上次 ≥ RERUN_DAYS 天
        const lastRun = (await Core.Storage.kvGet(LAST_RUN_KEY)) || null;
        if (!this._shouldRun(now, lastRun && lastRun.ts)) return;
        // 2. long sleeve 现金下限
        const acc = await Paper._getAccountRaw('long');
        if ((acc.cash || 0) < MIN_CASH) {
          console.log(`[LongTrader] long sleeve 现金 ${acc.cash} < ${MIN_CASH}, 跳过`);
          return;
        }
        // Bug #1 修复 (跑空防护): 跑前用 _planAutoTrade 探测 1 手 30 元股能否成交
        // 比硬定 MIN_CASH 数字更鲁棒 — 30 元是中盘股典型价, 1 手 3000 块 + 仓位 10% 要求 ≥ 3 万 cash
        // 现金不够买 1 手 → 跳过, 避免 LLM 推 N 只全部 autoTradeFromPick 返 null
        const testShares = Paper._planAutoTrade(acc.cash, acc.positionPct || 0.10, 30);
        if (!testShares || testShares < Core.Constants.LOT_SIZE) {
          console.log(`[LongTrader] 现金 ${acc.cash} × ${acc.positionPct || 0.10} 买不起 1 手 30 元股, 跳过`);
          return;
        }
        // Bug #2 修复 (Regime gate): 熊市 → 跳过, 防买在反弹半山腰
        try {
          const rec = await Core.Regime.get();
          const gate = Core.Regime.gateMultipliers();
          if (rec && rec.state === 'bear' && gate && gate.positionScale <= 0.5) {
            console.log(`[LongTrader] Regime bear + positionScale ${gate.positionScale} < 0.5, 跳过`);
            return;
          }
        } catch (e) { console.warn('[LongTrader] Regime 检查跳过:', e); }
        // 3. 拉全市场行情
        let all;
        try {
          all = await Core.Data.getStockSpot();
        } catch (e) {
          console.warn('[LongTrader] 拉全市场行情失败:', e);
          return;
        }
        if (!Array.isArray(all) || all.length === 0) return;
        // Bug #3 修复 (排除已持仓): 防反复追涨已持仓 (靠纪律引擎挡单票上限是兜底,
        // 但用户疑惑"为啥又推同一只" — 直接从候选池里去掉)
        let heldCodes = new Set();
        try {
          const held = (await Paper._getPaperHoldings('long')) || [];
          heldCodes = new Set(held.map(h => h.code).filter(Boolean));
        } catch (e) { /* */ }
        // 4. 简单硬筛: 涨跌幅 > 0 + 不在已持仓, 取前 30 (看涨池)
        const sorted = all
          .filter(s => s && s.代码 && s.名称 && parseFloat(s.涨跌幅) > 0 && !heldCodes.has(s.代码))
          .sort((a, b) => parseFloat(b.涨跌幅) - parseFloat(a.涨跌幅))
          .slice(0, HARD_TOP);
        if (sorted.length === 0) return;
        // 5. LLM 挑 TOP_N
        const picks = await this._llmPickTop(sorted, TOP_N);
        if (!picks || picks.length === 0) return;
        // 6. 自动成交到 long sleeve (纪律引擎自动卡)
        const cashBefore = acc.cash;
        const results = [];
        for (const p of picks) {
          try {
            const h = await Paper.autoTradeFromPick({ code: p.code, name: p.name, sleeve: 'long' });
            results.push({ code: p.code, name: p.name, ok: !!h, reason: p.reason, costPrice: h && h.costPrice, shares: h && h.shares });
            // Phase L1: 写 journal 行 (verify 后续归因用)
            if (h) await this._writeLongJournal({ ...p, costPrice: h.costPrice, shares: h.shares });
          } catch (e) {
            console.warn(`[LongTrader] autoTradeFromPick 失败 ${p.code}:`, e);
            results.push({ code: p.code, name: p.name, ok: false, reason: p.reason, error: String(e.message || e) });
          }
        }
        // 7. 写决策日志
        const accAfter = await Paper._getAccountRaw('long');
        await this._appendLog({
          ts: Date.now(),
          date: fmtDate(now),
          trigger: opts.manual ? 'manual' : 'scheduled',
          picks: results,
          cashBefore,
          cashAfter: accAfter.cash,
          cashUsed: +(cashBefore - accAfter.cash).toFixed(2)
        });
        // 8. 记录最后运行
        await Core.Storage.kvSet(LAST_RUN_KEY, { date: fmtDate(now), ts: Date.now() });
      } catch (e) {
        console.warn('[LongTrader] 跑一轮失败:', e);
      } finally {
        this._running = false;
      }
    },

    /**
     * 触发判定: 周一 + 距上次 ≥ RERUN_DAYS 天 (纯函数可测)
     * @param {Date} now 当前时间
     * @param {number} lastRunTs 上次运行时间戳 (ms), 无则视为从未跑过
     */
    _shouldRun(now, lastRunTs) {
      if (!now) return false;
      const day = now.getDay();
      if (day !== 1) return false;  // 周一 (周日=0, 周一=1)
      if (lastRunTs) {
        const daysSince = (now.getTime() - lastRunTs) / (24 * 60 * 60 * 1000);
        if (daysSince < RERUN_DAYS) return false;
      }
      return true;
    },

    /**
     * LLM 解读: 从硬筛池挑 TOP_N
     * @returns {Promise<Array<{code, name, reason}>|null>}
     */
    async _llmPickTop(stocks, topN) {
      try {
        const list = stocks.map((s, i) => {
          const code = s.代码;
          const name = s.名称;
          const chg = parseFloat(s.涨跌幅).toFixed(2);
          const turn = parseFloat(s.换手率 || 0).toFixed(2);
          const mcap = parseFloat(s.总市值 || 0);
          const mcapStr = isNaN(mcap) || mcap === 0 ? '?' : (mcap / 1e8).toFixed(1) + '亿';
          return `[${i}] ${code} ${name} | 涨跌幅=${chg}% | 换手=${turn}% | 市值=${mcapStr}`;
        }).join('\n');

        // H3 大盘状态机 (commit 6): 仅一行提示, 不影响 schema (只返 {code, name, reason})
        // 长线 sleeve 也没自动仓位系数 (acc.positionPct 是固定的), 只供 LLM 在趋势/下跌市收紧
        let regimeLine = '【大盘状态】默认震荡市';
        try {
          if (window.Core && Core.Regime && Core.Regime.gateMultipliers) {
            const g = Core.Regime.gateMultipliers();
            regimeLine = `【大盘状态】${g.label} (${g.state})${g.stale ? ' ⚠ 数据源失灵' : ''}, 仓位系数 ×${g.positionScale}, ${g.state === 'bear' ? '仅胜率显著才加仓' : (g.state === 'bull' ? '趋势市正常加仓' : '震荡市严控新仓')}`;
          }
        } catch (e) { console.warn('[LongTrader] regime 取值失败:', e); }

        // P3 全系统学习池
        let poolText = '';
        try {
          poolText = (await Core.LearningPool.format()) || '';
        } catch (e) { console.warn('[LongTrader] 学习池渲染失败:', e); }

        const systemPrompt = '你是 A 股长线选股助手, 帮用户从硬筛池里挑 ' + topN + ' 只作为本周模拟盘长线 sleeve 的买入标的。' +
          '\n- 选有真实上涨逻辑的 (题材/业绩/资金/技术突破)' +
          '\n- 优先选市值 ≥ 50 亿的 (流动性好)' +
          '\n- 优先选当日涨幅在 3-9% 区间的 (避免追高/避冷门)' +
          '\n- 排除 ST/退市风险股' +
          '\n' + regimeLine +
          (poolText ? '\n- 【全系统学习池】' + poolText.replace(/\n/g, ' ').slice(0, 200) : '') +
          '\n- 输出严格 JSON, 不要其他文字';

        const userPrompt = `硬筛池 (今日涨幅前 ${stocks.length}):

	${list}

	输出 JSON:
	{
	  "picks": [
	    { "code": "000001", "name": "平安银行", "reason": "一句话理由" }
	  ]
	}
	只输出 picks 数组 (${topN} 只以内), 不要其他字段。`;

        const raw = await Core.AI.callWithTimeout({
          systemPrompt,
          prompt: userPrompt,
          temperature: 0.5,
          maxTokens: 800,
          timeoutMs: 60000,
          page: 'long-trader',
          purpose: 'long-trader-pick'
        });
        if (!raw) return null;
        const parsed = await Core.AI.parseJsonOutput(raw, 'long-trader');
        if (!parsed || !parsed.ok || !parsed.obj) return null;
        const arr = (parsed.obj.picks || []);
        return arr.slice(0, topN).map(p => ({
          code: String(p.code || '').padStart(6, '0'),
          name: String(p.name || ''),
          reason: String(p.reason || '').slice(0, 200)
        })).filter(p => /^\d{6}$/.test(p.code));
      } catch (e) {
        console.warn('[LongTrader] LLM pick 失败:', e);
        return null;
      }
    },

    async _appendLog(entry) {
      try {
        const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
        list.push(entry);
        await Core.Storage.kvSet(LOG_KEY, list.slice(-LOG_LIMIT));
      } catch (e) {
        console.warn('[LongTrader] 写日志失败:', e);
      }
    },

    /** 决策日志列表 (UI 用, 按时间倒序) */
    async listLog(limit) {
      const list = (await Core.Storage.kvGet(LOG_KEY)) || [];
      const sorted = list.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
      return limit ? sorted.slice(0, limit) : sorted;
    },

    // ========== Phase L1: 长线业绩归因 (journal + 机械 verify + 8 类归因) ==========

    /**
     * 写长线建仓 journal (sleeve='long', auto=true), 跟 T3 _writeCondJournal 模式一致
     * @param {{code, name, reason, costPrice, shares, entryDate}} pick - autoTradeFromPick 返的持仓行
     */
    async _writeLongJournal(pick) {
      if (!pick || !pick.code) return null;
      try {
        const today = new Date().toISOString().slice(0, 10);
        const cost = parseFloat(pick.costPrice || pick.price || 0);
        const shares = parseInt(pick.shares || 0, 10);
        const reason = String(pick.reason || 'AI 长线选股').slice(0, 200);
        const content = '# AI 长线自动建仓\n\n' +
          '- 代码: ' + pick.code + '\n' +
          '- 名称: ' + (pick.name || '') + '\n' +
          '- 成本价: ¥' + cost.toFixed(2) + '\n' +
          '- 股数: ' + shares + ' (' + (shares / 100) + '手)\n' +
          '- 选股理由: ' + reason + '\n' +
          '- 成交日期: ' + today + '\n\n' +
          '> 本条由 LongTrader 自动写入, 后续 verify 用于归因';
        const row = {
          id: 'lt-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
          date: today,
          title: '📈 长线建仓: ' + pick.code + ' ' + (pick.name || ''),
          content,
          code: pick.code,
          assumption: reason,
          emotion: 'neutral',
          verify: 'pending',
          verifyOutcome: null,
          sleeve: 'long',
          auto: true,
          costPrice: cost,
          shares,
          entryDate: today,
          createdAt: Date.now()
        };
        await Core.Storage.add('journals', row);
        return row;
      } catch (e) {
        console.warn('[LongTrader] 写 journal 失败:', e);
        return null;
      }
    },

    /**
     * 长线归因纯函数 (复用 VERIFY_FAILURE_REASONS 8 类, 长线简化为 3 类)
     * @param {number} pnlPct 浮盈浮亏 (小数, 0.05=5%)
     * @returns {{outcome: 'correct'|'wrong'|'partial', reason: string}}
     */
    _judgeLongOutcome(pnlPct) {
      const thr = Core.Constants.LONG_VERIFY_THRESHOLD_PCT;
      const badThr = Core.Constants.LONG_VERIFY_THRESHOLD_BAD_PCT;
      const goodThr = Core.Constants.LONG_VERIFY_TIMING_GOOD_PCT;
      if (!isFinite(pnlPct)) return { outcome: 'partial', reason: '数据不足' };
      if (pnlPct >= goodThr) return { outcome: 'correct', reason: 'timingGood' };
      if (pnlPct >= thr) return { outcome: 'correct', reason: '选股对' };
      if (pnlPct <= -badThr) return { outcome: 'wrong', reason: '假设错误' };
      if (pnlPct <= -thr) return { outcome: 'wrong', reason: '选股错' };
      return { outcome: 'partial', reason: '时机过早' };
    },

    /**
     * 长线 verify 主流程: 拉 journal 表, long+auto+无 verify 的, 拉后续 K 线判定 outcome
     */
    async verifyLongTrades(opts = {}) {
      const daysBack = parseInt(opts.daysBack) || 90;
      const now = opts.now || new Date();
      const fetcher = opts.fetcher || (Core.Data && Core.Data.getStockKLine);
      if (typeof fetcher !== 'function') {
        console.warn('[LongTrader] verifyLongTrades 缺 fetcher, 跳过');
        return { scanned: 0, verified: 0, skipped: 0 };
      }
      const todayStr = (function(d) {
        return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
      })(now);
      let scanned = 0, verified = 0, skipped = 0;
      try {
        const all = (await Core.Storage.all('journals')) || [];
        const cutoff = (function(d) {
          const dt = new Date(d.getTime() - daysBack * 24 * 3600 * 1000);
          return dt.getFullYear() + '-' + String(dt.getMonth()+1).padStart(2,'0') + '-' + String(dt.getDate()).padStart(2,'0');
        })(now);
        const targets = all.filter(function(j) {
          return j && (j.sleeve || '') === 'long' && j.auto === true
            && j.code && j.entryDate && j.entryDate >= cutoff && j.entryDate < todayStr
            && (!j.verifyOutcome || j.verifyOutcome === null);
        });
        for (const j of targets) {
          scanned++;
          try {
            const kline = await fetcher(j.code, 'daily', undefined, undefined, '').catch(function() { return null; });
            if (!Array.isArray(kline) || kline.length < 5) { skipped++; continue; }
            const closes = kline.map(function(b) { return parseFloat(b.收盘 || b.close); }).filter(function(c) { return c > 0; });
            if (closes.length < 5) { skipped++; continue; }
            const dates = kline.map(function(b) { return String(b.日期 || b.date || '').slice(0, 10); });
            const entryIdx = dates.findIndex(function(d) { return d >= j.entryDate; });
            if (entryIdx < 0 || entryIdx >= closes.length) { skipped++; continue; }
            const entryPrice = j.costPrice || closes[entryIdx];
            const lastPrice = closes[closes.length - 1];
            if (!(entryPrice > 0) || !(lastPrice > 0)) { skipped++; continue; }
            const pnlPct = (lastPrice - entryPrice) / entryPrice;
            const outcome = this._judgeLongOutcome(pnlPct);
            await Core.Storage.update('journals', j.id, {
              verifyOutcome: outcome.outcome,
              verifyFailureReason: outcome.reason,
              verifiedAt: Date.now(),
              pnlPct: +pnlPct.toFixed(4),
              lastPrice: +lastPrice.toFixed(2)
            });
            verified++;
          } catch (e) {
            console.warn('[LongTrader] verify ' + j.code + ' 失败:', e.message || e);
            skipped++;
          }
        }
        return { scanned, verified, skipped };
      } catch (e) {
        console.warn('[LongTrader] verifyLongTrades 总流程失败:', e);
        return { scanned, verified, skipped };
      }
    },

    /**
     * 长线成绩单 (按 reason 关键词分组胜率)
     */
    _buildLongTrackRecord(trades) {
      const list = (Array.isArray(trades) ? trades : []).filter(function(t) { return t && t.outcome; });
      const minSamples = Core.Constants.LONG_VERIFY_MIN_SAMPLES;
      if (list.length < minSamples) return null;
      var catOf = function(r) {
        var s = String(r || '');
        if (/题材|概念|事件/.test(s)) return '题材';
        if (/业绩|财报|利润|营收/.test(s)) return '业绩';
        if (/资金|流入|主力|北向/.test(s)) return '资金';
        if (/技术|突破|均线|金叉/.test(s)) return '技术';
        return '其他';
      };
      var score = function(o) { return o === 'correct' ? 1 : (o === 'partial' ? 0.5 : 0); };
      var groups = {};
      for (var t = 0; t < list.length; t++) {
        var tr = list[t];
        var cat = catOf(tr.reason);
        var g = groups[cat] || (groups[cat] = { total: 0, scoreSum: 0, pnlSum: 0, reasons: {} });
        g.total++;
        g.scoreSum += score(tr.outcome);
        g.pnlSum += (tr.pnlPct || 0);
        if (tr.reason) g.reasons[tr.reason] = (g.reasons[tr.reason] || 0) + 1;
      }
      var byReason = Object.entries(groups).map(function(entry) {
        var cat = entry[0], g = entry[1];
        return {
          category: cat,
          total: g.total,
          correctRate: +(g.scoreSum / g.total).toFixed(2),
          avgPnl: +(g.pnlSum / g.total * 100).toFixed(2),
          topReason: Object.entries(g.reasons).sort(function(a, b) { return b[1] - a[1]; })[0]?.[0] || null
        };
      }).sort(function(a, b) { return b.total - a.total; });
      var totalScore = list.reduce(function(s, t) { return s + score(t.outcome); }, 0);
      return {
        total: list.length,
        correctRate: +(totalScore / list.length).toFixed(2),
        byReason: byReason
      };
    }
  };

  window.LongTrader = LongTrader;
})();
