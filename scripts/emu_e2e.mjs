/**
 * emu_e2e.mjs - Android Emulator 端到端冒烟
 * 1) adb forward WebView devtools
 * 2) CDP 跑 Runtime.evaluate 抓 DOM
 * 3) 截图
 */
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ADB = 'adb';
const SERIAL = 'emulator-5554';
const CDP_URL = 'http://127.0.0.1:9222';
const SHOT_DIR = path.join(ROOT, 'emu_screenshots');
if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR);

const log = (...a) => console.log('[emu]', ...a);

// 1) 找 webview_devtools socket, forward
const sockets = spawnSync(ADB, ['-s', SERIAL, 'shell', 'cat', '/proc/net/unix']);
const lines = sockets.stdout.toString().split('\n').filter(l => l.includes('webview_devtools'));
if (lines.length === 0) { console.error('没找到 webview devtools socket'); process.exit(1); }
const sockName = lines[0].split('@').pop().trim();
log('webview socket: ' + sockName);
spawnSync(ADB, ['-s', SERIAL, 'forward', 'tcp:9222', `localabstract:${sockName}`]);
await wait(500);

// 2) 拿 page target
const targets = await (await fetch(CDP_URL + '/json')).json();
const page = targets.find(t => t.type === 'page');
if (!page) { console.error('没找到 page'); process.exit(1); }
log('webview title=' + page.title + ' url=' + page.url);

// 3) 连 CDP
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const events = [];
const consoleErrors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  } else if (m.method) {
    events.push(m);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push((m.params.args || []).map(a => a.value || a.description).join(' '));
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('[EX] ' + (m.params.exceptionDetails.text || ''));
    } else if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
      consoleErrors.push(`[HTTP ${m.params.response.status}] ${m.params.response.url}`);
    }
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
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');

async function evalJS(expr, awaitPromise = true) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
  if (r.exceptionDetails) return { err: r.exceptionDetails.text };
  return r.result?.value;
}

async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) {
    const fp = path.join(SHOT_DIR, name);
    fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
    log('shot → ' + fp);
  }
}

const results = {};

// 让 SPA 跑完
await wait(4000);
results.title = await evalJS('document.title');
results.nav = await evalJS(`[...document.querySelectorAll('nav.app-nav .nav-label')].map(e => e.textContent.trim())`);
results.url = page.url;
results.coreModules = await evalJS(`typeof Core === 'object' && typeof Core.AI === 'object' && typeof Core.Agents === 'object' && typeof Core.Sync === 'object'`);
results.marketBar = await evalJS(`!!document.querySelector('.market-bar')`);
results.marketBarContent = await evalJS(`(() => {
  const m = document.querySelector('.market-bar-body');
  return m ? m.textContent.trim().slice(0, 200) : '';
})()`);

await shot('emu-01-home.png');

// 切到 "复盘" tab
await evalJS(`document.querySelector('[data-page="pageJournal"]').click()`);
await wait(1500);
const journalList = await evalJS(`document.getElementById('journalList')?.textContent?.trim()?.slice(0, 200) || ''`);
results.journalList = journalList;
const aiBtn = await evalJS(`!!document.querySelector('[onclick*="aiColleagueDialog"]')`);
results.aiColleagueBtn = aiBtn;
await shot('emu-02-journal.png');

// 切到 "选股" tab
await evalJS(`document.querySelector('[data-page="pageScreener"]').click()`);
await wait(1500);
const screenerResult = await evalJS(`document.getElementById('screenerResult')?.textContent?.trim()?.slice(0, 200) || ''`);
results.screenerResult = screenerResult;
await shot('emu-03-screener.png');

// 切到 "基金" tab (有市场bar)
await evalJS(`document.querySelector('[data-page="pageFund"]').click()`);
await wait(2500);
results.fundMarketBar = await evalJS(`document.querySelector('.market-bar-body')?.textContent?.trim()?.slice(0, 300) || ''`);
await shot('emu-04-fund.png');

// 切到 "提醒" tab
await evalJS(`document.querySelector('[data-page="pageAlerts"]').click()`);
await wait(1500);
await shot('emu-05-alerts.png');

// 切到 "回测" tab
await evalJS(`document.querySelector('[data-page="pageBacktest"]').click()`);
await wait(1500);
await shot('emu-06-backtest.png');

// 测数据源: 调 tencent 拉 600519
const tencentTest = await evalJS(`(async () => {
  try {
    const list = await Core.Data.getStockSpotTencent(['sh600519']);
    return JSON.stringify({ ok: list.length > 0, name: list[0]?.名称, price: list[0]?.最新价, change: list[0]?.涨跌幅 });
  } catch (e) { return 'ERR:' + e.message; }
})()`);
results.tencentTest = tencentTest;

// 测东方财富全市场
const efinanceTest = await evalJS(`(async () => {
  try {
    const list = await Core.Data.getStockSpotEfinance();
    return JSON.stringify({ ok: list.length > 0, total: list.length, sample: list[0]?.名称 });
  } catch (e) { return 'ERR:' + e.message; }
})()`);
results.efinanceTest = efinanceTest;

// 测 market.get('wide') 看 6 个宽基
const wideTest = await evalJS(`(async () => {
  try {
    const snap = await Core.Market.get('wide');
    return JSON.stringify({ ok: snap.items.length > 0, items: snap.items.map(i => ({ code: i.code, name: i.name, change: i.change })) });
  } catch (e) { return 'ERR:' + e.message; }
})()`);
results.wideTest = wideTest;

// 测 market.get('industry') 看 31 个行业
const industryTest = await evalJS(`(async () => {
  try {
    const snap = await Core.Market.get('industry');
    return JSON.stringify({ ok: snap.top.length > 0, top3: snap.top.slice(0, 3).map(i => i.name + ' ' + i.change.toFixed(2) + '%') });
  } catch (e) { return 'ERR:' + e.message; }
})()`);
results.industryTest = industryTest;

ws.close();
log('===== 结果 =====');
log('console errors: ' + consoleErrors.length);
consoleErrors.slice(0, 5).forEach((e, i) => log('  [' + (i+1) + '] ' + e.slice(0, 200)));
log('---');
for (const [k, v] of Object.entries(results)) {
  const str = typeof v === 'string' ? v : JSON.stringify(v);
  log(`${k}: ${str.slice(0, 300)}`);
}

// 判断
const pass = (results.marketBar || results.coreModules) && (results.tencentTest?.includes('"ok":true') || String(results.tencentTest).includes('"ok":true'));
log('=== ' + (pass ? '✅ PASS' : '❌ FAIL') + ' ===');
process.exit(pass ? 0 : 1);
