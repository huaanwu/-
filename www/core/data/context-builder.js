/**
 * Core.Data.ContextBuilder - 统一 AI 编排上下文构造 (Phase 2.3)
 *
 * 职责:
 *   - 把"各域零散拉取 + 串行/并行混搭 + 异常被吞"的 ctx 装配收口成一个函数
 *   - Promise.allSettled 语义: 任一数据源失败不污染整体, 失败信息进 partialErrors
 *   - 所有 quote 都走 Facade.getQuote (单只) 或 Facade.getQuoteMany (批量), 自动 sourceDigest
 *   - 输出统一的 Context DTO, 各 strategy 间输出形态一致
 *
 * Context DTO:
 *   {
 *     strategy: 'observe' | 'diagnose' | 'today' | 'short' | 'long' | 'fund',
 *     asOf: timestamp,
 *     slices: {
 *       watchlist: [Quote envelope],
 *       holdings: [Holding array + Quote envelopes],
 *       alerts: [Alert],
 *       recentJournals: [Journal],
 *       portfolio: object | null,
 *       macro: string | null,
 *       marketWidth: object | null,
 *       todayTransactions: [Tx]
 *     },
 *     sourceDigest: "tengxun realtime passed × 3 | sina realtime passed × 1",
 *     partialErrors: [{ source: 'macro', msg: '...' }]
 *   }
 *
 * 调用方 (Phase 2.4 迁移):
 *   - journal.js 232-268 → ContextBuilder.build('diagnose')
 *   - paper.js 6 处选股前 ctx → ContextBuilder.build('observe')
 *   - long-trader.js / short-trader.js 周一盘前 → ContextBuilder.build('long' / 'short')
 *   - agents.js observer → ContextBuilder.build('observe')
 */
