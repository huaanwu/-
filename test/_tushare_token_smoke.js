// 端到端测试: dev-proxy 的 tushare token 下发端点
// 启 dev-proxy (随机端口) → POST token → GET status → 清 token
// 失败: exit 1
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 18099; // 固定一个不冲突的端口
const PROXY = `http://127.0.0.1:${PORT}`;

let exitCode = 0;
function fail(msg) {
  console.error(`[tushare-smoke] FAIL: ${msg}`);
  exitCode = 1;
}
function pass(msg) {
  console.log(`[tushare-smoke] ok: ${msg}`);
}

function httpJson(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      host: '127.0.0.1',
      port: PORT,
      path: urlPath,
      headers: body ? { 'Content-Type': 'application/json' } : {}
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function waitForReady(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await httpJson('GET', '/health');
      if (r.status === 200) return true;
    } catch (e) { /* not ready */ }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

(async () => {
  // 启 dev-proxy (NO_AKTOOLS_AUTOSTART=1 跳过 akshare 拉起 — 加快测试)
  const env = {
    ...process.env,
    PROXY_PORT: String(PORT),
    NO_AKTOOLS_AUTOSTART: '1',
    NO_DATASOURCES_AUTOSTART: '1',
  };
  console.log(`[tushare-smoke] 启动 dev-proxy on :${PORT} (跳过 aktools/datasources 拉起)`);
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'dev-proxy.mjs')], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let devProxyLog = '';
  child.stdout.on('data', (c) => { devProxyLog += c; });
  child.stderr.on('data', (c) => { devProxyLog += c; });
  child.on('exit', (code, sig) => { console.log(`[tushare-smoke] dev-proxy exit code=${code} sig=${sig}`); });

  try {
    const ready = await waitForReady();
    if (!ready) {
      fail('dev-proxy 15s 内没就绪, log: ' + devProxyLog.slice(-500));
      return;
    }
    pass('dev-proxy ready');

    // 1) GET tushare-status (初始无 token)
    let r = await httpJson('GET', '/api/datasource/tushare-status');
    if (r.status !== 200) fail(`status endpoint 状态码 ${r.status}`);
    else if (r.body.has_token !== false) fail(`初始 has_token 应为 false, 实际: ${JSON.stringify(r.body)}`);
    else pass('初始 has_token=false');

    // 2) POST 合法 token
    const testToken = 'a'.repeat(32);
    r = await httpJson('POST', '/api/datasource/tushare-token', { token: testToken });
    if (r.status !== 200) fail(`POST 合法 token 状态码 ${r.status}, body: ${JSON.stringify(r.body)}`);
    else if (!r.body.ok) fail(`POST 返 ok=false: ${JSON.stringify(r.body)}`);
    else if (r.body.token_set !== true) fail(`POST 返 token_set 应为 true, 实际 ${r.body.token_set}`);
    else pass(`POST 合法 token 接受, sidecar_restart=${r.body.sidecar_restart} (false 也行, 没启 sidecar)`);

    // 3) GET 状态应该有 token
    r = await httpJson('GET', '/api/datasource/tushare-status');
    if (r.body.has_token !== true) fail(`设置后 has_token 应为 true, 实际: ${JSON.stringify(r.body)}`);
    else if (r.body.token_length !== 32) fail(`token_length 应为 32, 实际 ${r.body.token_length}`);
    else pass(`设置后 has_token=true, length=32`);

    // 4) POST 非法 token (太短)
    r = await httpJson('POST', '/api/datasource/tushare-token', { token: 'short' });
    if (r.status !== 400) fail(`太短 token 应返 400, 实际 ${r.status}`);
    else if (r.body.error !== 'INVALID_TOKEN_FORMAT') fail(`error code 不对: ${JSON.stringify(r.body)}`);
    else pass('太短 token 返 400 + INVALID_TOKEN_FORMAT');

    // 5) POST 清空 token
    r = await httpJson('POST', '/api/datasource/tushare-token', { token: '' });
    if (r.status !== 200) fail(`清空 token 状态码 ${r.status}`);
    else if (r.body.token_set !== false) fail(`清空后 token_set 应 false, 实际 ${r.body.token_set}`);
    else pass('清空 token 接受');

    // 6) GET 状态应回到无 token
    r = await httpJson('GET', '/api/datasource/tushare-status');
    if (r.body.has_token !== false) fail(`清空后 has_token 应 false, 实际: ${JSON.stringify(r.body)}`);
    else pass('清空后 has_token=false');

    // 7) GET 走错的 method 应 405
    r = await httpJson('GET', '/api/datasource/tushare-token');
    if (r.status !== 405) fail(`GET 走 POST-only endpoint 应 405, 实际 ${r.status}`);
    else pass('GET 走 POST-only endpoint 返 405');

  } finally {
    child.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 500));
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  console.log(exitCode === 0 ? '\n✅ 全过' : '\n❌ 有失败');
  process.exit(exitCode);
})().catch(e => {
  console.error('[tushare-smoke] uncaught:', e);
  process.exit(1);
});
