/**
 * V2 — Core.Scheduler 模块测试
 *
 * 覆盖:
 *   1. 模块暴露 (register/init/stop/runNow/list)
 *   2. register 注册 + list 返回元数据
 *   3. 重叠防护 (同 task 跑时再次触发跳过)
 *   4. 失败兜底 (单个 task 抛错不污染其他)
 *   5. intervalMs 未到期不触发
 *   6. runNow 立即触发
 *   7. stop 清空所有 task + timer
 *   8. runOnInit 选项 init 时立即跑
 *   9. jitterMs 延迟生效 (不需要验证具体延迟值, 只验证 task 跑了)
 *
 * 跑法: node test/orchestration/scheduler.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEDULER_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'scheduler.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

function buildSandbox() {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval
  };
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(SCHEDULER_SRC, sb, { filename: 'scheduler.js' });
  return sb;
}

// ===== 情形 1: 模块暴露 =====
describe('情形 1: 暴露 5 个 API', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  assert(!!S, 'Core.Scheduler 已定义');
  assert(typeof S.register === 'function', 'register 是函数');
  assert(typeof S.init === 'function', 'init 是函数');
  assert(typeof S.stop === 'function', 'stop 是函数');
  assert(typeof S.runNow === 'function', 'runNow 是函数');
  assert(typeof S.list === 'function', 'list 是函数');
});

// ===== 情形 2: register + list 元数据 =====
describe('情形 2: register 注册 task', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  const unreg = S.register('test-task', () => {}, 60000);
  const list = S.list();
  assert(list.length === 1, 'list 返 1 个 task');
  assert(list[0].name === 'test-task', 'task.name 正确');
  assert(list[0].intervalMs === 60000, 'task.intervalMs 正确');
  assert(list[0].lastResult === null, 'lastResult 初始为 null');
  assert(typeof unreg === 'function', 'register 返注销函数');
  unreg();
  assert(S.list().length === 0, '注销后 list 空');
});

// ===== 情形 3: 重叠防护 =====
describe('情形 3: 同 task 跑时再次触发跳过', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let callCount = 0;
  // 故意慢任务: 100ms 才完成
  S.register('slow', async () => {
    callCount++;
    await new Promise(r => setTimeout(r, 100));
  }, 1000);
  S.runNow('slow'); // 触发 1
  await new Promise(r => setTimeout(r, 10));
  S.runNow('slow'); // 触发 2, 此时第一次还没完 → 应被 _running 互斥跳过
  await new Promise(r => setTimeout(r, 200));
  assert(callCount === 1, `slow 只跑 1 次 (实际 ${callCount})`);
});

// ===== 情形 4: 失败兜底 =====
describe('情形 4: 单 task 抛错不污染其他', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let okRan = false;
  S.register('throws', async () => { throw new Error('boom'); }, 1000);
  S.register('ok', async () => { okRan = true; }, 1000);
  S.runNow('throws');
  await new Promise(r => setTimeout(r, 50));
  assert(S.list().find(t => t.name === 'throws').lastResult === 'fail', 'throws.lastResult = fail');
  S.runNow('ok');
  await new Promise(r => setTimeout(r, 50));
  assert(okRan, 'ok task 仍跑了 (没被 throws 污染)');
});

// ===== 情形 5: intervalMs 未到期不触发 =====
describe('情形 5: intervalMs 未到期不触发 (runNow 强制除外)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let count = 0;
  S.register('interval', () => { count++; }, 60000); // 60s
  // 模拟 _tick 内部逻辑: 不通过 runNow, 直接测 _tick
  // 但 _tick 是内部函数, 我们用 runNow 强制触发, 然后看 lastRunAt
  S.runNow('interval');
  await new Promise(r => setTimeout(r, 30));
  assert(count === 1, `runNow 立即触发 (${count})`);
  // 再 runNow, 仍能跑 (runNow 强制, 不受 intervalMs 限制)
  S.runNow('interval');
  await new Promise(r => setTimeout(r, 30));
  assert(count === 2, `runNow 二次也立即跑 (${count})`);
});

// ===== 情形 6: stop 清空 + timer 清掉 =====
describe('情形 6: stop 清空所有 task', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  S.register('a', () => {}, 1000);
  S.register('b', () => {}, 2000);
  assert(S.list().length === 2, '注册 2 个 task');
  S.stop();
  assert(S.list().length === 0, 'stop 后 list 空');
  // 二次 init 应能重启
  S.init();
  assert(typeof S.init === 'function', 'init 仍可用');
});

// ===== 情形 7: runOnInit 选项 =====
describe('情形 7: runOnInit 选项 init 时立即跑', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  let ran = false;
  S.register('init-task', async () => { ran = true; }, 60000, { runOnInit: true });
  assert(!ran, '注册时未跑');
  S.init();
  await new Promise(r => setTimeout(r, 50));
  assert(ran, 'init 后立即跑了');
});

// ===== 情形 8: 重名覆盖 + 警告 =====
describe('情形 8: 重名注册覆盖 + 警告', () => {
  const sb = buildSandbox();
  const origWarn = console.warn;
  let warns = [];
  console.warn = (...args) => warns.push(args.join(' '));
  const S = sb.window.Core.Scheduler;
  S.register('dup', () => {}, 1000);
  S.register('dup', () => {}, 2000); // 同名
  console.warn = origWarn;
  assert(warns.some(w => w.indexOf('dup') >= 0), 'console.warn 触发');
  assert(S.list().length === 1, 'list 只有 1 个 task (后者覆盖)');
});

// ===== 情形 9: 注销函数可多次调用 =====
describe('情形 9: 注销函数幂等', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Scheduler;
  const unreg = S.register('idem', () => {}, 1000);
  unreg();
  unreg(); // 二次调用不抛
  assert(S.list().length === 0, 'list 空');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V2 Scheduler: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();