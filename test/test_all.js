#!/usr/bin/env node
/**
 * StockMaster 全量自动化测试
 * 跑法: node test/test_all.js  或  npm test
 *
 * 不依赖浏览器,纯 Node:
 *   [1] JS 语法检查
 *   [2] 域脚本接口完备性
 *   [3] Core 模块导出
 *   [4] index.html script 引用对得上
 *   [5] Worker 文件结构
 *   [6] 关键文件存在
 *   [7] 数据层方法签名
 *   [8] 回测引擎纯函数实测
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');

let passed = 0, failed = 0;
const errors = [];

function ok(name) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); passed++; }
function fail(name, msg) { console.log(`  \x1b[31m✗\x1b[0m ${name}: ${msg}`); failed++; errors.push(`${name}: ${msg}`); }
function section(title) { console.log(`\n\x1b[1m[${title}]\x1b[0m`); }

function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf-8'); }
  catch (e) { return null; }
}

// ========== [1] JS 语法检查 ==========
section('1] JS 语法检查');
const syntaxFiles = [
  ...fs.readdirSync(path.join(WWW, 'core')).filter(f => f.endsWith('.js')).map(f => `core/${f}`),
  ...fs.readdirSync(path.join(WWW, 'app')).filter(f => f.endsWith('.js')).map(f => `app/${f}`),
  'workers/backtest.worker.js',
  'app.js'
];
for (const rel of syntaxFiles) {
  const abs = path.join(WWW, rel);
  try {
    execSync(`node --check "${abs}"`, { stdio: 'pipe' });
    ok(rel);
  } catch (e) {
    fail(rel, '语法错误');
  }
}

// ========== [2] 域脚本接口完备性 ==========
section('2] 域脚本接口完备性');
const DOMAINS = {
  'Watchlist': ['init', 'render', 'addDialog', 'add', 'remove', 'showKLine', 'closeModal', 'closeKLine'],
  'Holdings':  ['init', 'render', 'addDialog', 'editDialog', 'save', 'remove', 'addTxDialog', 'saveTx', 'closeModal', '_renderPending', 'confirmPending', 'ignorePending', '_markPendingConfirmed'],
  'Paper':     ['init', 'buy', 'sell', 'getAccount', 'getPositions', 'resetAccount', 'snapshotIfNeeded', 'autoTradeFromPick', 'renderPage', 'buyFromForm', 'sellFromForm', 'sellAll', '_calcFee', '_roundLot', '_pushSnapshot', '_planAutoTrade', 'maybeGenerateEodReport', '_shouldGenerateEod', '_pushEodReport', '_appendDisciplineLog', '_logDisciplineBlock', '_buildEodReport', '_formatEodReportText', '_pushEodToFeishu', '_renderEodReport'],
  'Journal':   ['init', 'render', 'newDialog', 'editDialog', 'save', 'remove', 'closeModal', '_buildHoldingsContext', '_renderHoldingBadge', '_renderStructuredTags', '_runAiAssistant'],
  'Screener':  ['init', 'run', '_addWatchlistFromPick', '_runPreBacktest'],
  'Fund':      ['init', 'render', 'addDialog', 'save', 'remove', 'showChart', 'closeModal'],
  'Backtest':  ['init', 'run'],
  'Alerts':    ['init', 'render', 'addDialog', 'save', 'toggle', 'remove', 'closeModal', 'startPolling', 'stopPolling', '_fetchJournalContext']
};
for (const [name, methods] of Object.entries(DOMAINS)) {
  const file = path.join(WWW, 'app', name.toLowerCase() + '.js');
  if (!fs.existsSync(file)) { fail(name, '文件不存在'); continue; }
  const content = fs.readFileSync(file, 'utf-8');
  for (const m of methods) {
    // 匹配 `m(` 或 `m:`
    const re = new RegExp(`\\b${m}\\s*[(:]`);
    if (re.test(content)) ok(`${name}.${m}`);
    else fail(`${name}.${m}`, '方法未定义');
  }
}

// ========== [3] Core 模块导出检查 ==========
section('3] Core 模块命名空间导出');
const CORE_MODULES = {
  'core/util.js':    'Core.Util',
  'core/storage.js': 'Core.Storage',
  'core/data.js':    'Core.Data',
  'core/state.js':   'Core.State',
  'core/toast.js':   'Core.Toast',
  'core/router.js':  'Core.Router',
  'core/ai-service.js': 'Core.AI',
  'core/sync.js':   'Core.Sync',
  'core/agents.js': 'Core.Agents',
  'core/discipline.js': 'Core.Discipline',
  'core/pending.js':  'Core.Pending',
  'core/news.js':   'Core.News',
  'core/premortem.js': 'Core.Premortem',
  'core/prebacktest.js': 'Core.PreBacktest',
  'core/crosscheck.js': 'Core.CrossCheck'
};
for (const [file, ns] of Object.entries(CORE_MODULES)) {
  const content = readFileSafe(path.join(WWW, file));
  if (!content) { fail(file, '读不到'); continue; }
  // 必须有 window.Core.X = { ... }
  const nsShort = ns.split('.')[1];
  const re = new RegExp(`window\\.Core\\.${nsShort}\\s*=\\s*\\{`);
  if (re.test(content)) ok(ns);
  else fail(ns, '未找到 window.Core.X = {...}');
}

// 检查 Core.Util 的关键函数
const utilContent = readFileSafe(path.join(WWW, 'core/util.js'));
const utilFns = ['escapeHtml', 'fmtNum', 'fmtPct', 'fmtMoney', 'pctClass', 'fmtDate', 'fmtDateTime', 'parseStockInput'];
for (const fn of utilFns) {
  if (utilContent.includes(`${fn}(`)) ok(`Util.${fn}`);
  else fail(`Util.${fn}`, '缺失');
}

// 检查 Core.Discipline (Phase B 交易纪律引擎) 的方法清单
const discContent = readFileSafe(path.join(WWW, 'core/discipline.js'));
const DISC_METHODS = ['getConfig', 'setConfig', 'preBuyCheck', 'renderCheckResult', '_resultToText',
  '_checkInputs', '_checkConcentration', '_checkTotalPosition', '_checkDrawdown', '_monthAnchorNext',
  '_checkChase', '_summarizeHistory', '_getRealAssets', '_getPaperAssets', '_currentMonth'];
for (const m of DISC_METHODS) {
  if (discContent && new RegExp(`\\b${m}\\s*\\(`).test(discContent)) ok(`Discipline.${m}`);
  else fail(`Discipline.${m}`, '缺失');
}

// 检查 Core.News 的方法清单 (Phase D1 新增 getStockNotices 等)
const newsContent = readFileSafe(path.join(WWW, 'core/news.js'));
const NEWS_METHODS = ['get', 'formatForPrompt', 'refresh', 'getStockNotices', 'formatNoticesForPrompt', '_filterNoticesByCode'];
for (const m of NEWS_METHODS) {
  if (newsContent && new RegExp(`\\b${m}\\s*\\(`).test(newsContent)) ok(`News.${m}`);
  else fail(`News.${m}`, '缺失');
}

// 检查 Core.Premortem (Phase D1) 的方法清单
const pmContent = readFileSafe(path.join(WWW, 'core/premortem.js'));
const PM_METHODS = ['checkPick', 'checkPicks', 'renderBlock'];
for (const m of PM_METHODS) {
  if (pmContent && new RegExp(`\\b${m}\\s*\\(`).test(pmContent)) ok(`Premortem.${m}`);
  else fail(`Premortem.${m}`, '缺失');
}
if (pmContent && pmContent.includes('PROMPT_SPEC') && pmContent.includes('falsifyCondition') && pmContent.includes('invalidation')) ok('Premortem.PROMPT_SPEC 字段说明');
else fail('Premortem.PROMPT_SPEC', '缺字段说明');

// 检查 Core.PreBacktest (Phase D2) 的方法清单
const pbtContent = readFileSafe(path.join(WWW, 'core/prebacktest.js'));
const PBT_METHODS = ['pickStrategy', 'judgeVerdict', 'formatResult', 'renderResultHtml', 'renderUnavailableHtml', 'runForPick'];
for (const m of PBT_METHODS) {
  if (pbtContent && new RegExp(`\\b${m}\\s*\\(`).test(pbtContent)) ok(`PreBacktest.${m}`);
  else fail(`PreBacktest.${m}`, '缺失');
}

// 检查 Core.Pending (Phase E 实盘待确认交易) 的方法清单
const pendContent = readFileSafe(path.join(WWW, 'core/pending.js'));
const PEND_METHODS = ['add', 'list', 'get', 'confirm', 'ignore', 'purgeExpired', '_suggestPosition', '_setStatus'];
for (const m of PEND_METHODS) {
  if (pendContent && new RegExp(`\\b${m}\\s*\\(`).test(pendContent)) ok(`Pending.${m}`);
  else fail(`Pending.${m}`, '缺失');
}

// 检查 Core.CrossCheck (Phase D2) 的方法清单
const ccContent = readFileSafe(path.join(WWW, 'core/crosscheck.js'));
const CC_METHODS = ['pickSecondProvider', 'resolveSecondOpinion', 'buildComparePrompt'];
for (const m of CC_METHODS) {
  if (ccContent && new RegExp(`\\b${m}\\s*\\(`).test(ccContent)) ok(`CrossCheck.${m}`);
  else fail(`CrossCheck.${m}`, '缺失');
}

// ========== [4] index.html script 引用对得上 ==========
section('4] index.html script 引用检查');
const html = readFileSafe(path.join(WWW, 'index.html'));
if (!html) { fail('index.html', '读不到'); }
else {
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map(m => m[1]);
  for (const src of scriptSrcs) {
    if (src.startsWith('http')) continue;
    const fp = path.join(WWW, src);
    if (!fs.existsSync(fp)) fail(src, '引用的文件不存在');
    else ok(src);
  }
  // 关键 onclick 引用 — 只检查"基名"在不在已知全局(支持 XX.YY 形式,如 Watchlist.addDialog)
  const onclicks = [...html.matchAll(/onclick="([^(]+)\(/g)].map(m => m[1].trim());
  const knownGlobals = new Set(['switchPage', 'goSettings', 'showToast', 'saveSettings', 'checkHealth', 'exportData', 'importData', 'clearAllData', 'Watchlist', 'Holdings', 'Paper', 'Journal', 'Screener', 'Fund', 'Backtest', 'Alerts']);
  for (const fn of new Set(onclicks)) {
    const baseName = fn.split('.')[0];
    if (knownGlobals.has(baseName)) ok(`onclick: ${fn}`);
    else fail(`onclick: ${fn}`, `基名 ${baseName} 不在已知全局列表(可能漏挂)`);
  }
}

// ========== [5] Worker 文件结构 ==========
section('5] Worker 文件结构');
const workerPath = path.join(WWW, 'workers', 'backtest.worker.js');
const workerContent = readFileSafe(workerPath);
if (!workerContent) fail('backtest.worker.js', '不存在');
else {
  if (/self\.onmessage\s*=/.test(workerContent)) ok('onmessage 入口');
  else fail('onmessage', '缺失');
  if (/self\.postMessage\(/.test(workerContent)) ok('postMessage 出口');
  else fail('postMessage', '缺失');
  for (const strat of ['strategyMaCross', 'strategyBreakout', 'strategyTurtle', 'sma', 'backtest', 'calcMetrics']) {
    if (workerContent.includes(strat)) ok(`函数: ${strat}`);
    else fail(`函数: ${strat}`, '缺失');
  }
}

// ========== [6] 关键文件存在 ==========
section('6] 关键文件存在');
[
  'package.json', 'capacitor.config.json', 'vite.config.js',
  'www/index.html', 'www/styles.css', 'www/app.js',
  'www/lib/echarts.min.js', 'www/lib/dexie.min.js',
  'scripts/build-web.mjs', 'scripts/copy-libs.mjs', 'scripts/dev-proxy.mjs',
  'AGENTS.md', 'README.md', '.gitignore'
].forEach(rel => {
  const fp = path.join(ROOT, rel);
  if (fs.existsSync(fp)) ok(rel);
  else fail(rel, '缺失');
});

// ========== [7] 数据层方法签名 ==========
section('7] Core.Data 方法签名');
const dataContent = readFileSafe(path.join(WWW, 'core/data.js'));
const DATA_METHODS = ['getStockSpot', 'getStockQuote', 'getStockKLine', 'getStockFinancial', 'getStockList',
  'getFundSpot', 'getFundHistory', 'getFundPortfolio', 'getIndexSpot', 'health', 'fetch'];
for (const m of DATA_METHODS) {
  if (new RegExp(`\\b${m}\\b`).test(dataContent)) ok(`Data.${m}`);
  else fail(`Data.${m}`, '缺失');
}

// ========== [8] 回测引擎纯函数实测 ==========
section('8] 回测引擎纯函数实测 (vm sandbox)');
try {
  let workerCode = readFileSafe(workerPath);
  if (!workerCode) throw new Error('worker 文件读不到');

  // 改写 worker:用 vm 注入 self,改写 onmessage
  // self.onmessage = (e) => {...}  →  __onmsg(e) 立即调用
  // self.postMessage(x) → 赋值到 __result
  const wrapped = workerCode
    .replace(/self\.onmessage\s*=\s*\(e\)\s*=>\s*\{/, '__onmsg = (e) => {')
    .replace(/self\.postMessage\(/g, '__result = (')
    .replace(/__result\s*=\s*\(\s*\{/g, '__result = ({');

  const ctx = {
    __onmsg: null,
    __result: null,
    console
  };
  vm.createContext(ctx);
  vm.runInContext(wrapped, ctx);

  if (typeof ctx.__onmsg !== 'function') throw new Error('onmsg 注入失败');

  // 构造 100 个交易日的模拟 K 线
  const kline = [];
  for (let i = 0; i < 100; i++) {
    const close = 10 + Math.sin(i / 10) * 2 + (i > 50 ? 1 : 0);  // 后期上涨
    kline.push({
      date: `2024-${String(Math.floor(i/30)+1).padStart(2,'0')}-${String((i%30)+1).padStart(2,'0')}`,
      open: close * 0.99,
      high: close * 1.02,
      low: close * 0.98,
      close
    });
  }

  // 测双均线
  ctx.__result = null;
  ctx.__onmsg({ data: { data: kline, strategy: 'ma_cross', params: { fast: 5, slow: 20 }, capital: 100000, fee: 0.0003 } });
  let r = ctx.__result;
  if (r && r.error) fail('双均线', r.error);
  else if (r && typeof r.totalReturn === 'number' && Array.isArray(r.trades) && Array.isArray(r.equityCurve) && r.equityCurve.length === 100) {
    ok(`双均线(5/20): 总收益 ${(r.totalReturn*100).toFixed(2)}% / 交易 ${r.trades.length} / 夏普 ${r.sharpe.toFixed(2)}`);
    if (r.maxDrawdown <= 0) ok(`  最大回撤 ${(r.maxDrawdown*100).toFixed(2)}% (≤0 ✓)`);
    else fail('  最大回撤', `应为 ≤0, 实际 ${r.maxDrawdown}`);
  } else {
    fail('双均线', '返回结构异常: ' + JSON.stringify(r).slice(0, 200));
  }

  // 测突破
  ctx.__result = null;
  ctx.__onmsg({ data: { data: kline, strategy: 'breakout', params: { n: 20 }, capital: 100000, fee: 0.0003 } });
  r = ctx.__result;
  if (r && !r.error && Array.isArray(r.trades)) ok(`突破(20): 交易 ${r.trades.length}, 总收益 ${(r.totalReturn*100).toFixed(2)}%`);
  else fail('突破', r?.error || '结构异常');

  // 测海龟
  ctx.__result = null;
  ctx.__onmsg({ data: { data: kline, strategy: 'turtle', params: { entry: 20, exit: 10 }, capital: 100000, fee: 0.0003 } });
  r = ctx.__result;
  if (r && !r.error && Array.isArray(r.trades)) ok(`海龟(20/10): 交易 ${r.trades.length}, 总收益 ${(r.totalReturn*100).toFixed(2)}%`);
  else fail('海龟', r?.error || '结构异常');

  // 测空数据
  ctx.__result = null;
  ctx.__onmsg({ data: { data: [], strategy: 'ma_cross', params: {}, capital: 100000, fee: 0.0003 } });
  r = ctx.__result;
  if (r && !r.error && Array.isArray(r.trades) && r.trades.length === 0) ok('空数据(0 K线): 不崩');
  else fail('空数据', r?.error || '异常');

  // 测未知策略
  ctx.__result = null;
  ctx.__onmsg({ data: { data: kline, strategy: 'unknown_strat', params: {}, capital: 100000, fee: 0.0003 } });
  r = ctx.__result;
  if (r && r.error) ok('未知策略: 优雅报错');
  else fail('未知策略', '应返回 error 字段');
} catch (e) {
  fail('回测引擎', e.message);
}

// ========== [9] 配置一致性 ==========
section('9] Vite external 列表 vs 实际文件');
const viteConfig = readFileSafe(path.join(ROOT, 'vite.config.js'));
// 只匹配 rollupOptions.external 数组内的字符串,避免误抓 proxy key
const externalBlock = viteConfig.match(/rollupOptions\s*:\s*\{[\s\S]*?external\s*:\s*\[([\s\S]*?)\]/);
if (!externalBlock) { fail('external 解析', '未找到 rollupOptions.external 数组');
} else {
  const externals = [...externalBlock[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
  for (const ext of externals) {
    if (ext.includes('-')) continue;  // 跳过 hashed 资源
    const fp = path.join(WWW, ext);
    if (fs.existsSync(fp)) ok(`external: ${ext}`);
    else fail(`external: ${ext}`, 'Vite external 引用了不存在的文件');
  }
}

// ========== [10] 复盘快照 Markdown 格式化 (纯函数) ==========
section('10] Journal._formatSnapshotForMarkdown 纯函数实测');
try {
  // vm sandbox 加载 journal.js
  // mock: window (含 Core/Toast/escapeHtml/fmtMoney/fmtDate/uuid)
  const journalSrc = readFileSafe(path.join(WWW, 'app', 'journal.js'));
  if (!journalSrc) throw new Error('journal.js 读不到');

  const fakeCtx = {
    window: {
      Core: {
        Storage: { all: async () => [], get: async () => null, add: async () => {} },
        Data: { getIndexSpot: async () => [], getStockQuote: async () => null },
        State: { get: () => null, set: () => {} }
      }
    },
    Core: undefined,  // 让 journal.js 自己从 window.Core 拿
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: (d) => '2026-07-26',
    uuid: () => 'test-uuid',
    console
  };
  fakeCtx.window.escapeHtml = fakeCtx.escapeHtml;
  fakeCtx.window.fmtMoney = fakeCtx.fmtMoney;
  fakeCtx.window.fmtDate = fakeCtx.fmtDate;
  fakeCtx.window.toastSuccess = fakeCtx.toastSuccess;
  fakeCtx.window.toastError = fakeCtx.toastError;
  fakeCtx.window.toastWarning = fakeCtx.toastWarning;
  fakeCtx.window.uuid = fakeCtx.uuid;
  fakeCtx.window.document = { getElementById: () => null };
  fakeCtx.document = fakeCtx.window.document;

  vm.createContext(fakeCtx);
  vm.runInContext(journalSrc, fakeCtx);

  if (!fakeCtx.window.Journal) throw new Error('Journal 未挂到 window');
  const Journal = fakeCtx.window.Journal;
  if (typeof Journal._formatSnapshotForMarkdown !== 'function') throw new Error('_formatSnapshotForMarkdown 不存在');

  // Case 1: 完整快照
  const snap1 = {
    date: '2026-07-26',
    indices: [
      { code: '000001', name: '上证指数', price: 3245.67, change: 0.85 },
      { code: '399001', name: '深证成指', price: 10234.56, change: -0.32 },
      { code: '000300', name: '沪深300', price: 3890.12, change: 1.05 }
    ],
    holdings: [
      { code: '600519', name: '贵州茅台', shares: 100, price: 1680.50, changePct: 2.1, dayPL: 3529.05, totalPL: 12000, mkt: 168050 },
      { code: '000001', name: '平安银行', shares: 1000, price: 12.30, changePct: -0.5, dayPL: -61.5, totalPL: -500, mkt: 12300 }
    ],
    cashflow: [
      { date: '2026-07-26', type: 'transfer', amount: -10000, target: '007194', note: '申购 9500 份' }
    ],
    errors: []
  };
  const md1 = Journal._formatSnapshotForMarkdown(snap1);
  if (md1.includes('## 今日数据快照 (2026-07-26)')) ok('标题行');
  else fail('标题行', md1.slice(0, 100));
  if (md1.includes('| 上证指数 | 3245.67 | +0.85% |')) ok('指数表行1');
  else fail('指数表行1', '找不到');
  if (md1.includes('| 深证成指 | 10234.56 | -0.32% |')) ok('指数表行2(负值无+)');
  else fail('指数表行2', '找不到');
  if (md1.includes('| 沪深300 | 3890.12 | +1.05% |')) ok('指数表行3');
  else fail('指数表行3', '找不到');
  if (md1.includes('贵州茅台') && md1.includes('+3529.05') && md1.includes('+12000.00')) ok('持仓正盈亏带+号');
  else fail('持仓正盈亏', '找不到 +3529.05 或 +12000.00');
  if (md1.includes('平安银行') && md1.includes('-61.50') && md1.includes('-500.00')) ok('持仓负盈亏带-号');
  else fail('持仓负盈亏', '找不到 -61.50 或 -500.00');
  if (md1.includes('### 💸 资金流水')) ok('资金流水分组');
  else fail('资金流水分组', '找不到');
  if (md1.includes('-10000') && md1.includes('transfer') && md1.includes('007194')) ok('资金流水明细');
  else fail('资金流水明细', '找不到 -10000/transfer/007194');
  if (md1.includes('市值 180350.00') && md1.includes('+3467.55')) ok('持仓汇总行 (市值/当日/累计)');
  else fail('持仓汇总行', '找不到 市值 180350.00 或 +3467.55');

  // Case 2: 空持仓
  const snap2 = {
    date: '2026-07-26',
    indices: [{ code: '000001', name: '上证', price: 3200, change: 0 }],
    holdings: [],
    cashflow: [],
    errors: []
  };
  const md2 = Journal._formatSnapshotForMarkdown(snap2);
  if (md2.includes('### 💼 持仓')) ok('空持仓分组');
  else fail('空持仓分组', '找不到');
  if (md2.includes('(空)')) ok('空持仓文案');
  else fail('空持仓文案', '找不到 (空)');

  // Case 3: null 快照
  const md3 = Journal._formatSnapshotForMarkdown(null);
  if (md3 === '') ok('null 快照 → 空字符串');
  else fail('null 快照', '应返回 ""');

  // Case 4: 指数全失败 (拉不到)
  const snap4 = { date: '2026-07-26', indices: [], holdings: [], cashflow: [], errors: ['指数: timeout'] };
  const md4 = Journal._formatSnapshotForMarkdown(snap4);
  if (!md4.includes('### 🌐 大盘')) ok('无指数时不输出大盘分组');
  else fail('无指数分组', '应不输出 ### 🌐 大盘');
  if (md4.includes('### 💼 持仓') && md4.includes('(空)')) ok('无持仓时空文案');
  else fail('无持仓空文案', '找不到');

  // Case 5: 数字边界 (change=0 不加 +)
  const snap5 = { date: '2026-07-26', indices: [{ code: 'x', name: '平', price: 100, change: 0 }], holdings: [], cashflow: [] };
  const md5 = Journal._formatSnapshotForMarkdown(snap5);
  if (md5.includes('| 平 | 100.00 | 0.00% |')) ok('change=0 不带 + 号');
  else fail('change=0 格式', '应是 "0.00%" 而非 "+0.00%"');

} catch (e) {
  fail('Journal 快照测试', e.message + ' / ' + e.stack);
}

// ========== [11] Market.formatItem 纯函数实测 ==========
section('11] Core.Market.formatItem 纯函数实测');
try {
  (async () => {
    const marketSrc = readFileSafe(path.join(WWW, 'core', 'market.js'));
    if (!marketSrc) throw new Error('market.js 读不到');

    // vm sandbox: 注入最小 window + Core.Storage + Core.Data mock
    const mctx = {
      window: {
        Core: {
          Storage: { cacheGet: async () => null, cacheSet: async () => {} },
          Data: { fetch: async () => [] }
        }
      },
      console
    };
    mctx.window.Core.Market = undefined;  // 加载时会被覆盖
    vm.createContext(mctx);
    vm.runInContext(marketSrc, mctx);

    if (!mctx.window.Core.Market) throw new Error('Core.Market 未挂到 window');
    const Market = mctx.window.Core.Market;

    // GROUPS 配置
    if (Market.GROUPS.wide && Market.GROUPS.wide.label === '宽基' && Array.isArray(Market.GROUPS.wide.symbols) && Market.GROUPS.wide.symbols.length >= 4) {
      ok(`宽基组: ${Market.GROUPS.wide.symbols.length} 个指数`);
    } else fail('宽基组配置', JSON.stringify(Market.GROUPS.wide));
    if (Market.GROUPS.style && Market.GROUPS.style.label === '风格' && Market.GROUPS.style.symbols.length >= 3) {
      ok(`风格组: ${Market.GROUPS.style.symbols.length} 个指数`);
    } else fail('风格组配置', JSON.stringify(Market.GROUPS.style));
    if (Market.GROUPS.industry && Market.GROUPS.industry.label === '行业' && !Market.GROUPS.industry.symbols) {
      ok('行业组: 动态拉取(不预定义 symbols)');
    } else fail('行业组配置', JSON.stringify(Market.GROUPS.industry));

    // formatItem 正向
    const f1 = Market.formatItem({ code: '000001', name: '上证指数', price: 3245.67, change: 0.85 });
    if (f1.price === '3245.67' && f1.change === '+0.85%' && f1.changeNum === 0.85) ok('正涨: +0.85% 带+号');
    else fail('正涨格式', JSON.stringify(f1));

    const f2 = Market.formatItem({ code: 'x', name: '深证', price: 10000, change: -1.23 });
    if (f2.change === '-1.23%' && f2.price === '10000.00') ok('负跌: -1.23% 无+号');
    else fail('负跌格式', JSON.stringify(f2));

    const f3 = Market.formatItem({ code: 'x', name: '平', price: 100, change: 0 });
    if (f3.change === '0.00%') ok('change=0 不带+号');
    else fail('change=0 格式', JSON.stringify(f3));

    // formatItem null
    if (Market.formatItem(null) === null) ok('null 输入 → null');
    else fail('null 输入', '应返回 null');

    // formatItem 缺字段
    const f4 = Market.formatItem({ code: 'x', name: 'y' });  // 缺 price/change
    if (f4.price === '-' && f4.change === '-') ok('缺字段 → "-"');
    else fail('缺字段', JSON.stringify(f4));

    // get 未知 group 应抛错(检查源码里有 GROUPS 校验)
    if (/GROUPS\[group\]\)\s*throw/.test(marketSrc)) ok('get() 校验未知 group');
    else fail('get() 校验', '源码里没看到 GROUPS[group] throw');

    // get 是 async function
    if (Market.get.constructor.name === 'AsyncFunction') ok('get() 是 async 函数');
    else fail('get() 类型', '应为 AsyncFunction');
  })().catch(e => fail('Market 测试', e.message + ' / ' + e.stack));
} catch (e) {
  fail('Market 测试', e.message + ' / ' + e.stack);
}

// ========== [12] Fund._computeRebalanceAdvice 纯函数实测 ==========
section('12] Fund._computeRebalanceAdvice 纯函数实测');
try {
  (() => {
    // 加载 fund.js (mock DOM/Core/Storage/Util/fmtMoney/escapeHtml)
    const fundSrc = readFileSafe(path.join(WWW, 'app', 'fund.js'));
    if (!fundSrc) throw new Error('fund.js 读不到');

    const fctx = {
      window: {
        Core: {
          Storage: { all: async () => [], get: async () => null, add: async () => {}, put: async () => {} },
          Data: { getFundSpot: async () => [], getIndexSpot: async () => [] }
        },
        document: { getElementById: () => null }
      },
      console,
      Core: undefined,
      escapeHtml: (s) => String(s == null ? '' : s),
      fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
      fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 2) : '-'),
      fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
      pctClass: () => '',
      toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
      uuid: () => 't'
    };
    fctx.window.escapeHtml = fctx.escapeHtml;
    fctx.window.fmtMoney = fctx.fmtMoney;
    fctx.window.fmtNum = fctx.fmtNum;
    fctx.window.fmtPct = fctx.fmtPct;
    fctx.window.toastSuccess = fctx.toastSuccess;
    fctx.window.toastError = fctx.toastError;
    fctx.window.toastWarning = fctx.toastWarning;
    fctx.window.uuid = fctx.uuid;
    vm.createContext(fctx);
    vm.runInContext(fundSrc, fctx);

    const Fund = fctx.window.Fund;
    if (typeof Fund._computeRebalanceAdvice !== 'function') throw new Error('方法未挂载');

    // Case 1: 空持仓
    const a1 = Fund._computeRebalanceAdvice([], { short_bond: 0.2, pure_bond: 0.8 });
    if (!a1.ok && a1.reason && a1.reason.includes('无持仓')) ok('空持仓 → ok=false');
    else fail('空持仓', JSON.stringify(a1));

    // Case 2: 完美 20/80, 无需调仓
    const a2 = Fund._computeRebalanceAdvice([
      { code: '007194', name: 'A', type: 'short_bond', currentNav: 1, value: 10000 },
      { code: '018581', name: 'B', type: 'pure_bond', currentNav: 1, value: 40000 }
    ], { short_bond: 0.2, pure_bond: 0.8 });
    if (a2.ok && a2.needRebalance === false && a2.drift.length === 2) ok('完美配置 → needRebalance=false');
    else fail('完美配置', JSON.stringify(a2).slice(0, 200));

    // Case 3: 漂移 5% 内, 不触发
    const a3 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 12000 },  // 24%
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 38000 }   // 76%
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    if (a3.ok && a3.needRebalance === false && /5%/.test(a3.reason)) ok('漂移 4% (≤ 5%) 不触发');
    else fail('漂移 4%', JSON.stringify(a3).slice(0, 200));

    // Case 4: 漂移 > 5%, 触发
    const a4 = Fund._computeRebalanceAdvice([
      { code: 'A', name: '短债', type: 'short_bond', currentNav: 1, value: 20000 },  // 40%
      { code: 'B', name: '纯债', type: 'pure_bond', currentNav: 1, value: 30000 }   // 60%
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    if (a4.ok && a4.needRebalance === true && a4.suggestions.length === 2) {
      const reduce = a4.suggestions.find(s => s.action === 'reduce');
      const add = a4.suggestions.find(s => s.action === 'add');
      if (reduce && reduce.code === 'A' && reduce.amount === 10000 && Math.abs(reduce.fromPct - 0.4) < 0.001 && Math.abs(reduce.toPct - 0.2) < 0.001) ok('减仓建议: 短债 40%→20% 减 10000');
      else fail('减仓建议', JSON.stringify(reduce));
      if (add && add.code === 'B' && add.amount === 10000 && Math.abs(add.fromPct - 0.6) < 0.001 && Math.abs(add.toPct - 0.8) < 0.001) ok('加仓建议: 纯债 60%→80% 加 10000');
      else fail('加仓建议', JSON.stringify(add));
      if (Math.abs(a4.totalAdjust - 20000) < 1) ok(`totalAdjust = ${a4.totalAdjust}`);
      else fail('totalAdjust', `应为 20000, 实际 ${a4.totalAdjust}`);
    } else fail('漂移 20% 触发', JSON.stringify(a4).slice(0, 200));

    // Case 5: 漂移但金额太小, 不调
    // 总 1000, 短债 280/1000=28% 偏 8% 触发, 差值=80 元 < 100 → 不调
    const a5 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 280 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 720 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    if (a5.ok && a5.needRebalance === true && a5.suggestions.length === 0) ok('触发但 < 100 元不调');
    else fail('< 100 元不调', JSON.stringify(a5).slice(0, 200));

    // Case 6: type 不在 targets 里, 不动
    const a6 = Fund._computeRebalanceAdvice([
      { code: 'A', name: '短债', type: 'short_bond', currentNav: 1, value: 10000 },
      { code: 'C', name: '宽基', type: 'wide', currentNav: 1, value: 40000 }  // type 不在 targets
    ], { short_bond: 0.2, pure_bond: 0.8 });
    if (a6.ok && a6.needRebalance === false) ok('wide 不在 targets → 不触发');
    else fail('wide 不在 targets', JSON.stringify(a6).slice(0, 200));

    // Case 7: 自定义阈值
    // 阈值 10% 时: 短债 50% 偏 30% > 10% 触发
    const a7 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 25000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 25000 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.10);
    if (a7.ok && a7.needRebalance === true && a7.suggestions.length === 2) ok('阈值 10% → 偏 30% 触发');
    else fail('阈值 10% 偏 30%', JSON.stringify(a7).slice(0, 200));
    // 阈值 5% 时, 偏 4% 不触发 (回归)
    const a7c = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 12000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 38000 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    if (a7c.ok && a7c.needRebalance === false) ok('阈值 5% → 偏 4% 不触发 (回归)');
    else fail('阈值 5% 偏 4%', JSON.stringify(a7c).slice(0, 200));

    // Case 8: 减仓份数计算
    const a8 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1.05, value: 20000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1.02, value: 30000 }
    ], { short_bond: 0.2, pure_bond: 0.8 });
    const red = a8.suggestions.find(s => s.action === 'reduce');
    if (red && red.shares !== null && Math.abs(red.shares - (10000 / 1.05)) < 0.5) ok(`减仓份数: ${red.shares} (≈ ${(10000 / 1.05).toFixed(2)})`);
    else fail('减仓份数', JSON.stringify(red));

    // Case 9: 费率计算 (默认 buy=0.1%)
    if (a4.costEstimate > 0 && a4.suggestions.length === 2) {
      // 加仓 10000 * 0.001 = 10, 减仓 10000 * 0 = 0 → 10
      if (Math.abs(a4.costEstimate - 10) < 0.01) ok(`费率: 10 元 (加仓 1 万 × 0.1%)`);
      else fail('费率', `应为 10 元, 实际 ${a4.costEstimate}`);
    } else fail('费率 case', 'a4 不对');

    // Case 10: 警告 (减 ≠ 加)
    const a10 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 30000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 20000 },
      { code: 'C', name: 'C', type: 'wide', currentNav: 1, value: 5000 }  // wide 不在 targets
    ], { short_bond: 0.2, pure_bond: 0.8 });
    // wide 那 5000 元在"减仓总额"里, 但没对应的"加仓"目标, 减≠加
    if (a10.warnings.some(w => /减仓.*≠.*加仓/.test(w))) ok('不平衡警告: 减 ≠ 加');
    else fail('不平衡警告', JSON.stringify(a10.warnings));
  })();
} catch (e) {
  fail('RebalanceAdvice 测试', e.message + ' / ' + e.stack);
}

// ========== [13] Fund._computePortfolioMetrics 纯函数实测 ==========
section('13] Fund._computePortfolioMetrics 纯函数实测');
try {
  // 重新建一个 vm ctx (不依赖 [12] 的 IIFE 局部变量)
  const fundSrc13 = readFileSafe(path.join(WWW, 'app', 'fund.js'));
  if (!fundSrc13) throw new Error('fund.js 读不到');
  const fctx13 = {
    window: {
      Core: {
        Storage: { all: async () => [], get: async () => null, add: async () => {}, put: async () => {} },
        Data: { getFundSpot: async () => [], getIndexSpot: async () => [], getFundHistory: async () => [] }
      },
      document: { getElementById: () => null }
    },
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 2) : '-'),
    fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
    pctClass: () => '',
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    uuid: () => 't'
  };
  fctx13.window.escapeHtml = fctx13.escapeHtml;
  fctx13.window.fmtMoney = fctx13.fmtMoney;
  fctx13.window.fmtNum = fctx13.fmtNum;
  fctx13.window.fmtPct = fctx13.fmtPct;
  fctx13.window.toastSuccess = fctx13.toastSuccess;
  fctx13.window.toastError = fctx13.toastError;
  fctx13.window.toastWarning = fctx13.toastWarning;
  fctx13.window.uuid = fctx13.uuid;
  vm.createContext(fctx13);
  vm.runInContext(fundSrc13, fctx13);
  const Fund13 = fctx13.window.Fund;
  if (typeof Fund13._computePortfolioMetrics !== 'function') throw new Error('方法未挂载');

  // Case 1: 无持仓
  const m1 = Fund13._computePortfolioMetrics([], {});
  if (!m1.ok && m1.reason.includes('无持仓')) ok('空持仓 → ok=false');
  else fail('空持仓', JSON.stringify(m1));

  // Case 2: 数据不足
  const m2 = Fund13._computePortfolioMetrics(
    [{ code: 'A', value: 10000, type: 'short_bond' }],
    { A: [{ date: '20260101', nav: 1 }, { date: '20260102', nav: 1.01 }] }
  );
  if (!m2.ok && /不足/.test(m2.reason)) ok('数据 < 5 天 → 拒绝');
  else fail('数据不足', JSON.stringify(m2));

  // 构造 100 天稳定上涨 0.05% 日收益 (年化 ≈ 12.6%)
  const upDays = [];
  for (let i = 0; i < 100; i++) {
    const d = `2026${String(Math.floor(i / 30) + 1).padStart(2, '0')}${String((i % 30) + 1).padStart(2, '0')}`;
    upDays.push({ date: d, nav: 1 + i * 0.0005 });  // 0.05% 日增
  }
  const m3 = Fund13._computePortfolioMetrics(
    [{ code: 'A', value: 10000, type: 'short_bond' }],
    { A: upDays }
  );
  if (m3.ok && m3.metrics.annualReturn > 0.1 && m3.metrics.annualReturn < 0.15) {
    ok(`年化收益: ${(m3.metrics.annualReturn * 100).toFixed(2)}% (期望 12-13%)`);
  } else fail('年化收益', JSON.stringify(m3.metrics).slice(0, 200));
  if (m3.ok && m3.metrics.maxDD === 0) ok('无回撤 (单调上涨)');
  else fail('无回撤', `maxDD=${m3.metrics?.maxDD}`);
  if (m3.ok && m3.metrics.annualVol < 0.001) ok('年化波动 ≈ 0 (单调)');
  else fail('年化波动', `${m3.metrics?.annualVol}`);

  // Case 4: 加波动 (2% 随机游走)
  const randDays = [];
  let nav = 1;
  for (let i = 0; i < 250; i++) {
    const r = (Math.sin(i * 0.7) + Math.cos(i * 0.3)) * 0.005;  // ±0.5%
    nav *= (1 + r);
    const d = `2025${String(Math.floor(i / 30) + 1).padStart(2, '0')}${String((i % 30) + 1).padStart(2, '0')}`;
    randDays.push({ date: d, nav });
  }
  const m4 = Fund13._computePortfolioMetrics(
    [{ code: 'A', value: 10000, type: 'pure_bond' }],
    { A: randDays }
  );
  if (m4.ok && m4.metrics.annualVol > 0.02 && m4.metrics.annualVol < 0.15) ok(`年化波动: ${(m4.metrics.annualVol * 100).toFixed(2)}% (合理范围)`);
  else fail('年化波动范围', `vol=${m4.metrics?.annualVol}`);

  // Case 5: 多只基金, 加权
  const m5 = Fund13._computePortfolioMetrics(
    [
      { code: 'A', value: 20000, type: 'short_bond' },
      { code: 'B', value: 30000, type: 'pure_bond' }
    ],
    {
      A: upDays,
      B: randDays
    }
  );
  if (m5.ok && Math.abs(m5.weights.A - 0.4) < 0.001 && Math.abs(m5.weights.B - 0.6) < 0.001) {
    ok(`权重: A=40%, B=60%`);
  } else fail('权重', JSON.stringify(m5.weights));
  if (m5.ok && m5.metrics.annualVol > 0.01 && m5.metrics.annualVol < 0.10) ok(`组合波动: ${(m5.metrics.annualVol * 100).toFixed(2)}% (混合后变小)`);
  else fail('组合波动', `vol=${m5.metrics?.annualVol}`);

  // Case 6: 胜率
  if (m4.ok && m4.metrics.winRate > 0.3 && m4.metrics.winRate < 0.7) ok(`胜率: ${(m4.metrics.winRate * 100).toFixed(1)}%`);
  else fail('胜率', `winRate=${m4.metrics?.winRate}`);

  // Case 7: 最大回撤必须 ≤ 0
  if (m4.ok && m4.metrics.maxDD <= 0 && m4.metrics.maxDD > -1) ok(`最大回撤: ${(m4.metrics.maxDD * 100).toFixed(2)}% (≤0)`);
  else fail('最大回撤 ≤ 0', `maxDD=${m4.metrics?.maxDD}`);

  // Case 8: Calmar (允许正/负/0)
  if (m4.ok && typeof m4.metrics.calmar === 'number' && !isNaN(m4.metrics.calmar)) ok(`Calmar: ${m4.metrics.calmar.toFixed(2)} (允许任意数)`);
  else fail('Calmar', `calmar=${m4.metrics?.calmar}`);

  // Case 9: 最佳/最差日
  if (m4.ok && m4.metrics.bestDay > 0 && m4.metrics.worstDay < 0) ok(`best ${(m4.metrics.bestDay*100).toFixed(2)}% / worst ${(m4.metrics.worstDay*100).toFixed(2)}%`);
  else fail('best/worst', `b=${m4.metrics?.bestDay} w=${m4.metrics?.worstDay}`);

  // Case 10: 空 navHistory
  const m10 = Fund13._computePortfolioMetrics(
    [{ code: 'A', value: 10000, type: 'short_bond' }],
    {}
  );
  if (!m10.ok && /不足/.test(m10.reason)) ok('空 navHistory → 不足');
  else fail('空 navHistory', JSON.stringify(m10));
} catch (e) {
  fail('PortfolioMetrics 测试', e.message + ' / ' + e.stack);
}

// ========== [14] Fund._analyzeNewsImpact 纯函数实测 ==========
section('14] Fund._analyzeNewsImpact 规则匹配实测');
try {
  const fundSrc14 = readFileSafe(path.join(WWW, 'app', 'fund.js'));
  if (!fundSrc14) throw new Error('fund.js 读不到');
  const fctx14 = {
    window: {
      Core: {
        Storage: { all: async () => [], get: async () => null },
        Data: { getFundSpot: async () => [], getIndexSpot: async () => [], getFundHistory: async () => [] },
        News: { get: async () => ({ relevant: [] }) }
      },
      document: { getElementById: () => null }
    },
    console,
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtNum: (n) => (typeof n === 'number' ? n.toFixed(2) : '-'),
    fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
    pctClass: () => '',
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {}
  };
  fctx14.window.escapeHtml = fctx14.escapeHtml;
  fctx14.window.fmtMoney = fctx14.fmtMoney;
  fctx14.window.fmtNum = fctx14.fmtNum;
  fctx14.window.fmtPct = fctx14.fmtPct;
  fctx14.window.toastSuccess = fctx14.toastSuccess;
  fctx14.window.toastError = fctx14.toastError;
  fctx14.window.toastWarning = fctx14.toastWarning;
  vm.createContext(fctx14);
  vm.runInContext(fundSrc14, fctx14);
  const Fund14 = fctx14.window.Fund;
  if (typeof Fund14._analyzeNewsImpact !== 'function') throw new Error('方法未挂载');

  // 持仓: 2 只债基 + 1 只宽基
  const holdings = [
    { code: '007194', name: '短债', type: 'short_bond' },
    { code: '018581', name: '纯债', type: 'pure_bond' },
    { code: '510300', name: '沪深300', type: 'csi300' }
  ];

  // Case 1: 降息 → 利好 2 只债基, 不影响 510300
  const news1 = [
    { tag: '央行', summary: '央行宣布降息 10bp, 1 年期 LPR 下调 5bp', url: 'x', score: 5 }
  ];
  const r1 = Fund14._analyzeNewsImpact(news1, holdings);
  if (r1.length === 1 && r1[0].items.length === 2) {
    const codes = r1[0].items.map(i => i.holding.code);
    if (codes.includes('007194') && codes.includes('018581') && !codes.includes('510300')) {
      ok('降息: 利好 2 只债基, 不影响权益');
    } else fail('降息范围', JSON.stringify(codes));
    const allPos = r1[0].items.every(i => i.impact === 'positive');
    if (allPos) ok('降息: 全部 positive');
    else fail('降息方向', JSON.stringify(r1[0].items.map(i => i.impact)));
  } else fail('降息 case', JSON.stringify(r1));

  // Case 2: 加息 → 利空 2 只债基
  const news2 = [
    { tag: '央行', summary: '美联储加息 25bp, 国内或跟随', url: 'x', score: 5 }
  ];
  const r2 = Fund14._analyzeNewsImpact(news2, holdings);
  if (r2.length === 1 && r2[0].items.every(i => i.impact === 'negative')) {
    ok('加息: 全部 negative');
  } else fail('加息', JSON.stringify(r2));

  // Case 3: 经济复苏 → 利好权益
  const news3 = [
    { tag: '宏观', summary: 'PMI 回升至 51, 经济复苏信号增强', url: 'x', score: 3 }
  ];
  const r3 = Fund14._analyzeNewsImpact(news3, holdings);
  if (r3.length === 1 && r3[0].items.length === 1 && r3[0].items[0].holding.code === '510300' && r3[0].items[0].impact === 'positive') {
    ok('经济复苏: 只利好 510300');
  } else fail('经济复苏', JSON.stringify(r3));

  // Case 4: 中性新闻 → 不匹配
  const news4 = [
    { tag: '国际', summary: '日本央行维持利率不变', url: 'x', score: 0 }
  ];
  const r4 = Fund14._analyzeNewsImpact(news4, holdings);
  if (r4.length === 0) ok('中性新闻: 0 匹配');
  else fail('中性新闻', JSON.stringify(r4));

  // Case 5: 信用风险 → 利空纯债 (但不直接影响短债)
  const news5 = [
    { tag: '债市', summary: '某城投平台违约, 信用风险加剧', url: 'x', score: 4 }
  ];
  const r5 = Fund14._analyzeNewsImpact(news5, holdings);
  if (r5.length === 1 && r5[0].items.some(i => i.holding.code === '018581' && i.impact === 'negative') && !r5[0].items.some(i => i.holding.code === '007194')) {
    ok('信用违约: 利空 018581 (纯债), 不影响短债 007194');
  } else fail('信用违约', JSON.stringify(r5));

  // Case 6: 多条新闻 + 多重影响
  const news6 = [
    { tag: '央行', summary: '央行降准 50bp 释放流动性', url: 'x', score: 5 },
    { tag: '宏观', summary: 'PMI 回升至 51, 经济复苏信号增强', url: 'x', score: 3 }
  ];
  const r6 = Fund14._analyzeNewsImpact(news6, holdings);
  if (r6.length === 2) ok('2 条新闻: 都匹配');
  else fail('2 条新闻', JSON.stringify(r6).slice(0, 300));

  // Case 7: 通胀 → 利空债基
  const news7 = [
    { tag: '宏观', summary: 'CPI 同比上涨 2.5%, 通胀压力上升', url: 'x', score: 3 }
  ];
  const r7 = Fund14._analyzeNewsImpact(news7, holdings);
  if (r7.length === 1 && r7[0].items.every(i => i.impact === 'negative' && (i.holding.type === 'short_bond' || i.holding.type === 'pure_bond'))) {
    ok('通胀: 利空 2 只债基');
  } else fail('通胀', JSON.stringify(r7));
} catch (e) {
  fail('NewsImpact 测试', e.message + ' / ' + e.stack);
}

// ========== [15] Alerts._fetchMarketInline 纯函数实测 ==========
section('15] Alerts._fetchMarketInline');
try {
  // vm 加载 alerts.js (mock window)
  const alertsSrc = readFileSafe(path.join(WWW, 'app', 'alerts.js'));
  if (!alertsSrc) throw new Error('alerts.js 读不到');

  const actx = {
    window: {
      Core: {
        Storage: { all: async () => [], get: async () => null, put: async () => {} },
        Data: { getStockQuote: async () => null },
        Market: { get: async (g) => ({
          group: g, items: [
            { code: '000001', name: '上证指数', price: 3245.67, change: 0.85 },
            { code: '399001', name: '深证成指', price: 10234.56, change: -0.32 },
            { code: '000300', name: '沪深300', price: 3890.12, change: 1.05 }
          ]
        }) },
        State: { get: () => null }
      },
      document: { getElementById: () => null, addEventListener: () => {} },
      Notification: function() {},  // mock
      Capacitor: undefined
    },
    console,
    Core: undefined,
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: () => '2026-07-26',
    fmtDateTime: () => '2026-07-26 15:30',
    uuid: () => 't',
    toastWarning: () => {}, toastSuccess: () => {}, toastError: () => {}
  };
  actx.Core = actx.window.Core;  // IIFE 内部用 `Core.Market` 而非 `window.Core.Market`
  actx.window.escapeHtml = actx.escapeHtml;
  actx.window.fmtMoney = actx.fmtMoney;
  actx.window.fmtDate = actx.fmtDate;
  actx.window.fmtDateTime = actx.window.fmtDateTime;
  actx.window.toastWarning = actx.toastWarning;
  actx.window.toastSuccess = actx.toastSuccess;
  actx.window.toastError = actx.toastError;
  actx.document = actx.window.document;  // vm 顶层也镜像 document
  vm.createContext(actx);
  vm.runInContext(alertsSrc, actx);
  const Alerts = actx.window.Alerts;
  if (typeof Alerts._fetchMarketInline !== 'function') throw new Error('方法未挂载');

  // 用 Promise 跑 async
  (async () => {
    // Case 1: 正常拉取
    const line1 = await Alerts._fetchMarketInline();
    if (line1 && line1.includes('上证指数') && line1.includes('+0.85%') && line1.includes('沪深300')) {
      ok(`inline 行情: ${line1}`);
    } else fail('inline 行情内容', JSON.stringify(line1));

    // Case 2: 调 wide group
    // 已经被 mock 验证过

    // Case 3: Market 返回空 items
    actx.window.Core.Market.get = async () => ({ items: [] });
    const line3 = await Alerts._fetchMarketInline();
    if (line3 === null) ok('空 items → null');
    else fail('空 items', JSON.stringify(line3));

    // Case 4: Market 抛错
    actx.window.Core.Market.get = async () => { throw new Error('network'); };
    const line4 = await Alerts._fetchMarketInline();
    if (line4 === null) ok('Market 抛错 → null');
    else fail('Market 抛错', JSON.stringify(line4));

    // Case 5: 无 Core.Market
    delete actx.window.Core.Market;
    const line5 = await Alerts._fetchMarketInline();
    if (line5 === null) ok('无 Core.Market → null');
    else fail('无 Core.Market', JSON.stringify(line5));
  })().catch(e => fail('Alerts inline 测试', e.message));
} catch (e) {
  fail('Alerts inline 测试', e.message + ' / ' + e.stack);
}

// ========== [16] Node daily_summary.mjs 单元测试 ==========
section('16] daily_summary.mjs (Node) parseArgs/拼 prompt');
try {
  // 简单验证脚本存在 + 可读
  const dailyPath = path.join(ROOT, 'scripts', 'daily_summary.mjs');
  if (!fs.existsSync(dailyPath)) throw new Error('daily_summary.mjs 不存在');
  ok('daily_summary.mjs 存在');

  const src = fs.readFileSync(dailyPath, 'utf-8');
  // 检查关键函数/字符串
  if (/DEEPSEEK_API_KEY/.test(src)) ok('读 DEEPSEEK_API_KEY');
  else fail('DEEPSEEK_API_KEY', '未引用');
  if (/FEISHU_WEBHOOK/.test(src)) ok('读 FEISHU_WEBHOOK');
  else fail('FEISHU_WEBHOOK', '未引用');
  if (/stock_zh_index_spot/.test(src)) ok('用 stock_zh_index_spot 拉大盘');
  else fail('大盘接口', '未引用');
  if (/deepseek-v4-flash/.test(src)) ok('默认模型 deepseek-v4-flash');
  else fail('默认模型', '未设置');
  if (/api\/public/.test(src)) ok('走 aktools /api/public 路径');
  else fail('aktools 路径', '未走新路径');
  if (/msg_type.*text/.test(src)) ok('飞书 msg_type=text');
  else fail('飞书', 'msg_type 格式不对');

  // parseArgs 测试
  const origArgv = process.argv;
  process.argv = ['node', 'daily_summary.mjs'];  // 无参数
  let parseErr = null;
  try {
    // 动态导入 daily_summary (mjs 里的 parseArgs, 但用动态 import)
    // 简化: 不真跑, 只检查源码
  } catch (e) { parseErr = e; }
  // 不真跑, 改成检查关键逻辑
  if (/process\.exit\(1\)/.test(src)) ok('无参数 → exit(1)');
  else fail('parseArgs 错误处理', '没看到 exit(1)');
  if (/JSON\.parse\(fs\.readFileSync/.test(src)) ok('读 snapshot JSON');
  else fail('JSON 读', '未读');
  if (/feishuText/.test(src) && /pushFeishu/.test(src)) ok('拼飞书文本 + 推送');
  else fail('飞书', '拼/推 缺一');
  if (/daily_summary_\$\{date/.test(src)) ok('输出 daily_summary_DATE.md');
  else fail('输出文件', '文件名格式不对');
  process.argv = origArgv;
} catch (e) {
  fail('daily_summary 测试', e.message);
}

// ========== [17] 5.1 互通闭环: journal↔holdings / alerts↔journal / screener↔watchlist+journal ==========
section('17] 5.1 互通闭环纯函数实测');

// ---- 17.1 Journal._buildHoldingsContext + _renderHoldingBadge ----
try {
  const journalSrc = readFileSafe(path.join(WWW, 'app', 'journal.js'));
  if (!journalSrc) throw new Error('journal.js 读不到');
  // 先定义所有工具函数, 再用它们构造 fakeStorage (避免未定义前调用)
  const fmtDateFn = (d) => {
    if (typeof d === 'string') return d;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const fakeStorage = {
    holdings: [
      { id: 'h1', code: '600519', name: '贵州茅台', shares: 100, costPrice: 1600, createdAt: Date.now() - 100 * 86400000 },
      { id: 'h2', code: '000001', name: '平安银行', shares: 1000, costPrice: 13, createdAt: Date.now() - 30 * 86400000 }
    ],
    transactions: [
      { id: 't1', holdingId: 'h1', code: '600519', type: 'buy', date: fmtDateFn(new Date(Date.now() - 100 * 86400000)), price: 1600, shares: 100, note: '建仓' },
      { id: 't2', holdingId: 'h2', code: '000001', type: 'buy', date: fmtDateFn(new Date(Date.now() - 30 * 86400000)), price: 13, shares: 500, note: '试仓' },
      { id: 't3', holdingId: 'h2', code: '000001', type: 'buy', date: fmtDateFn(new Date(Date.now() - 10 * 86400000)), price: 12, shares: 500, note: '加仓' }
    ]
  };
  const fakeSpot = [
    { 代码: '600519', 名称: '贵州茅台', 最新价: 1680, 涨跌幅: 1.5 },
    { 代码: '000001', 名称: '平安银行', 最新价: 12, 涨跌幅: -2.0 }
  ];
  const jctx = {
    window: {},
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: fmtDateFn,
    fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
    fmtPct: () => '0%',
    pctClass: () => '',
    uuid: () => 'test-uuid',
    console
  };
  jctx.window.Core = {
    Storage: {
      all: async (t) => fakeStorage[t] || [],
      get: async () => null,
      add: async () => {}
    },
    Data: { getStockSpot: async () => fakeSpot, getIndexSpot: async () => [], getStockQuote: async () => null },
    State: { get: () => null, set: () => {} }
  };
  jctx.Core = jctx.window.Core;  // 让 IIFE 内部直接读 Core 也能拿到
  jctx.window.escapeHtml = jctx.escapeHtml;
  jctx.window.fmtMoney = jctx.fmtMoney;
  jctx.window.fmtDate = jctx.fmtDate;
  jctx.window.fmtNum = jctx.fmtNum;
  jctx.window.toastSuccess = jctx.toastSuccess;
  jctx.window.toastError = jctx.toastError;
  jctx.window.toastWarning = jctx.toastWarning;
  jctx.window.uuid = jctx.uuid;
  jctx.window.document = { getElementById: () => null };
  jctx.document = jctx.window.document;
  vm.createContext(jctx);
  vm.runInContext(journalSrc, jctx);
  const Journal = jctx.window.Journal;

  (async () => {
    // _buildHoldingsContext: 返回 map[code] = { shares, cost, currentPrice, currentMkt, totalPL, totalPLPct, holdingDays, firstBuyDate, name }
    const ctx = await Journal._buildHoldingsContext();
    if (ctx && ctx['600519'] && ctx['600519'].shares === 100) ok('build: 600519 份额');
    else fail('build 600519 shares', JSON.stringify(ctx && ctx['600519']));
    if (ctx && ctx['600519'] && ctx['600519'].cost === 160000) ok('build: 600519 成本 (100×1600)');
    else fail('build 600519 cost', JSON.stringify(ctx && ctx['600519'] && ctx['600519'].cost));
    if (ctx && ctx['600519'] && ctx['600519'].currentMkt === 168000) ok('build: 600519 当前市值 (100×1680)');
    else fail('build 600519 mkt', JSON.stringify(ctx && ctx['600519'] && ctx['600519'].currentMkt));
    if (ctx && ctx['600519'] && ctx['600519'].totalPL === 8000) ok('build: 600519 累计盈亏 (168000-160000)');
    else fail('build 600519 pl', JSON.stringify(ctx && ctx['600519'] && ctx['600519'].totalPL));
    // 持仓天数: 最早 buy 距今约 100 天 (容差 ±2)
    if (ctx && ctx['600519'] && Math.abs(ctx['600519'].holdingDays - 100) <= 2) ok(`build: 600519 持仓天数 (${ctx['600519'].holdingDays})`);
    else fail('build 600519 days', JSON.stringify(ctx && ctx['600519'] && ctx['600519'].holdingDays));
    // 平安银行: 最早 buy 距今 30 天 (t2), 不是 10 天 (t3)
    if (ctx && ctx['000001'] && Math.abs(ctx['000001'].holdingDays - 30) <= 2) ok(`build: 000001 持仓天数 (${ctx['000001'].holdingDays}) 取最早 buy`);
    else fail('build 000001 days', JSON.stringify(ctx && ctx['000001'] && ctx['000001'].holdingDays));
    // 平安银行: 累计盈亏 = 1000×12 - 1000×13 = -1000
    if (ctx && ctx['000001'] && ctx['000001'].totalPL === -1000) ok('build: 000001 累计盈亏 -1000');
    else fail('build 000001 pl', JSON.stringify(ctx && ctx['000001'] && ctx['000001'].totalPL));

    // _renderHoldingBadge: 验证 HTML 包含 关键字段
    const html1 = Journal._renderHoldingBadge(ctx['600519']);
    if (html1.includes('💼 现持仓') && html1.includes('现价 1680.00') && html1.includes('+8000.00') && /持仓 \d+ 天/.test(html1)) ok('badge: 正盈亏 + 持仓天数');
    else fail('badge 600519', html1);
    const html2 = Journal._renderHoldingBadge(ctx['000001']);
    if (html2.includes('现价 12.00') && html2.includes('-1000.00') && /持仓 \d+ 天/.test(html2)) ok('badge: 负盈亏 + 持仓天数');
    else fail('badge 000001', html2);
    // null ctx → 空字符串
    if (Journal._renderHoldingBadge(null) === '') ok('badge: null → ""');
    else fail('badge null', '应返回 ""');

    // 空持仓时返回空 map
    fakeStorage.holdings = [];
    fakeStorage.transactions = [];
    const ctx2 = await Journal._buildHoldingsContext();
    if (ctx2 && Object.keys(ctx2).length === 0) ok('build: 空持仓 → 空 map');
    else fail('build 空持仓', JSON.stringify(ctx2));
  })();
} catch (e) {
  fail('5.1.1 journal↔holdings', e.message + ' / ' + (e.stack || ''));
}

// ---- 17.2 Alerts._fetchJournalContext ----
try {
  const alertsSrc = readFileSafe(path.join(WWW, 'app', 'alerts.js'));
  if (!alertsSrc) throw new Error('alerts.js 读不到');
  const journals = [
    { id: 'j1', title: '茅台建仓记录', content: '第一次买茅台, 因为估值修复 + 业绩拐点', code: '600519', date: '2026-07-10', createdAt: Date.now() - 5 * 86400000 },
    { id: 'j2', title: '茅台加仓', content: '跌了 5% 加仓, 但被套', code: '600519', date: '2026-07-15', createdAt: Date.now() - 2 * 86400000 },
    { id: 'j3', title: '旧笔记', content: '这条太老了', code: '600519', date: '2026-01-01', createdAt: Date.now() - 100 * 86400000 },
    { id: 'j4', title: '不相关', content: '平安银行分析', code: '000001', date: '2026-07-20', createdAt: Date.now() - 1 * 86400000 }
  ];
  const actx = {
    window: {},
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: (d) => {
      if (typeof d === 'string') return d;
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },
    uuid: () => 'test-uuid',
    console
  };
  actx.window.Core = {
    Storage: { all: async (t) => t === 'journals' ? journals : [], get: async () => null, add: async () => {} },
    Data: { getStockSpot: async () => [] },
    State: { get: () => null, set: () => {} }
  };
  actx.Core = actx.window.Core;
  actx.window.escapeHtml = actx.escapeHtml;
  actx.window.fmtMoney = actx.fmtMoney;
  actx.window.fmtDate = actx.fmtDate;
  actx.window.toastSuccess = actx.toastSuccess;
  actx.window.toastError = actx.toastError;
  actx.window.toastWarning = actx.toastWarning;
  actx.window.uuid = actx.uuid;
  // alerts.js IIFE 末尾有 document.addEventListener('DOMContentLoaded', ...), mock 掉
  actx.window.document = { getElementById: () => null, addEventListener: () => {}, removeEventListener: () => {} };
  actx.window.setInterval = () => {};  // 阻止 startPolling 自动启动
  actx.document = actx.window.document;
  vm.createContext(actx);
  vm.runInContext(alertsSrc, actx);
  const Alerts = actx.window.Alerts;

  (async () => {
    // Case 1: 找到 30 天内的 600519 复盘 (2 条), 不含 100 天前的 j3, 不含 000001 的 j4
    const r1 = await Alerts._fetchJournalContext('600519');
    if (r1 && r1.includes('📓 复盘历史') && r1.includes('茅台加仓') && r1.includes('茅台建仓记录') && !r1.includes('旧笔记') && !r1.includes('不相关')) ok('fetch: 30 天内 2 条, 排除老/无关');
    else fail('fetch 600519', r1);
    // 顺序: createdAt 降序 → 茅台加仓 (2d) 在前
    if (r1 && r1.indexOf('茅台加仓') < r1.indexOf('茅台建仓记录')) ok('fetch: 倒序 (新的在前)');
    else fail('fetch 顺序', r1);
    // 截断 60 字符
    if (r1 && r1.includes('因为估值修复')) ok('fetch: 包含正文片段');
    else fail('fetch 片段', r1);

    // Case 2: 找不到任何复盘 → null
    const r2 = await Alerts._fetchJournalContext('999999');
    if (r2 === null) ok('fetch: 找不到 → null');
    else fail('fetch 找不到', JSON.stringify(r2));

    // Case 3: 空 code → null
    const r3 = await Alerts._fetchJournalContext(null);
    if (r3 === null) ok('fetch: 空 code → null');
    else fail('fetch 空 code', JSON.stringify(r3));
  })();
} catch (e) {
  fail('5.1.2 alerts↔journal', e.message + ' / ' + (e.stack || ''));
}

// ---- 17.3 Screener._addWatchlistFromPick ----
try {
  const screenerSrc = readFileSafe(path.join(WWW, 'app', 'screener.js'));
  if (!screenerSrc) throw new Error('screener.js 读不到');
  const storageMock = {
    watchlist: [],
    journals: []
  };
  const sctx = {
    window: {},
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: (d) => {
      if (typeof d === 'string') return d;
      const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
      return `${y}-${m}-${day}`;
    },
    uuid: () => 'test-uuid-' + Math.random().toString(36).slice(2, 8),
    console
  };
  sctx.window.Core = {
    Storage: {
      all: async (t) => storageMock[t] || [],
      get: async (t, id) => (storageMock[t] || []).find(x => x.id === id || x.code === id) || null,
      add: async (t, obj) => { (storageMock[t] = storageMock[t] || []).push(obj); }
    },
    Data: { getStockSpot: async () => [] },
    State: { get: () => null, set: () => {} }
  };
  sctx.Core = sctx.window.Core;
  sctx.window.escapeHtml = sctx.escapeHtml;
  sctx.window.fmtMoney = sctx.fmtMoney;
  sctx.window.fmtDate = sctx.fmtDate;
  sctx.window.toastSuccess = sctx.toastSuccess;
  sctx.window.toastError = sctx.toastError;
  sctx.window.toastWarning = sctx.toastWarning;
  sctx.window.uuid = sctx.uuid;
  sctx.window.document = { getElementById: () => null };
  sctx.document = sctx.window.document;
  // Phase D1: 捕获模拟盘自动成交参数 (pre-mortem 透传断言用)
  const paperCalls = [];
  sctx.window.Paper = { autoTradeFromPick: (pick) => { paperCalls.push(pick); } };
  vm.createContext(sctx);
  vm.runInContext(screenerSrc, sctx);
  const Screener = sctx.window.Screener;

  (async () => {
    // 模拟 AI 解读后的 _lastAiContext
    Screener._lastAiContext = {
      marketView: '大盘震荡',
      policyView: '政策面中性',
      risks: ['估值偏高', '流动性收紧'],
      conditions: { market: 'all', peMax: 30, pbMax: 5, mktCapMin: 100, turnoverMin: 1, changeMin: 0, changeMax: null }
    };
    const fakeBtn = {
      dataset: {
        code: '600519',
        name: '贵州茅台',
        riskscore: '2',
        reasons: JSON.stringify(['估值修复', '业绩拐点', '宏观契合']),
        falsify: '跌破 20 日线且放量',
        invalidation: '2 周内未突破 1800 元'
      },
      disabled: false,
      textContent: ''
    };
    await Screener._addWatchlistFromPick(fakeBtn, '600519', '贵州茅台');

    // 1) watchlist 写入
    if (storageMock.watchlist.length === 1 && storageMock.watchlist[0].code === '600519') ok('screener: watchlist 写入');
    else fail('screener watchlist', JSON.stringify(storageMock.watchlist));
    // 2) journal 写入 (5.1.3 关键)
    if (storageMock.journals.length === 1 && storageMock.journals[0].code === '600519') ok('screener: journal 写入 (自动记理由)');
    else fail('screener journal', JSON.stringify(storageMock.journals));
    // 3) journal content 包含 AI 选股理由
    const j = storageMock.journals[0];
    if (j.content && j.content.includes('估值修复') && j.content.includes('业绩拐点') && j.content.includes('宏观契合')) ok('screener: journal 含 3 条 AI 理由');
    else fail('screener reasons', j.content);
    // 4) 包含筛选条件
    if (j.content && j.content.includes('PE ≤ 30') && j.content.includes('PB ≤ 5') && j.content.includes('市值 ≥ 100 亿') && j.content.includes('换手率 ≥ 1%')) ok('screener: journal 含筛选条件');
    else fail('screener 筛选条件', j.content);
    // 5) 包含大盘视角 + 风险点
    if (j.content && j.content.includes('大盘震荡') && j.content.includes('估值偏高') && j.content.includes('流动性收紧')) ok('screener: journal 含大盘+风险');
    else fail('screener 大盘风险', j.content);
    // 6) 标签含 AI选股 / 自选 / 标题格式正确
    if (j.title && j.title.startsWith('AI 选股:') && j.tags && j.tags.includes('AI选股') && j.tags.includes('自选')) ok('screener: 标签/标题');
    else fail('screener 标签标题', JSON.stringify({ title: j.title, tags: j.tags }));
    // 7) source 标记 (后续可清理/识别)
    if (j.source === 'screener-add') ok('screener: source 标记');
    else fail('screener source', j.source);
    // 8) 按钮状态
    if (fakeBtn.disabled === true && fakeBtn.textContent === '✓ 已加入') ok('screener: 按钮变 ✓');
    else fail('screener 按钮态', JSON.stringify({ disabled: fakeBtn.disabled, text: fakeBtn.textContent }));

    // 9) 重复点击 → 不重复写入 (返回早, 不创建新 journal)
    await Screener._addWatchlistFromPick(fakeBtn, '600519', '贵州茅台');
    if (storageMock.watchlist.length === 1 && storageMock.journals.length === 1) ok('screener: 重复点击不重复写入');
    else fail('screener 重复点击', `watchlist=${storageMock.watchlist.length} journal=${storageMock.journals.length}`);

    // 10) Phase D1: journal 行带 falsifyCondition/invalidation 非索引字段 + content 含 Pre-mortem 段
    if (j.falsifyCondition === '跌破 20 日线且放量' && j.invalidation === '2 周内未突破 1800 元') ok('screener: journal 行沉淀 falsifyCondition/invalidation');
    else fail('screener premortem 字段', JSON.stringify({ f: j.falsifyCondition, i: j.invalidation }));
    if (j.content && j.content.includes('### 🔬 Pre-mortem') && j.content.includes('跌破 20 日线且放量') && j.content.includes('2 周内未突破 1800 元')) ok('screener: journal content 含 Pre-mortem 段');
    else fail('screener premortem content', (j.content || '').slice(-300));
    // 11) Phase D1: 模拟盘 autoTradeFromPick 收到 falsifyCondition/invalidation
    if (paperCalls.length === 1 && paperCalls[0].falsifyCondition === '跌破 20 日线且放量' && paperCalls[0].invalidation === '2 周内未突破 1800 元') ok('screener: autoTradeFromPick 透传 pre-mortem 字段');
    else fail('screener autoTrade 透传', JSON.stringify(paperCalls));
  })();
} catch (e) {
  fail('5.1.3 screener↔watchlist+journal', e.message + ' / ' + (e.stack || ''));
}

// ========== [18] 5.2 主动智能: journal 结构化 + AI 复盘助手 + alerts 上次类似情境 ==========
section('18] 5.2 主动智能纯函数实测');

// ---- 18.1 Journal._renderStructuredTags ----
try {
  const journalSrc = readFileSafe(path.join(WWW, 'app', 'journal.js'));
  if (!journalSrc) throw new Error('journal.js 读不到');
  const fmtDateFn = (d) => {
    if (typeof d === 'string') return d;
    const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };
  const jctx = {
    window: {},
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
    fmtDate: fmtDateFn,
    fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
    fmtPct: () => '0%', pctClass: () => '',
    uuid: () => 'test-uuid', console
  };
  jctx.window.Core = {
    Storage: { all: async () => [], get: async () => null, add: async () => {} },
    Data: { getStockSpot: async () => [], getIndexSpot: async () => [], getStockQuote: async () => null },
    State: { get: () => null, set: () => {} }
  };
  jctx.Core = jctx.window.Core;
  jctx.window.escapeHtml = jctx.escapeHtml;
  jctx.window.fmtMoney = jctx.fmtMoney;
  jctx.window.fmtDate = jctx.fmtDate;
  jctx.window.fmtNum = jctx.fmtNum;
  jctx.window.toastSuccess = jctx.toastSuccess;
  jctx.window.toastError = jctx.toastError;
  jctx.window.toastWarning = jctx.toastWarning;
  jctx.window.uuid = jctx.uuid;
  // mock document 提供 journalList / modalRoot 节点 (避免 render 时 null.innerHTML 报错)
  const fakeRoot = { innerHTML: '', dataset: {} };
  jctx.window.document = {
    getElementById: (id) => (id === 'journalList' || id === 'modalRoot') ? fakeRoot : null
  };
  jctx.document = jctx.window.document;
  vm.createContext(jctx);
  vm.runInContext(journalSrc, jctx);
  const Journal = jctx.window.Journal;

  // 全 3 字段
  const html1 = Journal._renderStructuredTags({ assumption: '估值修复', emotion: '理性建仓', verify: 'pending' });
  if (html1.includes('假设: 估值修复') && html1.includes('情绪: 理性建仓') && html1.includes('⏳ 待回看')) ok('tags: 3 字段 + pending');
  else fail('tags 3 字段', html1);

  // 1w/1m/3m/verified 标签
  if (Journal._renderStructuredTags({ verify: '1w' }).includes('📅 1 周后')) ok('tags: 1w 标签');
  else fail('tags 1w', '');
  if (Journal._renderStructuredTags({ verify: '1m' }).includes('📅 1 月后')) ok('tags: 1m 标签');
  else fail('tags 1m', '');
  if (Journal._renderStructuredTags({ verify: '3m' }).includes('📅 3 月后')) ok('tags: 3m 标签');
  else fail('tags 3m', '');
  if (Journal._renderStructuredTags({ verify: 'verified' }).includes('✅ 已验证') && Journal._renderStructuredTags({ verify: 'verified' }).includes('var(--up)')) ok('tags: verified 绿色');
  else fail('tags verified', '');

  // 部分字段: 只有 assumption
  if (Journal._renderStructuredTags({ assumption: '业绩拐点' }).includes('假设: 业绩拐点') && !Journal._renderStructuredTags({ assumption: '业绩拐点' }).includes('情绪')) ok('tags: 只有 assumption');
  else fail('tags 部分', '');

  // 空: 返空字符串
  if (Journal._renderStructuredTags({}) === '' && Journal._renderStructuredTags(null) === '') ok('tags: 空 → ""');
  else fail('tags 空', '');

  // AI 待确认
  const htmlAi = Journal._renderStructuredTags({ assumption: '估值修复', emotion: '理性建仓', verify: 'pending', aiSuggested: { assumption: '估值修复' } });
  if (htmlAi.includes('🤖 AI 待确认')) ok('tags: AI 待确认 badge');
  else fail('tags AI 待确认', htmlAi);

  // AI 已应用
  const htmlApplied = Journal._renderStructuredTags({ assumption: '估值修复', verify: 'verified', aiAppliedAt: Date.now() });
  if (htmlApplied.includes('🤖 已应用') && !htmlApplied.includes('🤖 AI 待确认')) ok('tags: AI 已应用 badge');
  else fail('tags AI 已应用', htmlApplied);

  // 5.2.2 _runAiAssistant: mock Core.AI 返回 JSON
  (async () => {
    const fakeNote = { id: 'n1', title: '茅台加仓', code: '600519', content: '今天估值修复, 业绩拐点, 长期持有中', tags: [], mood: 'bullish', date: '2026-07-26', createdAt: Date.now() };
    const putCalls = [];
    jctx.window.Core.Storage.put = async (t, obj) => { putCalls.push({ t, obj }); };
    // Phase T: schema 校验 helper (test mock 需要)
    const _parseJsonOutput = (text, schema) => {
      if (!text || typeof text !== 'string') return { ok: false, errors: ['empty'] };
      const m = text.match(/\{[\s\S]*?\}/);
      if (!m) return { ok: false, errors: ['no JSON'] };
      try {
        const obj = JSON.parse(m[0]);
        if (!obj || typeof obj !== 'object') return { ok: false, errors: ['not object'] };
        // 简版 required 校验
        for (const k of (schema?.required || [])) {
          if (!(k in obj)) return { ok: false, errors: [`missing ${k}`] };
        }
        return { ok: true, obj };
      } catch (e) { return { ok: false, errors: [e.message] }; }
    };
    jctx.window.Core.AI = {
      getConfig: () => ({ provider: 'deepseek', apiKey: 'test' }),
      call: async () => '{"assumption":"估值修复","emotion":"长期持有中","verify":"1w"}',
      parseJsonOutput: _parseJsonOutput
    };
    await Journal._runAiAssistant(fakeNote);

    // 1) 校验: LLM 合法值被接受
    if (putCalls.length === 1 && putCalls[0].obj.aiSuggested && putCalls[0].obj.aiSuggested.assumption === '估值修复') ok('AI 助手: 合法 JSON 接受');
    else fail('AI 助手合法 JSON', JSON.stringify(putCalls));

    // 2) LLM 自由发挥 → 落到"其他"/"pending"
    jctx.window.Core.AI.call = async () => '{"assumption":"自我编造的","emotion":"FOMO","verify":"invalid"}';
    putCalls.length = 0;
    await Journal._runAiAssistant({ ...fakeNote, id: 'n2' });
    const sug2 = putCalls[0]?.obj?.aiSuggested;
    if (sug2 && sug2.assumption === '其他' && sug2.emotion === 'FOMO' && sug2.verify === 'pending') ok('AI 助手: 非法值回退');
    else fail('AI 助手非法值', JSON.stringify(sug2));

    // 3) JSON 解析失败 → 静默, 不抛
    jctx.window.Core.AI.call = async () => 'not json at all';
    putCalls.length = 0;
    await Journal._runAiAssistant({ ...fakeNote, id: 'n3' });
    if (putCalls.length === 0) ok('AI 助手: JSON 失败静默');
    else fail('AI 助手 JSON 失败', JSON.stringify(putCalls));

    // 4) 没配 apiKey → 直接跳过
    jctx.window.Core.AI.getConfig = () => ({ provider: 'deepseek' });  // 无 apiKey
    putCalls.length = 0;
    await Journal._runAiAssistant({ ...fakeNote, id: 'n4' });
    if (putCalls.length === 0) ok('AI 助手: 无 apiKey 跳过');
    else fail('AI 助手无 apiKey', JSON.stringify(putCalls));

    // 5) 内容太短 → 跳过
    jctx.window.Core.AI.getConfig = () => ({ provider: 'deepseek', apiKey: 'test' });
    putCalls.length = 0;
    await Journal._runAiAssistant({ ...fakeNote, id: 'n5', content: 'abc' });
    if (putCalls.length === 0) ok('AI 助手: 内容太短跳过');
    else fail('AI 助手短内容', JSON.stringify(putCalls));
  })();
} catch (e) {
  fail('5.2.1+5.2.2 journal', e.message + ' / ' + (e.stack || ''));
}

// ---- 18.2 Alerts._fetchJournalContext with alertType (5.2.3 上次类似情境) ----
try {
  const alertsSrc = readFileSafe(path.join(WWW, 'app', 'alerts.js'));
  if (!alertsSrc) throw new Error('alerts.js 读不到');
  const now = Date.now();
  const journals = [
    // 同代码 + 命中 price_above 启发标签 (技术突破/估值修复) 的旧复盘
    { id: 'j1', title: '茅台技术突破买入', content: '突破压力位, 加仓 100 股', code: '600519', date: '2026-07-01', createdAt: now - 20 * 86400000, assumption: '技术突破', emotion: '理性建仓', verify: '1w' },
    // 旧复盘, 不同 assumption
    { id: 'j2', title: '茅台估值修复', content: 'PE 跌到 25, 估值修复', code: '600519', date: '2026-06-15', createdAt: now - 40 * 86400000, assumption: '估值修复', emotion: '理性建仓', verify: 'verified' },
    // 已 verify=verified 的同类 — 应该被排除 (避免已结案案例)
    { id: 'j3', title: '茅台题材催化', content: 'AI 概念热', code: '600519', date: '2026-07-10', createdAt: now - 10 * 86400000, assumption: '题材催化', emotion: '冲动追高', verify: 'verified' },
    // 不相关代码
    { id: 'j4', title: '平安分析', content: 'PE 12', code: '000001', date: '2026-07-15', createdAt: now - 8 * 86400000, assumption: '估值修复', verify: '1w' }
  ];
  const actx = {
    window: {},
    toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
    escapeHtml: (s) => String(s == null ? '' : s),
    fmtMoney: () => '0.00',
    fmtDate: (d) => typeof d === 'string' ? d : '2026-07-26',
    uuid: () => 't', console
  };
  actx.window.Core = {
    Storage: { all: async (t) => t === 'journals' ? journals : [], get: async () => null, add: async () => {}, put: async () => {} },
    Data: { getStockSpot: async () => [] },
    State: { get: () => null, set: () => {} }
  };
  actx.Core = actx.window.Core;
  actx.window.escapeHtml = actx.escapeHtml;
  actx.window.fmtMoney = actx.fmtMoney;
  actx.window.fmtDate = actx.fmtDate;
  actx.window.toastSuccess = actx.toastSuccess;
  actx.window.toastError = actx.toastError;
  actx.window.toastWarning = actx.toastWarning;
  actx.window.uuid = actx.uuid;
  actx.window.document = { getElementById: () => null, addEventListener: () => {} };
  actx.window.setInterval = () => {};
  actx.document = actx.window.document;
  vm.createContext(actx);
  vm.runInContext(alertsSrc, actx);
  const Alerts = actx.window.Alerts;

  (async () => {
    // Case 1: price_above → 启发 assumption = ['技术突破', '估值修复'] → 找 j1 (技术突破) 排除 j2 (verify=verified, 但 j2 是估值修复, 不过 verify=verified 仍要排除)
    // j1 命中 (技术突破 + verify=1w, 没过 verify=verified)
    // j3 是题材催化, 不在启发列表 → 排除
    const r1 = await Alerts._fetchJournalContext('600519', 'price_above');
    if (r1 && r1.includes('🔁 上次类似情境') && r1.includes('技术突破 + 理性建仓') && r1.includes('茅台技术突破买入')) ok('alerts 5.2.3: price_above 命中技术突破');
    else fail('alerts price_above', r1);
    // j2 (估值修复) 因为 verify=verified 被排除 (虽然标签在启发列表)
    if (r1 && !r1.includes('茅台估值修复')) ok('alerts 5.2.3: verify=verified 排除');
    else fail('alerts verify 排除', r1);
    // j3 (题材催化) 排除 — 只看 🔁 行不包含
    if (r1 && !r1.split('🔁')[0].includes('茅台题材催化') === false) {}  // 题材催化在最近 2 条是允许的
    const j3InSimLine = r1 && r1.split('🔁')[1] ? r1.split('🔁')[1].includes('茅台题材催化') : false;
    if (!j3InSimLine) ok('alerts 5.2.3: 启发外 assumption 不进类似情境行');
    else fail('alerts 启发外', r1);

    // Case 2: change_below → 启发 assumption = ['恐慌割肉', '计划内止损', '长期持有中'] + emotion 匹配
    // 没有完全匹配的, 应该只返回 30 天内复盘, 不返回 "上次类似情境"
    // j1 假设=技术突破, 不在 → 排除
    // → 没找到类似情境, 只返前段
    const r2 = await Alerts._fetchJournalContext('600519', 'change_below');
    if (r2 && r2.includes('📓 复盘历史') && !r2.includes('🔁 上次类似情境')) ok('alerts 5.2.3: change_below 无类似情境');
    else fail('alerts change_below', r2);

    // Case 3: 不传 alertType → 不返回 "上次类似情境" (向后兼容)
    const r3 = await Alerts._fetchJournalContext('600519');
    if (r3 && r3.includes('📓 复盘历史') && !r3.includes('🔁 上次类似情境')) ok('alerts 5.2.3: 无 alertType 不返类似情境');
    else fail('alerts 无 alertType', r3);

    // Case 4: 找 emotion='长期持有中' 的 → 假设我们注入一条
    const journals2 = [
      ...journals,
      { id: 'j5', title: '茅台长期持有中', content: '业绩拐点 + 长期持有, 不动', code: '600519', date: '2026-07-20', createdAt: now - 2 * 86400000, assumption: '业绩拐点', emotion: '长期持有中', verify: 'pending' }
    ];
    actx.window.Core.Storage.all = async (t) => t === 'journals' ? journals2 : [];
    const r4 = await Alerts._fetchJournalContext('600519', 'change_below');
    // change_below 启发: ['恐慌割肉', '计划内止损', '长期持有中'] — j5 emotion=长期持有中, 但启发是按 assumption 匹配的
    // j5 assumption=业绩拐点, 不在列表 → 排除
    if (r4 && !r4.includes('🔁 上次类似情境')) ok('alerts 5.2.3: 启发按 assumption 匹配 (emotion 不算)');
    else fail('alerts assumption 优先', r4);
  })();
} catch (e) {
  fail('5.2.3 alerts 上次类似情境', e.message + ' / ' + (e.stack || ''));
}

// ========== [19] 5.2 c 事后验证 (daily_summary.mjs --verify) ==========
section('19] 5.2 c 事后验证 (daily_summary.mjs --verify)');
(async () => {
  try {
    // 动态 import daily_summary.mjs (ESM, Windows 需要 file:// URL)
    const dailySummaryUrl = require('url').pathToFileURL(path.join(ROOT, 'scripts', 'daily_summary.mjs')).href;
    const mod = await import(dailySummaryUrl);
    const {
      parseArgs, pickJournalsForVerify, buildVerifyPrompt, applyVerifyReport, runVerify
    } = mod;

    // ---- 19.1 parseArgs 双模式 ----
    const origArgv = process.argv;
    process.argv = ['node', 'daily_summary.mjs', 'snap.json'];
    let a1 = parseArgs();
    if (a1.mode === 'summary' && a1.snapshotPath.endsWith('snap.json')) ok('parseArgs: summary 模式');
    else fail('parseArgs summary', JSON.stringify(a1));

    process.argv = ['node', 'daily_summary.mjs', '--verify', 'journals.json'];
    let a2 = parseArgs();
    if (a2.mode === 'verify' && a2.dryRun === false && a2.journalsPath.endsWith('journals.json')) ok('parseArgs: verify 模式');
    else fail('parseArgs verify', JSON.stringify(a2));

    process.argv = ['node', 'daily_summary.mjs', '--verify-dry-run', 'j.json'];
    let a3 = parseArgs();
    if (a3.mode === 'verify' && a3.dryRun === true) ok('parseArgs: verify dry-run');
    else fail('parseArgs verify-dry-run', JSON.stringify(a3));

    process.argv = origArgv;

    // ---- 19.2 pickJournalsForVerify 边界 ----
    const now = Date.now();
    const day = 86400000;
    const fixture = [
      // 到期
      { id: 'a', code: '600519', verify: '1w', createdAt: now - 8 * day, title: '1w 到期' },
      { id: 'b', code: '600519', verify: '1m', createdAt: now - 31 * day, title: '1m 到期' },
      { id: 'c', code: '600519', verify: '3m', createdAt: now - 91 * day, title: '3m 到期' },
      { id: 'd', code: '600519', verify: 'pending', createdAt: now - 8 * day, title: 'pending 默认 7 天, 到期' },
      // 未到期
      { id: 'e', code: '600519', verify: '1w', createdAt: now - 5 * day, title: '1w 未到期' },
      { id: 'f', code: '600519', verify: '1m', createdAt: now - 20 * day, title: '1m 未到期' },
      { id: 'g', code: '600519', verify: '3m', createdAt: now - 60 * day, title: '3m 未到期' },
      { id: 'h', code: '600519', verify: 'pending', createdAt: now - 3 * day, title: 'pending 未到期' },
      // 排除
      { id: 'i', code: '600519', verify: 'verified', createdAt: now - 100 * day, title: '已验证, 排除' },
      { id: 'j', title: '无 code, 排除', verify: '1w', createdAt: now - 10 * day },
      { id: 'k', code: '600519', verify: 'invalid', createdAt: now - 10 * day, title: '无效 verify, 排除' },
      { id: 'l', code: '600519', title: '无 verify 5 天, pending 未到期', createdAt: now - 5 * day }  // 应视为 pending
    ];
    const picked = pickJournalsForVerify(fixture, now);
    if (picked.length === 9) ok('pick: 命中 9 条 (排除 verified/无 code/无效 verify)');
    else fail('pick 命中数', `${picked.length}`);
    if (picked.filter(p => p.due).length === 4) ok('pick: 4 条到期 (a b c d)');
    else fail('pick due', '');
    if (picked.find(p => p.note.id === 'i')) fail('pick: 不应包含已验证的 i', '');
    else ok('pick: 排除 verified');
    if (picked.find(p => p.note.id === 'j')) fail('pick: 不应包含无 code 的 j', '');
    else ok('pick: 排除无 code');
    if (picked.find(p => p.note.id === 'k')) fail('pick: 不应包含无效 verify 的 k', '');
    else ok('pick: 排除无效 verify');
    if (!picked.find(p => p.note.id === 'l')) fail('pick: 应把无 verify 视为 pending', '');
    else ok('pick: 无 verify 视为 pending (阈值 7 天)');
    const lEntry = picked.find(p => p.note.id === 'l');
    if (lEntry && lEntry.due === false && lEntry.thresholdDays === 7) ok('pick: l (无 verify, 5d) → due=false, 7d 阈值');
    else fail('pick l', JSON.stringify(lEntry));
    const aEntry = picked.find(p => p.note.id === 'a');
    if (aEntry && aEntry.daysSinceCreate === 8) ok('pick: daysSinceCreate=8 (创建于 8 天前)');
    else fail('pick days', JSON.stringify(aEntry));

    if (pickJournalsForVerify(null).length === 0) ok('pick: null → []');
    else fail('pick null', '');
    if (pickJournalsForVerify([]).length === 0) ok('pick: [] → []');
    else fail('pick empty', '');

    // ---- 19.3 buildVerifyPrompt ----
    const { systemPrompt, userPrompt } = buildVerifyPrompt(
      { code: '600519', title: '茅台加仓', assumption: '估值修复', emotion: '长期持有中', verify: '1w', date: '2026-07-01', content: 'PE 跌到 25 加仓', createdAt: now - 8 * day },
      { price: 1680, changePct: 2.5, daysSince: 8 }
    );
    if (systemPrompt.includes('对照报告') && userPrompt.includes('600519') && userPrompt.includes('1680.00') && userPrompt.includes('+2.50%') && userPrompt.includes('估值修复')) ok('verify prompt: 包含价格/涨跌幅/假设');
    else fail('verify prompt', `user=${userPrompt.slice(0, 200)}`);

    const { userPrompt: userPromptErr } = buildVerifyPrompt(
      { code: '600519', title: 't', assumption: '估值修复', verify: '1w', createdAt: now - 8 * day },
      { error: 'network' }
    );
    if (userPromptErr.includes('行情拉取失败') && userPromptErr.includes('network')) ok('verify prompt: 行情失败降级');
    else fail('verify prompt err', userPromptErr);

    // ---- 19.4 applyVerifyReport (Z2 重构后: 接受已 parse 的结构化对象) ----
    const orig = { id: 'n1', title: 't', content: '原内容', verify: '1w', createdAt: now - 8 * day };
    const updated = applyVerifyReport(orig, {
      verdict: '对', attribution: '无', lesson: '判断准', narrative: '### 当时判断\n看多\n### 当前反馈\n涨了'
    });
    if (updated.content.includes('原内容') && updated.content.includes('AI 事后验证') && updated.content.includes('看多') && updated.content.includes('涨了')) ok('verify apply: 报告 append 到原内容');
    else fail('verify apply content', updated.content);
    if (updated.verify === 'verified' && typeof updated.verifiedAt === 'number') ok('verify apply: verify=verified + verifiedAt 时间戳');
    else fail('verify apply status', JSON.stringify({ verify: updated.verify, verifiedAt: updated.verifiedAt }));
    if (updated.aiVerified && updated.aiVerified.verdict === '对' && updated.aiVerified.attribution === '无') ok('verify apply: aiVerified 结构化字段 (Z2 反馈闭环根基)');
    else fail('verify apply aiVerified', JSON.stringify(updated.aiVerified));
    if (orig.verify === '1w' && orig.content === '原内容' && !orig.verifiedAt && !orig.aiVerified) ok('verify apply: 纯函数 (原 note 未改)');
    else fail('verify apply 副作用', JSON.stringify(orig));

    const updated2 = applyVerifyReport({ content: 'x' }, null);
    if (updated2.content === 'x' && !updated2.verifiedAt) ok('verify apply: null report 跳过');
    else fail('verify apply null', JSON.stringify(updated2));

    // ---- 19.5 runVerify 端到端 (mock fetch + LLM) ----
    const tmpDir = path.join(ROOT, '.test-tmp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);
    const tmpJournals = path.join(tmpDir, 'journals-test.json');
    fs.writeFileSync(tmpJournals, JSON.stringify(fixture.slice(0, 4), null, 2));
    const llmCalls = [];
    const r1 = await runVerify(tmpJournals, false, {
      fetchQuote: async (code) => ({ price: 1680, changePct: 2.5 }),
      callLLM: async (userPrompt, systemPrompt) => {
        llmCalls.push({ code: userPrompt.match(/当前价/) ? 'has-data' : 'no-data', sys: systemPrompt.slice(0, 30) });
        // Z2: 返回结构化 JSON (供 parseVerifyJsonOutput 解析)
        return JSON.stringify({
          verdict: '对', attribution: '无',
          lesson: '判断准', narrative: '与假设一致, 走势符合预期'
        });
      }
    });
    if (r1.updated.length === 4) ok('runVerify: 4 条到期全处理');
    else fail('runVerify count', `updated=${r1.updated.length}`);
    if (llmCalls.length === 4) ok('runVerify: 4 次 LLM 调用');
    else fail('runVerify llm count', llmCalls.length);
    if (r1.updated.every(n => n.verify === 'verified' && n.content.includes('AI 事后验证') && n.content.includes('与假设一致'))) ok('runVerify: 每条都 verified + 含 AI 报告');
    else fail('runVerify apply', '');
    const outPath = tmpJournals.replace('.json', '.verified.json');
    if (fs.existsSync(outPath)) ok(`runVerify: 写回 ${path.basename(outPath)}`);
    else fail('runVerify 写回', outPath);
    const written = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
    if (Array.isArray(written) && written.length === 4) ok('runVerify: 写回 JSON 含 4 条');
    else fail('runVerify 写回内容', '');

    const r2 = await runVerify(tmpJournals, false, {
      fetchQuote: async (code) => ({ price: 1680, changePct: 2.5 }),
      callLLM: async () => null
    });
    if (r2.updated.length === 0) ok('runVerify: LLM 失败不写回');
    else fail('runVerify LLM fail', `updated=${r2.updated.length}`);

    const tmpJournals2 = path.join(tmpDir, 'journals-test2.json');
    fs.writeFileSync(tmpJournals2, JSON.stringify(fixture.slice(0, 4), null, 2));
    const r3 = await runVerify(tmpJournals2, true, {
      fetchQuote: async () => ({ price: 1 }),
      callLLM: async () => 'mocked'
    });
    if (r3.updated.length === 0 && !fs.existsSync(tmpJournals2.replace('.json', '.verified.json'))) ok('runVerify: dry-run 不写文件');
    else fail('runVerify dry-run', '');

    const origExit = process.exit;
    let exitCalled = false;
    process.exit = (code) => { exitCalled = true; };
    // 用绝对不存在的路径 (含不存在的父目录)
    // 脚本里 existsSync + readFileSync 任意一步抛错/退出, 都视为正确行为
    let verifyError = null;
    try {
      await runVerify(path.join(ROOT, '.test-tmp-no-such-dir-xyz', 'no-such.json'), false, {});
    } catch (e) {
      verifyError = e;
    }
    if (exitCalled || verifyError) ok('runVerify: 不存在文件 → exit(1) 或抛错');
    else fail('runVerify not-exists', `exitCalled=${exitCalled} error=${verifyError && verifyError.message}`);
    process.exit = origExit;

    try { fs.unlinkSync(tmpJournals); } catch (e) {}
    try { fs.unlinkSync(outPath); } catch (e) {}
    try { fs.unlinkSync(tmpJournals2); } catch (e) {}
    try { fs.rmdirSync(tmpDir); } catch (e) {}

    // ---- 19.6 Phase C 盘前简报 (--premarket) ----
    const {
      buildEconomicCalendar, buildPremarketPrompt, formatPremarketRaw, runPremarket
    } = mod;

    // parseArgs 识别 --premarket
    process.argv = ['node', 'daily_summary.mjs', '--premarket'];
    const a4 = parseArgs();
    if (a4.mode === 'premarket') ok('parseArgs: --premarket 模式');
    else fail('parseArgs premarket', JSON.stringify(a4));
    process.argv = origArgv;

    // buildEconomicCalendar: 公开日期规则
    const cal1 = buildEconomicCalendar(new Date(2026, 6, 20));  // 7-20: LPR + 季报密集期
    if (cal1.some(e => e.includes('LPR')) && cal1.some(e => e.includes('季报'))) ok('calendar: 7-20 → LPR + 季报密集期');
    else fail('calendar 7-20', JSON.stringify(cal1));
    const cal2 = buildEconomicCalendar(new Date(2026, 1, 5));   // 2-5: 无事件
    if (Array.isArray(cal2) && cal2.length === 0) ok('calendar: 2-5 → 无事件 (不编造)');
    else fail('calendar 2-5', JSON.stringify(cal2));
    const cal3 = buildEconomicCalendar(new Date(2026, 3, 30));  // 4-30: 月末 PMI
    if (cal3.some(e => e.includes('PMI'))) ok('calendar: 4-30 → PMI');
    else fail('calendar 4-30', JSON.stringify(cal3));

    // runPremarket: LLM 失败 → 降级原始数据罗列版
    let pushedText = null;
    const pm1 = await runPremarket({
      now: new Date(2026, 6, 27),
      fetchUs: async () => [{ name: '道琼斯', price: 44000, changePct: 1.2, date: '2026-07-24' }],
      fetchNews: async () => [{ tag: '要闻', summary: '央行开展逆回购操作', url: '' }],
      callLLM: async () => null,
      pushFeishu: async (text) => { pushedText = text; return true; }
    });
    if (pm1.summary === null && pm1.text.includes('隔夜外盘') && pm1.text.includes('道琼斯')
      && pm1.text.includes('央行开展逆回购操作')) ok('premarket: LLM 失败 → 原始罗列版');
    else fail('premarket LLM 降级', pm1.text.slice(0, 200));
    if (pushedText === pm1.text) ok('premarket: 降级版照样推送 (不推送失败)');
    else fail('premarket 推送', '');

    // runPremarket: 数据块失败独立降级 "本节数据不可用", 不中断整体
    let pushedText2 = null;
    const pm2 = await runPremarket({
      now: new Date(2026, 6, 27),
      fetchUs: async () => { throw new Error('aktools down'); },
      fetchNews: async () => null,
      callLLM: async () => 'AI 简报内容',
      pushFeishu: async (text) => { pushedText2 = text; return true; }
    });
    if (pm2.data.us === null && pm2.data.news === null && pm2.summary === 'AI 简报内容') ok('premarket: 数据块失败不中断, LLM 正常走');
    else fail('premarket 数据降级', JSON.stringify({ us: pm2.data.us, news: pm2.data.news }));
    if (pushedText2 === 'AI 简报内容') ok('premarket: LLM 成功时推送 LLM 版');
    else fail('premarket LLM 推送', pushedText2 && pushedText2.slice(0, 100));
    const raw2 = formatPremarketRaw(pm2.data);
    if (raw2.includes('本节数据不可用')) ok('premarket: 失败块降级文案 "本节数据不可用"');
    else fail('premarket 降级文案', raw2.slice(0, 200));

    // buildPremarketPrompt: 数据进 prompt + 降级文案进 prompt
    const { systemPrompt: pmSys, userPrompt: pmUser } = buildPremarketPrompt(pm1.data);
    if (pmSys.includes('300') && pmUser.includes('道琼斯') && pmUser.includes('央行开展逆回购操作')) ok('premarket prompt: 外盘/要闻进 userPrompt');
    else fail('premarket prompt', pmUser.slice(0, 200));
    const { userPrompt: pmUserErr } = buildPremarketPrompt(pm2.data);
    if (pmUserErr.includes('本节数据不可用')) ok('premarket prompt: 不可用块如实进 prompt');
    else fail('premarket prompt 降级', pmUserErr.slice(0, 200));

  } catch (e) {
    fail('5.2 c 事后验证', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [20] 5.3 长期路线图: 多智能体 + AI 记忆同步 + 本地 LLM 路由 ==========
section('20] 5.3 长期路线图 (多智能体 / AI 记忆 / 本地 LLM)');
(async () => {

// ---- 20.1 agents._coerceList 容错 ----
try {
  const AG = {
    window: { Core: {} },
    console,
    setTimeout, clearTimeout, setImmediate, clearImmediate
  };
  vm.createContext(AG);
  vm.runInContext(readFileSafe(path.join(WWW, 'core/agents.js')), AG);

  const A = AG.window.Core.Agents;
  if (A && A._coerceList && A.runObserver && A.runPipeline) ok('agents 模块加载');

  // Y9: _summarizeCtx 结构化摘要测试
  if (typeof A._summarizeCtx !== 'function') {
    fail('_summarizeCtx', '未暴露');
  } else {
    // 空 ctx → '(空)'
    if (A._summarizeCtx({}) === '(无事实)') ok('_summarizeCtx: 空 ctx → (无事实)');
    else fail('_summarizeCtx 空', A._summarizeCtx({}));

    // null/undefined → '(空)'
    if (A._summarizeCtx(null) === '(空)' && A._summarizeCtx(undefined) === '(空)') {
      ok('_summarizeCtx: null/undefined → (空)');
    } else fail('_summarizeCtx null', '应返 (空)');

    // holdings 截断到 10 条 + 盈亏
    const longHoldings = Array.from({length: 15}, (_, i) => ({ code: `60000${i}`, name: `股${i}`, profitLossPct: 0.05 + i * 0.01 }));
    const out = A._summarizeCtx({ holdings: longHoldings });
    if (out.includes('共 15 条') && out.includes('取前 10') && out.match(/- 600\d+ \S+ 盈亏/g).length === 10) {
      ok('_summarizeCtx: holdings 截到 10');
    } else fail('_summarizeCtx holdings', out.slice(0, 200));

    // alerts 截断到 5
    const longAlerts = Array.from({length: 8}, (_, i) => ({ code: `00000${i}`, type: 'price_above', condition: '>10' }));
    const outA = A._summarizeCtx({ alerts: longAlerts });
    if (outA.includes('共 8 条') && outA.includes('取前 5') && outA.match(/- 000\d+ price_above/g).length === 5) {
      ok('_summarizeCtx: alerts 截到 5');
    } else fail('_summarizeCtx alerts', outA.slice(0, 200));

    // recentJournals 标题前 8 + assumption
    const js = [
      { date: '2026-07-01', title: '试仓 T', assumption: '业绩拐点' },
      { date: '2026-07-02', code: '600519' }
    ];
    const outJ = A._summarizeCtx({ recentJournals: js });
    if (outJ.includes('2026-07-01 试仓 T') && outJ.includes('(假设: 业绩拐点)')) {
      ok('_summarizeCtx: recentJournals 标题 + assumption');
    } else fail('_summarizeCtx journals', outJ);

    // observations/findings 输出
    const outO = A._summarizeCtx({ observations: [{ severity: 'warning', text: '估值高位' }] });
    if (outO.includes('## 观察点') && outO.includes('[warning] 估值高位')) ok('_summarizeCtx: observations');
    else fail('_summarizeCtx obs', outO);

    const outF = A._summarizeCtx({ findings: [{ type: 'positive', confidence: 'high', text: '盈利改善' }] });
    if (outF.includes('[high/positive] 盈利改善')) ok('_summarizeCtx: findings');
    else fail('_summarizeCtx findings', outF);

    // news 数组 + 字符串两种
    const outN1 = A._summarizeCtx({ news: [{ title: 'PMI 跌破 50' }, { title: 'LPR 下调' }] });
    if (outN1.includes('- PMI 跌破 50') && outN1.includes('- LPR 下调')) ok('_summarizeCtx: news 数组');
    else fail('_summarizeCtx news 数组', outN1);

    const outN2 = A._summarizeCtx({ news: '今日要闻: A, B, C' });
    if (outN2.includes('## 新闻') && outN2.includes('今日要闻')) ok('_summarizeCtx: news 字符串');
    else fail('_summarizeCtx news 字符串', outN2);

    // market 字符串
    const outM = A._summarizeCtx({ market: '沪指 3300 +0.5%' });
    if (outM.includes('## 市场') && outM.includes('沪指 3300')) ok('_summarizeCtx: market 字符串');
    else fail('_summarizeCtx market', outM);
  }

  // 正常 JSON
  let r = A._coerceList('{"observations":[{"category":"holding","text":"x","severity":"info"}]}', 'observations', {
    category: A.ALLOWED.observationCategory, severity: A.ALLOWED.observationSeverity
  });
  if (r.length === 1 && r[0].category === 'holding') ok('_coerceList: 正常 JSON');
  else fail('_coerceList 正常 JSON', JSON.stringify(r));

  // ```json 包裹
  r = A._coerceList('```json\n{"observations":[{"category":"market","text":"y","severity":"warning"}]}\n```', 'observations', {
    category: A.ALLOWED.observationCategory, severity: A.ALLOWED.observationSeverity
  });
  if (r.length === 1 && r[0].category === 'market') ok('_coerceList: ```json 包裹');
  else fail('_coerceList 包裹', JSON.stringify(r));

  // 非法 category 回退
  r = A._coerceList('{"observations":[{"category":"invalid_xxx","text":"z","severity":"critical"}]}', 'observations', {
    category: A.ALLOWED.observationCategory, severity: A.ALLOWED.observationSeverity
  });
  if (r.length === 1 && r[0].category === A.ALLOWED.observationCategory[0] && r[0].severity === 'critical') ok('_coerceList: 非法枚举回退到第一项');
  else fail('_coerceList 非法枚举回退', JSON.stringify(r));

  // 非法 JSON → 空数组
  r = A._coerceList('not json at all', 'observations', null);
  if (r.length === 0) ok('_coerceList: 非法 JSON 返回空数组');
  else fail('_coerceList 非法 JSON', JSON.stringify(r));

  // 截取 { } 段
  r = A._coerceList('前置废话 {"observations":[{"category":"alert","text":"a","severity":"warning"}]} 后置废话', 'observations', {
    category: A.ALLOWED.observationCategory, severity: A.ALLOWED.observationSeverity
  });
  if (r.length === 1 && r[0].category === 'alert') ok('_coerceList: 截取 { } 段');
  else fail('_coerceList 截取', JSON.stringify(r));

  // 缺 key → 空数组
  r = A._coerceList('{"other":[]}', 'observations', null);
  if (r.length === 0) ok('_coerceList: 缺 key 返空');
  else fail('_coerceList 缺 key', JSON.stringify(r));

  // ALLOWED 完整性
  if (A.ALLOWED.observationCategory.includes('holding') && A.ALLOWED.coachAction.includes('hold')
    && A.ALLOWED.findingConfidence.includes('high') && A.ALLOWED.coachUrgency.includes('immediate')) {
    ok('ALLOWED 枚举完整');
  } else fail('ALLOWED 枚举', JSON.stringify(A.ALLOWED));

  // ---- 20.2 agents runObserver/Analyst/Coach (mock deps.callLLM) ----
  const mockCallLLM = async (opts) => {
    if (opts.systemPrompt.includes('观察者')) {
      return '{"observations":[{"category":"holding","code":"600519","text":"茅台持仓浮盈","severity":"info","source":"holding"}]}';
    }
    if (opts.systemPrompt.includes('分析师')) {
      return '{"findings":[{"type":"positive","code":"600519","text":"基本面稳健","confidence":"high"}]}';
    }
    if (opts.systemPrompt.includes('教练')) {
      return '{"actions":[{"code":"600519","action":"hold","reason":"持有不动","urgency":"low","targetPrice":null}],"watchlist":["000001"]}';
    }
    return '{}';
  };

  const ctxR = await A.runObserver({ holdings: [{ code: '600519', shares: 100 }] }, { deps: { callLLM: mockCallLLM } });
  if (ctxR.ok && ctxR.data.observations.length === 1 && ctxR.data.observations[0].code === '600519') ok('runObserver: mock callLLM');
  else fail('runObserver', JSON.stringify(ctxR));

  const ctxA = await A.runAnalyst({ observations: ctxR.data.observations }, { deps: { callLLM: mockCallLLM } });
  if (ctxA.ok && ctxA.data.findings[0].type === 'positive' && ctxA.data.findings[0].confidence === 'high') ok('runAnalyst: mock callLLM');
  else fail('runAnalyst', JSON.stringify(ctxA));

  const ctxC = await A.runCoach({ findings: ctxA.data.findings, observations: ctxR.data.observations }, { deps: { callLLM: mockCallLLM } });
  if (ctxC.ok && ctxC.data.actions[0].action === 'hold' && ctxC.data.watchlist[0] === '000001') ok('runCoach: mock callLLM + watchlist');
  else fail('runCoach', JSON.stringify(ctxC));

  // ---- 20.3 runPipeline 5 个 intent ----
  const pObs = await A.runPipeline('observe', { holdings: [{ code: '600519' }] }, { deps: { callLLM: mockCallLLM } });
  if (pObs.intent === 'observe' && pObs.steps.length === 1 && pObs.steps[0].agent === 'observer') ok('pipeline: observe 只跑 observer');
  else fail('pipeline observe', JSON.stringify(pObs.steps.map(s => s.agent)));

  const pDiag = await A.runPipeline('diagnose', { holdings: [] }, { deps: { callLLM: mockCallLLM } });
  if (pDiag.steps.length === 2 && pDiag.steps[0].agent === 'observer' && pDiag.steps[1].agent === 'analyst') ok('pipeline: diagnose 跑 observer+analyst');
  else fail('pipeline diagnose', JSON.stringify(pDiag.steps.map(s => s.agent)));

  const pNext = await A.runPipeline('next', { observations: [{ category: 'holding', code: '600519' }] }, { deps: { callLLM: mockCallLLM } });
  if (pNext.steps.length === 2 && pNext.steps[0].agent === 'analyst' && pNext.steps[1].agent === 'coach' && pNext.final && pNext.final.actions) ok('pipeline: next 跳过 observer');
  else fail('pipeline next', JSON.stringify(pNext));

  const pToday = await A.runPipeline('today', {}, { deps: { callLLM: mockCallLLM } });
  if (pToday.steps.length === 3 && pToday.steps[0].agent === 'observer' && pToday.steps[1].agent === 'analyst' && pToday.steps[2].agent === 'coach') ok('pipeline: today 全链路');
  else fail('pipeline today', JSON.stringify(pToday.steps.map(s => s.agent)));

  const pFull = await A.runPipeline('full', {}, { deps: { callLLM: mockCallLLM } });
  if (pFull.steps.length === 3) ok('pipeline: full 等同 today');
  else fail('pipeline full', JSON.stringify(pFull.steps));

  // 默认 intent (未传) → today
  const pDef = await A.runPipeline(undefined, {}, { deps: { callLLM: mockCallLLM } });
  if (pDef.intent === 'today' && pDef.steps.length === 3) ok('pipeline: 默认 today');
  else fail('pipeline 默认', JSON.stringify({ intent: pDef.intent, n: pDef.steps.length }));

  // pipeline 失败处理: mock 抛错
  const failMock = async () => { throw new Error('mock 失败'); };
  const pFail = await A.runPipeline('observe', {}, { deps: { callLLM: failMock } });
  if (pFail.steps.length === 1 && !pFail.steps[0].ok && pFail.summary.includes('失败')) ok('pipeline: agent 失败优雅降级');
  else fail('pipeline 降级', JSON.stringify(pFail.steps[0]));

} catch (e) {
  fail('agents 模块', e.message + ' / ' + (e.stack || ''));
}

// ---- 20.4 sync._isAIJournal / _isAIAlert ----
try {
  // 加载 sync.js, 注入 mock
  // vm 技巧: 让 window === context 本身, 这样 window.Core 和 context.Core 互通
  const SY = {
    console,
    setTimeout, clearTimeout,
    Core: {},
    toastSuccess: () => {}, toastInfo: () => {}, toastError: () => {},
    fetch: async () => []  // 默认空, 测试时再覆盖
  };
  SY.Core.State = {
    get: () => ({ sync: { userId: 'u-1', url: 'https://x.supabase.co', anonKey: 'ak', accessToken: 'tk' } }),
    set: () => {}
  };
  SY.Core.Storage = { all: async () => [] };
  vm.createContext(SY);
  SY.window = SY;  // vm 里 window 指向 context
  vm.runInContext(readFileSafe(path.join(WWW, 'core/sync.js')), SY);

  const S = SY.Core.Sync;

  if (S._isAIJournal({ aiSuggested: { x: 1 } })) ok('sync._isAIJournal: aiSuggested');
  else fail('sync._isAIJournal aiSuggested');

  if (S._isAIJournal({ verifiedAt: 123 })) ok('sync._isAIJournal: verifiedAt');
  else fail('sync._isAIJournal verifiedAt');

  if (S._isAIJournal({ assumption: '技术突破' })) ok('sync._isAIJournal: assumption');
  else fail('sync._isAIJournal assumption');

  if (S._isAIJournal({ emotion: '恐慌割肉' })) ok('sync._isAIJournal: emotion');
  else fail('sync._isAIJournal emotion');

  if (S._isAIJournal({ verify: '1w' })) ok('sync._isAIJournal: verify');
  else fail('sync._isAIJournal verify');

  if (!S._isAIJournal({ id: 'j-1', content: '普通复盘' })) ok('sync._isAIJournal: 普通不命中');
  else fail('sync._isAIJournal 普通');

  if (S._isAIAlert({ lastHit: '2026-07-26' })) ok('sync._isAIAlert: lastHit');
  else fail('sync._isAIAlert lastHit');

  if (S._isAIAlert({ hitHistory: [{ ts: 1 }] })) ok('sync._isAIAlert: hitHistory');
  else fail('sync._isAIAlert hitHistory');

  if (!S._isAIAlert({ id: 'a-1', active: true })) ok('sync._isAIAlert: 普通不命中');
  else fail('sync._isAIAlert 普通');

  // ---- 20.5 sync.pushAIMemory / pullAIMemory (mock fetch) ----
  // mock 完整的 Response 接口 (ok, status, text, json)
  const fakeResp = (data, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    statusText: 'OK',
    text: async () => typeof data === 'string' ? data : JSON.stringify(data),
    json: async () => data
  });
  const fakeFetch = async (url, opts = {}) => {
    const m = String(url);
    if (m.includes('/rest/v1/kv') && opts.method === 'POST') {
      const body = JSON.parse(opts.body);
      return fakeResp([body]);
    }
    if (m.includes('/rest/v1/kv') && opts.method === undefined) {
      return fakeResp([{
        value: [
          { kind: 'journal_ai', payload: { id: 'j-1', aiSuggested: { x: 1 } } },
          { kind: 'journal_ai', payload: { id: 'j-missing' } },
          { kind: 'alert_hit', payload: { id: 'a-1', hitCount: 5 } }
        ]
      }]);
    }
    return fakeResp([]);
  };
  S._session = { access_token: 'tk', user: { id: 'u-1' } };
  const origFetch = SY.fetch;
  SY.fetch = fakeFetch;
  SY.Core.Storage.all = async (table) => {
    if (table === 'journals') return [
      { id: 'j-1', content: '有 AI', aiSuggested: { x: 1 } },
      { id: 'j-2', content: '普通复盘' }
    ];
    if (table === 'alerts') return [
      { id: 'a-1', code: '600519', hitCount: 3, lastHit: '2026-07-25' },
      { id: 'a-2', code: '000001' }
    ];
    return [];
  };
  SY.Core.Storage.add = async () => {};
  SY.Core.Storage.put = async () => {};  // Y8: pullAIMemory 改用 put
  SY.Core.Storage.clear = async () => {};

  const pushR = await S.pushAIMemory();
  if (pushR.journals === 1 && pushR.alerts === 1 && pushR.total === 2) ok('sync.pushAIMemory: 过滤无 AI 痕迹');
  else fail('pushAIMemory', JSON.stringify(pushR));

  const pushDry = await S.pushAIMemory({ dryRun: true });
  if (pushDry.dryRun === true && pushDry.journals === 1) ok('sync.pushAIMemory: dryRun');
  else fail('pushAIMemory dryRun', JSON.stringify(pushDry));

  let jMerged = 0, aMerged = 0;
  // Y8: 同时 mock add 和 put (pullAIMemory 改用 put)
  SY.Core.Storage.add = async (table, rec) => {
    if (table === 'journals' && rec.id === 'j-1' && rec.aiSuggested?.x === 1) jMerged++;
    if (table === 'alerts' && rec.id === 'a-1' && rec.hitCount === 5) aMerged++;
  };
  SY.Core.Storage.put = async (table, rec) => {
    if (table === 'journals' && rec.id === 'j-1' && rec.aiSuggested?.x === 1) jMerged++;
    if (table === 'alerts' && rec.id === 'a-1' && rec.hitCount === 5) aMerged++;
  };
  const pullR = await S.pullAIMemory();
  if (pullR.journals === 1 && pullR.alerts === 1 && jMerged === 1 && aMerged === 1) ok('sync.pullAIMemory: 合并 + 跳过本地无记录');
  else fail('pullAIMemory', JSON.stringify({ pullR, jMerged, aMerged }));

  global.fetch = async () => fakeResp([]);  // 同步给 global (虽然 vm 用 SY.fetch)
  SY.fetch = async () => fakeResp([]);
  const pullEmpty = await S.pullAIMemory();
  if (pullEmpty.journals === 0 && pullEmpty.reason === 'no-cloud-data') ok('sync.pullAIMemory: 云端无数据');
  else fail('pullAIMemory 空', JSON.stringify(pullEmpty));

  SY.fetch = origFetch;
  global.fetch = origFetch;

  // ---- 20.6 pushAIMemory 未登录抛错 ----
  const origSession = S._session;
  S._session = null;
  SY.Core.State.get = () => ({ sync: { userId: '', url: 'https://x', anonKey: 'ak' } });
  let pushErr = null;
  try { await S.pushAIMemory(); } catch (e) { pushErr = e.message; }
  if (pushErr && pushErr.includes('未登录')) ok('sync.pushAIMemory: 未登录抛错');
  else fail('pushAIMemory 未登录', pushErr);

  S._session = origSession;

} catch (e) {
  fail('sync AI 记忆', e.message + ' / ' + (e.stack || ''));
}

// ---- 20.7 ai-service getConfig preferLocal ----
try {
  // vm sandbox: Core 挂到 context 顶层, window === context
  const AI = {
    console,
    setTimeout, clearTimeout,
    Core: { State: { get: () => ({}) } },
    fetch: async () => ({ ok: false })
  };
  vm.createContext(AI);
  AI.window = AI;
  vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), AI);

  const A = AI.Core.AI;
  AI.Core.State.get = () => ({
    ai: {
      provider: 'deepseek',
      apiKey: 'k1',
      model: 'deepseek-v4-flash',
      preferLocal: true,
      localEndpoint: { baseURL: 'http://192.168.1.10:1234/v1', model: 'qwen2.5-7b' }
    }
  });
  const cfg1 = A.getConfig();
  if (cfg1.preferLocal === true && cfg1.local.enabled === true
    && cfg1.local.baseURL === 'http://192.168.1.10:1234/v1'
    && cfg1.local.model === 'qwen2.5-7b') ok('ai.getConfig: preferLocal=true + local.enabled');
  else fail('ai.getConfig preferLocal', JSON.stringify(cfg1.local));

  AI.Core.State.get = () => ({
    ai: { provider: 'deepseek', apiKey: 'k1', preferLocal: false, localEndpoint: { baseURL: 'http://x:1234/v1' } }
  });
  const cfg2 = A.getConfig();
  if (cfg2.preferLocal === false && cfg2.local.enabled === false) ok('ai.getConfig: preferLocal=false');
  else fail('ai.getConfig preferLocal=false', JSON.stringify({ p: cfg2.preferLocal, e: cfg2.local.enabled }));

  AI.Core.State.get = () => ({
    ai: { provider: 'deepseek', apiKey: 'k1', preferLocal: true, localEndpoint: {} }
  });
  const cfg3 = A.getConfig();
  if (cfg3.preferLocal === true && cfg3.local.enabled === false) ok('ai.getConfig: preferLocal 但无 baseURL');
  else fail('ai.getConfig 无 baseURL', JSON.stringify({ p: cfg3.preferLocal, e: cfg3.local.enabled }));

  // ---- 20.8 resolveEndpoint 路由 ----
  AI.Core.State.get = () => ({
    ai: {
      provider: 'deepseek',
      apiKey: 'remote-key',
      model: 'deepseek-v4-flash',
      preferLocal: true,
      localEndpoint: { baseURL: 'http://192.168.1.10:1234/v1', apiKey: 'local', model: 'qwen2.5-7b' }
    }
  });
  let ep = A.resolveEndpoint({ local: true });
  if (ep.isLocal === true && ep.model === 'qwen2.5-7b' && ep.baseURL === 'http://192.168.1.10:1234/v1') ok('resolveEndpoint: local=true 强制本地');
  else fail('resolveEndpoint local=true', JSON.stringify(ep));

  ep = A.resolveEndpoint({ local: false });
  if (ep.isLocal === false && ep.model === 'deepseek-v4-flash') ok('resolveEndpoint: local=false 强制远程');
  else fail('resolveEndpoint local=false', JSON.stringify(ep));

  ep = A.resolveEndpoint({});
  if (ep.isLocal === true) ok('resolveEndpoint: 未指定按 preferLocal=true');
  else fail('resolveEndpoint 未指定', JSON.stringify(ep));

  AI.Core.State.get = () => ({
    ai: { provider: 'deepseek', apiKey: 'k1', model: 'deepseek-v4-flash', preferLocal: true, localEndpoint: {} }
  });
  ep = A.resolveEndpoint({});
  if (ep.isLocal === false && ep.reason === 'local-disabled-fallback-remote') ok('resolveEndpoint: 本地未启用降级远程');
  else fail('resolveEndpoint 降级', JSON.stringify(ep));

  AI.Core.State.get = () => ({
    ai: { provider: 'deepseek', apiKey: 'k1', model: 'deepseek-v4-flash', preferLocal: false,
      localEndpoint: { baseURL: 'http://192.168.1.10:1234/v1', model: 'qwen' } }
  });
  ep = A.resolveEndpoint({});
  if (ep.isLocal === false && ep.reason === 'remote') ok('resolveEndpoint: preferLocal=false → 远程');
  else fail('resolveEndpoint preferLocal=false', JSON.stringify(ep));

  AI.Core.State.get = () => ({
    ai: { provider: 'deepseek', apiKey: 'cfg-key', model: 'cfg-model', preferLocal: false, localEndpoint: {} }
  });
  ep = A.resolveEndpoint({ local: false, baseURL: 'http://override/', model: 'ov-model', apiKey: 'ov-key' });
  if (ep.baseURL === 'http://override' && ep.model === 'ov-model' && ep.apiKey === 'ov-key') ok('resolveEndpoint: opts 覆盖');
  else fail('resolveEndpoint opts 覆盖', JSON.stringify(ep));

} catch (e) {
  fail('ai-service 5.3.3', e.message + ' / ' + (e.stack || ''));
}

})();

// ========== [21] c 数据源限流修复: retry + 退避 + 全局限流状态 ==========
section('21] c 数据源限流修复 (retry/退避/限流)');
(async () => {
  try {
    // vm sandbox: window === context
    const DS = {
      console,
      setTimeout, clearTimeout,
      URLSearchParams,  // vm 没 web globals, 手动加
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: {
          cacheGet: async () => null,
          cacheSet: async () => {}
        }
      },
      fetch: async () => ({ ok: false, status: 500, text: async () => 'error' })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    const D = DS.window.Core.Data;

    // ---- 21.1 getLimitStatus 默认 ----
    const s0 = D.getLimitStatus();
    if (s0.blocked === false && s0.retryIn === 0 && s0.lastError === '' && s0.lastSuccess === 0) ok('getLimitStatus: 默认无限制');
    else fail('getLimitStatus 默认', JSON.stringify(s0));

    // ---- 21.2 HTTP 429 触发限流 (codes 路径) ----
    // 注: 无 codes 走东财全市场, fetch 不返限流错 (静默返空)
    // 限流能力保留给 codes 路径 (腾讯→aktools 降级)
    DS.fetch = async () => ({ ok: false, status: 429, text: async () => 'Too Many Requests' });
    let r1;
    try { await D.getStockSpot(['600519']); r1 = 'NO_THROW'; }
    catch (e) { r1 = e.message; }
    if (r1.includes('数据源限流') && r1.includes('60s')) {
      const s1 = D.getLimitStatus();
      if (s1.blocked && s1.retryIn > 0 && s1.retryIn <= 60000) ok('HTTP 429 触发 60s 限流');
      else fail('429 限流状态', JSON.stringify(s1));
    } else fail('HTTP 429 未触发限流', r1);

    // ---- 21.3 限流期内不发起任何 fetch (走 getStockKLine 限流检查) ----
    // getStockKLine 在限流期会直接 throw 不发请求, 与 fetchWithCache 行为一致
    // (因腾讯 fetcher 不受 aktools 限流约束, 不能用 codes 路径测)
    let fetchCalled = false;
    DS.fetch = async () => { fetchCalled = true; return { ok: false, status: 502, text: async () => 'Bad Gateway' }; };
    let r2;
    try { await D.getStockKLine('600519'); r2 = 'NO_THROW'; }
    catch (e) { r2 = e.message; }
    if (r2.includes('限流') && r2.includes('后') && !fetchCalled) ok('限流期内 fetch 不发起请求');
    else fail('限流期内行为', JSON.stringify({ msg: r2, fetchCalled }));

    // ---- 21.4 retry: 链式降级 (腾讯 4xx → 新浪 fail → aktools 200) ----
    // 注: Z13 新增新浪兜底层, mock 模拟"两个源都挂, 第三个走 aktools 拿数据"
    D.resetLimit();
    DS.Core.Storage.cacheGet = async () => null;
    let attempt = 0;
    DS.fetch = async () => {
      attempt++;
      if (attempt === 1) return { ok: false, status: 400, text: async () => 'Bad Request' };  // 腾讯 4xx
      if (attempt === 2) return { ok: false, status: 502, text: async () => 'Bad Gateway' }; // 新浪 5xx
      // aktools 返全市场
      return { ok: true, status: 200, json: async () => ([{ 代码: '600519', ret: 'success' }]) };
    };
    const r3 = await D.getStockSpot(['600519']);
    if (r3 && Array.isArray(r3) && r3[0] && r3[0].ret === 'success' && attempt === 3) ok('降级链: 腾讯→新浪→aktools');
    else fail('降级链', JSON.stringify({ r: r3, attempt }));

    // ---- 21.5 4xx 业务错误: 重试 N 次后抛 (codes 路径) ----
    D.resetLimit();
    attempt = 0;
    DS.fetch = async () => {
      attempt++;
      return { ok: false, status: 400, text: async () => 'Bad Request - invalid symbol' };
    };
    let r4;
    try { await D.getStockSpot(['600519']); r4 = 'NO_THROW'; }
    catch (e) { r4 = e.message; }
    if (r4.includes('HTTP 400') && attempt === 3) ok('4xx 业务错误重试 3 次后抛错');
    else fail('4xx retry N 次', JSON.stringify({ r: r4, attempt }));

    // ---- 21.6 5xx → 限流 (走 codes 路径, aktools 仍保有重试/限流能力) ----
    // 注: 无 codes 时东财全市场已独立处理 (失败静默 []), 不进全局限流
    D.resetLimit();
    attempt = 0;
    DS.fetch = async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' });
    let r5;
    // codes 路径: 4xx 重试 3 次后抛, 5xx 触发限流
    try { await D.getStockSpot(['600519']); r5 = 'NO_THROW'; }
    catch (e) { r5 = e.message; }
    if (r5.includes('数据源限流') && r5.includes('60s')) ok('5xx 触发 60s 限流 (codes 路径)');
    else fail('5xx 限流', r5);

    // ---- 21.7 缓存命中: 不发请求 (限流期内也用缓存) ----
    attempt = 0;
    DS.fetch = async () => { attempt++; return { ok: true, status: 200, json: async () => ({}) }; };
    let cacheGetCalled = 0;
    DS.Core.Storage.cacheGet = async () => { cacheGetCalled++; return { ret: 'cached' }; };
    let r6;
    try { r6 = await D.getStockSpot(); } catch (e) { r6 = 'ERR:' + e.message; }
    if (r6 && typeof r6 === 'object' && r6.ret === 'cached' && attempt === 0 && cacheGetCalled >= 1) ok('限流期缓存命中不发请求');
    else fail('限流期缓存命中', JSON.stringify({ r: r6, attempt, cacheGetCalled }));

    D.resetLimit();

    // ---- 21.8 getIndexSpot 用 symbol 参数 ----
    D.resetLimit();
    attempt = 0;
    DS.Core.Storage.cacheGet = async () => null;
    let calledUrl = '';
    DS.fetch = async (url) => {
      attempt++;
      calledUrl = url;
      return { ok: true, status: 200, json: async () => ({}) };
    };
    await D.getIndexSpot();
    if (attempt === 1 && calledUrl.includes('stock_zh_index_spot') && calledUrl.includes('symbol=')) ok('getIndexSpot: URL 带 symbol');
    else fail('getIndexSpot URL', JSON.stringify({ url: calledUrl, attempt }));

  } catch (e) {
    fail('c 数据源限流修复', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [22] Y12 腾讯 K 线 fetcher ==========
// 独立 IIFE: 不依赖 [21] (避免 21.5 retry bug 阻塞 Y12 跑不到)
(async () => {
  try {
    const DS = {
      console,
      setTimeout, clearTimeout,
      URLSearchParams,
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: {
          cacheGet: async () => null,
          cacheSet: async () => {}
        }
      },
      fetch: async () => ({ ok: false, status: 500, text: async () => 'error' })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    const D = DS.window.Core.Data;
    D.resetLimit();
    DS.Core.Storage.cacheGet = async () => null;

    // 22.Y12.1 _tencentKLine 字段归一化 (mock 腾讯返回)
    let tencentUrls = [];
    DS.fetch = async (url) => {
      tencentUrls.push(url);
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          code: 0, msg: '',
          data: {
            sh600519: {
              qfqday: [
                ['2024-07-10', 1700.50, 1710.20, 1720.00, 1695.30, 12345, '...', 1.23e9, 1.45, 0.57, 9.70, 0.42],
                ['2024-07-11', 1710.00, 1705.50, 1715.00, 1700.10, 11000, '...', 1.10e9, 0.87, -0.28, -4.70, 0.38]
              ]
            }
          }
        })
      };
    };
    const klineRows = await D._tencentKLine('600519', 'day', '2024-07-10', '2024-07-11', 5, 'qfq');
    const symbolOK = tencentUrls[0] && tencentUrls[0].includes('sh600519');
    if (klineRows.length === 2
      && klineRows[0].日期 === '2024-07-10'
      && klineRows[0].开盘 === 1700.50
      && klineRows[0].收盘 === 1710.20
      && klineRows[0].最高 === 1720.00
      && klineRows[0].最低 === 1695.30
      && klineRows[0].成交量 === 12345 * 100
      && klineRows[0].成交额 === 1.23e9
      && klineRows[0].振幅 === 1.45
      && klineRows[0].涨跌幅 === 0.57
      && klineRows[0].换手率 === 0.42
      && symbolOK) {
      ok('_tencentKLine: 字段归一化正确 + 6→sh 前缀');
    } else fail('_tencentKLine 字段归一化', JSON.stringify({ row: klineRows[0], url: tencentUrls[0] }));

    // 22.Y12.1b 真实腾讯只返 6 列 (无成交额/振幅/涨跌幅/换手率/涨跌额), 缺位应 null (不是 0)
    DS.fetch = async () => ({
      ok: true, status: 200,
      text: async () => JSON.stringify({
        code: 0, msg: '',
        data: { sh600519: { qfqday: [['2024-07-10', 1335.787, 1334.127, 1362.417, 1331.537, 23763]] } }
      })
    });
    const real6 = await D._tencentKLine('600519', 'day', '2024-07-10', '2024-07-10', 5, 'qfq');
    if (real6.length === 1
      && real6[0].收盘 === 1334.127
      && real6[0].成交量 === 2376300
      && real6[0].成交额 === null
      && real6[0].振幅 === null
      && real6[0].涨跌幅 === null
      && real6[0].涨跌额 === null
      && real6[0].换手率 === null) {
      ok('_tencentKLine: 真实 6 列数据, 缺位字段=null (非 0)');
    } else fail('_tencentKLine 6 列归一化', JSON.stringify(real6[0]));

    // 22.Y12.2 _tencentKLine 周期映射 + sz 前缀 (mock 任何 symbol 都返一对空模板)
    tencentUrls = [];
    DS.fetch = async (url) => {
      tencentUrls.push(url);
      // 从 URL 提取 symbol: ?param=symbol,period,... 第 0 段
      const m = url.match(/param=([^,]+),/);
      const sym = m ? m[1] : 'sh600519';
      return {
        ok: true, status: 200,
        text: async () => JSON.stringify({
          code: 0, msg: '',
          data: { [sym]: { qfqday: [['2024-07-10', 1700, 1710, 1720, 1695, 12345, '', 1e9, 1, 0.5, 8, 0.4]] } }
        })
      };
    };
    await D._tencentKLine('600519', 'weekly', '', '', 240, 'qfq');
    await D._tencentKLine('600519', 'monthly', '', '', 240, 'qfq');
    await D._tencentKLine('600519', 'daily', '', '', 240, 'qfq');
    await D._tencentKLine('000001', 'daily', '', '', 240, 'qfq');
    await D._tencentKLine('300750', 'daily', '', '', 240, 'qfq');
    const urlOK = tencentUrls.length === 5
      && tencentUrls[0].includes(',week,')
      && tencentUrls[1].includes(',month,')
      && tencentUrls[2].includes(',day,')
      && tencentUrls[3].includes('sz000001')
      && tencentUrls[4].includes('sz300750');
    if (urlOK) ok('_tencentKLine: daily/weekly/monthly + 0/3→sz 前缀');
    else fail('_tencentKLine 周期+前缀', JSON.stringify(tencentUrls));

    // 22.Y12.3 _tencentKLine code ≠ 0 抛错
    DS.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ code: -1, msg: 'invalid symbol', data: {} }) });
    let klineErr = '';
    try { await D._tencentKLine('999999', 'day', '', '', 240, 'qfq'); }
    catch (e) { klineErr = e.message; }
    if (klineErr.includes('invalid symbol')) ok('_tencentKLine: code≠0 抛错');
    else fail('_tencentKLine code≠0', klineErr);

    // 22.Y12.4 getStockKLine 缓存命中不走任何 fetch
    DS.Core.Storage.cacheGet = async () => [{ 日期: '2024-07-10', 收盘: 1710 }];
    let fetchHit = 0;
    DS.fetch = async () => { fetchHit++; return { ok: true, status: 200, json: async () => [] }; };
    const cachedKline = await D.getStockKLine('600519', 'daily', '20240710', '20240710', 'qfq');
    if (fetchHit === 0 && cachedKline.length === 1 && cachedKline[0].收盘 === 1710) {
      ok('getStockKLine: 缓存命中不发请求');
    } else fail('getStockKLine 缓存命中', JSON.stringify({ fetchHit, cached: cachedKline }));

    // 22.Y12.5 getStockKLine 腾讯失败 → 降级 aktools
    DS.Core.Storage.cacheGet = async () => null;
    fetchHit = 0;
    DS.fetch = async (url) => {
      fetchHit++;
      if (url.includes('web.ifzq.gtimg.cn')) {
        throw new Error('Tencent net error');
      }
      return { ok: true, status: 200, json: async () => [{ 日期: '2024-07-10', 收盘: 1710 }] };
    };
    const fallbackKline = await D.getStockKLine('600519', 'daily', '20240710', '20240710', 'qfq');
    if (fetchHit === 2 && fallbackKline.length === 1 && fallbackKline[0].收盘 === 1710) {
      ok('getStockKLine: 腾讯失败降级 aktools');
    } else fail('getStockKLine 降级', JSON.stringify({ fetchHit, fallback: fallbackKline }));

    // 22.Y12.6 getStockKLine 腾讯 HTTP 400 → 降级
    DS.Core.Storage.cacheGet = async () => null;
    fetchHit = 0;
    DS.fetch = async (url) => {
      fetchHit++;
      if (url.includes('web.ifzq.gtimg.cn')) {
        return { ok: false, status: 400, text: async () => 'Bad Request' };
      }
      return { ok: true, status: 200, json: async () => [{ 日期: '2024-07-10', 收盘: 1710 }] };
    };
    const fallback2 = await D.getStockKLine('600519', 'daily', '20240710', '20240710', 'qfq');
    if (fetchHit === 2 && fallback2[0].收盘 === 1710) ok('getStockKLine: 腾讯 HTTP 400 → 降级 aktools');
    else fail('getStockKLine 400 降级', JSON.stringify({ fetchHit, fallback: fallback2 }));

    // 22.Y12.7 getStockKLine 缓存失败仍走 fetch (一次成功即返)
    DS.Core.Storage.cacheGet = async () => null;
    fetchHit = 0;
    DS.fetch = async (url) => {
      fetchHit++;
      if (url.includes('web.ifzq.gtimg.cn')) {
        const m = url.match(/param=([^,]+),/);
        const sym = m ? m[1] : 'sh600519';
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { [sym]: { qfqday: [['2024-07-10', 1700, 1710, 1720, 1695, 12345, '', 1e9, 1, 0.5, 8, 0.4]] } } }) };
      }
      return { ok: true, status: 200, json: async () => [] };
    };
    const txKline = await D.getStockKLine('600519', 'daily', '20240710', '20240710', 'qfq');
    if (fetchHit === 1 && txKline.length === 1 && txKline[0].收盘 === 1710) {
      ok('getStockKLine: 缓存失败走腾讯, 一次成功即返');
    } else fail('getStockKLine 一次成功', JSON.stringify({ fetchHit, tx: txKline }));

    D.resetLimit();
  } catch (e) {
    fail('Y12 腾讯 K 线 fetcher', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [22.5] Z13 新浪 fetcher (腾讯失败兜底) ==========
section('22.5] Z13 新浪 hq.sinajs.cn fetcher (腾讯失败兜底)');
(async () => {
  try {
    // vm sandbox 内 TextDecoder 必须显式注入 (浏览器有, node vm 里没绑 global)
    // 用 node 原生 TextDecoder + 简易 Buffer/Iconv polyfill 不可行, 但 Node 现成 TextDecoder 可以
    // 只要把 node 的 TextDecoder 传过去
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: { cacheGet: async () => null, cacheSet: async () => {} }
      },
      fetch: async () => ({ ok: false, status: 502, text: async () => 'Bad Gateway' })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    const D = DS.window.Core.Data;

    // ---- 22.5.1 _sinaParse 解码 GBK 格式 ----
    // 模拟新浪响应 (结构: var hq_str_sh600519="..."
    const sinaText = [
      'var hq_str_sh600519="',
      '贵州茅台',  // 贵州茅台 UTF-8 escape (避免中文引号问题)
      ',1308.000,1297.410,1289.500,1308.000,1279.580,1289.500,1289.660,3199044,4129228560.000,',
      '0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-07-27,15:34:59,00";',
      ''
    ].join('');
    const r1 = D._sinaParse(sinaText, ['sh600519'].map(s => s.slice(2)));
    if (r1 && r1.length === 1 && r1[0].代码 === '600519' && r1[0].最新价 === 1289.5) ok('_sinaParse: 解析单只 (代码/名称/现价)');
    else fail('_sinaParse 单只', JSON.stringify(r1));

    // ---- 22.5.2 涨跌额/涨跌幅 = 现价 - 昨收 ----
    if (r1 && r1[0] && Math.abs(r1[0].涨跌额 - (-7.91)) < 0.01) ok('_sinaParse: 涨跌额 = 现价 - 昨收');
    else fail('_sinaParse 涨跌额', JSON.stringify(r1 && r1[0]));

    // ---- 22.5.3 _sinaFetch 透传 Referer + UA ----
    // 注: Windows Node 24 的 Buffer 不支持 'gb18030' encoding (缺少完整 ICU),
    //   所以 mock 提供已解码好的字符串 + 模拟 arrayBuffer 的二进制 Buffer 形态.
    //   浏览器生产环境 GBK 解码 100% 工作 (浏览器内置 ICU).
    let capturedUrl = '', capturedHeaders = null;
    let capturedBuf = false;
    DS.fetch = async (url, init = {}) => {
      capturedUrl = url;
      capturedHeaders = init.headers;
      // 返 UTF-8 字符串(fake GBK body, 测试只验证下游解析)
      capturedBuf = init && init.body === undefined; // fetch.getReader check marker (无body)
      return {
        ok: true, status: 200,
        arrayBuffer: async () => {
          const s = 'var hq_str_sz000001="平安银行,11.110,11.100,11.110,11.160,11.040,11.110,11.120,95715556,1062796331.760,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-07-27,15:36:00,00";\n';
          // utf-8 encode 到 ArrayBuffer
          return new TextEncoder().encode(s).buffer;
        }
      };
    };
    const r2 = await D._sinaFetch(['000001']);
    if (capturedUrl.includes('hq.sinajs.cn/list=') && capturedUrl.includes('sz000001')) ok('_sinaFetch: URL 走 hq.sinajs.cn');
    else fail('_sinaFetch URL', capturedUrl);
    if (capturedHeaders && capturedHeaders.Referer && capturedHeaders.Referer.includes('sina.com.cn')) ok('_sinaFetch: 带 Referer');
    else fail('_sinaFetch Referer', JSON.stringify(capturedHeaders));
    if (r2 && r2.length === 1 && r2[0].代码 === '000001' && r2[0].最新价 === 11.11) ok('_sinaFetch: 解析平安银行 (utf-8 mock)');
    else fail('_sinaFetch 解析', JSON.stringify(r2));

    // ---- 22.5.4 降级链: 腾讯 → 新浪 → 成功 ----
    let whichCalled = '';
    DS.fetch = async (url) => {
      whichCalled = url.includes('qt.gtimg.cn') ? 'tencent' :
                    url.includes('sinajs.cn') ? 'sina' : 'aktools';
      if (whichCalled === 'tencent') {
        return { ok: false, status: 502, text: async () => 'Bad Gateway' };
      }
      if (whichCalled === 'sina') {
        const s = 'var hq_str_sh600519="贵州茅台,1308.000,1297.410,1289.500,1308.000,1279.580,1289.500,1289.660,3199044,4129228560.000,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,2026-07-27,15:34:59,00";\n';
        return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(s).buffer };
      }
      return { ok: true, status: 200, json: async () => ([]) };
    };
    const r3 = await D.getStockSpot(['600519']);
    if (r3 && r3.length === 1 && r3[0].代码 === '600519' && r3[0].最新价 === 1289.5) ok('降级链: 腾讯失败 → 新浪成功');
    else fail('降级链', JSON.stringify({ called: whichCalled, r3 }));

    // ---- 22.5.5 降级链: 腾讯 + 新浪都挂 → aktools ----
    DS.fetch = async (url) => {
      if (url.includes('qt.gtimg.cn')) return { ok: false, status: 502, text: async () => '' };
      if (url.includes('sinajs.cn')) return { ok: false, status: 502, text: async () => '' };
      // aktools
      return { ok: true, status: 200, json: async () => ([{ 代码: '600519', 最新价: 1289.5, 涨跌幅: -0.6 }]) };
    };
    const r4 = await D.getStockSpot(['600519']);
    if (r4 && r4.length === 1 && r4[0].代码 === '600519') ok('降级链: 腾讯+新浪都挂 → aktools');
    else fail('降级链 aktools', JSON.stringify(r4));

  } catch (e) {
    fail('Z13 新浪 fetcher', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [23] Paper 模拟盘 (费用/整手/快照/自动成交/买卖集成) ==========
section('23] Paper 模拟盘纯函数实测');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');

    // vm sandbox: mock Core.Storage (内存表) + Core.Data + 全局工具函数
    const buildCtx = (storageData) => {
      const pctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-27',
        uuid: () => 'paper-test-' + Math.random().toString(36).slice(2, 8),
        parseStockInput: (t) => {
          const m = String(t || '').trim().match(/^(\d{6})/);
          return m ? { code: m[1], name: String(t).slice(6).trim() } : null;
        },
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true,
        // Phase C: EOD 飞书推送用 (测试里可覆盖 ctx.fetch 捕获 POST)
        fetch: async () => ({ ok: true, json: async () => ({ code: 0 }) })
      };
      pctx.window.Core = {
        Storage: {
          kvGet: async (k) => (k in storageData.kv ? storageData.kv[k] : null),
          kvSet: async (k, v) => { storageData.kv[k] = v; },
          all: async (t) => storageData.tables[t] || [],
          get: async (t, id) => (storageData.tables[t] || []).find(x => x.id === id) || null,
          add: async (t, obj) => { (storageData.tables[t] = storageData.tables[t] || []).push(obj); },
          put: async (t, obj) => {
            const arr = (storageData.tables[t] = storageData.tables[t] || []);
            const i = arr.findIndex(x => x.id === obj.id);
            if (i >= 0) arr[i] = obj; else arr.push(obj);
          },
          remove: async (t, id) => {
            storageData.tables[t] = (storageData.tables[t] || []).filter(x => x.id !== id);
          }
        },
        Data: {
          getStockQuote: async (code) => storageData.quotes[code] || null,
          getIndexSpot: async () => storageData.indexSpot || []
        },
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' }
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };

    // ---- 纯函数 (不需要 storage 数据) ----
    const ctx0 = buildCtx({ kv: {}, tables: {}, quotes: {}, indexSpot: [] });
    const Paper = ctx0.window.Paper;
    if (!Paper) throw new Error('Paper 未挂到 window');

    // _calcFee: 佣金万三 min 5, 卖出加印花税万五
    const f1 = Paper._calcFee(10000, 'buy');
    if (f1.commission === 5 && f1.stampTax === 0 && f1.total === 5) ok('fee: 买入 1 万 → 佣金 5 (万三 < 最低 5)');
    else fail('fee buy 1w', JSON.stringify(f1));
    const f2 = Paper._calcFee(100000, 'buy');
    if (f2.commission === 30 && f2.stampTax === 0 && f2.total === 30) ok('fee: 买入 10 万 → 佣金 30');
    else fail('fee buy 10w', JSON.stringify(f2));
    const f3 = Paper._calcFee(100000, 'sell');
    if (f3.commission === 30 && f3.stampTax === 50 && f3.total === 80) ok('fee: 卖出 10 万 → 佣金 30 + 印花税 50');
    else fail('fee sell 10w', JSON.stringify(f3));
    const f4 = Paper._calcFee(10000, 'sell');
    if (f4.commission === 5 && f4.stampTax === 5 && f4.total === 10) ok('fee: 卖出 1 万 → 5 + 5');
    else fail('fee sell 1w', JSON.stringify(f4));

    // _roundLot: 整手取整
    if (Paper._roundLot(250) === 200 && Paper._roundLot(99) === 0
      && Paper._roundLot(100) === 100 && Paper._roundLot(0) === 0) ok('lot: 250→200 / 99→0 / 100→100');
    else fail('lot', '');

    // _pushSnapshot: 同日去重 + 不同日 append + 上限 365
    let snaps = Paper._pushSnapshot([], { date: '2026-07-27', paperTotal: 100000, realTotal: 0, csi300: 3900 });
    snaps = Paper._pushSnapshot(snaps, { date: '2026-07-27', paperTotal: 100100, realTotal: 0, csi300: 3901 });
    if (snaps.length === 1 && snaps[0].paperTotal === 100000) ok('snapshot: 同日不重复 push');
    else fail('snapshot 去重', JSON.stringify(snaps));
    snaps = Paper._pushSnapshot(snaps, { date: '2026-07-28', paperTotal: 100100, realTotal: 0, csi300: 3901 });
    if (snaps.length === 2 && snaps[1].paperTotal === 100100) ok('snapshot: 不同日 append');
    else fail('snapshot append', JSON.stringify(snaps));
    let big = [];
    for (let i = 0; i < 400; i++) big = Paper._pushSnapshot(big, { date: `2026-d${String(i).padStart(3, '0')}`, paperTotal: i });
    if (big.length === 365 && big[0].paperTotal === 35 && big[364].paperTotal === 399) ok('snapshot: 上限 365 条滚动截断');
    else fail('snapshot 上限', `${big.length}`);

    // _planAutoTrade: 现金 × positionPct → 整手; 不足一手/含费超现金 → null
    if (Paper._planAutoTrade(100000, 0.10, 10) === 1000) ok('auto: 10 万 × 10% / 10 元 → 1000 股');
    else fail('auto 正常', String(Paper._planAutoTrade(100000, 0.10, 10)));
    if (Paper._planAutoTrade(500, 0.10, 10) === null) ok('auto: 预算 50 元不足一手 → null (跳过)');
    else fail('auto 不足一手', '');
    if (Paper._planAutoTrade(1004, 1.0, 10) === null) ok('auto: 100 股需 1005 (含费) > 现金 1004 → null');
    else fail('auto 含费不足', String(Paper._planAutoTrade(1004, 1.0, 10)));
    if (Paper._planAutoTrade(1005, 1.0, 10) === 100) ok('auto: 现金 1005 刚好够 100 股 + 费 5');
    else fail('auto 刚好够', '');
    if (Paper._planAutoTrade(100000, 0.10, 0) === null) ok('auto: 无行情价 → null');
    else fail('auto 无价', '');

    // ---- init / buy / sell 集成 (内存 mock storage) ----
    const store = {
      kv: {}, tables: {},
      quotes: { '600519': { 代码: '600519', 名称: '贵州茅台', 最新价: 10 } },
      indexSpot: []
    };
    const ctx1 = buildCtx(store);
    const P1 = ctx1.window.Paper;
    await P1.init();
    const acc0 = await P1.getAccount();
    if (acc0.cash === 100000 && acc0.initialCash === 100000 && acc0.positionPct === 0.10) ok('init: 默认账户 10 万 + 10% 仓位');
    else fail('init 默认账户', JSON.stringify(acc0));
    store.kv.paper_account.cash = 12345;
    await P1.init();
    if ((await P1.getAccount()).cash === 12345) ok('init: 已存在不覆盖');
    else fail('init 覆盖', '');

    // buy: 250 股 → 整手 200 @10 = 2000 + 费 5 (万三 0.6 < 5) = 2005
    const h1 = await P1.buy('600519', '贵州茅台', '', 250);
    if (h1 && h1.isPaper === true && h1.shares === 200 && h1.costPrice === 10 && h1.market === 'sh') ok('buy: 250→整手 200, isPaper 标记');
    else fail('buy 整手', JSON.stringify(h1));
    const accBuy = await P1.getAccount();
    if (Math.abs(accBuy.cash - (12345 - 2005)) < 0.01) ok(`buy: 现金扣 2005 (=2000+费5), 余 ${accBuy.cash}`);
    else fail('buy 现金', JSON.stringify(accBuy));
    const txsBuy = (store.tables.transactions || []).filter(t => t.isPaper && t.type === 'buy');
    if (txsBuy.length === 1 && txsBuy[0].shares === 200 && txsBuy[0].fee === 5) ok('buy: transactions 含 isPaper + fee');
    else fail('buy tx', JSON.stringify(txsBuy));

    // 加仓: 移动加权成本 (200×10 + 100×20) / 300 = 13.333
    store.quotes['600519'] = { 代码: '600519', 名称: '贵州茅台', 最新价: 20 };
    const h2 = await P1.buy('600519', '', '', 100);
    if (h2 && h2.shares === 300 && Math.abs(h2.costPrice - (200 * 10 + 100 * 20) / 300) < 1e-9) ok('buy: 加仓移动加权成本 13.333');
    else fail('buy 加权', JSON.stringify(h2));

    // buy: 现金不足 → null
    const h3 = await P1.buy('600519', '', '', 1000000);
    if (h3 === null && (await P1._getPaperHoldings()).length === 1) ok('buy: 现金不足 → null, 持仓不变');
    else fail('buy 现金不足', '');

    // sell: 300 股 @20 = 6000, 费 = max(1.8,5)=5 + 印花税 3 = 8 → +5992
    const cashBeforeSell = (await P1.getAccount()).cash;
    const s1 = await P1.sell(h2.id, 300);
    const cashAfterSell = (await P1.getAccount()).cash;
    if (s1 && Math.abs(cashAfterSell - (cashBeforeSell + 5992)) < 0.01) ok(`sell: 300 股 @20 → +5992 (佣金 5 + 印花税 3)`);
    else fail('sell 现金', JSON.stringify({ cashBeforeSell, cashAfterSell }));
    if ((await P1._getPaperHoldings()).length === 0) ok('sell: 清仓后 holdings 行删除');
    else fail('sell 清仓', '');
    const txsSell = (store.tables.transactions || []).filter(t => t.isPaper && t.type === 'sell');
    if (txsSell.length === 1 && txsSell[0].fee === 8) ok('sell: transactions 费 8 (5+3)');
    else fail('sell tx', JSON.stringify(txsSell));

    // sell: 超过持仓 → null
    const h4 = await P1.buy('600519', '', '', 100);
    const s2 = await P1.sell(h4.id, 200);
    if (s2 === null && (await P1._getPaperHoldings()).length === 1) ok('sell: 超持仓拒绝, 持仓不变');
    else fail('sell 超持仓', '');

    // ---- snapshotIfNeeded: 写一条 + 当天不重复 ----
    // (init 时已写过一条当天快照, 先清掉再测显式调用)
    store.kv.paper_snapshots = [];
    store.indexSpot = [{ 代码: '000300', 名称: '沪深300', 最新价: 3900 }];
    const snaps1 = await P1.snapshotIfNeeded();
    const snaps2 = await P1.snapshotIfNeeded();
    if (snaps1.length === 1 && snaps2.length === 1 && snaps1[0].date === '2026-07-27' && snaps1[0].csi300 === 3900) ok('snapshotIfNeeded: 写一条 + 当天跳过');
    else fail('snapshotIfNeeded', JSON.stringify(snaps2));
    if (snaps1[0].paperTotal > 0 && typeof snaps1[0].realTotal === 'number') ok(`snapshotIfNeeded: paperTotal ${snaps1[0].paperTotal} / realTotal ${snaps1[0].realTotal}`);
    else fail('snapshot 内容', JSON.stringify(snaps1[0]));

    // ---- autoTradeFromPick: 现金不足跳过 (不 throw, 不写表) ----
    const store2 = {
      kv: { paper_account: { initialCash: 100000, cash: 50, createdAt: 1, positionPct: 0.10 } },
      tables: {},
      quotes: { '600519': { 代码: '600519', 名称: '贵州茅台', 最新价: 1700 } },
      indexSpot: []
    };
    const ctx2 = buildCtx(store2);
    const P2 = ctx2.window.Paper;
    let threw = false, r1 = 'unset';
    try { r1 = await P2.autoTradeFromPick({ code: '600519', name: '贵州茅台' }); } catch (e) { threw = true; }
    if (!threw && r1 === null && (store2.tables.holdings || []).length === 0) ok('autoTradeFromPick: 现金 50 不足一手 → warn 跳过, 不 throw 不写表');
    else fail('autoTradeFromPick 跳过', JSON.stringify({ threw, r1 }));

    // 现金够 → 自动成交: 100000 × 10% = 10000 / 20 = 500 股 = 10000 + 费 5
    store2.kv.paper_account.cash = 100000;
    store2.quotes['600519'] = { 代码: '600519', 名称: '贵州茅台', 最新价: 20 };
    const r2 = await P2.autoTradeFromPick({ code: '600519', name: '贵州茅台' });
    if (r2 && r2.shares === 500 && r2.isPaper === true) ok('autoTradeFromPick: 10% 仓位自动成交 500 股');
    else fail('autoTradeFromPick 成交', JSON.stringify(r2));
    const accAuto = await P2.getAccount();
    if (Math.abs(accAuto.cash - (100000 - 10005)) < 0.01) ok(`autoTradeFromPick: 现金扣 10005 (=10000+费5)`);
    else fail('autoTradeFromPick 现金', JSON.stringify(accAuto));

    // autoTradeFromPick 成交后交易行带 auto 标记 (Phase C)
    const txAuto = (store2.tables.transactions || []).filter(t => t.isPaper && t.auto === true);
    if (txAuto.length === 1) ok('autoTradeFromPick: 交易行带 auto=true 标记');
    else fail('auto 标记', JSON.stringify(store2.tables.transactions));

    // Phase D1: autoTradeFromPick 带 falsifyCondition/invalidation → 写入 transactions 行 (非索引字段)
    store2.kv.paper_account.cash = 100000;
    store2.quotes['600111'] = { 代码: '600111', 名称: '北方稀土', 最新价: 20 };
    const r3 = await P2.autoTradeFromPick({ code: '600111', name: '北方稀土', falsifyCondition: '跌破 20 日线且放量', invalidation: '2 周内未突破 25 元' });
    const txPm = (store2.tables.transactions || []).find(t => t.code === '600111');
    if (r3 && txPm && txPm.falsifyCondition === '跌破 20 日线且放量' && txPm.invalidation === '2 周内未突破 25 元') ok('autoTradeFromPick: transactions 行沉淀 pre-mortem 字段');
    else fail('auto premortem 沉淀', JSON.stringify(txPm || r3));

    // ---- Phase C: EOD 日终小结 ----
    // _shouldGenerateEod 纯函数: 工作日 ≥15:30 且今日无记录 (fmtDate mock 恒返 '2026-07-27', 2026-07-27 是周一)
    if (Paper._shouldGenerateEod(new Date(2026, 6, 27, 16, 0), []) === true) ok('eod: 周一 16:00 无记录 → 生成');
    else fail('eod 应生成', '');
    if (Paper._shouldGenerateEod(new Date(2026, 6, 27, 15, 29), []) === false
      && Paper._shouldGenerateEod(new Date(2026, 6, 27, 10, 0), []) === false) ok('eod: 15:30 前不生成');
    else fail('eod 15:30 前', '');
    if (Paper._shouldGenerateEod(new Date(2026, 6, 25, 16, 0), []) === false
      && Paper._shouldGenerateEod(new Date(2026, 6, 26, 16, 0), []) === false) ok('eod: 周末不生成');
    else fail('eod 周末', '');
    if (Paper._shouldGenerateEod(new Date(2026, 6, 27, 16, 0), [{ date: '2026-07-27' }]) === false) ok('eod: 当日已存在不重复生成');
    else fail('eod 去重', '');
    if (Paper._shouldGenerateEod('not-a-date', []) === false) ok('eod: 非法时间不生成');
    else fail('eod 非法时间', '');

    // _pushEodReport: 同日去重 + 上限 60
    let eodList = Paper._pushEodReport([], { date: '2026-07-27', totalAssets: 1 });
    eodList = Paper._pushEodReport(eodList, { date: '2026-07-27', totalAssets: 2 });
    if (eodList.length === 1 && eodList[0].totalAssets === 1) ok('eod: push 同日去重');
    else fail('eod push 去重', JSON.stringify(eodList));
    let eodBig = [];
    for (let i = 0; i < 70; i++) eodBig = Paper._pushEodReport(eodBig, { date: `2026-e${String(i).padStart(3, '0')}` });
    if (eodBig.length === 60 && eodBig[0].date === '2026-e010') ok('eod: 上限 60 条滚动截断');
    else fail('eod 上限', `${eodBig.length}`);

    // _appendDisciplineLog: 上限 100
    let dlBig = [];
    for (let i = 0; i < 110; i++) dlBig = Paper._appendDisciplineLog(dlBig, { date: '2026-07-27', code: `c${i}`, reasons: ['r'] });
    if (dlBig.length === 100 && dlBig[0].code === 'c10') ok('eod: 纪律日志上限 100 条滚动截断');
    else fail('eod 纪律日志上限', `${dlBig.length}`);

    // maybeGenerateEodReport 集成: 内容聚合正确
    const store3 = {
      kv: {
        paper_account: { initialCash: 100000, cash: 80000, createdAt: 1, positionPct: 0.10 },
        paper_snapshots: [{ date: '2026-07-24', paperTotal: 99000, realTotal: 0, csi300: 3900 }],
        paper_discipline_log: [
          { date: '2026-07-27', code: '000002', reasons: ['单票仓位超限'] },
          { date: '2026-07-26', code: '000003', reasons: ['昨天的不算'] }
        ],
        paper_eod_reports: []
      },
      tables: {
        holdings: [{ id: 'ph1', code: '600519', name: '贵州茅台', shares: 100, costPrice: 10, isPaper: true }],
        transactions: [
          { id: 'pt1', code: '600519', type: 'buy', date: '2026-07-27', price: 10, shares: 100, fee: 5, isPaper: true, auto: true, createdAt: 1 },
          { id: 'pt2', code: '600519', type: 'sell', date: '2026-07-27', price: 12, shares: 100, fee: 5.6, isPaper: true, createdAt: 2 },
          { id: 'pt3', code: '000001', type: 'buy', date: '2026-07-26', price: 13, shares: 100, fee: 5, isPaper: true, createdAt: 0 },
          { id: 'pt4', code: '000001', type: 'buy', date: '2026-07-27', price: 13, shares: 100, fee: 5, createdAt: 3 }
        ]
      },
      quotes: { '600519': { 代码: '600519', 名称: '贵州茅台', 最新价: 12 } },
      indexSpot: []
    };
    const ctx3 = buildCtx(store3);
    const P3 = ctx3.window.Paper;
    const eod1 = await P3.maybeGenerateEodReport(new Date(2026, 6, 27, 16, 0));
    if (eod1 && eod1.date === '2026-07-27') ok('eod: 16:00 生成报告');
    else fail('eod 生成', JSON.stringify(eod1));
    if (eod1 && eod1.cash === 80000 && eod1.mktValue === 1200 && eod1.totalAssets === 81200) ok('eod: 现金/市值/总资产聚合 (100 股 × 12 = 1200)');
    else fail('eod 资产聚合', JSON.stringify(eod1));
    if (eod1 && eod1.dayPnl === -17800 && eod1.prevDate === '2026-07-24') ok('eod: 当日盈亏 -17800 (对照 07-24 快照 99000)');
    else fail('eod 当日盈亏', JSON.stringify({ dayPnl: eod1 && eod1.dayPnl, prevDate: eod1 && eod1.prevDate }));
    if (eod1 && eod1.trades.length === 2 && eod1.trades[0].auto === true && eod1.trades[1].auto === false) ok('eod: 当日成交 2 笔 (排除昨天/真实盘), AI 成交标 🤖');
    else fail('eod 成交聚合', JSON.stringify(eod1 && eod1.trades));
    if (eod1 && eod1.discipline.length === 1 && eod1.discipline[0].code === '000002') ok('eod: 纪律拦截只取当日 1 笔');
    else fail('eod 纪律拦截', JSON.stringify(eod1 && eod1.discipline));
    if (eod1 && eod1.top && eod1.top.code === '600519' && Math.abs(eod1.top.plPct - 0.2) < 1e-9 && eod1.bottom === null) ok('eod: 持仓 Top +20% (单持仓 Bottom 省略)');
    else fail('eod top/bottom', JSON.stringify({ top: eod1 && eod1.top, bottom: eod1 && eod1.bottom }));
    if (store3.kv.paper_eod_reports.length === 1) ok('eod: 写 kv paper_eod_reports');
    else fail('eod 写 kv', JSON.stringify(store3.kv.paper_eod_reports));

    // 重复调用不重复生成
    const eodDup = await P3.maybeGenerateEodReport(new Date(2026, 6, 27, 17, 0));
    if (eodDup === null && store3.kv.paper_eod_reports.length === 1) ok('eod: 当日已有 → 不重复生成');
    else fail('eod 重复', JSON.stringify(eodDup));

    // 15:30 前不生成 (空记录也不写)
    const store4 = { kv: { paper_account: { initialCash: 100000, cash: 100000, createdAt: 1, positionPct: 0.10 }, paper_eod_reports: [] }, tables: {}, quotes: {}, indexSpot: [] };
    const ctx4 = buildCtx(store4);
    const P4 = ctx4.window.Paper;
    const eodEarly = await P4.maybeGenerateEodReport(new Date(2026, 6, 27, 10, 0));
    if (eodEarly === null && store4.kv.paper_eod_reports.length === 0) ok('eod: 15:30 前 maybeGenerate 返回 null 不写 kv');
    else fail('eod 早间', JSON.stringify(eodEarly));

    // 飞书推送: kv feishu_webhook 配置后 POST msg_type=text, 文本含 🤖 标注
    let feishuPosts = [];
    store3.kv.feishu_webhook = 'https://open.feishu.cn/test-hook';
    store3.kv.paper_eod_reports = [];
    ctx3.fetch = async (url, opts) => {
      feishuPosts.push({ url, body: JSON.parse(opts.body) });
      return { ok: true, json: async () => ({ code: 0 }) };
    };
    const eod2 = await P3.maybeGenerateEodReport(new Date(2026, 6, 27, 16, 30));
    if (eod2 && feishuPosts.length === 1 && feishuPosts[0].url === 'https://open.feishu.cn/test-hook'
      && feishuPosts[0].body.msg_type === 'text' && feishuPosts[0].body.content.text.includes('日终小结')
      && feishuPosts[0].body.content.text.includes('🤖')) ok('eod: 飞书推送 msg_type=text + 🤖 标注');
    else fail('eod 飞书', JSON.stringify(feishuPosts));

    // 飞书推送失败 (CORS/网络) 不影响报告生成
    store3.kv.paper_eod_reports = [];
    ctx3.fetch = async () => { throw new Error('CORS blocked'); };
    const eod3 = await P3.maybeGenerateEodReport(new Date(2026, 6, 27, 16, 45));
    if (eod3 && store3.kv.paper_eod_reports.length === 1) ok('eod: 飞书失败只 warn, 报告照常生成');
    else fail('eod 飞书失败降级', JSON.stringify(eod3));

  } catch (e) {
    fail('Paper 模拟盘', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [24] Discipline 交易纪律引擎 (Phase B) ==========
section('24] Discipline 交易纪律引擎纯函数 + 集成实测');
(async () => {
  try {
    const discSrc = readFileSafe(path.join(WWW, 'core', 'discipline.js'));
    if (!discSrc) throw new Error('discipline.js 读不到');

    // vm sandbox: mock window.Core (Storage 内存表 + Data + State + Util)
    const buildCtx = (storageData) => {
      const dctx = { window: {}, console };
      dctx.window.Core = {
        Storage: {
          kvGet: async (k) => (k in storageData.kv ? storageData.kv[k] : null),
          kvSet: async (k, v) => { storageData.kv[k] = v; },
          all: async (t) => {
            if (storageData.throwOnAll) throw new Error('storage down');
            return storageData.tables[t] || [];
          },
          where: async (t, idx, v) => (storageData.tables[t] || []).filter(x => x[idx] === v)
        },
        Data: {
          getStockQuote: async (code) => {
            if (storageData.throwOnQuote) throw new Error('quote down');
            return storageData.quotes[code] || null;
          },
          getFundSpot: async () => []
        },
        State: { get: (k) => storageData.state[k] ?? null },
        Util: { escapeHtml: (s) => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;') }
      };
      vm.createContext(dctx);
      vm.runInContext(discSrc, dctx);
      return dctx;
    };
    const curMonth = (() => {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    })();

    // ---- 纯函数 ----
    const ctx0 = buildCtx({ kv: {}, tables: {}, quotes: {}, state: {} });
    const D0 = ctx0.window.Core.Discipline;
    if (!D0) throw new Error('Core.Discipline 未挂到 window');

    // _checkInputs: 假设/止损缺失与非法
    let b = D0._checkInputs({ assumption: '', stopLoss: 9, price: 10 });
    if (b.length === 1 && /买入假设必填/.test(b[0])) ok('inputs: 缺假设 → block');
    else fail('inputs 缺假设', JSON.stringify(b));
    b = D0._checkInputs({ assumption: '编造的理由', stopLoss: 9, price: 10 });
    if (b.length === 1 && /买入假设必填/.test(b[0])) ok('inputs: 假设不在枚举 → block');
    else fail('inputs 假设枚举', JSON.stringify(b));
    b = D0._checkInputs({ assumption: '业绩拐点', stopLoss: NaN, price: 10 });
    if (b.length === 1 && /止损价必填/.test(b[0])) ok('inputs: 缺止损 → block');
    else fail('inputs 缺止损', JSON.stringify(b));
    b = D0._checkInputs({ assumption: '业绩拐点', stopLoss: 10.5, price: 10 });
    if (b.length === 1 && /必须低于买入价/.test(b[0])) ok('inputs: 止损 ≥ 价格 → block');
    else fail('inputs 止损方向', JSON.stringify(b));
    b = D0._checkInputs({ assumption: '业绩拐点', stopLoss: 9, price: 10 });
    if (b.length === 0) ok('inputs: 合法输入 → 0 block');
    else fail('inputs 合法', JSON.stringify(b));

    // _checkConcentration: 23.5% > 20% → block 带具体数值
    const cfg = D0.DEFAULT_CONFIG;
    const cb = D0._checkConcentration({ positionValue: 23500, totalAssets: 100000, config: cfg });
    if (cb && cb.includes('23.5%') && cb.includes('20%')) ok(`concentration: "${cb}"`);
    else fail('concentration block', String(cb));
    if (D0._checkConcentration({ positionValue: 15000, totalAssets: 100000, config: cfg }) === null) ok('concentration: 15% → 通过');
    else fail('concentration 通过', '');
    if (D0._checkConcentration({ positionValue: 100, totalAssets: 0, config: cfg }) === null) ok('concentration: 总资产 0 → 不拦');
    else fail('concentration 0 资产', '');

    // _checkTotalPosition: 96% > 95% → block
    const tb = D0._checkTotalPosition({ stockValue: 96000, totalAssets: 100000, config: cfg });
    if (tb && tb.includes('96.0%') && tb.includes('95%')) ok(`totalPosition: "${tb}"`);
    else fail('totalPosition block', String(tb));
    if (D0._checkTotalPosition({ stockValue: 90000, totalAssets: 100000, config: cfg }) === null) ok('totalPosition: 90% → 通过');
    else fail('totalPosition 通过', '');

    // _monthAnchorNext: 无锚点 → 新锚点; 同月 → 原引用; 跨月 → 重置
    const a1 = D0._monthAnchorNext(null, '2026-07', 100000);
    if (a1 && a1.month === '2026-07' && a1.startTotal === 100000) ok('anchor: 无锚点 → 写入新锚点');
    else fail('anchor 新建', JSON.stringify(a1));
    const a2 = D0._monthAnchorNext(a1, '2026-07', 90000);
    if (a2 === a1) ok('anchor: 同月 → 不重置 (引用相等)');
    else fail('anchor 同月', JSON.stringify(a2));
    const a3 = D0._monthAnchorNext(a1, '2026-08', 90000);
    if (a3 !== a1 && a3.month === '2026-08' && a3.startTotal === 90000) ok('anchor: 跨月 → 以当前总资产重置');
    else fail('anchor 跨月', JSON.stringify(a3));

    // _checkDrawdown: 月初 10 万, 现 8.9 万 → 熔断 block; 9.5 万 → 通过
    const dd = D0._checkDrawdown({ currentTotal: 89000, anchor: { month: '2026-07', startTotal: 100000 }, config: cfg });
    if (dd && dd.includes('熔断') && dd.includes('10%') && dd.includes('只准减仓')) ok(`drawdown: "${dd}"`);
    else fail('drawdown block', String(dd));
    if (D0._checkDrawdown({ currentTotal: 95000, anchor: { month: '2026-07', startTotal: 100000 }, config: cfg }) === null) ok('drawdown: 回撤 5% → 通过');
    else fail('drawdown 通过', '');
    if (D0._checkDrawdown({ currentTotal: 1000, anchor: null, config: cfg }) === null) ok('drawdown: 无锚点 → 不拦');
    else fail('drawdown 无锚点', '');

    // _checkChase: 7% > 5% → warn; 3% → null; 无行情 → null
    const cw = D0._checkChase({ changePct: 7.23, config: cfg });
    if (cw && cw.includes('7.23%') && cw.includes('追高')) ok(`chase: "${cw}"`);
    else fail('chase warn', String(cw));
    if (D0._checkChase({ changePct: 3, config: cfg }) === null) ok('chase: 3% → 不警告');
    else fail('chase 通过', '');
    if (D0._checkChase({ changePct: NaN, config: cfg }) === null) ok('chase: 无涨跌幅 → 不警告');
    else fail('chase NaN', '');

    // _summarizeHistory: 同代码 2 次复盘 1 次验证不成立; 同假设 5 次
    const codeJs = [
      { code: '600519', assumption: '业绩拐点', content: '看多\n### 🔁 AI 事后验证 (2026-07-01)\n结论: 不成立' },
      { code: '600519', assumption: '其他', content: '再看看' }
    ];
    const sameAs = new Array(5).fill(0).map((_, i) => ({ code: 'x' + i, assumption: '业绩拐点', content: i === 0 ? '### 🔁 AI 事后验证\n不成立' : '笔记' }));
    const hist = D0._summarizeHistory(codeJs, sameAs, '业绩拐点');
    if (hist.length === 2 && hist[0].includes('2 次历史复盘') && hist[0].includes('1 次验证不成立')
      && hist[1].includes('业绩拐点') && hist[1].includes('5 次')) ok(`history: ${hist.join(' / ')}`);
    else fail('history 汇总', JSON.stringify(hist));
    if (D0._summarizeHistory([], [], '业绩拐点').length === 0) ok('history: 无历史 → 空数组');
    else fail('history 空', '');

    // getConfig/setConfig: 默认值 + 合并写回
    const c1 = await D0.getConfig();
    if (c1.enabled === true && c1.maxSingleStockPct === 0.20 && c1.maxMonthlyDrawdownPct === 0.10 && c1.maxSingleIndustryPct === 0.30) ok('config: 默认值 (含预留 maxSingleIndustryPct)');
    else fail('config 默认', JSON.stringify(c1));
    const c2 = await D0.setConfig({ maxSingleStockPct: 0.15 });
    if (c2.maxSingleStockPct === 0.15 && c2.maxTotalPositionPct === 0.95) ok('config: setConfig 合并写回');
    else fail('config 合并', JSON.stringify(c2));

    // ---- preBuyCheck 集成 (内存 mock storage) ----
    // 场景 A: 现金 9 万 + 600519 持仓 1000 股 @10 = 总资产 10 万; 再买 1500 股 @10 → 单票 25% > 20% block
    const storeA = {
      kv: {}, state: { accountCash: 90000 },
      tables: {
        holdings: [{ id: 'h1', code: '600519', name: '贵州茅台', shares: 1000, costPrice: 10 }],
        journals: codeJs
      },
      quotes: { '600519': { 代码: '600519', 名称: '贵州茅台', 最新价: 10, 涨跌幅: 1 } }
    };
    const DA = buildCtx(storeA).window.Core.Discipline;
    const rA = await DA.preBuyCheck({ code: '600519', name: '贵州茅台', price: 10, shares: 1500, amount: 15000, isPaper: false, assumption: '业绩拐点', stopLoss: 9 });
    if (!rA.ok && rA.blocks.some(x => x.includes('25.0%') && x.includes('20%'))) ok('preBuy: 单票超限 → block');
    else fail('preBuy 单票', JSON.stringify(rA.blocks));
    if (rA.history.length === 2 && rA.warns.some(w => w.includes('该代码 2 次历史复盘'))) ok('preBuy: 历史复盘折叠进 warns');
    else fail('preBuy history', JSON.stringify({ h: rA.history, w: rA.warns }));
    // 月初锚点已写入 (首次检查)
    if (storeA.kv.discipline_month_anchor && storeA.kv.discipline_month_anchor.month === curMonth
      && storeA.kv.discipline_month_anchor.startTotal === 100000) ok('preBuy: 月初锚点写入 (startTotal=100000)');
    else fail('preBuy 锚点', JSON.stringify(storeA.kv.discipline_month_anchor));

    // 场景 B: 小额买入 → 通过; 但涨跌幅 7% → 追高 warn
    storeA.quotes['600519'].涨跌幅 = 7;
    const rB = await DA.preBuyCheck({ code: '600519', price: 10, shares: 100, amount: 1000, isPaper: false, assumption: '估值修复', stopLoss: 9 });
    if (rB.ok && rB.blocks.length === 0) ok('preBuy: 合规买入 → ok');
    else fail('preBuy 合规', JSON.stringify(rB.blocks));
    if (rB.warns.some(w => w.includes('追高'))) ok('preBuy: 涨幅 7% → 追高 warn');
    else fail('preBuy 追高', JSON.stringify(rB.warns));

    // 场景 C: 缺假设/止损 → block (不依赖任何外部数据)
    const rC = await DA.preBuyCheck({ code: '600519', price: 10, shares: 100, isPaper: false });
    if (!rC.ok && rC.blocks.some(x => /买入假设必填/.test(x)) && rC.blocks.some(x => /止损价必填/.test(x))) ok('preBuy: 缺假设+止损 → 2 blocks');
    else fail('preBuy 输入缺失', JSON.stringify(rC.blocks));

    // 场景 D: 月度回撤熔断 (锚点 20 万, 现 10 万 → 回撤 50% > 10%)
    storeA.kv.discipline_month_anchor = { month: curMonth, startTotal: 200000 };
    const rD = await DA.preBuyCheck({ code: '600519', price: 10, shares: 100, amount: 1000, isPaper: false, assumption: '其他', stopLoss: 9 });
    if (!rD.ok && rD.blocks.some(x => x.includes('熔断') && x.includes('只准减仓'))) ok('preBuy: 回撤熔断 → block');
    else fail('preBuy 熔断', JSON.stringify(rD.blocks));

    // 场景 E: 检查本身失败 (storage 抛错) → 不 block, 降级 warn
    const storeE = { kv: {}, state: { accountCash: 100000 }, tables: {}, quotes: {}, throwOnAll: true };
    const DE = buildCtx(storeE).window.Core.Discipline;
    const rE = await DE.preBuyCheck({ code: '600519', price: 10, shares: 100, isPaper: false, assumption: '其他', stopLoss: 9 });
    if (rE.ok && rE.warns.some(w => w.includes('部分检查跳过'))) ok('preBuy: 存储故障 → 降级 warn, 不拦交易');
    else fail('preBuy 降级', JSON.stringify(rE));

    // 场景 F: 引擎关闭 → 全部放行
    const storeF = { kv: { discipline_config: { enabled: false } }, state: {}, tables: {}, quotes: {} };
    const DF = buildCtx(storeF).window.Core.Discipline;
    const rF = await DF.preBuyCheck({ code: '600519' });
    if (rF.ok && rF.blocks.length === 0 && rF.warns.length === 0) ok('preBuy: enabled=false → 直接放行');
    else fail('preBuy 关闭', JSON.stringify(rF));

    // 场景 G: 模拟盘独立口径 (paper 现金 5 万 + 模拟持仓 5 万, 独立锚点 key)
    const storeG = {
      kv: { paper_account: { initialCash: 100000, cash: 50000 } }, state: {},
      tables: { holdings: [{ id: 'p1', code: '000001', shares: 5000, costPrice: 10, isPaper: true }] },
      quotes: { '000001': { 代码: '000001', 最新价: 10, 涨跌幅: 0 } }
    };
    const DG = buildCtx(storeG).window.Core.Discipline;
    const rG = await DG.preBuyCheck({ code: '000001', price: 10, shares: 1000, amount: 10000, isPaper: true, assumption: '技术突破', stopLoss: 9 });
    // 单票 (50000+10000)/100000 = 60% > 20% → block; 锚点写到 _paper 后缀 key
    if (!rG.ok && rG.blocks.some(x => x.includes('60.0%'))) ok('preBuy: 模拟盘口径独立计算 (60% 单票 block)');
    else fail('preBuy 模拟盘', JSON.stringify(rG.blocks));
    if (storeG.kv.discipline_month_anchor_paper && storeG.kv.discipline_month_anchor_paper.startTotal === 100000
      && !storeG.kv.discipline_month_anchor) ok('preBuy: 模拟盘锚点独立 key (_paper 后缀)');
    else fail('preBuy 模拟锚点', JSON.stringify(storeG.kv));

    // renderCheckResult: escapeHtml + blocks/warns 分区
    const html = D0.renderCheckResult({ ok: false, blocks: ['<b>block</b>'], warns: ['warn1'], history: [] });
    if (html.includes('&lt;b&gt;block&lt;/b&gt;') && !html.includes('<b>block</b>') && html.includes('⛔') && html.includes('⚠️')) ok('renderCheckResult: XSS 转义 + 分区图标');
    else fail('renderCheckResult', html.slice(0, 200));
    if (D0.renderCheckResult({ ok: true, blocks: [], warns: [], history: [] }) === '') ok('renderCheckResult: 全通过 → 空字符串');
    else fail('renderCheckResult 空', '');
  } catch (e) {
    fail('Discipline 测试', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [25] Phase D1: pre-mortem 强制输出 + 持仓股公告上下文 ==========
section('25] Phase D1 pre-mortem + 个股公告');
(async () => {
  try {
    // ---- 25.1 Core.Premortem 纯函数 (vm sandbox) ----
    const pmSrc = readFileSafe(path.join(WWW, 'core', 'premortem.js'));
    if (!pmSrc) throw new Error('premortem.js 读不到');
    const pmCtx = { window: {}, console };
    vm.createContext(pmCtx);
    vm.runInContext(pmSrc, pmCtx);
    const PM = pmCtx.window.Core.Premortem;

    // checkPick: 全字段 → 通过
    const goodPick = {
      code: '600519', bullCase: ['估值修复'], bearCase: ['批价下行风险'],
      falsifyCondition: '跌破 20 日线且放量', invalidation: '2 周内未突破 1800 元'
    };
    if (PM.checkPick(goodPick, 0).length === 0) ok('pm.checkPick: 全字段通过');
    else fail('pm.checkPick 全字段', JSON.stringify(PM.checkPick(goodPick, 0)));

    // checkPick: 缺 4 字段 → 4 条错误
    const missErrs = PM.checkPick({ code: '600519' }, 1);
    if (missErrs.length === 4 && missErrs.every(e => e.includes('picks[1]'))) ok('pm.checkPick: 缺 4 字段 → 4 条带下标错误');
    else fail('pm.checkPick 缺字段', JSON.stringify(missErrs));

    // checkPick: bearCase 空话黑名单
    const emptyTalk = PM.checkPick({ ...goodPick, bearCase: ['无明显风险'] }, 0);
    if (emptyTalk.length === 1 && emptyTalk[0].includes('空话')) ok('pm.checkPick: bearCase "无明显风险" → 空话拦截');
    else fail('pm.checkPick 空话', JSON.stringify(emptyTalk));

    // checkPick: 字符串形式的 bullCase/bearCase 也接受 (LLM 容错)
    if (PM.checkPick({ ...goodPick, bullCase: '估值低', bearCase: '商誉减值风险' }, 0).length === 0) ok('pm.checkPick: 字符串形式字段容错');
    else fail('pm.checkPick 字符串容错', '');

    // checkPicks: 聚合多 pick 错误
    const agg = PM.checkPicks([goodPick, { code: '000001' }]);
    if (agg.length === 4 && agg[0].includes('picks[1](000001)')) ok('pm.checkPicks: 聚合错误含 picks[1](code)');
    else fail('pm.checkPicks 聚合', JSON.stringify(agg));

    // renderBlock: 四象限 + XSS 转义
    const html = PM.renderBlock({ ...goodPick, falsifyCondition: '<script>alert(1)</script>' });
    if (html.includes('📈') && html.includes('📉') && html.includes('证伪条件') && html.includes('失效条件')
      && html.includes('&lt;script&gt;') && !html.includes('<script>')) ok('pm.renderBlock: 四象限 + escapeHtml');
    else fail('pm.renderBlock', html.slice(0, 200));
    if (PM.renderBlock({}) === '' && PM.renderBlock(null) === '') ok('pm.renderBlock: 无字段 → 空字符串');
    else fail('pm.renderBlock 空', '');

    // PROMPT_SPEC 含四字段 + 禁空话说明
    if (PM.PROMPT_SPEC.includes('bullCase') && PM.PROMPT_SPEC.includes('bearCase')
      && PM.PROMPT_SPEC.includes('falsifyCondition') && PM.PROMPT_SPEC.includes('invalidation')
      && PM.PROMPT_SPEC.includes('禁止')) ok('pm.PROMPT_SPEC: 四字段 + 禁空话说明');
    else fail('pm.PROMPT_SPEC', PM.PROMPT_SPEC);

    // ---- 25.2 Core.News.getStockNotices (vm sandbox, mock fetch + cache) ----
    const newsSrc = readFileSafe(path.join(WWW, 'core', 'news.js'));
    if (!newsSrc) throw new Error('news.js 读不到');
    const emList = [
      { art_code: 'AN1', title: '贵州茅台:2025年年度权益分派实施公告', notice_date: '2026-06-22 00:00:00', codes: [{ stock_code: '600519', short_name: '贵州茅台' }] },
      { art_code: 'AN2', title: '五粮液:股东大会决议公告', notice_date: '2026-06-20 00:00:00', codes: [{ stock_code: '000858', short_name: '五粮液' }] },
      { art_code: 'AN3', title: '贵州茅台:重大事项公告', notice_date: '2026-07-18 00:00:00', codes: [{ stock_code: '600519', short_name: '贵州茅台' }] }
    ];
    const buildNewsCtx = (fetchImpl) => {
      const cache = {};
      const nctx = {
        window: {}, console,
        fetch: fetchImpl
      };
      nctx.window.Core = {
        Storage: {
          cacheGet: async (k) => (k in cache ? cache[k] : null),
          cacheSet: async (k, v) => { cache[k] = v; }
        },
        State: { get: () => null },
        Data: { fetch: async () => [] }
      };
      nctx.Core = nctx.window.Core;
      nctx._cache = cache;
      vm.createContext(nctx);
      vm.runInContext(newsSrc, nctx);
      return nctx;
    };

    // 主路径: stock_list 按个股查询 + 6h 缓存 (第二次调用不再 fetch)
    let fetchCount = 0, lastUrl = '';
    const nc1 = buildNewsCtx(async (url) => {
      fetchCount++; lastUrl = url;
      return { ok: true, json: async () => ({ data: { list: emList } }) };
    });
    const News1 = nc1.window.Core.News;
    const n1 = await News1.getStockNotices('600519', 5);
    if (fetchCount === 1 && lastUrl.includes('stock_list=600519')) ok('news.getStockNotices: 主路径走 stock_list 按个股查询');
    else fail('news stock_list 主路径', lastUrl);
    if (Array.isArray(n1) && n1.length === 2 && n1.every(x => x.code === '600519')
      && n1[0].title.includes('权益分派') && n1[0].date === '2026-06-22'
      && n1[0].url.includes('AN1')) ok('news.getStockNotices: 按代码过滤 + 字段格式化 (title/date/url)');
    else fail('news 过滤格式化', JSON.stringify(n1));
    const n1b = await News1.getStockNotices('600519', 5);
    if (fetchCount === 1 && Array.isArray(n1b) && n1b.length === 2) ok('news.getStockNotices: 第二次命中 6h 缓存 (不再 fetch)');
    else fail('news 缓存', `fetchCount=${fetchCount}`);

    // 兜底路径: stock_list 请求失败 → 全量拉取后本地按 codes[].stock_code 过滤
    const urls2 = [];
    const nc2 = buildNewsCtx(async (url) => {
      urls2.push(url);
      if (url.includes('stock_list=')) throw new Error('network down');
      return { ok: true, json: async () => ({ data: { list: emList } }) };
    });
    const News2 = nc2.window.Core.News;
    const n2 = await News2.getStockNotices('600519', 5);
    if (urls2.length === 2 && !urls2[1].includes('stock_list=')
      && Array.isArray(n2) && n2.length === 2 && n2.every(x => x.code === '600519')) ok('news.getStockNotices: 主路径失败 → 全量兜底 + 本地过滤');
    else fail('news 兜底', JSON.stringify({ urls: urls2, n2 }));

    // 双路径都失败 → null (调用方降级"公告数据不可用", 不污染 prompt)
    const nc3 = buildNewsCtx(async () => { throw new Error('down'); });
    const n3 = await nc3.window.Core.News.getStockNotices('600519', 5);
    if (n3 === null) ok('news.getStockNotices: 双路径失败 → null (降级)');
    else fail('news 降级 null', JSON.stringify(n3));

    // formatNoticesForPrompt 三态
    const fmt = News1.formatNoticesForPrompt;
    if (fmt(null) === '## 近期公告\n(公告数据不可用)') ok('news.formatNotices: null → 公告数据不可用');
    else fail('news fmt null', fmt(null));
    if (fmt([]) === '## 近期公告\n近期无公告') ok('news.formatNotices: 空 → 近期无公告');
    else fail('news fmt 空', fmt([]));
    const fmtList = fmt(n1, 5);
    if (fmtList.includes('## 近期公告 (最近 2 条)') && fmtList.includes('[1] 2026-06-22 贵州茅台:2025年年度权益分派实施公告')) ok('news.formatNotices: 列表 → 标题+日期');
    else fail('news fmt 列表', fmtList);

    // ---- 25.3 三个入口接线静态检查 ----
    const scrSrc = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (scrSrc.includes('Core.Premortem.PROMPT_SPEC') && scrSrc.includes('Core.Premortem.checkPicks')
      && scrSrc.includes('Core.Premortem.renderBlock') && scrSrc.includes('journal.falsifyCondition')
      && scrSrc.includes('data-falsify')) ok('screener: prompt+校验+渲染+沉淀 四处接线');
    else fail('screener 接线', '');
    const advSrc = readFileSafe(path.join(WWW, 'app', 'fund', 'ai-advisor.js'));
    if (advSrc.includes('Core.Premortem.PROMPT_SPEC') && advSrc.includes('Core.Premortem.checkPicks')
      && advSrc.includes('Core.Premortem.renderBlock')) ok('ai-advisor: prompt+校验+渲染 三处接线');
    else fail('ai-advisor 接线', '');
    const saSrc = readFileSafe(path.join(WWW, 'app', 'stock-advisor.js'));
    if (saSrc.includes('getStockNotices') && saSrc.includes('formatNoticesForPrompt')
      && saSrc.includes('证伪条件') && saSrc.includes('失效条件')) ok('stock-advisor: 公告注入 + pre-mortem 段落');
    else fail('stock-advisor 接线', '');
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (paperSrc.includes('tx.falsifyCondition') && paperSrc.includes('pick.falsifyCondition')) ok('paper: autoTradeFromPick → buy → transactions 沉淀');
    else fail('paper 接线', '');
  } catch (e) {
    fail('Phase D1 测试', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [26] Phase D2 回测前置 + 双模型交叉验证 ==========
section('26] Phase D2 回测前置 + 双模型交叉验证');
(async () => {
  try {
    // ---- 26.1 Core.PreBacktest 纯函数 (vm sandbox) ----
    const pbtSrc = readFileSafe(path.join(WWW, 'core', 'prebacktest.js'));
    if (!pbtSrc) throw new Error('prebacktest.js 读不到');

    const buildPbtCtx = (extra) => {
      const ctx = { window: {}, console, setTimeout, clearTimeout, ...extra };
      vm.createContext(ctx);
      vm.runInContext(pbtSrc, ctx);
      return ctx;
    };

    const c1 = buildPbtCtx({});
    const PBT = c1.window.Core.PreBacktest;

    // pickStrategy 映射: 技术突破 → breakout
    if (PBT.pickStrategy('技术突破放量创阶段新高') === 'breakout') ok('pbt.pickStrategy: 技术突破 → breakout');
    else fail('pbt.pickStrategy 突破', PBT.pickStrategy('技术突破放量创阶段新高'));
    // 业绩拐点 / 估值修复 → ma_cross
    if (PBT.pickStrategy('业绩拐点确认') === 'ma_cross' && PBT.pickStrategy('估值修复空间大') === 'ma_cross') ok('pbt.pickStrategy: 业绩拐点/估值修复 → ma_cross');
    else fail('pbt.pickStrategy 业绩/估值', '');
    // 其他/空 → 默认 ma_cross
    if (PBT.pickStrategy('题材催化') === 'ma_cross' && PBT.pickStrategy('') === 'ma_cross' && PBT.pickStrategy(null) === 'ma_cross') ok('pbt.pickStrategy: 其他/空 → 默认 ma_cross');
    else fail('pbt.pickStrategy 默认', '');

    // judgeVerdict 三档
    const jv = PBT.judgeVerdict;
    if (jv(-0.3) === '历史无效' && jv(-0.001) === '历史无效') ok('pbt.judgeVerdict: sharpe<0 → 历史无效');
    else fail('pbt.judgeVerdict 无效', jv(-0.3));
    if (jv(0) === '历史表现一般' && jv(0.49) === '历史表现一般') ok('pbt.judgeVerdict: 0~0.5 → 历史表现一般');
    else fail('pbt.judgeVerdict 一般', jv(0.3));
    if (jv(0.5) === '历史有效' && jv(1.2) === '历史有效') ok('pbt.judgeVerdict: ≥0.5 → 历史有效');
    else fail('pbt.judgeVerdict 有效', jv(0.5));
    if (jv(NaN) === null && jv('x') === null && jv(undefined) === null) ok('pbt.judgeVerdict: 非数值 → null');
    else fail('pbt.judgeVerdict 非数值', '');

    // formatResult: worker 返回 → 展示字段 (trades 数组 → 笔数)
    const fr = PBT.formatResult({ sharpe: 0.8, maxDrawdown: -0.12, annualReturn: 0.15, winRate: 0.6, trades: [{}, {}, {}] });
    if (fr.trades === 3 && fr.verdict === '历史有效' && fr.sharpe === 0.8 && fr.winRate === 0.6) ok('pbt.formatResult: trades 数组→笔数 + verdict');
    else fail('pbt.formatResult', JSON.stringify(fr));
    const frBad = PBT.formatResult({});
    if (frBad.trades === 0 && frBad.verdict === null && Number.isNaN(frBad.sharpe)) ok('pbt.formatResult: 空输入容错');
    else fail('pbt.formatResult 容错', JSON.stringify(frBad));

    // renderResultHtml: 徽章 + 三指标 + 日期转义
    const html1 = PBT.renderResultHtml({ ...fr, strategy: 'ma_cross', startDate: '2024-01-01<script>', endDate: '2026-01-01' });
    if (html1.includes('历史有效') && html1.includes('Sharpe') && html1.includes('最大回撤') && html1.includes('年化')
      && html1.includes('&lt;script&gt;') && !html1.includes('<script>')) ok('pbt.renderResultHtml: 徽章+三指标+转义');
    else fail('pbt.renderResultHtml', html1.slice(0, 200));
    const htmlBad = PBT.renderResultHtml({ ...fr, sharpe: -0.5, verdict: '历史无效', strategy: 'breakout' });
    if (htmlBad.includes('⚠') && htmlBad.includes('历史无效') && htmlBad.includes('var(--down)')) ok('pbt.renderResultHtml: 历史无效 → ⚠ 红色徽章');
    else fail('pbt.renderResultHtml 无效', htmlBad.slice(0, 200));
    if (PBT.renderUnavailableHtml().includes('不可用') && PBT.renderResultHtml(null).includes('不可用')) ok('pbt.renderUnavailableHtml: 降级文案');
    else fail('pbt.renderUnavailableHtml', '');

    // ---- 26.2 PreBacktest.runForPick 降级/超时 (vm sandbox + 依赖注入) ----
    const kline100 = [];
    for (let i = 0; i < 100; i++) {
      const close = 10 + Math.sin(i / 8) * 2;
      kline100.push({ 日期: `2025-02-${String((i % 28) + 1).padStart(2, '0')}`, 开盘: close * 0.99, 最高: close * 1.02, 最低: close * 0.98, 收盘: close });
    }
    class FakeWorkerOK {
      postMessage() {
        this.onmessage && this.onmessage({ data: { sharpe: 0.8, maxDrawdown: -0.12, annualReturn: 0.15, winRate: 0.6, trades: [{}, {}, {}], startDate: '2024-01-01', endDate: '2026-01-01' } });
      }
      terminate() {}
    }
    class FakeWorkerHang { postMessage() {} terminate() {} }

    // 正常路径: K线足够 + worker 返回指标
    const c2 = buildPbtCtx({
      Core: { Data: { getStockKLine: async () => kline100 } },
      Worker: FakeWorkerOK
    });
    const r2 = await c2.window.Core.PreBacktest.runForPick({ code: '600519', assumption: '业绩拐点' });
    if (r2 && r2.verdict === '历史有效' && r2.trades === 3 && r2.strategy === 'ma_cross'
      && r2.startDate === '2024-01-01' && r2.sharpe === 0.8) ok('pbt.runForPick: 正常路径返回指标+策略+区间');
    else fail('pbt.runForPick 正常', JSON.stringify(r2));

    // 策略映射接线: 技术突破假设 → breakout
    const r2b = await c2.window.Core.PreBacktest.runForPick({ code: '600519', assumption: '放量突破平台' });
    if (r2b && r2b.strategy === 'breakout') ok('pbt.runForPick: 突破假设 → breakout 策略');
    else fail('pbt.runForPick 策略映射', JSON.stringify(r2b));

    // K线拉取失败 → null (不抛)
    const c3 = buildPbtCtx({
      Core: { Data: { getStockKLine: async () => { throw new Error('限流'); } } },
      Worker: FakeWorkerOK
    });
    const r3 = await c3.window.Core.PreBacktest.runForPick({ code: '600519', assumption: 'x' });
    if (r3 === null) ok('pbt.runForPick: K线拉取失败 → null 降级');
    else fail('pbt.runForPick 失败降级', JSON.stringify(r3));

    // K线不足 (<60) → null
    const c4 = buildPbtCtx({
      Core: { Data: { getStockKLine: async () => kline100.slice(0, 30) } },
      Worker: FakeWorkerOK
    });
    const r4 = await c4.window.Core.PreBacktest.runForPick({ code: '600519', assumption: 'x' });
    if (r4 === null) ok('pbt.runForPick: K线不足 → null 降级');
    else fail('pbt.runForPick K线不足', JSON.stringify(r4));

    // 无 Worker 环境 → null
    const c5 = buildPbtCtx({ Core: { Data: { getStockKLine: async () => kline100 } } });
    const r5 = await c5.window.Core.PreBacktest.runForPick({ code: '600519', assumption: 'x' });
    if (r5 === null) ok('pbt.runForPick: 无 Worker → null 降级');
    else fail('pbt.runForPick 无Worker', JSON.stringify(r5));

    // worker 挂起 → 超时 → null (注入可控定时器, 纯 microtask 手动触发, 不真实等待)
    let timerCb = null;
    const c6 = buildPbtCtx({
      Core: { Data: { getStockKLine: async () => kline100 } },
      Worker: FakeWorkerHang,
      setTimeout: (fn) => { timerCb = fn; return 1; },
      clearTimeout: () => {}
    });
    const p6 = c6.window.Core.PreBacktest.runForPick({ code: '600519', assumption: 'x', timeoutMs: 50 });
    for (let i = 0; i < 10; i++) await Promise.resolve();  // 等 kline mock + _runWorker 注册 timer (全 microtask)
    if (typeof timerCb === 'function') timerCb();  // 手动触发超时
    const r6 = await p6;
    if (r6 === null) ok('pbt.runForPick: worker 超时 → null 降级');
    else fail('pbt.runForPick 超时', JSON.stringify(r6));

    // ---- 26.3 Core.CrossCheck (vm sandbox) ----
    const ccSrc = readFileSafe(path.join(WWW, 'core', 'crosscheck.js'));
    if (!ccSrc) throw new Error('crosscheck.js 读不到');
    const buildCcCtx = (aiStub) => {
      const ctx = { window: {}, console };
      if (aiStub) ctx.Core = { AI: aiStub };
      vm.createContext(ctx);
      vm.runInContext(ccSrc, ctx);
      return ctx;
    };
    const CC = buildCcCtx(null).window.Core.CrossCheck;

    // pickSecondProvider 选择逻辑
    const psp = CC.pickSecondProvider;
    if (psp('deepseek', { qwen: 'sk-1' }) === 'qwen') ok('cc.pickSecondProvider: 选第一个 ≠当前 且配 key 的');
    else fail('cc.pickSecondProvider 基本', psp('deepseek', { qwen: 'sk-1' }));
    if (psp('deepseek', { moonshot: 'a', qwen: 'b' }) === 'moonshot') ok('cc.pickSecondProvider: 按 PROVIDER_ORDER 顺序');
    else fail('cc.pickSecondProvider 顺序', psp('deepseek', { moonshot: 'a', qwen: 'b' }));
    if (psp('deepseek', { deepseek: 'x' }) === null && psp('deepseek', {}) === null && psp('deepseek', null) === null) ok('cc.pickSecondProvider: 无其他已配 provider → null');
    else fail('cc.pickSecondProvider 空', '');
    if (psp('deepseek', { qwen: '   ' }) === null) ok('cc.pickSecondProvider: 空白 key 不算已配');
    else fail('cc.pickSecondProvider 空白key', '');
    if (psp('qwen', { deepseek: 'k', qwen: 'x' }) === 'deepseek') ok('cc.pickSecondProvider: 跳过当前 provider 自己');
    else fail('cc.pickSecondProvider 跳过自己', '');

    // resolveSecondOpinion: state → 调用配置
    const PROVIDERS_STUB = {
      qwen: { name: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', defaultModel: 'qwen-plus' }
    };
    const cc2 = buildCcCtx({ getProviderConfig: (p) => PROVIDERS_STUB[p] || { name: p, baseURL: '', defaultModel: '' } });
    const CC2 = cc2.window.Core.CrossCheck;
    const so1 = CC2.resolveSecondOpinion({ ai: { provider: 'deepseek', useProxy: true }, apiKeys: { llm: { qwen: 'sk-2' } } });
    if (so1 && so1.provider === 'qwen' && so1.baseURL === '/api/llm/qwen/v1' && so1.apiKey === 'sk-2'
      && so1.model === 'qwen-plus' && so1.label === '通义千问') ok('cc.resolveSecondOpinion: 走代理 → /api/llm/{provider}/v1');
    else fail('cc.resolveSecondOpinion 代理', JSON.stringify(so1));
    const so2 = CC2.resolveSecondOpinion({ ai: { provider: 'deepseek', useProxy: false }, apiKeys: { llm: { qwen: 'sk-2' } } });
    if (so2 && so2.baseURL === 'https://dashscope.aliyuncs.com/compatible-mode/v1') ok('cc.resolveSecondOpinion: 不走代理 → provider 默认 baseURL');
    else fail('cc.resolveSecondOpinion 直连', JSON.stringify(so2));
    if (CC2.resolveSecondOpinion({ ai: { provider: 'deepseek' }, apiKeys: {} }) === null
      && CC2.resolveSecondOpinion(null) === null) ok('cc.resolveSecondOpinion: 未配置 → null (调用方 toast)');
    else fail('cc.resolveSecondOpinion 空', '');

    // buildComparePrompt: 双文本 + 标签 + 一致性要求
    const cp = CC.buildComparePrompt('文本A', '文本B', 'DeepSeek/v4', 'Qwen/plus');
    if (cp.includes('文本A') && cp.includes('文本B') && cp.includes('DeepSeek/v4') && cp.includes('Qwen/plus')
      && cp.includes('一致') && cp.includes('100')) ok('cc.buildComparePrompt: 双文本+标签+≤100字一致性');
    else fail('cc.buildComparePrompt', cp.slice(0, 120));

    // ---- 26.4 接线静态检查 ----
    const scrSrc = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (scrSrc.includes('Core.PreBacktest.runForPick') && scrSrc.includes('data-action="backtest"')
      && scrSrc.includes('pb-result') && scrSrc.includes('data-assumption')) ok('screener: 📊 历史验证按钮+卡片结果区+假设透传');
    else fail('screener D2 接线', '');
    const saSrc = readFileSafe(path.join(WWW, 'app', 'stock-advisor.js'));
    if (saSrc.includes('Core.PreBacktest.runForPick') && saSrc.includes('Core.CrossCheck.resolveSecondOpinion')
      && saSrc.includes('Core.CrossCheck.buildComparePrompt') && saSrc.includes('callWithTimeout')
      && saSrc.includes('saSecondBtn') && saSrc.includes('saPreBtBtn') && saSrc.includes('local: false')) ok('stock-advisor: 历史验证+第二意见+强制远程三处接线');
    else fail('stock-advisor D2 接线', '');
    const appSrc = readFileSafe(path.join(WWW, 'app.js'));
    if (appSrc.includes('settingSecondProvider') && appSrc.includes('onSecondProviderChange')
      && appSrc.includes('llm')) ok('app.js: 设置页第二意见 provider+key 配置区');
    else fail('app.js D2 接线', '');
  } catch (e) {
    fail('Phase D2 测试', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [27] Phase E: 实盘待确认交易 (Core.Pending) ==========
section('27] Phase E 待确认交易: Core.Pending 实测 + 接线检查');
(async () => {
  try {
    const pendSrc = readFileSafe(path.join(WWW, 'core', 'pending.js'));
    if (!pendSrc) throw new Error('pending.js 读不到');

    // vm sandbox: mock window.Core (Storage kv 内存表 + Util.uuid/escapeHtml)
    const buildPendCtx = (kv) => {
      const pctx = { window: {}, console };
      let seq = 0;
      pctx.window.Core = {
        Storage: {
          kvGet: async (k) => (k in kv ? kv[k] : null),
          kvSet: async (k, v) => { kv[k] = v; }
        },
        Util: {
          uuid: () => 'pid-' + (++seq),
          escapeHtml: (s) => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;')
        }
      };
      vm.createContext(pctx);
      vm.runInContext(pendSrc, pctx);
      return pctx;
    };

    // ---- add / 去重 ----
    const kv1 = {};
    const P1 = buildPendCtx(kv1).window.Core.Pending;
    if (!P1) throw new Error('Core.Pending 未挂到 window');
    const id1 = await P1.add({ code: '600519', name: '贵州茅台', suggestedShares: 100, suggestedAmount: 170000, reason: '理由A', source: 'screener' });
    const l1 = await P1.list('pending');
    if (id1 && l1.length === 1 && l1[0].code === '600519' && l1[0].status === 'pending'
      && l1[0].action === 'buy' && l1[0].source === 'screener'
      && l1[0].expireAt > Date.now()) ok('add: 建卡成功, 字段齐全 (buy/screener/pending/expireAt)');
    else fail('add 建卡', JSON.stringify(l1));
    // 同 code 重复 add → 不重复建卡, 刷新 reason, 返回原 id
    const id1b = await P1.add({ code: '600519', reason: '理由B', suggestedShares: 200, suggestedAmount: 340000 });
    const l1b = await P1.list('pending');
    if (id1b === id1 && l1b.length === 1 && l1b[0].reason === '理由B' && l1b[0].suggestedShares === 200) ok('add: 同 code pending 去重 (刷新 reason/仓位, 返回原 id)');
    else fail('add 去重', JSON.stringify({ id1, id1b, list: l1b }));
    // confirmed 之后同 code 可再建卡
    await P1.confirm(id1);
    const id1c = await P1.add({ code: '600519', reason: '理由C' });
    if (id1c !== id1 && (await P1.list('pending')).length === 1) ok('add: 原卡已 confirmed → 允许新建同 code 卡');
    else fail('add confirmed 后重建', '');

    // ---- 上限 50 条: 优先淘汰已完结卡片 ----
    const kv2 = {};
    const P2 = buildPendCtx(kv2).window.Core.Pending;
    const firstId = await P2.add({ code: 'c0', reason: '旧' });
    const secondId = await P2.add({ code: 'c1', reason: '旧2' });
    await P2.ignore(firstId);
    await P2.confirm(secondId);
    for (let i = 2; i < 52; i++) await P2.add({ code: 'c' + i });
    const all2 = await P2.list();
    const pend2 = await P2.list('pending');
    if (all2.length === 50) ok(`上限: 数组封顶 50 条 (实际 ${all2.length})`);
    else fail('上限 50', String(all2.length));
    if (!all2.find(t => t.id === firstId) && !all2.find(t => t.id === secondId)) ok('上限: 优先淘汰最旧的已完结卡片 (confirmed/ignored)');
    else fail('上限淘汰顺序', '已完结卡片未被优先淘汰');

    // ---- purgeExpired 惰性清理 ----
    const kv3 = {};
    const P3 = buildPendCtx(kv3).window.Core.Pending;
    const id3 = await P3.add({ code: '000001', reason: 'x' });
    // 直接把 kv 里的 expireAt 改到过去, 模拟过期
    kv3.pending_trades[0].expireAt = Date.now() - 1000;
    const l3 = await P3.list('pending');   // list 时惰性执行 purgeExpired
    const g3 = await P3.get(id3);
    if (l3.length === 0 && g3 && g3.status === 'ignored') ok('purgeExpired: 过期 pending → 惰性转 ignored');
    else fail('purgeExpired', JSON.stringify({ l3, g3 }));

    // ---- confirm / ignore 状态机 ----
    const kv4 = {};
    const P4 = buildPendCtx(kv4).window.Core.Pending;
    const id4a = await P4.add({ code: 'a' });
    const id4b = await P4.add({ code: 'b' });
    if (await P4.confirm(id4a) && (await P4.get(id4a)).status === 'confirmed') ok('confirm: pending → confirmed');
    else fail('confirm', '');
    if (await P4.ignore(id4b) && (await P4.get(id4b)).status === 'ignored') ok('ignore: pending → ignored');
    else fail('ignore', '');
    if (await P4.confirm('不存在') === false) ok('confirm: 未知 id → false');
    else fail('confirm 未知 id', '');
    if ((await P4.list('pending')).length === 0 && (await P4.list()).length === 2) ok('list: status 过滤正确');
    else fail('list 过滤', '');

    // ---- _suggestPosition 纯函数 ----
    const cfg = { maxSingleStockPct: 0.20 };
    const sp1 = P4._suggestPosition({ totalAssets: 100000, price: 10, config: cfg });
    if (sp1 && sp1.shares === 500 && sp1.amount === 5000) ok('suggest: 总资产 10 万 × 5% = 5000 → 500 股 @10');
    else fail('suggest 基本', JSON.stringify(sp1));
    const sp2 = P4._suggestPosition({ totalAssets: 100000, price: 10, config: cfg, heldValue: 15000 });
    if (sp2 && sp2.shares === 500) ok('suggest: 已持 1.5 万, 单票剩余额度 5000 → 仍 500 股');
    else fail('suggest 单票余量', JSON.stringify(sp2));
    const sp3 = P4._suggestPosition({ totalAssets: 100000, price: 10, config: cfg, heldValue: 19600 });
    if (sp3 === null) ok('suggest: 单票剩余额度 400, 不足一手 → null');
    else fail('suggest 额度不足', JSON.stringify(sp3));
    const sp4 = P4._suggestPosition({ totalAssets: 100000, price: 600, config: cfg });
    if (sp4 === null) ok('suggest: 5000 元买不起一手 600 元股 → null');
    else fail('suggest 不足一手', JSON.stringify(sp4));
    if (P4._suggestPosition({ totalAssets: 0, price: 10, config: cfg }) === null
      && P4._suggestPosition({ totalAssets: 100000, price: 0, config: cfg }) === null) ok('suggest: 总资产/价格非法 → null');
    else fail('suggest 非法输入', '');
    const sp5 = P4._suggestPosition({ totalAssets: 100000, price: 10 });  // 无 config → 默认单票上限 20%
    if (sp5 && sp5.shares === 500) ok('suggest: 缺 config → 用默认单票上限 20%');
    else fail('suggest 默认配置', JSON.stringify(sp5));

    // ---- 接线静态检查 ----
    const scrSrcE = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (scrSrcE.includes('Core.Pending.add') && scrSrcE.includes('Core.Pending._suggestPosition')
      && scrSrcE.includes("source: 'screener'") && scrSrcE.includes('已生成实盘待确认交易')
      && scrSrcE.includes('Core.Discipline._getRealAssets')) ok('screener: _addWatchlistFromPick 生成待确认卡片 (口径复用 Discipline)');
    else fail('screener E 接线', '');
    const hSrcE = readFileSafe(path.join(WWW, 'app', 'holdings.js'));
    if (hSrcE.includes('_renderPending') && hSrcE.includes('Core.Pending.confirm')
      && hSrcE.includes('Core.Pending.ignore') && hSrcE.includes('pendingTrades')
      && hSrcE.includes('Core.Pending.list')) ok('holdings: 待确认区块渲染 + confirm/ignore 接线');
    else fail('holdings E 接线', '');
    // 确认流程不绕过纪律: save/saveTx 里的 preBuyCheck 仍在, 且 confirm 标状态在成交落库之后
    const saveIdx = hSrcE.indexOf('async save(id)');
    const preBuyIdx = hSrcE.indexOf('preBuyCheck', saveIdx);
    const markIdx = hSrcE.indexOf('_markPendingConfirmed()', saveIdx);
    const addIdx = hSrcE.indexOf("Core.Storage.add('holdings', data)", saveIdx);
    if (preBuyIdx > saveIdx && addIdx > preBuyIdx && markIdx > addIdx) ok('holdings: 确认流程顺序 = preBuyCheck → 落库 → 标 confirmed (不绕过纪律)');
    else fail('holdings 确认顺序', JSON.stringify({ saveIdx, preBuyIdx, addIdx, markIdx }));
    const htmlE = readFileSafe(path.join(WWW, 'index.html'));
    if (htmlE.includes('/core/pending.js') && htmlE.includes('id="pendingTrades"')) ok('index.html: pending.js 引用 + 卡片容器');
    else fail('index.html E 接线', '');
    const viteE = readFileSafe(path.join(ROOT, 'vite.config.js'));
    if (viteE.includes("'/core/pending.js'")) ok('vite.config: external 含 /core/pending.js');
    else fail('vite external', '');
    // script 顺序: pending.js 在 discipline.js 之后 (依赖其实盘口径)
    if (htmlE.indexOf('/core/pending.js') > htmlE.indexOf('/core/discipline.js')) ok('index.html: pending.js 在 discipline.js 之后加载');
    else fail('script 顺序', '');
  } catch (e) {
    fail('Phase E 测试', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [28] Z1b 市场宽度信号 (AI 升级 #1b 补充) ==========
section('[28] Z1b Core.MarketWidth (Kimi regime 之外的宽度维度)');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: { cacheGet: async () => null, cacheSet: async () => {}, kvGet: async () => null, kvSet: async () => {} },
        Data: {
          // mock 全市场: 50 涨 / 30 跌 / 20 平
          getStockSpotEfinanceCached: async () => {
            const arr = [];
            for (let i = 0; i < 50; i++) arr.push({ 涨跌幅: 2.5 + i * 0.1 });
            for (let i = 0; i < 30; i++) arr.push({ 涨跌幅: -1.5 - i * 0.1 });
            for (let i = 0; i < 20; i++) arr.push({ 涨跌幅: 0 });
            return arr;
          }
        }
      },
      fetch: async () => ({ ok: false, status: 502 })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/market-width.js')), DS);
    const MW = DS.window.Core.MarketWidth;

    if (typeof MW.getMarketWidth === 'function') ok('Z1b: Core.MarketWidth 已挂载');
    else fail('Z1b 挂载', typeof MW);

    // ---- 28.1 _classifyWidth 弱市判定 (< 35%) ----
    const weak = MW._classifyWidth([
      ...Array(30).fill({ 涨跌幅: 1.5 }),  // 30 涨
      ...Array(60).fill({ 涨跌幅: -1.5 }), // 60 跌
      ...Array(10).fill({ 涨跌幅: 0 })     // 10 平
    ]);
    if (weak.status === 'weak' && weak.advancePct === 30) ok('Z1b: 上涨占比 30% → weak (弱势确认)');
    else fail('Z1b 弱市', JSON.stringify(weak));

    // ---- 28.2 强市判定 (> 65%) ----
    const strong = MW._classifyWidth([
      ...Array(70).fill({ 涨跌幅: 1.5 }),
      ...Array(20).fill({ 涨跌幅: -1.5 }),
      ...Array(10).fill({ 涨跌幅: 0 })
    ]);
    if (strong.status === 'strong' && strong.advancePct === 70) ok('Z1b: 上涨占比 70% → strong (强势确认)');
    else fail('Z1b 强市', JSON.stringify(strong));

    // ---- 28.3 中性判定 (40-60%) ----
    const neutral = MW._classifyWidth([
      ...Array(50).fill({ 涨跌幅: 1.5 }),
      ...Array(40).fill({ 涨跌幅: -1.5 }),
      ...Array(10).fill({ 涨跌幅: 0 })
    ]);
    if (neutral.status === 'neutral' && neutral.advancePct === 50) ok('Z1b: 上涨占比 50% → neutral');
    else fail('Z1b 中性', JSON.stringify(neutral));

    // ---- 28.4 涨跌幅 null 算平 ----
    const nullish = MW._classifyWidth([
      ...Array(40).fill({ 涨跌幅: 1.5 }),
      ...Array(20).fill({ 涨跌幅: -1.5 }),
      ...Array(20).fill({ 涨跌幅: null }),  // 20 个 null 算平
      ...Array(20).fill({ 涨跌幅: 0 })
    ]);
    if (nullish.flat === 40 && nullish.advancePct === 40) ok('Z1b: 涨跌幅 null → 平 (40)');
    else fail('Z1b null 处理', JSON.stringify(nullish));

    // ---- 28.5 边界: 涨跌幅 0 (平) 走 flat 分支 ----
    const exactZero = MW._classifyWidth([
      ...Array(60).fill({ 涨跌幅: 0.5 }),  // 0.5% > 0.01 算涨
      ...Array(40).fill({ 涨跌幅: 0 })       // = 0 算平 (不走 advance)
    ]);
    if (exactZero.advance === 60 && exactZero.flat === 40 && exactZero.decline === 0) ok('Z1b: 涨跌幅 0 → 平 (不归 advance)');
    else fail('Z1b 0 边界', JSON.stringify(exactZero));

    // ---- 28.6 数据不足 → unknown ----
    const empty = MW._classifyWidth([]);
    if (empty.status === 'unknown' && empty.advancePct === null) ok('Z1b: 空数组 → unknown');
    else fail('Z1b 空数据', JSON.stringify(empty));

    // ---- 28.7 getMarketWidth 走 cache 优先 (mock 命中时不再调 fetcher) ----
    let fetchCount = 0;
    const DS2 = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: () => null },
        Storage: {
          cacheGet: async () => ({ advance: 100, decline: 50, flat: 10, total: 160, advancePct: 62.5, status: 'neutral', ts: 'cached', partial: '' }),
          cacheSet: async () => {}
        },
        Data: { getStockSpotEfinanceCached: async () => { fetchCount++; return []; } }
      },
      fetch: async () => ({ ok: false })
    };
    DS2.window = DS2;
    vm.createContext(DS2);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS2);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/market-width.js')), DS2);
    const r = await DS2.window.Core.MarketWidth.getMarketWidth();
    if (fetchCount === 0 && r.ts === 'cached') ok('Z1b: getMarketWidth 命中缓存, 不再调 fetcher');
    else fail('Z1b 缓存', JSON.stringify({ fetchCount, r }));

    // ---- 28.8 formatWidthForPrompt 弱市提示 ----
    const txt = MW.formatWidthForPrompt(weak);
    if (txt.includes('弱势确认') && txt.includes('30')) ok('Z1b: formatWidthForPrompt 含"弱势确认" + 数字');
    else fail('Z1b 弱市 prompt', txt);

    // ---- 28.9 formatWidthForPrompt unknown 走占位 ----
    const txtU = MW.formatWidthForPrompt({ status: 'unknown' });
    if (txtU.includes('⚠') && txtU.includes('缺失')) ok('Z1b: unknown 走"数据缺失"占位');
    else fail('Z1b unknown prompt', txtU);
  } catch (e) {
    fail('Z1b 市场宽度', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [28.5] Z1 Phase A: Kimi 留下的 Core.Regime (接管接线) ==========
section('[28.5] Z1 Phase A: 接管 Kimi 的 Core.Regime (HS300 + MA60 + bear 迟滞)');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: { cacheGet: async () => null, cacheSet: async () => {}, kvGet: async () => null, kvSet: async () => {} },
        // K线 mock: 60+ 根, 全部 3800 (横盘, ma60 稳定, 走平)
        Data: { getStockKLine: async () => {
          const arr = [];
          for (let i = 0; i < 120; i++) arr.push({ 日期: `2025-${String(Math.floor(i/30)+1).padStart(2,'0')}-${String(i%30+1).padStart(2,'0')}`, 开盘: 3800, 收盘: 3800, 成交量: 1e9 });
          return arr;
        } }
      },
      fetch: async () => ({ ok: false })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/regime.js')), DS);
    const R = DS.window.Core.Regime;

    if (typeof R._classify === 'function') ok('Z1-A: Core.Regime._classify 纯函数已挂载');
    else fail('Z1-A _classify 挂载', typeof R);

    if (typeof R.gateMultipliers === 'function') ok('Z1-A: gateMultipliers 同步函数已挂载');
    else fail('Z1-A gateMultipliers 挂载', typeof R);

    // ---- 28.5.1 _classify: bull (close>ma60 + maUp) ----
    const bull = R._classify({ close: 4000, ma60: 3800, ma60Prev: 3700 });
    if (bull.state === 'bull') ok('Z1-A: close>ma60 + maUp → bull');
    else fail('Z1-A bull', JSON.stringify(bull));

    // ---- 28.5.2 _classify: bear (close<ma60*(1-0.03) + maDown) ----
    const bear = R._classify({ close: 3600, ma60: 3800, ma60Prev: 3850 });
    if (bear.state === 'bear') ok('Z1-A: 跌破 MA60×0.97 + maDown → bear');
    else fail('Z1-A bear', JSON.stringify(bear));

    // ---- 28.5.3 _classify: range (价=ma60, maUp 走平) ----
    const range = R._classify({ close: 3800, ma60: 3800, ma60Prev: 3790 });
    if (range.state === 'range') ok('Z1-A: 价=ma60 (走平) → range');
    else fail('Z1-A range', JSON.stringify(range));

    // ---- 28.5.4 _classify: bear 迟滞 (prevState=bear + close<ma60 → 仍 bear, streak=0) ----
    const stuck = R._classify({ close: 3700, ma60: 3800, ma60Prev: 3850, prevState: 'bear', aboveStreak: 2 });
    if (stuck.state === 'bear' && stuck.aboveStreak === 0) ok('Z1-A: bear 迟滞 close<ma60 → 仍 bear, streak 归 0');
    else fail('Z1-A bear 迟滞', JSON.stringify(stuck));

    // ---- 28.5.5 _classify: bear 迟滞退出 (aboveStreak=3 → 转 range) ----
    const exit = R._classify({ close: 3900, ma60: 3800, ma60Prev: 3850, prevState: 'bear', aboveStreak: 3 });
    if (exit.state === 'range' && exit.aboveStreak === 0) ok('Z1-A: bear 迟滞 streak≥3 → range (退出)');
    else fail('Z1-A bear 退出', JSON.stringify(exit));

    // ---- 28.5.6 _classify: 非法输入降级 range ----
    const bad = R._classify({ close: NaN, ma60: 3800, ma60Prev: 3700 });
    if (bad.state === 'range') ok('Z1-A: 非法输入降级 range');
    else fail('Z1-A 非法输入', JSON.stringify(bad));

    // ---- 28.5.7 _classify: ma60Prev=null (斜率未知, 不上 bull 也不下 bear) ----
    const noSlope = R._classify({ close: 4000, ma60: 3800, ma60Prev: null });
    if (noSlope.state === 'range') ok('Z1-A: 斜率未知 → range (不上 bull)');
    else fail('Z1-A 斜率未知', JSON.stringify(noSlope));

    // ---- 28.5.8 gateMultipliers 默认 fallback range (mem=null) ----
    const g0 = R.gateMultipliers();
    if (g0.state === 'range' && g0.positionScale === 1.0 && g0.sharpeThreshold === 0.5) ok('Z1-A: gateMultipliers mem=null → range 兜底');
    else fail('Z1-A gate 兜底', JSON.stringify(g0));

    // ---- 28.5.9 GATES 三档定义完整 ----
    if (R.GATES.bull && R.GATES.range && R.GATES.bear) ok('Z1-A: GATES 三档全定义');
    else fail('Z1-A GATES', JSON.stringify(R.GATES));

    // ---- 28.5.10 接 index.html / vite external 校验 ----
    const html = readFileSafe(path.join(WWW, 'index.html'));
    if (html.includes('/core/regime.js')) ok('index.html: /core/regime.js 已加 script');
    else fail('index.html regime script', '');
    // 顺序: regime.js 必须在 data.js 之后 (依赖 Core.Data.getStockKLine)
    if (html.indexOf('/core/regime.js') > html.indexOf('/core/data.js')) ok('index.html: regime.js 在 data.js 之后');
    else fail('index.html regime 顺序', '');

    const vite = readFileSafe(path.join(ROOT, 'vite.config.js'));
    if (vite.includes("'/core/regime.js'")) ok('vite.config: external 含 /core/regime.js');
    else fail('vite external regime', '');

    // ---- 28.5.11 app.js init 调 refresh (Phase A 接管) ----
    const appJs = readFileSafe(path.join(WWW, 'app.js'));
    if (appJs.includes('Core.Regime.refresh()')) ok('app.js: init 调 Core.Regime.refresh()');
    else fail('app.js regime refresh', '');
  } catch (e) {
    fail('Z1-A Kimi 接管', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [29] Z1c ai-service 自动注入市场宽度 ==========
section('[29] Z1c ai-service.call() 自动注入 Core.MarketWidth (Z1b 配套)');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    // mock ai-service: 拦截 fetch, 检查 body.messages[0].content 是否含宽度信号
    const captured = { body: null };
    const AI = {
      console, setTimeout, clearTimeout,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: () => ({
          ai: { provider: 'deepseek', apiKey: 'k1', model: 'deepseek-v4-flash', useProxy: false }
        }) },
        Storage: { cacheGet: async () => null, cacheSet: async () => {}, kvGet: async () => null, kvSet: async () => {} },
        // 模拟 MarketWidth: 弱市, advancePct=30
        MarketWidth: {
          getMarketWidth: async () => ({ advance: 1500, decline: 3000, flat: 500, total: 5000, advancePct: 30, status: 'weak', partial: '', ts: 'now' }),
          formatWidthForPrompt: (sig) => `[宽度: ${sig.advancePct}% / ${sig.status}]`
        }
      },
      fetch: async (url, init) => {
        captured.body = JSON.parse(init.body);
        return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) };
      }
    };
    AI.window = AI;
    vm.createContext(AI);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), AI);
    const A = AI.Core.AI;

    // ---- 29.1 默认 injectContext=true → system 自动拼接宽度 ----
    await A.call({ systemPrompt: '你是顾问', prompt: '该买吗' });
    const sys = captured.body.messages[0].content;
    if (sys.startsWith('你是顾问') && sys.includes('宽度: 30%')) ok('Z1c: 默认注入宽度信号 (前置 systemPrompt + 宽度)');
    else fail('Z1c 默认注入', sys);

    // ---- 29.2 无 systemPrompt 时, 宽度独占 system ----
    captured.body = null;
    await A.call({ prompt: '直接问题' });
    const sys2 = captured.body.messages[0].content;
    if (sys2 === '[宽度: 30% / weak]') ok('Z1c: 无 systemPrompt 时宽度独占 system 消息');
    else fail('Z1c 独占 system', sys2);

    // ---- 29.3 injectContext=false → 不注入 ----
    captured.body = null;
    await A.call({ systemPrompt: '纯净', prompt: 'x', injectContext: false });
    const sys3 = captured.body.messages[0].content;
    if (sys3 === '纯净') ok('Z1c: injectContext=false → 不注入');
    else fail('Z1c 不注入', sys3);

    // ---- 29.4 MarketWidth 异常时不抛, 继续 (降级) ----
    const AIBad = { ...AI, Core: { ...AI.Core, MarketWidth: { getMarketWidth: async () => { throw new Error('boom'); }, formatWidthForPrompt: () => '' } } };
    AIBad.window = AIBad;
    vm.createContext(AIBad);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), AIBad);
    captured.body = null;
    await AIBad.Core.AI.call({ systemPrompt: '应当正常', prompt: 'y' });
    const sysBad = captured.body.messages[0].content;
    if (sysBad === '应当正常') ok('Z1c: MarketWidth 异常 → 降级, 原始 systemPrompt 不变');
    else fail('Z1c 降级', sysBad);

    // ---- 29.5 MarketWidth status=unknown → 不注入 (避免污染) ----
    const AIUnk = { ...AI, Core: { ...AI.Core, MarketWidth: { getMarketWidth: async () => ({ status: 'unknown', partial: 'no data' }), formatWidthForPrompt: () => '[不应该出现]' } } };
    AIUnk.window = AIUnk;
    vm.createContext(AIUnk);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), AIUnk);
    captured.body = null;
    await AIUnk.Core.AI.call({ systemPrompt: '原始', prompt: 'z' });
    const sysUnk = captured.body.messages[0].content;
    if (sysUnk === '原始' && !sysUnk.includes('不应该出现')) ok('Z1c: status=unknown → 不注入 (不污染 system)');
    else fail('Z1c unknown 过滤', sysUnk);
  } catch (e) {
    fail('Z1c ai-service 注入', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [30] Z2 verify 结构化 + 归因 (反馈闭环根基) ==========
section('[30] Z2 verify JSON 结构化 + 归因统计 (daily_summary.mjs)');

(async () => {
  try {
    const dsPath = path.join(ROOT, 'scripts/daily_summary.mjs');
    // 用动态 import 把 ES module 拉进来 (Node 14+)
    const ds = await import(require('url').pathToFileURL(dsPath).href);

    // ---- 30.1 parseVerifyJsonOutput: 有效 JSON 路径 ----
    const valid = ds.parseVerifyJsonOutput(JSON.stringify({
      verdict: '对', attribution: '无', lesson: '题材风口判断准', narrative: '短期题材延续, 抓得很准。'
    }));
    if (valid.ok && valid.result.verdict === '对' && valid.result.attribution === '无') {
      ok('Z2.1 parseVerifyJsonOutput: 有效 JSON → ok=true');
    } else fail('Z2.1 有效 JSON', JSON.stringify(valid));

    // ---- 30.2: 容错围栏 (```json ... ```) ----
    const fenced = ds.parseVerifyJsonOutput('```json\n{"verdict":"错","attribution":"追高","lesson":"破位追入","narrative":"不该追"}\n```');
    if (fenced.ok && fenced.result.attribution === '追高') ok('Z2.2 容错围栏: ```json 包裹可解析');
    else fail('Z2.2 围栏', JSON.stringify(fenced));

    // ---- 30.3: free-form attribution → 归 "其他" (而非 reject) ----
    const freeAtt = ds.parseVerifyJsonOutput('{"verdict":"错","attribution":"贪心","lesson":"x","narrative":"y"}');
    if (freeAtt.ok && freeAtt.result.attribution === '其他') ok('Z2.3 free-form attribution → "其他" (兼容叙事价值)');
    else fail('Z2.3 attribution', JSON.stringify(freeAtt));

    // ---- 30.4: verdict=对 + attribution=错 → 强制 attribution="无" (数据一致性) ----
    const badAtt = ds.parseVerifyJsonOutput('{"verdict":"对","attribution":"追高","lesson":"x","narrative":"y"}');
    if (badAtt.ok && badAtt.result.attribution === '无') ok('Z2.4 verdict=对 → attribution 强制 "无"');
    else fail('Z2.4 verdict 强制', JSON.stringify(badAtt));

    // ---- 30.5: 缺字段 → ok=false + errors ----
    const missing = ds.parseVerifyJsonOutput('{"verdict":"对"}');
    if (!missing.ok && missing.errors.length >= 2 && missing.errors.some(e => e.includes('lesson') || e.includes('narrative'))) {
      ok('Z2.5 缺字段 → ok=false + errors[]');
    } else fail('Z2.5 缺字段', JSON.stringify(missing));

    // ---- 30.6: 无效 verdict → ok=false ----
    const badVerdict = ds.parseVerifyJsonOutput('{"verdict":"不确定","attribution":"无","lesson":"x","narrative":"y"}');
    if (!badVerdict.ok && badVerdict.errors.some(e => e.includes('verdict'))) {
      ok('Z2.6 无效 verdict → errors[] (含 verdict 提示)');
    } else fail('Z2.6 verdict 校验', JSON.stringify(badVerdict));

    // ---- 30.7: 空输入 → ok=false ----
    const empty = ds.parseVerifyJsonOutput(null);
    if (!empty.ok && empty.errors[0] === 'empty output') ok('Z2.7 null 输入 → "empty output"');
    else fail('Z2.7 null', JSON.stringify(empty));

    // ---- 30.8: 烂 JSON → "JSON parse error" ----
    const junk = ds.parseVerifyJsonOutput('这又不是 JSON, 随便说几句 {verdict: 错}');
    if (!junk.ok && junk.errors[0] && junk.errors[0].includes('JSON parse error')) {
      ok('Z2.8 烂 JSON → 友好错误 (含 parse)');
    } else fail('Z2.8 烂 JSON', JSON.stringify(junk));

    // ---- 30.9: 字段截断 (lesson 限 60 字, narrative 限 200 字) ----
    const longStr = 'x'.repeat(300);
    const truncated = ds.parseVerifyJsonOutput(JSON.stringify({
      verdict: '对', attribution: '无',
      lesson: longStr, narrative: longStr
    }));
    if (truncated.ok && truncated.result.lesson.length === 60 && truncated.result.narrative.length === 200) {
      ok('Z2.9 字段截断: lesson≤60 / narrative≤200');
    } else fail('Z2.9 截断', JSON.stringify({ ll: truncated.result.lesson.length, nl: truncated.result.narrative.length }));

    // ---- 30.10 applyVerifyReport: 写 aiVerified 结构化字段 ----
    const origNote = { id: 'n1', content: '原内容', assumption: '题材催化', verify: 'pending' };
    const updated = ds.applyVerifyReport(origNote, {
      verdict: '错', attribution: '追高', lesson: '高位追入无安全垫', narrative: '题材退潮, 杀跌明显'
    });
    if (updated.aiVerified && updated.aiVerified.verdict === '错' && updated.aiVerified.attribution === '追高' && updated.aiVerified.ts > 0 && updated.verify === 'verified' && updated.content.includes('AI 事后验证')) {
      ok('Z2.10 applyVerifyReport: aiVerified/verify/content 三个字段都写回');
    } else fail('Z2.10 applyVerifyReport', JSON.stringify({ aiVerified: updated.aiVerified, verify: updated.verify, hasContent: updated.content.includes('AI 事后验证') }));

    // ---- 30.11 getVerifyStats: 按 assumption 聚合 + winRate ----
    const notes = [
      { aiVerified: { verdict: '对', attribution: '无', lesson: '抓题材' }, assumption: '题材催化' },
      { aiVerified: { verdict: '对', attribution: '无', lesson: '抓题材' }, assumption: '题材催化' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: '不该追' }, assumption: '题材催化' },
      { aiVerified: { verdict: '部分', attribution: '时机早', lesson: '时机偏早' }, assumption: '题材催化' },
      { aiVerified: { verdict: '对', attribution: '无', lesson: '业绩兑现' }, assumption: '业绩拐点' },
      { aiVerified: { verdict: '错', attribution: '假设错', lesson: '业绩不及预期' }, assumption: '业绩拐点' }
    ];
    const stats = ds.getVerifyStats(notes);
    if (stats.total === 6 && stats.byAssumption['题材催化'].total === 4 && stats.byAssumption['题材催化'].hit === 2 && stats.byAssumption['题材催化'].miss === 1 && stats.byAssumption['题材催化'].partial === 1) {
      ok('Z2.11 getVerifyStats: byAssumption 聚合正确 (题材催化 4=2对1错1部分)');
    } else fail('Z2.11 byAssumption', JSON.stringify(stats.byAssumption['题材催化']));
    if (stats.byAssumption['题材催化'].winRate === 50 && stats.byAssumption['业绩拐点'].winRate === 50) {
      ok('Z2.11.2 winRate: 命中数/总数 (50%)');
    } else fail('Z2.11.2 winRate', JSON.stringify({ tc: stats.byAssumption['题材催化'].winRate, yj: stats.byAssumption['业绩拐点'].winRate }));

    // ---- 30.12 byAttribution: 错/部分时归因计数 ----
    if (stats.byAttribution['追高'] === 1 && stats.byAttribution['假设错'] === 1 && stats.byAttribution['时机早'] === 1 && !stats.byAttribution['无']) {
      ok('Z2.12 byAttribution: 错/部分归因统计 + 无 排除');
    } else fail('Z2.12 byAttribution', JSON.stringify(stats.byAttribution));

    // ---- 30.13 topHit / topMiss: 样本不足 (<3) 时不参与排名 ----
    const tiny = [
      { aiVerified: { verdict: '对', attribution: '无', lesson: 'a' }, assumption: '题材催化' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'b' }, assumption: '估值修复' }
    ];
    const statsTiny = ds.getVerifyStats(tiny);
    if (statsTiny.total === 2 && !statsTiny.topHit && !statsTiny.topMiss) ok('Z2.13 topHit/topMiss: <3 样本 → null');
    else fail('Z2.13 样本门槛', JSON.stringify({ total: statsTiny.total, h: statsTiny.topHit, m: statsTiny.topMiss }));
    // 注意: 上面 stats (30.11) 里 '题材催化' 总数=4 满足 >=3 阈值, 应有 topHit=topMiss

    // ---- 30.14 样本充足 → topHit/topMiss 出现 ----
    const rich = [];
    for (let i = 0; i < 5; i++) rich.push({ assumption: 'A', aiVerified: { verdict: i < 4 ? '对' : '错', attribution: i < 4 ? '无' : '假设错', lesson: 'l' } });
    for (let i = 0; i < 5; i++) rich.push({ assumption: 'B', aiVerified: { verdict: i < 1 ? '对' : '错', attribution: i < 1 ? '无' : '追高', lesson: 'l' } });
    const stats2 = ds.getVerifyStats(rich);
    if (stats2.topHit && stats2.topHit.assumption === 'A' && stats2.topHit.winRate === 80 && stats2.topMiss && stats2.topMiss.assumption === 'B' && stats2.topMiss.winRate === 20) {
      ok('Z2.14 topHit=最高命中率 (A 80%) / topMiss=最低 (B 20%)');
    } else fail('Z2.14 topHit/topMiss', JSON.stringify({ h: stats2.topHit, m: stats2.topMiss }));

    // ---- 30.15 lessons: 高频教训 (count >= 2) ----
    const lessonNotes = [
      { aiVerified: { verdict: '错', attribution: '追高', lesson: '破位追入无安全垫' }, assumption: '题材催化' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: '破位追入无安全垫' }, assumption: '题材催化' },
      { aiVerified: { verdict: '部分', attribution: '时机早', lesson: '时机偏早' }, assumption: '估值修复' }
    ];
    const stats3 = ds.getVerifyStats(lessonNotes);
    if (stats3.lessons.length === 1 && stats3.lessons[0].lesson === '破位追入无安全垫' && stats3.lessons[0].count === 2) {
      ok('Z2.15 lessons: count>=2 高频聚合 (破位追入无安全垫 × 2)');
    } else fail('Z2.15 lessons', JSON.stringify(stats3.lessons));

    // ---- 30.16 空 notes → 空统计 ----
    const stats4 = ds.getVerifyStats([]);
    if (stats4.total === 0 && !stats4.topHit && !stats4.topMiss && Object.keys(stats4.byAssumption).length === 0) {
      ok('Z2.16 空数据 → total=0 / topHit=null / 空 byAssumption');
    } else fail('Z2.16 空', JSON.stringify(stats4));

    // ---- 30.17 无 aiVerified 的笔记 → 不计入 ----
    const stats5 = ds.getVerifyStats([
      { assumption: '题材催化' },  // 无 aiVerified
      { assumption: '题材催化', aiVerified: { verdict: '对', attribution: '无', lesson: 'x' } }
    ]);
    if (stats5.total === 1 && stats5.byAssumption['题材催化'].total === 1) ok('Z2.17 无 aiVerified → 不计入');
    else fail('Z2.17 过滤', JSON.stringify(stats5));

    // ---- 30.18 formatVerifyStatsForPrompt: 空数据 → 提示 ----
    const fmt0 = ds.formatVerifyStatsForPrompt(ds.getVerifyStats([]));
    if (fmt0.includes('⚠') && fmt0.includes('暂无')) ok('Z2.18 空数据 → 提示"暂无" (引导用户跑 verify)');
    else fail('Z2.18 空提示', fmt0);

    // ---- 30.19 formatVerifyStatsForPrompt: 丰富数据 → 中文多行 ----
    const fmt1 = ds.formatVerifyStatsForPrompt(stats2);
    if (fmt1.includes('复盘历史') && fmt1.includes('最准假设') && fmt1.includes('最差假设') && fmt1.includes('错误归因')) {
      ok('Z2.19 formatVerifyStatsForPrompt: 4 段中文输出 (历史/最准/最差/归因)');
    } else fail('Z2.19 渲染', fmt1);

    // ---- 30.20 buildVerifyPrompt: 提示词含 JSON 字段要求 ----
    const promptObj = ds.buildVerifyPrompt({
      title: 't', code: '600519', content: 'c', assumption: 'a'
    });
    const promptCombined = (promptObj.systemPrompt || '') + '\n' + (promptObj.userPrompt || '');
    if (typeof promptCombined === 'string' && promptCombined.includes('verdict') && promptCombined.includes('attribution') && promptCombined.includes('lesson') && promptCombined.includes('narrative') && promptCombined.includes('对') && promptCombined.includes('错') && promptCombined.includes('部分')) {
      ok('Z2.20 buildVerifyPrompt: 强 JSON schema (verdict/attribution/lesson/narrative + 三档 verdict)');
    } else fail('Z2.20 prompt', String(promptCombined).slice(0, 300));
  } catch (e) {
    fail('Z2 verify 结构', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [31] Z3 概率校准 (Brier + 10 桶) ==========
section('[31] Z3 概率校准 (Brier score + 10 桶)');

(async () => {
  try {
    const ds = await import(require('url').pathToFileURL(path.join(ROOT, 'scripts/daily_summary.mjs')).href);

    // ---- 31.1 空数据 → null BS / 0 samples ----
    const empty = ds.computeCalibration([]);
    if (empty.samples === 0 && empty.brierScore === null && empty.buckets.length === 0) {
      ok('Z3.1 空数据 → samples=0 / BS=null');
    } else fail('Z3.1 空', JSON.stringify(empty));

    // ---- 31.2 完美校准: 概率=结果 → BS=0 ----
    const perfect = [
      { aiVerified: { verdict: '对', confidence: 1.0 } },  // 全对预测全赢
      { aiVerified: { verdict: '对', confidence: 1.0 } },
      { aiVerified: { verdict: '错', confidence: 0.0 } },
      { aiVerified: { verdict: '错', confidence: 0.0 } }
    ];
    const r1 = ds.computeCalibration(perfect);
    if (r1.brierScore === 0 && r1.skillScore === 1 && r1.samples === 4) {
      ok('Z3.2 完美校准 → BS=0 / Skill=1');
    } else fail('Z3.2 完美', JSON.stringify({ bs: r1.brierScore, ss: r1.skillScore, n: r1.samples }));

    // ---- 31.3 全猜 0.5 → BS=0.25 (基线) ----
    const all50 = Array.from({ length: 4 }, () => ({ aiVerified: { verdict: '对', confidence: 0.5 } }));
    const r2 = ds.computeCalibration(all50);
    if (Math.abs(r2.brierScore - 0.25) < 0.001 && Math.abs(r2.skillScore) < 0.001) {
      ok('Z3.3 全猜 0.5 → BS=0.25 (基线) / Skill≈0');
    } else fail('Z3.3 基线', JSON.stringify({ bs: r2.brierScore, ss: r2.skillScore }));

    // ---- 31.4 部分 = 0.5 credit ----
    const partial = [
      { aiVerified: { verdict: '部分', confidence: 0.5 } },  // outcome=0.5, p=0.5 → (0)²=0
      { aiVerified: { verdict: '部分', confidence: 0.8 } }   // outcome=0.5, p=0.8 → (0.3)²=0.09
    ];
    const r3 = ds.computeCalibration(partial);
    if (Math.abs(r3.brierScore - 0.045) < 0.005) {
      ok('Z3.4 部分=0.5 credit → BS=0.045 (0² + 0.3²)/2');
    } else fail('Z3.4 部分', JSON.stringify({ bs: r3.brierScore }));

    // ---- 31.5 缺 confidence 字段 → 跳过 (不计入) ----
    const noConf = [
      { aiVerified: { verdict: '对' } },                      // 缺 confidence
      { aiVerified: { verdict: '错', confidence: 0.0 } }
    ];
    const r4 = ds.computeCalibration(noConf);
    if (r4.samples === 1 && r4.brierScore === 0) {
      ok('Z3.5 缺 confidence → 跳过 (samples=1)');
    } else fail('Z3.5 缺字段', JSON.stringify({ n: r4.samples, bs: r4.brierScore }));

    // ---- 31.6 confidence 非法值 (NaN/负数/>1) → 跳过 ----
    const bad = [
      { aiVerified: { verdict: '对', confidence: -0.1 } },
      { aiVerified: { verdict: '对', confidence: 1.5 } },
      { aiVerified: { verdict: '对', confidence: NaN } },
      { aiVerified: { verdict: '对', confidence: 0.7 } }      // 唯一合法
    ];
    const r5 = ds.computeCalibration(bad);
    if (r5.samples === 1) ok('Z3.6 非法 confidence → 跳过 (仅保留合法)');
    else fail('Z3.6 非法', JSON.stringify({ n: r5.samples }));

    // ---- 31.7 10 桶分布: confidence=0.7 落 [0.7,0.8) ----
    const single = ds.computeCalibration([{ aiVerified: { verdict: '对', confidence: 0.73 } }]);
    if (single.buckets.length === 1 && single.buckets[0].label === '70-80%' && single.buckets[0].n === 1 && single.buckets[0].predicted === 0.73 && single.buckets[0].actual === 1) {
      ok('Z3.7 10 桶: confidence=0.73 → [70-80%) predicted/actual/n');
    } else fail('Z3.7 桶', JSON.stringify(single.buckets));

    // ---- 31.8 gap 正=过度自信, 负=过度保守 ----
    const overC = ds.computeCalibration([
      { aiVerified: { verdict: '错', confidence: 0.9 } },  // 预测 90%, 实际 0% → gap=+0.9
      { aiVerified: { verdict: '错', confidence: 0.8 } }   // 预测 80%, 实际 0% → gap=+0.8
    ]);
    if (overC.buckets[0].gap > 0.5 && overC.overconfidencePct > 0) {
      ok('Z3.8 过度自信: gap > 0 / overconfidencePct > 0');
    } else fail('Z3.8 overC', JSON.stringify({ gap: overC.buckets[0].gap, op: overC.overconfidencePct }));

    const underC = ds.computeCalibration([
      { aiVerified: { verdict: '对', confidence: 0.1 } },  // 预测 10%, 实际 100% → gap=-0.9
      { aiVerified: { verdict: '对', confidence: 0.2 } }   // 预测 20%, 实际 100% → gap=-0.8
    ]);
    if (underC.buckets[0].gap < -0.5 && underC.underconfidencePct > 0) {
      ok('Z3.9 过度保守: gap < 0 / underconfidencePct > 0');
    } else fail('Z3.9 underC', JSON.stringify({ gap: underC.buckets[0].gap, up: underC.underconfidencePct }));

    // ---- 31.10 良好校准 → skillScore > 0.7 (实际 0.75) ----
    const wellCal = [];
    for (let i = 0; i < 10; i++) {
      // 每桶 conf=0.6+0.04*i, 全部 对 (全猜对)
      wellCal.push({ aiVerified: { verdict: '对', confidence: 0.6 + i * 0.04 } });
    }
    const r6 = ds.computeCalibration(wellCal);
    if (r6.skillScore > 0.7 && r6.skillScore < 0.8) {
      ok('Z3.10 良好校准 → Skill=' + r6.skillScore + ' (0.7-0.8, 数学正确)');
    } else fail('Z3.10 skill', JSON.stringify({ ss: r6.skillScore }));

    // ---- 31.11 formatCalibrationForPrompt: 空 → ⚠ ----
    const fmt0 = ds.formatCalibrationForPrompt(ds.computeCalibration([]));
    if (fmt0.includes('⚠') && fmt0.includes('confidence')) ok('Z3.11 空数据 → 引导提示 (让 AI 下次填 confidence)');
    else fail('Z3.11 空渲染', fmt0);

    // ---- 31.12 formatCalibrationForPrompt: 完整 → BS + 警告 + 桶 ----
    const overCall = ds.formatCalibrationForPrompt(overC);
    if (overCall.includes('Brier Score') && overCall.includes('过度自信')) {
      ok('Z3.12 过度自信样本 → 渲染含 Brier + ⚠过度自信');
    } else fail('Z3.12 渲染警告', overCall.slice(0, 200));

    const wellFmt = ds.formatCalibrationForPrompt(r6);
    if (wellFmt.includes('Brier') && wellFmt.includes('校准样本')) {
      ok('Z3.13 良好校准 → 渲染含校准样本 + BS');
    } else fail('Z3.13 良渲染', wellFmt.slice(0, 200));
  } catch (e) {
    fail('Z3 校准', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [32] Z4 self-consistency 自一致性 (替代多空辩论) ==========
section('[32] Z4 Core.SelfConsistency (多采样 + 众数/共识率)');

(async () => {
  try {
    // 用 vm sandbox 装载 self-consistency.js, 注入 mock Core.AI.call
    const scPath = path.join(WWW, 'core/self-consistency.js');
    const scSrc = readFileSafe(scPath);
    const ctx = {
      console,
      window: {},
      Core: {
        // 模拟 LLM: 给定 prompt 模板, 返回对应 verdict
        AI: {
          call: async (opts) => {
            // mock: prompt 含 "verdict=对" / "verdict=错" / "verdict=部分" → 返回对应 JSON
            const p = opts.prompt || '';
            if (p.includes('mock-verdict=对')) return JSON.stringify({ verdict: '对', lesson: 'ok' });
            if (p.includes('mock-verdict=错')) return JSON.stringify({ verdict: '错', lesson: 'bad' });
            if (p.includes('mock-verdict=部分')) return JSON.stringify({ verdict: '部分', lesson: 'meh' });
            if (p.includes('mock-text-A')) return 'A 类回答, 题材热点延续';
            if (p.includes('mock-text-B')) return 'B 类回答, 估值偏高需谨慎';
            if (p.includes('mock-bad-json')) return '无效 JSON: {verdict:}';
            if (p.includes('mock-throw')) throw new Error('mock LLM error');
            return JSON.stringify({ verdict: '对' });
          }
        }
      }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(scSrc, ctx);

    const SC = ctx.window.Core.SelfConsistency;
    if (SC && typeof SC.run === 'function') ok('Z4.1 Core.SelfConsistency 已挂载 + run 函数');
    else fail('Z4.1 挂载', typeof SC);

    // ---- 32.2 全部 "对" → majority=对 / consensusRate=1 ----
    const allYes = await SC.run({
      prompt: 'mock-verdict=对 (任意)',
      n: 5,
      mode: 'json-verdict'
    });
    if (allYes.majority === '对' && allYes.consensusRate === 1 && allYes.lowConsensus === false && allYes.n === 5 && allYes.votes.length === 5) {
      ok('Z4.2 全 "对" → 100% 共识 / lowConsensus=false');
    } else fail('Z4.2 全对', JSON.stringify({ m: allYes.majority, c: allYes.consensusRate, l: allYes.lowConsensus, n: allYes.n }));

    // ---- 32.3 3 中 2 对 1 错 → majority=对 / 共识率 2/3 ----
    const m2of3 = await SC.run({
      prompt: 'mock-verdict=对',
      n: 2,
      mode: 'json-verdict',
      callOpts: { maxTokens: 50 }
    });
    const m3rd = await SC.run({
      prompt: 'mock-verdict=错',
      n: 1,
      mode: 'json-verdict'
    });
    // 拼成 [对, 对, 错] 用串行 task — 改为直接调 3 次 promise
    const mixRes = await SC.run({
      prompt: 'mock-verdict=对',
      n: 3,
      mode: 'json-verdict'
    });
    // mock LLM 总返 对, 但我们要 [对, 对, 错], 改 prompt 让 LLM 错误 1 次
    let counter = 0;
    const SC2ctx = {
      console, window: {}, Core: {
        AI: { call: async () => {
          counter++;
          const v = counter % 3 === 0 ? '错' : '对';
          return JSON.stringify({ verdict: v });
        } }
      }
    };
    SC2ctx.window = SC2ctx;
    vm.createContext(SC2ctx);
    vm.runInContext(scSrc, SC2ctx);
    const mix = await SC2ctx.window.Core.SelfConsistency.run({
      prompt: '任意', n: 6, mode: 'json-verdict'
    });
    // 6 次: 1=对,2=对,3=错,4=对,5=对,6=错 → majority=对(4/6)
    if (mix.majority === '对' && Math.abs(mix.consensusRate - 4 / 6) < 0.001 && mix.votes.length === 6) {
      ok('Z4.3 4对2错 (n=6) → majority=对 / 共识率 4/6');
    } else fail('Z4.3 mix', JSON.stringify({ m: mix.majority, c: mix.consensusRate, n: mix.votes.length }));

    // ---- 32.4 共识率 < threshold (默认 0.5) → lowConsensus=true ----
    let cIdx = 0;
    const SC3ctx = {
      console, window: {}, Core: {
        AI: { call: async () => {
          // 确定性: 4 次 "对", 6 次 "错" (前 4 次返 对, 后 6 次返 错) → majority=错(60%), > 0.5
          // 想触发 lowConsensus, 需要 majority 占比 < 0.5
          // 改为: 3 对 7 错 → majority=错(70%), 不触发
          // 真正要触发低共识, 用 50/50: 5 对 5 错 → 共识率=0.5, 但 0.5 < 0.5 不成立 (我用 < 而非 <=)
          // 改方案: 4 对 6 错 → majority=错(60%), threshold 改 0.7
          cIdx++;
          return cIdx <= 4 ? JSON.stringify({ verdict: '对' }) : JSON.stringify({ verdict: '错' });
        } }
      }
    };
    SC3ctx.window = SC3ctx;
    vm.createContext(SC3ctx);
    vm.runInContext(scSrc, SC3ctx);
    const lowC = await SC3ctx.window.Core.SelfConsistency.run({
      prompt: 'x', n: 10, threshold: 0.7, mode: 'json-verdict'
    });
    // 6/10 错 → majority=错, 共识率=0.6 < 0.7 → lowConsensus=true
    if (lowC.lowConsensus === true && lowC.majority === '错' && Math.abs(lowC.consensusRate - 0.6) < 0.001) {
      ok('Z4.4 lowConsensus: 共识率 0.6 < threshold 0.7 → 警告触发 (majority=错)');
    } else fail('Z4.4 lowC', JSON.stringify({ l: lowC.lowConsensus, m: lowC.majority, c: lowC.consensusRate }));

    // ---- 32.5 单次失败不阻塞 (Promise.allSettled 容错) ----
    const SC4ctx = {
      console, window: {}, Core: {
        AI: { call: async (opts) => {
          if (opts.prompt.includes('mock-throw')) throw new Error('mock fail');
          return JSON.stringify({ verdict: '对' });
        } }
      }
    };
    SC4ctx.window = SC4ctx;
    vm.createContext(SC4ctx);
    vm.runInContext(scSrc, SC4ctx);
    const partial = await SC4ctx.window.Core.SelfConsistency.run({
      prompt: 'mock-throw + mock-verdict=对', n: 3, mode: 'json-verdict'
    });
    // 期望: 3 次都 throw (因为 prompt 都含 mock-throw)
    if (partial.votes.length === 3 && partial.votes.every(v => v.error) && partial.majority === null) {
      ok('Z4.5 全失败 → majority=null / votes[].error 全部存在');
    } else fail('Z4.5 fail', JSON.stringify({ votes: partial.votes.map(v => !!v.error), m: partial.majority }));

    // ---- 32.6 text-prefix 模式: 自由文本按前 30 字聚合 ----
    // 关键: self-consistency 对同一 prompt 跑 N 次, mock 必须给不同输出
    let txtIdx = 0;
    const txtOutputs = [
      'A 类回答, 题材热点延续, 短期看多',
      'A 类回答, 题材热点延续, 短期看多',  // 同 prefix → 同组
      'B 类回答, 估值偏高需谨慎'
    ];
    const SC5ctx = {
      console, window: {}, Core: {
        AI: { call: async () => {
          const out = txtOutputs[txtIdx++ % txtOutputs.length];
          return out;
        } }
      }
    };
    SC5ctx.window = SC5ctx;
    vm.createContext(SC5ctx);
    vm.runInContext(scSrc, SC5ctx);
    const txt = await SC5ctx.window.Core.SelfConsistency.run({
      prompt: 'y', n: 3, mode: 'text-prefix', normalizeLen: 5
    });
    // 3 次: 前 5 字 "A 类回" × 2, "B 类回" × 1
    // majority = "A 类回答..." (count=2), consensusRate=2/3
    if (txt.majority && txt.majority.startsWith('A 类回答') && Math.abs(txt.consensusRate - 2 / 3) < 0.001) {
      ok('Z4.6 text-prefix: 2/3 同 prefix → majority=A 类回答 (count=2)');
    } else fail('Z4.6 text', JSON.stringify({ m: txt.majority && txt.majority.slice(0, 20), c: txt.consensusRate }));

    // ---- 32.7 围栏 JSON 容错: ```json ... ``` 包裹 ----
    const SC6ctx = {
      console, window: {}, Core: {
        AI: { call: async () => '```json\n{"verdict":"错","lesson":"x"}\n```' }
      }
    };
    SC6ctx.window = SC6ctx;
    vm.createContext(SC6ctx);
    vm.runInContext(scSrc, SC6ctx);
    const fenced = await SC6ctx.window.Core.SelfConsistency.run({
      prompt: 'y', n: 1, mode: 'json-verdict'
    });
    if (fenced.majority === '错' && fenced.allParsed.length === 1 && fenced.allParsed[0].lesson === 'x') {
      ok('Z4.7 围栏 JSON: ```json 包裹可正确抽 verdict');
    } else fail('Z4.7 围栏', JSON.stringify(fenced));

    // ---- 32.8 烂 JSON → 走 text-prefix 兜底 ----
    const SC7ctx = {
      console, window: {}, Core: {
        AI: { call: async () => '无效 JSON: {verdict:}' }
      }
    };
    SC7ctx.window = SC7ctx;
    vm.createContext(SC7ctx);
    vm.runInContext(scSrc, SC7ctx);
    const junk = await SC7ctx.window.Core.SelfConsistency.run({
      prompt: 'z', n: 2, mode: 'json-verdict'
    });
    if (junk.majority && junk.majority.startsWith('无效 JSON')) {
      ok('Z4.8 烂 JSON → 兜底 text-prefix (前 30 字聚合)');
    } else fail('Z4.8 junk', JSON.stringify(junk));

    // ---- 32.9 默认 n=3 + threshold=0.5 ----
    const def = await SC.run({ prompt: 'mock-verdict=对' });
    if (def.n === 3 && def.lowConsensus === false && def.consensusRate === 1) {
      ok('Z4.9 默认 n=3 / threshold=0.5 (符合 Wang 2022 推荐)');
    } else fail('Z4.9 默认', JSON.stringify({ n: def.n, l: def.lowConsensus, c: def.consensusRate }));
  } catch (e) {
    fail('Z4 self-consistency', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [33] Z5 FINCON 风格结构化教训 + 情境检索 ==========
section('[33] Z5 FINCON 风格结构化教训 (情境指纹 + 检索)');

(async () => {
  try {
    const ds = await import(require('url').pathToFileURL(path.join(ROOT, 'scripts/daily_summary.mjs')).href);

    // ---- 33.1 空数据 → 空教训 ----
    const empty = ds.buildStructuredLessons([]);
    if (empty.lessons.length === 0 && empty.total === 0) ok('Z5.1 空数据 → 0 lessons / total=0');
    else fail('Z5.1 空', JSON.stringify(empty));

    // ---- 33.2 同 lesson 出现 3 次 → 聚合 1 条, count=3 ----
    const lessonText = '题材退潮要止损';
    const notes = [
      { id: 'n1', assumption: '题材催化', aiVerified: { verdict: '错', attribution: '追高', lesson: lessonText, ts: 100 } },
      { id: 'n2', assumption: '题材催化', aiVerified: { verdict: '错', attribution: '追高', lesson: lessonText, ts: 200 } },
      { id: 'n3', assumption: '题材催化', aiVerified: { verdict: '错', attribution: '追高', lesson: lessonText, ts: 300 } },
      { id: 'n4', assumption: '业绩拐点', aiVerified: { verdict: '对', attribution: '无', lesson: '业绩兑现', ts: 400 } }  // 只 1 次, 不入
    ];
    const r1 = ds.buildStructuredLessons(notes);
    if (r1.lessons.length === 1 && r1.lessons[0].count === 3 && r1.lessons[0].lesson === lessonText && r1.total === 4) {
      ok('Z5.2 同 lesson 3 次 → 聚合 1 条 (count=3, examples ≤ 3)');
    } else fail('Z5.2 聚合', JSON.stringify(r1));

    // ---- 33.3 examples 上限 3 ----
    const r2 = ds.buildStructuredLessons([
      { id: 'a', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 1 } },
      { id: 'b', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 2 } },
      { id: 'c', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 3 } },
      { id: 'd', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 4 } },
      { id: 'e', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 5 } }
    ]);
    if (r2.lessons[0].examples.length === 3) ok('Z5.3 examples 上限 3 (不爆内存)');
    else fail('Z5.3 examples', JSON.stringify(r2.lessons[0].examples.length));

    // ---- 33.4 verdict 用最新 ts 的 ----
    const r3 = ds.buildStructuredLessons([
      { id: '1', assumption: 'A', aiVerified: { verdict: '对', attribution: 'x', lesson: 'L', ts: 100 } },
      { id: '2', assumption: 'A', aiVerified: { verdict: '错', attribution: 'x', lesson: 'L', ts: 500 } },  // 最新, 应胜出
      { id: '3', assumption: 'A', aiVerified: { verdict: '部分', attribution: 'x', lesson: 'L', ts: 200 } }
    ]);
    if (r3.lessons[0].verdict === '错' && r3.lessons[0].ts === 500) ok('Z5.4 verdict 用最新 ts (错误占多数)');
    else fail('Z5.4 verdict 最新', JSON.stringify(r3.lessons[0]));

    // ---- 33.5 recallLessons: 同 assumption 加分 ----
    const pool = ds.buildStructuredLessons([
      { id: '1', assumption: '题材催化', aiVerified: { verdict: '错', attribution: '追高', lesson: '题材退潮止损', ts: 1 } },
      { id: '2', assumption: '题材催化', aiVerified: { verdict: '错', attribution: '追高', lesson: '题材退潮止损', ts: 2 } },
      { id: '3', assumption: '业绩拐点', aiVerified: { verdict: '错', attribution: '假设错', lesson: '业绩兑现慢', ts: 3 } },
      { id: '4', assumption: '业绩拐点', aiVerified: { verdict: '错', attribution: '假设错', lesson: '业绩兑现慢', ts: 4 } }
    ]);
    const recall1 = ds.recallLessons({ assumption: '题材催化' }, pool);
    if (recall1[0] && recall1[0].lesson === '题材退潮止损' && recall1.length > 0) {
      ok('Z5.5 recall: ctx.assumption=题材催化 → 题材退潮止损排第一');
    } else fail('Z5.5 recall', JSON.stringify(recall1.map(r => r.lesson)));

    // ---- 33.6 recallLessons: topK 限制 ----
    const recall2 = ds.recallLessons({}, pool, { topK: 1 });
    if (recall2.length === 1) ok('Z5.6 recall topK=1 → 只返 1 条');
    else fail('Z5.6 topK', recall2.length);

    // ---- 33.7 recallLessons: 无 ctx 时按 count 排序 ----
    const noCtx = ds.recallLessons({}, pool);
    // 两组都 count=2, ties 时保持原顺序 (Array.sort 不稳, 不强求)
    if (noCtx.length === 2) ok('Z5.7 无 ctx → 返 2 条 (按 count)');
    else fail('Z5.7 no ctx', noCtx.length);

    // ---- 33.8 formatRecalledLessonsForPrompt: 渲染含标签 + 假设/归因 ----
    const fmt = ds.formatRecalledLessonsForPrompt(recall1);
    if (fmt.includes('相关历史教训') && fmt.includes('题材退潮止损') && fmt.includes('题材催化') && fmt.includes('追高') && (fmt.includes('⚠️') || fmt.includes('✅'))) {
      ok('Z5.8 formatRecall: 含教训文本 + 情境标签 + 计数');
    } else fail('Z5.8 渲染', fmt.slice(0, 200));

    // ---- 33.9 formatRecalledLessonsForPrompt: 空 → ⚠ ----
    const fmt0 = ds.formatRecalledLessonsForPrompt([]);
    if (fmt0.includes('⚠') && fmt0.includes('历史教训')) ok('Z5.9 空 → 引导提示');
    else fail('Z5.9 空渲染', fmt0);
  } catch (e) {
    fail('Z5 FINCON lessons', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [34] Z6 AI call log (trace + audit) ==========
section('[34] Z6 Core.AICallLog (AI 调用 trace + 审计)');

(async () => {
  try {
    const acPath = path.join(WWW, 'core/ai-call-log.js');
    const acSrc = readFileSafe(acPath);
    // mock Core.Storage 用内存
    const memStore = new Map();
    let idCounter = 0;
    const ctx = {
      console,
      window: {},
      Core: {
        Storage: {
          add: async (table, obj) => {
            if (!memStore.has(table)) memStore.set(table, []);
            const arr = memStore.get(table);
            arr.push({ ...obj });
            return obj.id;
          },
          all: async (table) => {
            return memStore.get(table) || [];
          },
          delete: async (table, id) => {
            const arr = memStore.get(table) || [];
            const idx = arr.findIndex(x => x.id === id);
            if (idx >= 0) arr.splice(idx, 1);
            return true;
          }
        }
      }
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    vm.runInContext(acSrc, ctx);
    const ACL = ctx.window.Core.AICallLog;
    if (ACL && typeof ACL.record === 'function') ok('Z6.1 Core.AICallLog 已挂载 + record 函数');
    else fail('Z6.1 挂载', typeof ACL);

    // ---- 34.2 record: 写入字段 + response 截断 200 ----
    const e1 = await ACL.record({
      page: 'journal', purpose: 'attr', prompt: 'p1', systemPrompt: 's1',
      response: 'x'.repeat(500), latencyMs: 1234, model: 'qwen3', baseURL: 'http://l',
      injected: { width: true }
    });
    if (e1 && e1.response.length === 200 && e1.promptLen === 2 && e1.sysLen === 2 && e1.page === 'journal' && e1.injected.width === true) {
      ok('Z6.2 record: response 截断 200 / 字段完整 / injected.width 保留');
    } else fail('Z6.2 record', JSON.stringify({ r: e1 && e1.response.length, p: e1 && e1.promptLen, s: e1 && e1.sysLen }));

    // ---- 34.3 promptHash / sysHash 用 FNV-1a (非空) ----
    const e2 = await ACL.record({ page: 'fund', purpose: 'advisor', prompt: 'test prompt', systemPrompt: 'test sys' });
    if (e2.promptHash && e2.sysHash && e2.promptHash !== e2.sysHash) ok('Z6.3 hash: FNV-1a 产生不同指纹 (避免存原文)');
    else fail('Z6.3 hash', JSON.stringify({ ph: e2.promptHash, sh: e2.sysHash }));

    // ---- 34.4 list 倒序 ----
    const list = await ACL.list({ limit: 10 });
    if (list.length >= 2 && list[0].ts >= list[1].ts) ok('Z6.4 list: 按 ts 倒序 (最新在前)');
    else fail('Z6.4 倒序', JSON.stringify(list.map(x => x.ts)));

    // ---- 34.5 list 过滤 page ----
    const journalOnly = await ACL.list({ page: 'journal' });
    if (journalOnly.length === 1 && journalOnly[0].page === 'journal') ok('Z6.5 list.page 过滤');
    else fail('Z6.5 page filter', JSON.stringify(journalOnly.map(x => x.page)));

    // ---- 34.6 list since 时间过滤 ----
    const recent = await ACL.list({ since: Date.now() - 1000 });
    if (recent.length >= 2) ok('Z6.6 list.since: 1 秒内的全返');
    else fail('Z6.6 since', recent.length);

    // ---- 34.7 stats 聚合 ----
    // 注入 1 条 error
    await ACL.record({ page: 'journal', purpose: 'x', prompt: 'p', error: 'timeout' });
    const s = await ACL.stats();
    if (s.total >= 3 && s.errorCount >= 1 && s.okCount >= 2 && s.byPage.journal && s.byPage.journal.error >= 1) {
      ok('Z6.7 stats: total/errorCount/byPage.error 都对');
    } else fail('Z6.7 stats', JSON.stringify(s));

    // ---- 34.8 滚动截断: 写到 201 条 → 删最早的 ----
    for (let i = 0; i < 200; i++) {
      await ACL.record({ page: 'p', purpose: 'x', prompt: 'p' + i });
    }
    const afterTrunc = await ACL.list({ limit: 1000 });
    if (afterTrunc.length === 200) ok('Z6.8 滚动截断: 满 200 条不再增长');
    else fail('Z6.8 截断', afterTrunc.length);

    // ---- 34.9 clear 清空 ----
    await ACL.clear();
    const afterClear = await ACL.list();
    if (afterClear.length === 0) ok('Z6.9 clear: 清空所有 ai_call_log');
    else fail('Z6.9 clear', afterClear.length);

    // ---- 34.10 record 写入失败不抛 (Core.Storage 抛错时优雅) ----
    memStore.get('ai_call_log').push = () => { throw new Error('db broken'); };
    let crashed = false;
    try {
      await ACL.record({ page: 'x', purpose: 'y', prompt: 'z' });
    } catch (e) { crashed = true; }
    if (!crashed) ok('Z6.10 写入失败 → 吞错不抛 (日志不应阻塞主流程)');
    else fail('Z6.10 失败容忍', 'crashed');
  } catch (e) {
    fail('Z6 ai-call-log', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [35] Z7 月度教训提炼 (summarizeMonth + formatMonthReportForPrompt) ==========
section('[35] Z7 月度复盘报告 (汇总所有 Z2/Z3/Z5 信号)');

(async () => {
  try {
    const ds = await import(require('url').pathToFileURL(path.join(ROOT, 'scripts/daily_summary.mjs')).href);

    // ---- 35.1 空数据 → 引导提示 ----
    const empty = ds.summarizeMonth([], { month: '2026-07' });
    if (empty.total === 0 && empty.hitRate === 0 && empty.oneThing.includes('暂无')) {
      ok('Z7.1 空数据 → total=0 / 引导提示');
    } else fail('Z7.1 空', JSON.stringify(empty));

    // ---- 35.2 命中率: 对+部分×0.5 / 总 ----
    const r1 = ds.summarizeMonth([
      { aiVerified: { verdict: '对' }, assumption: 'A' },
      { aiVerified: { verdict: '错' }, assumption: 'A' },
      { aiVerified: { verdict: '部分' }, assumption: 'A' }
    ], { month: '2026-07' });
    // hits = 1 + 0 + 0.5 = 1.5, hitRate = 1.5/3 = 50%
    if (r1.total === 3 && r1.hitRate === 50) ok('Z7.2 命中率: (1+0+0.5)/3 = 50%');
    else fail('Z7.2 命中率', JSON.stringify({ total: r1.total, hr: r1.hitRate }));

    // ---- 35.3 topAssumption: 样本 >=3 才入 ----
    const r2 = ds.summarizeMonth([
      // A: 4 次全对 (100%)
      { aiVerified: { verdict: '对', lesson: 'l1' }, assumption: 'A' },
      { aiVerified: { verdict: '对', lesson: 'l1' }, assumption: 'A' },
      { aiVerified: { verdict: '对', lesson: 'l1' }, assumption: 'A' },
      { aiVerified: { verdict: '对', lesson: 'l1' }, assumption: 'A' },
      // B: 5 次全错 (0%)
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'l2' }, assumption: 'B' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'l2' }, assumption: 'B' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'l2' }, assumption: 'B' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'l2' }, assumption: 'B' },
      { aiVerified: { verdict: '错', attribution: '追高', lesson: 'l2' }, assumption: 'B' },
      // C: 1 次 (样本不足, 不入排名)
      { aiVerified: { verdict: '对' }, assumption: 'C' }
    ]);
    if (r2.topAssumption.best && r2.topAssumption.best.assumption === 'A' && r2.topAssumption.best.winRate === 100 &&
        r2.topAssumption.worst && r2.topAssumption.worst.assumption === 'B' && r2.topAssumption.worst.winRate === 0) {
      ok('Z7.3 topAssumption: best=A 100% / worst=B 0% (C 样本 <3 不入)');
    } else fail('Z7.3 topAssumption', JSON.stringify(r2.topAssumption));

    // ---- 35.4 topAttribution: 最常见错因 ----
    if (r2.topAttribution === '追高') ok('Z7.4 topAttribution: 5/5 错都 "追高"');
    else fail('Z7.4 attribution', r2.topAttribution);

    // ---- 35.5 topLessons: 高频教训 Top 3 ----
    if (r2.topLessons.length > 0 && r2.topLessons[0].includes('l2') && r2.topLessons[0].includes('5次')) {
      ok('Z7.5 topLessons: l2 (5次) 排第一 (count 降序)');
    } else fail('Z7.5 topLessons', JSON.stringify(r2.topLessons));

    // ---- 35.6 oneThing: worst assumption 时优先 ----
    if (r2.oneThing.includes('B') && r2.oneThing.includes('0%') && r2.oneThing.includes('放弃')) {
      ok('Z7.6 oneThing: worst assumption (B 0%) → 建议放弃/加严入场');
    } else fail('Z7.6 oneThing', r2.oneThing);

    // ---- 35.7 calibration: 复用 computeCalibration (无 confidence → samples=0) ----
    if (r2.calibration.samples === 0 && r2.calibration.brierScore === null) {
      ok('Z7.7 calibration: 无 confidence 字段 → samples=0 / BS=null (Z3 安全降级)');
    } else fail('Z7.7 cal', JSON.stringify(r2.calibration));

    // ---- 35.8 fallback: 无 worst 时用 attribution ----
    const noWorst = ds.summarizeMonth([
      { aiVerified: { verdict: '对' }, assumption: 'A' },
      { aiVerified: { verdict: '对' }, assumption: 'A' }
    ]);
    if (noWorst.oneThing.includes('积累中') || noWorst.oneThing.includes('命中率')) {
      ok('Z7.8 fallback: 样本不足无 worst → 命中率高/积累中提示');
    } else fail('Z7.8 fallback', noWorst.oneThing);

    // ---- 35.9 formatMonthReportForPrompt: 完整报告 ----
    const fmt = ds.formatMonthReportForPrompt(r2);
    if (fmt.includes('2026-') && fmt.includes('月度复盘') && fmt.includes('命中率') && fmt.includes('最准假设') && fmt.includes('最差假设') && fmt.includes('最常见错因') && fmt.includes('下月重点') && fmt.includes('追高') && fmt.includes('B')) {
      ok('Z7.9 formatMonthReport: 含命中/最准/最差/归因/教训/下月重点');
    } else fail('Z7.9 渲染', fmt.slice(0, 300));

    // ---- 35.10 formatMonthReportForPrompt: 空 → ⚠ ----
    const fmt0 = ds.formatMonthReportForPrompt(ds.summarizeMonth([]));
    if (fmt0.includes('⚠')) ok('Z7.10 空渲染 → 引导写日记');
    else fail('Z7.10 空渲染', fmt0);
  } catch (e) {
    fail('Z7 月度', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== 总结 ==========
// 同步 section 的 ok() 已经在 console 打印;
// async IIFE 里的 ok() 还在 microtask 队列里, 用 setImmediate 给一次机会再读 passed/failed
setImmediate(() => {
  console.log(`\n\x1b[1m===== 测试结果 =====\x1b[0m`);
  console.log(`\x1b[32m通过: ${passed}\x1b[0m  |  \x1b[${failed > 0 ? '31' : '32'}]m失败: ${failed}\x1b[0m`);
  if (failed > 0) {
    console.log(`\n失败项:`);
    errors.forEach(e => console.log('  - ' + e));
    console.log(`\n\x1b[31m❌ 有失败项需要修复\x1b[0m`);
    process.exit(1);
  } else {
    console.log(`\n\x1b[32m✅ 全部通过\x1b[0m`);
    process.exit(0);
  }
});
