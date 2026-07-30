/**
 * Core.Data.Provenance - 数据来源追踪 (Phase 1.3)
 *
 * 职责:
 *   - 给每一次数据拉取生成完整 provenance 字段 (含 chain / rawSource / cacheHit 等)
 *   - 把多条 envelope 聚合成 sourceDigest 压缩文本 (1-2 行, 给 AI prompt 注入)
 *
 * 设计:
 *   - 纯函数, 不依赖 Core.* 其他模块
 *   - FNV-1a 32-bit hash 与 ai-service cacheKey 同算法 (core/ai-service.js _hash)
 *   - sourceDigest 控制长度: 单条 ≤40 字, 总长度 ≤400 字 (避免 prompt 爆炸)
 */
(function() {
  'use strict';

  const MAX_DIGEST_LEN = 400;
  const SINGLE_LINE_MAX = 40;

  /**
   * FNV-1a 32-bit hash (与 Core.AI cacheKey 算法一致)
   */
  function _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /**
   * 构造单个拉取的 provenance 对象
   * @param {object} opts
   *   - provider: 'tengxun' | 'sina' | 'aktools' | 'derived'
   *   - rawSource: { url, symbol, params } 或 null (cache hit 时只有 symbol)
   *   - rawBody: string | null (原始响应, 用于 hash)
   *   - upstreamErrors: string[] (降级链上的错误信息)
   *   - collectedBy: 内部入口名 (例 'data.quote.get')
   *   - cacheHit: boolean
   *   - ttlMs: number (缓存 TTL)
   * @returns {object} provenance
   */
  function build(opts) {
    const o = opts || {};
    const chain = [o.provider || 'unknown', 'normalize.v3'];
    if (o.cacheHit) chain.push('cache.lookup');
    return {
      chain: chain,
      rawSource: o.rawSource || null,
      rawHash: o.rawBody != null ? _hash(String(o.rawBody)) : null,
      upstreamErrors: Array.isArray(o.upstreamErrors) ? o.upstreamErrors.slice() : [],
      collectedBy: o.collectedBy || 'unknown',
      collectedAt: Date.now(),
      cacheHit: !!o.cacheHit,
      ttlMs: o.ttlMs || 60000
    };
  }

  /**
   * 把多条 envelope 聚合成 sourceDigest 压缩文本 (给 AI 注入)
   * 格式: "腾讯 realtime 5 分钟前 OK × 8;  新浪 delayed 8 分钟前 WARNED × 2;  未通过校验: sh600519"
   * @param {object[]} envelopes
   * @returns {string}
   */
  function digest(envelopes) {
    if (!Array.isArray(envelopes) || envelopes.length === 0) return '';
    const buckets = {}; // key = `${provider}|${freshness}|${quality}` -> count
    const failed = [];
    for (const env of envelopes) {
      if (!env || typeof env !== 'object') continue;
      const key = (env.provider || '?') + '|' + (env.freshness || '?') + '|' + (env.validation && env.validation.status ? env.validation.status : '?');
      buckets[key] = (buckets[key] || 0) + 1;
      if (env.validation && env.validation.status === 'failed') {
        const sym = env.symbol || env.payload && env.payload.symbol || '?';
        failed.push(sym);
      }
    }
    const now = Date.now();
    const lines = [];
    for (const key of Object.keys(buckets)) {
      const [provider, freshness, status] = key.split('|');
      const cnt = buckets[key];
      lines.push(`${provider} ${freshness} ${status} × ${cnt}`);
    }
    let out = lines.join('; ');
    if (failed.length > 0) {
      out += ';  未通过校验: ' + failed.slice(0, 5).join(',') + (failed.length > 5 ? ` 等 ${failed.length} 条` : '');
    }
    if (out.length > MAX_DIGEST_LEN) {
      out = out.slice(0, MAX_DIGEST_LEN - 3) + '...';
    }
    return out;
  }

  /**
   * 包装器: 给一个 DataEnvelope 加上 provenance 字段 (返回新对象, 不修改入参)
   * @param {object} envelope - 必须有 category / provider / market / assetType / symbol
   * @param {object} provOpts - 同 build() 入参
   * @returns {object} 新 envelope (含 provenance)
   */
  function attach(envelope, provOpts) {
    const env = Object.assign({}, envelope);
    env.provenance = build(provOpts || {});
    return env;
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.Provenance = Object.freeze({ build, digest, attach, _hash, MAX_DIGEST_LEN, SINGLE_LINE_MAX });
})();