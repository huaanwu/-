/**
 * V13 阶段 5 — PendingConfirmations 单测
 */
'use strict';
const { PendingConfirmations, DEFAULT_TTL_MS } = require('../../electron/feishu-pending');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(a, b, msg) { a === b ? ok(msg) : bad(msg + ' (期望 ' + b + ' 实际 ' + a + ')'); }
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }

function run() {
  setTimeout(() => {
    const p = new PendingConfirmations();
    p.set('ou_a', { tool: 'paper.buy', args: { code: '600519', shares: 100 } });
    const got = p.get('ou_a');
    assertTrue(got != null, '1 set/get 立即返回');
    assertEq(got.tool, 'paper.buy', '1 tool 正确');
    assertEq(got.args.code, '600519', '1 args.code 正确');
    assertTrue(got.expiresAt - got.createdAt >= DEFAULT_TTL_MS - 5, '1 expiresAt 在 TTL 窗口内');

    p.consume('ou_a');
    assertTrue(p.get('ou_a') === null, '2 consume 后 get 返 null');

    const p3 = new PendingConfirmations();
    p3.set('ou_c', { tool: 'paper.buy', args: { shares: 100 } });
    p3.set('ou_c', { tool: 'paper.sell', args: { shares: 200 } });
    assertEq(p3.get('ou_c').tool, 'paper.sell', '3 覆盖 — tool 已是新值');
    assertEq(p3.get('ou_c').args.shares, 200, '3 覆盖 — args.shares 已是新值');

    const p4 = new PendingConfirmations();
    const r = p4.set('ou_d', { args: {} });
    assertTrue(r === null, '4 无 tool 字段 → set 返 null');
    assertTrue(p4.get('ou_d') === null, '4 无 tool → 状态不入栈');

    const p5 = new PendingConfirmations();
    p5.set('ou_e1', { tool: 'paper.buy', args: { shares: 100 } });
    p5.set('ou_e2', { tool: 'paper.sell', args: { shares: 200 } });
    assertEq(p5.get('ou_e1').tool, 'paper.buy', '5 隔离 — e1 仍是 buy');
    assertEq(p5.get('ou_e2').tool, 'paper.sell', '5 隔离 — e2 仍是 sell');

    setTimeout(() => {
      const p6 = new PendingConfirmations({ ttlMs: 20 });
      p6.set('ou_f', { tool: 'paper.buy', args: {} });
      setTimeout(() => {
        assertTrue(p6.get('ou_f') === null, '6 TTL 过期后 get 返 null');
        const p7 = new PendingConfirmations();
        p7.set('ou_g1', { tool: 'paper.buy', args: {} });
        p7.set('ou_g2', { tool: 'paper.sell', args: {} });
        p7.clear();
        assertTrue(p7.get('ou_g1') === null && p7.get('ou_g2') === null, '7 clear 后所有 openId 都清空');

        const p8 = new PendingConfirmations();
        p8.set('ou_h', { tool: 'paper.buy', args: { shares: 50 } });
        const got2 = p8.consume('ou_h');
        assertEq(got2 && got2.tool, 'paper.buy', '8 consume 仍能拿到原值');

        const p9 = new PendingConfirmations({ ttlMs: 80 });
        p9.set('ou_i', { tool: 'paper.buy', args: {} });
        setTimeout(() => p9.set('ou_i', { tool: 'paper.sell', args: {} }), 30);
        setTimeout(() => {
          const got9 = p9.get('ou_i');
          assertTrue(got9 && got9.tool === 'paper.sell', '9 30ms 内重设 → 仍是 sell (TTL 已延长)');
          const p10 = new PendingConfirmations({ ttlMs: 200 });
          p10.set('ou_j1', { tool: 'paper.buy', args: {} });
          setTimeout(() => p10.set('ou_j2', { tool: 'paper.sell', args: {} }), 250);
          setTimeout(() => {
            assertTrue(p10.get('ou_j1') === null, '10 j1 过期后 get 返 null');
            const got10 = p10.get('ou_j2');
            assertTrue(got10 && got10.tool === 'paper.sell', '10 j2 仍有效');
            console.log('========================================');
            console.log('PendingConfirmations: ' + pass + ' 通过 / ' + fail + ' 失败 / ' + (pass + fail) + ' 总数');
            console.log('========================================');
            process.exit(fail > 0 ? 1 : 0);
          }, 300);
        }, 30);
      }, 60);
    }, 0);
  }, 0);
}

run();
