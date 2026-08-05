// e2e: 用 curl 验证 dev-proxy multi-source fallback 真实工作
// 走 curl 而非 fetch + AbortController, 绕开 Node 18 Windows UV_HANDLE_CLOSING fatal
// 用法: node test/_multisrc_e2e_runner.js
const { execFileSync } = require('node:child_process');

let passed = 0, failed = 0;
const t = async (name, fn) => {
  try { await fn(); console.log('  ok  ' + name); passed++; }
  catch (e) { failed++; console.error('  FAIL ' + name + ': ' + (e.message || e)); }
};

const curl = (url, timeoutSec = 60) => {
  try {
    const stdout = execFileSync('curl.exe', [
      '-s', '-w', '\n__STATUS__:%{http_code}', '--max-time', String(timeoutSec), url,
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = stdout.match(/__STATUS__:(\d+)$/);
    if (!m) throw new Error('curl 响应无 status 标记');
    return { status: parseInt(m[1], 10), body: stdout.replace(/\n?__STATUS__:\d+$/, '') };
  } catch (e) {
    throw new Error('curl 失败: ' + (e.message || e));
  }
};

(async () => {
  console.log('multisrc e2e (curl)');

  await t('multi/stock_daily baostock 真实胜出', async () => {
    const url = 'http://127.0.0.1:8089/api/datasource/multi/stock_daily?code=000001&start_date=2024-06-01&end_date=2024-06-10&adj=qfq';
    const r = curl(url, 30);
    if (r.status !== 200) throw new Error('status ' + r.status);
    const body = JSON.parse(r.body);
    if (!body.ok) throw new Error('body.ok=false: ' + r.body);
    if (body.source !== 'baostock') throw new Error('source 期望 baostock, got ' + body.source);
    if (!Array.isArray(body.data) || body.data.length === 0) throw new Error('data 为空');
    if (!body.data[0].close) throw new Error('第一行无 close: ' + JSON.stringify(body.data[0]));
  });

  await t('multi/stock_list baostock 真实胜出 (全 A 股)', async () => {
    const r = curl('http://127.0.0.1:8089/api/datasource/multi/stock_list', 90);
    if (r.status !== 200) throw new Error('status ' + r.status);
    const body = JSON.parse(r.body);
    if (body.source !== 'baostock') throw new Error('source 期望 baostock, got ' + body.source);
    if (!body.data || body.data.length < 4000) throw new Error('A 股应 4000+, got ' + (body.data?.length || 0));
  });

  await t('multi/stock_basic tushare 没 token + aktools 500 → 502 fallback 耗尽', async () => {
    const r = curl('http://127.0.0.1:8089/api/datasource/multi/stock_basic?code=000001', 90);
    // 现状: tushare 503 (没 token) + aktools 500 (akshare 网络) → dev-proxy 返 502
    if (r.status !== 502) throw new Error('期望 502, got ' + r.status);
  });

  console.log(`\n${passed} 通过 / ${failed} 失败`);
  // Node 24 无 UV_HANDLE_CLOSING bug, 直接 process.exit
  process.exit(failed > 0 ? 1 : 0);
})();
