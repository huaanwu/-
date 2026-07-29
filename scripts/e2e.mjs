/**
 * e2e.mjs - 端到端冒烟测试
 * 用 Chrome DevTools Protocol (CDP) 直接连, 不依赖 puppeteer
 *
 * 流程:
 *   1. 启 chrome --headless --remote-debugging-port=9222
 *   2. 连 WebSocket, 建 Page target, Runtime.enable 抓 console 错误
 *   3. navigate http://localhost:3003/
 *   4. 等 5s 让 SPA 渲染, 跑 Runtime.evaluate 抓关键 DOM
 *   5. 切到每个 page (pageWatchlist/Holdings/Journal/...) 抓断言
 *   6. 截图首页 + 复盘页
 *   7. 跑 5.3 agents 流水线 (Core.Agents.runPipeline)
 *   8. 报告 + 退出
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
const SCREENSHOT_DIR = path.join(ROOT, 'e2e_screenshots');

if (!fs.existsSync(SCREENSHOT_DIR)) fs.mkdirSync(SCREENSHOT_DIR);

const log = (...a) => console.log('[e2e]', ...a);
const errors = [];
const consoleErrors = [];
const consoleLogs = [];
const results = {};

// ===== 1. 启 Chrome =====
log('启动 Chrome headless...');
const chrome = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--no-sandbox',
  '--disable-cache',
  '--disable-application-cache',
  '--remote-debugging-port=9222',
  '--remote-debugging-address=127.0.0.1',
  '--window-size=1280,800',
  '--user-data-dir=' + path.join(ROOT, '.chrome-e2e-tmp-' + Date.now()),
  'about:blank'
], { stdio: ['ignore', 'pipe', 'pipe'] });

chrome.on('exit', (code) => log('Chrome 退出 code=' + code));

// 等 CDP 起来
async function waitCDP() {
  for (let i = 0; i < 30; i++) {
    try {
      const r = await fetch(CDP_URL + '/json/version');
      if (r.ok) {
        const j = await r.json();
        log('CDP ready, browser=' + j.Browser);
        return;
      }
    } catch (e) { /* not ready */ }
    await wait(300);
  }
  throw new Error('CDP 起来超时');
}

await waitCDP();

// ===== 2. 拿 wsUrl =====
const targets = await (await fetch(CDP_URL + '/json')).json();
let page = targets.find(t => t.type === 'page');
if (!page) throw new Error('没找到 page target');
log('page ws=' + page.webSocketDebuggerUrl);

// ===== 3. 连 WebSocket =====
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
const events = [];

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) reject(new Error(m.error.message));
    else resolve(m.result);
  } else if (m.method) {
    events.push(m);
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
log('WebSocket 已连');

await send('Page.enable');
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');

// ===== 4. 抓 console 错误 =====
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  // 已知软错误: favicon / manifest / aktools 数据源挂 / "Failed to load resource" 4xx 通用错
  const SOFT_404 = /favicon\.ico|manifest\.webmanifest|\/api\/akshare\/|Failed to load resource/;
  if (m.method === 'Runtime.consoleAPICalled') {
    const args = (m.params.args || []).map(a => a.value !== undefined ? a.value : a.description).join(' ');
    const level = m.params.type;
    consoleLogs.push({ level, args });
    if (level === 'error' && !SOFT_404.test(args)) consoleErrors.push(args);
  } else if (m.method === 'Runtime.exceptionThrown') {
    const e = m.params.exceptionDetails;
    const desc = (e.text || '') + ' ' + (e.exception?.description || '');
    if (!SOFT_404.test(desc)) consoleErrors.push('[EXCEPTION] ' + desc);
  } else if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    if (!SOFT_404.test(m.params.entry.text)) consoleErrors.push('[LOG] ' + m.params.entry.text);
  } else if (m.method === 'Network.responseReceived') {
    const url = m.params.response.url;
    if (m.params.response.status >= 500) {
      consoleErrors.push(`[HTTP 5xx] ${url}`);
    } else if (m.params.response.status >= 400 && !SOFT_404.test(url)) {
      consoleErrors.push(`[HTTP ${m.params.response.status}] ${url}`);
    }
  }
});

// ===== 5. navigate =====
log('navigate ' + APP_URL);
await send('Page.navigate', { url: APP_URL });
await wait(5000);  // 等 SPA 跑完

// ===== 6. 关键 DOM 断言 =====
async function eval_(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    errors.push(`eval 异常: ${expr} → ${r.exceptionDetails.text}`);
    return null;
  }
  return r.result?.value;
}

const navHtml = await eval_(`document.querySelector('nav.app-nav')?.outerHTML || 'no nav'`);
results.navHas8 = navHtml.includes('行情') && navHtml.includes('资金') && navHtml.includes('持仓') && navHtml.includes('复盘') && navHtml.includes('选股') && navHtml.includes('基金') && navHtml.includes('回测') && navHtml.includes('提醒');

const watchlistExists = await eval_(`!!document.querySelector('#watchlistTable')`);
const holdingsExists = await eval_(`!!document.querySelector('#holdingsTable')`);
const journalExists = await eval_(`!!document.querySelector('#journalList')`);
results.domMounted = watchlistExists && holdingsExists && journalExists;

// Core 命名空间
const coreOK = await eval_(`typeof Core === 'object' && typeof Core.AI === 'object' && typeof Core.Agents === 'object' && typeof Core.Sync === 'object' && typeof Core.Storage === 'object' && typeof Core.State === 'object'`);
results.coreModules = coreOK;

// AI 候选值
const aiAllowed = await eval_(`JSON.stringify(Core.Agents.ALLOWED.coachAction)`);
results.aiCoachActions = aiAllowed;

