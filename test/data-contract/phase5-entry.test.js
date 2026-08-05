/**
 * Phase 5 跨策略隔离回归测试
 *
 * 覆盖:
 *   1. Entry.run 注册 4 个 strategy + agents 后, list() 返回 5 个
 *   2. 未注册的 strategy → ok:false + 未知 strategy 错误
 *   3. register 同名 strategy 抛 TypeError (幂等性)
 *   4. Entry.run 返回统一 shape: { strategy, runId, ok, data, summary, latencyMs }
 *   5. Entry.run 透传 runId 给 handler
 *   6. Entry.run 失败降级: handler 抛错 → ok:false + error 字段
 *   7. Entry.run 走 Tracing (Tracing 不可用时静默跳过, 不影响主流程)
 *
 * 跑法: node test/data-contract/phase5-entry.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ENTRY_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'entry.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// 构造最小 Core mock (仅 Entry 需要的依赖)
function buildCore(opts = {}) {
  const handlers = opts.handlers || {};
  const tracing = opts.tracing;
  const sandbox = {
    window: {},
    console: { log: () => {}, warn: () => {}, error: () => {} }
  };
  sandbox.window.Core = {
    AI: {
      Tracing: tracing,
      Orchestrator: opts.orchestrator,
      Agents: opts.agents || {
        runPipeline: async () => ({ ok: true, summary: 'agents pipeline' })
      },
      call: async () => 'mock-ai-text',
      callWithTimeout: async () => 'mock-ai-text'
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(ENTRY_SRC, sandbox, { filename: 'entry.js' });
  return { sandbox, Entry: sandbox.window.Core.AI.Entry };
}

// ============================================================
// 情形 1: 4 个 strategy 注册 + agents 自注册
// ============================================================
describe('情形 1: register 4 个 strategy + agents 自注册, list 返 5 个', () => {
  const { Entry } = buildCore();
  Entry.register('long', { description: 'long' }, async () => ({ ok: true }));
  Entry.register('short', { description: 'short' }, async () => ({ ok: true }));
  Entry.register('fund', { description: 'fund' }, async () => ({ ok: true }));
  Entry.register('alerts', { description: 'alerts' }, async () => ({ ok: true }));
  const list = Entry.list();
  const keys = Object.keys(list).sort();
  assert(keys.length === 5, `5 个 strategy 已注册 (${keys.join(',')})`);
  assert(keys.includes('agents'), '含 agents (自注册)');
  assert(keys.includes('long') && keys.includes('short') && keys.includes('fund') && keys.includes('alerts'), '含 long/short/fund/alerts');
  assert(list.long.risk === 'M', 'long 默认 risk=M');
  assert(list.long.version === 'v1', 'long 默认 version=v1');
});

// ============================================================
// 情形 2: 未注册的 strategy → ok:false
// ============================================================
describe('情形 2: 未注册的 strategy → 返 ok:false + 未知 strategy 错误', async () => {
  const { Entry } = buildCore();
  const r = await Entry.run({ strategy: 'unknown_xyz', ctx: {}, opts: {} });
  assert(r.ok === false, 'ok=false');
  assert(/未知 strategy/.test(r.summary), 'summary 含「未知 strategy」');
  assert(/未注册/.test(r.error), 'error 含「未注册」');
  assert(r.strategy === 'unknown_xyz', 'strategy 字段保留');
});

// ============================================================
// 情形 3: register 同名 strategy 抛 TypeError
// ============================================================
describe('情形 3: register 同名 strategy 抛错 (幂等性)', () => {
  const { Entry } = buildCore();
  Entry.register('dup', { description: 'first' }, async () => ({ ok: true }));
  let threw = false;
  try {
    Entry.register('dup', { description: 'second' }, async () => ({ ok: true }));
  } catch (e) {
    threw = /已注册/.test(e.message);
  }
  assert(threw, '同名 register 抛「已注册」错误');
});

// ============================================================
// 情形 4: run 返回统一 shape + runId 生成
// ============================================================
describe('情形 4: run 返回统一 shape + runId 生成', async () => {
  const { Entry } = buildCore();
  Entry.register('test', { description: 'test' }, async (ctx, opts) => ({
    ok: true, data: { seenRunId: opts.runId }, summary: 'ok', raw: 'r', error: null
  }));
  const r = await Entry.run({ strategy: 'test', ctx: {}, opts: {} });
  assert(r.strategy === 'test', 'strategy=test');
  assert(/^strat-test-/.test(r.runId), 'runId 以 strat-test- 开头');
  assert(r.ok === true, 'ok=true');
  assert(r.summary === 'ok', 'summary 透传');
  assert(r.latencyMs > 0, 'latencyMs > 0');
  assert(r.data.seenRunId === r.runId, 'handler 拿到的 runId == Entry.run 返回的 runId');
});

// ============================================================
// 情形 5: 外部传入 runId → handler 收到同一 runId
// ============================================================
describe('情形 5: 外部 runId 透传给 handler', async () => {
  const { Entry } = buildCore();
  Entry.register('test', {}, async (ctx, opts) => ({ ok: true, data: { seen: opts.runId } }));
  const r = await Entry.run({ strategy: 'test', ctx: {}, opts: { runId: 'outer-123' } });
  assert(r.runId === 'outer-123', 'runId 沿用外部传入');
  assert(r.data.seen === 'outer-123', 'handler opts.runId == 外部 runId');
});

// ============================================================
// 情形 6: handler 抛错 → ok:false + error 捕获
// ============================================================
describe('情形 6: handler 抛错 → 降级返 ok:false', async () => {
  const { Entry } = buildCore();
  Entry.register('boom', {}, async () => { throw new Error('handler 炸了'); });
  const r = await Entry.run({ strategy: 'boom', ctx: {}, opts: {} });
  assert(r.ok === false, 'ok=false');
  assert(/handler 炸了/.test(r.error), 'error 含 handler 异常消息');
  assert(/boom 失败/.test(r.summary), 'summary 含「boom 失败」');
  assert(typeof r.latencyMs === 'number', 'latencyMs 仍计算 (即使失败)');
});

// ============================================================
// 情形 7: Tracing 不可用时静默 (不抛错)
// ============================================================
describe('情形 7: Tracing 不可用 → 静默跳过', async () => {
  const { Entry } = buildCore({ tracing: undefined });
  Entry.register('x', {}, async () => ({ ok: true, summary: 's' }));
  const r = await Entry.run({ strategy: 'x', ctx: {}, opts: {} });
  assert(r.ok === true, 'Tracing 缺失不影响 run 结果');
});

// ============================================================
// 情形 8: handler 返 null/undefined → Entry 不崩溃
// ============================================================
describe('情形 8: handler 返 null → Entry 不崩溃, 保留 runId', async () => {
  const { Entry } = buildCore();
  Entry.register('weird', {}, async () => null);
  const r = await Entry.run({ strategy: 'weird', ctx: {}, opts: {} });
  assert(r != null, 'Entry 不崩溃, 返对象');
  assert(r.strategy === 'weird', 'strategy 字段保留');
  assert(/^strat-weird-/.test(r.runId), 'runId 仍生成');
});

// ============================================================
// ============ 超时保护 (P0 阻塞: callThrough 必须保留 AbortController 语义) ============
describe('超时保护: callThrough 必须保留 AbortController 语义', async () => {
  // Mock Core.AI: 有 callWithTimeout (走真 abort) + call (兜底)
  function buildCoreWithTimeout(callImpl) {
    const storageSrc = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
    const utilSrc = fs.readFileSync(path.join(ROOT, 'www', 'core', 'util.js'), 'utf8');
    const aiServiceSrc = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai-service.js'), 'utf8');
    const tracingSrc = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'tracing.js'), 'utf8');
    const entrySrc = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'entry.js'), 'utf8');
    // 提供 Core.AI 全套 mock, 让 Core.AI.call 走我们自己的 callImpl,
    // 避免加载 ai-service.js 后调真实 fetch
    const sb = {
      console,
      Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
      JSON, Array, Object, Map, Set, Error, Number, AbortController, fetch,
      Core: {
        AI: {
          call: callImpl,
          callWithTimeout: callImpl,
        }
      }
    };
    sb.window = sb;
    sb.global = sb;
    vm.createContext(sb);
    vm.runInContext(storageSrc, sb);
    vm.runInContext(utilSrc, sb);
    vm.runInContext(aiServiceSrc, sb);
    vm.runInContext(tracingSrc, sb);
    // ai-service.js 加载后会用真实 call/callWithTimeout 覆盖 Core.AI 暴露, 把 mock 重新放回去
    sb.Core.AI.call = callImpl;
    sb.Core.AI.callWithTimeout = callImpl;
    // 重新注册 Entry (entry.js 之前已经从我们最初的 mock 读 Core.AI, 用 patched mode 即可)
    vm.runInContext(entrySrc, sb);
    // 加载 entry.js 后, 它会读 Core.AI.Tracing/Entry 并调用; 我们的 mock 已就位
    // 但 Core.AI.call/callWithTimeout 也已被我们接管, 不会走真实 fetch
    return sb;
  }

  function _assert(cond, msg) { cond ? console.log('  ✓ ' + msg) : (console.error('  ✗ ' + msg), fail = (fail || 0) + 1); pass = (pass || 0) + 1; }
  function _assertEq(actual, expected, msg) { _assert(actual === expected, msg + ' (期望 ' + JSON.stringify(expected) + ' 实际 ' + JSON.stringify(actual) + ')'); }

  // 5.1 走 callWithTimeout — callWithTimeout 用 setTimeout 在 timeoutMs 后 abort,
  // 我们的 mock callImpl 监听 signal, abort 时立刻 reject
  // 因为 buildCoreWithTimeout 把 callWithTimeout 和 call 都指向 callImpl, 走 callWithTimeout 分支
  await new Promise(resolve => {
    const t0 = Date.now();
    const callImpl = (opts) => new Promise((_, reject) => {
      if (opts && opts.signal) {
        const onAbort = () => reject(new Error('AI 调用超时 (mock)'));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort);
      }
    });
    const sb = buildCoreWithTimeout(callImpl);
    sb.Core.AI.Entry.callThrough({ timeoutMs: 30, systemPrompt: 'x', prompt: 'y' }, 'short')
      .then(() => resolve(_assert(false, '超时: 应抛错')))
      .catch(e => {
        const dt = Date.now() - t0;
        if (!/超时/.test(e.message)) _assert(false, '错误不含超时: ' + e.message);
        else if (dt < 5 || dt > 800) _assert(false, '5.1 超时耗时异常 ' + dt + 'ms (expect 5~800)');
        else _assert(true, '走 callWithTimeout: 30ms 超时保护生效 (耗时 ' + dt + 'ms)');
        resolve();
      });
  });

  // 5.2 兜底: 没有 callWithTimeout 时手动 AbortController
  await new Promise(resolve => {
    // 兜底分支: 没 callWithTimeout, callThrough 用 AbortController + signal
    // mock 的 callImpl 监听 signal, abort 时立刻 reject
    const callImpl = (opts) => new Promise((_, reject) => {
      if (opts && opts.signal) {
        const onAbort = () => reject(new Error('Aborted (timeout)'));
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort);
      }
    });
    const sb = buildCoreWithTimeout(callImpl);
    // 移除 callWithTimeout, 只留 call, 走兜底分支
    delete sb.Core.AI.callWithTimeout;
    sb.Core.AI.Entry.callThrough({ timeoutMs: 30, systemPrompt: 'x', prompt: 'y' }, 'long')
      .then(() => resolve(_assert(false, '兜底超时: 应抛错')))
      .catch(e => {
        if (!/超时|abort|Aborted/i.test(e.message)) {
          _assert(false, '兜底超时: 错误信息异常: ' + e.message);
        } else {
          _assert(true, '兜底超时保护生效 (无 callWithTimeout, 用 AbortController + signal)');
        }
        resolve();
      });
  });
});

// 情形 9: callThrough 不传 strategy → 走 default
// ============================================================
describe('情形 9: callThrough 不传 strategy → 走 default', async () => {
  const { Entry, sandbox } = buildCore();
  // callThrough 内部调 Core.AI.call, mock 返回
  const r = await Entry.callThrough({ systemPrompt: 's', prompt: 'p' });
  assert(r === 'mock-ai-text', 'callThrough 透传 mock-ai-text');
});

// ============================================================
// 情形 10: 跨策略 register 不污染
// ============================================================
describe('情形 10: 跨策略 register 互不污染 (list 仍 5 个)', () => {
  const { Entry } = buildCore();
  Entry.register('a', {}, async () => ({ ok: true }));
  Entry.register('b', {}, async () => ({ ok: true }));
  const list = Entry.list();
  assert(Object.keys(list).length === 3, `agents (自注册) + a + b = 3 (${Object.keys(list).sort().join(',')})`);
  assert(list.a.risk === 'M' && list.b.risk === 'M', '默认 risk=M');
});

(async () => {
  await new Promise(r => setTimeout(r, 100));
  console.log('\n' + '='.repeat(50));
  console.log(`Phase 5 Entry 接通: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();
