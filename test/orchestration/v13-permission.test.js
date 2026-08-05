/**
 * V13 阶段 5.2 测试 — W 类飞书确认卡片 (permission.js)
 *
 * 覆盖:
 *   1. 构造 + status()
 *   2. attachTo 后才能 askConfirm
 *   3. askConfirm 发卡片 + 返回 promise (未操作挂起)
 *   4. handleAction(confirm) → resolve(true)
 *   5. handleAction(cancel) → resolve(false)
 *   6. 不存在 askId → handleAction 返 false
 *   7. 超时自动 cancel (短 timeout)
 *   8. cancel() 手动取消
 *   9. status() 含 pending ask
 *  10. clearAll 清空所有 (resolve(false))
 *  11. sendCard 失败 → askConfirm 抛
 *  12. 多个并发 ask 独立 handle
 *  13. askId 唯一
 */
'use strict';

const Module = require('module');
const origLoad = Module._load;
const _axiosMock = { posts: [], responses: new Map() };

const fakeAxios = {
  post(url, data, opts) {
    _axiosMock.posts.push({ url, data, opts });
    if (url.includes('/auth/v3/tenant_access_token/internal')) {
      return Promise.resolve({ data: { code: 0, tenant_access_token: 'mock-t', expire: 7200 } });
    }
    if (url.includes('/im/v1/messages') && data?.card) {
      return Promise.resolve({ data: { code: 0, data: { message_id: 'card-msg-' + _axiosMock.posts.length } } });
    }
    if (url.includes('/im/v1/messages') && data?.msg_type === 'text') {
      return Promise.resolve({ data: { code: 0, data: { message_id: 'text-msg-' + _axiosMock.posts.length } } });
    }
    return Promise.resolve({ data: { code: 0 } });
  },
  get: () => Promise.resolve({ data: { code: 0 } })
};
Module._load = function (req, parent, isMain) {
  if (req === 'axios') return fakeAxios;
  return origLoad.apply(this, arguments);
};

const { Permission } = require('../../electron/permission');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

async function waitMs(ms) { return new Promise(r => setTimeout(r, ms)); }

// fake feishuApp, 只暴露 sendCard / sendText
function makeFakeFeishu(opts = {}) {
  return {
    sendCard: async (openId, card) => {
      if (opts.cardFail) return { ok: false, error: 'mocked card fail' };
      return { ok: true, messageId: 'card-1' };
    },
    sendText: async (openId, text) => ({ ok: true, messageId: 'text-1' })
  };
}

