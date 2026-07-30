/**
 * Core.Data.Facade - 数据门面 (Phase 2.2: 三源降级链 + cacheKey 双写)
 *
 * 职责:
 *   - getQuote(code) / getQuoteMany(codes): 高层入口, 内置 腾讯→新浪→aktools 降级
 *   - cacheKey 收口: 主 quote:v3:single:{code} + legacy quote:v3:legacy:{code} 双写 TTL=7d
 *   - provenance.chain 保留降级路径 (e.g. ["tengxun", "tengxun.fail", "sina", "normalize.sina"])
 *   - provenance.legacyHit: true 表示这次 cache hit 来自 legacy key (7 天内)
 *
 * 缓存策略:
 *   - quote:v3:single:{code} -> envelope payload (TTL: 实时 60s, 收盘后 24h)
 *   - quote:v3:multi:{sorted} -> envelope payload[] (TTL 60s)
 *   - quote:v3:legacy:{code} -> envelope payload (TTL 7d, 用于 Phase 1 前的旧 cache key 平滑)
 *
 * 设计:
 *   - 异步返回 envelope, 调用方不需要知道用了哪个 provider
 *   - 失败不 throw, 返回 quality=failed envelope, 让 AI 看到降级链
 *   - 单 source 失败时尝试下一个, 不重试 (上游 _fetch 已自带 retries=2)
 *
 * 注意:
 *   - Phase 1 已写入 quote:v3:{code} (无 :single 后缀) 的旧 key 不会被 facade 主动清,
 *     7 天后自动过期 (Core.Storage cacheGet 命中后写入新 key, 老 key 被新值覆盖)。
 *     legacy 双写是为了**读取兼容**:Phase 1 写入的 key 还能被读到。
 */
