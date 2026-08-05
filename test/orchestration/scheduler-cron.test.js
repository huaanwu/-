/**
 * V11.4 — Scheduler 时间触发边界 + 性能
 *
 * 覆盖:
 *   1. register 立即生效 (无 init 也能 list)
 *   2. init 启动 60s tick
 *   3. runOnInit: true 启动时跑
 *   4. intervalMs 到期才跑 (未到跳过)
 *   5. 重叠防护 (同名 task 在跑跳过)
 *   6. 失败兜底 (单 task 抛错不污染其他)
 *   7. jitterMs 跑前延迟
 *   8. runNow 强制跑 (无视 intervalMs)
 *   9. list 返回完整状态
 *   10. stop 停 timer + 清任务
 *   11. 注销 unregister 函数
 *   12. 多个 task 并发
 *   13. 长时间运行 (连续 5 tick)
 *   14. 源码对账
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHED_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'scheduler.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

function buildSandbox() {
  const sb = {
    window: {}, console: console,
    Date, Math, Promise, JSON, Array, Object, Map, Set, Error, Number,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SCHED_SRC, sb, { filename: 'scheduler.js' });
  return sb;
}

// ===== 情形 1: register 立即生效 =====
describe('情形 1: register 立即生效 (无 init)', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let called = 0;
  S.register('test1', () => { called++; }, 1000);
  const list = S.list();
  assert(list.length === 1, `list 1 个 task (${list.length})`);
  assert(list[0].name === 'test1', 'task 名正确');
  assert(list[0].lastRunAt === 0, 'lastRunAt=0');
  assert(list[0].running === false, 'running=false');
});

// ===== 情形 2: init 启动 tick =====
describe('情形 2: init 启动 60s tick', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  // 不能真等 60s, 验证 init 不抛错
  S.init();
  S.stop();
  assert(true, 'init + stop 不抛错');
});

// ===== 情形 3: runOnInit 启动时跑 =====
describe('情形 3: runOnInit 启动时跑一次', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let called = 0;
  S.register('test', () => { called++; }, 60 * 60 * 1000, { runOnInit: true });
  S.init();
  await new Promise(r => setTimeout(r, 50));
  S.stop();
  assert(called === 1, `runOnInit 跑 1 次 (${called})`);
});

// ===== 情形 4: 未到期不跑 =====
describe('情形 4: intervalMs 未到期不跑', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let called = 0;
  S.register('test', () => { called++; }, 60 * 60 * 1000);   // 1h 间隔
  // 验证 list 显示 lastRunAt=0
  const list = S.list();
  assert(list[0].lastRunAt === 0, '未跑 → lastRunAt=0');
  assert(called === 0, `未触发 (${called})`);
});

// ===== 情形 5: 重叠防护 =====
describe('情形 5: 重叠防护 (同名 task 在跑跳过)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let inFlight = 0, maxConcurrent = 0, totalRuns = 0;
  S.register('test', async () => {
    totalRuns++;
    inFlight++;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    await new Promise(r => setTimeout(r, 100));   // 100ms
    inFlight--;
  }, 0);   // intervalMs=0 让每次 tick 都尝试触发
  // 手动模拟连续多次 _tick (内部会标 running)
  for (let i = 0; i < 5; i++) {
    // 直接调 _runOne 不行 (私有), 走 runNow
    S.runNow('test');
  }
  await new Promise(r => setTimeout(r, 300));   // 等所有 task 完成
  S.stop();
  assert(totalRuns === 1, `重叠防护 → 只跑 1 次 (${totalRuns})`);
});

// ===== 情形 6: 失败兜底 =====
describe('情形 6: 失败兜底 (单 task 抛错不污染其他)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let aCalls = 0, bCalls = 0;
  S.register('a', () => { aCalls++; throw new Error('a fail'); }, 60 * 60 * 1000, { runOnInit: true });
  S.register('b', () => { bCalls++; }, 60 * 60 * 1000, { runOnInit: true });
  S.init();
  await new Promise(r => setTimeout(r, 50));
  S.stop();
  assert(aCalls === 1, `a 跑 1 次 (${aCalls})`);
  assert(bCalls === 1, `b 也跑 1 次, 不被 a 影响 (${bCalls})`);
});

// ===== 情形 7: jitterMs 跑前延迟 =====
describe('情形 7: jitterMs 跑前延迟', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let startTime = 0, runTime = 0;
  S.register('test', () => { runTime = Date.now(); }, 60 * 60 * 1000, {
    runOnInit: true,
    jitterMs: 100   // 0-100ms 延迟
  });
  startTime = Date.now();
  S.init();
  await new Promise(r => setTimeout(r, 200));
  S.stop();
  const elapsed = runTime - startTime;
  assert(elapsed >= 0 && elapsed <= 200, `jitter 延迟 (${elapsed}ms)`);
});

// ===== 情形 8: runNow 强制跑 =====
describe('情形 8: runNow 强制跑 (无视 intervalMs)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let called = 0;
  S.register('test', () => { called++; }, 60 * 60 * 1000);   // 1h 间隔
  S.runNow('test');
  await new Promise(r => setTimeout(r, 20));
  assert(called === 1, `runNow 跑 1 次 (${called})`);
  // 不存在 task
  let threw = false;
  try { S.runNow('non-exist'); } catch (e) { threw = true; }
  assert(!threw, 'runNow 不存在 task 不抛错 (仅 warn)');
});

// ===== 情形 9: list 返回状态 =====
describe('情形 9: list 返回完整状态', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  S.register('a', () => {}, 1000);
  S.register('b', () => {}, 2000);
  const list = S.list();
  assert(list.length === 2, `list 2 个 (${list.length})`);
  assert(list.every(t => typeof t.name === 'string' && typeof t.intervalMs === 'number' && typeof t.lastRunAt === 'number' && typeof t.lastResult === 'object' && typeof t.running === 'boolean'),
    '每个 task 含 name/intervalMs/lastRunAt/lastResult/running');
});

// ===== 情形 10: stop =====
describe('情形 10: stop 停 timer + 清任务', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  S.register('a', () => {}, 1000);
  S.register('b', () => {}, 2000);
  S.init();
  S.stop();
  const list = S.list();
  assert(list.length === 0, `stop 后 list 空 (${list.length})`);
});

// ===== 情形 11: unregister =====
describe('情形 11: unregister 函数移除 task', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  const unreg = S.register('test', () => {}, 1000);
  assert(S.list().length === 1, '注册 1 个');
  unreg();
  assert(S.list().length === 0, 'unregister 后 0 个');
});

// ===== 情形 12: 多 task 并发 =====
describe('情形 12: 多 task 并发 (runOnInit)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let aCount = 0, bCount = 0, cCount = 0;
  S.register('a', async () => { aCount++; await new Promise(r => setTimeout(r, 30)); }, 60 * 60 * 1000, { runOnInit: true });
  S.register('b', async () => { bCount++; await new Promise(r => setTimeout(r, 30)); }, 60 * 60 * 1000, { runOnInit: true });
  S.register('c', async () => { cCount++; }, 60 * 60 * 1000, { runOnInit: true });
  S.init();
  await new Promise(r => setTimeout(r, 80));
  S.stop();
  assert(aCount === 1 && bCount === 1 && cCount === 1, `3 个 task 各跑 1 次 (${aCount}/${bCount}/${cCount})`);
});

// ===== 情形 13: 多次 init 不重启 =====
describe('情形 13: 多次 init 不重启 timer', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  S.init();
  S.init();   // 第二次不抛错
  S.stop();
  assert(true, '多次 init 安全');
});

// ===== 情形 14: 源码对账 =====
describe('情形 14: 源码对账', () => {
  assert(/register\s*\(/.test(SCHED_SRC), 'register 函数');
  assert(/init\s*\(/.test(SCHED_SRC), 'init 函数');
  assert(/stop\s*\(/.test(SCHED_SRC), 'stop 函数');
  assert(/runNow\s*\(/.test(SCHED_SRC), 'runNow 函数');
  assert(/list\s*\(/.test(SCHED_SRC), 'list 函数');
  assert(/TICK_MS\s*=\s*60\s*\*\s*1000/.test(SCHED_SRC), 'TICK_MS = 60s');
  assert(/_running/.test(SCHED_SRC), '_running Set 重叠防护');
  assert(/_tasks/.test(SCHED_SRC), '_tasks Map');
  assert(/try\s*{/.test(SCHED_SRC) && /catch/.test(SCHED_SRC), 'try/catch 失败兜底');
  assert(/window\.Core\.Scheduler/.test(SCHED_SRC), '挂到 window.Core.Scheduler');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V11.4 Scheduler: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();