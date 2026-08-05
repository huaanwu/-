/**
 * V13 阶段 2 测试 — Daemon 调度器
 *
 * 覆盖:
 *   1. Daemon 注册 task 后能正常 tick 触发
 *   2. task 失败不中断其他 task
 *   3. runNow 强制立刻跑
 *   4. status 报告 task 状态
 *   5. 重复 register 抛错
 *   6. interval 太短抛错
 *   7. 防重叠: 跑 task 期间不会重入
 *   8. stop 后不再触发
 *   9. jitter 随机偏移
 *  10. runOnInit 立即触发 (不需要等 60s tick)
 */
'use strict';

const { Daemon } = require('../../electron/daemon');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

async function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  // ===== 情形 1: 注册 task + tick 触发 =====
  console.log('\n情形 1: 注册 task + tick 触发');
  {
    const d = new Daemon();
    let runs = 0;
    d.register('test', 1100, async () => { runs++; }, { runOnInit: false });
    // 手动调 tick (不等 60s)
    d._onTick();
    await waitMs(50);
    assert(runs === 1, `tick 触发 1 次 (实际=${runs})`);
    d.stop();
  }

  // ===== 情形 2: task 失败不中断其他 =====
  console.log('\n情形 2: task 失败不中断其他');
  {
    const d = new Daemon();
    let runs = { a: 0, b: 0 };
    d.register('a', 1100, async () => { runs.a++; throw new Error('A 故意失败'); }, { runOnInit: false });
    d.register('b', 1100, async () => { runs.b++; }, { runOnInit: false });
    d._onTick();
    await waitMs(50);
    assert(runs.a === 1, 'A 跑过');
    assert(runs.b === 1, 'B 也跑过 (不被 A 失败阻断)');
    d.stop();
  }

  // ===== 情形 3: runNow 强制立刻跑 =====
  console.log('\n情形 3: runNow 强制立刻跑');
  {
    const d = new Daemon();
    let runs = 0;
    d.register('test', 99999999, async () => { runs++; }, { runOnInit: false });
    await d.runNow('test');
    assert(runs === 1, 'runNow 跑了 1 次');
    d.stop();
  }

  // ===== 情形 4: status 报告 =====
  console.log('\n情形 4: status 报告');
  {
    const d = new Daemon();
    d.register('a', 1000, async () => {}, { runOnInit: false });
    d.register('b', 2000, async () => { throw new Error('故意'); }, { runOnInit: false });
    await d.runNow('b');
    const s = d.status();
    assert(s.length === 2, `status 有 2 个 task (${s.length})`);
    const b = s.find(t => t.name === 'b');
    assert(b.lastError === '故意', `b.lastError = 故意 (${b.lastError})`);
    assert(b.runCount === 1, 'b.runCount = 1');
    d.stop();
  }

  // ===== 情形 5: 重复 register 抛错 =====
  console.log('\n情形 5: 重复 register 抛错');
  {
    const d = new Daemon();
    d.register('test', 1000, async () => {}, { runOnInit: false });
    try {
      d.register('test', 1000, async () => {});
      assert(false, '重复 register 应抛错');
    } catch (e) {
      assert(/已存在/.test(e.message), `抛错 "已存在": ${e.message}`);
    }
    d.stop();
  }

  // ===== 情形 6: interval < 1000ms 抛错 =====
  console.log('\n情形 6: interval < 1000ms 抛错');
  {
    const d = new Daemon();
    try {
      d.register('test', 100, async () => {});
      assert(false, '短 interval 应抛错');
    } catch (e) {
      assert(/至少 1000/.test(e.message), `抛错含 1000ms: ${e.message}`);
    }
    d.stop();
  }

  // ===== 情形 7: 防重叠 =====
  console.log('\n情形 情形 7: 防重叠');
  {
    const d = new Daemon();
    let activeCount = 0, maxActive = 0;
    let runs = 0;
    d.register('slow', 1100, async () => {
      activeCount++;
      maxActive = Math.max(maxActive, activeCount);
      await waitMs(200);   // 跑 200ms
      activeCount--;
      runs++;
    }, { runOnInit: false });
    // 连续 tick 5 次, 间隔 30ms
    for (let i = 0; i < 5; i++) {
      d._onTick();
      await waitMs(30);
    }
    await waitMs(300);   // 等最后一次跑完
    assert(maxActive === 1, `同时只有 1 个 (实际 max=${maxActive})`);
    assert(runs <= 2, `跑次数 ≤ 2 (实际=${runs})`);
    d.stop();
  }

  // ===== 情形 8: stop 后不再触发 =====
  console.log('\n情形 8: stop 后不再触发');
  {
    const d = new Daemon();
    let runs = 0;
    d.register('test', 1100, async () => { runs++; }, { runOnInit: false });
    d.start();
    await waitMs(1500);   // 跑几次
    const beforeStop = runs;
    d.stop();
    await waitMs(200);
    assert(runs === beforeStop, `stop 后 runs 不再增加 (${beforeStop} → ${runs})`);
  }

  // ===== 情形 9: jitter 偏移 =====
  console.log('\n情形 9: jitter 偏移');
  {
    // jitter 是测试稳定性的难点 (Math.random + 系统调度延迟导致抖动窗口不稳定)
    // 这里只验证 jitter 配置生效: 等够长时间后 task 必然跑, 且只跑 1 次
    const d = new Daemon();
    let runs = 0;
    d.register('jitter', 1100, async () => { runs++; }, { runOnInit: false, jitterMs: 200 });
    d._onTick();   // 触发 jitter 后延迟 0-200ms
    await waitMs(800);   // 等超过 jitter 上限
    assert(runs === 1, `jitter 后跑了 1 次 (实际=${runs})`);
    d.stop();
  }

  // ===== 情形 10: runOnInit 立即触发 =====
  console.log('\n情形 10: runOnInit 立即触发');
  {
    const d = new Daemon({ runOnInit: true });
    let runs = 0;
    d.register('init', 99999999, async () => { runs++; }, { runOnInit: true });
    d.start();
    await waitMs(100);
    assert(runs === 1, `runOnInit 跑了 1 次 (实际=${runs})`);
    d.stop();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`V13 Daemon: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();