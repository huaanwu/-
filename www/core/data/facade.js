/**
 * Core.Data.Facade - 数据门面 (Phase 1.4)
 *
 * 职责:
 *   - 提供 data.quote.get(code) / data.quote.getMany(codes) 等高层入口
 *   - 统一收口 cacheKey (避免调用方自己拼 key 撞库)
 *   - 自动注入 provenance + validation + sourceDigest
 *   - 阶段 1: 只接腾讯源 (sina/aktools 在阶段 2 加入)
 *
 * 缓存策略:
 *   - quote:v3:{symbol} -> envelope (TTL 默认 60 秒, 收盘后 24 小时)
 *   - quote:v3:multi:{sortedSymbols} -> envelope[] (TTL 默认 60 秒)
 *   - 旧 cache key (Core.Data.fetchWithCache 那种散拼) 保留 7 天双写 (阶段 2 实施)
 *
 * 设计:
 *   - 异步返回 envelope[], 调用方不需要知道用了哪个 provider
 *   - 失败不 throw, 返回带 quality=failed 的 envelope, 让 AI 看到降级链
 */
(function() {
  'use strict';

  const Schema = window.Core.Data.Schema;
  const Provenance = window.Core.Data.Provenance;
  if (!Schema || !Provenance) {
    console.error('[DataFacade] Schema / Provenance 未加载, 请确认 schema.js + provenance.js 在 facade.js 之前加载');
  }

  // 默认 TTL: 行情 60 秒, 收盘后(>15:30)24 小时
  const TTL_REALTIME_MS = 60 * 1000;
  const TTL_EOD_MS = 24 * 60 * 60 * 1000;

  function _ttlForNow() {
    const h = new Date().getHours();
    const m = new Date().getMinutes();
    const minutes = h * 60 + m;
    // A股交易时段 9:30-11:30 / 13:00-15:00, 其他时段按 EOD 处理
    const inTrading = (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30)
                   || (minutes >= 13 * 60 && minutes <= 15 * 60);
    return inTrading ? TTL_REALTIME_MS : TTL_EOD_MS;
  }

  /**
   * 内部: 腾讯 fetcher (经 Core.Data.getStockSpotTencent, 与现有逻辑一致)
   * @returns {Promise<Array>} 腾讯原始字段对象数组 (字段名 中文: 代码/名称/最新价/...)
   */
  async function _fetchRawFromTengxun(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) return [];
    if (!window.Core.Data || typeof window.Core.Data.getStockSpotTencent !== 'function') {
      throw new Error('Core.Data.getStockSpotTencent 未暴露, 请确认 core/data.js 加载完成');
    }
    return await window.Core.Data.getStockSpotTencent(symbols);
  }

  /**
   * 构造 quote envelope (含 schema 校验 + provenance)
   */
  async function _buildQuoteEnvelope(raw, provOpts) {
    const Normalize = window.Core.Data.Normalize;
    const payload = Normalize ? Normalize.normalizeTengxun(raw) : raw;
    const symbol = (payload && payload.symbol) || raw['代码'] || raw.code || '?';
    const provider = provOpts.provider || Schema.PROVIDERS.TENGXUN;
    const env = {
      category: Schema.CATEGORIES.QUOTE,
      provider: provider,
      market: (payload && payload.market) || _marketOf(symbol),
      assetType: Schema.ASSET_TYPES.STOCK,
      symbol: symbol,
      fetchedAt: Date.now(),
      freshness: Schema.FRESHNESS.REALTIME,
      quality: Schema.QUALITY.OK,
      schemaVersion: 'quote.v3',
      validation: { status: Schema.VALIDATION_STATUS.PENDING, warnings: [], errors: [] },
      provenance: null,
      payload: payload
    };
    env.validation = Schema.validate(env, 'quote.v3');
    env.provenance = Provenance.build(Object.assign({ provider: provider, collectedBy: 'data.quote.get' }, provOpts || {}));
    if (env.validation.status === Schema.VALIDATION_STATUS.FAILED) {
      env.quality = Schema.QUALITY.FAILED;
    } else if (env.validation.status === Schema.VALIDATION_STATUS.WARNED) {
      env.quality = Schema.QUALITY.PARTIAL;
    }
    return env;
  }

  function _marketOf(symbol) {
    const s = String(symbol);
    if (s.startsWith('6')) return Schema.MARKETS.SH;
    if (s.startsWith('0') || s.startsWith('3')) return Schema.MARKETS.SZ;
    if (s.startsWith('5')) return Schema.MARKETS.SH;  // 沪市基金
    if (s.startsWith('1') || s.startsWith('2')) return Schema.MARKETS.SZ;  // 深市基金
    return Schema.MARKETS.SH;
  }

  /**
   * 取一只股票的标准化 envelope (带缓存)
   * @param {string} code - 6 位股票代码
   * @returns {Promise<object>} DataEnvelope
   */
  async function getQuote(code) {
    if (!code) throw new Error('getQuote: code required');
    const cacheKey = `quote:v3:${code}`;
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) {
      return await _buildQuoteEnvelope(cached, { provider: cached.provider, cacheHit: true, collectedBy: 'data.quote.get' });
    }
    const raws = await _fetchRawFromTengxun([code]);
    if (!raws || raws.length === 0) {
      return {
        category: Schema.CATEGORIES.QUOTE,
        provider: Schema.PROVIDERS.TENGXUN,
        market: _marketOf(code),
        assetType: Schema.ASSET_TYPES.STOCK,
        symbol: code,
        fetchedAt: Date.now(),
        freshness: Schema.FRESHNESS.REALTIME,
        quality: Schema.QUALITY.FAILED,
        schemaVersion: 'quote.v3',
        validation: { status: Schema.VALIDATION_STATUS.FAILED, warnings: [], errors: ['tengxun returned empty'] },
        provenance: Provenance.build({ provider: Schema.PROVIDERS.TENGXUN, collectedBy: 'data.quote.get', upstreamErrors: ['empty response'] }),
        payload: {}
      };
    }
    const raw = raws[0];
    const env = await _buildQuoteEnvelope(raw, { provider: Schema.PROVIDERS.TENGXUN });
    await Core.Storage.cacheSet(cacheKey, env.payload, _ttlForNow());
    return env;
  }

  /**
   * 批量取多只股票 (走一次腾讯请求)
   * @param {string[]} codes
   * @returns {Promise<object[]>} envelopes
   */
  async function getQuoteMany(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    const sorted = codes.slice().sort();
    const multiKey = `quote:v3:multi:${sorted.join(',')}`;
    const cached = await Core.Storage.cacheGet(multiKey);
    if (Array.isArray(cached) && cached.length === sorted.length) {
      return Promise.all(cached.map(c => _buildQuoteEnvelope(c, { provider: Schema.PROVIDERS.TENGXUN, cacheHit: true, collectedBy: 'data.quote.getMany' })));
    }
    const raws = await _fetchRawFromTengxun(sorted);
    const envelopes = await Promise.all(raws.map(r => _buildQuoteEnvelope(r, { provider: Schema.PROVIDERS.TENGXUN })));
    // 单只缓存也写一份
    for (let i = 0; i < envelopes.length; i++) {
      const env = envelopes[i];
      const ttl = _ttlForNow();
      await Core.Storage.cacheSet(`quote:v3:${env.symbol}`, env.payload, ttl);
    }
    // 批量缓存存原始数组
    await Core.Storage.cacheSet(multiKey, envelopes.map(e => e.payload), _ttlForNow());
    return envelopes;
  }

  /**
   * 把多条 envelope 聚合成 sourceDigest (供 AI prompt 注入)
   * 复用 Provenance.digest
   */
  function digest(envelopes) {
    return Provenance.digest(envelopes);
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.Facade = Object.freeze({ getQuote, getQuoteMany, digest, _ttlForNow, _marketOf });
})();