/**
 * Core.AI.Entry — AI 编排统一入口 (Phase 5)
 *
 * 把 LongTrader / ShortTrader / Fund / Agents 四个独立 AI 入口
 * 统一到 Core.AI.Entry.run({strategy, ctx, opts}).
 *
 * 设计:
 *   - 不试图统一 prompt 构建 / 结果解析 (各 strategy 差异太大)
 *   - 只统一 runId 生成 + Tracing 包裹 + 返回形状
 *   - 每个 strategy 通过 register() 自注册 handler
 *   - handler 签名: async (ctx, opts) => { ok, data, summary, raw, error }
 *     (与 Orchestrator.runAgent 返回兼容)
 *
 * 注册时机:
 *   - agents: entry.js 自注册 (Core.Agents.runPipeline 已在 Phase 3 收敛到 Orchestrator)
 *   - long/short/fund: 各自 init() 时调用 Core.AI.Entry.register()
 *   - 或通过 app.js init() 集中注册 (见 entry.md / 各域 init)
 *
 * runId 串联:
 *   Core.AI.Entry.run({strategy:'long', ctx, opts: { runId: '...' }})
 *     → Tracing.start(runId)
 *     → handler(ctx, {runId, ...opts})
 *     → handler 内部 cachedCall/call 透传 runId
 *     → Tracing.finish + flush
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  window.Core.AI = window.Core.AI || {};
  const Core = window.Core;

  /** @type {Object<string, { handler: Function, meta: object }>} */
  const _strategies = {};

  /**
   * 注册一个 AI strategy
   * @param {string} strategy     'long'|'short'|'fund'|'agents'|...
   * @param {object} meta         { description, version?, risk? }
   * @param {Function} handler    async (ctx, opts) => { ok, data, summary, raw, error }
   */
  function register(strategy, meta, handler) {
    if (!strategy || typeof handler !== 'function') throw new TypeError('[Entry] register: 缺 strategy/handler');
    if (_strategies[strategy]) throw new Error('[Entry] strategy ' + strategy + ' 已注册');
    _strategies[strategy] = {
      handler: handler,
      meta: { description: meta && meta.description ? meta.description : '', version: meta && meta.version ? meta.version : 'v1', risk: meta && meta.risk ? meta.risk : 'M' }
    };
    console.log('[Entry] 已注册 strategy:', strategy);
  }

  /**
   * 统一入口
   * @param {{ strategy: string, ctx?: object, opts?: object }} param
   * @returns {Promise<{ strategy, runId, ok, data, summary, raw?, error?, latencyMs }>}
   */
  async function run({ strategy, ctx, opts }) {
    const t0 = Date.now();
    strategy = strategy || 'agents';
    ctx = ctx || {};
    opts = opts || {};

    const entry = _strategies[strategy];
    if (!entry) {
      return { strategy, runId: null, ok: false, data: null, summary: '未知 strategy: ' + strategy, error: '未注册: ' + strategy, latencyMs: 0 };
    }

    // 生成/复用 runId
    const runId = opts.runId || ('strat-' + strategy + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

    // Tracing
    const tracing = Core.AI && Core.AI.Tracing;
    if (tracing) {
      tracing.start(runId, { strategy, intent: strategy, startedAt: t0, version: entry.meta.version });
      tracing.recordEvent(runId, { kind: 'entry.start', summary: strategy + ' start' });
    }

    let result;
    try {
      // 透传 runId 给 handler
      const handlerOpts = Object.assign({}, opts, { runId: runId });
      result = await entry.handler(ctx, handlerOpts);

      // handler 应返回 { ok, data, summary, raw?, error? }
      if (!result || typeof result !== 'object') {
        result = { ok: false, data: null, summary: strategy + ' handler 返回非法值', error: 'handler 返回非对象', raw: String(result) };
      }
      if (typeof result.ok !== 'boolean') result.ok = true;
      result.runId = runId;

      if (tracing) {
        tracing.recordEvent(runId, { kind: 'entry.result', summary: result.summary || strategy + ' ok=' + result.ok });
      }
    } catch (e) {
      console.warn('[Entry]', strategy, '异常:', e);
      if (tracing) {
        tracing.recordEvent(runId, { kind: 'error', summary: strategy + ' error: ' + e.message });
      }
      result = { ok: false, data: null, summary: strategy + ' 失败: ' + e.message, raw: '', error: e.message, runId: runId };
    }

    const latencyMs = Date.now() - t0;
    result.latencyMs = latencyMs;
    result.strategy = strategy;

    if (tracing) {
      tracing.finish(runId, { ok: result.ok, totalMs: latencyMs, finishedAt: Date.now() });
      tracing.flush(runId).catch(function (e) { console.warn('[Entry] Tracing.flush 失败:', e); });
    }

    return result;
  }

  /**
   * 列出已注册 strategies
   */
  function list() {
    var result = {};
    for (var key in _strategies) {
      if (_strategies.hasOwnProperty(key)) {
        result[key] = _strategies[key].meta;
      }
    }
    return result;
  }

  /** 通用 AI call handler (各 strategy 可复用) */
  async function _defaultCallHandler(ctx, opts) {
    var callOpts = ctx.callOpts || {};
    if (opts.runId) callOpts.runId = opts.runId;
    var raw;
    if (callOpts.stream) {
      raw = await Core.AI.call(callOpts);
    } else {
      raw = await Core.AI.callWithTimeout(callOpts);
    }
    return { ok: true, data: raw, summary: ctx.summary || 'AI call', raw: raw };
  }

  // 自注册: agents strategy 直接映射 Core.Agents.runPipeline
  // agents 已在 Phase 3 收敛到 Orchestrator, 这里加一层 runId + Tracing 包装
  register('agents', {
    description: 'Core.Agents.runPipeline (observer/analyst/coach)',
    version: 'v1',
    risk: 'M'
  }, async function (ctx, opts) {
    if (typeof Core.Agents !== 'object' || typeof Core.Agents.runPipeline !== 'function') {
      throw new Error('Core.Agents.runPipeline 未就绪');
    }
    // runPipeline 自己管理 runId, 这里透传
    var pipelineOpts = Object.assign({}, opts);
    if (!pipelineOpts.runId) pipelineOpts.runId = opts.runId;
    var intent = String(ctx.intent || 'today');
    var r = await Core.Agents.runPipeline(intent, ctx, pipelineOpts);
    return { ok: r.ok !== false, data: r, summary: r.summary, raw: null, error: r.error || null };
  });

  /**
   * 轻量包裹: 给现有的 Core.AI.call / callWithTimeout 加 runId + Tracing
   * 域代码不改结构, 只把原来的 Core.AI.call(opts) 改为 Core.AI.Entry.callThrough(opts, 'long')
   *
   * @param {object} callOpts - 原样传给 callWithTimeout 的参数
   * @param {string} [strategy='default']
   * @returns {Promise<string>} AI 输出文本 (与原来的 call/callWithTimeout 一致)
   */
  /**
   * 走 Core.AI.call, 但保留 callWithTimeout 的 AbortController 语义:
   *   - 优先用 Core.AI.callWithTimeout (走 AbortController, 真正断网)
   *   - 兜底: Core.AI.callWithTimeout 不存在时, 用 AbortController + 手动 race call
   *   - 最后兜底: 直接调 Core.AI.call (vm sandbox 中 mock call)
   * 默认 timeout = opts.timeout || opts.timeoutMs || 60000 (与 callWithTimeout 一致)
   */
  async function callThrough(callOpts, strategy) {
    strategy = strategy || 'default';
    var runId = callOpts.runId || ('ct-' + strategy + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    callOpts.runId = runId;

    if (!Core.AI || typeof Core.AI.call !== 'function') {
      throw new Error('[Entry] Core.AI.call 未就绪');
    }

    var timeoutMs = (callOpts && (callOpts.timeoutMs || callOpts.timeout)) || 60000;
    var traced = false;
    var tracing = Core.AI && Core.AI.Tracing;
    if (tracing) {
      tracing.start(runId, { strategy: strategy, intent: 'callThrough', startedAt: Date.now() });
      tracing.recordEvent(runId, { kind: 'entry.callThrough', summary: strategy + ' AI call' });
      traced = true;
    }
    callOpts._t0 = callOpts._t0 || Date.now();
    // 同 run 的 start 在 tracing 内部按 _t0 算 elapsed, 但 tracing.finish 用 (Date.now() - callOpts._t0)
    // 拷贝原 _t0 给 tracing 阶段, 避免后续改写 callOpts._t0 影响 trace 计算
    var traceStart = callOpts._t0;

    async function _doCall() {
      if (Core.AI && typeof Core.AI.callWithTimeout === 'function') {
        return await Core.AI.callWithTimeout(callOpts);
      }
      // 兜底: 手动 AbortController + race (vm sandbox 等场景)
      if (typeof AbortController === 'function' && typeof fetch === 'function') {
        var ac = new AbortController();
        var timer = setTimeout(function () { ac.abort('timeout'); }, timeoutMs);
        try {
          return await Core.AI.call(Object.assign({}, callOpts, { signal: ac.signal }));
        } finally {
          clearTimeout(timer);
        }
      }
      return await Core.AI.call(callOpts);
    }

    var text;
    try {
      text = await _doCall();
    } catch (e) {
      if (traced) {
        try {
          tracing.recordEvent(runId, { kind: 'error', summary: strategy + ' AI call 失败: ' + (e.message || String(e)).slice(0, 80) });
          tracing.finish(runId, { ok: false, totalMs: Date.now() - traceStart, finishedAt: Date.now() });
          var p = tracing.flush(runId);
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (traceErr) {
          // tracing 内部状态不完整 (例如 vm sandbox 中只有 mock), 不污染主路径
          console.warn('[Entry] tracing 收尾失败 (忽略):', traceErr && traceErr.message || traceErr);
        }
      }
      throw e;
    }

    if (traced) {
      try {
        tracing.recordEvent(runId, { kind: 'entry.callThrough.done', summary: strategy + ' AI call 完成, 长度 ' + (text ? text.length : 0) });
        tracing.finish(runId, { ok: true, totalMs: Date.now() - traceStart, finishedAt: Date.now() });
        var p = tracing.flush(runId);
        if (p && typeof p.catch === 'function') p.catch(function (e) { console.warn('[Entry] callThrough flush 失败:', e); });
      } catch (traceErr) {
        console.warn('[Entry] tracing 收尾失败 (忽略):', traceErr && traceErr.message || traceErr);
      }
    }
    return text;
  }

  window.Core.AI.Entry = { register: register, run: run, list: list, callThrough: callThrough };
  console.log('[Entry] AI 编排统一入口已就绪');
})();