(function() {
  'use strict';

  const Facade = window.Core.Data && window.Core.Data.Facade;
  if (!Facade) {
    console.error('[ContextBuilder] Core.Data.Facade 未加载, 请确认 facade.js 在 context-builder.js 之前加载');
  }

  /**
   * 安全运行: 失败时返回 null + 记 partialErrors
   */
  async function _safe(label, fn, partialErrors) {
    try {
      return await fn();
    } catch (e) {
      partialErrors.push({ source: label, msg: (e && e.message) || String(e) });
      return null;
    }
  }

  /**
   * 拉关注股 (watchlist storage)
   */
  async function _loadWatchlist() {
    const list = await Core.Storage.all('watchlist');
    return Array.isArray(list) ? list : [];
  }

  /**
   * 拉持仓 (holdings, 默认排除模拟盘)
   */
  async function _loadHoldings({ paper = false } = {}) {
    const all = await Core.Storage.all('holdings');
    if (!Array.isArray(all)) return [];
    return paper ? all : all.filter(h => !h.isPaper);
  }

  /**
   * 拉告警
   */
  async function _loadAlerts() {
    const list = await Core.Storage.all('alerts');
    return Array.isArray(list) ? list : [];
  }

  /**
   * 拉近期复盘 (默认 7 天, 最多 5 条)
   */
  async function _loadRecentJournals({ days = 7, limit = 5 } = {}) {
    const all = await Core.Storage.all('journals');
    if (!Array.isArray(all)) return [];
    const weekAgo = Date.now() - days * 86400000;
    return all.filter(j => (j.createdAt || 0) >= weekAgo).slice(-limit);
  }

  /**
   * 拉今日成交 (transactions)
   */
  async function _loadTodayTransactions() {
    const all = await Core.Storage.all('transactions');
    if (!Array.isArray(all)) return [];
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const ts = todayStart.getTime();
    return all.filter(t => (t.ts || t.createdAt || 0) >= ts);
  }

  /**
   * 把 holdings 数组配上 quote envelopes (走 Facade.getQuoteMany 批量, 节省网络)
   * 返回 { holdings: [h + .quote], quoteEnvelopes: [...] }
   */
  async function _enrichHoldingsWithQuotes(holdings, partialErrors) {
    if (holdings.length === 0) return { holdings: [], quoteEnvelopes: [] };
    const codes = holdings.map(h => h.code).filter(Boolean);
    if (codes.length === 0) return { holdings, quoteEnvelopes: [] };
    const envs = await _safe('quote.batch', () => Facade.getQuoteMany(codes), partialErrors) || [];
    const byCode = {};
    envs.forEach(e => { if (e && e.symbol) byCode[e.symbol] = e; });
    const enriched = holdings.map(h => {
      const env = byCode[h.code];
      if (env && env.payload && env.payload.price != null) {
        h.currentPrice = env.payload.price;
      } else {
        h.currentPrice = null;
      }
      return { ...h, quoteEnvelope: env || null };
    });
    return { holdings: enriched, quoteEnvelopes: envs.filter(Boolean) };
  }

  /**
   * 把 watchlist 配 quote envelopes
   */
  async function _enrichWatchlistWithQuotes(watchlist, partialErrors) {
    if (watchlist.length === 0) return { watchlist: [], quoteEnvelopes: [] };
    const codes = watchlist.map(w => w.code || w).filter(Boolean);
    const envs = await _safe('quote.batch', () => Facade.getQuoteMany(codes), partialErrors) || [];
    const byCode = {};
    envs.forEach(e => { if (e && e.symbol) byCode[e.symbol] = e; });
    const enriched = watchlist.map(w => {
      const code = w.code || w;
      const env = byCode[code];
      return { code, watchEntry: w, quoteEnvelope: env || null };
    });
    return { watchlist: enriched, quoteEnvelopes: envs.filter(Boolean) };
  }

  /**
   * 构造 Context DTO, strategy 决定拉哪些 slice
   */
  async function build(strategy, opts = {}) {
    const partialErrors = [];
    const slices = {};
    const allEnvelopes = [];
    let holdings = [];
    let watchlist = [];

    // ===== holdings (除 'observe' 外都需要) =====
    if (strategy !== 'observe') {
      const raw = await _safe('holdings', () => _loadHoldings({ paper: opts.paper }), partialErrors) || [];
      const { holdings: enriched, quoteEnvelopes: hEnvs } = await _enrichHoldingsWithQuotes(raw, partialErrors);
      holdings = enriched;
      allEnvelopes.push(...hEnvs);
      slices.holdings = enriched;
    }

    // ===== watchlist (observe / diagnose / short / long / fund 都需要) =====
    if (['observe', 'diagnose', 'short', 'long', 'fund', 'today'].includes(strategy)) {
      const raw = await _safe('watchlist', _loadWatchlist, partialErrors) || [];
      const { watchlist: enriched, quoteEnvelopes: wEnvs } = await _enrichWatchlistWithQuotes(raw, partialErrors);
      watchlist = enriched;
      allEnvelopes.push(...wEnvs);
      slices.watchlist = enriched;
    }

    // ===== alerts (diagnose / today) =====
    if (['diagnose', 'today'].includes(strategy)) {
      slices.alerts = await _safe('alerts', _loadAlerts, partialErrors) || [];
    }

    // ===== recentJournals (diagnose) =====
    if (strategy === 'diagnose') {
      slices.recentJournals = await _safe('recentJournals',
        () => _loadRecentJournals({ days: opts.journalDays || 7, limit: opts.journalLimit || 5 }),
        partialErrors) || [];
    }

    // ===== todayTransactions (today / diagnose) =====
    if (['today', 'diagnose'].includes(strategy)) {
      slices.todayTransactions = await _safe('todayTransactions', _loadTodayTransactions, partialErrors) || [];
    }

    // ===== portfolio / macro / marketWidth (diagnose / short / long / fund) =====
    if (['diagnose', 'short', 'long', 'fund'].includes(strategy)) {
      const [portfolio, macroText, marketWidth] = await Promise.all([
        _safe('portfolio', () => Core.Portfolio && Core.Portfolio.getAssets
          ? Core.Portfolio.getAssets({ paper: !!opts.paper }) : Promise.resolve(null), partialErrors),
        _safe('macro', () => Core.Macro && Core.Macro.get
          ? Core.Macro.get().then(m => Core.Macro.formatForPrompt
              ? Core.Macro.formatForPrompt(m)
              : (m ? JSON.stringify(m).slice(0, 800) : null))
          : Promise.resolve(null), partialErrors),
        _safe('marketWidth', () => Core.MarketWidth && Core.MarketWidth.getMarketWidth
          ? Core.MarketWidth.getMarketWidth() : Promise.resolve(null), partialErrors)
      ]);
      slices.portfolio = portfolio;
      slices.macro = macroText;
      slices.marketWidth = marketWidth;
    }

    // ===== sourceDigest 聚合 =====
    const sourceDigest = allEnvelopes.length > 0
      ? Facade.digest(allEnvelopes)
      : '';

    return {
      strategy,
      asOf: Date.now(),
      slices,
      sourceDigest,
      partialErrors
    };
  }

  /**
   * 把 Context DTO 渲染成 AI prompt 头部 (md 格式)
   * - 含 strategy + 时间戳 + 数据来源摘要 + partial errors 警告
   */
  function renderForPrompt(ctx, opts = {}) {
    const lines = [];
    lines.push(`## Context (strategy=${ctx.strategy}, asOf=${new Date(ctx.asOf).toISOString()})`);
    if (ctx.sourceDigest) {
      lines.push(`## 数据来源摘要`);
      lines.push(ctx.sourceDigest);
    }
    if (ctx.partialErrors && ctx.partialErrors.length > 0) {
      lines.push(`## 数据缺失警告`);
      ctx.partialErrors.forEach(e => lines.push(`- ${e.source}: ${e.msg}`));
    }
    return lines.join('\n');
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.ContextBuilder = Object.freeze({
    build, renderForPrompt
  });
})();