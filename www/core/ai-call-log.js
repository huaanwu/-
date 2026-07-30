/**
 * Core.AICallLog - AI 调用 trace 记录
 *
 * 目的: 每次 AI 调用留日志, 用于事后审计 / 调试 / 教学
 * 字段:
 *   ts, page, purpose              // 来源追溯
 *   promptHash, sysHash            // 内容指纹 (避免全文存, 泄露 + 体积)
 *   promptLen, sysLen              // 长度统计
 *   response (截断 200 字)         // 关键开头 / 结论
 *   latencyMs, model, baseURL      // 性能 + 来源
 *   injected: { regime, width, stats, calibration, lessons }
 *   error (失败原因)
 *
 * 存储: 走 Core.Storage.add('ai_call_log', {...}), 容量上限 200, 超出滚动截断
 * 检索: list({limit, since, page}) / clear()
 *
 * 设计: 不阻塞 call() 主路径; 写入 try/catch 吞错 (日志失败不应影响 AI 响应)
 */
(function() {
  'use strict';

  const MAX_LOGS = 200;
  const RESPONSE_TRUNC = 200;

  async function record(entry) {
    try {
      const e = {
        id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('log-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)),
        ts: entry.ts || Date.now(),
        page: entry.page || '?',
        purpose: entry.purpose || '?',
        promptHash: entry.promptHash || _hash(entry.prompt || ''),
        sysHash: entry.sysHash || _hash(entry.systemPrompt || ''),
        promptLen: (entry.prompt || '').length,
        sysLen: (entry.systemPrompt || '').length,
        response: (entry.response || '').slice(0, RESPONSE_TRUNC),
        latencyMs: entry.latencyMs || 0,
        model: entry.model || '',
        baseURL: entry.baseURL || '',
        injected: entry.injected || {},
        error: entry.error || null,
        runId: entry.runId || null
      };
      await Core.Storage.add('ai_call_log', e);
      // 滚动截断: 超 MAX_LOGS 就删最旧的 (先快照 ids, 避免迭代中 splice 跳过)
      const all = await Core.Storage.all('ai_call_log');
      if (Array.isArray(all) && all.length > MAX_LOGS) {
        const sorted = all.sort((a, b) => (a.ts || 0) - (b.ts || 0));
        const idsToDel = sorted.slice(0, all.length - MAX_LOGS).map(x => x.id).filter(Boolean);
        for (const id of idsToDel) {
          try { await Core.Storage.delete('ai_call_log', id); } catch (err) { /* 单条失败忽略 */ }
        }
      }
      return e;
    } catch (e) {
      console.warn('[AICallLog] 写日志失败:', e.message);
      return null;
    }
  }

  async function list(opts = {}) {
    const limit = opts.limit || 50;
    const page = opts.page;
    const since = opts.since;
    try {
      const all = await Core.Storage.all('ai_call_log');
      let arr = Array.isArray(all) ? all : [];
      arr.sort((a, b) => (b.ts || 0) - (a.ts || 0));  // 倒序
      if (page) arr = arr.filter(x => x.page === page);
      if (since) arr = arr.filter(x => (x.ts || 0) >= since);
      return arr.slice(0, limit);
    } catch (e) {
      console.warn('[AICallLog] 读日志失败:', e.message);
      return [];
    }
  }

  async function clear() {
    try {
      const all = await Core.Storage.all('ai_call_log');
      // 先快照 ids, 避免迭代中 splice 导致跳过
      const ids = (all || []).map(x => x.id).filter(Boolean);
      for (const id of ids) {
        try { await Core.Storage.delete('ai_call_log', id); } catch (err) { /* ignore */ }
      }
    } catch (e) {
      console.warn('[AICallLog] 清空失败:', e.message);
    }
  }

  /**
   * 聚合: 按 (page, purpose) 统计成功率 + 平均延迟
   * @returns { total, okCount, errorCount, byPage: {...}, avgLatencyMs }
   */
  async function stats() {
    try {
      const all = await Core.Storage.all('ai_call_log');
      const arr = Array.isArray(all) ? all : [];
      let total = arr.length, okCount = 0, errorCount = 0, totalLatency = 0;
      const byPage = {};
      for (const x of arr) {
        if (x.error) errorCount++;
        else okCount++;
        totalLatency += x.latencyMs || 0;
        const p = x.page || '?';
        if (!byPage[p]) byPage[p] = { total: 0, ok: 0, error: 0, latency: 0 };
        byPage[p].total++;
        if (x.error) byPage[p].error++; else byPage[p].ok++;
        byPage[p].latency += x.latencyMs || 0;
      }
      return {
        total,
        okCount,
        errorCount,
        avgLatencyMs: total > 0 ? Math.round(totalLatency / total) : 0,
        byPage
      };
    } catch (e) {
      console.warn('[AICallLog] 统计失败:', e.message);
      return { total: 0, okCount: 0, errorCount: 0, avgLatencyMs: 0, byPage: {} };
    }
  }

  // FNV-1a 32-bit hash, 与 ai-service 的 cacheKey 同算法
  function _hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  window.Core = window.Core || {};
  window.Core.AICallLog = { record, list, clear, stats, MAX_LOGS, RESPONSE_TRUNC };
})();