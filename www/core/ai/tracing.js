/**
 * Core.AI.Tracing - TraceIOEvent 内存环形缓冲 + 持久化 (Phase 3)
 * 依赖: Core.Storage (Dexie) — agent_runs + ai_traces 表 (DB_VERSION 3)
 *
 * 设计:
 *   - 一次 AgentRun = 顶层 1 个 runId; 内部可能包含多个 agent (observer/analyst/coach)
 *   - 每个 agent / IO 副作用都产 1-N 个 TraceIOEvent
 *   - 内存环形缓冲容量 1000 events/run (防 OOM)
 *   - 5s 定时器兜底 flush; Orchestrator.runAgent 显式 flush 优先
 *   - LRU 容量 50 run (内存中最多保留 50 个 run 的 events, 防止长会话 OOM)
 *   - _flushing Set 互斥; 50ms retry; 失败最多 3 次
 *
 * TraceIOEvent DTO:
 *   { runId, kind, at, ts, summary, detail }
 *   kind: 'ai.call' | 'cache.get' | 'cache.set' | 'tool.io' | 'effect.request' | 'error'
 *
 * AgentRun DTO (落 agent_runs 表):
 *   { runId, intent, strategy, agentType, ok, totalMs, startedAt, finishedAt, steps?, error? }
 *
 * CLAUDE.md: 不引新库; 不阻塞主流程 (flush 失败吞错); 空 catch 加 console.warn
 */
