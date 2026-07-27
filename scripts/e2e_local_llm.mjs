/**
 * e2e_local_llm.mjs - 5.3.3 本地 LLM 端到端
 * 自动设 8082 配置 → 跑 testConnection → 跑多智能体 pipeline → 报结果
 */
import { spawn } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_URL = 'http://127.0.0.1:9222';
const APP_URL = 'http://localhost:3003/';
const LOCAL_BASE = 'http://localhost:8082/v1';
const LOCAL_MODEL = 'qwen36-35b-a3b';

const log = (...a) => console.log('[e2e-local]', ...a);

const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  '--disable-cache', '--disable-application-cache',
  '--remote-debugging-port=9222', '--remote-debugging-address=127.0.0.1',
  '--window-size=1280,800',
  '--user-data-dir=' + path.join(ROOT, '.chrome-local-tmp-' + Date.now()),
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

async function waitCDP() {
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(CDP_URL + '/json/version'); if (r.ok) return; } catch (e) {}
    await wait(300);
  }
  throw new Error('CDP 超时');
}
await waitCDP();

const targets = await (await fetch(CDP_URL + '/json')).json();
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
log('WebSocket 连上');

await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

async function evalJS(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) {
    return { err: r.exceptionDetails.text + ' / ' + (r.exceptionDetails.exception?.description || '') };
  }
  return r.result?.value;
}

log('navigate ' + APP_URL);
await send('Page.navigate', { url: APP_URL });
await wait(4000);

// 1) 注入本地 LLM 配置
const setupR = await evalJS(`
  (function() {
    const cur = Core.State.get('ai') || {};
    Core.State.set('ai', Object.assign({}, cur, {
      provider: 'deepseek',
      preferLocal: true,
      useProxy: false,
      baseURL: '',
      apiKey: cur.apiKey || '',
      model: cur.model || 'deepseek-v4-flash',
      localEndpoint: { baseURL: '${LOCAL_BASE}', model: '${LOCAL_MODEL}', apiKey: '' }
    }));
    return JSON.stringify(Core.AI.getConfig(), null, 2);
  })()
`);
log('注入后配置:\n' + setupR);

// 2) 测连通
log('测连通...');
const connR = await evalJS(`
  (async () => {
    try {
      const r = await Core.AI.testConnection();
      return JSON.stringify(r);
    } catch (e) { return 'ERR:' + e.message; }
  })()
`, true);
log('testConnection: ' + connR);

// 3) 验证 resolveEndpoint
const epR = await evalJS(`
  (function() {
    const ep = Core.AI.resolveEndpoint({});
    return JSON.stringify(ep, null, 2);
  })()
`);
log('resolveEndpoint(默认):\n' + epR);

// 4) 跑多智能体 (强制本地)
log('跑 observe pipeline (强制本地)...');
const pipeR = await evalJS(`
  (async () => {
    try {
      const t0 = Date.now();
      const r = await Core.Agents.runPipeline('observe', {
        holdings: [{ code: '600519', shares: 100, cost: 1600 }],
        alerts: [],
        recentJournals: []
      }, { local: true });
      const ms = Date.now() - t0;
      return JSON.stringify({
        ms, ok: r.ok, intent: r.intent, steps: r.steps.length,
        firstOk: r.steps[0]?.ok,
        obsCount: r.final?.observations?.length || 0,
        firstObs: r.final?.observations?.[0]?.text || '',
        summary: r.summary
      });
    } catch (e) { return 'ERR:' + e.message + ' / ' + e.stack; }
  })()
`, true);
log('pipeline result: ' + pipeR);

// 5) 截图复盘页
await evalJS(`switchPage('pageJournal')`);
await wait(500);
const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot?.data) {
  const fp = path.join(ROOT, 'e2e_screenshots', '06-local-llm-pipeline.png');
  fs.writeFileSync(fp, Buffer.from(shot.data, 'base64'));
  log('screenshot → ' + fp);
}

ws.close();
chrome.kill();
log('done');

// 判断结果
try {
  const conn = JSON.parse(connR || '{}');
  const pipe = JSON.parse(pipeR || '{}');
  console.log('\n===== 5.3.3 端到端验收 =====');
  console.log('1. testConnection:', conn.ok ? `✅ ${conn.model} ${conn.latencyMs}ms "${conn.reply}"` : `❌ ${conn.error}`);
  console.log('2. pipeline:', pipe.ok ? `✅ ${pipe.obsCount} observations, ${pipe.ms}ms` : `❌ ${pipe.summary || pipe.err}`);
  console.log('3. 配置生效:', epR.includes('"isLocal": true') ? '✅ 走本地' : '❌ 走远程');
  process.exit(conn.ok && pipe.ok ? 0 : 1);
} catch (e) {
  console.log('parse 失败:', e.message);
  process.exit(1);
}