(function() {
  'use strict';

  const Schema = window.Core.Data.Schema;
  const Provenance = window.Core.Data.Provenance;
  const Normalize = window.Core.Data.Normalize;
  if (!Schema || !Provenance || !Normalize) {
    console.error('[DataFacade] Schema/Provenance/Normalize 未加载, 请确认 schema.js + provenance.js + normalize.js 在 facade.js 之前加载');
  }

  // TTL 常量
  const TTL_REALTIME_MS = 60 * 1000;
  const TTL_EOD_MS = 24 * 60 * 60 * 1000;
  const TTL_LEGACY_MS = 7 * 24 * 60 * 60 * 1000;   // 7 天

  function _ttlForNow() {
    const h = new Date().getHours();
    const m = new Date().getMinutes();
    const minutes = h * 60 + m;
    const inTrading = (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30)
                   || (minutes >= 13 * 60 && minutes <= 15 * 60);
    return inTrading ? TTL_REALTIME_MS : TTL_EOD_MS;
  }

  // ===== CacheKey 收口 =====
  function _mainKey(code) { return `quote:v3:single:${code}`; }
  function _legacyKey(code) { return `quote:v3:legacy:${code}`; }
  function _multiKey(codes) { return `quote:v3:multi:${codes.slice().sort().join(',')}`; }

  function _marketOf(symbol) {
    const s = String(symbol || '');
    if (s.startsWith('6')) return Schema.MARKETS.SH;
    if (s.startsWith('0') || s.startsWith('3')) return Schema.MARKETS.SZ;
    if (s.startsWith('5')) return Schema.MARKETS.SH;
    if (s.startsWith('1') || s.startsWith('2')) return Schema.MARKETS.SZ;
    return Schema.MARKETS.SH;
  }

  // ===== 三源 fetcher 映射 =====
  // 返回 { raw, chain } — raw 是已 normalize 前的字段对象, chain 是 [provider, ...] 转换链
  // 由 _fetchWithFallback 串起来: 第一个成功就用; 全失败抛 UpstreamError
  class UpstreamError extends Error {
    constructor(msg, chain) {
      super(msg);
      this.chain = chain || [];
      this.isUpstreamError = true;
    }
  }

  async function _fetchFromTengxun(codes) {
    if (!window.Core.Data || typeof window.Core.Data.getStockSpotTencent !== 'function') {
      throw new UpstreamError('Core.Data.getStockSpotTencent not available', ['tengxun.unavailable']);
    }
    const raws = await window.Core.Data.getStockSpotTencent(codes);
    if (!Array.isArray(raws) || raws.length === 0) {
      throw new UpstreamError('tengxun returned empty', ['tengxun.empty']);
    }
    const map = {};
    raws.forEach(r => { const c = r['代码'] || r.code; if (c) map[c] = r; });
    const result = {};
    codes.forEach(c => {
      if (map[c]) result[c] = { raw: map[c], chain: ['tengxun', 'normalize.tengxun'] };
    });
    if (Object.keys(result).length === 0) {
      throw new UpstreamError('tengxun returned no matching codes', ['tengxun.empty']);
    }
    return { result, missing: codes.filter(c => !result[c]) };
  }

  async function _fetchFromSina(codes) {
    if (!window.Core.Data || typeof window.Core.Data._sinaFetch !== 'function') {
      throw new UpstreamError('Core.Data._sinaFetch not available', ['sina.unavailable']);
    }
    const raws = await window.Core.Data._sinaFetch(codes);
    if (!Array.isArray(raws) || raws.length === 0) {
      throw new UpstreamError('sina returned empty', ['sina.empty']);
    }
    const map = {};
    raws.forEach(r => { const c = r['代码'] || r.code; if (c) map[c] = r; });
    const result = {};
    codes.forEach(c => {
      if (map[c]) result[c] = { raw: map[c], chain: ['sina', 'normalize.sina'] };
    });
    if (Object.keys(result).length === 0) {
      throw new UpstreamError('sina returned no matching codes', ['sina.empty']);
    }
    return { result, missing: codes.filter(c => !result[c]) };
  }

  async function _fetchFromAktools(codes) {
    if (!window.Core.Data || typeof window.Core.Data.fetch !== 'function') {
      throw new UpstreamError('Core.Data.fetch not available', ['aktools.unavailable']);
    }
    const all = await window.Core.Data.fetch('stock_zh_a_spot', {}, 60 * 1000);
    if (!Array.isArray(all) || all.length === 0) {
      throw new UpstreamError('aktools returned empty', ['aktools.empty']);
    }
    // aktools 用 ts_code 形如 '600519.SH', 抽取纯 6 位代码
    const _aktoolsCodeOf = (r) => {
      const ts = r['ts_code'] || r['代码'] || r.code || '';
      return ts.includes('.') ? ts.split('.')[0] : ts;
    };
    const map = {};
    all.forEach(r => {
      const c = _aktoolsCodeOf(r);
      if (c) map[c] = r;
    });
    const result = {};
    codes.forEach(c => {
      if (map[c]) result[c] = { raw: map[c], chain: ['aktools', 'normalize.aktools'] };
    });
    if (Object.keys(result).length === 0) {
      throw new UpstreamError('aktools returned no matching codes', ['aktools.empty']);
    }
    return { result, missing: codes.filter(c => !result[c]) };
  }

  // 降级链: tengxun -> sina -> aktools (每源只试一次, 不重试 — 上游已 retries)
  async function _fetchWithFallback(codes, mode = 'auto') {
    const errors = [];
    const order = mode === 'auto'
      ? ['tengxun', 'sina', 'aktools']
      : [mode];
    let aggregated = {};
    let missing = codes.slice();
    for (const provider of order) {
      if (missing.length === 0) break;
      try {
        const fetcher = provider === 'tengxun' ? _fetchFromTengxun
                      : provider === 'sina' ? _fetchFromSina
                      : provider === 'aktools' ? _fetchFromAktools
                      : null;
        if (!fetcher) continue;
        const { result, missing: stillMissing } = await fetcher(missing);
        Object.assign(aggregated, result);
        missing = stillMissing;
      } catch (e) {
        errors.push({ provider, chain: e.chain || [provider + '.fail'], msg: e.message });
      }
    }
    if (Object.keys(aggregated).length === 0) {
      throw new UpstreamError('all providers failed: ' + JSON.stringify(errors), errors.flatMap(e => e.chain));
    }
    return { aggregated, errors };
  }

  /**
   * 构造 quote envelope (含 schema 校验 + provenance + chain)
   * provOpts: { provider, cacheHit, legacyHit, chain, upstreamErrors, collectedBy }
   * 注: raw 可能是 已 normalize 的 payload (cache 命中) 或 待 normalize 的源 raw (fetcher 路径)
   */
  function _buildQuoteEnvelope(raw, provOpts) {
    const provider = provOpts.provider || Schema.PROVIDERS.TENGXUN;
    // cache 命中: raw 已经是 payload, 直接用; fetcher: 需 normalize
    let payload;
    if (provOpts.cacheHit && raw && raw.symbol && raw.market && raw.price !== undefined) {
      payload = raw;
    } else {
      const normalizeFn = provider === Schema.PROVIDERS.TENGXUN ? Normalize.normalizeTengxun
                        : provider === Schema.PROVIDERS.SINA ? Normalize.normalizeSina
                        : provider === Schema.PROVIDERS.AKTOOLS ? Normalize.normalizeAktools
                        : Normalize.normalizeTengxun;
      payload = normalizeFn(raw) || {};
    }
    const symbol = (payload && payload.symbol) || raw['代码'] || (raw.ts_code ? raw.ts_code.split('.')[0] : '') || raw.code || '?';
    const chain = (provOpts.chain || [provider, 'normalize.' + provider]).slice();
    if (provOpts.cacheHit && !chain.includes('cache.lookup')) chain.push('cache.lookup');
    if (provOpts.legacyHit && !chain.includes('cache.legacy')) chain.push('cache.legacy');
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
    env.provenance = Provenance.build({
      provider: provider,
      collectedBy: provOpts.collectedBy || 'data.quote.get',
      cacheHit: !!provOpts.cacheHit,
      upstreamErrors: provOpts.upstreamErrors || []
    });
    // 把降级链塞进 provenance.chain (覆盖默认 chain)
    env.provenance.chain = chain;
    env.provenance.legacyHit = !!provOpts.legacyHit;
    if (env.validation.status === Schema.VALIDATION_STATUS.FAILED) {
      env.quality = Schema.QUALITY.FAILED;
    } else if (env.validation.status === Schema.VALIDATION_STATUS.WARNED) {
      env.quality = Schema.QUALITY.PARTIAL;
    }
    return env;
  }

  function _failedEnvelope(code, errors) {
    return {
      category: Schema.CATEGORIES.QUOTE,
      provider: Schema.PROVIDERS.DERIVED,
      market: _marketOf(code),
      assetType: Schema.ASSET_TYPES.STOCK,
      symbol: code,
      fetchedAt: Date.now(),
      freshness: Schema.FRESHNESS.REALTIME,
      quality: Schema.QUALITY.FAILED,
      schemaVersion: 'quote.v3',
      validation: { status: Schema.VALIDATION_STATUS.FAILED, warnings: [], errors: errors || ['all providers failed'] },
      provenance: Provenance.build({
        provider: Schema.PROVIDERS.DERIVED,
        collectedBy: 'data.quote.get',
        upstreamErrors: errors || ['all providers failed']
      }),
      payload: {}
    };
  }

  // ===== 公开 API =====

  /**
   * 取一只股票的标准化 envelope (带缓存 + 降级链)
   * @param {string} code - 6 位股票代码
   * @param {object} [opts]
   *   - provider: 'auto' (默认) | 'tengxun' | 'sina' | 'aktools'
   * @returns {Promise<object>} DataEnvelope
   */
  async function getQuote(code, opts = {}) {
    if (!code) throw new Error('getQuote: code required');
    const mode = opts.provider || 'auto';
    const mainKey = _mainKey(code);
    const legacyKey = _legacyKey(code);

    // 1) 主 key 命中
    const cached = await Core.Storage.cacheGet(mainKey);
    if (cached && cached.symbol) {
      return _buildQuoteEnvelope(cached, {
        provider: cached.provider || Schema.PROVIDERS.TENGXUN,
        cacheHit: true,
        legacyHit: false,
        collectedBy: 'data.quote.get'
      });
    }

    // 2) legacy key 命中 (7 天过渡期)
    const legacyCached = await Core.Storage.cacheGet(legacyKey);
    if (legacyCached && legacyCached.symbol) {
      const env = _buildQuoteEnvelope(legacyCached, {
        provider: legacyCached.provider || Schema.PROVIDERS.TENGXUN,
        cacheHit: true,
        legacyHit: true,
        collectedBy: 'data.quote.get'
      });
      // 回填主 key (保留 legacy 让其按 TTL 自然过期)
      try { await Core.Storage.cacheSet(mainKey, env.payload, _ttlForNow()); } catch (_) {}
      return env;
    }

    // 3) 真正拉取 (降级链)
    let result, errors;
    try {
      const fetched = await _fetchWithFallback([code], mode);
      result = fetched.aggregated[code];
      errors = fetched.errors;
    } catch (e) {
      return _failedEnvelope(code, [e.message]);
    }
    if (!result) {
      return _failedEnvelope(code, errors.map(x => x.msg));
    }

    const env = _buildQuoteEnvelope(result.raw, {
      provider: result.chain[0],
      chain: result.chain,
      upstreamErrors: errors.map(x => x.msg),
      collectedBy: 'data.quote.get'
    });

    // 4) 双写: 主 key + legacy key
    try { await Core.Storage.cacheSet(mainKey, env.payload, _ttlForNow()); } catch (_) {}
    try { await Core.Storage.cacheSet(legacyKey, env.payload, TTL_LEGACY_MS); } catch (_) {}
    return env;
  }

  /**
   * 批量取多只股票 (单次降级链, 失败 codes 由 fallback 覆盖)
   * @param {string[]} codes
   * @param {object} [opts] - { provider }
   * @returns {Promise<object[]>} envelopes (按输入 codes 顺序)
   */
  async function getQuoteMany(codes, opts = {}) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    const mode = opts.provider || 'auto';
    const sorted = codes.slice().sort();
    const multiKey = _multiKey(codes);

    // 1) 批量缓存命中
    const cachedMulti = await Core.Storage.cacheGet(multiKey);
    if (Array.isArray(cachedMulti) && cachedMulti.length === codes.length) {
      return Promise.all(cachedMulti.map(c => _buildQuoteEnvelope(c, {
        provider: c.provider || Schema.PROVIDERS.TENGXUN,
        cacheHit: true,
        legacyHit: false,
        collectedBy: 'data.quote.getMany'
      })));
    }

    // 2) 单只缓存逐个命中 (混命中场景)
    const singles = await Promise.all(codes.map(c => Core.Storage.cacheGet(_mainKey(c)).catch(() => null)));
    const allHit = singles.every(s => s && s.symbol);
    if (allHit) {
      return Promise.all(singles.map((s, i) => _buildQuoteEnvelope(s, {
        provider: s.provider || Schema.PROVIDERS.TENGXUN,
        cacheHit: true,
        legacyHit: false,
        collectedBy: 'data.quote.getMany'
      })));
    }

    // 3) 真正拉取 (降级链)
    let aggregated, errors;
    try {
      const fetched = await _fetchWithFallback(codes, mode);
      aggregated = fetched.aggregated;
      errors = fetched.errors;
    } catch (e) {
      return codes.map(c => _failedEnvelope(c, [e.message]));
    }

    // 4) 构造 envelopes (按输入 codes 顺序, 缺失的返 failed envelope)
    const envelopes = codes.map(code => {
      const r = aggregated[code];
      if (!r) return _failedEnvelope(code, errors.map(x => x.msg));
      return _buildQuoteEnvelope(r.raw, {
        provider: r.chain[0],
        chain: r.chain,
        upstreamErrors: errors.map(x => x.msg),
        collectedBy: 'data.quote.getMany'
      });
    });

    // 5) 缓存写入
    const ttl = _ttlForNow();
    const paylaods = envelopes.map(e => e.payload);
    try { await Core.Storage.cacheSet(multiKey, paylaods, ttl); } catch (_) {}
    for (const env of envelopes) {
      try { await Core.Storage.cacheSet(_mainKey(env.symbol), env.payload, ttl); } catch (_) {}
      try { await Core.Storage.cacheSet(_legacyKey(env.symbol), env.payload, TTL_LEGACY_MS); } catch (_) {}
    }
    return envelopes;
  }

  /**
   * 把多条 envelope 聚合成 sourceDigest (供 AI prompt 注入)
   */
  function digest(envelopes) {
    return Provenance.digest(envelopes);
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.Facade = Object.freeze({
    getQuote, getQuoteMany, digest,
    _ttlForNow, _marketOf,
    _mainKey, _legacyKey, _multiKey,
    _fetchWithFallback, _buildQuoteEnvelope, _failedEnvelope,
    _fetchFromTengxun, _fetchFromSina, _fetchFromAktools,
    UpstreamError,
    TTL_REALTIME_MS, TTL_EOD_MS, TTL_LEGACY_MS
  });
})();