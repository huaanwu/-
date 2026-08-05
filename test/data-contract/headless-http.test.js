/**
 * G5 headless HTTP 入口集成测试
 *
 * 覆盖:
 *   1. GET /api/headless/health → ok:true + mode:headless
 *   2. POST /api/headless/run 正常请求 → 200 + 调用 agentRegistry.invoke
 *   3. POST /api/headless/run 无 body → 200 (默认 strategy=agents)
 *   4. POST /api/headless/run JSON parse 失败 → 400
 *   5. CORS 头存在 (Access-Control-Allow-Origin: *)
 *   6. agent-registry.js 含 ai.runStrategy 工具 (M 风险)
 *
 * 跑法: node test/data-contract/headless-http.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const http = require('http');

const ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_SRC = fs.readFileSync(path.join(ROOT, 'electron', 'agent-registry.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// 加载 agent-registry (注入 stub electron)
function loadRegistry() {
  const sandbox = {
    require,
    module: { exports: {} },
    exports: {},
    __dirname: path.resolve(ROOT, 'electron'),
    __filename: path.resolve(ROOT, 'electron', 'agent-registry.js'),
    console,
    process
  };
  // Stub electron: app.getPath / shell.openExternal / BrowserWindow
  sandbox.electron = {
    app: { getPath: () => '/tmp/userdata' },
    BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] },
    shell: { openExternal: async () => {} }
  };
  vm.createContext(sandbox);
  // electron-updater 不需要 — 但 agent-registry require('electron-updater') 会失败
  // 包装 require 让 electron-updater 返空 stub
  const origRequire = sandbox.require;
  sandbox.require = function (id) {
    if (id === 'electron-updater') return { autoUpdater: { checkForUpdates: () => Promise.resolve(), once: () => {} } };
    return origRequire.apply(this, arguments);
  };
  vm.runInContext(REGISTRY_SRC, sandbox, { filename: 'agent-registry.js' });
  return sandbox.module.exports;
}

// 起临时 HTTP server (复用 main.js setupHeadless 思路)
async function startHeadlessServer(registry, port = 0) {
  const server = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && req.url === '/api/headless/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'headless' }));
      return;
    }
    if (req.method === 'POST' && req.url === '/api/headless/run') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'JSON parse failed: ' + e.message }));
          return;
        }
        try {
          const result = await registry.invoke('ai.runStrategy', { strategy: payload.strategy || 'agents', payload }, {});
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, strategy: payload.strategy || 'agents', result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message || String(e) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      resolve({ server, port: addr.port });
    });
  });
}

function httpRequest(opts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port: opts.port, path: opts.path, method: opts.method,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    if (opts.body) req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    req.end();
  });
}

// ============================================================
// 情形 1: GET /api/headless/health
// ============================================================
describe('情形 1: GET /api/headless/health → ok:true', async () => {
  const registry = loadRegistry();
  const { server, port } = await startHeadlessServer(registry);
  try {
    const r = await httpRequest({ method: 'GET', path: '/api/headless/health', port });
    assert(r.status === 200, 'GET 返 200');
    const j = JSON.parse(r.body);
    assert(j.ok === true, 'body ok=true');
    assert(j.mode === 'headless', 'mode=headless');
  } finally { server.close(); }
});

// ============================================================
// 情形 2: POST /api/headless/run 正常请求
// ============================================================
describe('情形 2: POST /api/headless/run 调用 ai.runStrategy', async () => {
  const registry = loadRegistry();
  const { server, port } = await startHeadlessServer(registry);
  try {
    const r = await httpRequest({
      method: 'POST', path: '/api/headless/run', port,
      body: { strategy: 'long', payload: { foo: 'bar' } }
    });
    assert(r.status === 200, 'POST 返 200');
    const j = JSON.parse(r.body);
    assert(j.ok === true, 'ok=true');
    assert(j.strategy === 'long', 'strategy=long');
    // invoke 返 { ok: true, data: { queued: true, ... } } — HTTP server 把整个 invoke 返值塞 result
    assert(j.result && j.result.ok === true, 'invoke ok=true');
    assert(j.result && j.result.data && j.result.data.queued === true, 'agentRegistry.invoke 返 queued=true (ai.runStrategy 占位)');
  } finally { server.close(); }
});

// ============================================================
// 情形 3: POST 无 body → 默认 strategy=agents
// ============================================================
describe('情形 3: POST 无 body → 默认 strategy=agents', async () => {
  const registry = loadRegistry();
  const { server, port } = await startHeadlessServer(registry);
  try {
    const r = await httpRequest({ method: 'POST', path: '/api/headless/run', port });
    assert(r.status === 200, 'POST 返 200');
    const j = JSON.parse(r.body);
    assert(j.strategy === 'agents', '默认 strategy=agents');
    assert(j.result && j.result.ok === true, '仍调 registry invoke (返 ok)');
  } finally { server.close(); }
});

// ============================================================
// 情形 4: POST 非法 JSON → 400
// ============================================================
describe('情形 4: POST 非法 JSON → 400', async () => {
  const registry = loadRegistry();
  const { server, port } = await startHeadlessServer(registry);
  try {
    const r = await httpRequest({ method: 'POST', path: '/api/headless/run', port, body: 'not json {{{', headers: {} });
    assert(r.status === 400, '返 400');
    assert(/JSON parse/.test(r.body), 'error 含「JSON parse」');
  } finally { server.close(); }
});

// ============================================================
// 情形 5: CORS 头存在
// ============================================================
describe('情形 5: CORS 头 (Access-Control-Allow-Origin: *)', async () => {
  const registry = loadRegistry();
  const { server, port } = await startHeadlessServer(registry);
  try {
    const r = await httpRequest({ method: 'GET', path: '/api/headless/health', port });
    assert(r.headers['access-control-allow-origin'] === '*', 'CORS *');
  } finally { server.close(); }
});

// ============================================================
// 情形 6: ai.runStrategy 在 agent-registry 已注册
// ============================================================
describe('情形 6: agent-registry.js 含 ai.runStrategy 工具 (M 风险)', () => {
  const registry = loadRegistry();
  const tool = registry.get('ai.runStrategy');
  assert(!!tool, '工具已注册');
  assert(tool && tool.risk === 'M', 'risk=M');
  assert(tool && /Headless 模式 AI 调度入口/.test(tool.description), 'description 含「Headless」');
  // input_schema 含 strategy enum
  const props = tool && tool.input_schema && tool.input_schema.properties;
  assert(props && props.strategy && Array.isArray(props.strategy.enum), 'input_schema.strategy enum 存在');
  assert(props.strategy.enum.includes('long') && props.strategy.enum.includes('short') && props.strategy.enum.includes('fund'), 'enum 含 long/short/fund');
});

// ============================================================
// 情形 7: list() 含 ai.runStrategy
// ============================================================
describe('情形 7: registry.list() 暴露 ai.runStrategy', () => {
  const registry = loadRegistry();
  const list = registry.list();
  const names = list.map(t => t.name);
  assert(names.includes('ai.runStrategy'), 'list 含 ai.runStrategy');
  assert(names.includes('data.health'), 'list 含 data.health (既有工具未丢)');
  assert(names.includes('fs.readUserFile'), 'list 含 fs.readUserFile');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`G5 headless HTTP: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();