(function() {
  'use strict';

  const MAX_EVENTS_PER_RUN = 1000;   // 单 run 环形缓冲上限
  const MAX_RUNS_IN_MEMORY = 50;      // LRU run 数
  const FLUSH_INTERVAL_MS = 5000;     // 5s 兜底定时器
  const FLUSH_RETRY_MS = 50;
  const FLUSH_MAX_RETRY = 3;

  /** runId → { meta, events: [], lastFlushTs, dirty: bool } */
  const _runs = new Map();
  /** 互斥锁: 正在 flush 的 runId 集合 */
  const _flushing = new Set();

  let _flushTimer = null;

  function _scheduleFlush() {
    if (_flushTimer) return;
    _flushTimer = setTimeout(() => {
      _flushTimer = null;
      // 找出 dirty runs 全部 flush
      const dirty = [];
      for (const [rid, r] of _runs.entries()) {
        if (r.dirty && r.events.length) dirty.push(rid);
      }
      for (const rid of dirty) {
        flush(rid).catch((e) => console.warn('[Tracing] 定时 flush 失败:', rid, e));
      }
    }, FLUSH_INTERVAL_MS);
  }

  function _evictLRU() {
    if (_runs.size <= MAX_RUNS_IN_MEMORY) return;
    // 按 lastFlushTs 升序排 (最久没刷的优先淘汰)
    const sorted = [..._runs.entries()].sort((a, b) => (a[1].lastFlushTs || 0) - (b[1].lastFlushTs || 0));
    const toRemove = sorted.slice(0, _runs.size - MAX_RUNS_IN_MEMORY);
    for (const [rid] of toRemove) {
      const r = _runs.get(rid);
      if (r && r.dirty) {
        // 淘汰前最后一次尽力 flush (失败不抛)
        flush(rid).catch(() => {});
      }
      _runs.delete(rid);
    }
  }

  /**
   * 开启一次 Run. 幂等: 同一 runId 第二次调用只覆盖 meta (不丢 events).
   * @param {string} runId
   * @param {{ intent?: string, strategy?: string, agentType?: string, startedAt?: number }} meta
   */
  function start(runId, meta) {
    if (!runId) throw new TypeError('start: runId 必填');
    meta = meta || {};
    const existing = _runs.get(runId);
    if (existing) {
      // 幂等: 合并 meta (新值覆盖)
      existing.meta = { ...existing.meta, ...meta };
      return existing;
    }
    const run = {
      meta: {
        runId,
        intent: meta.intent || '',
        strategy: meta.strategy || '',
        agentType: meta.agentType || '',
        startedAt: meta.startedAt || Date.now(),
        finishedAt: 0,
        ok: false,
        totalMs: 0,
        steps: [],
        error: null
      },
      events: [],
      lastFlushTs: 0,
      dirty: false
    };
    _runs.set(runId, run);
    _evictLRU();
    return run;
  }

  /**
   * 记录一条 TraceIOEvent. 容量超限自动截断最早 (内存环形)
   * @param {string} runId
   * @param {{ kind: string, summary?: string, detail?: any, at?: number }} evt
   */
  function recordEvent(runId, evt) {
    const run = _runs.get(runId);
    if (!run) {
      console.warn('[Tracing] recordEvent: runId 未 start, 忽略:', runId, evt && evt.kind);
      return;
    }
    if (!evt || !evt.kind) {
      console.warn('[Tracing] recordEvent: kind 必填, 忽略');
      return;
    }
    const now = evt.at || Date.now();
    run.events.push({
      runId,
      kind: evt.kind,
      summary: evt.summary || '',
      detail: evt.detail || null,
      at: now,
      ts: now
    });
    if (run.events.length > MAX_EVENTS_PER_RUN) {
      // 环形: 砍掉最早 1/4
      run.events.splice(0, Math.floor(MAX_EVENTS_PER_RUN / 4));
    }
    run.dirty = true;
    _scheduleFlush();
  }

  /**
   * 标记 Run 结束 (填充 finishedAt/ok/totalMs/error)
   * @param {string} runId
   * @param {{ ok: boolean, totalMs: number, finishedAt?: number, error?: string, steps?: any[] }} finish
   */
  function finish(runId, finish) {
    const run = _runs.get(runId);
    if (!run) return;
    finish = finish || {};
    run.meta.finishedAt = finish.finishedAt || Date.now();
    run.meta.ok = !!finish.ok;
    run.meta.totalMs = finish.totalMs || 0;
    run.meta.error = finish.error || null;
    if (Array.isArray(finish.steps)) run.meta.steps = finish.steps;
    run.dirty = true;
  }

  /**
   * 显式 flush 到 IndexedDB. 互斥; 失败重试; 失败后仍 try/catch 不抛.
   * @param {string} [runId] 不传则 flush 所有 dirty runs
   * @returns {Promise<{ runId: string, flushed: number }>}
   */
  async function flush(runId) {
    const targets = runId ? [runId] : [..._runs.keys()];
    const results = [];
    for (const rid of targets) {
      const r = await _flushOne(rid);
      results.push(r);
    }
    return { runId: runId || null, flushed: results.filter(x => x && x.flushed > 0).length };
  }

  async function _flushOne(runId, attempt = 0) {
    if (_flushing.has(runId)) {
      // 重叠防护: 等待 50ms 重试
      if (attempt >= FLUSH_MAX_RETRY) {
        console.warn('[Tracing] flush 重叠超限, 跳过:', runId);
        return { runId, flushed: 0, reason: 'locked' };
      }
      await new Promise(r => setTimeout(r, FLUSH_RETRY_MS));
      return _flushOne(runId, attempt + 1);
    }
    const run = _runs.get(runId);
    if (!run) return { runId, flushed: 0, reason: 'gone' };
    if (!run.events.length && run.meta.finishedAt === 0) return { runId, flushed: 0, reason: 'empty' };

    _flushing.add(runId);
    try {
      const storage = window.Core && window.Core.Storage;
      if (!storage || !storage.addAgentRun || !storage.addAITraces) {
        console.warn('[Tracing] Core.Storage 未就绪, 跳过 flush:', runId);
        return { runId, flushed: 0, reason: 'no-storage' };
      }

      let flushed = 0;
      // 写 agent_runs
      if (run.meta.finishedAt > 0) {
        await storage.addAgentRun({ ...run.meta, runId });
        flushed++;
      }
      // 写 ai_traces
      if (run.events.length) {
        await storage.addAITraces(run.events);
        flushed += run.events.length;
        run.events = []; // 清空已 flush 的 events
      }
      run.lastFlushTs = Date.now();
      run.dirty = false;
      return { runId, flushed };
    } catch (e) {
      console.warn('[Tracing] flush 失败，事件保留下次重试:', runId, e && e.message || e);
      return { runId, flushed: 0, reason: 'error', error: e && e.message };
    } finally {
      _flushing.delete(runId);
    }
  }

  /** 读取内存中某 run 的 events (调试用) */
  function listByRun(runId) {
    const run = _runs.get(runId);
    if (!run) return [];
    return run.events.slice();
  }

  /** 读取某 run 的 meta */
  function getMeta(runId) {
    const run = _runs.get(runId);
    if (!run) return null;
    return JSON.parse(JSON.stringify(run.meta));
  }

  /** 调试: 当前内存中 run 数 */
  function size() {
    return _runs.size;
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.AI = window.Core.AI || {};
  window.Core.AI.Tracing = {
    start, recordEvent, finish, flush, listByRun, getMeta, size,
    MAX_EVENTS_PER_RUN, MAX_RUNS_IN_MEMORY, FLUSH_INTERVAL_MS
  };
})();