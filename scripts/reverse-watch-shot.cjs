/**
 * reverse-watch-shot.cjs - 独立 SPA 截图工具
 *
 * 不依赖 stock-master 任何脚本, 用 CDP 连 headless Chrome 截 reverse-watch/
 * 用法: node scripts/reverse-watch-shot.cjs
 */
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');

const ROOT = path.resolve(__dirname, '..');
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const CDP_URL = 'http://127.0.0.1:9222';
const APP_URL = 'http://127.0.0.1:3020/index.html';
const OUT_DIR = path.join(ROOT, 'reverse-watch', 'shots');

if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR);

const log = (...a) => console.log('[rw-shot]', ...a);
const errors = [];
const consoleErrors = [];

// ===== 启 Chrome (若未启) =====
function ensureChrome() {
  return new Promise((resolve, reject) => {
    const probe = http.get(CDP_URL + '/json/version', (r) => {
      if (r.statusCode === 200) resolve(null);
      else reject(new Error('CDP probe failed'));
    });
    probe.on('error', () => {
      // 启 Chrome
      log('启动 Chrome headless...');
      const chrome = spawn(CHROME, [
        '--headless=new', '--disable-gpu', '--no-sandbox',
        '--disable-cache', '--disable-application-cache',
        '--remote-debugging-port=9222',
        '--remote-debugging-address=127.0.0.1',
        '--window-size=1280,800',
        '--user-data-dir=' + path.join(ROOT, '.chrome-rw-tmp-' + Date.now()),
        'about:blank'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      chrome.on('error', reject);
      setTimeout(() => resolve(chrome), 1500);
    });
  });
}

async function main() {
  await ensureChrome();
  log('获取 page target...');
  const targets = await new Promise((res, rej) => {
    http.get(CDP_URL + '/json', (r) => {
      let buf = '';
      r.on('data', c => buf += c);
      r.on('end', () => res(JSON.parse(buf)));
    }).on('error', rej);
  });
  let page = targets.find(t => t.type === 'page');
  if (!page) {
    // 启 Chrome (ensureChrome 已 wait 1.5s), 再查
    await new Promise(r => setTimeout(r, 1500));
    const targets2 = await new Promise((res, rej) => {
      http.get(CDP_URL + '/json', (r) => {
        let buf = '';
        r.on('data', c => buf += c);
        r.on('end', () => res(JSON.parse(buf)));
      }).on('error', rej);
    });
    page = targets2.find(t => t.type === 'page');
  }
  if (!page) throw new Error('没找到 page target');
  log('page ws=' + page.webSocketDebuggerUrl);

  const WebSocket = require('ws');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });

  let nextId = 1;
  const pending = new Map();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
    } else if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails.text);
    }
  });

  function cdp(method, params = {}) {
    return new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, (msg) => {
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  await cdp('Runtime.enable');
  await cdp('Page.enable');
  await cdp('Network.enable');

  log('导航到 ' + APP_URL);
  await cdp('Page.navigate', { url: APP_URL });

  // 等 4s 让 mock 数据 + 渲染完成
  await new Promise(r => setTimeout(r, 4000));

  // 检查 DOM
  const dom = await cdp('Runtime.evaluate', {
    expression: `(() => {
      const text = document.body?.textContent || '';
      return {
        title: document.title,
        hasKpi: !!document.getElementById('kpiRow'),
        hasGates: !!document.getElementById('gatesRow'),
        hasRecs: !!document.getElementById('recGrid'),
        hasPools: !!document.getElementById('poolsRow'),
        kpiCount: document.querySelectorAll('#kpiRow .kpi').length,
        gatesCount: document.querySelectorAll('#gatesRow .gate').length,
        recCount: document.querySelectorAll('#recGrid .rec-card').length,
        poolCount: document.querySelectorAll('#poolsRow .pool').length,
        sampleText: text.slice(0, 200)
      };
    })()`,
    returnByValue: true
  });
  log('DOM:', JSON.stringify(dom.result.value, null, 2));

  // 截图
  const png = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'dashboard.png'), Buffer.from(png.data, 'base64'));
  log('已截图: ' + path.join(OUT_DIR, 'dashboard.png'));

  // 测一下下单 modal
  await cdp('Runtime.evaluate', {
    expression: `document.querySelector('[data-buy]')?.click()`
  });
  await new Promise(r => setTimeout(r, 600));
  const png2 = await cdp('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT_DIR, 'buy-dialog.png'), Buffer.from(png2.data, 'base64'));
  log('已截图 modal: ' + path.join(OUT_DIR, 'buy-dialog.png'));

  // 报告
  log('--- 报告 ---');
  log('Console errors:', consoleErrors.length);
  consoleErrors.slice(0, 5).forEach(e => log('  -', e));
  log('Exceptions:', errors.length);
  errors.slice(0, 5).forEach(e => log('  -', e));

  ws.close();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });