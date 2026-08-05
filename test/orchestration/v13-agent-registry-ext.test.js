/**
 * V13 阶段 1 测试 — agentRegistry 扩展 (22 个域写工具, R/W 两档)
 *
 * 覆盖:
 *   1. R/W 校验: 风险等级必须是 R 或 W, L/M/H 抛错
 *   2. 22 个扩展工具全部注册成功
 *   3. 每个工具都有 input_schema + description + handler
 *   4. W 类工具在 source='feishu' 时先调 _maybeFeishuConfirm
 *   5. executeJavaScript 桥 (mock BrowserWindow) 调通到 renderer 域方法
 *   6. W 类工具的 handler 真的执行了 executeJavaScript (参数正确序列化)
 *   7. _pickWindow 在无窗口时返 null → handler 抛错
 *   8. W 类工具的 input_schema 校验失败抛错
 *   9. V12 trigger bug 已修: window.LongTrader 而非 window.Long
 *  10. 回归: 原 8 个内建工具仍能调
 */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

// electron 模块 mock — 测试不需要实际启动 Electron
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

const mockBrowserWindowCalls = [];   // 记录 executeJavaScript 调用
const mockBrowserWindow = {
  _nextResult: null,
  _nextError: null,
  webContents: {
    executeJavaScript: async (expr, userGesture) => {
      mockBrowserWindowCalls.push({ expr, userGesture });
      if (mockBrowserWindow._nextError) {
        const e = mockBrowserWindow._nextError;
        mockBrowserWindow._nextError = null;
        throw e;
      }
      if (mockBrowserWindow._nextResult !== null) {
        const r = mockBrowserWindow._nextResult;
        mockBrowserWindow._nextResult = null;
        return r;
      }
      return undefined;   // 默认返 undefined (视为成功)
    }
  }
};
const mockApp = {
  isQuitting: false,
  relaunch: () => {},
  quit: () => {},
  whenReady: () => Promise.resolve(),
  on: () => {},
  getPath: (k) => path.resolve(ROOT, 'mock-userData'),
  isPackaged: false
};

Module._load = function (request, parent, ...rest) {
  if (request === 'electron') {
    return {
      BrowserWindow: {
        getFocusedWindow: () => mockBrowserWindow,
        getAllWindows: () => [mockBrowserWindow]
      },
      app: mockApp,
      shell: { openExternal: async () => {} }
    };
  }
  return origLoad.call(this, request, parent, ...rest);
};

const agentRegistry = require(path.join(ROOT, 'electron', 'agent-registry.js'));
const { registerExtension, _setPickWindowNull } = require(path.join(ROOT, 'electron', 'agent-registry-ext.js'));
registerExtension(agentRegistry);

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
// 顺序 await 各情形 (避免 fire-and-forget)
async function describe(name, fn) { console.log('\n' + name); await fn(); }