(async () => {
  // ===== 情形 1: 构造 + status =====
  console.log('\n情形 1: 构造');
  {
    const p = new Permission();
    assert(typeof p.askConfirm === 'function', '有 askConfirm');
    assert(typeof p.handleAction === 'function', '有 handleAction');
    assert(p.status().length === 0, '初始 status 空');
  }

  // ===== 情形 2: 没 attachTo → askConfirm 抛 =====
  console.log('\n情形 2: 未 attachTo 抛错');
  {
    const p = new Permission();
    let err = null;
    try { await p.askConfirm('ou_x', 'tool.a', {}); }
    catch (e) { err = e; }
    assert(err !== null && /attachTo/.test(err.message), '抛错含 attachTo');
  }

  // ===== 情形 3: askConfirm 发卡片, 未操作挂起 =====
  console.log('\n情形 3: askConfirm 发卡片');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    let resolved = null;
    const prom = p.askConfirm('ou_user', 'paper.submitTrade', { code: '600519', shares: 100 }).then(r => { resolved = r; });
    await waitMs(50);
    assert(resolved === null, '未操作时 promise 未 resolve');
    assert(p.status().length === 1, 'pending 1 个 ask');
    const ask = p.status()[0];
    assert(ask.tool === 'paper.submitTrade', 'tool 正确');
    assert(ask.openId === 'ou_user', 'openId 正确');
    assert(ask.args.code === '600519', 'args.code 正确');
    // 让 promise 完成以免 hang 测试
    p.handleAction(ask.askId, 'cancel');
    await prom;
    assert(resolved === false, 'cancel → resolve(false)');
  }

  // ===== 情形 4: handleAction confirm → true =====
  console.log('\n情形 4: confirm');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    let resolved = null;
    const prom = p.askConfirm('ou_x', 'paper.submitTrade', {}).then(r => { resolved = r; });
    await waitMs(30);
    const ask = p.status()[0];
    const handled = p.handleAction(ask.askId, 'confirm');
    assert(handled === true, 'handleAction 返 true');
    await prom;
    assert(resolved === true, 'confirm → resolve(true)');
    assert(p.status().length === 0, 'ask 已移除');
  }

  // ===== 情形 5: handleAction cancel =====
  console.log('\n情形 5: cancel');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    let resolved = null;
    const prom = p.askConfirm('ou_x', 'watchlist.add', {}).then(r => { resolved = r; });
    await waitMs(30);
    const ask = p.status()[0];
    p.handleAction(ask.askId, 'cancel');
    await prom;
    assert(resolved === false, 'cancel → false');
  }

  // ===== 情形 6: 不存在 askId =====
  console.log('\n情形 6: 不存在 askId');
  {
    const p = new Permission();
    p.attachTo(makeFakeFeishu());
    const r = p.handleAction('ask-nonexistent', 'confirm');
    assert(r === false, '返 false');
  }

  // ===== 情形 7: 超时自动 cancel =====
  console.log('\n情形 7: 超时自动');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 100 });
    p.attachTo(feishu);
    let resolved = null;
    const prom = p.askConfirm('ou_x', 'paper.submitTrade', {}).then(r => { resolved = r; });
    await waitMs(200);
    assert(resolved === false, `超时 resolve(false) (${resolved})`);
    assert(p.status().length === 0, 'ask 已清理');
  }

  // ===== 情形 8: cancel() 手动 =====
  console.log('\n情形 8: cancel() 手动');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    let resolved = null;
    const prom = p.askConfirm('ou_x', 'paper.submitTrade', {}).then(r => { resolved = r; });
    await waitMs(30);
    const ask = p.status()[0];
    const ok = p.cancel(ask.askId);
    assert(ok === true, 'cancel 返 true');
    await prom;
    assert(resolved === false, 'manual cancel → false');
  }

  // ===== 情形 9: status 含 pending =====
  console.log('\n情形 9: status 查询');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    const prom1 = p.askConfirm('ou_a', 't1', {});
    const prom2 = p.askConfirm('ou_b', 't2', {});
    await waitMs(30);
    assert(p.status().length === 2, '2 个 pending');
    const tools = p.status().map(s => s.tool).sort();
    assert(tools[0] === 't1' && tools[1] === 't2', '2 个不同 tool');
    // 清理
    p.clearAll();
    await prom1; await prom2;
  }

  // ===== 情形 10: clearAll =====
  console.log('\n情形 10: clearAll');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    let r1 = null, r2 = null;
    const prom1 = p.askConfirm('ou_a', 't1', {}).then(r => { r1 = r; });
    const prom2 = p.askConfirm('ou_b', 't2', {}).then(r => { r2 = r; });
    await waitMs(30);
    p.clearAll();
    await prom1; await prom2;
    assert(r1 === false && r2 === false, '两个都 resolve(false)');
    assert(p.status().length === 0, 'status 空');
  }

  // ===== 情形 11: sendCard 失败 → askConfirm 抛 =====
  console.log('\n情形 11: sendCard 失败');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu({ cardFail: true });
    const p = new Permission();
    p.attachTo(feishu);
    let err = null;
    try { await p.askConfirm('ou_x', 'tool.a', {}); }
    catch (e) { err = e; }
    assert(err !== null && /发卡片失败/.test(err.message), `抛错含发卡片: ${err?.message}`);
  }

  // ===== 情形 12: 多个并发 ask 独立 =====
  console.log('\n情形 12: 多并发独立');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    const r1 = p.askConfirm('ou_a', 't1', {});
    const r2 = p.askConfirm('ou_b', 't2', {});
    await waitMs(30);
    const asks = p.status();
    assert(asks.length === 2, '2 个独立 ask');
    // 只 confirm 第一个
    p.handleAction(asks[0].askId, 'confirm');
    p.handleAction(asks[1].askId, 'cancel');
    const v1 = await r1, v2 = await r2;
    assert(v1 === true && v2 === false, '独立 resolve');
  }

  // ===== 情形 13: askId 唯一 =====
  console.log('\n情形 13: askId 唯一');
  {
    _axiosMock.posts = [];
    const feishu = makeFakeFeishu();
    const p = new Permission({ timeoutMs: 10000 });
    p.attachTo(feishu);
    const ids = new Set();
    for (let i = 0; i < 10; i++) {
      const prom = p.askConfirm('ou_x', 't' + i, {});
      await waitMs(5);
      const all = p.status();
      ids.add(all[all.length - 1].askId);
    }
    assert(ids.size === 10, `10 个 askId 全唯一 (实际=${ids.size})`);
    p.clearAll();
  }

  console.log('\n' + '='.repeat(50));
  console.log(`V13 Permission: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();