// 切到复盘页
await eval_(`switchPage('pageJournal')`);
await wait(1000);
const journalRendered = await eval_(`document.querySelectorAll('#journalList .journal-card, #journalList .data-card-empty, #journalList > div').length`);
results.journalRenders = journalRendered;

await eval_(`switchPage('pageWatchlist')`);
await wait(1000);
const watchlistRendered = await eval_(`document.querySelectorAll('#watchlistTable > *').length`);
results.watchlistRenders = watchlistRendered;

// 5.3.1 多智能体跑个 pipeline (用更详细的输出, 排查 r.data undefined)
const pipelineResult = await eval_(`(async () => {
  try {
    const r = await Core.Agents.runPipeline('observe', { holdings: [{ code: '600519', shares: 100, cost: 1500 }] }, { deps: { callLLM: async () => '{"observations":[{"category":"holding","code":"600519","text":"测试持仓","severity":"info","source":"holding"}]}' } });
    return JSON.stringify({ ok: r.ok, intent: r.intent, stepsCount: r.steps.length, firstAgent: r.steps[0]?.agent, firstOk: r.steps[0]?.ok, finalKeys: r.final ? Object.keys(r.final) : null, finalN: r.final?.observations?.length });
  } catch (e) { return 'ERR:' + e.message + ' / ' + (e.stack || ''); }
})()`);
results.agentsRunPipeline = pipelineResult;

// Core.Sync._isAIJournal 试一下
const isAI = await eval_(`Core.Sync._isAIJournal({ aiSuggested: { x: 1 } })`);
results.syncIsAI = isAI;

// ai-service resolveEndpoint
const ep = await eval_(`JSON.stringify(Core.AI.resolveEndpoint({ local: false }))`);
results.aiResolve = ep;

// 5.3.1 AI 同事弹窗: 验证 DOM 入口 + 函数存在
const aiColleagueBtnExists = await eval_(`!!document.querySelector('[onclick*="aiColleagueDialog"]')`);
results.aiColleagueBtn = aiColleagueBtnExists;

const aiColleagueFn = await eval_(`typeof Journal.aiColleagueDialog === 'function' && typeof Journal._runAgentPipeline === 'function' && typeof Journal._pushAIMemory === 'function' && typeof Journal._pullAIMemory === 'function'`);
results.aiColleagueFns = aiColleagueFn;

// 调一下 aiColleagueDialog, 看 modal 是否出现
await eval_(`switchPage('pageJournal')`);
await wait(200);
const modalResult = await eval_(`(async () => {
  try {
    Journal.aiColleagueDialog();
    await new Promise(r => setTimeout(r, 200));
    const root = document.getElementById('modalRoot');
    const html = root ? root.innerHTML : '';
    return JSON.stringify({
      hasModal: html.length > 100,
      has4Btns: html.includes('今日全链路') && html.includes('诊断持仓') && html.includes('仅观察') && html.includes('下一步行动'),
      hasMemoryBtns: html.includes('推 AI 记忆') && html.includes('拉 AI 记忆'),
      hasResultArea: html.includes('aiColleagueResult')
    });
  } catch (e) { return 'ERR:' + e.message; }
})()`);
results.aiColleagueModal = modalResult;

// ===== 7. 截图 =====
// v0.2.11 修: 截图前关掉 AI 同事弹窗, 否则所有页面被挡
async function closeModal() {
  await eval_(`(function(){
    const root = document.getElementById('modalRoot');
    if (root) root.innerHTML = '';
  })()`);
  await wait(200);
}
async function shot(name) {
  await closeModal();
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r?.data) {
    const fp = path.join(SCREENSHOT_DIR, name);
    fs.writeFileSync(fp, Buffer.from(r.data, 'base64'));
    log('screenshot → ' + fp);
  }
}
await shot('01-home.png');
await eval_(`switchPage('pageJournal')`);
await wait(500);
await shot('02-journal.png');
await eval_(`switchPage('pageScreener')`);
await wait(500);
await shot('03-screener.png');
await eval_(`switchPage('pageFund')`);
await wait(500);
await shot('04-fund.png');
await eval_(`switchPage('pageAlerts')`);
await wait(500);
await shot('05-alerts.png');
await eval_(`switchPage('pagePaper')`);
await wait(500);
await shot('06-paper.png');
await eval_(`switchPage('pageSettings')`);
await wait(500);
await shot('07-settings.png');

// ===== 8. 收尾 =====
log('===== e2e 结果 =====');
log('硬 console errors (排除 404 软错误): ' + consoleErrors.length);
if (consoleErrors.length) {
  consoleErrors.slice(0, 10).forEach((e, i) => log('  [' + (i+1) + '] ' + e.slice(0, 200)));
}
log('eval errors: ' + errors.length);
errors.forEach(e => log('  ' + e));
log('results:');
for (const [k, v] of Object.entries(results)) {
  const ok = v && v !== false && v !== 0;
  log(`  ${ok ? '✅' : '❌'} ${k}: ${typeof v === 'string' ? v.slice(0, 200) : JSON.stringify(v)}`);
}

const passCount = Object.entries(results).filter(([k, v]) => v && v !== false && v !== 0).length;
const total = Object.keys(results).length;
log(`PASS: ${passCount}/${total}`);

ws.close();
chrome.kill();
try { fs.rmSync(path.join(ROOT, '.chrome-e2e-tmp'), { recursive: true, force: true, maxRetries: 1 }); } catch (e) { log('rm tmp dir 跳过: ' + e.message); }

process.exit(passCount === total ? 0 : 1);