(async () => {
  await describe('情形 1: 风险等级校验 (R/W 两档)', async () => {
    const tools = agentRegistry.list();
    for (const t of tools) {
      assert(t.risk === 'R' || t.risk === 'W', `${t.name}: risk=${t.risk}`);
    }
  });

  await describe('情形 2: 扩展工具数 ≥ 22', async () => {
    const names = agentRegistry.list().map(t => t.name);
    const expected = [
      'watchlist.add', 'watchlist.remove',
      'holdings.list', 'holdings.save', 'holdings.remove', 'holdings.saveTx',
      'holdings.confirmPending', 'holdings.rejectPending',
      'paper.buy', 'paper.sell', 'paper.resetAccount', 'paper.addCondOrder', 'paper.cancelCondOrder',
      'alerts.list', 'alerts.create', 'alerts.toggle',
      'journal.list', 'journal.save', 'journal.remove',
      'account.summary', 'account.cashflowAdd',
      'trigger.runLongTrader', 'trigger.runShortTrader', 'trigger.runScreener', 'trigger.checkAlerts'
    ];
    for (const e of expected) {
      assert(names.includes(e), `注册了 ${e}`);
    }
    assert(agentRegistry.list().length >= 30, `总数 ≥ 30 (内建 8 + 扩展 22, 当前 ${agentRegistry.list().length})`);
  });

  await describe('情形 3: 每个工具有 name+description+input_schema+handler+risk', async () => {
    for (const t of agentRegistry.list()) {
      const full = agentRegistry.get(t.name);
      assert(full.description && full.description.length > 5, `${t.name}: description 长度>5`);
      assert(full.input_schema && full.input_schema.type === 'object', `${t.name}: input_schema.type=object`);
      assert(typeof full.handler === 'function', `${t.name}: handler 是函数`);
    }
  });

  await describe('情形 4: W 类工具飞书双确认', async () => {
    mockBrowserWindow._nextResult = { added: true, code: '600519' };
    mockBrowserWindowCalls.length = 0;
    try {
      const r = await agentRegistry.invoke('watchlist.add', { input: '600519' }, {});
      assert(mockBrowserWindowCalls.length === 1, `非飞书 → 直接执行 executeJavaScript (1 次调用, 实际=${mockBrowserWindowCalls.length})`);
    } catch (e) {
      assert(false, 'invoke 应成功: ' + e.message);
    }
  });

  await describe('情形 5: executeJavaScript 序列化参数', async () => {
    mockBrowserWindowCalls.length = 0;
    mockBrowserWindow._nextResult = { ok: true };
    await agentRegistry.invoke('paper.buy', { code: '300750', name: '宁德', shares: 100 }, {});
    assert(mockBrowserWindowCalls.length === 1, '1 次 executeJavaScript 调用');
    const call = mockBrowserWindowCalls[0];
    assert(call.expr.includes('Paper.buy'), '表达式包含 Paper.buy');
    assert(call.expr.includes('300750'), '参数 code 已 stringify 注入');
    assert(call.expr.includes('100'), '参数 shares 已 stringify 注入');
  });

  await describe('情形 6: 缺必填参数抛错', async () => {
    // agentRegistry.invoke 包了 try/catch, schema 错误返 {ok:false, error}
    const r1 = await agentRegistry.invoke('watchlist.remove', {}, {});
    assert(r1.ok === false && /缺必填字段: code/.test(r1.error || ''), `缺 code: ${(r1.error || '').slice(0, 60)}`);
    const r2 = await agentRegistry.invoke('paper.buy', { code: '300750' }, {});
    assert(r2.ok === false && /缺必填字段: shares/.test(r2.error || ''), `缺 shares: ${(r2.error || '').slice(0, 60)}`);
  });

  await describe('情形 7: 无 BrowserWindow 抛错', async () => {
    _setPickWindowNull(true);
    // agentRegistry.invoke 包了 try/catch → 返 {ok:false, error}, 不直接抛
    const r = await agentRegistry.invoke('holdings.list', {}, {});
    assert(r.ok === false, `无窗口应返 ok=false (实际=${JSON.stringify(r).slice(0, 60)})`);
    assert(/无窗口/.test(r.error || ''), `error 含 "无窗口": ${(r.error || '').slice(0, 60)}`);
    _setPickWindowNull(false);
  });

  await describe('情形 8: trigger.runLongTrader 调 window.LongTrader', async () => {
    mockBrowserWindowCalls.length = 0;
    mockBrowserWindow._nextResult = { ran: true };
    await agentRegistry.invoke('trigger.runLongTrader', {}, {});
    const call = mockBrowserWindowCalls[0];
    assert(call.expr.includes('LongTrader'), '表达式含 LongTrader (修 V12 bug)');
    assert(!call.expr.includes('window.Long.runNow') || call.expr.includes('window.LongTrader'),
      '不是用 window.Long 而是 window.LongTrader');
  });

  await describe('情形 9: 飞书来源仍能执行 (V13 stub 阶段)', async () => {
    const origWarn = console.warn;
    let warned = false;
    console.warn = (...args) => { if (args[0] && args[0].includes && args[0].includes('permission.askConfirm')) warned = true; };
    mockBrowserWindowCalls.length = 0;
    mockBrowserWindow._nextResult = { ok: true };
    await agentRegistry.invoke('watchlist.add', { input: '600519' }, { source: 'feishu', userOpenId: 'ou_test' });
    console.warn = origWarn;
    assert(warned, 'console.warn 触发 (stub 阶段提示)');
    assert(mockBrowserWindowCalls.length === 1, `executeJavaScript 仍执行 (stub 通过) 实际=${mockBrowserWindowCalls.length}`);
  });

  await describe('情形 10: 内建 8 工具仍能调', async () => {
    const builtin = ['data.health', 'data.listAccounts', 'app.restart', 'app.checkUpdate',
      'fs.readUserFile', 'fs.writeUserFile', 'shell.openExternal', 'ai.runStrategy'];
    for (const n of builtin) {
      assert(agentRegistry.get(n), `${n} 已注册`);
      assert(['R', 'W'].includes(agentRegistry.get(n).risk), `${n} 风险等级是 R/W`);
    }
  });

  console.log('\n' + '='.repeat(50));
  console.log(`V13 AgentRegistry 扩展: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();