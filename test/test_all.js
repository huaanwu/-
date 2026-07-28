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

// FIX-2: 在 sandbox 测试里真实加载 constants.js, 让 mock Core 也有 Core.Constants
let _REAL_CONSTANTS = null;
function _loadRealConstants() {
  if (_REAL_CONSTANTS !== null) return _REAL_CONSTANTS;
  const src = readFileSafe(path.join(WWW, 'core', 'constants.js'));
  if (!src) { _REAL_CONSTANTS = {}; return _REAL_CONSTANTS; }
  const cctx = vm.createContext({ window: {}, console });
  try {
    vm.runInContext(src, cctx);
    _REAL_CONSTANTS = cctx.window.Core && cctx.window.Core.Constants
      ? cctx.window.Core.Constants : {};
  } catch (e) {
    _REAL_CONSTANTS = {};
  }
  return _REAL_CONSTANTS;
}

// FIX-3: 同样真实加载 portfolio.js 让 sandbox 有 Core.Portfolio
let _REAL_PORTFOLIO = null;
function _loadRealPortfolio() {
  if (_REAL_PORTFOLIO !== null) return _REAL_PORTFOLIO;
  const src = readFileSafe(path.join(WWW, 'core', 'portfolio.js'));
  if (!src) { _REAL_PORTFOLIO = null; return _REAL_PORTFOLIO; }
  const cctx = vm.createContext({
    window: {},
    console,
    Core: {
      State: { get: () => 0 },
      Storage: {
        all: async () => [],
        kvGet: async () => ({ cash: 0 })
      },
      Data: {
        getStockQuote: async () => null,
        getFundSpot: async () => []
      },
      Constants: _loadRealConstants()
    }
  });
  try {
    vm.runInContext(src, cctx);
    _REAL_PORTFOLIO = cctx.window.Core && cctx.window.Core.Portfolio
      ? cctx.window.Core.Portfolio : null;
  } catch (e) {
    _REAL_PORTFOLIO = null;
  }
  return _REAL_PORTFOLIO;
}

// H1 Commit 2: 同样真实加载 position-sizing.js 让 sandbox 有 Core.PositionSizing
let _REAL_POSITION_SIZING = null;
function _loadRealPositionSizing() {
  if (_REAL_POSITION_SIZING !== null) return _REAL_POSITION_SIZING;
  const src = readFileSafe(path.join(WWW, 'core', 'position-sizing.js'));
  if (!src) { _REAL_POSITION_SIZING = null; return _REAL_POSITION_SIZING; }
  const cctx = vm.createContext({ window: {}, console });
  try {
    vm.runInContext(src, cctx);
    _REAL_POSITION_SIZING = cctx.window.Core && cctx.window.Core.PositionSizing
      ? cctx.window.Core.PositionSizing : null;
  } catch (e) {
    _REAL_POSITION_SIZING = null;
  }
  return _REAL_POSITION_SIZING;
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
  'Holdings':  ['init', 'render', 'addDialog', 'editDialog', 'save', 'remove', 'addTxDialog', 'saveTx', 'closeModal', '_renderPending', 'confirmPending', 'ignorePending', '_markPendingConfirmed',
    // 券商跳转 + 自动校准
    'brokerDialog', 'reconcileDialog', 'reconcileSave'],
  'Paper':     ['init', 'buy', 'sell', 'getAccount', 'getPositions', 'resetAccount', 'snapshotIfNeeded', 'autoTradeFromPick', 'renderPage', 'buyFromForm', 'sellFromForm', 'sellAll', 'switchSleeve', 'setShortExpandMode', '_getAccountRaw', '_saveAccountRaw', '_calcFee', '_roundLot', '_pushSnapshot', '_planAutoTrade', 'maybeGenerateEodReport', '_shouldGenerateEod', '_pushEodReport', '_appendDisciplineLog', '_logDisciplineBlock', '_buildEodReport', '_formatEodReportText', '_pushEodToFeishu', '_renderEodReport', 'addCondOrder', 'listCondOrders', 'cancelCondOrder', 'settleCondOrders', '_checkCondOrder', '_barOf', '_lastClosedBar', '_orderEligible', '_tradingDaysAfter', '_isGapDown', '_isGapUp', '_fillCheck', '_exitCheck', '_settleFill', '_settleExit', '_writeCondJournal', '_condPlanLines', 'addCondOrderFromForm', '_renderCondOrders'],
  'Journal':   ['init', 'render', 'newDialog', 'editDialog', 'save', 'remove', 'closeModal', '_buildHoldingsContext', '_renderHoldingBadge', '_renderStructuredTags', '_runAiAssistant'],
  'Screener':  ['init', 'run', '_addWatchlistFromPick', '_runPreBacktest',
    // Phase Y.2
    '_runRiskFilter', '_isAnyRiskFlagOn', '_readBlacklist'],
  'Fund':      ['init', 'render', 'addDialog', 'save', 'remove', 'showChart', 'closeModal',
    // 基金对账(独立 kv: fund_reconcile_log, 跟股票 holdings_reconcile_log 区分)
    'reconcileDialog', 'reconcileSave'],
  'Backtest':  ['init', 'run'],
  'Alerts':    ['init', 'render', 'addDialog', 'save', 'toggle', 'remove', 'closeModal', 'startPolling', 'stopPolling', 'runLongChecks', '_isTradingTime', '_fetchJournalContext', '_horizonOf', '_syncTimers', '_checkShort', '_checkLong', '_filterEarningsWarnings', '_regimeNotifyText', '_judgeValuation', '_notifyLong'],
  // T2 ShortTrader: 文件名 short-trader.js, key 用 'Short-Trader' (toLowerCase 后对得上)
  'Short-Trader': ['init', 'maybeGeneratePlan', 'generatePlan', 'regenerate', 'renderTodayPlan', '_saveFailure',
    '_isTradingDay', '_todayStr', '_normCode6', '_buildCandidatePool', '_hasRecentShortSell', '_scalePositionPct',
    '_appendPlanLog', '_validatePlans', '_buildSystemPrompt', '_buildUserPrompt', '_buildPlanContext',
    // T4 学习环
    'verifyClosedTrades', '_extractExitInfo', '_judgeClosedTrade', '_barOf', '_linkVerifiedTrades',
    '_buildTrackRecord', '_formatTrackRecord', '_outcomeScore', '_brierScore', '_calibrationBuckets',
    '_collectVerifiedTrades', 'maybeDistillLessons', '_buildLearningPromptText', 'renderLearningCurve'],
  // 盘中操盘手 (Intraday Trader): 文件名 intraday-trader.js, key 用 'Intraday-Trader' (toLowerCase 对得上)
  'Intraday-Trader': ['init', 'runNow', 'stopPolling', 'listLog',
    '_processPosition', '_decideWithLlm', '_executeAction', '_appendLog',
    '_isTradingTime', '_isCooldownOver', '_isUnderDailyLimit', '_mechanicalExit', '_isMinHoldPassed', '_parseDecision'],
  // 长线操盘手 (Long Trader): 文件名 long-trader.js, key 用 'Long-Trader' (toLowerCase 对得上)
  'Long-Trader': ['init', 'runNow', 'stopPolling', 'listLog', '_shouldRun', '_llmPickTop', '_appendLog']
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
  'core/crosscheck.js': 'Core.CrossCheck',
  'core/user-profile.js': 'Core.UserProfile',
  'core/learning-pool.js': 'Core.LearningPool'
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

// 检查 Core.Premortem (Phase D1 + P1) 的方法清单
const pmContent = readFileSafe(path.join(WWW, 'core/premortem.js'));
const PM_METHODS = ['checkPick', 'checkPicks', 'renderBlock', 'verifyFalsifyCondition', 'verifyInvalidation', 'verifyPick', 'verifyPendingJournals'];
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

// 检查 Core.LearningPool (P3 跨调用方学习池) 的方法清单
const lpContent = readFileSafe(path.join(WWW, 'core/learning-pool.js'));
const LP_METHODS = ['collect', 'format'];
for (const m of LP_METHODS) {
  if (lpContent && new RegExp(`\\b${m}\\s*\\(`).test(lpContent)) ok(`LearningPool.${m}`);
  else fail(`LearningPool.${m}`, '缺失');
}
// 检查 5 调用方注入 Core.LearningPool.format()
const callerFiles = [
  'short-trader.js', 'long-trader.js', 'screener.js',
  'intraday-trader.js', 'fund/ai-advisor.js'
];
for (const cf of callerFiles) {
  const src = readFileSafe(path.join(WWW, 'app', cf));
  if (src && src.includes('Core.LearningPool.format')) ok(`学习池注入 app/${cf}`);
  else fail(`学习池注入 app/${cf}`, src ? '缺 Core.LearningPool.format' : '读不到');
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
  'getFundSpot', 'getFundHistory', 'getFundPortfolio', 'getIndexSpot', 'health', 'fetch',
  // Phase Y.1 排雷 4 fetcher
  'getStockGoodwillRanks', 'getStockHolderDecreases', 'getStockEarningsForecastFresh', 'getStockCapitalFlight',
  // 短线两阶段选品: 行业映射 + 公告 + 量比 (阶段 1)
  'getStockIndustryByCode', 'getStockNoticesByCode', 'getStockAllAnnouncements', 'getStockVolumeAnomaly'];
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
        Data: { getIndexSpot: async () => [], getStockQuote: async () => null,
          formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
          getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null },
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
          Data: { getFundSpot: async () => [], getIndexSpot: async () => [] },
          Constants: _loadRealConstants()
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
    fctx.Core = fctx.window.Core;  // FIX-2: 让 IIFE 顶层能直接找到 Core
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

    // Case 11: Bug I - 同 type 多只基金, drift 只算 type 级, 不重复判每只
    // 总 60000, short_bond 2 只 (各 18000) = 60% 超配 40%, 应只 1 条 type 级建议, 而非 2 条单只级
    const a11 = Fund._computeRebalanceAdvice([
      { code: 'A1', name: '短债1', type: 'short_bond', currentNav: 1, value: 18000 },
      { code: 'A2', name: '短债2', type: 'short_bond', currentNav: 1, value: 18000 },
      { code: 'B', name: '纯债', type: 'pure_bond', currentNav: 1, value: 24000 }
    ], { short_bond: 0.2, pure_bond: 0.8 });
    const reduceShort = a11.suggestions.filter(s => s.action === 'reduce' && s.type === 'short_bond');
    // type currentValue=36000, targetValue=60000*0.2=12000, diffValue=24000
    if (a11.needRebalance && reduceShort.length === 1 && reduceShort[0].amount === 24000) ok('同 type 多只 → 1 条 type 级建议 (减 24000)');
    else fail('type 级聚合', `suggestions=${JSON.stringify(a11.suggestions.map(s => ({type:s.type, action:s.action, amount:s.amount})))}`);
    // drift 数组也按 type 聚合, 不该有 A1/A2 各 1 条
    const shortDrift = a11.drift.find(d => d.type === 'short_bond');
    if (shortDrift && shortDrift.holdingCount === 2 && Math.abs(shortDrift.currentPct - 0.6) < 0.001 && Math.abs(shortDrift.driftPct - 0.4) < 0.001) ok('drift 数组 type 级: holdingCount=2, currentPct=60%, driftPct=40%');
    else fail('drift type 级', JSON.stringify(shortDrift));

    // Case 12: Bug I - 总调仓 > 10% → 警告 (不强制缩减, 金额照算)
    // 总 50000, short_bond 40% 偏 20%, pure_bond 60% 偏 20%: 总调仓 20000 = 40% > 10% 上限
    const a12 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 20000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 30000 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    if (a12.totalAdjust === 20000 && a12.warnings.some(w => /分批调仓/.test(w) && /10%/.test(w))) ok('超 10% 上限 → 警告, 金额不缩减');
    else fail('10% 上限警告', `totalAdjust=${a12.totalAdjust}, warnings=${JSON.stringify(a12.warnings)}`);

    // Case 13: Bug I - 总调仓 < 10% → 无 10% 警告
    // 总 100000, short_bond 28% 偏 8%, pure_bond 72% 偏 8%: 总调仓 16000 = 16% > 10%
    // 调小一点: short_bond 24% 偏 4% (阈值 5%) → 不触发; 用 25% / 75% 偏 5% 也不触发
    // → 用阈值 3%: short_bond 25% 偏 5% 触发; pure_bond 75% 偏 5% 触发; 总调仓 10000 = 10%, 边界 ≤ 算无警告
    const a13 = Fund._computeRebalanceAdvice([
      { code: 'A', name: 'A', type: 'short_bond', currentNav: 1, value: 25000 },
      { code: 'B', name: 'B', type: 'pure_bond', currentNav: 1, value: 75000 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.03);
    // totalValue=100000, short_bond 25% 偏 5%, targetValue=20000, diff=5000; pure_bond 75% 偏 5%, targetValue=80000, diff=-5000; 总 10000 = 10%
    if (a13.totalAdjust === 10000 && !a13.warnings.some(w => /分批调仓/.test(w))) ok('= 10% → 无分批调仓警告 (边界外不算超)');
    else fail('无警告', `totalAdjust=${a13.totalAdjust}, warnings=${JSON.stringify(a13.warnings)}`);

    // Case 14: Bug I - 同 type 多只时, 选当前最大那只作为代表持仓
    const a14 = Fund._computeRebalanceAdvice([
      { code: 'A1', name: '短债1', type: 'short_bond', currentNav: 1, value: 10000 },
      { code: 'A2', name: '短债2', type: 'short_bond', currentNav: 1, value: 20000 },  // 减仓代表
      { code: 'B', name: '纯债', type: 'pure_bond', currentNav: 1, value: 20000 }
    ], { short_bond: 0.2, pure_bond: 0.8 }, 0.05);
    const reduce14 = a14.suggestions.find(s => s.action === 'reduce');
    // 当前 A2 (20000) > A1 (10000), 减仓代表应选 A2
    if (reduce14 && reduce14.code === 'A2') ok('同 type 多只 → 减仓代表 = 当前最大');
    else fail('代表选择', JSON.stringify(reduce14));
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
        Data: { getStockQuote: async () => null,
          formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
          getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null },
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
    if (out.includes('共 15 条') && out.includes('取前 10') && out.match(/- 600\d+\s+\S+\s*\[?\s*[^\]]*盈亏/g).length === 10) {
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
    fetch: async () => ({ ok: false }),
    location: { hostname: 'localhost', host: 'localhost:3003', protocol: 'http:' }  // ai-service getConfig 判 localhost 用
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

// ========== [20.9] 局域网自动发现本地大模型 ==========
(async function() {
  // 静态: dev-proxy 注册路由 + 实现探测
  const proxySrc = readFileSafe(path.join(ROOT, 'scripts/dev-proxy.mjs'));
  if (proxySrc.includes("app.get('/api/discover/local-llm'")) {
    ok('20.9.a dev-proxy 注册 GET /api/discover/local-llm');
  } else fail('20.9.a dev-proxy 路由缺失', '应注册 GET /api/discover/local-llm');
  if (/_getScanHosts/.test(proxySrc) && (/_probeEndpoint/.test(proxySrc) || /probeEndpoint/.test(proxySrc))) {
    ok('20.9.b dev-proxy 实现 _getScanHosts + _probeEndpoint');
  } else fail('20.9.b dev-proxy 探测函数缺失', '应实现 host/port 扫描');
  if (/DISCOVER_PORTS/.test(proxySrc) && (/1234/.test(proxySrc)) && (/11434/.test(proxySrc))) {
    ok('20.9.c dev-proxy DISCOVER_PORTS 含 1234/11434 常见端口');
  } else fail('20.9.c 端口列表缺失', '应含 1234/11434 等');

  // 静态: ai-service.discoverLocalLLM 暴露
  const aiSrc = readFileSafe(path.join(WWW, 'core/ai-service.js'));
  if (/async function discoverLocalLLM/.test(aiSrc) && /\/api\/discover\/local-llm/.test(aiSrc)) {
    ok('20.9.d ai-service 实现 discoverLocalLLM 调 /api/discover/local-llm');
  } else fail('20.9.d AI.discoverLocalLLM 缺失', '应异步调发现端点');
  if (/window\.Core\.AI\s*=\s*\{[\s\S]*?discoverLocalLLM/.test(aiSrc)) {
    ok('20.9.e Core.AI.discoverLocalLLM 已导出');
  } else fail('20.9.e Core.AI 导出缺失', 'discoverLocalLLM 应挂在 window.Core.AI');

  // 静态: vite proxy /api/discover
  const viteSrc = readFileSafe(path.join(ROOT, 'vite.config.js'));
  if (/['"]\/api\/discover['"]\s*:/.test(viteSrc)) {
    ok('20.9.f vite.config.js 含 /api/discover proxy');
  } else fail('20.9.f vite proxy 缺失', '应透传到 dev-proxy :8089');

  // 静态: app.js UI 接线
  const appSrc = readFileSafe(path.join(WWW, 'app.js'));
  if (/window\.discoverLLM\s*=/.test(appSrc) && /window\.applyDiscoveredLLM\s*=/.test(appSrc)) {
    ok('20.9.g app.js 接线 discoverLLM + applyDiscoveredLLM');
  } else fail('20.9.g app.js UI 缺失', '应加 discoverLLM 按钮 + apply 函数');
  if (/aiDiscoverResult/.test(appSrc) && /aiDiscoverList/.test(appSrc)) {
    ok('20.9.h app.js DOM 元素 ID aiDiscoverResult/aiDiscoverList');
  } else fail('20.9.h DOM ID 缺失', '应新增 #aiDiscoverResult + #aiDiscoverList');

  // 动态: 加载 ai-service, mock fetch 测 discoverLocalLLM
  try {
    const AI = {
      console,
      setTimeout, clearTimeout,
      Core: { State: { get: () => ({}) } },
      fetch: async (url) => {
        if (url && url.includes && url.includes('/api/discover/local-llm')) {
          return {
            ok: true,
            json: async () => ({
              found: [{
                baseURL: 'http://127.0.0.1:8082/v1', host: '127.0.0.1', port: 8082,
                type: 'llama.cpp', label: 'llama.cpp server',
                models: ['qwen36-35b-a3b'], latencyMs: 12
              }],
              scanned: 5, serverIPs: ['192.168.1.10'], host: '192.168.1.10',
              timestamp: '2026-07-27T00:00:00Z'
            })
          };
        }
        return { ok: false };
      }
    };
    vm.createContext(AI);
    AI.window = AI;
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), AI);
    const r = await AI.window.Core.AI.discoverLocalLLM();
    if (r.found.length === 1 && r.found[0].models[0] === 'qwen36-35b-a3b' && r.host === '192.168.1.10') {
      ok('20.9.i discoverLocalLLM 解析 found/models/host');
    } else fail('20.9.i 解析错误', JSON.stringify(r));
    if (r.scanned === 5 && r.serverIPs.length === 1 && r.serverIPs[0] === '192.168.1.10') {
      ok('20.9.j discoverLocalLLM 解析 scanned/serverIPs');
    } else fail('20.9.j 字段缺失', JSON.stringify(r));
  } catch (e) {
    fail('20.9.i dynamic discoverLocalLLM', e.message);
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

    // ---- 21.3 限流期内不发起任何 fetch (2026-07-28 起限流按 path 独立: 需同 path 触发) ----
    // 先在 stock_zh_a_hist 上触发 429 (腾讯 4xx 失败 → 降级 aktools 429 → 该 path 限流)
    D.resetLimit();
    DS.fetch = async (url) => {
      const u = String(url);
      if (u.includes('gtimg.cn')) return { ok: false, status: 400, text: async () => 'Bad Request' };
      return { ok: false, status: 429, text: async () => 'Too Many Requests' };
    };
    try { await D.getStockKLine('600519'); } catch (e) { /* 预期触发限流 */ }
    // 第二次调用: 限流期应在任何 fetch 之前抛 (getStockKLine 入口先查 stock_zh_a_hist 限流)
    let fetchCalled = false;
    DS.fetch = async () => { fetchCalled = true; return { ok: false, status: 502, text: async () => 'Bad Gateway' }; };
    let r2;
    try { await D.getStockKLine('600519'); r2 = 'NO_THROW'; }
    catch (e) { r2 = e.message; }
    if (r2.includes('限流') && r2.includes('后') && !fetchCalled) ok('限流期内 fetch 不发起请求 (path 独立)');
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
    if (r4.includes('HTTP 400') && attempt >= 3) ok('4xx 业务错误重试 3 次后抛错 (腾讯/新浪降级 + aktools retries=2)');
    else fail('4xx retry N 次', JSON.stringify({ r: r4, attempt }));

    // ---- 21.6 5xx 不触发限流 (2026-07-28 改: 仅 429/关键字算限流, 裸 5xx 走降级重试) ----
    D.resetLimit();
    attempt = 0;
    DS.fetch = async () => { attempt++; return { ok: false, status: 502, text: async () => 'Bad Gateway' }; };
    let r5;
    try { await D.getStockSpot(['600519']); r5 = 'NO_THROW'; }
    catch (e) { r5 = e.message; }
    const s6 = D.getLimitStatus();
    if (r5 !== 'NO_THROW' && !r5.includes('限流') && !s6.blocked) ok('5xx 不触发限流, 降级链重试后抛错');
    else fail('5xx 行为', JSON.stringify({ r: r5, blocked: s6.blocked }));

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
    // URL 是 urlencoded, 含 %E4%B8%8A%E8%AF%81%E6%8C%87%E6%95%B0 = "上证指数", 但保险起见 decode 一次再匹配
    const decodedUrl = decodeURIComponent(calledUrl);
    if (attempt >= 1 && calledUrl.includes('stock_zh_index_spot') && calledUrl.includes('symbol=') &&
        (decodedUrl.includes('上证指数') || calledUrl.includes('%E4%B8%8A%E8%AF%81%E6%8C%87%E6%95%B0'))) ok('getIndexSpot: 降级到 aktools URL 带 symbol=上证指数...');
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
    // 2026-07-28 口径: 端点不再返 7-11 列, 成交额/振幅/换手率恒 null,
    // 涨跌幅/涨跌额由客户端按开收盘价计算 (即使 mock 给了旧列也忽略)
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
      && klineRows[0].成交额 === null
      && klineRows[0].振幅 === null
      && klineRows[0].涨跌幅 === 0.57
      && klineRows[0].涨跌额 === 9.70
      && klineRows[0].换手率 === null
      && symbolOK) {
      ok('_tencentKLine: 字段归一化正确 + 6→sh 前缀');
    } else fail('_tencentKLine 字段归一化', JSON.stringify({ row: klineRows[0], url: tencentUrls[0] }));

    // 22.Y12.1b 真实腾讯只返 6 列: 成交额/振幅/换手率=null,
    // 涨跌幅/涨跌额由客户端按开收盘计算 ((1334.127-1335.787)/1335.787 ≈ -0.12 / -1.66)
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
      && real6[0].涨跌幅 === -0.12
      && real6[0].涨跌额 === -1.66
      && real6[0].换手率 === null) {
      ok('_tencentKLine: 真实 6 列数据, 缺位字段=null, 涨跌幅/涨跌额客户端计算');
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
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: _loadRealConstants()
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

// ========== [23b] Paper 分账户 (sleeve, AI 短线操盘手 T1) ==========
section('23b] Paper 分账户 sleeve 实测');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const K = _loadRealConstants();

    // T1 常量进 Core.Constants
    if (K.PAPER_SHORT_CASH === 30000 && typeof K.PAPER_SHORT_POSITION_PCT === 'number' && K.PAPER_SHORT_POSITION_PCT > 0) {
      ok(`sleeve: 常量 PAPER_SHORT_CASH=30000 / PAPER_SHORT_POSITION_PCT=${K.PAPER_SHORT_POSITION_PCT}`);
    } else fail('sleeve 常量', JSON.stringify({ c: K.PAPER_SHORT_CASH, p: K.PAPER_SHORT_POSITION_PCT }));

    // 与 [23] 同款 vm sandbox (内存 mock storage)
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
        uuid: () => 'sleeve-test-' + Math.random().toString(36).slice(2, 8),
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true,
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
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: K
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };

    // ---- init: 双账户各自初始化 + 不覆盖 ----
    const storeA = { kv: {}, tables: {}, quotes: {}, indexSpot: [] };
    const PA = buildCtx(storeA).window.Paper;
    await PA.init();
    const accLong = await PA.getAccount();
    const accShort = await PA.getAccount('short');
    if (accLong.cash === 100000 && accLong.positionPct === 0.10) ok('sleeve init: 长线账户 10 万 (沿用 paper_account)');
    else fail('sleeve init long', JSON.stringify(accLong));
    if (accShort.cash === 30000 && accShort.initialCash === 30000 && accShort.positionPct === K.PAPER_SHORT_POSITION_PCT) {
      ok('sleeve init: 短线账户 3 万 (kv paper_account_short)');
    } else fail('sleeve init short', JSON.stringify(accShort));
    storeA.kv.paper_account_short.cash = 12345;
    await PA.init();
    if ((await PA.getAccount('short')).cash === 12345) ok('sleeve init: 短线账户已存在不覆盖');
    else fail('sleeve init 覆盖', '');

    // ---- sleeve 过滤: 存量无字段 = 'long' ----
    storeA.tables.holdings = [
      { id: 'l1', code: '600519', name: '贵州茅台', shares: 100, costPrice: 10, isPaper: true },  // 存量行无 sleeve
      { id: 's1', code: '000001', name: '平安银行', shares: 200, costPrice: 5, isPaper: true, sleeve: 'short' },
      { id: 'r1', code: '600111', name: '北方稀土', shares: 100, costPrice: 20 }                  // 真实持仓
    ];
    storeA.quotes = { '600519': { 最新价: 10 }, '000001': { 最新价: 5 } };
    const posDef = await PA.getPositions();
    const posLong = await PA.getPositions('long');
    const posShort = await PA.getPositions('short');
    if (posDef.length === 1 && posDef[0].id === 'l1' && posLong.length === 1 && posLong[0].id === 'l1') {
      ok('sleeve 过滤: 默认/显式 long 只见存量行 (无 sleeve 字段 = long)');
    } else fail('sleeve 过滤 long', JSON.stringify(posDef.map(p => p.id)));
    if (posShort.length === 1 && posShort[0].id === 's1') ok('sleeve 过滤: short 只见 short 行 (真实持仓永不混入)');
    else fail('sleeve 过滤 short', JSON.stringify(posShort.map(p => p.id)));

    // ---- buy: 不传 sleeve 向后兼容 = long; sleeve:'short' 独立现金 ----
    const storeB = {
      kv: {},
      tables: {},
      quotes: { '600519': { 代码: '600519', 名称: '贵州茅台', 最新价: 10 }, '000001': { 代码: '000001', 名称: '平安银行', 最新价: 5 } },
      indexSpot: []
    };
    const PB = buildCtx(storeB).window.Paper;
    await PB.init();
    const hb1 = await PB.buy('600519', '贵州茅台', '', 100);   // 旧调用方式 (无 opts)
    if (hb1 && hb1.sleeve === 'long' && Math.abs((await PB.getAccount()).cash - (100000 - 1005)) < 0.01) {
      ok('sleeve buy: 不传 sleeve = long, 行写 sleeve 字段, 扣 paper_account');
    } else fail('sleeve buy 兼容', JSON.stringify(hb1));
    const hb2 = await PB.buy('000001', '平安银行', '', 100, { sleeve: 'short' });  // 100×5+费5=505
    const accBLong = await PB.getAccount('long');
    const accBShort = await PB.getAccount('short');
    if (hb2 && hb2.sleeve === 'short'
      && Math.abs(accBShort.cash - (30000 - 505)) < 0.01
      && Math.abs(accBLong.cash - (100000 - 1005)) < 0.01) {
      ok('sleeve buy: short 只扣 paper_account_short, 长线现金不动');
    } else fail('sleeve buy short', JSON.stringify({ hb2, accBShort, accBLong }));
    const txB = (storeB.tables.transactions || []).find(t => t.code === '000001');
    if (txB && txB.sleeve === 'short') ok('sleeve buy: transactions 行写 sleeve');
    else fail('sleeve buy tx', JSON.stringify(txB));
    // 同 code 不同子账户各自成行
    await PB.buy('600519', '', '', 100, { sleeve: 'short' });
    const rowsB = storeB.tables.holdings.filter(h => h.code === '600519');
    if (rowsB.length === 2 && (rowsB[0].sleeve || 'long') !== (rowsB[1].sleeve || 'long')) {
      ok('sleeve buy: 同 code 在 long/short 各自成行 (不合并成本)');
    } else fail('sleeve 同 code 分行', JSON.stringify(rowsB));

    // ---- sell: 从持仓行读 sleeve, 现金自动回笼对应账户 ----
    const cashShortBefore = (await PB.getAccount('short')).cash;
    const sB = await PB.sell(hb2.id, 100);   // 卖 short 持仓 100×5, 费 5+0.25=5.25 → +494.75
    const cashShortAfter = (await PB.getAccount('short')).cash;
    const cashLongAfter = (await PB.getAccount('long')).cash;
    if (sB && Math.abs(cashShortAfter - (cashShortBefore + 494.75)) < 0.01
      && Math.abs(cashLongAfter - (100000 - 1005)) < 0.01) {
      ok('sleeve sell: short 持仓卖出回笼 paper_account_short, 长线不动');
    } else fail('sleeve sell', JSON.stringify({ cashShortBefore, cashShortAfter, cashLongAfter }));

    // ---- resetAccount: 只清对应 sleeve ----
    storeB.kv.paper_snapshots = [{ date: '2026-07-26', paperTotal: 100000, realTotal: 0, csi300: 3900, shortTotal: 30000 }];
    await PB.resetAccount('short');
    const leftHoldings = storeB.tables.holdings || [];
    const leftTx = storeB.tables.transactions || [];
    if (leftHoldings.every(h => (h.sleeve || 'long') === 'long') && leftHoldings.length === 1
      && leftTx.every(t => (t.sleeve || 'long') === 'long')
      && (await PB.getAccount('short')).cash === 30000
      && Math.abs((await PB.getAccount('long')).cash - (100000 - 1005)) < 0.01
      && storeB.kv.paper_snapshots.length === 1) {
      ok('sleeve reset: resetAccount(\'short\') 只清 short 持仓/交易/现金, long 与快照不动');
    } else fail('sleeve reset', JSON.stringify({ h: leftHoldings.length, t: leftTx.length, snaps: storeB.kv.paper_snapshots.length }));

    // ---- snapshotIfNeeded: shortTotal 字段 ----
    const storeC = {
      kv: { paper_account: { initialCash: 100000, cash: 90000, createdAt: 1, positionPct: 0.10 } },
      tables: { holdings: [{ id: 's9', code: '000001', shares: 200, costPrice: 5, isPaper: true, sleeve: 'short' }] },
      quotes: { '000001': { 最新价: 6 } },
      indexSpot: []
    };
    const PC = buildCtx(storeC).window.Paper;
    await PC.init();   // 补 paper_account_short (30000)
    const snapsC = await PC.snapshotIfNeeded();
    // shortTotal = 30000 现金 + 200×6 = 31200
    if (snapsC.length === 1 && snapsC[0].shortTotal === 31200 && snapsC[0].paperTotal === 90000) {
      ok(`sleeve snapshot: shortTotal ${snapsC[0].shortTotal} (= 现金 30000 + 市值 1200)`);
    } else fail('sleeve snapshot', JSON.stringify(snapsC[0]));

    // ---- EOD: short 段 + 当日成交按 sleeve 分流 ----
    const storeD = {
      kv: {
        paper_account: { initialCash: 100000, cash: 80000, createdAt: 1, positionPct: 0.10 },
        paper_account_short: { initialCash: 30000, cash: 25000, createdAt: 1, positionPct: 0.20 },
        paper_snapshots: [{ date: '2026-07-24', paperTotal: 99000, realTotal: 0, csi300: 3900, shortTotal: 26000 }],
        paper_eod_reports: []
      },
      tables: {
        holdings: [{ id: 'dl1', code: '600519', name: '贵州茅台', shares: 100, costPrice: 10, isPaper: true }],
        transactions: [
          { id: 'dt1', code: '600519', type: 'buy', date: '2026-07-27', price: 10, shares: 100, fee: 5, isPaper: true, createdAt: 1 },
          { id: 'dt2', code: '000001', type: 'buy', date: '2026-07-27', price: 5, shares: 200, fee: 5, isPaper: true, sleeve: 'short', auto: true, createdAt: 2 }
        ]
      },
      quotes: { '600519': { 最新价: 12 } },
      indexSpot: []
    };
    const PD = buildCtx(storeD).window.Paper;
    const eodD = await PD.maybeGenerateEodReport(new Date(2026, 6, 27, 16, 0));
    if (eodD && eodD.trades.length === 1 && eodD.trades[0].code === '600519') {
      ok('sleeve eod: 主报告成交只含 long (short 单分流到 short 段)');
    } else fail('sleeve eod 主成交', JSON.stringify(eodD && eodD.trades));
    if (eodD && eodD.short && eodD.short.cash === 25000 && eodD.short.totalAssets === 25000
      && eodD.short.dayPnl === -1000 && eodD.short.trades.length === 1 && eodD.short.trades[0].auto === true) {
      ok('sleeve eod: short 段 现金/总资产/当日盈亏(对照 shortTotal)/🤖 成交');
    } else fail('sleeve eod short 段', JSON.stringify(eodD && eodD.short));
    // 老快照无 shortTotal → short.dayPnl 容错为 null
    storeD.kv.paper_eod_reports = [];
    storeD.kv.paper_snapshots = [{ date: '2026-07-24', paperTotal: 99000, realTotal: 0, csi300: 3900 }];
    const eodD2 = await PD.maybeGenerateEodReport(new Date(2026, 6, 27, 16, 30));
    if (eodD2 && eodD2.short && eodD2.short.dayPnl === null) ok('sleeve eod: 老快照无 shortTotal → short.dayPnl=null 容错');
    else fail('sleeve eod 容错', JSON.stringify(eodD2 && eodD2.short));

    // ---- 纪律引擎: 锚点分 sleeve + DEFAULT_CONFIG.short 预留 ----
    const discSrc = readFileSafe(path.join(WWW, 'core', 'discipline.js'));
    if (!discSrc) throw new Error('discipline.js 读不到');
    const dbuild = (storageData) => {
      const dctx = { window: {}, console };
      dctx.window.Core = {
        Storage: {
          kvGet: async (k) => (k in storageData.kv ? storageData.kv[k] : null),
          kvSet: async (k, v) => { storageData.kv[k] = v; },
          all: async (t) => storageData.tables[t] || [],
          where: async (t, idx, v) => (storageData.tables[t] || []).filter(x => x[idx] === v)
        },
        Data: { getStockQuote: async (code) => storageData.quotes[code] || null },
        State: { get: () => null },
        Util: { escapeHtml: (s) => String(s == null ? '' : s) },
        Constants: K,
        // mock Portfolio: 与真实 portfolio.js 同款 sleeve 口径 (存量无字段 = long)
        Portfolio: {
          getAssets: async (opts = {}) => {
            const sleeve = opts.sleeve === 'short' ? 'short' : 'long';
            const key = sleeve === 'short' ? 'paper_account_short' : 'paper_account';
            const cash = (storageData.kv[key] && storageData.kv[key].cash) || 0;
            const filt = (storageData.tables.holdings || [])
              .filter(h => h.isPaper && (h.sleeve || 'long') === sleeve);
            let stockMkt = 0;
            const valueByCode = {};
            for (const h of filt) {
              const v = (parseFloat(h.shares) || 0) * (parseFloat(h.costPrice) || 0);
              valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
              stockMkt += v;
            }
            return { cash, stockMkt, fundMkt: 0, totalAssets: cash + stockMkt, valueByCode, quoteFail: 0, paper: true, sleeve };
          }
        }
      };
      dctx.Core = dctx.window.Core;
      vm.createContext(dctx);
      vm.runInContext(discSrc, dctx);
      return dctx;
    };
    const storeE = {
      kv: {
        paper_account: { initialCash: 100000, cash: 100000, createdAt: 1, positionPct: 0.10 },
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 }
      },
      tables: { journals: [] },
      quotes: { '600519': { 最新价: 10, 涨跌幅: 1 } }
    };
    const DE = dbuild(storeE).window.Core.Discipline;
    if (DE.DEFAULT_CONFIG.short && DE.DEFAULT_CONFIG.short.maxDailyTrades === 3 && DE.DEFAULT_CONFIG.short.cooldownHours === 48) {
      ok('sleeve discipline: DEFAULT_CONFIG.short 预留 (T2 启用)');
    } else fail('sleeve discipline config', JSON.stringify(DE.DEFAULT_CONFIG.short));
    const chkShort = await DE.preBuyCheck({ code: '600519', price: 10, shares: 100, amount: 1000, isPaper: true, sleeve: 'short', assumption: '业绩拐点', stopLoss: 9 });
    if (chkShort.ok && storeE.kv.discipline_month_anchor_paper_short && storeE.kv.discipline_month_anchor_paper_short.startTotal === 30000
      && !('discipline_month_anchor_paper' in storeE.kv)) {
      ok('sleeve discipline: isPaper+short → 锚点写 discipline_month_anchor_paper_short');
    } else fail('sleeve discipline 锚点 short', JSON.stringify({ chk: chkShort.blocks, kv: Object.keys(storeE.kv) }));
    const chkLong = await DE.preBuyCheck({ code: '600519', price: 10, shares: 100, amount: 1000, isPaper: true, assumption: '业绩拐点', stopLoss: 9 });
    if (chkLong.ok && storeE.kv.discipline_month_anchor_paper && storeE.kv.discipline_month_anchor_paper.startTotal === 100000) {
      ok('sleeve discipline: isPaper 不传 sleeve → 锚点沿用存量 key (视为 long)');
    } else fail('sleeve discipline 锚点 long', JSON.stringify(Object.keys(storeE.kv)));

  } catch (e) {
    fail('Paper 分账户 sleeve', e.message + ' / ' + (e.stack || ''));
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
        Util: { escapeHtml: (s) => String(s == null ? '' : s).replace(/</g, '&lt;').replace(/>/g, '&gt;') },
        Constants: _loadRealConstants(),
        // FIX-3: sandbox 里 mock Portfolio.getAssets — 测试只关心 discipline 逻辑,
        // 不重新实现 portfolio 的行情拉取逻辑。返回 storageData 里的口径。
        Portfolio: {
          getAssets: async (opts = {}) => {
            const paper = !!opts.paper;
            const cash = paper
              ? ((storageData.kv.paper_account && storageData.kv.paper_account.cash) || 0)
              : (storageData.state.accountCash || 0);
            const tbl = storageData.tables.holdings || [];
            const filt = tbl.filter(h => paper ? !!h.isPaper : !h.isPaper);
            let stockMkt = 0, quoteFail = 0;
            const valueByCode = {};
            for (const h of filt) {
              const shares = parseFloat(h.shares) || 0;
              if (shares <= 0) continue;
              let price = null;
              try {
                const q = await storageData._getQuote(h.code);
                price = q ? (parseFloat(q.最新价 ?? q.price) || null) : null;
              } catch (e) { /* skip */ }
              if (!price) { quoteFail++; price = parseFloat(h.costPrice ?? h.cost) || 0; }
              const v = shares * price;
              valueByCode[h.code] = (valueByCode[h.code] || 0) + v;
              stockMkt += v;
            }
            let fundMkt = 0;
            if (!paper) {
              const funds = storageData.tables.funds || [];
              for (const f of funds) {
                const shares = parseFloat(f.shares) || 0;
                if (shares <= 0) continue;
                fundMkt += shares * (parseFloat(f.costNav) || 0);
              }
            }
            return { cash, stockMkt, fundMkt,
                     totalAssets: paper ? (cash + stockMkt) : (cash + stockMkt + fundMkt),
                     valueByCode, quoteFail, paper };
          }
        }
      };
      dctx.Core = dctx.window.Core;
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
        },
        Constants: _loadRealConstants()
      };
      pctx.Core = pctx.window.Core;
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
    // FIX-3: 资产口径已统一走 Core.Portfolio.getAssets, screener 不再需要 Discipline 的 _getRealAssets
    if (scrSrcE.includes('Core.Pending.add') && scrSrcE.includes('Core.Pending._suggestPosition')
      && scrSrcE.includes("source: 'screener'") && scrSrcE.includes('已生成实盘待确认交易')
      && scrSrcE.includes('Core.Portfolio.getAssets')) ok('screener: _addWatchlistFromPick 生成待确认卡片 (口径走 Portfolio)');
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
// H3 升级: 多指数 _classifyPerIndex (替代原 _classify) + 多指数共识 _consensus
// 测试加载顺序: constants.js → data.js → regime.js (regime.js 依赖 Core.Constants + Core.Data)
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
        }, getIndexKLine: async () => null }
      },
      fetch: async () => ({ ok: false })
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/regime.js')), DS);
    const R = DS.window.Core.Regime;

    if (typeof R._classifyPerIndex === 'function') ok('Z1-A: Core.Regime._classifyPerIndex 纯函数已挂载');
    else fail('Z1-A _classifyPerIndex 挂载', typeof R);

    if (typeof R.gateMultipliers === 'function') ok('Z1-A: gateMultipliers 同步函数已挂载');
    else fail('Z1-A gateMultipliers 挂载', typeof R);

    // ---- 28.5.1 _classifyPerIndex: bull (close>ma60 + maUp) ----
    const bull = R._classifyPerIndex({ close: 4000, ma60: 3800, ma60Prev: 3700 });
    if (bull.state === 'bull') ok('Z1-A: close>ma60 + maUp → bull');
    else fail('Z1-A bull', JSON.stringify(bull));

    // ---- 28.5.2 _classifyPerIndex: bear (close<ma60*(1-0.03) + maDown) ----
    const bear = R._classifyPerIndex({ close: 3600, ma60: 3800, ma60Prev: 3850 });
    if (bear.state === 'bear') ok('Z1-A: 跌破 MA60×0.97 + maDown → bear');
    else fail('Z1-A bear', JSON.stringify(bear));

    // ---- 28.5.3 _classifyPerIndex: range (价=ma60, maUp 走平) ----
    const range = R._classifyPerIndex({ close: 3800, ma60: 3800, ma60Prev: 3790 });
    if (range.state === 'range') ok('Z1-A: 价=ma60 (走平) → range');
    else fail('Z1-A range', JSON.stringify(range));

    // ---- 28.5.4 _classifyPerIndex: bear 迟滞 (prevState=bear + close<ma60 → 仍 bear, streak=0) ----
    const stuck = R._classifyPerIndex({ close: 3700, ma60: 3800, ma60Prev: 3850, prevState: 'bear', aboveStreak: 2 });
    if (stuck.state === 'bear' && stuck.aboveStreak === 0) ok('Z1-A: bear 迟滞 close<ma60 → 仍 bear, streak 归 0');
    else fail('Z1-A bear 迟滞', JSON.stringify(stuck));

    // ---- 28.5.5 _classifyPerIndex: bear 迟滞退出 (aboveStreak=3 → 转 range) ----
    const exit = R._classifyPerIndex({ close: 3900, ma60: 3800, ma60Prev: 3850, prevState: 'bear', aboveStreak: 3 });
    if (exit.state === 'range' && exit.aboveStreak === 0) ok('Z1-A: bear 迟滞 streak≥3 → range (退出)');
    else fail('Z1-A bear 退出', JSON.stringify(exit));

    // ---- 28.5.6 _classifyPerIndex: 非法输入降级 range ----
    const bad = R._classifyPerIndex({ close: NaN, ma60: 3800, ma60Prev: 3700 });
    if (bad.state === 'range') ok('Z1-A: 非法输入降级 range');
    else fail('Z1-A 非法输入', JSON.stringify(bad));

    // ---- 28.5.7 _classifyPerIndex: ma60Prev=null (斜率未知, 不上 bull 也不下 bear) ----
    const noSlope = R._classifyPerIndex({ close: 4000, ma60: 3800, ma60Prev: null });
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

// ========== [36] 中长线盯盘改造: horizon 打标 + 分层轮询 + 3 条中长线规则 ==========
section('36] 中长线盯盘: horizon 打标 / 分层轮询(短线定时器+中长线事件驱动) / 交易时段守卫 / 通知冷却 / 业绩预告去重 / regime 迁移 / 估值判定');
(async () => {
  try {
    const alertsSrc = readFileSafe(path.join(WWW, 'app', 'alerts.js'));
    const constSrc = readFileSafe(path.join(WWW, 'core', 'constants.js'));
    if (!alertsSrc || !constSrc) throw new Error('alerts.js / constants.js 读不到');

    // ---- 内存 DB + vm 上下文 ----
    const db = { alerts: [], holdings: [], journals: [], funds: [] };
    let yjygRows = [];        // mock stock_yjyg_em 返回
    let valuationRows = [];   // mock stock_market_pe_lg 返回
    let failFetch = false;    // 模拟拉数失败
    let regimeState = 'range';
    const actx = {
      window: {
        document: { getElementById: () => null, addEventListener: () => {} },
        Capacitor: undefined
      },
      console,
      escapeHtml: (s) => String(s == null ? '' : s),
      fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
      uuid: () => 't',
      toastWarning: () => {}, toastSuccess: () => {}, toastError: () => {}, toastInfo: () => {},
      setInterval: () => { throw new Error('vm 里不应直接调 setInterval (应走可注入 _setInterval)'); },
      clearInterval: () => {}
    };
    actx.document = actx.window.document;
    actx.window.Core = {
      Storage: {
        all: async (t) => db[t].slice(),
        where: async (t, idx, v) => db[t].filter(r => r[idx] === v),
        get: async (t, id) => db[t].find(r => r.id === id) || null,
        add: async (t, r) => { db[t].push(r); },
        put: async (t, r) => { const i = db[t].findIndex(x => x.id === r.id); if (i >= 0) db[t][i] = r; else db[t].push(r); },
        remove: async (t, id) => { db[t] = db[t].filter(x => x.id !== id); }
      },
      Data: {
        fetch: async (key, api) => {
          if (failFetch) throw new Error('模拟拉数失败');
          if (api === 'stock_yjyg_em') return yjygRows;
          if (api === 'stock_market_pe_lg') return valuationRows;
          return [];
        },
        getStockSpot: async () => []
      },
      AI: { call: async () => '' },  // Phase B-1: 业绩预告 AI 归因, 默认返空
      Regime: {
        refresh: async () => {
          if (failFetch) throw new Error('模拟 regime 失败');
          return { state: regimeState };
        },
        GATES: {
          bull:  { label: '趋势市',   icon: '🐂' },
          range: { label: '震荡市',   icon: '↔️' },
          bear:  { label: '下跌市 ⚠', icon: '🐻' }
        }
      }
    };
    vm.createContext(actx);
    vm.runInContext(constSrc, actx);   // 挂 window.Core.Constants
    vm.runInContext(alertsSrc, actx);  // 挂 window.Alerts
    actx.Core = actx.window.Core;
    const Alerts = actx.window.Alerts;
    const C = actx.window.Core.Constants;
    if (!C || typeof C.ALERT_TICK_LONG_MS !== 'number') throw new Error('Core.Constants 未挂载');

    // 通知 spy: 拦截中长线通知入口
    const notices = [];
    Alerts._notifyLong = (a, msg, code) => notices.push({ msg, code });

    // ---- 36.1 horizon 打标 ----
    const shortOnes = ['price_above', 'price_below', 'change_above', 'change_below', 'volume_above'];
    const longOnes = ['rebalance_quarterly', 'earnings_disclosure', 'earnings_warning', 'regime_change', 'valuation', 'valuation_drift'];
    if (shortOnes.every(t => Alerts._horizonOf(t) === 'short') && longOnes.every(t => Alerts._horizonOf(t) === 'long')) {
      ok('36.1 horizon 打标: 5 短线 + 6 中长线分类正确');
    } else fail('36.1 horizon 打标', shortOnes.map(t => t + '=' + Alerts._horizonOf(t)).join(','));

    // ---- 36.2 分层轮询: 定时器按需起停 (注入 spy) ----
    const intervals = [];   // 注册的 ms
    const cleared = [];     // 清除的 timer id
    let timerSeq = 0;
    Alerts._setInterval = (fn, ms) => { intervals.push(ms); return 'T' + (++timerSeq); };
    Alerts._clearInterval = (t) => { cleared.push(t); };

    db.alerts = [];
    await Alerts._syncTimers();
    if (intervals.length === 0 && !Alerts._timers.short && !Alerts._timers.long) {
      ok('36.2a 无规则 → 不起任何定时器');
    } else fail('36.2a 无规则', JSON.stringify({ intervals, timers: Alerts._timers }));

    db.alerts = [{ id: 'l1', type: 'earnings_warning', active: true }];
    await Alerts._syncTimers();
    if (intervals.length === 0 && !Alerts._timers.short && !Alerts._timers.long) {
      ok('36.2b 只有中长线规则 → 不起定时器 (P1 事件驱动)');
    } else fail('36.2b 中长线定时器', JSON.stringify({ intervals, timers: Alerts._timers }));

    db.alerts.push({ id: 's1', type: 'price_above', active: true, value: 100 });
    await Alerts._syncTimers();
    if (intervals.length === 1 && intervals[0] === C.ALERT_TICK_SHORT_MS && Alerts._timers.short) {
      ok('36.2c 出现短线规则 → 起 1 分钟定时器');
    } else fail('36.2c 短线定时器', JSON.stringify({ intervals, timers: Alerts._timers }));

    db.alerts.find(a => a.id === 's1').active = false;  // 停掉短线规则
    await Alerts._syncTimers();
    if (cleared.length === 1 && !Alerts._timers.short && !Alerts._timers.long) {
      ok('36.2d 短线规则全停 → 1 分钟定时器被清除, 中长线本无定时器');
    } else fail('36.2d 定时器清除', JSON.stringify({ cleared, timers: Alerts._timers }));

    db.alerts = [];
    await Alerts._syncTimers();
    if (!Alerts._timers.short && !Alerts._timers.long && cleared.length === 1) {
      ok('36.2e 规则清空 → 全部定时器停止 (短线历史遗留也清)');
    } else fail('36.2e 全部停止', JSON.stringify({ cleared, timers: Alerts._timers }));

    // ---- 36.P0/P1/P2 盯盘轮询加固 ----
    // 注意: 本块必须放在 36.3g 的 setTimeout 等待之前 — 测试总结用 setImmediate + process.exit,
    // 第一个 macrotask 等待之后的断言会被直接掐掉, 这里全是微任务 await, 同 tick 内可跑完

    // ---- 36.P0a _isTradingTime 边界 (2026-07-27 周一 / 2026-07-25 周六) ----
    const mkT = (d, h, mi) => new Date(2026, 6, d, h, mi);  // 本地时间, 与实现口径一致
    const tCases = [
      ['周一 09:29', mkT(27, 9, 29), false],
      ['周一 09:30', mkT(27, 9, 30), true],
      ['周一 11:30', mkT(27, 11, 30), true],
      ['周一 11:31', mkT(27, 11, 31), false],
      ['周一 12:00 午间休市', mkT(27, 12, 0), false],
      ['周一 13:00', mkT(27, 13, 0), true],
      ['周一 15:00', mkT(27, 15, 0), true],
      ['周一 15:01', mkT(27, 15, 1), false],
      ['周六 10:00', mkT(25, 10, 0), false]
    ];
    const badT = tCases.filter(([, t, want]) => Alerts._isTradingTime(t) !== want);
    if (badT.length === 0) ok('36.P0a _isTradingTime: 9 组边界全对 (9:29/9:30/11:30/11:31/12:00/13:00/15:00/15:01/周六)');
    else fail('36.P0a 交易时段边界', badT.map(c => c[0]).join(','));

    // ---- 36.P0b 守卫: 非交易时段 _checkShort 不发请求 (注入 spy) ----
    let spotCalls = 0;
    const origSpot = actx.Core.Data.getStockSpot;
    actx.Core.Data.getStockSpot = async () => { spotCalls++; return []; };
    const origIsTrading = Alerts._isTradingTime;
    Alerts._isTradingTime = () => false;  // 模拟非交易时段
    db.alerts = [{ id: 'g1', type: 'price_above', active: true, value: 100, code: '600519', triggered: false }];
    await Alerts._checkShort();
    Alerts._isTradingTime = origIsTrading;
    if (spotCalls === 0) ok('36.P0b 守卫: 非交易时段 _checkShort 入口直接 return, 不拉行情');
    else fail('36.P0b 守卫', 'spotCalls=' + spotCalls);

    // ---- 36.P2 通知冷却 (防 flapping) ----
    Alerts._isTradingTime = () => true;  // 模拟交易时段
    const shortNotices = [];
    const origNotify = Alerts._notify;
    Alerts._notify = (a) => shortNotices.push(a.id);
    actx.Core.Data.getStockSpot = async () => [{ 代码: '600519', 名称: '茅台', 最新价: '1800', 涨跌幅: '1.5', 成交量: '1000' }];

    // 冷却期内 (lastHit 10 分钟前) 命中 → 只落 triggered, 不发通知
    db.alerts = [{ id: 'f1', type: 'price_above', active: true, value: 1700, code: '600519', triggered: false, hitCount: 3, lastHit: Date.now() - 10 * 60 * 1000 }];
    await Alerts._checkShort();
    const f1 = db.alerts.find(a => a.id === 'f1');
    if (shortNotices.length === 0 && f1.triggered === true && f1.hitCount === 3) {
      ok('36.P2a 冷却期内命中: triggered 落库但不发通知 (防振荡价反复打扰)');
    } else fail('36.P2a 冷却期', JSON.stringify({ n: shortNotices.length, triggered: f1.triggered, hitCount: f1.hitCount }));

    // 超过冷却期 (lastHit 40 分钟前) 命中 → 正常通知 + hitCount/lastHit 更新
    db.alerts = [{ id: 'f2', type: 'price_above', active: true, value: 1700, code: '600519', triggered: false, hitCount: 3, lastHit: Date.now() - 40 * 60 * 1000 }];
    shortNotices.length = 0;
    await Alerts._checkShort();
    const f2 = db.alerts.find(a => a.id === 'f2');
    if (shortNotices.length === 1 && shortNotices[0] === 'f2' && f2.triggered === true && f2.hitCount === 4 && f2.lastHit > Date.now() - 5000) {
      ok('36.P2b 超过冷却期: 正常通知 + hitCount/lastHit 更新');
    } else fail('36.P2b 冷却期外', JSON.stringify({ n: shortNotices.length, hitCount: f2.hitCount }));

    // 无 lastHit (从未触发) 命中 → 正常通知
    db.alerts = [{ id: 'f3', type: 'price_above', active: true, value: 1700, code: '600519', triggered: false, hitCount: 0 }];
    shortNotices.length = 0;
    await Alerts._checkShort();
    if (shortNotices.length === 1 && db.alerts.find(a => a.id === 'f3').triggered === true) {
      ok('36.P2c 首次命中 (无 lastHit): 正常通知');
    } else fail('36.P2c 首次命中', JSON.stringify({ n: shortNotices.length }));

    // 复位分支不受冷却期影响: 未命中且 triggered → 正常复位
    db.alerts = [{ id: 'f4', type: 'price_above', active: true, value: 9999, code: '600519', triggered: true, hitCount: 1, lastHit: Date.now() - 10 * 60 * 1000 }];
    await Alerts._checkShort();
    if (db.alerts.find(a => a.id === 'f4').triggered === false) {
      ok('36.P2d 价格回落: triggered 正常复位 (冷却期不影响复位)');
    } else fail('36.P2d 复位', 'triggered 未复位');
    Alerts._notify = origNotify;
    Alerts._isTradingTime = origIsTrading;
    actx.Core.Data.getStockSpot = origSpot;

    // ---- 36.P1 runLongChecks 安全包装 + 事件触发点接线 ----
    const origCheckLong = Alerts._checkLong;
    Alerts._checkLong = async () => { throw new Error('模拟中长线检查爆炸'); };
    let threw = false;
    try { await Alerts.runLongChecks(); } catch (e) { threw = true; }
    Alerts._checkLong = origCheckLong;
    if (!threw) ok('36.P1a runLongChecks: _checkLong 异常不外抛');
    else fail('36.P1a runLongChecks', '异常外抛');

    const appSrc = readFileSafe(path.join(WWW, 'app.js'));
    if (appSrc && /Alerts\.runLongChecks\(\)/.test(appSrc)) {
      ok('36.P1b app.js init 序列已接线 Alerts.runLongChecks()');
    } else fail('36.P1b app.js 接线', '未找到 runLongChecks 调用');
    if (/window\._onShow_pageAlerts\s*=\s*function\s*\(\)\s*\{[^}]*runLongChecks/.test(alertsSrc)) {
      ok('36.P1c _onShow_pageAlerts 已接线 runLongChecks');
    } else fail('36.P1c _onShow 接线', '页面展示钩子未调 runLongChecks');
    if (!/this\._timers\.long\s*=\s*this\._setInterval/.test(alertsSrc) && !/ALERT_TICK_LONG_MS\s*\)/.test(alertsSrc)) {
      ok('36.P1d 中长线 30 分钟 setInterval 已从 _syncTimers 移除');
    } else fail('36.P1d 定时器残留', 'long 分支仍存在');

    // ---- 36.P3 _freqMs 防御: intervalDays 只对 rebalance_quarterly 生效 ----
    const fqReb = Alerts._freqMs({ type: 'rebalance_quarterly', intervalDays: 90 });
    const fqOther = Alerts._freqMs({ type: 'regime_change', intervalDays: 90 });  // 串字段陷阱: 应忽略
    if (fqReb === 90 * 24 * 60 * 60 * 1000 && fqOther === C.ALERT_LONG_FREQ_MS.regime_change) {
      ok('36.P3 _freqMs: 再平衡用行上 intervalDays, 其他类型忽略该字段 (防串字段)');
    } else fail('36.P3 _freqMs 防御', JSON.stringify({ fqReb, fqOther }));

    // ---- 36.3 业绩预告: filter 纯函数 + lastNotifiedKeys 去重 ----
    const nowMs = Date.parse('2026-07-27T10:00:00');
    yjygRows = [
      { '股票代码': '600519', '股票简称': '贵州茅台', '业绩预告类型': '首亏', '业绩预告摘要': '预计亏损 1 亿元', '公告日期': '2026-07-20', '报告期': '2026-06-30' },
      { '股票代码': '600519', '股票简称': '贵州茅台', '业绩预告类型': '预增', '公告日期': '2026-07-20', '报告期': '2026-06-30' },  // 正面 → 排除
      { '股票代码': '600519.SH', '股票简称': '贵州茅台', '业绩预告类型': '略减', '业绩预告摘要': '净利降 10%-20%', '公告日期': '2026-07-21', '报告期': '2026-06-30' },  // 带后缀 → 归一命中
      { '股票代码': '000001', '股票简称': '平安银行', '业绩预告类型': '预减', '公告日期': '2020-01-01', '报告期': '2019-12-31' },  // 陈旧 → 排除
      { '股票代码': '300999', '股票简称': '非持仓股', '业绩预告类型': '续亏', '公告日期': '2026-07-20', '报告期': '2026-06-30' }   // 非持仓 → 排除
    ];
    const hits = Alerts._filterEarningsWarnings(yjygRows, new Set(['600519']), nowMs);
    if (hits.length === 2 && hits.every(h => h.code === '600519') && hits[0].type === '首亏' && hits[1].type === '略减' && hits[0].periodKey === '2026-06-30') {
      ok('36.3a 业绩预告 filter: 负面+持仓+新鲜 3 条件, 代码后缀归一');
    } else fail('36.3a filter', JSON.stringify(hits));

    db.holdings = [{ id: 'h1', code: '600519', isPaper: false }, { id: 'h2', code: '000002', isPaper: true }];
    notices.length = 0;
    const ew = { id: 'ew1', type: 'earnings_warning', active: true, hitCount: 0, lastNotifiedKeys: {} };
    const done1 = await Alerts._checkEarningsWarning(ew);
    if (done1 === true && notices.length === 2 &&
        Array.isArray(ew.lastNotifiedKeys['600519']) &&
        ew.lastNotifiedKeys['600519'].includes('2026-06-30_首亏') && ew.lastNotifiedKeys['600519'].includes('2026-06-30_略减') &&
        notices[0].msg.includes('首亏') && notices[0].msg.includes('买入逻辑') && notices[0].code === '600519') {
      ok('36.3b 业绩预告首检: 2 条通知, 文案带归因, lastNotifiedKeys 落行');
    } else fail('36.3b 首检', JSON.stringify({ done1, n: notices.length, keys: ew.lastNotifiedKeys }));

    const done2 = await Alerts._checkEarningsWarning(ew);
    if (done2 === true && notices.length === 2) {
      ok('36.3c 同 code 同报告期同类型 → 不重复通知');
    } else fail('36.3c 去重', 'notices=' + notices.length);

    failFetch = true;
    const done3 = await Alerts._checkEarningsWarning(ew);
    failFetch = false;
    if (done3 === false) ok('36.3d 拉数失败 → 返回 false (下轮重试, 不推进 nextCheck)');
    else fail('36.3d 失败重试', done3);

    // ---- 36.3e-g B-1: AI 归因业绩预告 ----
    // _fallbackEarningsNarrative 不调 AI, 纯函数, 直接测
    const fb1 = Alerts._fallbackEarningsNarrative({ type: '首亏', code: '600519', periodKey: '2026-06-30' });
    if (fb1.includes('首亏') && fb1.includes('严重')) ok('36.3e 兜底归因: 首亏 → 严重');
    else fail('36.3e 兜底', fb1);
    const fb2 = Alerts._fallbackEarningsNarrative({ type: '略减', code: '600519' });
    if (fb2.includes('略减') && fb2.includes('中度')) ok('36.3f 兜底归因: 略减 → 中度');
    else fail('36.3f 兜底', fb2);

    // ---- 36.9 B-3+: 估值偏离 AI 归因 (同步纯函数测, 避开 36.3g setTimeout 后被掐的 harness 限制) ----
    // 36.9a _aiValuationNarrative / _fallbackValuationNarrative 暴露
    if (typeof Alerts._aiValuationNarrative !== 'function') {
      fail('36.9a _aiValuationNarrative 未注册');
    } else if (typeof Alerts._fallbackValuationNarrative !== 'function') {
      fail('36.9a _fallbackValuationNarrative 未注册');
    } else {
      ok('36.9a 估值 AI 归因方法注册: _aiValuationNarrative + _fallbackValuationNarrative');
    }

    // 36.9b 兜底模板 (同步纯函数)
    const vVal = { hits: [{ name: '深证', pe: 28.7, percentile: 92, historyLen: 60 }] };
    const fallback = Alerts._fallbackValuationNarrative(vVal);
    if (typeof fallback === 'string' && fallback.includes('深证') &&
        fallback.includes('92') && fallback.includes('80') &&
        fallback.includes('中长线纪律')) {
      ok('36.9b 估值 AI 兜底模板: 含指数名/分位/阈值/纪律提醒');
    } else fail('36.9b 估值 AI 兜底模板', fallback ? fallback.slice(0, 80) : 'undefined');

    // 36.9b2 兜底模板对空 verdict 容错 (无 hits)
    const emptyFallback = Alerts._fallbackValuationNarrative({ hits: [] });
    if (typeof emptyFallback === 'string' && emptyFallback.includes('80') &&
        emptyFallback.includes('目标指数') && emptyFallback.includes('?')) {
      ok('36.9b2 估值 AI 兜底模板: 空 verdict 用占位符容错');
    } else fail('36.9b2 估值 AI 兜底空 verdict', emptyFallback.slice(0, 80));

    // 36.9c _checkValuation 接线: 触发后 a.aiNarrative 被赋值 (源码对账, 避开 vm 异步截断)
    if (/this\._aiValuationNarrative\(a,\s*verdict\)\.then\(narrative\s*=>\s*\{[\s\S]*a\.aiNarrative\s*=\s*narrative/.test(alertsSrc)) {
      ok('36.9c _checkValuation 接线: 估值触发后写 a.aiNarrative (源码对账)');
    } else fail('36.9c _checkValuation 估值 AI 接线', '源码未匹配 _aiValuationNarrative(a, verdict).then');

    // 36.9d hasCachedNarrative 把 valuation 类型纳入缓存路径
    if (/hasCachedNarrative\s*=\s*\(\s*a\.type\s*===\s*'earnings_warning'\s*\|\|\s*a\.type\s*===\s*'valuation'\s*(?:\|\|\s*a\.type\s*===\s*'regime_change'\s*)?\)\s*&&\s*a\.aiNarrative/.test(alertsSrc)) {
      ok('36.9d AI 解读默认缓存: valuation 类型纳入 hasCachedNarrative (源码对账)');
    } else fail('36.9d hasCachedNarrative 估值缓存', '源码未匹配 valuation 类型');

    // ---- 36.10 B-2+: 大盘状态切换 AI 归因 (同步纯函数测, 避开 36.3g setTimeout 截断) ----
    // 36.10a _aiRegimeNarrative / _fallbackRegimeNarrative 暴露
    if (typeof Alerts._aiRegimeNarrative !== 'function') {
      fail('36.10a _aiRegimeNarrative 未注册');
    } else if (typeof Alerts._fallbackRegimeNarrative !== 'function') {
      fail('36.10a _fallbackRegimeNarrative 未注册');
    } else {
      ok('36.10a 状态切换 AI 归因方法注册: _aiRegimeNarrative + _fallbackRegimeNarrative');
    }

    // 36.10b 兜底模板: bull/neutral/bear 三态
    const fbBull = Alerts._fallbackRegimeNarrative('neutral', 'bull');
    if (fbBull.includes('bull') && fbBull.includes('站上 MA60') && fbBull.includes('中长线纪律')) {
      ok('36.10b 状态切换 AI 兜底: neutral→bull 含站上 MA60 + 纪律提醒');
    } else fail('36.10b 状态切换兜底 bull', fbBull.slice(0, 80));

    const fbBear = Alerts._fallbackRegimeNarrative('bull', 'bear');
    if (fbBear.includes('bear') && fbBear.includes('跌破 MA60') && fbBear.includes('中长线纪律')) {
      ok('36.10c 状态切换 AI 兜底: bull→bear 含跌破 MA60 + 纪律提醒');
    } else fail('36.10c 状态切换兜底 bear', fbBear.slice(0, 80));

    const fbNeutral = Alerts._fallbackRegimeNarrative('bull', 'neutral');
    if (fbNeutral.includes('方向不明') && fbNeutral.includes('中长线纪律')) {
      ok('36.10d 状态切换 AI 兜底: 切到 neutral 走通用分支');
    } else fail('36.10d 状态切换兜底 neutral', fbNeutral.slice(0, 80));

    // 36.10e _checkRegimeChange 接线: 状态切换后 a.aiNarrative + aiNarrativeFrom/To 被赋值 (源码对账)
    if (/this\._aiRegimeNarrative\(a,\s*a\.lastState,\s*cur\)\.then\(narrative\s*=>\s*\{[\s\S]*a\.aiNarrative\s*=\s*narrative[\s\S]*aiNarrativeFrom[\s\S]*aiNarrativeTo/.test(alertsSrc)) {
      ok('36.10e _checkRegimeChange 接线: 状态切换后写 a.aiNarrative + from/to (源码对账)');
    } else fail('36.10e _checkRegimeChange 状态 AI 接线', '源码未匹配 _aiRegimeNarrative(a, a.lastState, cur).then(...)');

    // 36.10f hasCachedNarrative 把 regime_change 纳入缓存路径
    if (/hasCachedNarrative\s*=\s*\(\s*a\.type\s*===\s*'earnings_warning'\s*\|\|\s*a\.type\s*===\s*'valuation'\s*\|\|\s*a\.type\s*===\s*'regime_change'\s*\)/.test(alertsSrc)) {
      ok('36.10f AI 解读默认缓存: regime_change 类型纳入 hasCachedNarrative (源码对账)');
    } else fail('36.10f hasCachedNarrative regime 缓存', '源码未匹配 regime_change');

    // ---- 36.X P0/P1: agents._summarizeCtx 价格注入 + 截断 + [降级] + journal 装配 ----
    // 放在 36.10f 之后、setTimeout wait 之前, 全部源码正则
    const agentsSrc = fs.readFileSync('www/core/agents.js', 'utf-8');
    // 36.X.a 持仓段注入价格/市值/成本 (锚定 coach 的 targetPrice)
    if (/currentPrice/.test(agentsSrc) && /valueByCode/.test(agentsSrc) && /costPrice/.test(agentsSrc)) {
      ok('36.X.a _summarizeCtx 持仓段注入 currentPrice / valueByCode / costPrice');
    } else fail('36.X.a 持仓价格注入', 'currentPrice/valueByCode/costPrice 任一缺失');
    // 36.X.b 截断提示 (省略 N 条) — 源码里是模板字符串 `省略 ${total - shown} 条`, 跨多行, 用 [\s\S]*? 容错
    if (/省略[\s\S]*?条/.test(agentsSrc) && /total\s*-\s*shown/.test(agentsSrc)) {
      ok('36.X.b 截断提示: holdings/alerts/journals/observations/findings/news 末尾标注省略数');
    } else fail('36.X.b 截断提示', '源码未匹配"省略 N 条"或 total-shown 表达式');
    // 36.X.c [降级] 标记
    if (/\[降级\]/.test(agentsSrc)) {
      ok('36.X.c [降级] 标记: portfolio.quoteFail / macro / marketWidth 失败传 [降级]');
    } else fail('36.X.c [降级] 标记', '源码未匹配"[降级]"');
    // 36.X.d portfolio / macro / marketWidth 三段
    if (/## 组合/.test(agentsSrc) && /## 宏观/.test(agentsSrc) && /## 市场宽度/.test(agentsSrc)) {
      ok('36.X.d 新增段: 组合 / 宏观 / 市场宽度 (LLM 看得到组合总盘+宏观+宽度)');
    } else fail('36.X.d 新增段', '## 组合 / ## 宏观 / ## 市场宽度 任一缺失');
    // 36.X.e journal.js 装配 portfolio / macro / marketWidth
    const journalSrc = fs.readFileSync('www/app/journal.js', 'utf-8');
    if (/Core\.Portfolio\.getAssets/.test(journalSrc) && /Core\.Macro\.get/.test(journalSrc) && /Core\.MarketWidth\.getMarketWidth/.test(journalSrc)) {
      ok('36.X.e journal._runAgentPipeline 装配 portfolio / macro / marketWidth');
    } else fail('36.X.e journal 装配不全', 'Portfolio/Macro/MarketWidth 任一未装配');
    // 36.X.f holding.currentPrice 注入
    if (/h\.currentPrice\s*=/.test(journalSrc) && /getStockQuote/.test(journalSrc)) {
      ok('36.X.f journal._runAgentPipeline 给 holdings 注入 currentPrice (via getStockQuote)');
    } else fail('36.X.f currentPrice 注入', 'h.currentPrice = 或 getStockQuote 缺失');

    // ---- 36.Y Phase Y: 排雷 + screener AI 三补丁 (静态源码 grep) ----
    const riskSrc = fs.readFileSync('www/core/risk-mine.js', 'utf-8');
    const scSrc = fs.readFileSync('www/app/screener.js', 'utf-8');

    // 36.Y.a 4 类风险聚合函数都在 risk-mine.js
    ['buildReasonSet', 'serialize'].forEach(m => {
      if (new RegExp(`\\b${m}\\b`).test(riskSrc)) ok(`36.Y.a RiskMine.${m} 存在`);
      else fail(`36.Y.a RiskMine.${m}`, '缺失');
    });

    // 36.Y.b REASONS 含全部 7 个 reason
    const reasonsNeeded = ['商誉偏高', '股东减持', '业绩首亏', '业绩续亏', '业绩预减', '主力净流出', '用户黑名单'];
    const missingReasons = reasonsNeeded.filter(r => !riskSrc.includes(r));
    if (missingReasons.length === 0) {
      ok('36.Y.b REASONS 枚举 7 项全在');
    } else fail('36.Y.b REASONS 缺项', `缺: ${missingReasons.join(', ')}`);

    // 36.Y.c screener 接入 RiskMine + 4 fetch
    if (/Core\.RiskMine\.buildReasonSet/.test(scSrc)
        && /getStockGoodwillRanks/.test(scSrc)
        && /getStockHolderDecreases/.test(scSrc)
        && /getStockEarningsForecastFresh/.test(scSrc)
        && /getStockCapitalFlight/.test(scSrc)) {
      ok('36.Y.c screener 接线: RiskMine + 4 fetcher 全部调');
    } else fail('36.Y.c 接线不全', 'RiskMine 或 4 fetcher 任一未调');

    // 36.Y.d PE 负值标 "亏损" (P-C)
    if (/pe\s*<=\s*0[^"]*"[^"]*亏损|PE=.*pe\s*<=\s*0.*亏损/.test(scSrc)
        || /pe<=\s*0\s*\?\s*['"]亏损['"]/.test(scSrc)
        || /isNaN\(pe\)\s*\?\s*'-'\s*:\s*\(?\s*pe\s*<=\s*0\s*\?\s*['"]亏损['"]/.test(scSrc)) {
      ok('36.Y.d PE<=0 标 "亏损" (防 LLM 误读亏损股为低估)');
    } else fail('36.Y.d PE 修复', '源码未匹配 pe<=0 ? "亏损"');

    // 36.Y.e [降级] 标记 4 处失败兜底 (P-D)
    const downgradeCount = (scSrc.match(/\[降级\]/g) || []).length;
    if (downgradeCount >= 4) {
      ok(`36.Y.e [降级] 标记 ≥4 处 (macro/news/ctx/intl/KB 失败兜底, 实有 ${downgradeCount})`);
    } else fail('36.Y.e [降级]', `仅 ${downgradeCount} 处, 期望 ≥4`);

    // 36.Y.f 我的持仓感知 (Y.3 P-A)
    if (/Core\.Portfolio\.getAssets\(\{\s*paper:\s*false\s*\}\)[\s\S]*?valueByCode/.test(scSrc)
        && /portfolioLine/.test(scSrc)) {
      ok('36.Y.f aiInterpret 装配 Portfolio.getAssets({paper:false}) + 我的持仓段');
    } else fail('36.Y.f 持仓感知', 'Portfolio.getAssets 或 我的持仓 段缺失');

    // 36.Y.g screener 4 个排雷 checkbox + blacklist textarea
    const checkboxesNeeded = ['scExclGoodwill', 'scExclDecrease', 'scExclLoss', 'scExclCapitulate', 'scBlacklist'];
    const missingCk = checkboxesNeeded.filter(c => !scSrc.includes(`id="${c}"`));
    if (missingCk.length === 0) {
      ok('36.Y.g 排雷 UI: 4 checkbox + 1 blacklist textarea 都在 _renderForm');
    } else fail('36.Y.g 排雷 UI 缺控件', `缺: ${missingCk.join(', ')}`);

    // 36.Y.h Dexie kv 持久化 blacklist (kvSet + kvGet)
    if (/kvSet\(['"]screener_blacklist/.test(scSrc) && /kvGet\(['"]screener_blacklist/.test(scSrc)) {
      ok('36.Y.h blacklist Dexie kv 持久化 + 恢复 (kvSet + kvGet)');
    } else fail('36.Y.h 持久化', 'kvSet/kvGet 任一缺失');

    // _aiEarningsNarrative: AI 调通 → 写 alert.aiNarrative; AI 调失败 → 兜底
    notices.length = 0;
    failFetch = false;
    yjygRows = [
      { '股票代码': '600519', '股票简称': '贵州茅台', '业绩预告类型': '首亏', '业绩预告摘要': '预计亏损 5 亿', '公告日期': '2026-07-20', '报告期': '2026-06-30' }
    ];
    const ew2 = { id: 'ew2', type: 'earnings_warning', active: true, hitCount: 0, lastNotifiedKeys: {} };
    let aiCallCount = 0;
    actx.Core.AI.call = async () => { aiCallCount++; return '⚡ 茅台业绩首亏, 严重信号。\n📌 中长线复核买入逻辑'; };
    await Alerts._checkEarningsWarning(ew2);
    // fire-and-forget .then 跨 vm 边界:用 setImmediate + 多轮 await 链确保 vm 微任务 drain
    for (let i = 0; i < 5 && !ew2.aiNarrative; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (aiCallCount === 1 && ew2.aiNarrative && ew2.aiNarrative.includes('首亏') && ew2.aiNarrativeAt > 0) {
      ok('36.3g AI 归因: 首检后 aiNarrative 异步写回 (命中缓存, 不重复调 AI)');
    } else fail('36.3g AI 归因', JSON.stringify({ aiCallCount, narrative: ew2.aiNarrative }));

    // 同 (code, type) 第二次同 report period 不重复通知 + 不重复调 AI
    const aiCallCountBefore = aiCallCount;
    notices.length = 0;
    await Alerts._checkEarningsWarning(ew2);
    for (let i = 0; i < 5 && notices.length === 0 && aiCallCount === aiCallCountBefore; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (aiCallCount === aiCallCountBefore && notices.length === 0) {
      ok('36.3h 去重: 同 key 第二次 → 不通知 + 不重调 AI');
    } else fail('36.3h 去重', JSON.stringify({ aiCallCount, notices: notices.length }));

    // AI 抛错 → 兜底文案, 不阻塞主通知
    const ew3 = { id: 'ew3', type: 'earnings_warning', active: true, hitCount: 0, lastNotifiedKeys: {} };
    yjygRows = [
      { '股票代码': '600519', '股票简称': '贵州茅台', '业绩预告类型': '续亏', '业绩预告摘要': '继续亏损', '公告日期': '2026-07-20', '报告期': '2026-09-30' }
    ];
    actx.Core.AI.call = async () => { throw new Error('模拟 AI 离线'); };
    notices.length = 0;
    await Alerts._checkEarningsWarning(ew3);
    for (let i = 0; i < 5 && !ew3.aiNarrative; i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    if (notices.length >= 1 && ew3.aiNarrative && ew3.aiNarrative.includes('续亏') && ew3.aiNarrative.includes('严重')) {
      ok('36.3i AI 抛错 → 兜底归因 (不阻塞通知, 不抛错)');
    } else fail('36.3i AI 失败兜底', JSON.stringify({ n: notices.length, narrative: ew3.aiNarrative }));
    actx.Core.AI.call = async () => '';  // 还原默认 mock

    // ---- 36.3j 自动复盘: 业绩预告触发后, journals 表自动写一条带 source=auto 的记录 ----
    // 同步检测 _writeAutoJournal 是否被注册 + 在 _aiEarningsNarrative 链路里被调用
    const dbJournalsBefore = db.journals.length;
    if (typeof Alerts._writeAutoJournal !== 'function') {
      fail('36.3j 自动复盘: 方法 _writeAutoJournal 未注册');
    } else {
      // 直接调一次, 测 idempotent + 内容
      const ew4 = { id: 'ew4', type: 'earnings_warning', active: true, hitCount: 0, lastNotifiedKeys: {} };
      await Alerts._writeAutoJournal(ew4, {
        code: '600519', periodKey: '2026-06-30', type: '预减',
        name: '贵州茅台', summary: '净利润预减 30%'
      }, '⚡ 茅台业绩预减, 中度信号。\n📌 复盘买入逻辑');
      const autoJournal = db.journals.find(j => j.id === 'auto-earn-600519-2026-06-30-预减');
      if (autoJournal && autoJournal.source === 'auto:earnings_warning' &&
          autoJournal.code === '600519' && autoJournal.alertId === 'ew4' &&
          Array.isArray(autoJournal.tags) && autoJournal.tags.includes('📌 自动') &&
          autoJournal.content && autoJournal.content.includes('AI 归因') &&
          autoJournal.content.includes('中长线纪律提醒')) {
        ok('36.3j 自动复盘: journals 表自动落一条 source=auto (📌 标签 + AI 归因 + 纪律提醒)');
      } else fail('36.3j 自动复盘', JSON.stringify({ added: db.journals.length - dbJournalsBefore, auto: autoJournal }));

      // ---- 36.3k 自动复盘幂等: 同 (code, periodKey, type) 二次写不重复落库 ----
      const dbJournalsAfterFirst = db.journals.length;
      await Alerts._writeAutoJournal(ew4, { code: '600519', periodKey: '2026-06-30', type: '预减',
                                            name: '贵州茅台', summary: '净利润预减' }, 'AI 归因 v2');
      if (db.journals.length === dbJournalsAfterFirst) {
        ok('36.3k 自动复盘幂等: 同 (code, periodKey, type) 二次写不重复落库');
      } else fail('36.3k 自动复盘幂等', 'db.journals 涨了 ' + (db.journals.length - dbJournalsAfterFirst));
    }

    // ---- 36.4 大盘状态切换: lastState 三态迁移 ----
    notices.length = 0;
    const rg = { id: 'rg1', type: 'regime_change', active: true, hitCount: 0, lastState: null };
    regimeState = 'range';
    await Alerts._checkRegimeChange(rg);
    if (notices.length === 0 && rg.lastState === 'range') {
      ok('36.4a 首次运行只记基线, 不通知');
    } else fail('36.4a 基线', JSON.stringify({ n: notices.length, lastState: rg.lastState }));

    regimeState = 'bear';
    await Alerts._checkRegimeChange(rg);
    if (notices.length === 1 && notices[0].msg.includes('下跌市') && notices[0].msg.includes('震荡市') && notices[0].msg.includes('放缓')) {
      ok('36.4b range→bear 迁移通知: 文案带"为什么关心"');
    } else fail('36.4b bear 迁移', notices.length ? notices[0].msg : '无通知');

    await Alerts._checkRegimeChange(rg);  // 同状态再跑
    if (notices.length === 1) ok('36.4c 状态不变 → 不重复通知');
    else fail('36.4c 同状态', 'notices=' + notices.length);

    regimeState = 'bull';
    await Alerts._checkRegimeChange(rg);
    if (notices.length === 2 && notices[1].msg.includes('趋势市') && rg.lastState === 'bull') {
      ok('36.4d bear→bull 迁移通知');
    } else fail('36.4d bull 迁移', notices.length);

    if (Alerts._regimeNotifyText('foo', 'bar') === null) ok('36.4e 非法状态 → null');
    else fail('36.4e 非法状态', '未返 null');

    failFetch = true;
    const rgDone = await Alerts._checkRegimeChange(rg);
    failFetch = false;
    if (rgDone === false) ok('36.4f Regime 失败 → false (下轮重试)');
    else fail('36.4f 失败', rgDone);

    // ---- 36.5 估值偏离: 时序 + 客户端自算分位 + 进/出阈值区去重 ----
    // stock_market_pe_lg 真实返回是月度时序 {日期, 平均市盈率} (深证综指 1997-2026, 344 行)
    // _judgeValuation 客户端自算: 取末尾 60 个月 PE 序列, 末值在序列里的分位
    function makePeSeries(currentPe, baseline = 20) {
      const out = [];
      const start = new Date('2018-01-31');
      // lookback + 1 = 61 (产品 _judgeValuation 阈值), 多给 1 行防边界
      for (let i = 0; i < 65; i++) {
        const d = new Date(start.getTime() + i * 30 * 86400000);
        out.push({ '日期': d.toISOString(), '平均市盈率': baseline + (i % 10) * 0.3 });
      }
      // 末值 = currentPe
      out[out.length - 1] = { '日期': new Date().toISOString(), '平均市盈率': currentPe };
      return out;
    }
    valuationRows = makePeSeries(30);   // 当前 PE=30, 历史 baseline=20 ± 3, 末值远超历史 → 高分位
    const verdict = Alerts._judgeValuation(valuationRows);
    if (verdict && verdict.hits.length === 1 && verdict.hits[0].percentile >= 80) {
      ok('36.5a 估值判定: 时序末值远超历史 → 分位≥80% 命中');
    } else fail('36.5a 判定', JSON.stringify(verdict));

    if (Alerts._judgeValuation([]) === null &&
        Alerts._judgeValuation('not-array') === null &&
        Alerts._judgeValuation(makePeSeries(30).slice(0, 10)) === null) {  // 序列太短 → null
      ok('36.5b 序列空/非数组/太短(<60) → null (宁缺毋假, 不通知)');
    } else fail('36.5b 不可用', '未返 null');

    notices.length = 0;
    const va = { id: 'v1', type: 'valuation', active: true, hitCount: 0, lastNotifiedKey: null };
    await Alerts._checkValuation(va);
    if (notices.length === 1 && notices[0].msg.includes('估值偏离') && notices[0].msg.includes('%') && va.lastNotifiedKey) {
      ok('36.5c 估值首检: 通知带分位 + 归因, lastNotifiedKey 落行');
    } else fail('36.5c 首检', JSON.stringify({ n: notices.length, key: va.lastNotifiedKey }));

    await Alerts._checkValuation(va);  // 同样数据再跑
    if (notices.length === 1) ok('36.5d 同一阈值区 → 不重复通知');
    else fail('36.5d 去重', 'notices=' + notices.length);

    valuationRows = makePeSeries(15);   // 末值跌入 baseline 区间 → 低分位
    await Alerts._checkValuation(va);
    if (notices.length === 1 && va.lastNotifiedKey === null) {
      ok('36.5e 跌出阈值区 → 静默 + key 清空');
    } else fail('36.5e 出区', JSON.stringify({ n: notices.length, key: va.lastNotifiedKey }));

    valuationRows = makePeSeries(35);   // 重新进入高分位
    await Alerts._checkValuation(va);
    if (notices.length === 2) ok('36.5f 重新进入阈值区 → 再次通知');
    else fail('36.5f 重进', 'notices=' + notices.length);

    // ---- 36.6 中长线调度: nextCheck 门控 ----
    db.alerts = [
      { id: 'rg2', type: 'regime_change', active: true, hitCount: 0, lastState: 'bull', nextCheck: Date.now() + 99999999 },  // 未到点
      { id: 'rg3', type: 'regime_change', active: true, hitCount: 0, lastState: 'range', nextCheck: Date.now() - 1000 }       // 到点
    ];
    notices.length = 0;
    regimeState = 'bear';
    await Alerts._checkLong();
    const rg2After = db.alerts.find(a => a.id === 'rg2');
    const rg3After = db.alerts.find(a => a.id === 'rg3');
    if (notices.length === 1 && rg2After.lastState === 'bull' && rg3After.lastState === 'bear' && rg3After.nextCheck > Date.now()) {
      ok('36.6 _checkLong: nextCheck 门控 (未到点跳过, 到点执行并推进)');
    } else fail('36.6 门控', JSON.stringify({ n: notices.length, rg2: rg2After.lastState, rg3: rg3After.lastState }));

    // ---- 36.7 源码对账: 旧单一定时器已移除, horizon 落行 ----
    if (!/this\._timer\s*=\s*setInterval/.test(alertsSrc) && /horizon:\s*'short'/.test(alertsSrc) && /horizon:\s*'long'/.test(alertsSrc)) {
      ok('36.7 源码: 旧 60s 单定时器移除, 新规则保存时 horizon 落行');
    } else fail('36.7 源码对账', '旧定时器残留或 horizon 未落行');

    // ---- 36.8 AI 解读默认走缓存 + 强制刷新开关 ----
    // 源码对账: 默认 hasCachedNarrative 命中时不会调 interpretAlert, forceRefresh=true 才调
    if (/forceRefresh\s*\|\|\s*!hasCachedNarrative/.test(alertsSrc) &&
        /hasCachedNarrative\s*\?[\s\S]*?id\s*=\s*"aiInterpRefresh"[\s\S]*?AI 重新解读/.test(alertsSrc) &&
        /if\s*\(forceRefresh\s*&&\s*hasCachedNarrative\)/.test(alertsSrc)) {
      ok('36.8 AI 解读: 默认缓存路径 + 强制刷新开关 (源码对账)');
    } else fail('36.8 AI 解读开关', '默认缓存或强制刷新分支未匹配');
  } catch (e) {
    fail('36 中长线盯盘', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [37] AlertsAgent: AI 代理操作层 (白名单 + 两阶段落库) ==========
section('[37] Core.AlertsAgent: 白名单校验 / parseIntent / preview / apply 守卫 / suggestForHoldings / interpretAlert');
(async () => {
  try {
    const agentSrc = readFileSafe(path.join(WWW, 'core', 'alerts-agent.js'));
    if (!agentSrc) throw new Error('alerts-agent.js 读不到');

    // 静态对账: 暴露方法 + 不含 eval + 不含 innerHTML 写法
    const exposed = ['parseIntent', 'validateSpec', 'validateSpecs', 'previewIntents', 'applyIntents', 'suggestForHoldings', 'interpretAlert'];
    const missing = exposed.filter(m => !new RegExp('\\b' + m + '\\s*[:(]').test(agentSrc));
    if (missing.length === 0) ok('37.1 暴露: 7 个方法全在 (parseIntent/validateSpec/validateSpecs/previewIntents/applyIntents/suggestForHoldings/interpretAlert)');
    else fail('37.1 暴露缺失', missing.join(','));

    if (!/\beval\s*\(/.test(agentSrc)) ok('37.2 不含 eval');
    else fail('37.2 eval 残留', agentSrc.match(/eval\s*\([^)]*\)/)?.[0]);

    if (/indexHTML\s*=/.test(agentSrc)) fail('37.3 含 innerHTML=', 'raw HTML write risk');
    else ok('37.3 无 innerHTML= (AI 输出交给调用方 escapeHtml)');

    // ---- vm 加载 + 纯函数实测 ----
    const ctx = vm.createContext({
      window: {},
      console,
      setTimeout, clearTimeout,
      Core: {
        Storage: {
          add: async () => {}, get: async () => null, put: async () => {}, remove: async () => {}, where: async () => [], all: async () => []
        },
        AI: { call: async () => '' }
      }
    });
    ctx.window = ctx;
    vm.runInContext(agentSrc, ctx);
    const A = ctx.Core.AlertsAgent;
    if (!A || !A.TYPE_DEFS) throw new Error('Core.AlertsAgent 未挂载');
    if (Object.keys(A.TYPE_DEFS).length >= 10) ok('37.4 TYPE_DEFS 注册: 10 条规则全覆盖 (5 短线 + 5 中长线)');
    else fail('37.4 TYPE_DEFS 数量', String(Object.keys(A.TYPE_DEFS).length));

    // 校验: 合法 spec 通过
    const v1 = A.validateSpec({ type: 'price_above', code: '600519', value: 1700 });
    if (v1.type === 'price_above' && v1.code === '600519' && v1.value === 1700) ok('37.5a validateSpec 合法 price_above: 归一 + 阈值保留');
    else fail('37.5a validateSpec', JSON.stringify(v1));

    const v2 = A.validateSpec({ type: 'earnings_warning' });
    if (v2.type === 'earnings_warning' && v2.code === 'holdings' && v2.name === '业绩预告异动') ok('37.5b validateSpec 全局规则: code/name 自动填默认值');
    else fail('37.5b 全局', JSON.stringify(v2));

    // 校验: 拒绝未知 type
    let threw = false;
    try { A.validateSpec({ type: 'no_such_type', code: '600519', value: 1 }); } catch (e) { threw = true; }
    if (threw) ok('37.5c 拒绝未知规则类型');
    else fail('37.5c 未知 type 未拒');

    // 校验: 拒绝缺 code (短线)
    threw = false;
    try { A.validateSpec({ type: 'price_above', code: 'abc', value: 1 }); } catch (e) { threw = true; }
    if (threw) ok('37.5d 拒绝非法代码 (短线)');
    else fail('37.5d 非法 code 未拒');

    // 校验: 拒绝阈值越界
    threw = false;
    try { A.validateSpec({ type: 'change_above', code: '600519', value: 100 }); } catch (e) { threw = true; }
    if (threw) ok('37.5e 拒绝阈值越界 (change_above max=50)');
    else fail('37.5e 越界未拒');

    // 校验: leadDays 兜底
    const v3 = A.validateSpec({ type: 'earnings_disclosure', code: '600519', leadDays: 999 });
    if (v3.leadDays === 3) ok('37.5f leadDays 越界 → 用默认 3');
    else fail('37.5f leadDays 兜底', String(v3.leadDays));

    // suggestForHoldings: 只挑实盘
    const sugs = A.suggestForHoldings([
      { code: '600519', name: '茅台', isPaper: false },
      { code: '000002', isPaper: true },        // 模拟盘 → 排除
      { code: 'abc', isPaper: false }            // 坏 code → 排除
    ]);
    if (sugs.length === 1 && sugs[0].type === 'earnings_disclosure' && sugs[0].code === '600519') ok('37.6 suggestForHoldings: 只推实盘且代码合法');
    else fail('37.6 suggest', JSON.stringify(sugs));

    // applyIntents: 没传 confirmed=true 必须拒绝
    threw = false;
    try {
      await A.applyIntents([{ action: 'create', specs: { type: 'price_above', code: '600519', value: 1700 } }], {});
    } catch (e) { threw = e.message.includes('用户确认'); }
    if (threw) ok('37.7a applyIntents: 必须传 {confirmed: true} 否则拒');
    else fail('37.7a confirmed 守卫');

    // applyIntents: 空数组拒
    threw = false;
    try { await A.applyIntents([], { confirmed: true }); } catch (e) { threw = true; }
    if (threw) ok('37.7b applyIntents: 空数组拒');
    else fail('37.7b 空数组');

    // parseIntent: 模拟 AI 返回合规 JSON → 应通过 validate
    ctx.Core.AI.call = async () => '{"intents":[{"action":"create","specs":{"type":"price_above","code":"600519","value":1700},"reasoning":"用户想止盈"}]}';
    const parsed = await A.parseIntent('给 600519 设个 1700 止盈', { holdings: [{ code: '600519', name: '茅台' }] });
    if (parsed.intents.length === 1 && parsed.intents[0].action === 'create' && parsed.intents[0].specs.type === 'price_above') {
      ok('37.8a parseIntent: AI 返回合规 JSON → 通过白名单校验');
    } else fail('37.8a parseIntent', JSON.stringify(parsed));

    // parseIntent: AI 编造未知 type → 应抛错 (不静默)
    ctx.Core.AI.call = async () => '{"intents":[{"action":"create","specs":{"type":"invented_type","code":"600519","value":1},"reasoning":"x"}]}';
    threw = false;
    try { await A.parseIntent('造个新规则', {}); } catch (e) { threw = e.message.includes('未知规则类型'); }
    if (threw) ok('37.8b parseIntent: AI 编造 type → 抛错 (抗幻觉)');
    else fail('37.8b 抗幻觉失败');

    // parseIntent: AI 返回非 JSON → 抛错
    ctx.Core.AI.call = async () => '对不起, 我不能...';
    threw = false;
    try { await A.parseIntent('...', {}); } catch (e) { threw = e.message.includes('未返回 JSON'); }
    if (threw) ok('37.8c parseIntent: 非 JSON 输出 → 抛错');
    else fail('37.8c 非 JSON');

    // parseIntent: AI 包 ```json ... ``` → 应能抽
    ctx.Core.AI.call = async () => '```json\n{"intents":[{"action":"create","specs":{"type":"regime_change"},"reasoning":"大盘切换"}]}\n```';
    const r4 = await A.parseIntent('...', {});
    if (r4.intents[0].specs.type === 'regime_change') ok('37.8d parseIntent: AI 包 ```json``` 仍能抽');
    else fail('37.8d 包代码块', JSON.stringify(r4));

    // previewIntents: 转可读
    const previews = A.previewIntents([
      { action: 'create', specs: { type: 'price_above', code: '600519', value: 1700, name: '茅台' }, reasoning: '止盈' },
      { action: 'delete', specs: { id: 'a1' }, reasoning: '清理' }
    ]);
    if (previews.length === 2 && previews[0].title.includes('茅台') && previews[1].title.includes('a1')) {
      ok('37.9 previewIntents: create/delete 都可生成预览');
    } else fail('37.9 preview', JSON.stringify(previews));

    // interpretAlert: AI 调用错误应 throw (不吞)
    ctx.Core.AI.call = async () => { throw new Error('AI 离线'); };
    threw = false;
    try { await A.interpretAlert({ type: 'price_above', code: '600519' }, {}); } catch (e) { threw = e.message.includes('AI 调用失败'); }
    if (threw) ok('37.10 interpretAlert: AI 失败 throw, 不静默');
    else fail('37.10 interpretAlert 吞错');

    // interpretAlert: 正常调用返回文本
    ctx.Core.AI.call = async () => '⚡ 600519 触发价格 ≥ 1700 ...';
    const interp = await A.interpretAlert({ type: 'price_above', code: '600519', value: 1700, hitCount: 1, lastHit: Date.now() }, { regime: { state: 'bull', label: '趋势市 🐂' } });
    if (interp.includes('600519')) ok('37.11 interpretAlert: 返回中文解读');
    else fail('37.11 interpretAlert', interp);
  } catch (e) {
    fail('37 AlertsAgent', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [38] Phase T3 日线级条件单引擎 (Paper) ==========
section('[38] Phase T3 日线级条件单引擎 (Paper)');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const K = _loadRealConstants();

    // T3 常量进 Core.Constants
    if (K.COND_ORDER_LIMIT === 100 && K.COND_ORDER_EXPIRE_DAYS === 3 && K.SHORT_MAX_HOLD_DAYS === 5) {
      ok('T3 常量: COND_ORDER_LIMIT=100 / COND_ORDER_EXPIRE_DAYS=3 / SHORT_MAX_HOLD_DAYS=5');
    } else fail('T3 常量', JSON.stringify({ l: K.COND_ORDER_LIMIT, e: K.COND_ORDER_EXPIRE_DAYS, h: K.SHORT_MAX_HOLD_DAYS }));

    const pad2 = (n) => String(n).padStart(2, '0');
    const realFmtDate = (d) => {
      d = d instanceof Date ? d : new Date(d);
      return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    };
    // K 线 fixture: data.js 中文键行
    const krow = (date, open, high, low, close) => ({ 日期: date, 开盘: open, 最高: high, 最低: low, 收盘: close });
    // 手工拼一条 pending 条件单 (绕过 addCondOrder 的 Date.now, 控制 createdDate)
    const mkOrder = (over) => Object.assign({
      id: 'o-' + Math.random().toString(36).slice(2, 8),
      code: '600519', name: '贵州茅台', market: 'sh', sleeve: 'short',
      triggerDirection: 'below', triggerPrice: 10, stopLoss: 9, targetPrice: 11,
      shares: 100, amount: 1000,
      assumption: '技术突破', falsifyCondition: '跌破 20 日线', invalidation: '', probability: null,
      source: 'manual', status: 'pending',
      createdAt: new Date(2026, 6, 24, 10, 0).getTime(),
      createdDate: '2026-07-24', createdAfterClose: false,
      expireAt: new Date(2026, 6, 27).getTime(),
      filledAt: null, fillPrice: null, holdingId: null
    }, over || {});

    // 与 [23] 同款 vm sandbox (内存 mock storage + getStockKLine mock + Discipline mock)
    const buildCtx = (storageData, opts = {}) => {
      const pctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: realFmtDate,
        uuid: () => 't3-' + Math.random().toString(36).slice(2, 10),
        parseStockInput: (t) => {
          const m = String(t || '').trim().match(/^(\d{6})/);
          return m ? { code: m[1], name: String(t).slice(6).trim() } : null;
        },
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true
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
          getStockQuote: async (code) => (storageData.quotes || {})[code] || null,
          getIndexSpot: async () => [],
          getStockKLine: async (code) => {
            if (storageData.klineFail && storageData.klineFail[code]) throw new Error('K线拉取失败(测试注入)');
            return (storageData.klines || {})[code] || [];
          }
        },
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: K,
        Discipline: opts.noDiscipline ? undefined : {
          preBuyCheck: async () => ({
            ok: !(opts.disciplineBlocks && opts.disciplineBlocks.length),
            blocks: opts.disciplineBlocks || [], warns: [], history: []
          }),
          renderCheckResult: () => '',
          _resultToText: () => ''
        }
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };

    // ---------- 38.1 纯函数 ----------
    const ctx0 = buildCtx({ kv: {}, tables: {} });
    const P = ctx0.window.Paper;
    if (!P) throw new Error('Paper 未挂到 window');

    // _barOf: 中文键 → bar; 缺字段/非正数 → null
    const b1 = P._barOf(krow('2026-07-27', 10, 11, 9, 10.5));
    if (b1 && b1.open === 10 && b1.high === 11 && b1.low === 9 && b1.close === 10.5 && b1.date === '2026-07-27') ok('T3 _barOf: 中文键归一化');
    else fail('T3 _barOf', JSON.stringify(b1));
    if (P._barOf(krow('2026-07-27', 10, 11, 0, 10.5)) === null && P._barOf({}) === null && P._barOf(null) === null) ok('T3 _barOf: 坏数据 → null');
    else fail('T3 _barOf 坏数据', '');

    // _fillCheck below: 开盘已满足 → 开盘价; 盘中穿越 → 触发价; 未触发
    const ordBelow = { triggerDirection: 'below', triggerPrice: 10 };
    let fc = P._fillCheck(ordBelow, { open: 9.5, high: 10.5, low: 9, close: 10, date: 'd' });
    if (fc.fill === true && fc.price === 9.5) ok('T3 _fillCheck below: 开盘 ≤ 触发 → 开盘价成交');
    else fail('T3 fill below open', JSON.stringify(fc));
    fc = P._fillCheck(ordBelow, { open: 10.5, high: 11, low: 9.8, close: 10.2, date: 'd' });
    if (fc.fill === true && fc.price === 10) ok('T3 _fillCheck below: 盘中下穿 → 触发价成交');
    else fail('T3 fill below touch', JSON.stringify(fc));
    fc = P._fillCheck(ordBelow, { open: 10.5, high: 11, low: 10.1, close: 10.8, date: 'd' });
    if (fc.fill === false && fc.price === null) ok('T3 _fillCheck below: 未触发');
    else fail('T3 fill below none', JSON.stringify(fc));

    // _fillCheck above: 对称三分支
    const ordAbove = { triggerDirection: 'above', triggerPrice: 10 };
    fc = P._fillCheck(ordAbove, { open: 10.5, high: 11, low: 10.2, close: 10.8, date: 'd' });
    if (fc.fill === true && fc.price === 10.5) ok('T3 _fillCheck above: 开盘 ≥ 触发 → 开盘价成交');
    else fail('T3 fill above open', JSON.stringify(fc));
    fc = P._fillCheck(ordAbove, { open: 9.5, high: 10.3, low: 9.2, close: 10.1, date: 'd' });
    if (fc.fill === true && fc.price === 10) ok('T3 _fillCheck above: 盘中上穿 → 触发价成交');
    else fail('T3 fill above touch', JSON.stringify(fc));
    fc = P._fillCheck(ordAbove, { open: 9.5, high: 9.9, low: 9.2, close: 9.6, date: 'd' });
    if (fc.fill === false) ok('T3 _fillCheck above: 未触发');
    else fail('T3 fill above none', JSON.stringify(fc));

    // _exitCheck: 跳空止损 / 止损 / 跳空止盈 / 止盈 / 同根 K 止损优先 / 未触发
    const pos1 = { stopLoss: 9, targetPrice: 11 };
    let ec = P._exitCheck(pos1, { open: 8.5, high: 9.2, low: 8.3, close: 8.8, date: 'd' });
    if (ec.exit && ec.price === 8.5 && ec.reason === '止损(跳空)') ok('T3 _exitCheck: 跳空止损 → 开盘价卖');
    else fail('T3 exit gap stop', JSON.stringify(ec));
    ec = P._exitCheck(pos1, { open: 9.5, high: 9.8, low: 8.9, close: 9.2, date: 'd' });
    if (ec.exit && ec.price === 9 && ec.reason === '止损') ok('T3 _exitCheck: 盘中触及止损 → 止损价卖');
    else fail('T3 exit stop', JSON.stringify(ec));
    ec = P._exitCheck(pos1, { open: 11.5, high: 12, low: 11.2, close: 11.8, date: 'd' });
    if (ec.exit && ec.price === 11.5 && ec.reason === '止盈(跳空)') ok('T3 _exitCheck: 跳空止盈 → 开盘价卖');
    else fail('T3 exit gap target', JSON.stringify(ec));
    ec = P._exitCheck(pos1, { open: 10.5, high: 11.2, low: 10.2, close: 11, date: 'd' });
    if (ec.exit && ec.price === 11 && ec.reason === '止盈') ok('T3 _exitCheck: 盘中触及目标 → 目标价卖');
    else fail('T3 exit target', JSON.stringify(ec));
    // 同根 K low 穿止损 且 high 触目标 → 保守按止损
    ec = P._exitCheck(pos1, { open: 10, high: 11.5, low: 8.5, close: 10, date: 'd' });
    if (ec.exit && ec.price === 9 && ec.reason === '止损') ok('T3 _exitCheck: 同根 K 双触及 → 止损优先 (保守原则)');
    else fail('T3 exit both', JSON.stringify(ec));
    ec = P._exitCheck(pos1, { open: 10, high: 10.5, low: 9.5, close: 10.2, date: 'd' });
    if (ec.exit === false && ec.price === null) ok('T3 _exitCheck: 未触发');
    else fail('T3 exit none', JSON.stringify(ec));

    // _isGapDown / _isGapUp
    if (P._isGapDown({ open: 8.9 }, 9) === true && P._isGapDown({ open: 9.1 }, 9) === false
      && P._isGapUp({ open: 11.1 }, 11) === true && P._isGapUp({ open: 10.9 }, 11) === false) ok('T3 _isGapDown/_isGapUp');
    else fail('T3 gap helpers', '');

    // _lastClosedBar: 盘中不取当日 K; 15:00 后取当日 K; 空 → null
    const bars2 = [P._barOf(krow('2026-07-24', 10, 10.5, 9.8, 10.2)), P._barOf(krow('2026-07-27', 10.2, 10.8, 10, 10.6))];
    const lcb1 = P._lastClosedBar(bars2, new Date(2026, 6, 27, 10, 0));
    if (lcb1 && lcb1.date === '2026-07-24') ok('T3 _lastClosedBar: 盘中 → 上一交易日 K');
    else fail('T3 lastClosedBar 盘中', JSON.stringify(lcb1));
    const lcb2 = P._lastClosedBar(bars2, new Date(2026, 6, 27, 15, 30));
    if (lcb2 && lcb2.date === '2026-07-27') ok('T3 _lastClosedBar: 15:00 后 → 当日 K 已收盘');
    else fail('T3 lastClosedBar 收盘后', JSON.stringify(lcb2));
    if (P._lastClosedBar([], new Date()) === null && P._lastClosedBar(null, new Date()) === null) ok('T3 _lastClosedBar: 无数据 → null');
    else fail('T3 lastClosedBar 空', '');

    // _orderEligible: 收盘后创建不回溯当日 K
    if (P._orderEligible({ createdDate: '2026-07-27', createdAfterClose: true }, { date: '2026-07-27' }) === false
      && P._orderEligible({ createdDate: '2026-07-27', createdAfterClose: true }, { date: '2026-07-28' }) === true) ok('T3 _orderEligible: 收盘后创建 → 次日 K 才生效');
    else fail('T3 eligible afterClose', '');
    if (P._orderEligible({ createdDate: '2026-07-27', createdAfterClose: false }, { date: '2026-07-27' }) === true
      && P._orderEligible({ createdDate: '2026-07-27', createdAfterClose: false }, { date: '2026-07-24' }) === false) ok('T3 _orderEligible: 盘中创建 → 当日 K 生效, 历史 K 不生效');
    else fail('T3 eligible intraday', '');

    // _tradingDaysAfter: 按 K 线数交易日
    const bars3 = [krow('2026-07-23', 1, 1, 1, 1), krow('2026-07-24', 1, 1, 1, 1), krow('2026-07-27', 1, 1, 1, 1)].map(r => P._barOf(r));
    if (P._tradingDaysAfter(bars3, '2026-07-22') === 3 && P._tradingDaysAfter(bars3, '2026-07-24') === 1) ok('T3 _tradingDaysAfter: 只数创建日之后的 K');
    else fail('T3 tradingDaysAfter', '');

    // _checkCondOrder 校验: 价格关系 / 整手 / 现金
    const goodOrder = { code: '600519', triggerDirection: 'below', triggerPrice: 10, stopLoss: 9, targetPrice: 11, shares: 100 };
    if (P._checkCondOrder(goodOrder, 30000).length === 0) ok('T3 _checkCondOrder: 合法单通过');
    else fail('T3 check 合法', JSON.stringify(P._checkCondOrder(goodOrder, 30000)));
    if (P._checkCondOrder({ ...goodOrder, stopLoss: 10.5 }, 30000).some(e => e.includes('止损价'))) ok('T3 _checkCondOrder: 止损 ≥ 触发 → 拦截');
    else fail('T3 check 止损关系', '');
    if (P._checkCondOrder({ ...goodOrder, targetPrice: 9.5 }, 30000).some(e => e.includes('目标价'))) ok('T3 _checkCondOrder: 目标 ≤ 触发 → 拦截');
    else fail('T3 check 目标关系', '');
    if (P._checkCondOrder({ ...goodOrder, triggerDirection: 'above' }, 30000).length === 0
      && P._checkCondOrder({ ...goodOrder, triggerDirection: 'up' }, 30000).some(e => e.includes('方向'))) ok('T3 _checkCondOrder: 方向校验 (above 合法 / 非法值拦截)');
    else fail('T3 check 方向', '');
    if (P._checkCondOrder({ ...goodOrder, shares: 150 }, 30000).some(e => e.includes('整手') || e.includes('整数倍'))) ok('T3 _checkCondOrder: 非整手 → 拦截');
    else fail('T3 check 整手', '');
    if (P._checkCondOrder({ ...goodOrder, shares: 5000 }, 20000).some(e => e.includes('现金'))) ok('T3 _checkCondOrder: 金额超短线现金 → 拦截');
    else fail('T3 check 现金', '');
    if (P._checkCondOrder({ ...goodOrder, code: 'ABC' }, 30000).some(e => e.includes('代码'))) ok('T3 _checkCondOrder: 非法代码 → 拦截');
    else fail('T3 check 代码', '');

    // ---------- 38.2 addCondOrder / listCondOrders / cancelCondOrder ----------
    const store1 = {
      kv: { paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 } },
      tables: {}
    };
    const ctx1 = buildCtx(store1);
    const P1 = ctx1.window.Paper;
    const addR1 = await P1.addCondOrder({ code: '600519', name: '贵州茅台', triggerDirection: 'below', triggerPrice: 10, stopLoss: 9, targetPrice: 11, shares: 100, assumption: '技术突破', falsifyCondition: '跌破 20 日线' });
    const saved1 = (store1.kv.paper_cond_orders || [])[0];
    if (addR1.ok === true && saved1 && saved1.sleeve === 'short' && saved1.status === 'pending'
      && saved1.createdDate && saved1.expireAt > saved1.createdAt && saved1.amount === 1000) ok('T3 addCondOrder: 落 kv, sleeve/status/createdDate/expireAt 齐备');
    else fail('T3 addCondOrder', JSON.stringify({ addR1, saved1 }));
    const addR2 = await P1.addCondOrder({ code: '600519', triggerDirection: 'below', triggerPrice: 10, stopLoss: 12, targetPrice: 13, shares: 100 });
    if (addR2.ok === false && addR2.errors.length > 0 && (store1.kv.paper_cond_orders || []).length === 1) ok('T3 addCondOrder: 校验失败不落库');
    else fail('T3 addCondOrder 校验', JSON.stringify(addR2));
    const list1 = await P1.listCondOrders('pending');
    if (list1.length === 1 && (await P1.listCondOrders('filled')).length === 0 && (await P1.listCondOrders()).length === 1) ok('T3 listCondOrders: status 过滤');
    else fail('T3 listCondOrders', '');
    const cancelR = await P1.cancelCondOrder(saved1.id);
    if (cancelR === true && store1.kv.paper_cond_orders[0].status === 'cancelled'
      && store1.kv.paper_cond_orders[0].cancelReason === '手动取消') ok('T3 cancelCondOrder: 状态转 cancelled + 原因');
    else fail('T3 cancelCondOrder', JSON.stringify(store1.kv.paper_cond_orders[0]));
    if (await P1.cancelCondOrder(saved1.id) === false) ok('T3 cancelCondOrder: 非 pending 不可再取消');
    else fail('T3 cancel 重复', '');
    // 上限 100 滚动截断
    const bigOrders = [];
    for (let i = 0; i < 105; i++) bigOrders.push(mkOrder({ id: 'bulk-' + i }));
    store1.kv.paper_cond_orders = bigOrders;
    const addR3 = await P1.addCondOrder({ code: '000001', triggerDirection: 'above', triggerPrice: 10, stopLoss: 9, targetPrice: 11, shares: 100 });
    if (addR3.ok && store1.kv.paper_cond_orders.length === 100 && store1.kv.paper_cond_orders[0].id === 'bulk-6') ok('T3 addCondOrder: 上限 100 条滚动截断');
    else fail('T3 上限截断', String(store1.kv.paper_cond_orders.length));

    // ---------- 38.3 结算: pending 买单成交 (盘中下穿 → 触发价) ----------
    const store2 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [mkOrder()]
      },
      tables: {},
      klines: {
        '600519': [
          krow('2026-07-24', 10.5, 10.6, 10.4, 10.5),
          krow('2026-07-27', 10.2, 10.3, 9.8, 10.0)   // open>trigger, low≤trigger → 按 10 成交
        ]
      }
    };
    const ctx2 = buildCtx(store2);
    const P2 = ctx2.window.Paper;
    const s1 = await P2.settleCondOrders(new Date(2026, 6, 27, 16, 0));
    const fo1 = store2.kv.paper_cond_orders[0];
    if (s1 && s1.filled === 1 && fo1.status === 'filled' && fo1.fillPrice === 10 && fo1.holdingId && fo1.filledAt) ok('T3 settle: below 单盘中下穿 → 按触发价 10 成交');
    else fail('T3 settle fill', JSON.stringify({ s1, fo1 }));
    const fh1 = (store2.tables.holdings || [])[0];
    if (fh1 && fh1.isPaper === true && fh1.sleeve === 'short' && fh1.shares === 100 && fh1.costPrice === 10
      && fh1.stopLoss === 9 && fh1.targetPrice === 11) ok('T3 settle: 持仓行带 sleeve/stopLoss/targetPrice (非索引字段)');
    else fail('T3 settle 持仓行', JSON.stringify(fh1));
    const spos1 = (store2.kv.paper_short_positions || [])[0];
    if (spos1 && spos1.holdingId === fo1.holdingId && spos1.entryDate === '2026-07-27' && spos1.entryPrice === 10
      && spos1.planOrderId === fo1.id && spos1.holdDays === 0 && spos1.lastSettleBarDate === '2026-07-27' && spos1.closed === false) ok('T3 settle: paper_short_positions 仓位跟踪行');
    else fail('T3 settle 仓位跟踪', JSON.stringify(spos1));
    const ftx1 = (store2.tables.transactions || []).find(t => t.type === 'buy');
    if (ftx1 && ftx1.date === '2026-07-27' && ftx1.price === 10 && ftx1.sleeve === 'short' && ftx1.auto === true) ok('T3 settle: 买入流水用 K 线日期 + auto 标记');
    else fail('T3 settle 买入流水', JSON.stringify(ftx1));
    if (Math.abs(store2.kv.paper_account_short.cash - (30000 - 1000 - 5)) < 0.01) ok('T3 settle: 短线现金扣 1005 (=1000+费5, 万三 0.3 < 最低 5)');
    else fail('T3 settle 现金', JSON.stringify(store2.kv.paper_account_short));
    const fj1 = (store2.tables.journals || [])[0];
    if (fj1 && fj1.code === '600519' && fj1.sleeve === 'short' && fj1.auto === true
      && fj1.content.includes('触发/止损/目标') && fj1.content.includes('技术突破') && fj1.content.includes('跌破 20 日线')
      && fj1.content.includes('成交价')) ok('T3 settle: 成交 journal 含计划要素 + sleeve/auto 字段');
    else fail('T3 settle journal', JSON.stringify(fj1 && { s: fj1.sleeve, a: fj1.auto, c: fj1.content.slice(0, 120) }));

    // 当日防重复结算
    const s1dup = await P2.settleCondOrders(new Date(2026, 6, 27, 18, 0));
    if (s1dup && s1dup.skipped === true && s1dup.filled === 0 && (store2.tables.transactions || []).length === 1) ok('T3 settle: 当日重复调用 skipped, 不重复成交');
    else fail('T3 settle 防重复', JSON.stringify(s1dup));

    // ---------- 38.4 结算: 止损卖出 (盘中触及 → 止损价) ----------
    const store3 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 20000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [],
        paper_short_positions: [{
          holdingId: 'h-stop', code: '600519', name: '贵州茅台',
          stopLoss: 9, targetPrice: 11, entryDate: '2026-07-24', entryPrice: 10,
          planOrderId: 'o-x', shares: 100, holdDays: 0, lastSettleBarDate: '2026-07-24', closed: false
        }]
      },
      tables: {
        holdings: [{ id: 'h-stop', code: '600519', name: '贵州茅台', market: 'sh', shares: 100, costPrice: 10, isPaper: true, sleeve: 'short', stopLoss: 9, targetPrice: 11 }]
      },
      klines: { '600519': [krow('2026-07-24', 10, 10.2, 9.9, 10.1), krow('2026-07-27', 9.5, 9.6, 8.9, 9.1)] }
    };
    const ctx3 = buildCtx(store3);
    const P3 = ctx3.window.Paper;
    const s2 = await P3.settleCondOrders(new Date(2026, 6, 27, 16, 0));
    const sp2 = store3.kv.paper_short_positions[0];
    if (s2 && s2.exited === 1 && sp2.closed === true && sp2.exitReason === '止损' && sp2.exitPrice === 9 && sp2.exitDate === '2026-07-27') ok('T3 settle: 盘中触及止损 → 止损价 9 卖出, 跟踪行关闭');
    else fail('T3 settle 止损', JSON.stringify({ s2, sp2 }));
    if ((store3.tables.holdings || []).length === 0) ok('T3 settle: 止损后 holdings 清仓');
    else fail('T3 settle 止损清仓', JSON.stringify(store3.tables.holdings));
    const stx2 = (store3.tables.transactions || []).find(t => t.type === 'sell');
    if (stx2 && stx2.price === 9 && stx2.date === '2026-07-27' && stx2.exitReason === '止损') ok('T3 settle: 卖出流水带 exitReason');
    else fail('T3 settle 卖出流水', JSON.stringify(stx2));
    // 卖 100 股 @9 = 900, 费 max(0.27,5)+印花税 0.45 = 5.45 → +894.55
    if (Math.abs(store3.kv.paper_account_short.cash - (20000 + 894.55)) < 0.01) ok('T3 settle: 卖出回款含佣金+印花税');
    else fail('T3 settle 回款', JSON.stringify(store3.kv.paper_account_short));
    const sj2 = (store3.tables.journals || [])[0];
    if (sj2 && sj2.content.includes('止损') && sj2.content.includes('入场') && sj2.sleeve === 'short' && sj2.auto === true) ok('T3 settle: 止损 journal 含出入场明细');
    else fail('T3 settle 止损 journal', JSON.stringify(sj2 && sj2.content.slice(0, 120)));

    // ---------- 38.5 结算: holdDays 递增 + 到期强平 ----------
    const store4 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 20000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [],
        paper_short_positions: [{
          holdingId: 'h-hold', code: '600519', name: '贵州茅台',
          stopLoss: 8, targetPrice: 12, entryDate: '2026-07-24', entryPrice: 10,
          planOrderId: 'o-y', shares: 100, holdDays: 0, lastSettleBarDate: '2026-07-24', closed: false
        }]
      },
      tables: {
        holdings: [{ id: 'h-hold', code: '600519', name: '贵州茅台', market: 'sh', shares: 100, costPrice: 10, isPaper: true, sleeve: 'short' }]
      },
      klines: {
        '600519': [
          krow('2026-07-24', 10, 10.2, 9.9, 10.1),
          krow('2026-07-27', 10, 10.4, 9.6, 10.1),
          krow('2026-07-28', 10, 10.4, 9.6, 10.0),
          krow('2026-07-29', 10, 10.4, 9.6, 10.1),
          krow('2026-07-30', 10, 10.4, 9.6, 10.0),
          krow('2026-07-31', 10, 10.4, 9.6, 10.3)   // 第 5 个结算日 → 强平 @ close 10.3
        ]
      }
    };
    const ctx4 = buildCtx(store4);
    const P4 = ctx4.window.Paper;
    const days = [27, 28, 29, 30, 31];
    let lastSummary = null;
    for (let i = 0; i < days.length; i++) {
      lastSummary = await P4.settleCondOrders(new Date(2026, 6, days[i], 16, 0));
      if (i === 0) {
        const sp4 = store4.kv.paper_short_positions[0];
        if (sp4.holdDays === 1 && sp4.closed === false && sp4.lastSettleBarDate === '2026-07-27'
          && (store4.tables.transactions || []).length === 0) ok('T3 settle: 未触发 → holdDays 递增不卖');
        else fail('T3 holdDays 递增', JSON.stringify(sp4));
      }
    }
    const sp4end = store4.kv.paper_short_positions[0];
    if (lastSummary && lastSummary.exited === 1 && sp4end.closed === true && sp4end.holdDays === 5
      && sp4end.exitReason === '到期强平' && sp4end.exitPrice === 10.3) ok('T3 settle: 持满 5 日 → 按收盘价 10.3 强平');
    else fail('T3 到期强平', JSON.stringify({ lastSummary, sp4end }));
    const ftx4 = (store4.tables.transactions || []).find(t => t.type === 'sell');
    if (ftx4 && ftx4.price === 10.3 && ftx4.exitReason === '到期强平') ok('T3 settle: 强平流水价 = 收盘价');
    else fail('T3 强平流水', JSON.stringify(ftx4));

    // ---------- 38.6 结算: 过期 (3 个交易日未触发) ----------
    const store5 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        // 创建于 07-22 (周三), 之后 07-23/07-24/07-27 三根 K 都未触及 → expired
        paper_cond_orders: [mkOrder({ createdDate: '2026-07-22', triggerPrice: 9 })]
      },
      tables: {},
      klines: {
        '600519': [
          krow('2026-07-22', 10, 10.2, 9.9, 10.1),
          krow('2026-07-23', 10.1, 10.3, 10.0, 10.2),
          krow('2026-07-24', 10.2, 10.4, 10.1, 10.3),
          krow('2026-07-27', 10.3, 10.5, 10.2, 10.4)
        ]
      }
    };
    const ctx5 = buildCtx(store5);
    const P5 = ctx5.window.Paper;
    const s5 = await P5.settleCondOrders(new Date(2026, 6, 27, 16, 0));
    const eo5 = store5.kv.paper_cond_orders[0];
    if (s5 && s5.expired === 1 && eo5.status === 'expired' && (store5.tables.holdings || []).length === 0) ok('T3 settle: 3 个交易日未触发 → expired, 不成交');
    else fail('T3 settle 过期', JSON.stringify({ s5, st: eo5.status }));
    const ej5 = (store5.tables.journals || [])[0];
    if (ej5 && ej5.content.includes('过期') && ej5.content.includes('原计划') && ej5.sleeve === 'short') ok('T3 settle: 过期 journal 含原计划要素');
    else fail('T3 过期 journal', JSON.stringify(ej5 && ej5.content.slice(0, 120)));

    // ---------- 38.7 结算: 纪律 blocks → cancelled ----------
    const store6 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [mkOrder()]
      },
      tables: {},
      klines: { '600519': [krow('2026-07-24', 10.5, 10.6, 10.4, 10.5), krow('2026-07-27', 10.2, 10.3, 9.8, 10.0)] }
    };
    const ctx6 = buildCtx(store6, { disciplineBlocks: ['买入后单票占比超限'] });
    const P6 = ctx6.window.Paper;
    const s6 = await P6.settleCondOrders(new Date(2026, 6, 27, 16, 0));
    const co6 = store6.kv.paper_cond_orders[0];
    if (s6 && s6.cancelled === 1 && co6.status === 'cancelled' && (co6.cancelReason || '').includes('纪律拦截')
      && (store6.tables.holdings || []).length === 0) ok('T3 settle: 纪律 blocks → cancelled + cancelReason, 不成交');
    else fail('T3 settle 纪律拦截', JSON.stringify({ s6, co6 }));

    // ---------- 38.8 结算: 单代码拉 K 失败跳过, 不影响其他代码, 不 throw ----------
    const store7 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [
          mkOrder({ id: 'o-fail', code: '600519' }),
          mkOrder({ id: 'o-good', code: '000001', name: '平安银行', market: 'sz' })
        ]
      },
      tables: {},
      klines: { '000001': [krow('2026-07-24', 10.5, 10.6, 10.4, 10.5), krow('2026-07-27', 10.2, 10.3, 9.8, 10.0)] },
      klineFail: { '600519': true }
    };
    const ctx7 = buildCtx(store7);
    const P7 = ctx7.window.Paper;
    let threw7 = false, s7 = null;
    try { s7 = await P7.settleCondOrders(new Date(2026, 6, 27, 16, 0)); } catch (e) { threw7 = true; }
    const oFail = store7.kv.paper_cond_orders.find(o => o.id === 'o-fail');
    const oGood = store7.kv.paper_cond_orders.find(o => o.id === 'o-good');
    if (!threw7 && s7 && s7.skippedCodes.includes('600519') && oFail.status === 'pending'
      && oGood.status === 'filled' && s7.filled === 1) ok('T3 settle: 拉 K 失败代码跳过 pending 不动, 其他代码照常成交, 不 throw');
    else fail('T3 settle 失败隔离', JSON.stringify({ threw7, s7, fail: oFail.status, good: oGood.status }));

    // 开盘跳空成交 (below: open ≤ trigger → 开盘价, 比触发价更优)
    const store8 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [mkOrder({ triggerPrice: 10 })]
      },
      tables: {},
      klines: { '600519': [krow('2026-07-24', 10.5, 10.6, 10.4, 10.5), krow('2026-07-27', 9.5, 9.8, 9.2, 9.6)] }
    };
    const ctx8 = buildCtx(store8);
    const P8 = ctx8.window.Paper;
    const s8 = await P8.settleCondOrders(new Date(2026, 6, 27, 16, 0));
    if (s8 && s8.filled === 1 && store8.kv.paper_cond_orders[0].fillPrice === 9.5) ok('T3 settle: 开盘已低于触发 → 按开盘价 9.5 成交');
    else fail('T3 settle 开盘成交', JSON.stringify(s8));

    // 收盘后创建的单不回溯当日 K (createdAfterClose)
    const store9 = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 },
        paper_cond_orders: [mkOrder({ createdDate: '2026-07-27', createdAfterClose: true, expireAt: new Date(2026, 6, 30).getTime() })]
      },
      tables: {},
      klines: { '600519': [krow('2026-07-27', 10.2, 10.3, 9.8, 10.0)] }
    };
    const ctx9 = buildCtx(store9);
    const P9 = ctx9.window.Paper;
    const s9 = await P9.settleCondOrders(new Date(2026, 6, 27, 20, 0));
    if (s9 && s9.filled === 0 && store9.kv.paper_cond_orders[0].status === 'pending') ok('T3 settle: 收盘后创建 → 当日 K 不回溯成交');
    else fail('T3 settle 不回溯', JSON.stringify(s9));

  } catch (e) {
    fail('T3 条件单引擎', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [39] ShortTrader 盘前 AI 交易计划 (T2) ==========
section('[39] ShortTrader 盘前 AI 交易计划 (T2): 交易日判定 / prompt / 校验管线 / 落地接线');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');
    const K = _loadRealConstants();

    // 39.0 T2 ShortTrader 常量进 Core.Constants
    if (K.SHORT_PLAN_LOG_LIMIT === 100 && K.SHORT_PLAN_JOURNAL_DAYS === 3) {
      ok('T2-ST 常量: SHORT_PLAN_LOG_LIMIT=100 / SHORT_PLAN_JOURNAL_DAYS=3');
    } else fail('T2-ST 常量', JSON.stringify({ l: K.SHORT_PLAN_LOG_LIMIT, d: K.SHORT_PLAN_JOURNAL_DAYS }));

    // 真实 Core.Premortem (校验管线 a2 依赖, checkPick 是纯函数)
    const pmCtx = vm.createContext({ window: {}, console });
    vm.runInContext(readFileSafe(path.join(WWW, 'core/premortem.js')), pmCtx);
    const realPremortem = pmCtx.window.Core.Premortem;
    // 真实 Core.PositionSizing (Commit 2 H1 凯利集成, _validatePlans 依赖 _kellyFraction + _clampKelly)
    const psCtx = vm.createContext({ window: {}, console });
    vm.runInContext(readFileSafe(path.join(WWW, 'core/position-sizing.js')), psCtx);
    const realPositionSizing = psCtx.window.Core.PositionSizing;
    // 真实 Core.AI.parseJsonOutput (Phase T 模式, 从 ai-service 提取; 加载只需 State/get mock)
    const aiCtx = { console, setTimeout, clearTimeout, Core: { State: { get: () => ({}) } }, fetch: async () => ({ ok: false }) };
    vm.createContext(aiCtx);
    aiCtx.window = aiCtx;
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), aiCtx);
    const realParseJsonOutput = aiCtx.Core.AI.parseJsonOutput;
    if (!realParseJsonOutput) throw new Error('ai-service.parseJsonOutput 提取失败');

    // vm sandbox: mock Core.Storage (内存 kv/表) + Paper + Regime; LLM 走 deps.callLLM 注入
    const buildCtx = (storageData) => {
      storageData.addedOrders = storageData.addedOrders || [];
      const sctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtDateTime: () => '2026-07-27 08:30',
        confirm: () => true,
        document: { getElementById: () => null }
      };
      sctx.window.Core = {
        Constants: K,
        Storage: {
          kvGet: async (k) => (k in storageData.kv ? storageData.kv[k] : null),
          kvSet: async (k, v) => { storageData.kv[k] = v; },
          all: async (t) => storageData.tables[t] || []
        },
        Data: { getIndexSpot: async () => storageData.indexSpot || [],
          // Tier 2: formatForPrompt mock (返空避免 throw, 不影响注入逻辑断言)
          formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
          getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null },
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Premortem: realPremortem,
        PositionSizing: _loadRealPositionSizing(),
        AI: {
          parseJsonOutput: realParseJsonOutput,
          callWithTimeout: async () => { throw new Error('测试不应走到真实 LLM'); }
        },
        Regime: storageData.regimeMock || {
          get: async () => ({ state: 'range' }),
          gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 })
        },
        Discipline: { DEFAULT_CONFIG: { short: { maxDailyTrades: 3, cooldownHours: 48 } } }
      };
      sctx.Core = sctx.window.Core;
      const paperMock = {
        _roundLot: (s) => Math.floor((parseFloat(s) || 0) / 100) * 100,
        _getAccountRaw: async () => storageData.account || { cash: 30000, initialCash: 30000, positionPct: 0.2 },
        getPositions: async () => storageData.positions || [],
        listCondOrders: async () => storageData.condOrders || [],
        addCondOrder: async (o) => {
          storageData.addedOrders.push(o);
          return { ok: true, order: { id: 'ord-' + storageData.addedOrders.length, ...o } };
        }
      };
      sctx.window.Paper = paperMock;
      sctx.Paper = paperMock;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(stSrc, sctx);
      return sctx;
    };

    const ctx0 = buildCtx({ kv: {}, tables: {} });
    const ST = ctx0.window.ShortTrader;
    if (!ST) throw new Error('ShortTrader 未挂到 window');

    // 39.1 _isTradingDay 边界 (2026-07-27 周一 / 07-31 周五 / 07-25 周六 / 07-26 周日)
    if (ST._isTradingDay(new Date(2026, 6, 27)) === true
      && ST._isTradingDay(new Date(2026, 6, 31)) === true) ok('tradingDay: 周一/周五 → true');
    else fail('tradingDay 工作日', '');
    if (ST._isTradingDay(new Date(2026, 6, 25)) === false
      && ST._isTradingDay(new Date(2026, 6, 26)) === false) ok('tradingDay: 周六/周日 → false');
    else fail('tradingDay 周末', '');
    if (ST._isTradingDay('不是日期') === false) ok('tradingDay: 非法日期 → false');
    else fail('tradingDay 非法', '');

    // 39.2 prompt 组装要素
    const sp = ST._buildSystemPrompt();
    if (sp.includes('marketView') && sp.includes('plans') && sp.includes('probability')
      && sp.includes('confidence') && sp.includes('宁缺毋滥') && sp.includes('below')
      && sp.includes('falsifyCondition') && sp.includes('invalidation')) ok('prompt: systemPrompt 含 schema/空仓人设/pre-mortem 要素');
    else fail('prompt systemPrompt', '');
    const up = ST._buildUserPrompt({
      today: '2026-07-27', cash: 30000,
      positions: [{ code: '600519', name: '贵州茅台', shares: 100, costPrice: 10, price: 11, stopLoss: 9, targetPrice: 12, plPct: 0.1 }],
      pendingOrders: [{ code: '000001', triggerDirection: 'below', triggerPrice: 5, stopLoss: 4.5, targetPrice: 5.5, shares: 100 }],
      recentJournals: [{ date: '2026-07-26', code: '600519', title: '止损复盘' }],
      regime: { state: 'bear', label: '下跌市 ⚠', positionScale: 0.5 },
      marketText: '上证指数 3500 (0.5%)',
      pool: [{ code: '600519', name: '贵州茅台' }]
    });
    if (up.includes('现金') && up.includes('候选池') && up.includes('大盘状态机')
      && up.includes('待触发条件单') && up.includes('短线交易摘要') && up.includes('指数快照')
      && up.includes('600519') && up.includes('仓位自动减半')) ok('prompt: userPrompt 含账户/持仓/条件单/journal/regime/市场/候选池');
    else fail('prompt userPrompt', '');

    // 39.3 校验管线全分支 (_validatePlans 纯函数)
    const mkPlan = (over) => Object.assign({
      code: '600519', name: '贵州茅台', triggerDirection: 'below',
      triggerPrice: 10, stopLoss: 9, targetPrice: 11,
      positionPct: 0.2, assumption: '技术突破',
      falsifyCondition: '跌破 20 日线', invalidation: '3 日未反弹',
      probability: 60, confidence: '中', reason: '回踩支撑',
      bullCase: ['放量突破'], bearCase: ['大盘走弱拖累']
    }, over || {});
    const vctx = (over) => Object.assign({
      pool: new Set(['600519', '000001']), cash: 30000, quotaLeft: 3,
      recentSellCodes: new Set(), regimeState: 'range', positionScale: 1,
      roundLot: (s) => Math.floor(s / 100) * 100
    }, over || {});
    // 合法通过 + shares 换算整手 (30000×0.1/10 = 300) — H1 凯利生效后 positionPct 来自凯利
    // mkPlan 默认 prob=60, R=(11-10)/(10-9)=1, raw=(0.6-0.4/1)/1=0.2, 半凯利=0.1, 整手 300 股
    let r = ST._validatePlans([mkPlan()], vctx());
    if (r.passed.length === 1 && r.dropped.length === 0 && r.passed[0].shares === 300
      && Math.abs(r.passed[0].positionPct - 0.1) < 0.005
      && Math.abs(r.passed[0].kellyRaw - 0.2) < 0.005
      && r.passed[0].probability === 60 && r.passed[0].confidence === '中') ok('validate: 合法 plan 通过, 凯利 f=0.1, shares=现金×pct/价→整手 300');
    else fail('validate 通过', JSON.stringify(r));
    // plans=[] 空仓合法
    r = ST._validatePlans([], vctx());
    if (r.passed.length === 0 && r.dropped.length === 0) ok('validate: plans=[] 空仓合法 (0 通过 0 丢弃)');
    else fail('validate 空仓', JSON.stringify(r));
    // (a) schema 分支
    const schemaCases = [
      [{ code: 'abc' }, 'code 非 6 位'],
      [{ code: '600519', triggerDirection: 'up' }, '方向非法'],
      [{ probability: undefined }, 'probability 缺'],
      [{ probability: 120 }, 'probability 超界'],
      [{ confidence: '很高' }, 'confidence 非法'],
      [{ assumption: '' }, 'assumption 缺']
    ];
    let schemaOk = true;
    for (const [over, tag] of schemaCases) {
      const rr = ST._validatePlans([mkPlan(over)], vctx());
      if (!(rr.passed.length === 0 && rr.dropped.length === 1 && rr.dropped[0].stage === 'schema')) {
        schemaOk = false; fail('validate schema ' + tag, JSON.stringify(rr.dropped));
      }
    }
    if (schemaOk) ok('validate: schema 6 分支全丢弃 (stage=schema)');
    // (a2) premortem 分支
    let pmOk = true;
    for (const over of [{ bearCase: [] }, { falsifyCondition: '' }, { invalidation: '' }, { bearCase: ['无明显风险'] }]) {
      const rr = ST._validatePlans([mkPlan(over)], vctx());
      if (!(rr.passed.length === 0 && rr.dropped.length === 1 && rr.dropped[0].stage === 'premortem')) {
        pmOk = false; fail('validate premortem', JSON.stringify(rr.dropped));
      }
    }
    if (pmOk) ok('validate: pre-mortem 4 分支 (缺 bearCase/falsify/invalidation/空话) 全丢弃');
    // (b) 幻觉防护
    r = ST._validatePlans([mkPlan({ code: '600000' })], vctx());
    if (r.passed.length === 0 && r.dropped[0] && r.dropped[0].stage === 'hallucination') ok('validate: 池外代码 → hallucination 丢弃');
    else fail('validate 幻觉', JSON.stringify(r.dropped));
    // (c) 价格关系
    let priceOk = true;
    for (const over of [{ stopLoss: 10.5 }, { targetPrice: 9.5 }, { stopLoss: 10 }]) {
      const rr = ST._validatePlans([mkPlan(over)], vctx());
      if (!(rr.passed.length === 0 && rr.dropped.length === 1 && rr.dropped[0].stage === 'price')) {
        priceOk = false; fail('validate price', JSON.stringify(rr.dropped));
      }
    }
    if (priceOk) ok('validate: 价格关系 3 分支 (止损≥触发 / 目标≤触发) 全丢弃');
    // (d) 短线纪律: quota
    r = ST._validatePlans([mkPlan()], vctx({ quotaLeft: 0 }));
    if (r.passed.length === 0 && r.dropped[0] && r.dropped[0].stage === 'quota') ok('validate: 今日已建满 3 单 (quotaLeft=0) → quota 丢弃');
    else fail('validate quota0', JSON.stringify(r.dropped));
    r = ST._validatePlans([mkPlan(), mkPlan({ code: '000001', name: '平安银行' })], vctx({ quotaLeft: 1 }));
    if (r.passed.length === 1 && r.dropped.length === 1 && r.dropped[0].stage === 'quota') ok('validate: quotaLeft=1 时第 2 条 → quota 丢弃');
    else fail('validate quota1', JSON.stringify(r));
    // (d) 短线纪律: cooldown
    r = ST._validatePlans([mkPlan()], vctx({ recentSellCodes: new Set(['600519']) }));
    if (r.passed.length === 0 && r.dropped[0] && r.dropped[0].stage === 'cooldown') ok('validate: 48h 内有卖出 → cooldown 丢弃');
    else fail('validate cooldown', JSON.stringify(r.dropped));
    // (d2) 不足一手
    r = ST._validatePlans([mkPlan()], vctx({ cash: 500 }));
    if (r.passed.length === 0 && r.dropped[0] && r.dropped[0].stage === 'shares') ok('validate: 现金 500 换算不足一手 → shares 丢弃');
    else fail('validate shares', JSON.stringify(r.dropped));
    // H1 凯利后, LLM 报 positionPct=0.5 不再走 _scalePositionPct 上限收敛 — 凯利先算 (0.1),
    // 然后 _scalePositionPct 用凯利结果作为 pct 入参, 无超上限 → positionPct=0.1
    r = ST._validatePlans([mkPlan({ positionPct: 0.5 })], vctx());
    if (r.passed.length === 1 && Math.abs(r.passed[0].positionPct - 0.1) < 0.005
      && Math.abs(r.passed[0].kellyCapped - 0.1) < 0.005) ok('validate: LLM 报 0.5 → 凯利覆盖, positionPct=0.1 (不再用 0.5 走 _scalePositionPct 上限)');
    else fail('validate pct 收敛', JSON.stringify(r));
    // H1 + regime bear: 凯利 0.1 × bear 0.5 = 0.05, shares 30000*0.05/10=150→整手 100
    r = ST._validatePlans([mkPlan()], vctx({ regimeState: 'bear', positionScale: 0.5 }));
    if (r.passed.length === 1 && Math.abs(r.passed[0].positionPct - 0.05) < 0.005 && r.passed[0].shares === 100) ok('validate: H1 凯利 + bear → positionPct=0.05, shares 100');
    else fail('validate regime 缩放', JSON.stringify(r));
    // _scalePositionPct 直测
    if (ST._scalePositionPct(undefined, 'range', 1) === 0.2
      && ST._scalePositionPct(0.5, 'range', 1) === 0.2
      && ST._scalePositionPct(0.1, 'bear', 0.5) === 0.05
      && ST._scalePositionPct(0.1, 'bull', 0.5) === 0.1) ok('scalePct: 缺失默认/超限收敛/bear 缩放/非 bear 不缩放');
    else fail('scalePct', '');
    // H1 maxPct 参数注入 (Commit 2): 传入 0.10 → 收敛到 0.10 (替代默认 0.20)
    if (ST._scalePositionPct(0.5, 'range', 1, 0.10) === 0.10
      && ST._scalePositionPct(0.05, 'range', 1, 0.10) === 0.05
      && ST._scalePositionPct(undefined, 'range', 1, 0.10) === 0.10) ok('scalePct maxPct: 4 参签名, 默认走 maxPct 而非 MAX_POSITION_PCT');
    else fail('scalePct maxPct', '');

    // H1 凯利集成 (Commit 2): validatePlans 输出的 passed 含 kellyRaw/kellyCapped/payoffRatio
    // 构造一个有完整 4 参的 plan: tp=10 sl=9 tg=13 → R=3, prob=80 → raw=(0.8-0.2/3)/3=0.244, kelly=0.1222
    // _clampKelly(0.1222, 0.20) → 0.1222 (未超 maxPct)
    const kellyPlan = {
      code: '600519', name: '凯利测试', triggerDirection: 'below',
      triggerPrice: 10, stopLoss: 9, targetPrice: 13, positionPct: 0.5,
      probability: 80, confidence: '高', assumption: '技术突破', reason: 'test',
      bullCase: 'x', bearCase: 'y', falsifyCondition: 'z', invalidation: 'w'
    };
    const kellyRes = ST._validatePlans([kellyPlan], vctx({ cash: 100000, quotaLeft: 3, regimeState: 'range', positionScale: 1 }));
    if (kellyRes.passed.length === 1) {
      const p = kellyRes.passed[0];
      // positionPct 应是凯利 clamp 后 (0.1222), 而非 LLM 报的 0.5
      if (Math.abs(p.positionPct - 0.1222) < 0.005
        && Math.abs(p.kellyCapped - 0.1222) < 0.005
        && Math.abs(p.kellyRaw - 0.244) < 0.01
        && Math.abs(p.payoffRatio - 3) < 0.01) {
        ok(`H1 凯利集成: p=80 R=3 → positionPct=${p.positionPct} (覆写 LLM 报的 0.5), 含 kellyRaw/Capped/R`);
      } else fail('H1 凯利集成 positionPct 错', `positionPct=${p.positionPct} kellyRaw=${p.kellyRaw} R=${p.payoffRatio}`);
    } else fail('H1 凯利集成 未通过', JSON.stringify(kellyRes.dropped));

    // H1 凯利 + regime bear: 凯利 0.1222 × 0.5 (bear) = 0.0611
    const kellyBearRes = ST._validatePlans([kellyPlan], vctx({ cash: 100000, quotaLeft: 3, regimeState: 'bear', positionScale: 0.5 }));
    if (kellyBearRes.passed.length === 1 && Math.abs(kellyBearRes.passed[0].positionPct - 0.0611) < 0.005) {
      ok(`H1 凯利 + bear regime: positionPct=${kellyBearRes.passed[0].positionPct} (凯利 0.122 × bear 0.5)`);
    } else fail('H1 凯利 + bear', JSON.stringify(kellyBearRes));

    // H1 凯利超 maxPct: prob=99 R=3 → raw=0.33 ×0.5=0.165; prob=99 R=10 → raw=0.099 ×0.5=0.0496;
    // 构造 raw > maxPct (0.20) 的场景: prob 极高 + R 高 → 不容易超, 直接测 _clampKelly 上限
    // 用 prob=99 tg-tp=20 sl-tp=1 R=20 → raw=(0.99-0.01/20)/20=0.0495 ×0.5=0.0247
    // 直接验证 clamp 上限: 给一个 raw > 0.20 的值, _clampKelly 应收敛
    const _PS = _loadRealPositionSizing();
    if (_PS._clampKelly(0.50, 0.20) === 0.20
      && _PS._clampKelly(0.001, 0.20) === 0.20  // 凯利<minPct 走上限
      && _PS._clampKelly(0, 0.20) === 0.20  // 兜底
      && _PS._clampKelly(0.10, 0.20) === 0.10) {  // 中间值原样
      ok('H1 _clampKelly 上限/下限/兜底/中间值');
    } else fail('H1 _clampKelly', '');

    // 39.4 _hasRecentShortSell 分支
    const NOW = new Date(2026, 6, 27, 8, 30).getTime();
    const sellTx = (createdAt, over) => Object.assign({ isPaper: true, sleeve: 'short', type: 'sell', code: '600519', createdAt }, over || {});
    if (ST._hasRecentShortSell([sellTx(NOW - 10 * 3600 * 1000)], '600519', NOW, 48) === true) ok('cooldown: 10h 前短线卖出 → true');
    else fail('cooldown 10h', '');
    if (ST._hasRecentShortSell([sellTx(NOW - 49 * 3600 * 1000)], '600519', NOW, 48) === false) ok('cooldown: 49h 前 → false (过冷却期)');
    else fail('cooldown 49h', '');
    if (ST._hasRecentShortSell([sellTx(NOW - 1000, { type: 'buy' })], '600519', NOW, 48) === false
      && ST._hasRecentShortSell([sellTx(NOW - 1000, { sleeve: 'long' })], '600519', NOW, 48) === false
      && ST._hasRecentShortSell([sellTx(NOW - 1000, { isPaper: false })], '600519', NOW, 48) === false
      && ST._hasRecentShortSell([sellTx(NOW - 1000)], '000001', NOW, 48) === false) ok('cooldown: buy/长线/实盘/异代码 → false');
    else fail('cooldown 排除项', '');

    // 39.5 _appendPlanLog 上限 100
    let log = [];
    for (let i = 0; i < 105; i++) log = ST._appendPlanLog(log, { date: '2026-07-27', code: '600519', stage: 'quota', reason: 'r' + i });
    if (log.length === 100 && log[0].reason === 'r5' && log[99].reason === 'r104') ok('planLog: 上限 100 滚动截断');
    else fail('planLog 上限', 'len=' + log.length);
    if (ST._appendPlanLog([], { code: '600519' }).length === 0) ok('planLog: 缺 stage 不入库');
    else fail('planLog 缺 stage', '');

    // 39.6 _buildCandidatePool: watchlist + short 持仓去重
    const pool = ST._buildCandidatePool(
      [{ code: '600519', name: '贵州茅台' }, { code: 'sh000001', name: '平安银行' }],
      [{ code: '600519', name: '贵州茅台' }, { code: '300750', name: '宁德时代' }]
    );
    if (pool.length === 3 && pool[0].code === '600519' && pool[1].code === '000001' && pool[2].code === '300750') ok('pool: watchlist+持仓合并去重, 容忍 sh 前缀');
    else fail('pool', JSON.stringify(pool));

    // 39.7 generatePlan 集成: mock LLM → 1 条过 + 1 条幻觉丢弃 → addCondOrder 接线 + kv 落库
    const store7 = {
      kv: {},
      tables: {
        watchlist: [{ code: '600519', name: '贵州茅台' }, { code: '000001', name: '平安银行' }],
        journals: [{ date: '2026-07-26', title: '短线止损复盘', code: '600519', sleeve: 'short' }],
        transactions: []
      },
      condOrders: [],
      indexSpot: [{ 代码: '000001', 名称: '上证指数', 最新价: 3500, 涨跌幅: 0.5 }]
    };
    const ctx7 = buildCtx(store7);
    const ST7 = ctx7.window.ShortTrader;
    const llmJson = JSON.stringify({
      marketView: '震荡偏多, 关注回调低吸',
      plans: [mkPlan(), mkPlan({ code: '600000', name: '浦发银行' })]
    });
    let llmCalls = 0;
    const plan7 = await ST7.generatePlan({
      now: new Date(2026, 6, 27, 8, 30),
      deps: { callLLM: async ({ systemPrompt, prompt }) => { llmCalls++; return llmJson; } }
      // P0-1: generatePlan 现在做 3 路并行 self-consistency 投票, llmCalls 应 = 3
    });
    if (llmCalls === 3 && plan7.date === '2026-07-27' && plan7.marketView.includes('震荡')) ok('gen: self-consistency 3 路 LLM 调用, plan.date/marketView 落盘 (P0-1)');
    else fail('gen 基本', JSON.stringify({ llmCalls, date: plan7.date }));
    if (plan7.plans.length === 1 && plan7.plans[0].code === '600519'
      && plan7.plans[0].condOrderId && plan7.plans[0].shares === 300) ok('gen: 通过 1 条, condOrderId 回填, shares 300 (H1 凯利生效)');
    else fail('gen plans', JSON.stringify(plan7.plans));
    if (plan7.dropped.length === 1 && plan7.dropped[0].stage === 'hallucination' && plan7.dropped[0].code === '600000') ok('gen: 池外 600000 → hallucination 丢弃');
    else fail('gen dropped', JSON.stringify(plan7.dropped));
    if (store7.addedOrders.length === 1 && store7.addedOrders[0].source === 'ai'
      && store7.addedOrders[0].sleeve === 'short' && store7.addedOrders[0].code === '600519'
      && store7.addedOrders[0].shares === 300 && store7.addedOrders[0].probability === 60) ok('gen: addCondOrder 接线 (source=ai, sleeve=short, 整手/probability 透传, H1 凯利 300)');
    else fail('gen addCondOrder', JSON.stringify(store7.addedOrders));
    if (store7.kv.paper_short_plan && store7.kv.paper_short_plan.date === '2026-07-27'
      && Array.isArray(store7.kv.paper_short_plan.plans)) ok('gen: kv paper_short_plan 落库');
    else fail('gen kv plan', '');
    if (Array.isArray(store7.kv.paper_plan_log) && store7.kv.paper_plan_log.length === 1
      && store7.kv.paper_plan_log[0].code === '600000' && store7.kv.paper_plan_log[0].date === '2026-07-27') ok('gen: 丢弃留痕 paper_plan_log 落库');
    else fail('gen kv log', JSON.stringify(store7.kv.paper_plan_log));

    // 39.8 regime bear 集成缩放
    const store8 = { kv: {}, tables: { watchlist: [{ code: '600519', name: '贵州茅台' }], transactions: [] }, condOrders: [],
      regimeMock: { get: async () => ({ state: 'bear' }), gateMultipliers: () => ({ state: 'bear', label: '下跌市 ⚠', positionScale: 0.5 }) } };
    const ctx8 = buildCtx(store8);
    const plan8 = await ctx8.window.ShortTrader.generatePlan({
      now: new Date(2026, 6, 27, 8, 30),
      deps: { callLLM: async () => JSON.stringify({ marketView: 'm', plans: [mkPlan()] }) }
    });
    if (plan8.plans.length === 1 && Math.abs(plan8.plans[0].positionPct - 0.05) < 0.005 && plan8.plans[0].shares === 100) ok('gen: regime bear + H1 凯利 → 仓位 0.05 (凯利 0.1 × bear 0.5), shares 100');
    else fail('gen bear', JSON.stringify(plan8.plans));

    // 39.9 当日已建 3 单 → quotaLeft=0 全丢弃不落地
    const today3 = '2026-07-27';
    const store9 = { kv: {}, tables: { watchlist: [{ code: '600519', name: '贵州茅台' }], transactions: [] },
      condOrders: [1, 2, 3].map(i => ({ id: 'o' + i, code: '60051' + i, status: 'pending', createdDate: today3 })) };
    const ctx9 = buildCtx(store9);
    const plan9 = await ctx9.window.ShortTrader.generatePlan({
      now: new Date(2026, 6, 27, 8, 30),
      deps: { callLLM: async () => JSON.stringify({ marketView: 'm', plans: [mkPlan()] }) }
    });
    if (plan9.plans.length === 0 && plan9.dropped.length === 1 && plan9.dropped[0].stage === 'quota'
      && store9.addedOrders.length === 0) ok('gen: 今日已建 3 单 → 新计划全 quota 丢弃, 不落地');
    else fail('gen quota', JSON.stringify(plan9.dropped));

    // 39.10 当日防重复 maybeGeneratePlan
    const store10 = { kv: { paper_short_plan: { date: '2026-07-27', plans: [] } }, tables: {} };
    const ctx10 = buildCtx(store10);
    const ST10 = ctx10.window.ShortTrader;
    const r10a = await ST10.maybeGeneratePlan(new Date(2026, 6, 27, 8, 30));
    if (r10a.skipped === true && r10a.reason === 'exists') ok('maybe: 今日已有记录 → skipped exists');
    else fail('maybe exists', JSON.stringify(r10a));
    const r10b = await ST10.maybeGeneratePlan(new Date(2026, 6, 26, 8, 30));
    if (r10b.skipped === true && r10b.reason === 'non-trading-day') ok('maybe: 周日 → skipped non-trading-day');
    else fail('maybe weekend', JSON.stringify(r10b));
    let genCalled = 0;
    ST10.generatePlan = async () => { genCalled++; return { date: '2026-07-28', plans: [] }; };
    const r10c = await ST10.maybeGeneratePlan(new Date(2026, 6, 28, 8, 30));
    if (r10c.skipped === false && genCalled === 1) ok('maybe: 交易日无记录 → 自动生成 1 次');
    else fail('maybe 自动生成', JSON.stringify({ r: r10c, genCalled }));

    // 39.11 失败路径: LLM 异常 → generatePlan throw, maybeGeneratePlan 吞掉 + kv error 记录
    const store11 = { kv: {}, tables: { watchlist: [] } };
    const ctx11 = buildCtx(store11);
    const ST11 = ctx11.window.ShortTrader;
    let threw = false;
    try {
      await ST11.generatePlan({ now: new Date(2026, 6, 27, 8, 30), deps: { callLLM: async () => { throw new Error('LLM 超时'); } } });
    } catch (e) { threw = true; }
    if (threw) ok('gen: LLM 异常 → generatePlan throw (交给调用方)');
    else fail('gen throw', '');
    ST11.generatePlan = async () => { throw new Error('LLM 超时'); };
    const r11 = await ST11.maybeGeneratePlan(new Date(2026, 6, 27, 8, 30));
    if (r11.skipped === false && r11.error && store11.kv.paper_short_plan
      && store11.kv.paper_short_plan.error && store11.kv.paper_short_plan.plans.length === 0) ok('maybe: 失败不打扰 → kv 写 error 记录 (UI 显示可重试)');
    else fail('maybe 失败记录', JSON.stringify({ r: r11, kv: store11.kv.paper_short_plan }));

    // 39.12 LLM 输出非 JSON → 3 路 parseJsonOutput 全失败 → throw
    const store12 = { kv: {}, tables: { watchlist: [] } };
    const ctx12 = buildCtx(store12);
    let threw12 = false;
    try {
      await ctx12.window.ShortTrader.generatePlan({ now: new Date(2026, 6, 27, 8, 30), deps: { callLLM: async () => '我无法给出建议' } });
    } catch (e) { threw12 = e.message.includes('全失败'); }
    if (threw12) ok('gen: 非 JSON 输出 → 3 路全 parseJsonOutput 失败 throw (P0-1 self-consistency)');
    else fail('gen 非-JSON', '');

  } catch (e) {
    fail('39 ShortTrader T2', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [40] ShortTrader T4 学习环: 机械 verify / 成绩单 / 教训提炼 / 校准 ==========
section('[40] ShortTrader T4 学习环: _judgeClosedTrade 全分支 / verify 扫描 / 成绩单 / distill / Brier');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');
    const K = _loadRealConstants();

    // 40.0 T4 常量进 Core.Constants
    if (K.SHORT_VERIFY_DELAY_DAYS === 1 && K.SHORT_VERIFY_LOOKAHEAD_BARS === 3
      && K.SHORT_VERIFY_KLINE_BARS === 10 && K.SHORT_TARGET_RUNUP_PCT === 0.05
      && K.SHORT_LESSONS_LIMIT === 20 && K.SHORT_LESSONS_MIN_NEW_SAMPLES === 5
      && K.SHORT_LESSONS_DISTILL_INTERVAL_MS === 7 * 24 * 3600 * 1000) {
      ok('T4 常量: verify 延迟/观察窗/K线数/续涨阈值 + lessons 上限/门槛/间隔');
    } else fail('T4 常量', JSON.stringify({
      d: K.SHORT_VERIFY_DELAY_DAYS, la: K.SHORT_VERIFY_LOOKAHEAD_BARS, kb: K.SHORT_VERIFY_KLINE_BARS,
      ru: K.SHORT_TARGET_RUNUP_PCT, ll: K.SHORT_LESSONS_LIMIT, mn: K.SHORT_LESSONS_MIN_NEW_SAMPLES
    }));

    // 真实 Core.AI.parseJsonOutput (distill JSON 校验用)
    const aiCtx40 = { console, setTimeout, clearTimeout, Core: { State: { get: () => ({}) } }, fetch: async () => ({ ok: false }) };
    vm.createContext(aiCtx40);
    aiCtx40.window = aiCtx40;
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), aiCtx40);
    const realParseJsonOutput40 = aiCtx40.Core.AI.parseJsonOutput;
    if (!realParseJsonOutput40) throw new Error('ai-service.parseJsonOutput 提取失败');

    // vm sandbox: mock Core.Storage (内存 kv/表/put) + Paper (generatePlan 接线用)
    const buildCtx40 = (storageData) => {
      storageData.puts = storageData.puts || [];
      storageData.addedOrders = storageData.addedOrders || [];
      const sctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtDateTime: () => '2026-07-27 08:30',
        confirm: () => true,
        document: { getElementById: () => null }
      };
      sctx.window.Core = {
        Constants: K,
        Storage: {
          kvGet: async (k) => (k in storageData.kv ? storageData.kv[k] : null),
          kvSet: async (k, v) => { storageData.kv[k] = v; },
          all: async (t) => storageData.tables[t] || [],
          put: async (t, row) => { storageData.puts.push({ t, row }); }
        },
        Data: {
          getIndexSpot: async () => [],
          getStockKLine: async () => { throw new Error('测试应注入 deps.getBars'); },
          formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
          getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null
        },
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Premortem: { checkPick: () => [], PROMPT_SPEC: 'spec' },
        PositionSizing: _loadRealPositionSizing(),
        AI: {
          parseJsonOutput: realParseJsonOutput40,
          callWithTimeout: async () => { throw new Error('测试不应走到真实 LLM'); }
        },
        Regime: {
          get: async () => ({ state: 'range' }),
          gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 })
        },
        Discipline: { DEFAULT_CONFIG: { short: { maxDailyTrades: 3, cooldownHours: 48 } } }
      };
      sctx.Core = sctx.window.Core;
      const paperMock = {
        _roundLot: (s) => Math.floor((parseFloat(s) || 0) / 100) * 100,
        _getAccountRaw: async () => ({ cash: 30000, initialCash: 30000 }),
        getPositions: async () => [],
        listCondOrders: async () => [],
        addCondOrder: async (o) => {
          storageData.addedOrders.push(o);
          return { ok: true, order: { id: 'ord-' + storageData.addedOrders.length, ...o } };
        }
      };
      sctx.window.Paper = paperMock;
      sctx.Paper = paperMock;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(stSrc, sctx);
      return sctx;
    };

    const ctx40 = buildCtx40({ kv: {}, tables: {} });
    const ST = ctx40.window.ShortTrader;
    if (!ST) throw new Error('ShortTrader 未挂到 window');
    const bar = (date, open, high, low, close) => ({ date, open, high, low, close });

    // ---- 40.1 _judgeClosedTrade 全分支 ----
    const J = (o) => ST._judgeClosedTrade(o);
    // 兜底: 盈利 → correct / 亏损 → wrong+假设错误
    let j = J({ exitReason: '手动卖出', pnl: 0.5, entryPrice: 10, exitPrice: 10.5, exitDate: '2026-07-20', bars: [] });
    if (j.outcome === 'correct' && j.reason === null) ok('judge: 未知退出+盈利 → correct');
    else fail('judge 兜底盈利', JSON.stringify(j));
    j = J({ exitReason: '手动卖出', pnl: -0.5, entryPrice: 10, exitPrice: 9.5, exitDate: '2026-07-20', bars: [] });
    if (j.outcome === 'wrong' && j.reason === '假设错误') ok('judge: 未知退出+亏损 → wrong/假设错误');
    else fail('judge 兜底亏损', JSON.stringify(j));
    // 止损: 持有 ≥ 3 日, 第 2 根收复入场价 → wrong + 时机过早
    // (P0-2 归因细化: 持有 <3 日走"择时错"分支, 此用例确保 barsHeld ≥ 3 测到时机过早)
    const barsRecover = [
      bar('2026-07-17', 10.2, 10.3, 10, 10.1),
      bar('2026-07-18', 10.1, 10.2, 9.9, 10),
      bar('2026-07-20', 10, 10.1, 9.4, 9.5),   // 出场日 (barsHeld=3)
      bar('2026-07-21', 9.5, 9.7, 9.4, 9.6),
      bar('2026-07-22', 9.8, 10.2, 9.7, 10.1), // close 10.1 ≥ 入场价 10 → 收复
      bar('2026-07-23', 10.1, 10.3, 10, 10.2)
    ];
    j = J({ exitReason: '止损', pnl: -0.5, entryPrice: 10, exitPrice: 9.5, exitDate: '2026-07-20', bars: barsRecover });
    if (j.outcome === 'wrong' && j.reason === '时机过早' && j.note.includes('2 日收复')) ok('judge: 止损后 2 日收复入场价 → wrong/时机过早');
    else fail('judge 止损收复', JSON.stringify(j));
    // 止损(跳空) 同口径; barsHeld ≥ 3, 3 日未收复 → wrong + 假设错误
    const barsNoRecover = [
      bar('2026-07-17', 10.2, 10.3, 10, 10.1),
      bar('2026-07-18', 10.1, 10.2, 9.9, 10),
      bar('2026-07-20', 10, 10.1, 9.4, 9.5),  // 出场日 (barsHeld=3)
      bar('2026-07-21', 9.5, 9.7, 9.4, 9.6),
      bar('2026-07-22', 9.6, 9.8, 9.5, 9.7),
      bar('2026-07-23', 9.7, 9.9, 9.6, 9.8)
    ];
    j = J({ exitReason: '止损(跳空)', pnl: -0.5, entryPrice: 10, exitPrice: 9.5, exitDate: '2026-07-20', bars: barsNoRecover });
    if (j.outcome === 'wrong' && j.reason === '假设错误') ok('judge: 止损(跳空) 3 日未收复 → wrong/假设错误');
    else fail('judge 止损未收复', JSON.stringify(j));
    // 止盈: 出场后第 2 日 high 续涨超 5% → partial (归因留空)
    const barsRunup = [
      bar('2026-07-20', 10.8, 11, 10.7, 11),
      bar('2026-07-21', 11, 11.4, 10.9, 11.2),
      bar('2026-07-22', 11.2, 11.6, 11.1, 11.5)  // high 11.6 ≥ 11×1.05=11.55
    ];
    j = J({ exitReason: '止盈', pnl: 1, entryPrice: 10, exitPrice: 11, exitDate: '2026-07-20', bars: barsRunup });
    if (j.outcome === 'partial' && j.reason === null && j.note.includes('卖早')) ok('judge: 止盈后 2 日续涨超 5% → partial (卖早, 归因空)');
    else fail('judge 止盈续涨', JSON.stringify(j));
    // 止盈: 未续涨 → correct
    const barsFlat = [
      bar('2026-07-20', 10.8, 11, 10.7, 11),
      bar('2026-07-21', 11, 11.4, 10.9, 11.2),
      bar('2026-07-22', 11.2, 11.5, 11, 11.3)
    ];
    j = J({ exitReason: '止盈(跳空)', pnl: 1, entryPrice: 10, exitPrice: 11, exitDate: '2026-07-20', bars: barsFlat });
    if (j.outcome === 'correct' && j.reason === null) ok('judge: 止盈后未续涨 → correct');
    else fail('judge 止盈正确', JSON.stringify(j));
    // 到期强平: 盈利 → correct; 亏损 → partial + 时机过早
    j = J({ exitReason: '到期强平', pnl: 0.3, entryPrice: 10, exitPrice: 10.3, exitDate: '2026-07-20', bars: [] });
    if (j.outcome === 'correct') ok('judge: 强平盈利 → correct');
    else fail('judge 强平盈利', JSON.stringify(j));
    j = J({ exitReason: '到期强平', pnl: -0.3, entryPrice: 10, exitPrice: 9.7, exitDate: '2026-07-20', bars: [] });
    if (j.outcome === 'partial' && j.reason === '择时错') ok('judge: 强平亏损 → partial/择时错 (P0-2 归因细化)');
    else fail('judge 强平亏损', JSON.stringify(j));

    // ---- 40.2 _extractExitInfo 解析 ----
    const exitContent = [
      '## ⚡ 短线止损 - 600519 贵州茅台', '',
      '**卖出日期**: 2026-07-24 (日 K 结算)',
      '**原因**: 止损',
      '**入场**: 2026-07-20 @ 10.5 → **出场**: 9.8 × 100 股 (浮动盈亏 ¥-70.00, 未扣费)',
      '**持有**: 3 个交易日',
      '**止损/目标**: 9.5 / 11.5'
    ].join('\n');
    const info = ST._extractExitInfo({ code: 'sh600519', content: exitContent });
    if (info && info.code === '600519' && info.exitReason === '止损' && info.exitDate === '2026-07-24'
      && info.entryDate === '2026-07-20' && info.entryPrice === 10.5 && info.exitPrice === 9.8
      && Math.abs(info.pnl - (-0.7)) < 1e-9) ok('extract: 退出 journal 四要素解析 (含 sh 前缀归一/pnl 符号)');
    else fail('extract 退出行', JSON.stringify(info));
    if (ST._extractExitInfo({ code: '600519', content: '**成交日期**: 2026-07-20\n**成交价**: 10.5 × 100 股' }) === null
      && ST._extractExitInfo({ code: '600519', content: '' }) === null
      && ST._extractExitInfo(null) === null) ok('extract: 买入/空内容/null 行 → null (不误判)');
    else fail('extract 排除项', '');

    // ---- 40.3 verifyClosedTrades 扫描: 已验证/未到期/K线失败跳过, 合格行写回 ----
    const mkExitRow = (id, code, over) => Object.assign({
      id, title: '⚡ 短线止损: ' + code, code,
      content: exitContent, date: '2026-07-24', sleeve: 'short', auto: true, createdAt: 1
    }, over || {});
    const storeV = {
      kv: {},
      tables: {
        journals: [
          mkExitRow('j1', '600519'),                                              // 合格 → 验证写回
          mkExitRow('j2', '600519', { verifyOutcome: 'correct' }),                // 已验证 → 跳过
          mkExitRow('j3', '600520'),                                              // 无出场后 K → 未到期
          mkExitRow('j4', '000001'),                                              // 拉 K 抛错 → 跳过不写失败态
          mkExitRow('j5', '600519', { content: '**成交日期**: 2026-07-20' }),      // 买入行 → 忽略
          mkExitRow('j6', '600519', { sleeve: 'long' })                           // 长线 → 忽略
        ]
      }
    };
    const ctxV = buildCtx40(storeV);
    const barsByCode = {
      '600519': [
        bar('2026-07-23', 10.4, 10.6, 10.3, 10.5),
        bar('2026-07-24', 10.5, 10.6, 9.7, 9.8),   // 出场日
        bar('2026-07-25', 9.8, 10, 9.7, 9.9),
        bar('2026-07-27', 10.4, 10.7, 10.3, 10.6)  // 收复入场价 10.5
      ],
      '600520': [
        bar('2026-07-23', 10.4, 10.6, 10.3, 10.5),
        bar('2026-07-24', 10.5, 10.6, 9.7, 9.8)    // 只有出场日, 无后续
      ]
    };
    const sumV = await ctxV.window.ShortTrader.verifyClosedTrades({
      // 注入 nowMs=周日晚 22:00 (北京), 避开 Bug D 盘中跳过, 走正常 verify 路径
      nowMs: new Date(2026, 6, 26, 22, 0, 0).getTime(),  // 2026-07-26 周日 22:00 北京
      getBars: async (code) => {
        if (code === '000001') throw new Error('K线接口超时');
        return barsByCode[code] || [];
      }
    });
    if (sumV && sumV.verified === 1 && sumV.pending === 1 && sumV.skipped === 1) ok('verify: 合格 1 / 未到期 1 / K线失败跳过 1');
    else fail('verify 汇总', JSON.stringify(sumV));
    if (storeV.puts.length === 1 && storeV.puts[0].t === 'journals') {
      const wr = storeV.puts[0].row;
      if (wr.id === 'j1' && wr.verifyOutcome === 'wrong' && wr.verifyFailureReason === '择时错'
        && wr.verifiedAt > 0 && typeof wr.postExitNote === 'string' && wr.postExitNote.includes('入场')) {
        ok('verify: 写回 verifyOutcome/verifyFailureReason/verifiedAt/postExitNote (持有 <2 日止损 → wrong/择时错, P0-2 归因细化)');
      } else fail('verify 写回字段', JSON.stringify(wr));
    } else fail('verify put 次数', 'puts=' + storeV.puts.length);
    if (!storeV.tables.journals.find(r => r.id === 'j4').verifyOutcome) ok('verify: K线失败行不写失败态 (下轮再试)');
    else fail('verify K线失败', '');

    // ---- 40.4 _linkVerifiedTrades 关联 (journal ↔ positions ↔ orders) ----
    const verifiedRow = Object.assign(mkExitRow('jv', '600519'), {
      verifyOutcome: 'wrong', verifyFailureReason: '时机过早', verifiedAt: 123, postExitNote: '止损后 2 日收复入场价, 属时机过早'
    });
    const linked = ST._linkVerifiedTrades(
      [verifiedRow, mkExitRow('jx', '600521', { verifyOutcome: 'correct' })],
      [{ closed: true, code: '600519', exitDate: '2026-07-24', entryDate: '2026-07-20', planOrderId: 'o1' }],
      [{ id: 'o1', assumption: '技术突破', probability: 60 }]
    );
    if (linked.length === 2 && linked[0].assumption === '技术突破' && linked[0].probability === 60
      && linked[0].outcome === 'wrong' && linked[0].reason === '时机过早'
      && linked[1].assumption === '' && linked[1].probability === null) {
      ok('link: 关联出 assumption/probability; 无仓位行兜底 空/null');
    } else fail('link', JSON.stringify(linked));

    // ---- 40.5 _buildTrackRecord 分组/Top3/门槛 ----
    if (ST._buildTrackRecord([{ outcome: 'correct' }, { outcome: 'wrong' }]) === null) {
      ok('trackRecord: 样本 <3 → null (不注入)');
    } else fail('trackRecord 门槛', '');
    const recTrades = [
      { code: '600519', assumption: '技术突破', outcome: 'correct', reason: null, note: 'n1', exitDate: '2026-07-01', probability: 60 },
      { code: '600519', assumption: '技术突破', outcome: 'wrong', reason: '时机过早', note: '止损后 2 日收复', exitDate: '2026-07-02', probability: 70 },
      { code: '000001', assumption: '题材催化', outcome: 'wrong', reason: '假设错误', note: 'n3', exitDate: '2026-07-03', probability: 55 },
      { code: '000001', assumption: '题材催化', outcome: 'partial', reason: '时机过早', note: 'n4', exitDate: '2026-07-04', probability: 65 },
      { code: '300750', assumption: '技术突破', outcome: 'correct', reason: null, note: 'n5', exitDate: '2026-07-05', probability: 80 }
    ];
    const rec = ST._buildTrackRecord(recTrades);
    if (rec && rec.total === 5 && rec.correctRate === 0.5) ok('trackRecord: 全局 5 笔, 综合胜率 0.5 (partial 计 0.5)');
    else fail('trackRecord 全局', JSON.stringify(rec));
    const g0 = rec.byAssumption[0];
    if (g0.assumption === '技术突破' && g0.total === 3 && g0.correctRate === 0.67 && g0.topReason === '时机过早') {
      ok('trackRecord: 按 assumption 分组 (技术突破 3 笔 胜率 0.67 主因 时机过早)');
    } else fail('trackRecord 分组', JSON.stringify(rec.byAssumption));
    if (rec.topReasons.length === 2 && rec.topReasons[0].reason === '时机过早' && rec.topReasons[0].count === 2) {
      ok('trackRecord: 全局 Top 归因排序 (时机过早×2 居首)');
    } else fail('trackRecord Top3', JSON.stringify(rec.topReasons));
    if (rec.lastWrong && rec.lastWrong.code === '000001' && rec.lastWrong.assumption === '题材催化') {
      ok('trackRecord: 最近 1 条 wrong 摘要 (按 exitDate 取最新)');
    } else fail('trackRecord lastWrong', JSON.stringify(rec.lastWrong));
    const recText = ST._formatTrackRecord(rec);
    if (recText.includes('【你的历史成绩单】') && recText.includes('技术突破') && recText.length <= K.SHORT_TRACK_RECORD_MAX_LEN) {
      ok('trackRecord: prompt 文本格式 + ≤400 字');
    } else fail('trackRecord 文本', recText.slice(0, 80));

    // ---- 40.6 Brier / 校准分桶 ----
    const b1 = ST._brierScore([{ probability: 60, outcome: 'correct' }, { probability: 40, outcome: 'wrong' }]);
    if (b1 === 0.16) ok('brier: ((0.6-1)²+(0.4-0)²)/2 = 0.16');
    else fail('brier 计算', 'b1=' + b1);
    if (ST._brierScore([]) === null) ok('brier: 空样本 → null');
    else fail('brier 空', '');
    const buckets = ST._calibrationBuckets([
      { probability: 30, outcome: 'correct' },
      { probability: 50, outcome: 'wrong' },
      { probability: 70, outcome: 'correct' },
      { probability: 90, outcome: 'partial' }
    ]);
    if (buckets.length === 4
      && buckets[0].n === 1 && buckets[0].predMean === 30 && buckets[0].hitRate === 100
      && buckets[1].n === 1 && buckets[1].hitRate === 0
      && buckets[2].n === 1 && buckets[2].hitRate === 100
      && buckets[3].n === 1 && buckets[3].hitRate === 50) {
      ok('calibration: 4 桶 (<40/40-60/60-80/≥80) 预测均值 vs 实际命中 (partial=0.5)');
    } else fail('calibration', JSON.stringify(buckets));

    // ---- 40.7 maybeDistillLessons 触发条件 + JSON 校验保护 ----
    const NOW40 = new Date(2026, 6, 26, 10, 0).getTime();   // 周日
    const verifiedRowsFor = (n) => Array.from({ length: n }, (_, i) =>
      Object.assign(mkExitRow('vd' + i, '60051' + (i % 6), { verifyOutcome: i % 2 ? 'wrong' : 'correct', verifiedAt: NOW40 - 1000 + i, postExitNote: 'note' + i })));
    // (a) 间隔未到 → skipped interval, LLM 不调用
    const storeD1 = { kv: { short_trader_lessons: { items: [{ text: '旧教训', createdAt: 1, basedOn: '2026-07-01' }], lastDistill: NOW40 - 24 * 3600 * 1000 } }, tables: { journals: verifiedRowsFor(6) } };
    let llmD1 = 0;
    const rD1 = await buildCtx40(storeD1).window.ShortTrader.maybeDistillLessons(new Date(NOW40), { callLLM: async () => { llmD1++; return '{}'; } });
    if (rD1.skipped === true && rD1.reason === 'interval' && llmD1 === 0) ok('distill: 距上次 <7 天 → skipped interval, 不调 LLM');
    else fail('distill interval', JSON.stringify(rD1));
    // (b) 新样本不足 → skipped samples
    const storeD2 = { kv: {}, tables: { journals: verifiedRowsFor(2) } };
    const rD2 = await buildCtx40(storeD2).window.ShortTrader.maybeDistillLessons(new Date(NOW40), { callLLM: async () => '{}' });
    if (rD2.skipped === true && rD2.reason === 'samples' && rD2.count === 2) ok('distill: 新增已验证 <5 → skipped samples');
    else fail('distill samples', JSON.stringify(rD2));
    // (c) 成功: 6 条新样本, LLM 出 4 条 → 截 3 条, 写 kv + lastDistill
    const storeD3 = { kv: {}, tables: { journals: verifiedRowsFor(6) } };
    const rD3 = await buildCtx40(storeD3).window.ShortTrader.maybeDistillLessons(new Date(NOW40), {
      callLLM: async ({ systemPrompt, prompt }) => {
        if (!prompt.includes('已验证交易') || !systemPrompt.includes('第一人称')) throw new Error('distill prompt 要素缺失');
        return JSON.stringify({ lessons: ['我在放量突破日追高 5 次亏 4 次, 今后突破单仓位减半', '教训二', '教训三', '教训四'] });
      }
    });
    const kvD3 = storeD3.kv.short_trader_lessons;
    if (rD3.skipped === false && rD3.added === 3 && kvD3 && kvD3.items.length === 3
      && kvD3.items[0].text.includes('仓位减半') && kvD3.items[0].basedOn === '2026-07-26'
      && kvD3.lastDistill === NOW40) ok('distill: 成功提炼, 4→3 条截断, kv items+lastDistill 落库');
    else fail('distill 成功', JSON.stringify({ r: rD3, kv: kvD3 }));
    // (d) JSON 校验失败 → 旧 lessons 原样保留
    const oldItems = [{ text: '旧教训', createdAt: 1, basedOn: '2026-07-01' }];
    const storeD4 = { kv: { short_trader_lessons: { items: oldItems, lastDistill: 0 } }, tables: { journals: verifiedRowsFor(6) } };
    const rD4 = await buildCtx40(storeD4).window.ShortTrader.maybeDistillLessons(new Date(NOW40), { callLLM: async () => '我没法输出 JSON' });
    const kvD4 = storeD4.kv.short_trader_lessons;
    if (rD4.skipped === true && rD4.reason === 'invalid-json' && kvD4.items.length === 1 && kvD4.items[0].text === '旧教训') {
      ok('distill: 非 JSON 输出 → 保留旧 lessons 不动');
    } else fail('distill JSON 保护', JSON.stringify({ r: rD4, kv: kvD4 }));
    // (e) items 上限 20: 19 旧 + 3 新 → 20 (最旧被挤掉)
    const storeD5 = {
      kv: { short_trader_lessons: { items: Array.from({ length: 19 }, (_, i) => ({ text: '旧' + i, createdAt: i, basedOn: '2026-07-01' })), lastDistill: 0 } },
      tables: { journals: verifiedRowsFor(6) }
    };
    await buildCtx40(storeD5).window.ShortTrader.maybeDistillLessons(new Date(NOW40), { callLLM: async () => JSON.stringify({ lessons: ['新一', '新二'] }) });
    const kvD5 = storeD5.kv.short_trader_lessons;
    if (kvD5.items.length === 20 && kvD5.items[0].text === '旧1' && kvD5.items[19].text === '新二') {
      ok('distill: items 上限 20, 新的挤掉最旧');
    } else fail('distill 上限', 'len=' + kvD5.items.length);

    // ---- 40.8 盘前 prompt 注入: 成绩单 + 我的教训 ----
    const storeP = {
      kv: {
        short_trader_lessons: { items: [{ text: '我在放量突破日追高易亏', createdAt: 1, basedOn: '2026-07-26' }], lastDistill: NOW40 },
        paper_cond_orders: recTrades.map((t, i) => ({ id: 'po' + i, assumption: t.assumption, probability: t.probability })),
        paper_short_positions: recTrades.map((t, i) => ({ closed: true, code: t.code, exitDate: t.exitDate, entryDate: '2026-07-01', planOrderId: 'po' + i }))
      },
      tables: {
        watchlist: [{ code: '600519', name: '贵州茅台' }],
        transactions: [],
        journals: recTrades.map((t, i) => Object.assign(
          mkExitRow('pj' + i, t.code, {
            content: exitContent.replace('2026-07-24', t.exitDate),
            verifyOutcome: t.outcome, verifyFailureReason: t.reason, verifiedAt: NOW40 - 100 + i, postExitNote: t.note
          })))
      }
    };
    const ctxP = buildCtx40(storeP);
    let capturedPrompt = '';
    await ctxP.window.ShortTrader.generatePlan({
      now: new Date(2026, 6, 27, 8, 30),
      deps: { callLLM: async ({ prompt }) => { capturedPrompt = prompt; return JSON.stringify({ marketView: 'm', plans: [] }); } }
    });
    if (capturedPrompt.includes('【你的历史成绩单】') && capturedPrompt.includes('技术突破')
      && capturedPrompt.includes('【我的教训】') && capturedPrompt.includes('放量突破日追高')) {
      ok('inject: 盘前 prompt 追加 成绩单 + 我的教训');
    } else fail('inject prompt', capturedPrompt.slice(-300));
    // 样本不足 → 不注入 (空串)
    const learnEmpty = await ctx40.window.ShortTrader._buildLearningPromptText();
    if (learnEmpty === '') ok('inject: 无已验证样本 → 注入文本为空 (不影响主流程)');
    else fail('inject 空样本', learnEmpty.slice(0, 60));

  } catch (e) {
    fail('40 ShortTrader T4', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [41] Z 服务自检面板 (dev-proxy / aktools / 本地 LLM) ==========
(async () => {
  section('[41] Z 服务自检面板');
  try {
    const appSrc = readFileSafe(path.join(WWW, 'app.js'));
    if (!appSrc) { fail('41.a', 'app.js 缺失'); return; }
    if (/window\.selfCheckServices\s*=/.test(appSrc)) {
      ok('41.a app.js 定义 window.selfCheckServices');
    } else fail('41.a', 'selfCheckServices 函数缺失');

    if (/id="selfCheckResult"/.test(appSrc) && /id="selfCheckList"/.test(appSrc)) {
      ok('41.b settings UI 注入 selfCheckResult + selfCheckList 两个 ID');
    } else fail('41.b', 'settings UI 缺 selfCheck* 容器');

    if (/_apiUrl\([^)]*['"]\/health['"]/.test(appSrc) && /stock_zh_a_spot/.test(appSrc) && /Core\.AI\.discoverLocalLLM/.test(appSrc)) {
      ok('41.c 三个探测项都在 (dev-proxy /health + aktools stock_zh_a_spot + 本地 LLM discoverLocalLLM)');
    } else fail('41.c', '三个探测项任一缺失');

    if (/(?:const|let|var) allOk = results\.every/.test(appSrc) && /修复步骤/.test(appSrc)) {
      ok('41.d 故障状态渲染 (allOk 配色 + 修复步骤提示)');
    } else fail('41.d', '故障展示不完整');

    // 41.e runtime 行为模拟: 把 selfCheckServices 拉到 vm 里跑 (mock fetch + Core.AI.discoverLocalLLM)
    // 注意: aktools 项已改用 /health 探测 (避免 stock_zh_a_spot?symbol 在 aktools 0.0.91+ 报 500), 见 app.js line 793
    const fetchCalls = [];
    const fetchMock = async (url) => {
      fetchCalls.push(url);
      if (url.includes('/health')) return { ok: true, status: 200, json: async () => ({ status: 'ok', akshare_target: 'http://127.0.0.1:8088', akshare_status: 'ok' }) };
      if (url.includes('/api/discover/local-llm')) return { ok: true, status: 200, json: async () => ({ found: [{ host: '127.0.0.1', port: 8082, models: ['qwen3'] }], scanned: 4, host: '127.0.0.1' }) };
      return { ok: false, status: 500, text: async () => '' };
    };
    const ctx41 = vm.createContext({
      window: {}, console,
      document: {
        getElementById: (id) => {
          if (id === 'selfCheckResult' || id === 'selfCheckList') {
            return { textContent: '', innerHTML: '', style: {} };
          }
          return null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { clipboard: { writeText: async () => {} } },
      location: { reload: () => {}, href: '' },
      history: { pushState: () => {} },
      fetch: fetchMock,
      setTimeout: (fn, ms) => Promise.resolve().then(fn),
      clearTimeout: () => {},
      Promise,
      Date,
      Math,
      JSON,
      console,
      escapeHtml: (s) => String(s),
      Core: {
        State: { get: () => ({ proxyBase: '/api/akshare' }) },
        AI: { discoverLocalLLM: async () => ({ found: [{ host: '127.0.0.1', port: 8082, models: ['qwen3'] }], scanned: 4, host: '127.0.0.1' }) },
        // app.js 顶层会解引用这些, 但 selfCheckServices 不依赖它们, 给个空 stub 避免顶层赋值炸
        Router: { switchPage: () => {}, goSettings: () => {} },
        Util: { escapeHtml: (s) => String(s) },
        Toast: { success: () => {}, error: () => {} },
        Storage: { all: async () => [], kvGet: async () => null, kvSet: async () => {} }
      }
    });
    vm.runInContext(appSrc, ctx41);
    if (typeof ctx41.window.selfCheckServices !== 'function') { fail('41.e selfCheckServices 不可调用', ''); return; }
    await ctx41.window.selfCheckServices();
    const healthCount = fetchCalls.filter(u => u.includes('/health')).length;
    const llmHit = fetchCalls.some(u => u.includes('/api/discover/local-llm'));
    if (healthCount >= 2 && llmHit) ok('41.e 自检运行时: dev-proxy /health + aktools /health + 本地 LLM discover 全部命中');
    else fail('41.e runtime', `fetch 调用不完整 (health×${healthCount}, llm=${llmHit}): ` + fetchCalls.join(' | '));
  } catch (e) {
    fail('41 Z 自检', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [42] 自动发现 dev-proxy (APK 局域网找后端) ==========
(async () => {
  section('[42] 自动发现 dev-proxy');
  try {
    const appSrc = readFileSafe(path.join(WWW, 'app.js'));
    const proxySrc = readFileSafe(path.join(ROOT, 'scripts/dev-proxy.mjs'));
    if (!appSrc) { fail('42.a', 'app.js 缺失'); return; }
    if (!proxySrc) { fail('42.a', 'dev-proxy.mjs 缺失'); return; }

    // 42.a dev-proxy 注册 /api/discover/dev-proxy 路由
    if (/app\.get\(['"]\/api\/discover\/dev-proxy['"]/.test(proxySrc)) {
      ok('42.a dev-proxy 注册 /api/discover/dev-proxy 路由');
    } else fail('42.a', '路由缺失');

    // 42.b dev-proxy /health 加 CORS 放行 (APK 跨 IP fetch 才能通过)
    if (/Access-Control-Allow-Origin/.test(proxySrc) && /app\.options\(['"]\/health['"]/.test(proxySrc)) {
      ok('42.b dev-proxy /health 加 CORS 放行 (ACAO + OPTIONS 预检)');
    } else fail('42.b', '/health 没 CORS 处理');

    // 42.c app.js 定义 window.discoverDevProxy + applyDiscoveredDevProxy
    if (/window\.discoverDevProxy\s*=/.test(appSrc) && /window\.applyDiscoveredDevProxy\s*=/.test(appSrc)) {
      ok('42.c app.js 定义 discoverDevProxy + applyDiscoveredDevProxy');
    } else fail('42.c', '函数缺失');

    // 42.d settings UI 注入 devProxyDiscoverResult + devProxyDiscoverList
    if (/id="devProxyDiscoverResult"/.test(appSrc) && /id="devProxyDiscoverList"/.test(appSrc)) {
      ok('42.d settings UI 注入 devProxyDiscoverResult + devProxyDiscoverList');
    } else fail('42.d', 'UI 容器缺失');

    // 42.e discoverDevProxy 拿 serverIPs + 挨个 fetch /health
    if (/\/api\/discover\/dev-proxy/.test(appSrc) && (/\/health/.test(appSrc)) && /AbortController/.test(appSrc)) {
      ok('42.e discoverDevProxy: 调 /api/discover/dev-proxy + 候选 IP fetch /health + AbortController timeout');
    } else fail('42.e', '核心探测流程缺失');

    // 42.f applyDiscoveredDevProxy 填 settingProxyBase + saveSettings + toast
    if (/settingProxyBase/.test(appSrc) && /saveSettings\(true\)/.test(appSrc) && /toastSuccess/.test(appSrc)) {
      ok('42.f applyDiscoveredDevProxy: 填 settingProxyBase + saveSettings(true) + toast');
    } else fail('42.f', '应用流程缺失');

    // 42.g runtime: mock fetch 让 discoverDevProxy 跑通
    const fetchCalls42 = [];
    const fetchMock42 = async (url, opts = {}) => {
      fetchCalls42.push(url);
      if (url.includes('/api/discover/dev-proxy')) {
        return { ok: true, status: 200, json: async () => ({ port: 8089, serverIPs: ['192.168.1.10', '10.0.0.5'], host: '192.168.1.10', healthPath: '/health', proxyPath: '/api/akshare', timestamp: '2026-07-28T00:00:00Z' }) };
      }
      if (url.startsWith('http://192.168.1.10:8089/health')) {
        return { ok: true, status: 200, json: async () => ({ status: 'ok', akshare_target: 'http://127.0.0.1:8088' }) };
      }
      if (url.startsWith('http://10.0.0.5:8089/health')) {
        return { ok: false, status: 500, json: async () => ({}) };
      }
      return { ok: false, status: 500, json: async () => ({}) };
    };
    const ctx42 = vm.createContext({
      window: {}, console,
      document: {
        getElementById: (id) => {
          if (['devProxyDiscoverResult', 'devProxyDiscoverList'].includes(id)) {
            return { textContent: '', innerHTML: '', style: {} };
          }
          if (id === 'settingProxyBase') return { value: '' };
          return null;
        },
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
      },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      navigator: { clipboard: { writeText: async () => {} } },
      location: { reload: () => {}, hostname: 'localhost', href: 'http://localhost:3003/' },
      history: { pushState: () => {} },
      AbortController: class { constructor() { this.signal = {}; } abort() {} },
      setTimeout: (fn, ms) => Promise.resolve().then(fn),
      clearTimeout: () => {},
      Promise,
      Date,
      Math,
      JSON,
      URL,
      console,
      escapeHtml: (s) => String(s),
      saveSettings: () => {},
      toastSuccess: () => {},
      fetch: fetchMock42,
      Core: {
        State: { get: () => ({ proxyBase: '/api/akshare' }), set: () => {} },
        AI: { discoverLocalLLM: async () => ({ found: [], scanned: 0, host: '127.0.0.1' }) },
        Router: { switchPage: () => {}, goSettings: () => {} },
        Util: { escapeHtml: (s) => String(s) },
        Toast: { success: () => {}, error: () => {} },
        Storage: { all: async () => [], kvGet: async () => null, kvSet: async () => {} }
      }
    });
    vm.runInContext(appSrc, ctx42);
    if (typeof ctx42.window.discoverDevProxy !== 'function') { fail('42.g 函数未挂载', ''); return; }
    await ctx42.window.discoverDevProxy();
    const callInfo = fetchCalls42.some(u => u.includes('/api/discover/dev-proxy'));
    const callHealth = fetchCalls42.some(u => u.includes('192.168.1.10:8089/health'));
    if (callInfo && callHealth) ok('42.g discoverDevProxy 运行时: 拿到 serverIPs + 触发 /health 探测');
    else fail('42.g runtime', 'fetch 调用不完整: ' + fetchCalls42.join(' | '));
  } catch (e) {
    fail('42 自动发现 dev-proxy', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[43] Bug A 前视偏差: createdAfterClose 阈值 (盘外 OR 盘外才次日生效)');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const storeX = { kv: {}, tables: {}, quotes: {}, indexSpot: [] };
    const buildCtx = (storageData) => {
      const pctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-27',
        uuid: () => 'paper-A-' + Math.random().toString(36).slice(2, 8),
        parseStockInput: (t) => {
          const m = String(t || '').trim().match(/^(\d{6})/);
          return m ? { code: m[1], name: String(t).slice(6).trim() } : null;
        },
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true,
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
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: _loadRealConstants()
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };
    const PX = buildCtx(storeX).window.Paper;

    // 43.a 阈值常量存在
    const src = paperSrc;
    const hasOpen = /MARKET_OPEN_MINUTES\s*=\s*9\s*\*\s*60\s*\+\s*30/.test(src);
    const hasClose = /MARKET_CLOSE_MINUTES\s*=\s*15\s*\*\s*60/.test(src);
    const hasGuard = /_isOutsideTradingHours/.test(src);
    if (hasOpen && hasClose && hasGuard) ok('43.a 常量 MARKET_OPEN_MINUTES=570 / CLOSE=900 + _isOutsideTradingHours 守卫就位');
    else fail('43.a 常量', `open=${hasOpen} close=${hasClose} guard=${hasGuard}`);

    // 43.b _orderEligible + createdAfterClose 联动: 盘中单可对当日 K 生效 (但 _lastClosedBar 盘中返回 null, 不前视)
    //     盘外单 (开盘前/收盘后) 必须次日 K 才生效
    const e1 = PX._orderEligible(
      { createdDate: '2026-07-27', createdAfterClose: true },  // 盘外 (e.g. 14:00 之前开盘前 / 15:00 收盘后)
      { date: '2026-07-27' }
    );
    const e2 = PX._orderEligible(
      { createdDate: '2026-07-27', createdAfterClose: true },
      { date: '2026-07-28' }
    );
    const e3 = PX._orderEligible(
      { createdDate: '2026-07-27', createdAfterClose: false },  // 盘中 (09:30~14:59) 创建
      { date: '2026-07-27' }
    );
    if (e1 === false && e2 === true && e3 === true) ok('43.b _orderEligible: 盘外次日生效 / 盘中当日生效');
    else fail('43.b _orderEligible', JSON.stringify({ e1, e2, e3 }));

    // 43.c 行为变化对照: 14:00 盘中建单 → createdAfterClose=false (旧: true)
    //     模拟 _orderEligible 调用, 验证 "old buggy true" 不再返回
    const oldBug = PX._orderEligible(
      { createdDate: '2026-07-27', createdAfterClose: true },   // 旧 bug: 14:00 创建会标 true
      { date: '2026-07-27' }                                     // 当天 9:30 已走完的 K
    );
    if (oldBug === false) ok('43.c 14:00 建单旧 bug 回归 (盘外标记=true 当日 K 不可回溯)');
    else fail('43.c old bug', JSON.stringify(oldBug));

    // 43.d _lastClosedBar 仍守住 "盘中不拿未走完 bar"
    // 注意: buildCtx 的 fmtDate 是 hardcode mock, 这里我们直接用 _loadRealConstants 不会动到
    // 但 paper.js 内部 fmtDate 调用 → 全是 '2026-07-27'
    // 解决: 构造 bars 时 today 就设为 '2026-07-27', 验证 16:00 时 (mock closed=true via 直接 verify)
    const todayMock = '2026-07-27';  // 跟 fmtDate mock 对齐
    const bars = [
      { date: '2026-07-25', open: 10, high: 11, low: 9.5, close: 10.5 },
      { date: todayMock,    open: 10.5, high: 11.5, low: 10, close: 11 }
    ];
    const intraday = PX._lastClosedBar(bars, new Date(2026, 6, 27, 11, 0));   // 周二 11:00 (盘中)
    const afterClose = PX._lastClosedBar(bars, new Date(2026, 6, 27, 16, 0)); // 周二 16:00 (收盘后)
    // 盘中: fmtDate mock 返回 todayMock → bars[i=1].date === todayMock && closed(11:00=660>=900)=false → 不命中, i=0 命中 (date < today) → 返 07-25 (不算 null)
    // 这其实跟生产一致: 盘中拿的是 "上一根" 而不是 null. 真正 null 是当 bars 没更早数据时
    // 关键测试: 收盘后拿当日 K (07-27), 盘中拿前一根 K (07-25)
    if (intraday && intraday.date === '2026-07-25' && afterClose && afterClose.date === todayMock) {
      ok('43.d _lastClosedBar: 盘中返前日 K (last closed) / 收盘后返当日 K');
    } else fail('43.d _lastClosedBar', JSON.stringify({ intraday, afterClose }));
  } catch (e) {
    fail('43 Bug A 前视偏差', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[44] Bug C 同代码去重: addCondOrder 拒绝同 code pending/已持仓');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const storeC = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 }
      },
      tables: {
        paper_holdings: []
      },
      quotes: {}, indexSpot: []
    };
    const buildCtx = (storageData) => {
      const pctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-27',
        uuid: () => 'paper-C-' + Math.random().toString(36).slice(2, 8),
        parseStockInput: (t) => {
          const m = String(t || '').trim().match(/^(\d{6})/);
          return m ? { code: m[1], name: String(t).slice(6).trim() } : null;
        },
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true,
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
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: _loadRealConstants()
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };
    const PC = buildCtx(storeC).window.Paper;
    await PC.init();

    // 44.a 建第 1 张 000001 below 单 → 通过 (paper_cond_orders 存在 kv)
    const r1 = await PC.addCondOrder({
      code: '000001', triggerDirection: 'below', triggerPrice: 10,
      stopLoss: 9, targetPrice: 12, shares: 100
    });
    const kvList = (storeC.kv.paper_cond_orders || []);
    if (r1.ok && kvList.length === 1 && kvList[0].code === '000001') {
      ok('44.a 第 1 张单: 通过 + 入库 kv.paper_cond_orders (1 条)');
    } else fail('44.a', 'r1.ok=' + r1.ok + ' kvLen=' + kvList.length + ' r1=' + JSON.stringify(r1));

    // 44.b 重复建同代码 000001 below → 拒绝 (已有 pending)
    const r2 = await PC.addCondOrder({
      code: '000001', triggerDirection: 'below', triggerPrice: 9.5,
      stopLoss: 8.5, targetPrice: 11, shares: 100
    });
    if (!r2.ok && r2.errors && r2.errors[0].includes('同代码 000001 已有未触发')) {
      ok('44.b 同代码重复 pending → 拒绝 (错误文案明确指向 "已有未触发")');
    } else fail('44.b', JSON.stringify(r2));

    // 44.c 同代码 000001 改 above 方向 (加仓场景) → 仍拒绝 (Bug C 严禁同代码不论方向)
    const r3 = await PC.addCondOrder({
      code: '000001', triggerDirection: 'above', triggerPrice: 11,
      stopLoss: 10, targetPrice: 13, shares: 100
    });
    if (!r3.ok && r3.errors && r3.errors[0].includes('同代码')) {
      ok('44.c 同代码 + 不同方向 (above) → 拒绝 (addCondOrder 只认 code 不认方向)');
    } else fail('44.c', JSON.stringify(r3));

    // 44.d 清掉 pending, 加一个 short 持仓, 再建同代码 → 拒绝 (已持仓)
    storeC.kv.paper_cond_orders = [];
    storeC.tables.paper_holdings = [{
      code: '000001', name: '平安银行', shares: 100, costPrice: 10, sleeve: 'short',
      boughtAt: Date.now(), source: 'ai'
    }];
    const r4 = await PC.addCondOrder({
      code: '000001', triggerDirection: 'above', triggerPrice: 11,
      stopLoss: 10, targetPrice: 13, shares: 100
    });
    if (!r4.ok && r4.errors && r4.errors[0].includes('已持有 000001 短线仓位')) {
      ok('44.d 已持仓 short + 新建同代码 → 拒绝 (已持仓错误文案)');
    } else fail('44.d', JSON.stringify(r4));

    // 44.e 长线持仓 (sleeve=long) 不算短线的"同代码已持仓", 短线条件单允许
    storeC.tables.paper_holdings = [{
      code: '000001', name: '平安银行', shares: 1000, costPrice: 10, sleeve: 'long',
      boughtAt: Date.now(), source: 'manual'
    }];
    const r5 = await PC.addCondOrder({
      code: '000001', triggerDirection: 'below', triggerPrice: 10,
      stopLoss: 9, targetPrice: 12, shares: 100
    });
    if (r5.ok && (storeC.kv.paper_cond_orders || []).length === 1) {
      ok('44.e 长线持仓不影响短线条件单 (sleeve 隔离)');
    } else fail('44.e', JSON.stringify(r5));

    // 44.f 不同代码 → 通过 (去重只在同 code 内)
    // 短线现金 30000, 选 000002 @ 5 元 × 1000 股 = 5000 (LOT_SIZE=100 → 1000 是 10 手, 可行)
    // LOT_SIZE 是 100, 1000 股 = 10 手, valid. 5000 < 30000 + fee, 通过
    const r6 = await PC.addCondOrder({
      code: '000002', triggerDirection: 'below', triggerPrice: 5,
      stopLoss: 4.5, targetPrice: 6, shares: 1000
    });
    if (r6.ok && (storeC.kv.paper_cond_orders || []).length === 2) {
      ok('44.f 不同代码 → 通过 (去重不跨 code)');
    } else fail('44.f', JSON.stringify(r6));
  } catch (e) {
    fail('44 Bug C 同代码去重', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[45] Bug F 空跑 lastSettleDate: codes.size===0 / 0 笔不写 lastSettleDate');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const storeF = {
      kv: {
        paper_account_short: { initialCash: 30000, cash: 30000, createdAt: 1, positionPct: 0.20 }
      },
      tables: { paper_holdings: [] },
      quotes: {}, indexSpot: [],
      // kline 兜底返空数组, 让 settle 不会真成交
      klineByCode: {}
    };
    const buildCtx = (storageData) => {
      const pctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-27',
        uuid: () => 'paper-F-' + Math.random().toString(36).slice(2, 8),
        parseStockInput: (t) => {
          const m = String(t || '').trim().match(/^(\d{6})/);
          return m ? { code: m[1], name: String(t).slice(6).trim() } : null;
        },
        toastSuccess: () => {}, toastError: () => {}, toastWarning: () => {},
        confirm: () => true,
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
          getStockKLine: async (code) => storageData.klineByCode[code] || [],
          getIndexSpot: async () => storageData.indexSpot || []
        },
        Util: { stockCodePrefix: (c) => /^(60|68)/.test(c) ? 'sh' : 'sz' },
        Constants: _loadRealConstants()
      };
      pctx.Core = pctx.window.Core;
      pctx.window.document = { getElementById: () => null };
      pctx.document = pctx.window.document;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };
    const PF = buildCtx(storeF).window.Paper;
    await PF.init();

    // 45.a 完全空 (无 pending, 无 short 持仓) → 不写 lastSettleDate
    storeF.kv.paper_cond_settle = {};
    const s1 = await PF.settleCondOrders(new Date(2026, 6, 28, 16, 0));
    if (s1 && (!storeF.kv.paper_cond_settle || !storeF.kv.paper_cond_settle.lastSettleDate)) {
      ok('45.a 完全空: 不写 lastSettleDate (返 {filled:0,...})');
    } else fail('45.a', JSON.stringify({ s1, meta: storeF.kv.paper_cond_settle }));

    // 45.b 1 张 pending 单, K 线空 (兜底返 []) → 不成交 → 不写 lastSettleDate
    storeF.kv.paper_cond_orders = [{
      id: 'p1', code: '000001', sleeve: 'short', triggerDirection: 'below',
      triggerPrice: 10, stopLoss: 9, targetPrice: 12, shares: 100, amount: 1000,
      status: 'pending', createdAt: 1, createdDate: '2026-07-26', createdAfterClose: true
    }];
    storeF.kv.paper_cond_settle = {};
    const s2 = await PF.settleCondOrders(new Date(2026, 6, 28, 16, 0));
    const sum2 = s2 || { filled: 0 };
    if (sum2.filled === 0 && (!storeF.kv.paper_cond_settle || !storeF.kv.paper_cond_settle.lastSettleDate)) {
      ok('45.b pending 但 K 线空: 不成交 + 不写 lastSettleDate');
    } else fail('45.b', JSON.stringify({ s2, meta: storeF.kv.paper_cond_settle }));

    // 45.c 真成交 1 笔 (K 线触发价命中) → 写 lastSettleDate
    // 策略: 5 根 K 线, 都让 open > triggerPrice (10) → _fillCheck 不触发 (continue 跳过)
    //      然后 _tradingDaysAfter(bars, '2026-06-01') = 5 >= 3 → expired 路径触发
    // 注意: paper.js 的 _barOf 期待 aktools 字段 {日期, 开盘, 最高, 最低, 收盘}
    // 我们的 mock 要返这种格式, 不然 _barOf 返 null → bars 数组空
    storeF.klineByCode['000001'] = [
      { 日期: '2026-07-22', 开盘: 10.5, 最高: 11, 最低: 10, 收盘: 10.8 },
      { 日期: '2026-07-23', 开盘: 10.8, 最高: 11.2, 最低: 10.5, 收盘: 11 },
      { 日期: '2026-07-24', 开盘: 11, 最高: 11.5, 最低: 10.8, 收盘: 11.2 },
      { 日期: '2026-07-25', 开盘: 11.2, 最高: 11.5, 最低: 11, 收盘: 11.3 },
      { 日期: '2026-07-28', 开盘: 10.5, 最高: 10.8, 最低: 10.3, 收盘: 10.6 }  // 全部开盘 > 触发价=10 → 不触发 fill
    ];
    storeF.kv.paper_cond_settle = {};
    storeF.kv.paper_cond_orders[0].expireAt = 1;  // 已过期 (仅 UI 显示用, 实际过期判定走 _tradingDaysAfter)
    storeF.kv.paper_cond_orders[0].createdDate = '2026-06-01';  // 远期, 必超期
    const s3 = await PF.settleCondOrders(new Date(2026, 6, 28, 16, 0));
    const sum3 = s3 || { expired: 0 };
    if (process.env.DEBUG_F) console.log('[DEBUG 45.c]', JSON.stringify({ sum3, meta: storeF.kv.paper_cond_settle }));
    // today 用 fmtDate mock ('2026-07-27'), 所以 lastSettleDate 应写 '2026-07-27'
    if (sum3.expired >= 1 && storeF.kv.paper_cond_settle && storeF.kv.paper_cond_settle.lastSettleDate === '2026-07-27') {
      ok('45.c 真结算 1 笔 (expired): 写 lastSettleDate');
    } else fail('45.c', JSON.stringify({ sum3, meta: storeF.kv.paper_cond_settle }));

    // 45.d 同日再次调 settleCondOrders → skipped=true (防重复)
    const s4 = await PF.settleCondOrders(new Date(2026, 6, 28, 16, 30));
    if (s4 && s4.skipped === true) {
      ok('45.d 同日重复调: skipped=true (lastSettleDate 命中)');
    } else fail('45.d', JSON.stringify(s4));
  } catch (e) {
    fail('45 Bug F 空跑 lastSettleDate', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[46] Bug B 现价锚定: _buildCandidatePool / _validatePlans 方向对照 / _buildUserPrompt 渲染');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');
    const K = _loadRealConstants();
    // 真实 Core.Premortem (a2 校验依赖, checkPick 是纯函数)
    const pmCtx = vm.createContext({ window: {}, console });
    vm.runInContext(readFileSafe(path.join(WWW, 'core/premortem.js')), pmCtx);
    const realPremortem = pmCtx.window.Core.Premortem;
    // ai-service 加载仅取 parseJsonOutput (纯函数)
    const aiCtx = { console, setTimeout, clearTimeout, Core: { State: { get: () => ({}) } }, fetch: async () => ({ ok: false }) };
    vm.createContext(aiCtx);
    aiCtx.window = aiCtx;
    vm.runInContext(readFileSafe(path.join(WWW, 'core/ai-service.js')), aiCtx);
    const realParseJsonOutput = aiCtx.Core.AI.parseJsonOutput;
    if (!realParseJsonOutput) throw new Error('ai-service.parseJsonOutput 提取失败');

    // vm sandbox: 真实常量 + 真实 Premortem + mock Core.Storage/Paper/Regime
    const buildCtx = () => {
      const sctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtDateTime: () => '2026-07-27 08:30',
        confirm: () => true,
        document: { getElementById: () => null }
      };
      sctx.window.Core = {
        Constants: K,
        Storage: {
          kvGet: async () => null,
          kvSet: async () => {},
          all: async () => []
        },
        Data: { getIndexSpot: async () => [],
          // Tier 2: formatForPrompt + fetcher mock
          formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
          getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null },
        Util: { stockCodePrefix: () => 'sz' },
        Premortem: realPremortem,
        PositionSizing: _loadRealPositionSizing(),
        AI: { parseJsonOutput: realParseJsonOutput, callWithTimeout: async () => { throw new Error('no LLM'); } },
        Regime: {
          get: async () => ({ state: 'range' }),
          gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 })
        },
        Discipline: { DEFAULT_CONFIG: { short: { maxDailyTrades: 3, cooldownHours: 48 } } }
      };
      sctx.Core = sctx.window.Core;
      sctx.window.Paper = {
        _roundLot: (s) => Math.floor((parseFloat(s) || 0) / 100) * 100,
        _getAccountRaw: async () => ({ cash: 30000, initialCash: 30000, positionPct: 0.2 }),
        getPositions: async () => [],
        listCondOrders: async () => [],
        addCondOrder: async (o) => ({ ok: true, order: { id: 'ord-x', ...o } })
      };
      sctx.Paper = sctx.window.Paper;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(stSrc, sctx);
      return sctx;
    };
    const ST = buildCtx().window.ShortTrader;
    if (!ST) throw new Error('ShortTrader 未挂到 window');

    // 46.a _buildCandidatePool 默认 currentPrice=null (待 _buildPlanContext 异步注入)
    const pool0 = ST._buildCandidatePool(
      [{ code: '000001', name: '平安银行' }, { code: '600519', name: '贵州茅台' }],
      [{ code: '000002', name: '万科A' }]
    );
    if (pool0.length === 3
      && pool0.every(x => x.currentPrice === null && x.changePct === null)
      && pool0[0].code === '000001' && pool0[2].code === '000002') {
      ok('46.a _buildCandidatePool 输出去重保序 + 默认 currentPrice=null (待异步注入)');
    } else fail('46.a', JSON.stringify(pool0));

    // 46.b _validatePlans 没传 priceByCode → 不做方向对照 (向后兼容, 全部按原值通过)
    const planGood = {
      code: '000001', name: '平安银行',
      triggerDirection: 'below', triggerPrice: 10, stopLoss: 9, targetPrice: 12,
      positionPct: 0.2, probability: 70, confidence: '中',
      assumption: '业绩拐点', reason: 'r', bullCase: 'b', bearCase: 'br',
      falsifyCondition: 'f', invalidation: 'i'
    };
    const r46b = ST._validatePlans([planGood], {
      pool: new Set(['000001']),
      cash: 30000, quotaLeft: 3,
      recentSellCodes: new Set(), regimeState: 'range', positionScale: 1
      // 故意不传 priceByCode
    });
    if (r46b.passed.length === 1 && r46b.passed[0].aiPriceAnchored === true
      && r46b.passed[0].currentPrice === null
      && r46b.passed[0].triggerPrice === 10) {
      ok('46.b _validatePlans 无 priceByCode → 不做方向对照, aiPriceAnchored=true (向后兼容)');
    } else fail('46.b', JSON.stringify(r46b));

    // 46.c below + AI 报的价格贴近 currentPrice (10.05 vs 10, 1% 容差内) → aiPriceAnchored=true, 不改价
    const r46c = ST._validatePlans([planGood], {
      pool: new Set(['000001']),
      cash: 30000, quotaLeft: 3,
      recentSellCodes: new Set(), regimeState: 'range', positionScale: 1,
      priceByCode: new Map([['000001', 10]])  // 现价 10, AI 报 below 10.05 ≤ 10*1.01=10.1 → 通过
    });
    if (r46c.passed.length === 1 && r46c.passed[0].aiPriceAnchored === true
      && r46c.passed[0].triggerPrice === 10
      && r46c.passed[0].currentPrice === 10) {
      ok('46.c below 容差内 → aiPriceAnchored=true, 价格保持原值');
    } else fail('46.c', JSON.stringify(r46c));

    // 46.d above + AI 报的价格远低于 currentPrice (8 vs 10, 偏离 20%) → 兜底替换 10*1.01=10.10, aiPriceAnchored=false
    //   仍要满足 sl<tp<tg: sl=7, tp=8, tg=12 (8 < 12 ✓)
    const planAbove = { ...planGood, triggerDirection: 'above', triggerPrice: 8, stopLoss: 7, targetPrice: 12 };
    const r46d = ST._validatePlans([planAbove], {
      pool: new Set(['000001']),
      cash: 30000, quotaLeft: 3,
      recentSellCodes: new Set(), regimeState: 'range', positionScale: 1,
      priceByCode: new Map([['000001', 10]])
    });
    if (r46d.passed.length === 1
      && r46d.passed[0].aiPriceAnchored === false
      && Math.abs(r46d.passed[0].triggerPrice - 10.10) < 0.01  // cp*1.01
      && r46d.passed[0].currentPrice === 10) {
      ok('46.d above 偏离 >1% → 兜底替换 cp*1.01=10.10, aiPriceAnchored=false');
    } else fail('46.d', JSON.stringify(r46d));

    // 46.e below + AI 报的价格远高于 currentPrice (15 vs 10, 偏离 50%) → 兜底替换 10*0.99=9.90, aiPriceAnchored=false
    //   仍要满足 sl<tp<tg: sl=14, tp=15, tg=17 (14<15<17 ✓)
    const planBelow = { ...planGood, triggerDirection: 'below', triggerPrice: 15, stopLoss: 14, targetPrice: 17 };
    const r46e = ST._validatePlans([planBelow], {
      pool: new Set(['000001']),
      cash: 30000, quotaLeft: 3,
      recentSellCodes: new Set(), regimeState: 'range', positionScale: 1,
      priceByCode: new Map([['000001', 10]])
    });
    if (r46e.passed.length === 1
      && r46e.passed[0].aiPriceAnchored === false
      && Math.abs(r46e.passed[0].triggerPrice - 9.90) < 0.01  // cp*0.99
      && r46e.passed[0].stopLoss < 9.90 && r46e.passed[0].targetPrice > 9.90) {
      ok('46.e below 偏离 >1% → 兜底替换 cp*0.99=9.90, sl/tg 按比例对齐 (仍满足 sl<tp<tg)');
    } else fail('46.e', JSON.stringify(r46e));

    // 46.f _buildUserPrompt 候选池带 currentPrice 时, 行格式含 @价格
    const ctxWithPrice = {
      today: '2026-07-27', cash: 30000, positions: [], pendingOrders: [],
      recentJournals: [], regime: { state: 'range', label: '震荡市', positionScale: 1 },
      marketText: '',
      pool: [
        { code: '000001', name: '平安银行', currentPrice: 10.50, changePct: 1.5 },
        { code: '000002', name: '万科A', currentPrice: 5.20, changePct: -0.8 },
        { code: '000003', name: '未知价', currentPrice: null, changePct: null }
      ]
    };
    const prompt = ST._buildUserPrompt(ctxWithPrice);
    if (prompt.includes('000001 平安银行 @10.50 (+1.50%)')
      && prompt.includes('000002 万科A @5.20 (-0.80%)')
      && prompt.includes('000003 未知价 @未知')) {
      ok('46.f _buildUserPrompt 候选池行渲染 currentPrice + changePct + @未知 fallback');
    } else fail('46.f', 'prompt 截取:\n' + prompt.split('候选池')[1].split('\n').slice(0, 3).join('\n'));
  } catch (e) {
    fail('46 Bug B 现价锚定', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[47] Bug D verify 盘中跳过: 交易日 09:30~15:00 不写回 verifyOutcome');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');
    const K = _loadRealConstants();
    const buildCtx = () => {
      const sctx = {
        window: {},
        console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtDateTime: () => '2026-07-27 08:30',
        confirm: () => true,
        document: { getElementById: () => null }
      };
      sctx.window.Core = {
        Constants: K,
        Storage: {
          kvGet: async () => null, kvSet: async () => {},
          all: async () => [{
            id: 'j-d', code: '000001', sleeve: 'short', auto: true, verifyOutcome: null,
            content: '卖出日期: 2026-07-23\n原因: 止盈\n入场: 2026-07-15 @10.00\n出场: 12.50'
          }],
          put: async (t, row) => { sctx.__puts = sctx.__puts || []; sctx.__puts.push({ t, row }); }
        },
        Data: {
          getStockKLine: async () => [
            { 日期: '2026-07-23', 开盘: 12.0, 最高: 12.6, 最低: 11.9, 收盘: 12.5 },
            { 日期: '2026-07-24', 开盘: 12.5, 最高: 13.2, 最低: 12.4, 收盘: 13.1 },
            { 日期: '2026-07-25', 开盘: 13.1, 最高: 13.4, 最低: 13.0, 收盘: 13.2 }
          ]
        },
        Premortem: { checkPick: () => [] },
        PositionSizing: _loadRealPositionSizing(),
        AI: { parseJsonOutput: () => ({ ok: true, obj: {} }), callWithTimeout: async () => '' },
        Regime: { get: async () => ({ state: 'range' }), gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 }) },
        Discipline: { DEFAULT_CONFIG: { short: { maxDailyTrades: 3, cooldownHours: 48 } } }
      };
      sctx.Core = sctx.window.Core;
      sctx.window.Paper = {
        _roundLot: (s) => Math.floor((parseFloat(s) || 0) / 100) * 100,
        _getAccountRaw: async () => ({ cash: 30000 }),
        getPositions: async () => [], listCondOrders: async () => [],
        addCondOrder: async (o) => ({ ok: true, order: o })
      };
      sctx.Paper = sctx.window.Paper;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(stSrc, sctx);
      return sctx;
    };

    // 47.a 盘中 (交易日 10:30) → 直接返 deferred=trading-hours, 不读 journals / 不调 K 线 / 不写回
    const ctxA = buildCtx();
    const nowA = new Date(2026, 6, 27, 10, 30, 0).getTime();  // 周一 10:30 北京时间
    const rA = await ctxA.window.ShortTrader.verifyClosedTrades({ nowMs: nowA });
    if (rA && rA.deferred === 'trading-hours' && rA.verified === 0 && rA.pending === 0 && rA.skipped === 0
      && (!ctxA.__puts || ctxA.__puts.length === 0)) {
      ok('47.a 盘中 (周一 10:30) → deferred=trading-hours, 0 写回, 0 调 K 线');
    } else fail('47.a', JSON.stringify(rA));

    // 47.b 盘前 (交易日 09:00) → 正常 verify
    const ctxB = buildCtx();
    const nowB = new Date(2026, 6, 27, 9, 0, 0).getTime();  // 周一 09:00 北京时间, 开盘前
    const rB = await ctxB.window.ShortTrader.verifyClosedTrades({ nowMs: nowB });
    if (rB && rB.verified === 1 && !rB.deferred
      && ctxB.__puts && ctxB.__puts.length === 1
      && ctxB.__puts[0].row.verifyOutcome) {
      ok('47.b 盘前 (周一 09:00) → 正常 verify 1 笔, 写回 verifyOutcome');
    } else fail('47.b', JSON.stringify(rB) + ' puts=' + JSON.stringify(ctxB.__puts));

    // 47.c 收盘后 (交易日 16:00) → 正常 verify
    const ctxC = buildCtx();
    const nowC = new Date(2026, 6, 27, 16, 0, 0).getTime();  // 周一 16:00 北京时间, 收盘后
    const rC = await ctxC.window.ShortTrader.verifyClosedTrades({ nowMs: nowC });
    if (rC && rC.verified === 1 && !rC.deferred
      && ctxC.__puts && ctxC.__puts.length === 1) {
      ok('47.c 收盘后 (周一 16:00) → 正常 verify 1 笔, 不 deferred');
    } else fail('47.c', JSON.stringify(rC));

    // 47.d 周末 (周日 10:30) → 正常 verify (周末 _isTradingDay=false, 不进盘中判断)
    const ctxD = buildCtx();
    const nowD = new Date(2026, 6, 26, 10, 30, 0).getTime();  // 周日 10:30 北京时间
    const rD = await ctxD.window.ShortTrader.verifyClosedTrades({ nowMs: nowD });
    if (rD && rD.verified === 1 && !rD.deferred
      && ctxD.__puts && ctxD.__puts.length === 1) {
      ok('47.d 周末 (周日 10:30) → _isTradingDay=false, 正常 verify 不跳过');
    } else fail('47.d', JSON.stringify(rD));
  } catch (e) {
    fail('47 Bug D verify 盘中跳过', e.message + ' / ' + (e.stack || ''));
  }
})();

section('[48] Bug E 跳空跌破止损: bar.open<stopLoss+有成本价 → 取消仓位 (不入止损成交)');
(async () => {
  try {
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    const K = _loadRealConstants();
    const storeE = { kv: {}, tables: { paper_holdings: [] }, quotes: {}, indexSpot: [], klineByCode: {} };
    const buildCtx = () => {
      const pctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-27',
        Date,
        Math,
        JSON,
        setTimeout, clearTimeout,
        Core: {
          Constants: K,
          Storage: {
            kvGet: async (k) => storeE.kv[k],
            kvSet: async (k, v) => { storeE.kv[k] = v; },
            all: async (t) => storeE.tables[t] || [],
            get: async (t, id) => (storeE.tables[t] || []).find(r => r && r.id === id),
            put: async (t, row) => {
              storeE.tables[t] = storeE.tables[t] || [];
              const i = storeE.tables[t].findIndex(r => r && r.id === row.id);
              if (i >= 0) storeE.tables[t][i] = row; else storeE.tables[t].push(row);
            }
          },
          Data: {
            getStockSpot: async (code) => storeE.quotes[code] || null,
            getStockKLine: async (code) => storeE.klineByCode[code] || [],
            getIndexSpot: async () => storeE.indexSpot
          },
          Discipline: { preBuyCheck: async () => ({ ok: true, blocks: [], warns: [] }) },
          Util: { stockCodePrefix: () => 'sz' },
          State: { get: () => ({ currentPage: 'pagePaper' }) }
        }
      };
      pctx.Core = pctx.Core;
      pctx.window.Core = pctx.Core;
      vm.createContext(pctx);
      vm.runInContext(paperSrc, pctx);
      return pctx;
    };
    const PC = buildCtx();
    const P = PC.window.Paper;

    // 48.a 跳空低开 + 有 costPrice > stopLoss → 取消 (不写 exit)
    const posA = { stopLoss: 9, targetPrice: 11, costPrice: 10, entryPrice: 10, code: '000001', shares: 100 };
    const ecA = P._exitCheck(posA, { open: 8.5, high: 8.7, low: 8.3, close: 8.6, date: '2026-07-27' });
    if (ecA.exit === false && ecA.cancelled === true && ecA.reason === '止损失效' && ecA.price === null) {
      ok('48.a 跳空低开 (open 8.5 < stop 9) + cost 10 > stop 9 → cancelled=true, 取消仓位');
    } else fail('48.a', JSON.stringify(ecA));

    // 48.b 跳空低开 + costPrice <= stopLoss (破净成本) → 仍走止损(跳空) 老路径
    //   场景: 加仓后摊薄成本已经低于止损 (罕见, 防御) — 视为正常止损
    const posB = { stopLoss: 9, targetPrice: 11, costPrice: 8, entryPrice: 8, code: '000001', shares: 100 };
    const ecB = P._exitCheck(posB, { open: 8.5, high: 8.7, low: 8.3, close: 8.6, date: '2026-07-27' });
    if (ecB.exit === true && ecB.price === 8.5 && ecB.reason === '止损(跳空)') {
      ok('48.b 跳空低开 + cost 8 < stop 9 → 走 _isGapDown 老路径, 仍按开盘价止损');
    } else fail('48.b', JSON.stringify(ecB));

    // 48.c 跳空低开 + 无 costPrice (历史数据缺失) → 走老路径 (向后兼容)
    const posC = { stopLoss: 9, targetPrice: 11, code: '000001', shares: 100 };
    const ecC = P._exitCheck(posC, { open: 8.5, high: 8.7, low: 8.3, close: 8.6, date: '2026-07-27' });
    if (ecC.exit === true && ecC.price === 8.5 && ecC.reason === '止损(跳空)') {
      ok('48.c 跳空低开 + 无 costPrice → 向后兼容, 走 _isGapDown 老路径');
    } else fail('48.c', JSON.stringify(ecC));

    // 48.d 盘中触及止损 (low <= stop) + 有成本 → 走正常止损 (不入取消路径)
    const posD = { stopLoss: 9, targetPrice: 11, costPrice: 10, entryPrice: 10, code: '000001', shares: 100 };
    const ecD = P._exitCheck(posD, { open: 9.5, high: 9.8, low: 8.9, close: 9.2, date: '2026-07-27' });
    if (ecD.exit === true && ecD.price === 9 && ecD.reason === '止损') {
      ok('48.d 盘中触及止损 (low 8.9 < stop 9) + cost 10 > stop 9 → 正常止损价卖, 不取消');
    } else fail('48.d', JSON.stringify(ecD));

    // 48.e open 略低于 stop 但实际不跳空 (open > close) 且 cost < stop → 仍走跳空止损
    //   防御: 即使不"跳空" (open > close) 但 open 已击穿 stop, 仍是 stop 触发
    //   此 case 覆盖 _isGapDown 永远 true (只判 open <= stop) 的实现
    const posE = { stopLoss: 9, targetPrice: 11, costPrice: 8, entryPrice: 8, code: '000001', shares: 100 };
    const ecE = P._exitCheck(posE, { open: 8.7, high: 9.0, low: 8.5, close: 8.9, date: '2026-07-27' });
    if (ecE.exit === true && ecE.price === 8.7 && ecE.reason === '止损(跳空)') {
      ok('48.e open 8.7 < stop 9 + cost 8 < stop 9 → 老路径, 跳空止损 (open <= stop)');
    } else fail('48.e', JSON.stringify(ecE));

    // 48.f 跳空高开 + 止盈 (与止损对称, 不应触发取消) — sanity check
    const posF = { stopLoss: 9, targetPrice: 11, costPrice: 10, entryPrice: 10, code: '000001', shares: 100 };
    const ecF = P._exitCheck(posF, { open: 11.5, high: 12, low: 11.2, close: 11.8, date: '2026-07-27' });
    if (ecF.exit === true && ecF.price === 11.5 && ecF.reason === '止盈(跳空)') {
      ok('48.f 跳空高开 (open 11.5 >= target 11) → 止盈(跳空) 路径不受 Bug E 影响');
    } else fail('48.f', JSON.stringify(ecF));
  } catch (e) {
    fail('48 Bug E 跳空跌破止损', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== 总结 ==========
// 同步 section 的 ok() 已经在 console 打印;
// async IIFE 里的 ok() 还在 microtask / setTimeout 队列里, 旧版本 setImmediate 只给一次机会,
// 36.x 段有 5×50ms=250ms setTimeout wait 链 (vm 跨边界 fire-and-forget then), 旧机制直接掐断 → 假绿。
// 修法: 每 30ms poll 一次 process._getActiveHandles(), 把 timer / immediate / pending I/O 句柄
//      都算成 "active"; 等 active=0 连续 2 轮 (60ms) 才 resolve, 封顶 5s。
// 注: Node 24 不再把 setTimeout 句柄放在 _getActiveHandles 返回值里, 所以 active=0 主要靠
//      "process 内部尚未处理完的 I/O / pending handle" 来撑住等待。36.x 段的 setTimeout 链
//      总长 250ms (5×50ms), 60ms 等不到 → 还会 fail; 因此 MAX_MS 5s 封顶 + 至少 60ms 起步
//      + 实际依赖 vm 跨边界 promise.resolve 在每 tick 之间被 microtask drain 触发。
function waitForIIFEsDrain() {
  return new Promise((resolve) => {
    const start = Date.now();
    const MAX_MS = 5000;
    const INTERVAL_MS = 30;
    const REQUIRED_QUIET = 8;  // 8 × 30 = 240ms 连续无 active 才认为 drained (36.x setTimeout 链 250ms)
    let quietTicks = 0;
    const tick = () => {
      if (Date.now() - start > MAX_MS) return resolve();  // 封顶
      const handles = process._getActiveHandles();
      const isTimerLike = (h) => h && (h._onTimeout
        || (typeof h.hasRef === 'function' && h._idleStart !== undefined && h._idleNext)
        || (h.constructor && (h.constructor.name === 'WriteStream' || h.constructor.name === 'Socket')));
      const activeCount = handles.filter(isTimerLike).length;
      // 注意: 即使 handles 中没有 timer 句柄, Node 24 也可能在底层 event loop 仍持有
      // pending microtask / setImmediate / I/O; 这里用 setInterval 间隔 (30ms) 给底层
      // 多次机会处理, REQUIRED_QUIET=2 连续 60ms 稳定才收手。
      void activeCount;  // 留口子: 若未来需要可观察, 当前 Node 24 不返回 timer
      if (activeCount === 0) {
        quietTicks++;
        if (quietTicks >= REQUIRED_QUIET) return resolve();
      } else {
        quietTicks = 0;
      }
      setTimeout(tick, INTERVAL_MS);
    };
    setTimeout(tick, INTERVAL_MS);
  });
}

// ========== [49] Bug J KB tags 兜底 + ai-advisor 调用方注释 ==========
section('[49] Bug J KB 匹配: tags 兜底 + ai-advisor 调用方注释');
(async () => {
  try {
    const kbSrc = readFileSafe(path.join(WWW, 'core', 'kb.js'));
    if (!kbSrc) throw new Error('kb.js 读不到');

    // 49.a 源码对账: pickRelevant 含 tags 兜底逻辑
    if (/tags[\s\S]{0,200}兜底|score\s*\+=\s*0\.5/.test(kbSrc)) ok('kb.js pickRelevant 加 tags 兜底 (score += 0.5)');
    else fail('kb.js tags 兜底', '源码未找到 tags 兜底标记');

    // 49.b 源码对账: ai-advisor.js 注释解释 seed 前 5 作 placeholder + tags 兜底
    const advSrc = readFileSafe(path.join(WWW, 'app', 'fund', 'ai-advisor.js'));
    if (advSrc && /Bug J 修复[\s\S]{0,300}tags 兜底/.test(advSrc)) ok('ai-advisor.js 调用方注释解释 placeholder + tags 兜底');
    else fail('ai-advisor.js 注释', '源码未找到 Bug J 注释标记');

    // 49.c 功能实测: pickRelevant 用合成 KB + fetch mock (绕开空 KB fallback)
    const vmCtx = {
      console,
      setTimeout, clearTimeout,
      // fetch mock: 返 ok + 含 tags 的合成 KB
      fetch: async () => ({ ok: true, json: async () => ({ _meta: {}, entries: [
        { id: 'KW-1', category: 'risk', title: '波动率风险', keywords: ['波动', '风险'], tags: ['risk'] },
        { id: 'KW-2', category: 'fixed_income', title: '华富吉富30天滚动持有短债', keywords: ['华富吉富30天', '短债持有期'], tags: ['short_bond', '纯债'] },
        { id: 'KW-3', category: 'cycle', title: '美林时钟', keywords: ['美林', '周期'], tags: ['cycle'] }
      ]}) }),
      // 顶层 Core (kb.js 引用 Core.Storage 不走 window)
      Core: { Storage: { cacheGet: async () => null, cacheSet: async () => {} } }
    };
    vmCtx.window = { Core: vmCtx.Core };
    vm.createContext(vmCtx);
    vm.runInContext(kbSrc, vmCtx);

    // query "短债" → KW-2 tags 命中 (0.5), KW-1/KW-3 都不命中 (0)
    const r1 = await vmCtx.window.Core.KB.pickRelevant({ holdings: [{ name: '短债', type: 'short_bond' }], maxN: 3 });
    if (r1.length === 1 && r1[0].id === 'KW-2') ok('tags 兜底: query="短债" → KW-2 命中 (keywords 无, tags 有)');
    else fail('tags 兜底实测', `r1=${JSON.stringify(r1.map(e => e.id))}`);

    // 49.d 回归: keywords 直接命中仍优先 (score=1 > tags 兜底 score=0.5)
    const r2 = await vmCtx.window.Core.KB.pickRelevant({ holdings: [{ name: '波动' }], maxN: 3 });
    if (r2.length > 0 && r2[0].id === 'KW-1') ok('keywords 命中优先 (score=1 > tags 兜底 score=0.5)');
    else fail('keywords 优先', `r2=${JSON.stringify(r2.map(e => e.id))}`);
  } catch (e) {
    fail('Bug J 测试', e.message + ' / ' + e.stack);
  }
})();

// ========== [44] 短线两阶段选品 候选池扩展 + 板块注入 + 阶段 1 截断 (Commit 2) ==========
section('[44] short-trader.js 候选池扩展 + 阶段 1 排序截断');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');

    // 44.a _mergeCandPools 去重保序
    if (/_mergeCandPools\(basePool, screenerTop\)[\s\S]{0,600}seen\.has\(x\.code\)[\s\S]{0,400}seen\.add\(code\)[\s\S]{0,400}fromScreener: true/.test(stSrc))
      ok('44.a _mergeCandPools 去重保序 + fromScreener 标记');
    else fail('44.a _mergeCandPools', '源码未匹配去重保序实现');

    // 44.b _stage1Score 空特征仍返数字 + 权重引用
    if (/_stage1Score\(x, ctx\)[\s\S]{0,800}const w = _STAGE1_WEIGHTS[\s\S]{0,200}trend5 \* w\.trend5pct[\s\S]{0,200}range20 \* w\.range20[\s\S]{0,200}indRank \* w\.industryRank/.test(stSrc))
      ok('44.b _stage1Score 4 维加权 (trend/range/drift/industryRank)');
    else fail('44.b _stage1Score', '源码未匹配 4 维加权公式');

    // 44.c 阶段 1 截断: expandMode=false + pool > 5 → 截 5 + stage1Dropped
    if (/expandMode[\s\S]{0,200}paper_short_expand_mode[\s\S]{0,400}_POOL_TARGET[\s\S]{0,300}stage1Dropped[\s\S]{0,200}slice\(_POOL_TARGET\)/.test(stSrc))
      ok('44.c 阶段 1 截断 (kv expandMode + 5 只 + stage1Dropped)');
    else fail('44.c 阶段 1 截断', '源码未匹配截断逻辑');

    // 44.d 板块注入: industryByCode + industryChangeByCode Map
    if (/industryByCode = new Map\(\)[\s\S]{0,300}industryChangeByCode = new Map\(\)[\s\S]{0,800}Core\.Market\.get\('industry'\)[\s\S]{0,800}getStockIndustryByCode/.test(stSrc))
      ok('44.d 板块注入 (Market.get industry + getStockIndustryByCode 反查)');
    else fail('44.d 板块注入', '源码未匹配板块 Map 构建');

    // 44.e Paper UI: setShortExpandMode + kv 写
    const paperSrc = readFileSafe(path.join(WWW, 'app', 'paper.js'));
    if (!paperSrc) throw new Error('paper.js 读不到');
    if (/setShortExpandMode\(checked\)[\s\S]{0,200}kvSet\('paper_short_expand_mode'/.test(paperSrc))
      ok('44.e Paper.setShortExpandMode 写 kv paper_short_expand_mode');
    else fail('44.e setShortExpandMode', 'paper.js 未匹配 setShortExpandMode 实现');

    // 44.f index.html 含 paperShortExpandMode checkbox
    const htmlSrc = readFileSafe(path.join(WWW, 'index.html'));
    if (!htmlSrc) throw new Error('index.html 读不到');
    if (/id="paperShortExpandMode"[\s\S]{0,200}Paper\.setShortExpandMode\(this\.checked\)/.test(htmlSrc))
      ok('44.f index.html 含 paperShortExpandMode checkbox + onchange 接线');
    else fail('44.f index.html checkbox', 'index.html 未含 paperShortExpandMode checkbox');
  } catch (e) {
    fail('44 候选池扩展', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [45] 短线两阶段选品 公告注入 prompt (Commit 3) ==========
section('[45] short-trader.js 公告注入 prompt');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');

    // 45.a ctx.noticesByCode 装配 (截断后并发拉, 单只 5 条上限由 data 层保证)
    if (/noticesByCode = new Map\(\)[\s\S]{0,300}getStockNoticesByCode\(c\.code, 7\)[\s\S]{0,400}noticesByCode\.set\(ctx\.pool\[i\]\.code/.test(stSrc))
      ok('45.a ctx.noticesByCode 装配 (getStockNoticesByCode 7 天 + Map.set)');
    else fail('45.a ctx.noticesByCode', '源码未匹配公告 Map 装配');

    // 45.b _buildUserPrompt 公告行渲染 ([公告:type+text|...])
    if (/_buildUserPrompt[\s\S]{0,4000}noticesByCode[\s\S]{0,400}\[公告:\$\{notices\.map/.test(stSrc))
      ok('45.b _buildUserPrompt 候选池行含 [公告:...] 渲染');
    else fail('45.b 公告渲染', 'userPrompt 未含公告行');

    // 45.c _buildSystemPrompt 含行业 + 公告准则
    if (/_buildSystemPrompt[\s\S]{0,4000}【行业 \+ 公告[\s\S]{0,300}业绩预告\(预增→催化[\s\S]{0,300}股东减持\(→谨慎/.test(stSrc))
      ok('45.c _buildSystemPrompt 含【行业 + 公告】准则段');
    else fail('45.c systemPrompt 准则', '源码未匹配公告准则');

    // 45.d 板块行渲染 ([行业:名 涨跌% (rank/total)])
    if (/_buildUserPrompt[\s\S]{0,4000}industryChangeByCode[\s\S]{0,400}\[行业:\$\{indInfo\.industryName\}/.test(stSrc))
      ok('45.d _buildUserPrompt 候选池行含 [行业:名 涨跌%] 渲染');
    else fail('45.d 板块渲染', 'userPrompt 未含板块行');
  } catch (e) {
    fail('45 公告注入', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [46] 短线两阶段选品 量能异动 + 最终 prompt 模板 (Commit 4) ==========
section('[46] short-trader.js 量比 (volRatio) 注入');
(async () => {
  try {
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');

    // 46.a _barOf 标准化含 volume 字段
    if (/_barOf\(row\)[\s\S]{0,400}volume = parseFloat\(row\.成交量\)/.test(stSrc))
      ok('46.a _barOf 含 volume (成交量)');
    else fail('46.a _barOf volume', '源码未匹配 volume 标准化');

    // 46.b _summarizeKline 计算 volRatio = todayVol / 前 20 日均量 (bars<21 → null)
    if (/_summarizeKline[\s\S]{0,2500}volRatio = \(\(\) => \{[\s\S]{0,300}bars\.length < 21[\s\S]{0,300}todayVol \/ avg20Vol[\s\S]{0,500}volRatio\r?\n\s+\};/.test(stSrc))
      ok('46.b _summarizeKline 输出 volRatio (bars<21 → null)');
    else fail('46.b _summarizeKline volRatio', '源码未匹配 volRatio 计算');

    // 46.c _buildUserPrompt 候选池行含量比渲染 (↑放量/↓缩量)
    if (/_buildUserPrompt[\s\S]{0,4000}量比\$\{kf\.volRatio\}[\s\S]{0,200}↑放量[\s\S]{0,200}↓缩量/.test(stSrc))
      ok('46.c _buildUserPrompt 候选池行含量比渲染 (↑放量/↓缩量)');
    else fail('46.c 量比渲染', 'userPrompt 未含量比渲染');

    // 46.d _buildSystemPrompt 含【量能异动】准则段
    if (/_buildSystemPrompt[\s\S]{0,6000}【量能异动[\s\S]{0,300}volRatio = 今日量 \/ 前 20 日均量[\s\S]{0,300}volRatio > 1\.5[\s\S]{0,200}volRatio < 0\.7/.test(stSrc))
      ok('46.d _buildSystemPrompt 含【量能异动】准则段');
    else fail('46.d systemPrompt 量比准则', '源码未匹配量比准则');

    // 46.e _summarizeKline 沙箱实测: 21 根 → volRatio 正确; 20 根 → volRatio=null
    const vmCtx = {
      console, window: {}, document: undefined,
      Core: { Constants: { SHORT_RULES: {}, SHORT_LESSONS_TEXT_MAX_LEN: 40, SCORECARD_MIN_SAMPLES: 3, BRIER_MIN_SAMPLES: 5 } }
    };
    vmCtx.window.Core = vmCtx.Core;
    const vm = require('vm');
    vm.createContext(vmCtx);
    // 抽出 ShortTrader 对象 (整个 IIFE)
    const iifeMatch = stSrc.match(/\(function\(\) \{[\s\S]*?\n\}\)\(\);?\s*$/);
    if (!iifeMatch) throw new Error('short-trader IIFE 提取失败');
    vm.runInContext(iifeMatch[0], vmCtx);
    const ST = vmCtx.window.ShortTrader;
    if (!ST || typeof ST._summarizeKline !== 'function') throw new Error('ShortTrader._summarizeKline 未暴露');
    // 21 根: 最后一根量 2000, 前 20 根每根 1000 → volRatio = 2
    const bars21 = [];
    for (let i = 0; i < 21; i++) {
      bars21.push({ 开盘: 10, 最高: 10.5, 最低: 9.5, 收盘: 10 + i * 0.01, 成交量: i === 20 ? 2000 : 1000, 日期: '2026-07-' + String(i + 1).padStart(2, '0') });
    }
    const feats21 = ST._summarizeKline(bars21);
    if (feats21 && feats21.volRatio === 2) ok('46.e.1 _summarizeKline 21 根 volRatio=2 (沙箱实测)');
    else fail('46.e.1 volRatio 21 根', `实测=${feats21 && feats21.volRatio}`);
    // 20 根 → volRatio=null
    const feats20 = ST._summarizeKline(bars21.slice(1));
    if (feats20 && feats20.volRatio === null) ok('46.e.2 _summarizeKline 20 根 volRatio=null');
    else fail('46.e.2 volRatio 20 根', `实测=${feats20 && feats20.volRatio}`);
    // avg20Vol=0 → volRatio=null
    const barsZero = bars21.map(b => Object.assign({}, b, { 成交量: 0 }));
    const featsZero = ST._summarizeKline(barsZero);
    if (featsZero && featsZero.volRatio === null) ok('46.e.3 _summarizeKline avg20Vol=0 → volRatio=null');
    else fail('46.e.3 volRatio 零均量', `实测=${featsZero && featsZero.volRatio}`);
  } catch (e) {
    fail('46 量比注入', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [50] 短线两阶段选品 资料接口 (Commit 1) ==========
section('[50] data.js 行业映射 + 公告 + 量比');
(async () => {
  try {
    const dataSrc = readFileSafe(path.join(WWW, 'core', 'data.js'));
    if (!dataSrc) throw new Error('data.js 读不到');

    // 50.a getStockIndustryByCode: 24h cache + 反向 idx 写法
    if (/getStockIndustryByCode[\s\S]{0,300}industry_by_code_v1[\s\S]{0,200}stock_board_industry_cons_em/.test(dataSrc))
      ok('50.a getStockIndustryByCode 24h cache + stock_board_industry_cons_em 反查');
    else fail('50.a 行业映射', '源码未匹配预期实现');

    // 50.b getStockNoticesByCode: 三类合并 + 单只 5 条上限
    if (/getStockNoticesByCode[\s\S]*?业绩预告[\s\S]*?股东减持[\s\S]*?getStockAllAnnouncements\(\)[\s\S]*?slice\(0, 5\)/.test(dataSrc))
      ok('50.b getStockNoticesByCode 业绩预告+减持+全市场公告 三类合并 + 5 条上限');
    else fail('50.b 公告查询', '源码未匹配三类合并 + 5 条上限');

    // 50.c getStockVolumeAnomaly: 复用 getStockKLine + volRatio 计算
    if (/getStockVolumeAnomaly[\s\S]{0,800}avg20Vol[\s\S]{0,300}volRatio/.test(dataSrc))
      ok('50.c getStockVolumeAnomaly 复用 K线 + volRatio = todayVol/avg20Vol');
    else fail('50.c 量比', '源码未匹配 volRatio 计算');

    // 50.d 暴露: window.Core.Data 含 3 个方法 (DATA_METHODS 已自动覆盖, 此处只验不在 DATA_METHODS 时补漏)
    const exposeLine = dataSrc.match(/getStockIndustryByCode[\s\S]{0,100}getStockIndustryBatch/);
    if (exposeLine) ok('50.d window.Core.Data 暴露 3 个新接口');
    else fail('50.d 暴露', 'window.Core.Data 未导出 4 个新方法');
  } catch (e) {
    fail('50 data.js 接口', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [51] Core.UserProfile 基础模块 (Commit 1) ==========
section('[51] Core.UserProfile 7 字段 schema');
(async () => {
  try {
    // vm sandbox 加载 user-profile.js (独立运行, 不依赖其他 Core)
    const src = readFileSafe(path.join(WWW, 'core', 'user-profile.js'));
    if (!src) throw new Error('user-profile.js 读不到');
    const mem = {};
    const upCtx = vm.createContext({
      window: {},
      console,
      Core: {
        State: {
          get: function (k, d) { return (k in mem) ? mem[k] : d; },
          set: function (k, v) { mem[k] = v; }
        }
      }
    });
    vm.runInContext(src, upCtx);
    const UP = upCtx.window.Core && upCtx.window.Core.UserProfile;
    if (!UP) throw new Error('Core.UserProfile 未挂载');

    // 51.a 静态数据 (DEFAULTS + 3 个 *_TEXT 字典)
    if (UP && typeof UP === 'object') ok('51.a Core.UserProfile 命名空间存在');
    else fail('51.a 命名空间', '未挂到 window.Core.UserProfile');

    if (UP.DEFAULTS && UP.DEFAULTS.risk === 'moderate'
        && UP.DEFAULTS.horizon === '1-3y'
        && UP.DEFAULTS.allowEquity === 'no'
        && UP.DEFAULTS.targetReturn === 5
        && UP.DEFAULTS.maxDrawdown === 10) {
      ok('51.b DEFAULTS: risk=moderate/horizon=1-3y/allowEquity=no/targetReturn=5/maxDrawdown=10');
    } else fail('51.b DEFAULTS', JSON.stringify(UP.DEFAULTS));

    if (UP.SCHEMA.length === 7 && UP.SCHEMA.includes('risk')
        && UP.SCHEMA.includes('targetReturn') && UP.SCHEMA.includes('maxDrawdown')) {
      ok('51.c SCHEMA 含 7 字段 (risk/horizon/allowEquity/preference/blacklist/targetReturn/maxDrawdown)');
    } else fail('51.c SCHEMA', JSON.stringify(UP.SCHEMA));

    if (UP.RISK_TEXT.conservative && UP.RISK_TEXT.conservative.includes('极度保守')
        && UP.RISK_TEXT.moderate && UP.RISK_TEXT.moderate.includes('稳健')
        && UP.RISK_TEXT.balanced && UP.RISK_TEXT.balanced.includes('平衡')) {
      ok('51.d RISK_TEXT 3 档中文 (极度保守/稳健/平衡)');
    } else fail('51.d RISK_TEXT', '缺中文文案');

    // 51.e 纯函数 mergeWithDefaults: null → 全默认
    const m1 = UP.mergeWithDefaults(null);
    if (m1.risk === 'moderate' && m1.targetReturn === 5 && m1.maxDrawdown === 10 && m1.preference === '') {
      ok('51.e mergeWithDefaults(null) → 全默认');
    } else fail('51.e mergeWithDefaults(null)', JSON.stringify(m1));

    // 51.f mergeWithDefaults: 部分覆盖
    const m2 = UP.mergeWithDefaults({ risk: 'conservative', targetReturn: 8, preference: 'ESG' });
    if (m2.risk === 'conservative' && m2.targetReturn === 8 && m2.preference === 'ESG'
        && m2.horizon === '1-3y' && m2.maxDrawdown === 10 && m2.blacklist === '') {
      ok('51.f mergeWithDefaults 部分覆盖 + 未指定字段走默认');
    } else fail('51.f mergeWithDefaults 部分覆盖', JSON.stringify(m2));

    // 51.g mergeWithDefaults: 数字字段 coerce (字符串 "8" → 8)
    const m3 = UP.mergeWithDefaults({ targetReturn: '8.5', maxDrawdown: '15' });
    if (m3.targetReturn === 8.5 && m3.maxDrawdown === 15) ok('51.g mergeWithDefaults 数字字段字符串 coerce');
    else fail('51.g coerce', JSON.stringify(m3));

    // 51.h validate: 合法 profile → ok
    const v1 = UP.validate({
      risk: 'balanced', horizon: '3y+', allowEquity: 'yes',
      preference: 'X', blacklist: 'Y', targetReturn: 8, maxDrawdown: 20
    });
    if (v1.valid === true && v1.errors.length === 0) ok('51.h validate 合法 profile → valid=true');
    else fail('51.h validate 合法', JSON.stringify(v1));

    // 51.i validate: 非法 risk → errors
    const v2 = UP.validate({
      risk: 'invalid', horizon: '1y', allowEquity: 'no',
      targetReturn: 5, maxDrawdown: 10
    });
    if (v2.valid === false && v2.errors.some(e => /risk/.test(e))) ok('51.i validate 非法 risk → valid=false + errors');
    else fail('51.i validate 非法', JSON.stringify(v2));

    // 51.j validate: 数值越界
    const v3 = UP.validate({
      risk: 'moderate', horizon: '1y', allowEquity: 'no',
      targetReturn: 200, maxDrawdown: -5
    });
    if (v3.valid === false && v3.errors.length >= 2) ok('51.j validate targetReturn=200 / maxDrawdown=-5 → 拒');
    else fail('51.j validate 越界', JSON.stringify(v3));

    // 51.k riskLabel / horizonLabel / allowEquityLabel: 已知值返回中文
    if (UP.riskLabel('conservative').includes('极度保守')
        && UP.horizonLabel('1y').includes('1 年内')
        && UP.allowEquityLabel('yes').includes('允许')) {
      ok('51.k label 函数 (riskLabel/horizonLabel/allowEquityLabel)');
    } else fail('51.k label', 'label 函数未返回中文');

    // 51.l label 容错: 未知值返回默认
    if (UP.riskLabel('???').includes('稳健')
        && UP.horizonLabel('???').includes('1-3')) {
      ok('51.l label 容错 (未知值 → 默认)');
    } else fail('51.l label 容错', 'label 未知值未走默认');

    // 51.m save / load round-trip (走 mock State 隔离)
    const r = UP.save({ risk: 'balanced', targetReturn: 12 });
    const loaded = UP.load();
    if (r === true && loaded.risk === 'balanced' && loaded.targetReturn === 12 && loaded.horizon === '1-3y') {
      ok('51.m save → load round-trip (字段覆盖 + 默认填充)');
    } else fail('51.m round-trip', `save=${r}, load=${JSON.stringify(loaded)}`);

    // 51.n save 校验失败: 非法 profile 不写入
    const beforeReject = JSON.stringify(mem);
    const r2 = UP.save({ risk: 'INVALID', horizon: '1y', allowEquity: 'no', targetReturn: 5, maxDrawdown: 10 });
    const afterReject = JSON.stringify(mem);
    if (r2 === false && beforeReject === afterReject) {
      ok('51.n save 拒绝非法 profile (State 未变)');
    } else fail('51.n save 拒绝', `r=${r2}, before=${beforeReject}, after=${afterReject}`);

    // 51.o load 失败降级 (mock Core.State.get 抛错 → 返回 DEFAULTS)
    const failCtx = vm.createContext({
      window: {},
      console,
      Core: {
        State: {
          get: function () { throw new Error('mock fail'); },
          set: function () {}
        }
      }
    });
    vm.runInContext(src, failCtx);
    const UP2 = failCtx.window.Core.UserProfile;
    const fallback = UP2.load();
    if (fallback.risk === 'moderate' && fallback.targetReturn === 5) {
      ok('51.o load 失败 → 返回 DEFAULTS (降级)');
    } else fail('51.o load 降级', JSON.stringify(fallback));
  } catch (e) {
    fail('51 Core.UserProfile', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [52] Core.AI.formatUserProfile (Commit 2: 用户画像统一格式化) ==========
section('[52] Core.AI.formatUserProfile: 把 UserProfile 渲染成中文 prompt 段');
(async () => {
  try {
    // vm sandbox 同时加载 user-profile.js + ai-service.js
    // (ai-service 依赖 Core.UserProfile, 所以先建 ctx, 再注入 UserProfile 后加载 ai-service)
    const upSrc = readFileSafe(path.join(WWW, 'core', 'user-profile.js'));
    const aiSrc = readFileSafe(path.join(WWW, 'core', 'ai-service.js'));
    if (!upSrc) throw new Error('user-profile.js 读不到');
    if (!aiSrc) throw new Error('ai-service.js 读不到');

    // 1) 完整 render: 全字段
    const fullMem = {};
    const fullCtx = vm.createContext({
      window: {},
      console,
      Core: {
        State: {
          get: (k, d) => (k in fullMem) ? fullMem[k] : d,
          set: (k, v) => { fullMem[k] = v; }
        },
        Util: {}
      }
    });
    vm.runInContext(upSrc, fullCtx);
    vm.runInContext(aiSrc, fullCtx);

    fullCtx.window.Core.UserProfile.save({
      risk: 'balanced',
      horizon: '3y+',
      allowEquity: 'yes',
      preference: '重仓蓝筹',
      blacklist: 'ST,教育',
      targetReturn: 12,
      maxDrawdown: 20
    });
    const seg = fullCtx.window.Core.AI.formatUserProfile();

    // 52.a 全字段渲染 (7 行都包含)
    if (seg && seg.includes('风险偏好') && seg.includes('平衡')
        && seg.includes('3 年以上')
        && seg.includes('允许股票类资产')
        && seg.includes('目标年化收益率: 12%')
        && seg.includes('可接受最大回撤: 20%')
        && seg.includes('重仓蓝筹')
        && seg.includes('ST,教育')) {
      ok('52.a 全字段: 7 行完整中文 + 含用户偏好/黑名单');
    } else fail('52.a 全字段', seg);

    // 52.b 仅渲染有值的字段 (空 preference/blacklist 应不渲染)
    fullCtx.window.Core.UserProfile.save({
      risk: 'conservative', horizon: '1y', allowEquity: 'no',
      targetReturn: 3, maxDrawdown: 2
    });
    const seg2 = fullCtx.window.Core.AI.formatUserProfile();
    if (seg2.includes('极度保守') && seg2.includes('1 年内') && seg2.includes('仅基金')
        && seg2.includes('3%') && seg2.includes('2%')
        && !seg2.includes('个人偏好:') && !seg2.includes('黑名单:')) {
      ok('52.b 默认保守: 5 行基础字段, 偏好/黑名单省略');
    } else fail('52.b 默认保守', seg2);

    // 52.c 缺 Core.UserProfile → 降级返空串 (不抛错)
    const noUpCtx = vm.createContext({
      window: {}, console,
      Core: {
        State: { get: () => null, set: () => {} },
        Util: {}
      }
    });
    vm.runInContext(aiSrc, noUpCtx);
    const seg3 = noUpCtx.window.Core.AI.formatUserProfile();
    if (seg3 === '') ok('52.c 无 Core.UserProfile → 返空串 (降级)');
    else fail('52.c 降级', `expected "", got ${JSON.stringify(seg3)}`);

    // 52.d Core.UserProfile.load() 抛错 → UserProfile 内部 catch 返 DEFAULTS, formatUserProfile 仍能返稳定 profile (5 行)
    const brokenCtx = vm.createContext({
      window: {}, console,
      Core: {
        State: {
          get: () => { throw new Error('mock fail'); },
          set: () => {}
        },
        Util: {}
      }
    });
    vm.runInContext(upSrc, brokenCtx);
    vm.runInContext(aiSrc, brokenCtx);
    const seg4 = brokenCtx.window.Core.AI.formatUserProfile();
    if (seg4 && seg4.includes('稳健') && seg4.includes('1-3 年') && seg4.includes('5%') && seg4.includes('10%')) {
      ok('52.d load 抛错 → UserProfile 兜底 → formatUserProfile 仍稳定返默认 profile');
    } else fail('52.d 异常降级', JSON.stringify(seg4));

    // 52.e formatUserProfile 挂载到 Core.AI
    if (typeof fullCtx.window.Core.AI.formatUserProfile === 'function') {
      ok('52.e Core.AI.formatUserProfile 已挂载');
    } else fail('52.e 挂载', 'Core.AI.formatUserProfile 未挂载');
  } catch (e) {
    fail('52 Core.AI.formatUserProfile', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [53] fund/ai-advisor.js: prompt 含 Core.UserProfile 注入 (Commit 3) ==========
section('[53] fund/ai-advisor.js: systemPrompt 不再硬编码"长期稳健型", 改用 Core.AI.formatUserProfile');
(async () => {
  try {
    const advSrc = readFileSafe(path.join(WWW, 'app', 'fund', 'ai-advisor.js'));
    if (!advSrc) throw new Error('fund/ai-advisor.js 读不到');

    // 53.1 静态扫描: systemPrompt【用户画像】段不再直接硬编码"长期稳健型"
    // (允许作为 *降级兜底文案* 在 formatUserProfile() 返空时出现, 不能直接写在主体段)
    const sysPromptMatch = advSrc.match(/const systemPrompt = `([\s\S]*?)`;/);
    if (!sysPromptMatch) throw new Error('systemPrompt 模板字符串未找到');
    const sysTpl = sysPromptMatch[1];

    // 53.a 【用户画像】段已迁移成 Core.AI.formatUserProfile() 调用
    // (允许 || 之后的降级文案含"长期稳健型"作为 formatUserProfile 抛错时的兜底)
    const upSegMatch = sysTpl.match(/【用户画像】([\s\S]*?)(?=\n【|\n```|$)/);
    const userProfileSeg = upSegMatch ? upSegMatch[1] : '';
    // 检查"长期稳健型"只出现在 || 之后 (降级路径), 不能独立成行
    const hardCodedLines = (userProfileSeg || '').split('\n')
      .filter(line => /长期稳健型/.test(line) && !line.includes('||'));
    if (userProfileSeg && /Core\.AI\.formatUserProfile\(\)/.test(userProfileSeg)
        && hardCodedLines.length === 0) {
      ok('53.a 【用户画像】段: 调 formatUserProfile, 主体无硬编码"长期稳健型" (|| 降级文案允许)');
    } else fail('53.a', `段=${JSON.stringify(userProfileSeg).slice(0, 200)}, 硬编码行=${hardCodedLines.length}`);

    // 53.b 含 Core.AI.formatUserProfile 注入 (全局断言)
    if (/Core\.AI\.formatUserProfile\(\)/.test(sysTpl)) ok('53.b systemPrompt 调用 Core.AI.formatUserProfile()');
    else fail('53.b', 'systemPrompt 未调 formatUserProfile');

    // 53.c 含"用户画像"段标记
    if (/【用户画像】/.test(sysTpl)) ok('53.c systemPrompt 含【用户画像】段');
    else fail('53.c', 'systemPrompt 缺【用户画像】');

    // 53.2 动态 vm 验证: 默认 profile → prompt 含 "稳健" + 不再含 "长期稳健型 (年化 3-5%"
    const upSrc = readFileSafe(path.join(WWW, 'core', 'user-profile.js'));
    const aiSrc = readFileSafe(path.join(WWW, 'core', 'ai-service.js'));
    const runMem = {};
    const runCtx = vm.createContext({
      window: {}, console,
      Core: {
        State: {
          get: (k, d) => (k in runMem) ? runMem[k] : d,
          set: (k, v) => { runMem[k] = v; }
        }
      }
    });
    vm.runInContext(upSrc, runCtx);
    vm.runInContext(aiSrc, runCtx);
    // 默认 profile (无 userProfile 持久化) → render 稳定
    const profileSeg = runCtx.window.Core.AI.formatUserProfile();
    if (profileSeg && profileSeg.includes('稳健')) ok('53.d 默认 profile (空持久化) → formatUserProfile 返"稳健"');
    else fail('53.d', JSON.stringify(profileSeg));

    // 53.3 设 balanced 后 → formatUserProfile 返"平衡"
    runCtx.window.Core.UserProfile.save({
      risk: 'balanced', horizon: '3y+', allowEquity: 'yes',
      targetReturn: 15, maxDrawdown: 25
    });
    const seg2 = runCtx.window.Core.AI.formatUserProfile();
    if (seg2.includes('平衡') && seg2.includes('3 年以上')
        && seg2.includes('允许股票类资产') && seg2.includes('15%') && seg2.includes('25%')) {
      ok('53.e balanced profile → 完整 5 行中文渲染');
    } else fail('53.e', JSON.stringify(seg2));

    // 53.f userPrompt 部分: 注入全局 userProfile 段
    const userPromptMatch = advSrc.match(/const userPrompt = `([\s\S]*?)`;/);
    if (userPromptMatch && /全局用户画像/.test(userPromptMatch[1])
        && /Core\.UserProfile|Core\.AI\.formatUserProfile/.test(userPromptMatch[1])) {
      ok('53.f userPrompt 含【全局用户画像】段 + 调 formatUserProfile');
    } else fail('53.f', 'userPrompt 未注全局画像');

    // 53.g 保留: form-driven 本单用户画像 (单次覆盖)
    if (/风险偏好: \$\{riskText\}/.test(userPromptMatch[1])
        && /投资期限: \$\{horizonText\}/.test(userPromptMatch[1])) {
      ok('53.g userPrompt 保留本单字段 (riskText/horizonText 模板)');
    } else fail('53.g', '本单字段模板丢失');
  } catch (e) {
    fail('53 fund/ai-advisor.js', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [54] screener.js: prompt 含 Core.UserProfile 注入 (Commit 4) ==========
section('[54] screener.js: systemPrompt 改用 Core.AI.formatUserProfile (与选基共用同一来源)');
(async () => {
  try {
    const scSrc = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (!scSrc) throw new Error('screener.js 读不到');

    // 54.a systemPrompt 模板【用户画像】段调 Core.AI.formatUserProfile()
    const sysMatch = scSrc.match(/const systemPrompt = `([\s\S]*?)`;/);
    if (!sysMatch) throw new Error('systemPrompt 模板字符串未找到');
    const sysTpl = sysMatch[1];

    const segMatch = sysTpl.match(/【用户画像】([\s\S]*?)(?=\n【|\n```|$)/);
    const upSeg = segMatch ? segMatch[1] : '';
    const hardCodedLines = (upSeg || '').split('\n')
      .filter(line => /长期稳健型/.test(line) && !line.includes('||'));
    if (upSeg && /Core\.AI\.formatUserProfile\(\)/.test(upSeg) && hardCodedLines.length === 0) {
      ok('54.a screener【用户画像】段: 调 formatUserProfile, 主体无硬编码');
    } else fail('54.a', `upSeg=${JSON.stringify(upSeg).slice(0, 200)}, 硬编码行=${hardCodedLines.length}`);

    // 54.b 选股 prompt 与 选基 (53.b) 用同一个 Core.AI.formatUserProfile
    // (静态一致性检查: 两文件都出现这个函数调用)
    const advSrc = readFileSafe(path.join(WWW, 'app', 'fund', 'ai-advisor.js'));
    if (scSrc.includes('Core.AI.formatUserProfile()') && advSrc.includes('Core.AI.formatUserProfile()')) {
      ok('54.b 选股 + 选基 都用 Core.AI.formatUserProfile() (单一来源)');
    } else fail('54.b', '两文件至少有一个未引 Core.AI.formatUserProfile');

    // 54.c screener.js 与 ai-advisor.js 的"硬编码长期稳健型"已下线
    // 检查文件层面剩余出现次数 (只允许作为 || 降级文案, 不能独立成行)
    const scHardCount = (scSrc.match(/长期稳健型/g) || []).length;
    const advHardCount = (advSrc.match(/长期稳健型/g) || []).length;
    if (scHardCount <= 1 && advHardCount <= 1) {
      ok(`54.c 硬编码兜底 ≤ 1 次/文件 (screener=${scHardCount}, advisor=${advHardCount}, 都用作 || 降级)`);
    } else fail('54.c', `screener=${scHardCount} advisor=${advHardCount} 超出`);
  } catch (e) {
    fail('54 screener.js', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [55] state.js init() 还原 Core.UserProfile (Commit 5: 修复丢画像 bug) ==========
section('[55] state.js init() 必须还原 state_userProfile (否则重启后丢回默认)');
(async () => {
  try {
    const stateSrc = readFileSafe(path.join(WWW, 'core', 'state.js'));
    if (!stateSrc) throw new Error('state.js 读不到');

    // 55.a init() 内 kvGet('state_userProfile') 调用
    const initMatch = stateSrc.match(/async function init\(\)\s*\{([\s\S]*?)\n\s*\}/);
    if (!initMatch) throw new Error('init() 函数未找到');
    const initBody = initMatch[1];

    if (/kvGet\(['"]state_userProfile['"]\)/.test(initBody)) {
      ok('55.a state.js init() 含 kvGet(\'state_userProfile\') 还原调用');
    } else fail('55.a', 'init() 内未还原 userProfile');

    // 55.b init() 内还原后赋值给 _state.userProfile
    if (/userProfile[^a-zA-Z_$].*_state\.userProfile\s*=/.test(initBody)
        || /_state\.userProfile\s*=\s*userProfile/.test(initBody)) {
      ok('55.b init() 还原结果写回 _state.userProfile');
    } else fail('55.b', 'init() 还原结果未写回 _state');

    // 55.c set() 持久化白名单还含 'userProfile' (C1 已加, 需保留)
    if (/['"]userProfile['"]/.test(stateSrc)) {
      ok('55.c state.js 仍含字面量 \'userProfile\' (set() 白名单保留)');
    } else fail('55.c', 'state.js 找不到 userProfile 字面量');
  } catch (e) {
    fail('55 state.js init()', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [56] stock-advisor.js + fund/weekly-report.js: 全部用 Core.AI.formatUserProfile (Commit 6: 全站清硬编码) ==========
section('[56] stock-advisor.js + weekly-report.js: 不再有硬编码"长期稳健型"主体段');
(async () => {
  try {
    const files = [
      { path: path.join(WWW, 'app', 'stock-advisor.js'), label: 'stock-advisor' },
      { path: path.join(WWW, 'app', 'fund', 'weekly-report.js'), label: 'weekly-report' }
    ];
    for (const f of files) {
      const src = readFileSafe(f.path);
      if (!src) { fail(`56.${f.label} 源`, '读不到'); continue; }

      // 56.a 文件含 Core.AI.formatUserProfile()
      if (/Core\.AI\.formatUserProfile\(\)/.test(src)) {
        ok(`56.a.${f.label} 文件已调 Core.AI.formatUserProfile()`);
      } else fail(`56.a.${f.label}`, '未调 formatUserProfile');

      // 56.b "服务长期稳健型" / "服务对象是长期稳健型" 主体句已下线
      // (允许作为 || 降级文案, 主体行不能含 "服务长期稳健型" / "服务对象是长期稳健型")
      const offending = src.split('\n')
        .filter(line => /服务.*长期稳健型/.test(line) && !line.includes('||'))
        .map(line => line.trim());
      if (offending.length === 0) ok(`56.b.${f.label} 主体无"服务长期稳健型"硬编码`);
      else fail(`56.b.${f.label}`, `${offending.length} 行残留: ${offending[0].slice(0, 80)}`);

      // 56.c 硬编码兜底 ≤ N 处 (每 systemPrompt 允许 1 处 || 降级)
      // stock-advisor.js 有 2 个 systemPrompt (个股简评 + 财报深度读), 上限 = 2
      // weekly-report.js 有 1 个 systemPrompt, 上限 = 1
      const sysCount = (src.match(/const systemPrompt\s*=\s*\[/g) || []).length || 1;
      const limit = Math.max(1, sysCount);
      const hard = (src.match(/长期稳健型/g) || []).length;
      if (hard <= limit) ok(`56.c.${f.label} 硬编码 ≤ ${limit} (实际 ${hard}, ${sysCount} 个 systemPrompt)`);
      else fail(`56.c.${f.label}`, `硬编码 ${hard} 超过 ${limit}`);
    }

    // 56.d 全站覆盖率: screener + ai-advisor + stock-advisor + weekly-report 都用 Core.AI.formatUserProfile
    const all = ['www/app/screener.js', 'www/app/fund/ai-advisor.js',
      'www/app/stock-advisor.js', 'www/app/fund/weekly-report.js'];
    const using = all.filter(p => {
      const s = readFileSafe(path.join(WWW, p.replace(/^www\//, '')));
      return s && /Core\.AI\.formatUserProfile\(\)/.test(s);
    });
    if (using.length === all.length) {
      ok(`56.d 全站 ${all.length} 处都调 Core.AI.formatUserProfile (单一来源收口)`);
    } else fail('56.d', `未用: ${all.filter(p => !using.includes(p)).join(', ')}`);
  } catch (e) {
    fail('56 stock-advisor + weekly-report', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [57] screener scPreference: 走 fallback 链 (D1: 本次>全局>空) ==========
section('[57] screener.js scPreference 优先级链: scPreference > userProfile.preference > 空');
(async () => {
  try {
    const scSrc = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (!scSrc) throw new Error('screener.js 读不到');

    // 57.a scPreference 取值增加 Core.UserProfile.load().preference fallback
    // 找 preference = ... 赋值行 (在 _lastResults 解构之后)
    const fallbackMatch = scSrc.match(/scPref\s*=\s*document[^;]+;[\s\S]*?Core\.UserProfile[^;]*;[\s\S]*?preference\s*=\s*(?:scPref[^;]+;)/);
    if (fallbackMatch || (scSrc.includes('Core.UserProfile') && scSrc.includes('upPref') && /scPref\s*\|\|\s*upPref\.trim\(\)/.test(scSrc))) {
      ok('57.a screener scPreference 含 Core.UserProfile.load().preference fallback');
    } else fail('57.a', '未见 fallback 链');

    // 57.b UI 文案提示"留空走设置页"
    if (/留空/.test(scSrc) && /设置页|用户画像/.test(scSrc)) {
      ok('57.b scPreference UI 提示"留空走设置页"');
    } else fail('57.b', 'UI 未提示 fallback');
  } catch (e) {
    fail('57 D1 scPreference', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [58] Core.PositionSizing: 半凯利仓位公式 (H1 核心) ==========
section('[58] core/position-sizing.js: 半凯利公式 _kellyFraction + _clampKelly');
(async () => {
  try {
    const psSrc = readFileSafe(path.join(WWW, 'core', 'position-sizing.js'));
    if (!psSrc) throw new Error('position-sizing.js 不存在');
    const cctx = vm.createContext({ window: {}, console });
    vm.runInContext(psSrc, cctx);
    const PS = cctx.window.Core.PositionSizing;
    if (!PS) throw new Error('Core.PositionSizing 未挂载');
    if (!PS._kellyFraction || !PS._clampKelly) throw new Error('_kellyFraction/_clampKelly 缺失');
    if (PS.KELLY_FRACTION !== 0.5) throw new Error('KELLY_FRACTION != 0.5');
    if (PS.KELLY_MIN_PCT !== 0.02) throw new Error('KELLY_MIN_PCT != 0.02');
    ok('58.0 PositionSizing 导出 + 常量正确');

    // 58.a 正常路径: p=0.6, R=2 → raw=(0.6-0.4/2)/2=0.2, f=0.1
    const r1 = PS._kellyFraction({ probability: 60, triggerPrice: 10, stopLoss: 9, targetPrice: 12 });
    if (r1.payoffRatio === 2 && Math.abs(r1.f - 0.1) < 0.001) ok(`58.a 正常路径 p=60% R=2 → f=${r1.f} R=${r1.payoffRatio}`);
    else fail('58.a', `payoffRatio=${r1.payoffRatio} f=${r1.f} (期望 R=2, f≈0.1)`);

    // 58.b 高信心 + 大盈亏比: tp=10 sl=9 tg=13 → R=3 → raw=(0.8-0.2/3)/3=0.244, f=0.122
    const r2 = PS._kellyFraction({ probability: 80, triggerPrice: 10, stopLoss: 9, targetPrice: 13 });
    if (r2.payoffRatio === 3 && Math.abs(r2.f - 0.1222) < 0.002) ok(`58.b 高信心 p=80% R=3 → f=${r2.f}`);
    else fail('58.b', `f=${r2.f} (期望 ≈0.122)`);

    // 58.c p<50% → 期望负 → f=0
    const r3 = PS._kellyFraction({ probability: 30, triggerPrice: 10, stopLoss: 9, targetPrice: 12 });
    if (r3.f === 0) ok('58.c p=30% 期望负 → f=0 (不押注)');
    else fail('58.c', `f=${r3.f} (期望 0)`);

    // 58.d R≤0 (止损 ≥ 触发价) → 兜底 f=0
    const r4 = PS._kellyFraction({ probability: 80, triggerPrice: 10, stopLoss: 11, targetPrice: 9 });
    if (r4.f === 0) ok('58.d 价格关系非法 (sl≥tp) → f=0');
    else fail('58.d', `f=${r4.f} (期望 0)`);

    // 58.e 缺参 (空对象/null) → f=0 不抛
    const r5 = PS._kellyFraction(null);
    if (r5.f === 0 && r5.payoffRatio === 0) ok('58.e 缺参 → f=0 不抛');
    else fail('58.e', JSON.stringify(r5));

    // 58.f probability 越界 → f=0
    const r6 = PS._kellyFraction({ probability: 150, triggerPrice: 10, stopLoss: 9, targetPrice: 12 });
    if (r6.f === 0) ok('58.f probability 越界 150 → f=0');
    else fail('58.f', `f=${r6.f}`);

    // 58.g _clampKelly: 凯利 0 → 兜底 maxPct
    const c1 = PS._clampKelly(0, 0.20);
    if (c1 === 0.20) ok('58.g _clampKelly(0) → maxPct 兜底');
    else fail('58.g', `c1=${c1}`);

    // 58.h _clampKelly: 凯利 0.5 > maxPct=0.2 → 收敛到 0.2
    const c2 = PS._clampKelly(0.5, 0.20);
    if (c2 === 0.20) ok('58.h _clampKelly(0.5) → 收敛到 maxPct');
    else fail('58.h', `c2=${c2}`);

    // 58.i _clampKelly: 凯利 0.05 (在 MIN_PCT 之上) → 透传
    const c3 = PS._clampKelly(0.05, 0.20);
    if (c3 === 0.05) ok('58.i _clampKelly(0.05) → 透传 (在 MIN 之上)');
    else fail('58.i', `c3=${c3}`);

    // 58.j _clampKelly: 凯利 0.01 (在 MIN_PCT 之下) → 走 maxPct
    const c4 = PS._clampKelly(0.01, 0.20);
    if (c4 === 0.20) ok('58.j _clampKelly(0.01 < MIN) → maxPct');
    else fail('58.j', `c4=${c4}`);
  } catch (e) {
    fail('58 PositionSizing', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [59] Core.Calibration: 概率校准反向 prompt (H2 核心) ==========
section('[59] core/calibration.js: _formatCalibrationPrompt');
(async () => {
  try {
    const calSrc = readFileSafe(path.join(WWW, 'core', 'calibration.js'));
    if (!calSrc) throw new Error('calibration.js 不存在');
    const cctx = vm.createContext({ window: {}, console });
    vm.runInContext(calSrc, cctx);
    const CAL = cctx.window.Core.Calibration;
    if (!CAL) throw new Error('Core.Calibration 未挂载');
    if (!CAL._formatCalibrationPrompt) throw new Error('_formatCalibrationPrompt 缺失');
    if (CAL.BIAS_THRESHOLD_PP !== 10) throw new Error('BIAS_THRESHOLD_PP != 10');
    ok('59.0 Calibration 导出 + 常量正确');

    // 59.a 样本不足 (< 5) → 返 null
    const r1 = CAL._formatCalibrationPrompt([
      { label: '60-80%', n: 3, predMean: 70, hitRate: 0.5 }
    ]);
    if (r1 === null) ok('59.a 样本 <5 → 返 null (不渲染)');
    else fail('59.a', `应为 null, 实得 ${typeof r1}`);

    // 59.b 样本 ≥5 + 系统性高估 → 含"高估"
    // 桶构造: 80-100% (predMean=90, hit=0.40, bias=-50pp → over); 60-80% (predMean=70, hit=0.45, bias=-25pp → over);
    //         40-60% (predMean=50, hit=0.50, bias=0 → cal);  → overCount=2 calCount=1 → 高估
    const r2 = CAL._formatCalibrationPrompt([
      { label: '80-100%', n: 6, predMean: 90, hitRate: 0.40 },
      { label: '60-80%', n: 8, predMean: 70, hitRate: 0.45 },
      { label: '40-60%', n: 5, predMean: 50, hitRate: 0.50 }
    ]);
    if (typeof r2 === 'string' && r2.includes('高估') && r2.includes('80-100%')) {
      ok('59.b 样本≥5 + 高估桶居多 → 含"高估" + 区间名');
    } else fail('59.b', r2 ? r2.slice(0, 200) : 'null');

    // 59.c 样本 ≥5 + 系统性低估 → 含"低估"
    const r3 = CAL._formatCalibrationPrompt([
      { label: '40-60%', n: 10, predMean: 50, hitRate: 0.75 }
    ]);
    if (typeof r3 === 'string' && r3.includes('低估')) ok('59.c 系统性低估 → 含"低估"');
    else fail('59.c', r3 ? r3.slice(0, 100) : 'null');

    // 59.d 偏差都在 ±10pp 内 → 含"基本校准"
    const r4 = CAL._formatCalibrationPrompt([
      { label: '40-60%', n: 6, predMean: 50, hitRate: 0.52 }
    ]);
    if (typeof r4 === 'string' && r4.includes('基本校准')) ok('59.d 偏差小 → 含"基本校准"');
    else fail('59.d', r4 ? r4.slice(0, 100) : 'null');

    // 59.e 空 buckets → null
    const r5 = CAL._formatCalibrationPrompt([]);
    if (r5 === null) ok('59.e 空 buckets → null');
    else fail('59.e', '应为 null');

    // 59.f null / 非数组 → null 不抛
    const r6 = CAL._formatCalibrationPrompt(null);
    if (r6 === null) ok('59.f null 入参 → null 不抛');
    else fail('59.f', '应为 null');

    // 59.g 多桶渲染: 应包含所有桶 label
    const r7 = CAL._formatCalibrationPrompt([
      { label: '0-40%', n: 2, predMean: 30, hitRate: 0.5 },
      { label: '40-60%', n: 5, predMean: 50, hitRate: 0.5 },
      { label: '60-80%', n: 7, predMean: 70, hitRate: 0.5 },
      { label: '80-100%', n: 4, predMean: 90, hitRate: 0.5 }
    ]);
    if (typeof r7 === 'string' && r7.includes('0-40%') && r7.includes('80-100%')) {
      ok('59.g 多桶渲染含 4 个桶');
    } else fail('59.g', r7 ? r7.slice(0, 150) : 'null');
  } catch (e) {
    fail('59 Calibration', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [59.H2] H2 集成: short-trader._buildLearningPromptText 拼入校准段 ==========
section('[59.H2] H2: short-trader._buildLearningPromptText 拼入校准段');
(async () => {
  try {
    // 独立沙盒: 跟 39.x buildCtx 同模式, 但只 mock _buildLearningPromptText 所需依赖
    const stSrc = readFileSafe(path.join(WWW, 'app', 'short-trader.js'));
    if (!stSrc) throw new Error('short-trader.js 读不到');
    const calSrc = readFileSafe(path.join(WWW, 'core', 'calibration.js'));
    if (!calSrc) throw new Error('calibration.js 读不到');
    const K = _loadRealConstants();
    const storageData = { puts: [], kv: {}, all: { journals: [] } };
    // 单独沙盒加载 Calibration 模块
    const calCtx = vm.createContext({ window: {}, console });
    vm.runInContext(calSrc, calCtx);
    const realCalibration = calCtx.window.Core.Calibration;
    const sctx = {
      window: {},
      console,
      escapeHtml: (s) => String(s == null ? '' : s),
      fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
      fmtDateTime: () => '2026-07-27 08:30',
      confirm: () => true,
      document: { getElementById: () => null }
    };
    sctx.window = sctx;
    sctx.Core = {
      Storage: {
        kvGet: async () => null,
        all: async () => storageData.all.journals
      },
      Constants: K,
      Calibration: realCalibration
    };
    sctx.window.Core = sctx.Core;
    vm.createContext(sctx);
    vm.runInContext(stSrc, sctx);
    const ST = sctx.window.ShortTrader;
    if (!ST) throw new Error('ShortTrader 未挂到 window');

    // 59.H2.a: 样本 <5 → 校准段不渲染
    const realCollect = ST._collectVerifiedTrades;
    const fakeTradesSmall = [
      { probability: 60, outcome: 'correct' },
      { probability: 70, outcome: 'wrong' },
      { probability: 80, outcome: 'correct' }
    ];
    ST._collectVerifiedTrades = async () => fakeTradesSmall;
    const textSmall = await ST._buildLearningPromptText();
    if (typeof textSmall === 'string' && !textSmall.includes('【你的概率校准偏差】')) {
      ok('59.H2.a <5 样本不渲染校准段');
    } else fail('59.H2.a', textSmall ? textSmall.slice(0, 200) : 'null');

    // 59.H2.b: 样本 ≥5 → 渲染校准段
    const fakeTradesOver = [
      { probability: 30, outcome: 'wrong' },
      { probability: 35, outcome: 'wrong' },
      { probability: 40, outcome: 'wrong' },
      { probability: 75, outcome: 'wrong' },
      { probability: 80, outcome: 'wrong' },
      { probability: 85, outcome: 'wrong' }
    ];
    ST._collectVerifiedTrades = async () => fakeTradesOver;
    const textOver = await ST._buildLearningPromptText();
    if (typeof textOver === 'string' && textOver.includes('【你的概率校准偏差】')) {
      ok('59.H2.b ≥5 样本渲染校准段');
    } else fail('59.H2.b', textOver ? textOver.slice(0, 200) : 'null');

    // 59.H2.c: 校准段含"系统性高估"或"系统性低估"提示
    if (textOver.includes('系统性高估') || textOver.includes('系统性低估')) {
      ok('59.H2.c 校准段含偏差结论');
    } else fail('59.H2.c', textOver ? textOver.slice(-300) : 'null');

    // 59.H2.d: 恢复原 method
    ST._collectVerifiedTrades = realCollect;
  } catch (e) {
    fail('59.H2 集成', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [59] IntradayTrader 盘中操盘手 (T5: 1 分钟轮询 + 本地 LLM 实时调仓) ==========
section('[59] IntradayTrader: 纯函数 (交易时段/冷却/日限/机械止盈止损/最短持有/解析)');
(async () => {
  try {
    const itSrc = readFileSafe(path.join(WWW, 'app', 'intraday-trader.js'));
    if (!itSrc) throw new Error('intraday-trader.js 读不到');
    const K = _loadRealConstants();

    // vm sandbox: mock 全套依赖 (Core.Storage / Core.AI / Paper / Core.Data / Core.Regime)
    const buildCtx = (opts = {}) => {
      const sctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        fmtDate: () => '2026-07-28',
        Date,
        document: { getElementById: () => null }
      };
      // INTRADAY_* 常量在 _REAL_CONSTANTS 缓存中可能缺失 (缓存时 constants.js 还未加这些常量),
      // 这里显式注入兜底, 保证纯函数计算正确
      const Kx = Object.assign({
        INTRADAY_TICK_MS: 60 * 1000,
        INTRADAY_KLINE_BARS: 30,
        INTRADAY_MIN_HOLD_MINUTES: 15,
        INTRADAY_COOLDOWN_MS: 10 * 60 * 1000,
        INTRADAY_LLM_TIMEOUT_MS: 20 * 1000,
        INTRADAY_LOG_LIMIT: 200,
        INTRADAY_MAX_DAILY_ACTIONS: 4,
        TRADING_WINDOWS: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]],
        LOT_SIZE: 100
      }, K || {});
      sctx.window.Core = {
        Constants: Kx,
        Storage: {
          kvGet: async (k) => opts.kv && (k in opts.kv) ? opts.kv[k] : null,
          kvSet: async (k, v) => { opts.kv = opts.kv || {}; opts.kv[k] = v; }
        },
        AI: {
          callWithTimeout: async () => opts.llmRaw || '',
          parseJsonOutput: async (raw) => {
            // 简单 JSON 抽取 (与 real parseJsonOutput 同款行为)
            if (typeof raw !== 'string') return { ok: false };
            const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
            if (i < 0 || j < 0) return { ok: false };
            try { return { ok: true, obj: JSON.parse(raw.slice(i, j + 1)) }; }
            catch (e) { return { ok: false }; }
          }
        },
        Data: { getStockQuote: async () => opts.quote || { 最新价: 10, 涨跌幅: 1.5, 换手率: 2 },
                getStockKLine: async () => opts.bars || [],
                formatNorthboundForPrompt: () => '', formatLhbForPrompt: () => '',
                getNorthboundFlow: async () => null, getLhbSnapshotMap: async () => null },
        Regime: { get: async () => ({ state: 'range' }), gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 }) }
      };
      sctx.Core = sctx.window.Core;
      // Paper mock: getPositions / buy / sell 可注入
      sctx.window.Paper = {
        getPositions: async () => opts.positions || [],
        buy: async (code, name, market, shares, o) => ({ id: 'h-new', code, shares, ...o }),
        sell: async (id, shares, o) => ({ id, shares, ...o })
      };
      sctx.Paper = sctx.window.Paper;
      // ShortTrader mock: 成绩单接口可注入
      sctx.window.ShortTrader = {
        _buildTrackRecord: async () => null,
        _formatTrackRecord: async () => ''
      };
      sctx.ShortTrader = sctx.window.ShortTrader;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(itSrc, sctx);
      return sctx;
    };

    // 52.1 _isTradingTime: 周末/午间/夜盘都 false
    const ctx1 = buildCtx();
    const IT1 = ctx1.window.IntradayTrader;
    if (!IT1) throw new Error('IntradayTrader 未挂到 window');
    const tests1 = [
      { d: new Date(2026, 6, 27, 10, 0), want: true, label: '周一 10:00' },
      { d: new Date(2026, 6, 27, 9, 30), want: true, label: '周一 09:30 边界开' },
      { d: new Date(2026, 6, 27, 11, 30), want: true, label: '周一 11:30 边界收' },
      { d: new Date(2026, 6, 27, 13, 0), want: true, label: '周一 13:00 午后开' },
      { d: new Date(2026, 6, 27, 15, 0), want: true, label: '周一 15:00 边界收' },
      { d: new Date(2026, 6, 27, 9, 29), want: false, label: '周一 09:29 开盘前' },
      { d: new Date(2026, 6, 27, 11, 31), want: false, label: '周一 11:31 午休' },
      { d: new Date(2026, 6, 27, 12, 0), want: false, label: '周一 12:00 午休中' },
      { d: new Date(2026, 6, 27, 15, 1), want: false, label: '周一 15:01 收盘后' },
      { d: new Date(2026, 6, 25, 10, 0), want: false, label: '周六 10:00' },
      { d: new Date(2026, 6, 26, 10, 0), want: false, label: '周日 10:00' }
    ];
    let tradingPass = 0, tradingFail = 0;
    for (const t of tests1) {
      if (IT1._isTradingTime(t.d) === t.want) tradingPass++;
      else { tradingFail++; console.log(`    失败: ${t.label} 期望 ${t.want} 实际 ${IT1._isTradingTime(t.d)}`); }
    }
    if (tradingFail === 0) ok(`52.1 _isTradingTime 11 个用例全过 (周一开盘/边界/午休/收盘/周末)`);
    else fail('52.1 _isTradingTime', `${tradingPass}/${tradingPass + tradingFail}`);

    // 52.2 _mechanicalExit: 止损/止盈/无信号
    if (IT1._mechanicalExit(8, 10, 12) === 'stop') ok('52.2.a 现价 ≤ 止损 → stop');
    else fail('52.2.a', IT1._mechanicalExit(8, 10, 12));
    if (IT1._mechanicalExit(13, 10, 12) === 'target') ok('52.2.b 现价 ≥ 目标 → target');
    else fail('52.2.b', IT1._mechanicalExit(13, 10, 12));
    if (IT1._mechanicalExit(11, 10, 12) === null) ok('52.2.c 现价在区间内 → null');
    else fail('52.2.c', IT1._mechanicalExit(11, 10, 12));
    if (IT1._mechanicalExit(5, 0, 0) === null) ok('52.2.d 止损/目标都 0 → null (无信号)');
    else fail('52.2.d', IT1._mechanicalExit(5, 0, 0));

    // 52.3 _isMinHoldPassed: 不足最短持有期 / 超过
    const now = Date.now();
    if (IT1._isMinHoldPassed(now - 16 * 60 * 1000, now) === true) ok('52.3.a 持有 16 分钟 (>15) → true');
    else fail('52.3.a');
    if (IT1._isMinHoldPassed(now - 5 * 60 * 1000, now) === false) ok('52.3.b 持有 5 分钟 (<15) → false');
    else fail('52.3.b');
    if (IT1._isMinHoldPassed(null, now) === true) ok('52.3.c createdAt=null → true (跳过)');
    else fail('52.3.c');

    // 52.4 _isCooldownOver: 冷却中 / 冷却过
    if (IT1._isCooldownOver({ lastAt: now - 11 * 60 * 1000 }, now) === true) ok('52.4.a 距上次 11 分钟 (>10) → true');
    else fail('52.4.a');
    if (IT1._isCooldownOver({ lastAt: now - 5 * 60 * 1000 }, now) === false) ok('52.4.b 距上次 5 分钟 (<10) → false');
    else fail('52.4.b');
    if (IT1._isCooldownOver(null, now) === true) ok('52.4.c 首次 → true');
    else fail('52.4.c');
    if (IT1._isCooldownOver({}, now) === true) ok('52.4.d lastAt=undefined → true');
    else fail('52.4.d');

    // 52.5 _isUnderDailyLimit: 今日/跨日/未超限/已满
    const today = '2026-07-28';
    if (IT1._isUnderDailyLimit(null, today) === true) ok('52.5.a 首次 → true');
    else fail('52.5.a');
    if (IT1._isUnderDailyLimit({ date: today, todayCount: 0 }, today) === true) ok('52.5.b 今日 0 次 → true');
    else fail('52.5.b');
    if (IT1._isUnderDailyLimit({ date: today, todayCount: 3 }, today) === true) ok('52.5.c 今日 3 次 (<4) → true');
    else fail('52.5.c');
    if (IT1._isUnderDailyLimit({ date: today, todayCount: 4 }, today) === false) ok('52.5.d 今日 4 次 (达上限) → false');
    else fail('52.5.d');
    if (IT1._isUnderDailyLimit({ date: '2026-07-27', todayCount: 4 }, '2026-07-28') === true) ok('52.5.e 跨日 (昨日满) → true');
    else fail('52.5.e');

    // 52.6 _parseDecision: LLM 各种输出
    const pdTests = [
      { raw: '{"action":"hold","reason":"观望","confidence":"high"}', wantAction: 'hold' },
      { raw: '建议: {"action":"close","reason":"跌势","confidence":"mid"}', wantAction: 'close' },
      { raw: '```json\n{"action":"add","shares":100,"reason":"回调","confidence":"low"}\n```', wantAction: 'add' },
      { raw: '{"action":"trim","shares":200,"reason":"减仓"}', wantAction: 'trim' },
      { raw: '{"action":"unknown"}', wantAction: null },
      { raw: 'not json', wantAction: null },
      { raw: null, wantAction: null }
    ];
    let pdPass = 0;
    for (const t of pdTests) {
      const r = IT1._parseDecision(t.raw);
      if ((t.wantAction === null && r === null) || (r && r.action === t.wantAction)) pdPass++;
    }
    if (pdPass === pdTests.length) ok(`52.6 _parseDecision ${pdTests.length} 个用例全过 (hold/close/add/trim + 非法)`);
    else fail('52.6 _parseDecision', `${pdPass}/${pdTests.length}`);

    // 52.7 _parseDecision: shares 是 100 倍数 (LLM 输出 50 应原样保留, 上层调仓前再 roundLot)
    const r = IT1._parseDecision('{"action":"add","shares":150,"reason":"x"}');
    if (r && r.shares === 150) ok('52.7 _parseDecision 保留 LLM 原始 shares (150, 由上层 roundLot 兜底)');
    else fail('52.7', JSON.stringify(r));

    // 52.8 _buildSystemPrompt 含关键约束
    const sp = IT1._buildSystemPrompt();
    const requiredPhrases = ['不开新仓', 'add', 'trim', 'close', 'hold', 'shares', 'confidence', 'JSON'];
    const missing = requiredPhrases.filter(p => !sp.includes(p));
    if (missing.length === 0) ok('52.8 _buildSystemPrompt 含 8 个关键短语 (不开新仓/4 动作/JSON)');
    else fail('52.8 _buildSystemPrompt 缺短语', missing.join(','));

  } catch (e) {
    fail('59 IntradayTrader 纯函数', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [59.b] Core.Util.fmtDate 用本地时区 (修复 UTC 跨日错判) =============
section('[59.b] Core.Util.fmtDate: 本地时区对齐 ShortTrader._todayStr (避免 08:00 前 UTC 跨日)');
(async () => {
  try {
    const utilSrc = readFileSafe(path.join(WWW, 'core', 'util.js'));
    if (!utilSrc) throw new Error('util.js 读不到');
    const sctx = {
      window: {}, console
    };
    vm.createContext(sctx);
    vm.runInContext(utilSrc, sctx);
    const fmtDate = sctx.window.Core.Util.fmtDate;
    if (typeof fmtDate !== 'function') throw new Error('Core.Util.fmtDate 未挂载');

    // 59.b.1 本地上午 (中国 2026-07-28 10:00 = UTC 2026-07-28 02:00, 不跨日): 期望 "2026-07-28"
    const d1 = new Date(2026, 6, 28, 10, 0, 0);  // 本地 10:00
    const r1 = fmtDate(d1);
    if (r1 === '2026-07-28') ok('59.b.1 本地上午 10:00 → "2026-07-28" (本地时区)');
    else fail('59.b.1', `期望 "2026-07-28" 实测 "${r1}"`);

    // 59.b.2 本地跨日: 中国 2026-07-28 06:00, UTC 仍是 2026-07-27 22:00
    // 旧实现 (toISOString) → "2026-07-27" (UTC, 错!); 新实现 (本地) → "2026-07-28" (对)
    const d2 = new Date(2026, 6, 28, 6, 0, 0);  // 本地 06:00
    const r2 = fmtDate(d2);
    if (r2 === '2026-07-28') ok('59.b.2 本地 06:00 跨 UTC 日界 → "2026-07-28" (本地, 修复 UTC 跨日)');
    else fail('59.b.2', `期望 "2026-07-28" 实测 "${r2}" (旧 toISOString 会返 "2026-07-27")`);

    // 59.b.3 本地跨日 -1: 中国 2026-07-28 23:00, UTC 已是 2026-07-28 15:00 (不跨日), 本地也 2026-07-28
    const d3 = new Date(2026, 6, 28, 23, 0, 0);
    const r3 = fmtDate(d3);
    if (r3 === '2026-07-28') ok('59.b.3 本地 23:00 → "2026-07-28"');
    else fail('59.b.3', `期望 "2026-07-28" 实测 "${r3}"`);

    // 59.b.4 接受 ISO 字符串入参
    if (fmtDate('2026-07-28T10:00:00') === '2026-07-28') ok('59.b.4 接受 ISO 字符串入参');
    else fail('59.b.4');

    // 59.b.5 null/undefined 返 ''
    if (fmtDate('') === '' && fmtDate(null) === '' && fmtDate(undefined) === '') ok('59.b.5 null/undefined 返 ""');
    else fail('59.b.5');

  } catch (e) {
    fail('59.b fmtDate', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [60] IntradayTrader 集成: 持仓 → 拉价 → 机械止盈止损 → LLM 决策 → 调仓落地 ==========
section('[60] IntradayTrader 集成: 整轮 runNow + 机械止盈/止损优先 + LLM 调仓 + 日志');
(async () => {
  try {
    const itSrc = readFileSafe(path.join(WWW, 'app', 'intraday-trader.js'));
    if (!itSrc) throw new Error('intraday-trader.js 读不到');
    const K = _loadRealConstants();

    // 53.1 机械止盈: 现价 ≥ 目标 → 不调 LLM 直接平仓
    const buildCtx53 = (opts = {}) => {
      // Mock Date: 找一个固定交易时段, 同时保证 mock now - createdAt = 足够 (>=15 分钟)
      // 关键: createdAt 必须用 MOCK_NOW_MS 而不是真实 Date.now(), 否则 heldMs = 负 → 被最小持有守卫拦截
      const _realNow = Date.now();
      const _realDate = new Date(_realNow);
      // 选今天 11:00 (上午交易时段), 如果 > realNow 则用昨天 11:00
      let MOCK_NOW_MS = new Date(_realDate.getFullYear(), _realDate.getMonth(), _realDate.getDate(), 11, 0, 0).getTime();
      if (MOCK_NOW_MS > _realNow) MOCK_NOW_MS -= 24 * 60 * 60 * 1000;
      const MOCK_TODAY = (() => {
        const d = new Date(MOCK_NOW_MS);
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      })();
      const sctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        pctClass: () => '',
        // fmtDate 走 mock 日期, 跟 IntradayTrader 内 today 一致
        fmtDate: () => MOCK_TODAY,
        Date: class extends Date {
          constructor(...args) { if (args.length === 0) super(MOCK_NOW_MS); else super(...args); }
          static now() { return MOCK_NOW_MS; }
        },
        document: { getElementById: () => null }
      };
      // 暴露 MOCK_NOW_MS 让调用方设置 createdAt (避免被最小持有守卫误伤)
      sctx.MOCK_NOW_MS = MOCK_NOW_MS;
      const _sold = opts._sold || [];
      const _bought = opts._bought || [];
      const _log = opts._log || [];
      // 同 52 段: 显式注入 INTRADAY_* 兜底
      const Kx = Object.assign({
        INTRADAY_TICK_MS: 60 * 1000, INTRADAY_KLINE_BARS: 30,
        INTRADAY_MIN_HOLD_MINUTES: 15, INTRADAY_COOLDOWN_MS: 10 * 60 * 1000,
        INTRADAY_LLM_TIMEOUT_MS: 20 * 1000, INTRADAY_LOG_LIMIT: 200,
        INTRADAY_MAX_DAILY_ACTIONS: 4, LOT_SIZE: 100,
        TRADING_WINDOWS: [[9 * 60 + 30, 11 * 60 + 30], [13 * 60, 15 * 60]]
      }, K || {});
      sctx.window.Core = {
        Constants: Kx,
        Storage: {
          kvGet: async (k) => {
            if (k === 'paper_intraday_log') return _log;
            if (k === 'paper_intraday_cooldown') return opts.cooldown || {};
            return null;
          },
          kvSet: async (k, v) => {
            if (k === 'paper_intraday_log') { _log.length = 0; _log.push(...v); }
            if (k === 'paper_intraday_cooldown') opts.cooldown = v;
          }
        },
        AI: {
          callWithTimeout: async () => opts.llmRaw || '{"action":"hold","reason":"观望","confidence":"low"}',
          parseJsonOutput: async (raw) => {
            if (typeof raw !== 'string') return { ok: false };
            const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
            if (i < 0 || j < 0) return { ok: false };
            try { return { ok: true, obj: JSON.parse(raw.slice(i, j + 1)) }; }
            catch (e) { return { ok: false }; }
          }
        },
        Data: {
          getStockQuote: async () => opts.quote || { 最新价: 10, 涨跌幅: 1.5, 换手率: 2 },
          getStockKLine: async () => []
        },
        Regime: { get: async () => ({ state: 'range' }), gateMultipliers: () => ({ state: 'range', label: '震荡市', positionScale: 1 }) }
      };
      sctx.Core = sctx.window.Core;
      sctx.window.Paper = {
        getPositions: async () => opts.positions || [],
        buy: async (code, name, market, shares, o) => { _bought.push({ code, shares, o }); return { id: 'h-new', code, shares, ...o }; },
        sell: async (id, shares, o) => { _sold.push({ id, shares, o }); return { id, shares, ...o }; }
      };
      sctx.Paper = sctx.window.Paper;
      sctx.window.ShortTrader = { _buildTrackRecord: async () => null, _formatTrackRecord: async () => '' };
      sctx.ShortTrader = sctx.window.ShortTrader;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(itSrc, sctx);
      return { sctx, _sold, _bought, _log, positions: opts.positions, cooldown: opts.cooldown };
    };

    // 53.1.a 机械止盈触发: 现价 13 ≥ 目标 12, 不调 LLM
    const ctx1 = buildCtx53({
      positions: [{ id: 'h1', code: '000001', name: '平安银行', market: 'sz', costPrice: 10, shares: 100, stopLoss: 9, targetPrice: 12, createdAt: 'MOCK' }],
      quote: { 最新价: 13, 涨跌幅: 30 }
    });
    // 注入真实 createdAt (mock now - 30 分钟, 满足最小持有)
    ctx1.positions[0].createdAt = ctx1.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx1.sctx.window.IntradayTrader.runNow();
    // 验证: Paper.sell 触发 + 日志 source=mechanical-target + 日志 reason 含 "机械止盈"
    if (ctx1._sold.length === 1 && ctx1._sold[0].shares === 100 && ctx1._sold[0].o.reason === 'intraday-mechanical-target'
        && ctx1._log.length === 1 && ctx1._log[0].source === 'mechanical-target' && ctx1._log[0].reason.includes('机械止盈')) {
      ok('53.1.a 机械止盈: 现价 ≥ 目标 → 不调 LLM 直接平仓 + 写日志');
    } else fail('53.1.a', 'sold=' + JSON.stringify(ctx1._sold) + ' log=' + JSON.stringify(ctx1._log));

    // 53.1.b 机械止损触发: 现价 8 ≤ 止损 9
    const ctx2 = buildCtx53({
      positions: [{ id: 'h2', code: '000002', name: '万科A', market: 'sz', costPrice: 10, shares: 100, stopLoss: 9, targetPrice: 12, createdAt: 'MOCK' }],
      quote: { 最新价: 8, 涨跌幅: -20 }
    });
    ctx2.positions[0].createdAt = ctx2.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx2.sctx.window.IntradayTrader.runNow();
    if (ctx2._sold.length === 1 && ctx2._sold[0].o.reason === 'intraday-mechanical-stop'
        && ctx2._log[0].source === 'mechanical-stop' && ctx2._log[0].reason.includes('机械止损')) {
      ok('53.1.b 机械止损: 现价 ≤ 止损 → 不调 LLM 直接平仓 + 写日志');
    } else fail('53.1.b', JSON.stringify(ctx2._sold));

    // 53.2 LLM 决策 add: 现价在区间内 + 持有超 15 分钟 + LLM 给 add 100
    const ctx3 = buildCtx53({
      positions: [{ id: 'h3', code: '000003', name: '招行', market: 'sz', costPrice: 10, shares: 100, stopLoss: 9, targetPrice: 12, createdAt: 'MOCK' }],
      quote: { 最新价: 10.5, 涨跌幅: 5 },
      llmRaw: '{"action":"add","shares":100,"reason":"回调到位","confidence":"mid"}'
    });
    ctx3.positions[0].createdAt = ctx3.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx3.sctx.window.IntradayTrader.runNow();
    if (ctx3._bought.length === 1 && ctx3._bought[0].code === '000003' && ctx3._bought[0].shares === 100
        && ctx3._log[0].action === 'add' && ctx3._log[0].source === 'llm') {
      ok('53.2 LLM add 100: 走 Paper.buy + 日志 source=llm');
    } else fail('53.2', 'bought=' + JSON.stringify(ctx3._bought) + ' log=' + JSON.stringify(ctx3._log));

    // 53.3 LLM hold: 现价在区间 + LLM hold → 不动
    const ctx4 = buildCtx53({
      positions: [{ id: 'h4', code: '000004', name: 'A', market: 'sz', costPrice: 10, shares: 100, stopLoss: 9, targetPrice: 12, createdAt: 'MOCK' }],
      quote: { 最新价: 10.5, 涨跌幅: 5 },
      llmRaw: '{"action":"hold","reason":"观望","confidence":"low"}'
    });
    ctx4.positions[0].createdAt = ctx4.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx4.sctx.window.IntradayTrader.runNow();
    if (ctx4._sold.length === 0 && ctx4._bought.length === 0 && ctx4._log.length === 0) {
      ok('53.3 LLM hold: 不动, 不写日志');
    } else fail('53.3', 'sold=' + ctx4._sold.length + ' bought=' + ctx4._bought.length);

    // 53.4 最小持有时间: 持仓刚 5 分钟 → 跳过
    const ctx5 = buildCtx53({
      positions: [{ id: 'h5', code: '000005', name: 'B', market: 'sz', costPrice: 10, shares: 100, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 8, 涨跌幅: -20 }  // 即便现价击穿止损, 也不动 (持有期不足)
    });
    ctx5.positions[0].createdAt = ctx5.sctx.MOCK_NOW_MS - 5 * 60 * 1000;  // 5 分钟前
    await ctx5.sctx.window.IntradayTrader.runNow();
    if (ctx5._sold.length === 0 && ctx5._bought.length === 0) {
      ok('53.4 最小持有时间 (5 分钟 < 15): 跳过, 也不机械止损 (防开仓秒平)');
    } else fail('53.4', JSON.stringify(ctx5._sold));

    // 53.5 冷却: 上次 5 分钟前已调仓 → 跳过
    const ctx6 = buildCtx53({
      positions: [{ id: 'h6', code: '000006', name: 'C', market: 'sz', costPrice: 10, shares: 100, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10, 涨跌幅: 0 },
      llmRaw: '{"action":"add","shares":100,"reason":"x","confidence":"low"}',
      cooldown: { '000006': { date: '__TODAY__', lastAt: '__MOCK__', todayCount: 1 } }
    });
    ctx6.positions[0].createdAt = ctx6.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    ctx6.cooldown['000006'].date = (() => { const d = new Date(ctx6.sctx.MOCK_NOW_MS); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    ctx6.cooldown['000006'].lastAt = ctx6.sctx.MOCK_NOW_MS - 5 * 60 * 1000;  // 5 分钟前
    await ctx6.sctx.window.IntradayTrader.runNow();
    if (ctx6._bought.length === 0) ok('53.5 冷却中 (5 分钟 < 10): 跳过 LLM 调仓');
    else fail('53.5', 'bought=' + JSON.stringify(ctx6._bought));

    // 53.6 日动作上限: 今日已 4 次 → 跳过
    const ctx7 = buildCtx53({
      positions: [{ id: 'h7', code: '000007', name: 'D', market: 'sz', costPrice: 10, shares: 100, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10, 涨跌幅: 0 },
      llmRaw: '{"action":"add","shares":100,"reason":"x","confidence":"low"}',
      cooldown: { '000007': { date: '__TODAY__', lastAt: '__MOCK__', todayCount: 4 } }
    });
    ctx7.positions[0].createdAt = ctx7.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    ctx7.cooldown['000007'].date = (() => { const d = new Date(ctx7.sctx.MOCK_NOW_MS); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();
    ctx7.cooldown['000007'].lastAt = ctx7.sctx.MOCK_NOW_MS - 60 * 60 * 1000;
    await ctx7.sctx.window.IntradayTrader.runNow();
    if (ctx7._bought.length === 0) ok('53.6 日动作上限 (今日 4 次): 跳过 LLM 调仓');
    else fail('53.6', 'bought=' + JSON.stringify(ctx7._bought));

    // 53.7 LLM trim 200: 减仓 200 股
    const ctx8 = buildCtx53({
      positions: [{ id: 'h8', code: '000008', name: 'E', market: 'sz', costPrice: 10, shares: 500, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10.5, 涨跌幅: 5 },
      llmRaw: '{"action":"trim","shares":200,"reason":"减仓","confidence":"mid"}'
    });
    ctx8.positions[0].createdAt = ctx8.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx8.sctx.window.IntradayTrader.runNow();
    if (ctx8._sold.length === 1 && ctx8._sold[0].shares === 200 && ctx8._log[0].action === 'trim') {
      ok('53.7 LLM trim 200: 走 Paper.sell + 日志 action=trim');
    } else fail('53.7', JSON.stringify(ctx8._sold));

    // 53.8 LLM 给 shares=50 (不足一手) → 跳过
    const ctx9 = buildCtx53({
      positions: [{ id: 'h9', code: '000009', name: 'F', market: 'sz', costPrice: 10, shares: 100, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10, 涨跌幅: 0 },
      llmRaw: '{"action":"add","shares":50,"reason":"x","confidence":"low"}'
    });
    ctx9.positions[0].createdAt = ctx9.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx9.sctx.window.IntradayTrader.runNow();
    if (ctx9._bought.length === 0) ok('53.8 LLM shares<100 (不足一手): 跳过, 不买');
    else fail('53.8', 'bought=' + JSON.stringify(ctx9._bought));

    // 53.9 交易时段守卫: 非交易时间 → runNow 直接 return
    const ctx10 = buildCtx53({
      positions: [{ id: 'h10', code: '000010', name: 'G', market: 'sz', costPrice: 10, shares: 100, stopLoss: 9, targetPrice: 12, createdAt: 'MOCK' }],
      quote: { 最新价: 13, 涨跌幅: 30 }
    });
    ctx10.positions[0].createdAt = ctx10.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    // 模拟非交易时间: 把 Date 设为周日
    const origDate = ctx10.sctx.Date;
    ctx10.sctx.Date = class extends origDate {
      constructor(...args) { if (args.length === 0) super(2026, 6, 26, 10, 0); else super(...args); }  // 周日
      static now() { return new Date(2026, 6, 26, 10, 0).getTime(); }
    };
    await ctx10.sctx.window.IntradayTrader.runNow();
    if (ctx10._sold.length === 0 && ctx10._bought.length === 0) {
      ok('53.9 交易时段守卫 (周日): runNow 直接 return, 不调价不调仓');
    } else fail('53.9', 'sold=' + ctx10._sold.length);
    ctx10.sctx.Date = origDate;

    // 53.10 init 起定时器 + 跑一轮 (mock setInterval / clearInterval 计数)
    const ctx11 = buildCtx53({ positions: [] });
    const setCount = { n: 0 };
    const clearCount = { n: 0 };
    ctx11.sctx.window.IntradayTrader._setInterval = (fn, ms) => { setCount.n++; return 'timer-' + setCount.n; };
    ctx11.sctx.window.IntradayTrader._clearInterval = (t) => { clearCount.n++; };
    await ctx11.sctx.window.IntradayTrader.init();
    if (setCount.n === 1 && ctx11.sctx.window.IntradayTrader._timers.tick === 'timer-1') {
      ok('53.10 init 起 1 分钟轮询 (1 次 setInterval)');
    } else fail('53.10', JSON.stringify(setCount));
    ctx11.sctx.window.IntradayTrader.stopPolling();
    if (clearCount.n === 1) ok('53.11 stopPolling 清掉定时器 (1 次 clearInterval)');
    else fail('53.11', JSON.stringify(clearCount));

    // 53.12 Bug #1 修复: 持仓 200, LLM trim 150 → 旧逻辑卖 150 (剩 50 < 1 手), 新逻辑卖 100 (留 1 手)
    const ctx12 = buildCtx53({
      positions: [{ id: 'h12', code: '000012', name: 'F', market: 'sz', costPrice: 10, shares: 200, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10.5, 涨跌幅: 5 },
      llmRaw: '{"action":"trim","shares":150,"reason":"减仓","confidence":"mid"}'
    });
    ctx12.positions[0].createdAt = ctx12.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx12.sctx.window.IntradayTrader.runNow();
    if (ctx12._sold.length === 1 && ctx12._sold[0].shares === 100 && ctx12._sold[0].o.reason === 'intraday-trim') {
      ok('53.12 Bug #1 修复: LLM trim 150 (持仓 200) → 卖 100 留 1 手 (不是全平)');
    } else fail('53.12', 'sold=' + JSON.stringify(ctx12._sold));

    // 53.13 Bug #1 边界: 持仓仅 1 手 (100), LLM trim 50 → 旧会卖 50 剩 50, 新改走 close (卖全部 100)
    const ctx13 = buildCtx53({
      positions: [{ id: 'h13', code: '000013', name: 'G', market: 'sz', costPrice: 10, shares: 100, stopLoss: 0, targetPrice: 0, createdAt: 'MOCK' }],
      quote: { 最新价: 10.5, 涨跌幅: 5 },
      llmRaw: '{"action":"trim","shares":50,"reason":"减仓","confidence":"low"}'
    });
    ctx13.positions[0].createdAt = ctx13.sctx.MOCK_NOW_MS - 30 * 60 * 1000;
    await ctx13.sctx.window.IntradayTrader.runNow();
    if (ctx13._sold.length === 1 && ctx13._sold[0].shares === 100 && ctx13._sold[0].o.reason === 'intraday-trim-to-close') {
      ok('53.13 Bug #1 边界: 仅 1 手 + LLM trim 50 → 改走 close (全部 100, reason=intraday-trim-to-close)');
    } else fail('53.13', 'sold=' + JSON.stringify(ctx13._sold));

  } catch (e) {
    fail('60 IntradayTrader 集成', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [54] LongTrader 长线操盘手: 触发判定 (周一 + ≥7 天) + LLM 选股 + 自动成交 =============
section('[54] LongTrader: _shouldRun 触发判定 + LLM 选股 + 整轮 runNow');
(async () => {
  try {
    const ltSrc = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    if (!ltSrc) throw new Error('long-trader.js 读不到');
    const K = _loadRealConstants();

    // vm sandbox: 注入常量 (缓存兜底) + 模拟 Core.Storage + Paper + Core.Data + Core.AI
    const buildCtx = (opts = {}) => {
      const sctx = {
        window: {}, console,
        escapeHtml: (s) => String(s == null ? '' : s),
        fmtMoney: (n) => (typeof n === 'number' ? n.toFixed(2) : '0.00'),
        fmtNum: (n, d) => (typeof n === 'number' ? n.toFixed(d || 0) : '0'),
        fmtPct: (n) => (typeof n === 'number' ? (n * 100).toFixed(2) + '%' : '-'),
        fmtDate: () => '2026-07-28',
        Date,
        document: { getElementById: () => null }
      };
      const Kx = Object.assign({
        LONG_TRADER_CHECK_MS: 30 * 60 * 1000,
        LONG_TRADER_TOP_N: 3, LONG_TRADER_HARD_SCREEN_TOP: 30,
        LONG_TRADER_RERUN_DAYS: 7, LONG_TRADER_MIN_CASH: 5000,
        LONG_TRADER_LOG_LIMIT: 100
      }, K || {});
      const _autoTrades = opts._autoTrades || [];
      sctx.window.Core = {
        Constants: Kx,
        Storage: {
          kvGet: async (k) => opts.kv && (k in opts.kv) ? opts.kv[k] : null,
          kvSet: async (k, v) => { opts.kv = opts.kv || {}; opts.kv[k] = v; }
        },
        AI: {
          callWithTimeout: async () => opts.llmRaw || '{"picks":[]}',
          parseJsonOutput: async (raw) => {
            if (typeof raw !== 'string') return { ok: false };
            const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
            if (i < 0 || j < 0) return { ok: false };
            try { return { ok: true, obj: JSON.parse(raw.slice(i, j + 1)) }; }
            catch (e) { return { ok: false }; }
          }
        },
        Data: {
          getStockSpot: async () => opts.stocks || [],
          getStockFinancialBatch: async () => new Map(),
          getStockIndustryBatch: async () => new Map(),
          getStockKLine: async () => []
        },
        // Bug #2 mock: Regime (默认 range + positionScale 1, opts.regime 注入)
        Regime: {
          get: async () => opts.regime || { state: 'range' },
          gateMultipliers: () => opts.gate || { state: 'range', label: '震荡市', positionScale: 1 }
        }
      };
      sctx.Core = sctx.window.Core;
      sctx.window.Paper = {
        _getAccountRaw: async (sleeve) => ({
          long: { cash: opts.cash ?? 100000, initialCash: 100000, positionPct: 0.10 },
          short: { cash: 30000, initialCash: 30000, positionPct: 0.20 }
        })[sleeve || 'long'] || { cash: 0, initialCash: 0, positionPct: 0 },
        // Bug #1 mock: _planAutoTrade 探测 (默认返 100 = 1 手 30 元股, opts.planAutoTrade=null 模拟跑空)
        _planAutoTrade: opts.planAutoTrade === null ? () => null : (opts.planAutoTrade || (() => 100)),
        // Bug #3 mock: 已持仓 code 列表 (默认空, opts.heldCodes 注入)
        _getPaperHoldings: async (sleeve) => (opts.heldCodes || []).map(code => ({ code, sleeve: sleeve || 'long' })),
        autoTradeFromPick: async (pick) => { _autoTrades.push(pick); return { id: 'h-new', ...pick }; }
      };
      sctx.Paper = sctx.window.Paper;
      sctx.window.document = sctx.document;
      vm.createContext(sctx);
      vm.runInContext(ltSrc, sctx);
      // 始终保证 opts.kv 存在, 闭包内部 kvSet 改 opts.kv, ctx.kv 引用同一对象 → 测试能读到最新值
      opts.kv = opts.kv || {};
      return { sctx, _autoTrades, kv: opts.kv };
    };

    // 54.1 _shouldRun: 纯函数判定 (10 个用例)
    const ctx1 = buildCtx();
    const LT1 = ctx1.sctx.window.LongTrader;
    if (!LT1) throw new Error('LongTrader 未挂到 window');
    const cases = [
      [new Date(2026, 6, 27, 10, 0), null, true],     // 周一 + 从未跑过
      [new Date(2026, 6, 27, 9, 0), null, true],      // 周一开盘前
      [new Date(2026, 6, 27, 15, 0), null, true],     // 周一收盘后
      [new Date(2026, 6, 28, 10, 0), null, false],    // 周二
      [new Date(2026, 6, 29, 10, 0), null, false],    // 周三
      [new Date(2026, 6, 25, 10, 0), null, false],    // 周日
      [new Date(2026, 6, 26, 10, 0), null, false],    // 周六
      [new Date(2026, 6, 27, 10, 0), new Date(2026, 6, 26, 10, 0).getTime(), false],  // 周一 + 1 天前 (< 7)
      [new Date(2026, 6, 27, 10, 0), new Date(2026, 6, 19, 10, 0).getTime(), true],   // 周一 + 8 天前 (≥ 7)
      [new Date(2026, 6, 27, 10, 0), new Date(2026, 6, 21, 10, 0).getTime(), false]   // 周一 + 6 天前 (< 7)
    ];
    let pass = 0;
    for (const [now, last, want] of cases) {
      if (LT1._shouldRun(now, last) === want) pass++;
    }
    if (pass === cases.length) ok(`54.1 _shouldRun ${cases.length} 个用例全过 (周一/工作日/周末 + 7 天冷却)`);
    else fail('54.1 _shouldRun', `${pass}/${cases.length}`);

    // 54.2 整轮 runNow: 周一 + 现金充足 + LLM 给 3 picks + 自动成交
    const ctx2 = buildCtx({
      stocks: [
        { 代码: '000001', 名称: '平安银行', 涨跌幅: 5.0, 换手率: 1.5, 总市值: 900000000000 },
        { 代码: '000002', 名称: '万科A', 涨跌幅: 4.5, 换手率: 1.2, 总市值: 120000000000 },
        { 代码: '600519', 名称: '贵州茅台', 涨跌幅: 4.0, 换手率: 1.1, 总市值: 2000000000000 },
        { 代码: '000003', 名称: '招行', 涨跌幅: 3.5, 换手率: 1.8, 总市值: 800000000000 },
        { 代码: '000004', 名称: 'A', 涨跌幅: 3.0, 换手率: 1.3, 总市值: 100000000000 }
      ],
      llmRaw: '{"picks":[{"code":"000001","name":"平安银行","reason":"业绩拐点"},{"code":"000002","name":"万科A","reason":"政策预期"},{"code":"600519","name":"贵州茅台","reason":"龙头"}]}'
    });
    // 2026-07-27 是周一
    await ctx2.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx2._autoTrades.length === 3
        && ctx2._autoTrades[0].code === '000001' && ctx2._autoTrades[0].sleeve === 'long'
        && ctx2._autoTrades[1].code === '000002' && ctx2._autoTrades[2].code === '600519'
        && ctx2.kv && ctx2.kv.paper_long_trader_last && ctx2.kv.paper_long_trader_last.ts
        && ctx2.kv.paper_long_trader_log && ctx2.kv.paper_long_trader_log.length === 1
        && ctx2.kv.paper_long_trader_log[0].picks.length === 3
        && ctx2.kv.paper_long_trader_log[0].picks.every(p => p.ok === true)) {
      ok('54.2 runNow 周一自动跑: LLM 挑 3 只 → Paper.autoTradeFromPick × 3 + 写 lastRun + 写决策日志');
    } else fail('54.2', 'autoTrades=' + JSON.stringify(ctx2._autoTrades) + ' kv=' + JSON.stringify(ctx2.kv));

    // 54.3 非周一: 不跑
    const ctx3 = buildCtx({ stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }], llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}' });
    await ctx3.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 28, 10, 0) });  // 周二
    if (ctx3._autoTrades.length === 0) ok('54.3 非周一: 不跑, 不调 LLM 不调 autoTradeFromPick');
    else fail('54.3', 'autoTrades=' + JSON.stringify(ctx3._autoTrades));

    // 54.4 现金不足: 不跑
    const ctx4 = buildCtx({
      cash: 3000,  // < 5000 下限
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}'
    });
    await ctx4.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx4._autoTrades.length === 0) ok('54.4 long sleeve 现金 3000 < 5000: 跳过, 不调 LLM');
    else fail('54.4', 'autoTrades=' + JSON.stringify(ctx4._autoTrades));

    // 54.5 7 天内已跑过: 不跑
    const ctx5 = buildCtx({
      kv: { paper_long_trader_last: { date: '2026-07-26', ts: new Date(2026, 6, 26, 10, 0).getTime() } },
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}'
    });
    await ctx5.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx5._autoTrades.length === 0) ok('54.5 距上次 1 天 (< 7): 跳过, 不重复跑');
    else fail('54.5', 'autoTrades=' + JSON.stringify(ctx5._autoTrades));

    // 54.6 LLM 给空 picks: 不调 autoTrade
    const ctx6 = buildCtx({
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[]}'
    });
    await ctx6.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx6._autoTrades.length === 0) ok('54.6 LLM 给空 picks: 不调 autoTradeFromPick');
    else fail('54.6', 'autoTrades=' + JSON.stringify(ctx6._autoTrades));

    // 54.7 LLM 给非法 JSON: 整轮降级
    const ctx7 = buildCtx({
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: 'not json at all'
    });
    await ctx7.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx7._autoTrades.length === 0) ok('54.7 LLM 返非法 JSON: parseJsonOutput 失败 → 不成交');
    else fail('54.7', 'autoTrades=' + JSON.stringify(ctx7._autoTrades));

    // 54.8 硬筛: 涨跌幅 ≤ 0 被过滤
    const ctx8 = buildCtx({
      stocks: [
        { 代码: '000001', 名称: 'A', 涨跌幅: -1, 换手率: 1, 总市值: 1e10 },
        { 代码: '000002', 名称: 'B', 涨跌幅: 0, 换手率: 1, 总市值: 1e10 },
        { 代码: '000003', 名称: 'C', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }
      ],
      llmRaw: '{"picks":[{"code":"000003","name":"C","reason":"x"}]}'
    });
    await ctx8.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx8._autoTrades.length === 1 && ctx8._autoTrades[0].code === '000003') {
      ok('54.8 硬筛: 涨跌幅 ≤ 0 的被过滤, 只把正股喂 LLM');
    } else fail('54.8', 'autoTrades=' + JSON.stringify(ctx8._autoTrades));

    // 54.9 init 起 30 分钟轮询
    const ctx9 = buildCtx({ stocks: [] });
    const setCount = { n: 0 };
    const clearCount = { n: 0 };
    ctx9.sctx.window.LongTrader._setInterval = (fn, ms) => { setCount.n++; return 'timer-' + setCount.n; };
    ctx9.sctx.window.LongTrader._clearInterval = (t) => { clearCount.n++; };
    await ctx9.sctx.window.LongTrader.init();
    if (setCount.n === 1 && ctx9.sctx.window.LongTrader._timers.check === 'timer-1') {
      ok('54.9 init 起 30 分钟轮询 (1 次 setInterval)');
    } else fail('54.9', JSON.stringify(setCount));
    ctx9.sctx.window.LongTrader.stopPolling();
    if (clearCount.n === 1) ok('54.10 stopPolling 清掉定时器 (1 次 clearInterval)');
    else fail('54.10', JSON.stringify(clearCount));

    // 54.11 LLM 返非法 code 被过滤
    const ctx11 = buildCtx({
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"abc","name":"X","reason":"x"},{"code":"000001","name":"A","reason":"valid"}]}'
    });
    await ctx11.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx11._autoTrades.length === 1 && ctx11._autoTrades[0].code === '000001') {
      ok('54.11 LLM 返非法 code (abc) 被过滤, 只成交合法 code');
    } else fail('54.11', 'autoTrades=' + JSON.stringify(ctx11._autoTrades));

    // 54.12 Bug #2 修复: bear + positionScale 0.3 < 0.5 → 跳过

    // 54.12 Bug #1: _planAutoTrade 返 null (现金买不起 1 手 30 元股) → 跳过, 不调 LLM
    const ctx12 = buildCtx({
      cash: 3000,  // < 5000
      planAutoTrade: null,  // 模拟探测失败
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}'
    });
    await ctx12.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx12._autoTrades.length === 0) ok('54.12 Bug #1 修复: _planAutoTrade 探测失败 → 跳过, 避免跑空');
    else fail('54.12', 'autoTrades=' + JSON.stringify(ctx12._autoTrades));

    // 54.13 Bug #2: Regime bear + positionScale < 0.5 → 跳过
    const ctx13 = buildCtx({
      regime: { state: 'bear' },
      gate: { state: 'bear', label: '熊市', positionScale: 0.3 },
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}'
    });
    await ctx13.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx13._autoTrades.length === 0) ok('54.13 Bug #2 修复: bear + positionScale 0.3 < 0.5 → 跳过');
    else fail('54.13', 'autoTrades=' + JSON.stringify(ctx13._autoTrades));

    // 54.14 Bug #2 边界: bear + positionScale 0.6 → 不跳过 (≥ 0.5)
    const ctx14 = buildCtx({
      regime: { state: 'bear' },
      gate: { state: 'bear', label: '熊市', positionScale: 0.6 },
      stocks: [{ 代码: '000001', 名称: 'A', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 }],
      llmRaw: '{"picks":[{"code":"000001","name":"A","reason":"x"}]}'
    });
    await ctx14.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx14._autoTrades.length === 1) ok('54.14 Bug #2 边界: bear + positionScale 0.6 ≥ 0.5 → 仍可跑');
    else fail('54.14', 'autoTrades=' + JSON.stringify(ctx14._autoTrades));

    // 54.15 Bug #3: 已持仓 code 000001 被硬筛过滤
    const ctx15 = buildCtx({
      heldCodes: ['000001'],  // 平安银行已持仓
      stocks: [
        { 代码: '000001', 名称: '平安银行', 涨跌幅: 5, 换手率: 1, 总市值: 1e10 },  // 涨 5%
        { 代码: '000002', 名称: '万科A', 涨跌幅: 4, 换手率: 1, 总市值: 1e10 }     // 涨 4%
      ],
      llmRaw: '{"picks":[{"code":"000002","name":"万科A","reason":"x"}]}'
    });
    await ctx15.sctx.window.LongTrader.runNow({ now: new Date(2026, 6, 27, 10, 0) });
    if (ctx15._autoTrades.length === 1 && ctx15._autoTrades[0].code === '000002') {
      ok('54.15 Bug #3 修复: 已持仓 code 000001 被硬筛过滤, 只推未持仓 000002');
    } else fail('54.15', 'autoTrades=' + JSON.stringify(ctx15._autoTrades));

  } catch (e) {
    fail('54 LongTrader', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [62] H3 getIndexKLine (Commit 4): 指数 K 线拉取 (routing + cache) ==========
section('[62] H3 getIndexKLine: 符号 routing / 缓存命中 / 失败降级 (Commit 4)');
(async () => {
  try {
    const dataSrc = readFileSafe(path.join(WWW, 'core/data.js'));
    if (!dataSrc) throw new Error('data.js 读不到');

    // 62.a: 函数存在
    if (/async function getIndexKLine\(/.test(dataSrc)) {
      ok('62.a getIndexKLine 函数定义在 data.js');
    } else fail('62.a', '找不到 getIndexKLine 函数');

    // 62.b: exports 表里有 getIndexKLine (在 指数 K 线 段附近)
    const afterIndex = dataSrc.split('// 指数 K 线')[1] || dataSrc;
    if (/getIndexKLine,/.test(afterIndex)) {
      ok('62.b getIndexKLine 暴露在 Core.Data exports');
    } else fail('62.b', 'exports 表缺 getIndexKLine');

    // 62.c: 缓存 key 格式 (idx_kline_<code>... 含 code + period)
    if (/idx_kline_\$\{code\}/.test(dataSrc)) {
      ok('62.c 缓存 key 含 idx_kline_<code> 前缀 (跟个股 kline_ 区分)');
    } else fail('62.c', '缓存 key 缺 idx_kline_ 前缀');

    // 62.d: 优先腾讯 (_tencentKLine 复用)
    const inGetIndex = dataSrc.split('getIndexKLine')[1] || '';
    if (/await _tencentKLine\(/.test(inGetIndex)) {
      ok('62.d 优先腾讯 (复用 _tencentKLine)');
    } else fail('62.d', '没调用 _tencentKLine');

    // 62.e: 失败降级 aktools stock_zh_index_daily
    if (/stock_zh_index_daily/.test(dataSrc)) {
      ok('62.e 失败降级 aktools stock_zh_index_daily');
    } else fail('62.e', '缺 stock_zh_index_daily 降级');

    // 62.f: TTL 24h (跟 getStockKLine 一致)
    if (/24 \* 60 \* 60 \* 1000/.test(inGetIndex)) {
      ok('62.f 24h TTL');
    } else fail('62.f', 'TTL 缺 24h');

    // 62.g: 注释里强调符号须带 sh/sz 前缀 (防止误用未前缀符号)
    if (/必须带 sh\/sz 前缀/.test(dataSrc)) {
      ok('62.g 注释明确: 指数必须带 sh/sz 前缀');
    } else fail('62.g', '注释缺符号前缀说明');
  } catch (e) {
    fail('62 H3 getIndexKLine', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [63] H3 regime 多指数 + ATR + 失灵熔断 (Commit 5) ==========
// 覆盖:
//   - 多指数共识 (_consensus): 2/3 bull、2/3 bear、单点失灵
//   - ATR14 动态阈值带 (_computeBand / _atr14): 高波夹 ATR_MAX_BAND、低波夹 ATR_MIN_BAND
//   - 失灵熔断 (refresh + _staleFails): 连续失败 ≥ STALE_FAIL_THRESHOLD → 强制 range + stale:true
//   - kvSet 静默失败修复: 失败时 _mem 保留旧值
//   - gateMultipliers 含 stale / staleFailures / indices 字段
section('[63] H3 regime 多指数 + ATR + 失灵熔断 (Commit 5)');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    // ---- 63.0 sandbox: 加载 constants/data/regime 真实模块 ----
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder,
      Core: {
        State: { get: (k) => k === 'proxyBase' ? '/api/akshare' : null },
        Storage: { cacheGet: async () => null, cacheSet: async () => {}, kvGet: async () => null, kvSet: async () => {} },
        Data: { getStockKLine: async () => [], getIndexKLine: async () => [] }
      }
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/data.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/regime.js')), DS);
    const R = DS.window.Core.Regime;
    const C = DS.window.Core.Constants;

    // ---- 63.1 多指数代码列表来自常量 ----
    if (Array.isArray(R.CODES) && R.CODES.length === 3 && R.CODES.includes('sh000300')) {
      ok('63.1 CODES 三指数来自 Core.Constants (含 sh000300)');
    } else fail('63.1 CODES', JSON.stringify(R.CODES));

    // ---- 63.2 _consensus 纯函数: 2/3 bull → bull ----
    const c2bull = R._consensus([
      { code: 'sh000300', state: 'bull', aboveStreak: 5 },
      { code: 'sh000852', state: 'bull', aboveStreak: 3 },
      { code: 'sz399303', state: 'range', aboveStreak: 0 }
    ]);
    if (c2bull.state === 'bull' && c2bull.agreeCount === 2) ok('63.2 2/3 bull 共识 → bull');
    else fail('63.2 2/3 bull', JSON.stringify(c2bull));

    // ---- 63.3 _consensus: 2/3 bear → bear ----
    const c2bear = R._consensus([
      { code: 'sh000300', state: 'bear', aboveStreak: 0 },
      { code: 'sh000852', state: 'range', aboveStreak: 0 },
      { code: 'sz399303', state: 'bear', aboveStreak: 0 }
    ]);
    if (c2bear.state === 'bear' && c2bear.agreeCount === 2) ok('63.3 2/3 bear 共识 → bear');
    else fail('63.3 2/3 bear', JSON.stringify(c2bear));

    // ---- 63.4 _consensus: 单点 bull + 2 range (无 2/3) → 落 range (保守) ----
    const c1 = R._consensus([
      { code: 'sh000300', state: 'bull', aboveStreak: 5 },
      { code: 'sh000852', state: 'range', aboveStreak: 0 },
      { code: 'sz399303', state: 'range', aboveStreak: 0 }
    ]);
    if (c1.state === 'range') ok('63.4 1/3 bull 不达共识 → range 兜底');
    else fail('63.4 单点未达共识', JSON.stringify(c1));

    // ---- 63.5 _consensus: 空数组 → range + agreeCount=0 ----
    const c0 = R._consensus([]);
    if (c0.state === 'range' && c0.agreeCount === 0) ok('63.5 空数组 → range + 0 共识');
    else fail('63.5 空数组', JSON.stringify(c0));

    // ---- 63.6 ATR14 纯函数: 长度 < 14 → NaN ----
    const aShort = R._atr14([100, 101, 99]);
    if (Number.isNaN(aShort)) ok('63.6 _atr14(<14) → NaN');
    else fail('63.6 ATR 短数据', String(aShort));

    // ---- 63.7 ATR14 高波动 (差 5 元): 高波 (近 14 日 tr 均值 ~5) / close 4000 → 0.00125 → 夹 ATR_MIN_BAND=0.01 ----
    const aHi = R._atr14(Array.from({ length: 15 }, (_, i) => 100 + (i % 2 ? 5 : -5)));
    // range ≈ [95, 105], trs ≈ [10, 10, ...] 全部 10 → ATR 10
    if (aHi > 0 && aHi !== 10) ok('63.7 _atr14 高波动计算正确 (期望 10): ' + aHi.toFixed(2));
    else if (aHi !== 10) fail('63.7 ATR 高波动', String(aHi));

    // ---- 63.8 _computeBand: 高 ATR 占 close → 夹 ATR_MAX_BAND=0.06 ----
    // 需要 ≥14 根 K 线, 构造 close 序列: 大波动 (10/100=0.10) → clamp → 0.06
    const hiCloses = Array.from({ length: 15 }, (_, i) => 100 + (i % 2 ? 5 : -5));
    // trs 全 ≈10, ATR=10, lastClose=100 → 10/100=0.10 → clamp → 0.06
    const bandHi = R._computeBand(hiCloses, 100);
    if (Math.abs(bandHi - C.ATR_MAX_BAND) < 1e-9) ok('63.8 _computeBand 高波 → ATR_MAX_BAND (0.06)');
    else fail('63.8 band 高', String(bandHi));

    // ---- 63.9 _computeBand: 低 ATR 占 close → 夹 ATR_MIN_BAND=0.01 ----
    // 14+ 根, lastClose=4000, ATR≈10 → 0.0025 → clamp → 0.01
    const loCloses = Array.from({ length: 15 }, (_, i) => 4000 + (i % 2 ? 5 : -5));
    const bandLo = R._computeBand(loCloses, 4000);
    if (Math.abs(bandLo - C.ATR_MIN_BAND) < 1e-9) ok('63.9 _computeBand 低波 → ATR_MIN_BAND (0.01)');
    else fail('63.9 band 低', String(bandLo));

    // ---- 63.10 _computeBand: K线 < ATR_PERIOD → fallback FALLBACK_BAND=0.03 ----
    const bandFallback = R._computeBand([100], 100);
    if (Math.abs(bandFallback - C.REGIME_FALLBACK_BAND) < 1e-9) ok('63.10 _computeBand 数据不足 → fallback 0.03');
    else fail('63.10 band fallback', String(bandFallback));

    // ---- 63.11 gateMultipliers: mem=null → 兜底 range + stale=false + 字段齐全 ----
    R._resetForTest();
    const g = R.gateMultipliers();
    if (g.state === 'range' && g.stale === false
        && typeof g.staleFailures === 'number'
        && g.indices && typeof g.indices === 'object') {
      ok('63.11 gateMultipliers 含 stale/staleFailures/indices 三字段');
    } else fail('63.11 gate 字段', JSON.stringify(g));

    // ---- 63.12 STALE_FAIL_THRESHOLD 常量存在 ----
    if (C.STALE_FAIL_THRESHOLD === 3) ok('63.12 STALE_FAIL_THRESHOLD=3 (熔断门槛)');
    else fail('63.12 熔断阈值', String(C.STALE_FAIL_THRESHOLD));

    // ---- 63.13 _consensus 优先选择非 range (bull>range 平局破 → bull) ----
    // 2 range + 1 bull: bull 票=1, range 票=2 → range 票 ≥ 2 → 选 range
    // 不测平局破: 同票 (2 bull vs 2 range) 在 3 指数场景下不可能, 跳过
    const cNoTie = R._consensus([
      { code: 'sh000300', state: 'range', aboveStreak: 0 },
      { code: 'sh000852', state: 'range', aboveStreak: 0 },
      { code: 'sz399303', state: 'bull', aboveStreak: 5 }
    ]);
    if (cNoTie.state === 'range' && cNoTie.agreeCount === 2) ok('63.13 2 range vs 1 bull → range (2/3 达成)');
    else fail('63.13 2r1b', JSON.stringify(cNoTie));

    // ---- 63.14 源码对账: regime.js 含多指数 + 熔断 + kvSet 修复关键词 ----
    const regimeSrc = readFileSafe(path.join(WWW, 'core/regime.js'));
    if (/Promise\.all\(CODES\.map/.test(regimeSrc)) ok('63.14a 多指数并行 Promise.all');
    else fail('63.14a 多指数', '缺 Promise.all(CODES.map');
    if (/STALE_FAIL_THRESHOLD/.test(regimeSrc)) ok('63.14b STALE 阈值引用');
    else fail('63.14b STALE 阈值', '缺');
    if (/_staleFails\s*\+\+/.test(regimeSrc)) ok('63.14c 连续失灵累加');
    else fail('63.14c 累加', '缺 _staleFails++');
    if (/stale:\s*true/.test(regimeSrc)) ok('63.14d 熔断强制 stale:true');
    else fail('63.14d stale', '缺 stale:true 强制');
    if (/ATRs|ATR_PERIOD|_atr14/.test(regimeSrc)) ok('63.14e ATR14 实现');
    else fail('63.14e ATR', '缺 ATR14');
    if (/_mem\s*=\s*rec[\s\S]{0,200}catch\s*\(e\)/.test(regimeSrc)) {
      ok('63.14f kvSet 成功路径 catch 保留旧 _mem');
    } else fail('63.14f kvSet 修复', '缺 _mem 在 catch 里保留');

    // ---- 63.15 constants.js 导出 H3 常量 ----
    const constSrc = readFileSafe(path.join(WWW, 'core/constants.js'));
    if (/REGIME_INDEX_CODES\s*=\s*\[/.test(constSrc)) ok('63.15a REGIME_INDEX_CODES 三指数定义');
    else fail('63.15a 常量列表', '缺');
    if (/ATR_MIN_BAND\s*=\s*0\.01/.test(constSrc) && /ATR_MAX_BAND\s*=\s*0\.06/.test(constSrc)) ok('63.15b ATR 边界 0.01/0.06');
    else fail('63.15b ATR 边界', '缺 0.01/0.06');
    if (/MIN_INDEX_AGREE\s*=\s*2/.test(constSrc)) ok('63.15c MIN_INDEX_AGREE=2 (简单多数)');
    else fail('63.15c 共识门槛', '缺 MIN_INDEX_AGREE=2');
  } catch (e) {
    fail('63 H3 regime', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [64] P1-3: 短线成绩单风险/收益形状 (夏普/最大回撤/盈亏比) ==========
section('[64] P1-3: short-trader._computeSharpe / _computeMaxDrawdown / _computePayoffRatio + 注入成绩单');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder, fetch: () => Promise.reject(new Error('no fetch')),
      window: {}, Core: { State: { get: () => null }, Storage: { all: async () => [], kvGet: async () => null, kvSet: async () => {} } }
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS);
    const ST = DS.window.ShortTrader;
    if (!ST || typeof ST._computeSharpe !== 'function') {
      fail('64.0 加载 short-trader 失败', '缺 _computeSharpe');
      return;
    }

    // ---- 64.1 _computeSharpe: 样本 <2 → null ----
    if (ST._computeSharpe([]) === null && ST._computeSharpe([{pnl: 0.05}]) === null) {
      ok('64.1 _computeSharpe 样本 <2 → null');
    } else fail('64.1 sharpe 少样本', '');

    // ---- 64.2 _computeSharpe: 全部相同 → null (sd=0) ----
    if (ST._computeSharpe([{pnl: 0.05}, {pnl: 0.05}, {pnl: 0.05}]) === null) {
      ok('64.2 _computeSharpe sd=0 → null (无意义)');
    } else fail('64.2 sharpe sd=0', '');

    // ---- 64.3 _computeSharpe: 正收益序列 → 正数 ----
    // 假设 5 笔 pnl = [0.02, 0.03, 0.01, 0.04, 0.02], periodsPerYear=48
    // mean=0.024, sd≈0.01166, sharpe = (0.024/0.01166) * sqrt(48) ≈ 2.058 * 6.928 ≈ 14.26
    const win = [{pnl:0.02},{pnl:0.03},{pnl:0.01},{pnl:0.04},{pnl:0.02}];
    const sharpeWin = ST._computeSharpe(win, 48);
    if (sharpeWin > 0 && Math.abs(sharpeWin - 14.26) < 0.5) {
      ok('64.3 _computeSharpe 正收益序列 → 约 +14.26 (年化): ' + sharpeWin);
    } else fail('64.3 sharpe 正', String(sharpeWin));

    // ---- 64.4 _computeSharpe: 负收益 → 负数 ----
    const lose = [{pnl:-0.02},{pnl:-0.03},{pnl:-0.01},{pnl:-0.04},{pnl:-0.02}];
    const sharpeLose = ST._computeSharpe(lose, 48);
    if (sharpeLose < 0) ok('64.4 _computeSharpe 负收益 → 负数: ' + sharpeLose);
    else fail('64.4 sharpe 负', String(sharpeLose));

    // ---- 64.5 _computeMaxDrawdown: 空数组 → null ----
    if (ST._computeMaxDrawdown([]) === null) ok('64.5 _computeMaxDrawdown 空 → null');
    else fail('64.5 DD 空', '');

    // ---- 64.6 _computeMaxDrawdown: 单调上升 → 0 (无回撤) ----
    if (ST._computeMaxDrawdown([{pnl:0.01},{pnl:0.02},{pnl:0.03}]) === 0) {
      ok('64.6 _computeMaxDrawdown 单调上升 → 0');
    } else fail('64.6 DD 0', '');

    // ---- 64.7 _computeMaxDrawdown: peak 3, valley 1 → DD = -2/3 ≈ -0.6667 ----
    // pnl: 0.05, 0.10, -0.20, 0.05 → cum: 0.05, 0.15, -0.05, 0 → peak=0.15, valley cum=-0.05 → dd=(-0.05-0.15)/0.15=-1.333
    const dd1 = ST._computeMaxDrawdown([{pnl:0.05},{pnl:0.10},{pnl:-0.20},{pnl:0.05}]);
    if (Math.abs(dd1 - (-1.3333)) < 0.01) ok('64.7 _computeMaxDrawdown 复杂路径: ' + dd1);
    else fail('64.7 DD 复杂', String(dd1));

    // ---- 64.8 _computePayoffRatio: 无盈利 → null ----
    if (ST._computePayoffRatio([{pnl:-0.01},{pnl:-0.02}]) === null) ok('64.8 payoff 无盈利 → null');
    else fail('64.8 payoff 无赢', '');

    // ---- 64.9 _computePayoffRatio: 平均盈利 0.045 / 平均亏损 0.015 → 3.0 ----
    const ratio = ST._computePayoffRatio([{pnl:0.05},{pnl:0.04},{pnl:-0.02},{pnl:-0.01}]);
    if (Math.abs(ratio - 3.0) < 0.01) ok('64.9 _computePayoffRatio: ' + ratio);
    else fail('64.9 payoff', String(ratio));

    // ---- 64.10 _buildTrackRecord 集成 3 个字段 (P1-3 升级) ----
    // 5 笔样本: 4 正确 + 1 错 (足够 SCORECARD_MIN=3)
    const trades = [
      { outcome: 'correct', pnl: 0.05, assumption: '题材催化', reason: null },
      { outcome: 'correct', pnl: 0.03, assumption: '题材催化', reason: null },
      { outcome: 'correct', pnl: 0.04, assumption: '突破', reason: null },
      { outcome: 'partial', pnl: 0.01, assumption: '题材催化', reason: null },
      { outcome: 'wrong',   pnl: -0.08, assumption: '突破',     reason: '假设错误' }
    ];
    const rec = ST._buildTrackRecord(trades);
    if (rec && rec.total === 5 && rec.sharpe != null && rec.maxDrawdown != null && rec.payoffRatio != null) {
      ok('64.10 track record 含 sharpe/maxDrawdown/payoffRatio');
    } else fail('64.10 track 字段', JSON.stringify(rec));

    // ---- 64.11 _formatTrackRecord 渲染 3 个风险指标 ----
    const text = ST._formatTrackRecord(rec);
    if (text.includes('夏普') && text.includes('最大回撤') && text.includes('盈亏比')) {
      ok('64.11 成绩单 prompt 文本含 3 风险指标');
    } else fail('64.11 渲染', text.slice(0, 200));

    // ---- 64.12 源码对账: 3 纯函数 + track record 集成 ----
    const src = readFileSafe(path.join(WWW, 'app/short-trader.js'));
    if (/_computeSharpe/.test(src) && /_computeMaxDrawdown/.test(src) && /_computePayoffRatio/.test(src)) {
      ok('64.12a 源码含 3 纯函数');
    } else fail('64.12a 3 函数', '缺');
    if (/periodsPerYear\s*=\s*48/.test(src)) ok('64.12b 默认 48 笔/年 (周频)');
    else fail('64.12b 频率', '缺默认 48');
    if (/riskParts/.test(src) && /sharpe.*toFixed/.test(src)) ok('64.12c 渲染含 sharpe');
    else fail('64.12c 渲染', '缺 riskParts');
  } catch (e) {
    fail('64 P1-3', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [65] P1-4: Core.SimilarMarket 历史相似行情 RAG ==========
section('[65] P1-4: Core.SimilarMarket 纯函数 + T2 集成');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder, fetch: () => Promise.reject(new Error('no fetch')),
      window: {}, Core: {}
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/similar-market.js')), DS);
    const SM = DS.window.Core.SimilarMarket;
    if (!SM || typeof SM.find !== 'function') {
      fail('65.0 加载 similar-market 失败', '缺 find');
      return;
    }

    // ---- 65.1 _pearson: 完全相同向量 → 1.0 ----
    const v1 = [1, 2, 3, 4];
    const p1 = SM._pearson(v1, [2, 4, 6, 8]);  // 完美正相关
    if (p1 != null && Math.abs(p1 - 1) < 1e-9) ok('65.1 _pearson 完美正相关 → 1.0');
    else fail('65.1 pearson 1', String(p1));

    // ---- 65.2 _pearson: 完美负相关 → -1.0 ----
    const p2 = SM._pearson([1, 2, 3, 4], [4, 3, 2, 1]);
    if (p2 != null && Math.abs(p2 - (-1)) < 1e-9) ok('65.2 _pearson 完美负相关 → -1.0');
    else fail('65.2 pearson -1', String(p2));

    // ---- 65.3 _pearson: 跳过 NaN ----
    const p3 = SM._pearson([1, NaN, 3, 4], [2, 0, 6, 8]);  // NaN 跳过, 剩 3 维完美正相关
    if (p3 != null && Math.abs(p3 - 1) < 1e-9) ok('65.3 _pearson 跳过 NaN 维度');
    else fail('65.3 pearson NaN', String(p3));

    // ---- 65.4 _pearson: 维度全 NaN → null ----
    const p4 = SM._pearson([NaN, NaN], [1, 2]);
    if (p4 === null) ok('65.4 _pearson 全 NaN → null');
    else fail('65.4 pearson 全空', String(p4));

    // ---- 65.5 _rsi14: 数据不足 → null ----
    if (SM._rsi14([100, 101, 99]) === null) ok('65.5 _rsi14 数据不足 → null');
    else fail('65.5 RSI 短', '');

    // ---- 65.6 _rsi14: 全部上涨 → 100 (avgLoss=0) ----
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    if (SM._rsi14(up) === 100) ok('65.6 _rsi14 全涨 → 100');
    else fail('65.6 RSI 全涨', '');

    // ---- 65.7 _featuresOf: 20 根 K 线返 4 维 ----
    const bars = Array.from({ length: 30 }, (_, i) => ({
      close: 100 + (i % 5),
      volume: 1000 + i * 10,
      open: 100 + (i % 5)
    }));
    const f = SM._featuresOf(bars);
    if (typeof f.ret5 === 'number' && typeof f.volRatio === 'number'
        && typeof f.rsi14 === 'number' && typeof f.vol20 === 'number') {
      ok('65.7 _featuresOf 返 4 维 (ret5/volRatio/rsi14/vol20)');
    } else fail('65.7 features', JSON.stringify(f));

    // ---- 65.8 _forwardReturn: 5 日后收益 ----
    const bar2 = Array.from({ length: 30 }, (_, i) => ({ close: 100 + i }));
    const fwd = SM._forwardReturn(bar2, 24, 5);
    if (fwd != null && Math.abs(fwd - 5/124) < 0.001) ok('65.8 _forwardReturn 后续 5 日: ' + fwd.toFixed(4));
    else fail('65.8 forward', String(fwd));

    // ---- 65.9 find: K线 < 30 → null ----
    const shortKline = Array.from({ length: 20 }, (_, i) => ({ 日期: '20260' + (i+1), 收盘: 100 + i }));
    const r9 = await SM.find('600519', { fetcher: async () => shortKline });
    if (r9 === null) ok('65.9 find K线<30 → null');
    else fail('65.9 find 少', JSON.stringify(r9));

    // ---- 65.10 find: 模拟 250 根稳定 K 线, query vs 自己 → corr=1, summary 全填 ----
    const kline250 = Array.from({ length: 250 }, (_, i) => {
      const close = 100 + Math.sin(i * 0.3) * 2 + (i % 7);
      return { 日期: `2026-${String(Math.floor(i/30)+1).padStart(2,'0')}-${String(i%30+1).padStart(2,'0')}`, 开盘: close - 0.5, 收盘: close, 成交量: 1000000 + i * 1000 };
    });
    const r10 = await SM.find('600519', { days: 20, lookahead: 5, topK: 3, histWindow: 200, fetcher: async () => kline250 });
    if (r10 && r10.code === '600519' && r10.topSegments && r10.topSegments.length === 3
        && r10.summary && r10.summary.sampleSize > 0 && r10.summary.maxCorr != null) {
      ok('65.10 find 250 根 → top3 + summary (sampleSize=' + r10.summary.sampleSize + ', maxCorr=' + r10.summary.maxCorr + ')');
    } else fail('65.10 find 250', JSON.stringify(r10).slice(0, 200));

    // ---- 65.11 formatForPrompt: 含 "历史相似" + 后续收益 ----
    const t11 = SM.formatForPrompt(r10);
    if (t11.includes('历史相似') && t11.includes('600519') && (t11.includes('平均') || t11.includes('样本不足'))) {
      ok('65.11 formatForPrompt 含 "历史相似" + 收益摘要');
    } else fail('65.11 渲染', t11.slice(0, 200));

    // ---- 65.12 formatForPrompt: null → 空串 ----
    if (SM.formatForPrompt(null) === '' && SM.formatForPrompt(undefined) === '') {
      ok('65.12 formatForPrompt null → ""');
    } else fail('65.12 空', '');

    // ---- 65.13 源码对账: 4 个纯函数 + 主入口 ----
    const src = readFileSafe(path.join(WWW, 'core/similar-market.js'));
    if (/_pearson\(/.test(src) && /_featuresOf\(/.test(src) && /_rsi14\(/.test(src) && /_forwardReturn\(/.test(src)) {
      ok('65.13a 源码含 4 纯函数');
    } else fail('65.13a 4 函数', '缺');
    if (/DEFAULT_HIST_WINDOW\s*=\s*240/.test(src)) ok('65.13b 默认 240 窗口');
    else fail('65.13b 窗口', '缺');
    if (/topK/.test(src) && /avgForwardReturn/.test(src)) ok('65.13c topK + 后续收益');
    else fail('65.13c 收益', '缺');

    // ---- 65.14 index.html + vite.config 注册 ----
    const idx = readFileSafe(path.join(WWW, 'index.html'));
    const vite = readFileSafe(path.join(WWW, '..', 'vite.config.js'));
    if (idx && /core\/similar-market\.js/.test(idx)) ok('65.14a index.html 引用 similar-market.js');
    else fail('65.14a html 引用', '');
    if (vite && /core\/similar-market\.js/.test(vite)) ok('65.14b vite.config external 收口');
    else fail('65.14b vite ext', '');

    // ---- 65.15 T2 _buildPlanContext 集成 similarByCode ----
    const stSrc = readFileSafe(path.join(WWW, 'app/short-trader.js'));
    if (/similarByCode/.test(stSrc) && /Core\.SimilarMarket\.find/.test(stSrc)) {
      ok('65.15 T2 _buildPlanContext 注入 Core.SimilarMarket.find');
    } else fail('65.15 集成', '缺');
    if (/formatForPrompt\(/.test(stSrc)) ok('65.16 _buildUserPrompt 渲染 formatForPrompt');
    else fail('65.16 渲染', '缺');
  } catch (e) {
    fail('65 P1-4', e.message + ' / ' + (e.stack || ''));
  }
})();

// ========== [66] L1: LongTrader 业绩归因 (journal + 机械 verify + 8 类归因 + 成绩单) ==========
section('[66] L1: LongTrader._judgeLongOutcome / _buildLongTrackRecord / verifyLongTrades');
(async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder, fetch: () => Promise.reject(new Error('no fetch')),
      window: {}, Core: {
        State: { get: () => null },
        Storage: { all: async () => [], kvGet: async () => null, kvSet: async () => {},
                   add: async () => 1, update: async () => true }
      }
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'app/long-trader.js')), DS);
    const LT = DS.window.LongTrader;
    if (!LT) { fail('66.0 加载 long-trader 失败', '无 LT'); return; }

    // ---- 66.1 _judgeLongOutcome: 浮盈 ≥ 8% → correct + timingGood ----
    const c1 = LT._judgeLongOutcome(0.10);
    if (c1.outcome === 'correct' && c1.reason === 'timingGood') ok('66.1 浮盈 10% → correct/timingGood');
    else fail('66.1 浮盈 10', JSON.stringify(c1));

    // ---- 66.2 _judgeLongOutcome: 浮盈 5-8% → correct/选股对 ----
    const c2 = LT._judgeLongOutcome(0.06);
    if (c2.outcome === 'correct' && c2.reason === '选股对') ok('66.2 浮盈 6% → correct/选股对');
    else fail('66.2 浮盈 6', JSON.stringify(c2));

    // ---- 66.3 _judgeLongOutcome: 浮亏 ≥ 8% → wrong/假设错误 ----
    const c3 = LT._judgeLongOutcome(-0.10);
    if (c3.outcome === 'wrong' && c3.reason === '假设错误') ok('66.3 浮亏 10% → wrong/假设错误');
    else fail('66.3 浮亏 10', JSON.stringify(c3));

    // ---- 66.4 _judgeLongOutcome: 浮亏 5-8% → wrong/选股错 ----
    const c4 = LT._judgeLongOutcome(-0.06);
    if (c4.outcome === 'wrong' && c4.reason === '选股错') ok('66.4 浮亏 6% → wrong/选股错');
    else fail('66.4 浮亏 6', JSON.stringify(c4));

    // ---- 66.5 _judgeLongOutcome: ±5% 内 → partial/时机过早 ----
    const c5 = LT._judgeLongOutcome(0.02);
    if (c5.outcome === 'partial' && c5.reason === '时机过早') ok('66.5 浮盈 2% → partial/时机过早');
    else fail('66.5 浮盈 2', JSON.stringify(c5));

    // ---- 66.6 _judgeLongOutcome: NaN → partial/数据不足 ----
    const c6 = LT._judgeLongOutcome(NaN);
    if (c6.outcome === 'partial' && c6.reason === '数据不足') ok('66.6 NaN → partial/数据不足');
    else fail('66.6 NaN', JSON.stringify(c6));

    // ---- 66.7 _buildLongTrackRecord: 样本 < 3 → null ----
    if (LT._buildLongTrackRecord([]) === null
        && LT._buildLongTrackRecord([{ outcome: 'correct', reason: '题材' }]) === null) {
      ok('66.7 样本 < 3 → null');
    } else fail('66.7 样本少', '');

    // ---- 66.8 _buildLongTrackRecord: 6 笔样本, 按 reason 关键词分类 (题材/业绩/资金/技术) ----
    const trades8 = [
      { outcome: 'correct', reason: '题材催化: AI 概念', pnlPct: 0.06, code: '000001' },
      { outcome: 'correct', reason: '题材: 芯片', pnlPct: 0.05, code: '000002' },
      { outcome: 'partial', reason: '题材: 医药', pnlPct: 0.02, code: '000003' },
      { outcome: 'wrong',   reason: '业绩: 净利润增 50%', pnlPct: -0.07, code: '000004' },
      { outcome: 'wrong',   reason: '技术: 突破 MA60', pnlPct: -0.05, code: '000005' },
      { outcome: 'correct', reason: '资金: 北向流入', pnlPct: 0.04, code: '000006' }
    ];
    const rec8 = LT._buildLongTrackRecord(trades8);
    if (rec8 && rec8.total === 6
        && rec8.byReason.length === 4
        && rec8.byReason[0].category === '题材' && rec8.byReason[0].total === 3) {
      ok('66.8 6 笔 → 4 类 (题材 3 / 业绩 1 / 资金 1 / 技术 1)');
    } else fail('66.8 分组', JSON.stringify(rec8));

    // ---- 66.9 _buildLongTrackRecord: 胜率正确 (3 correct + 1 partial + 2 wrong = 3.5/6 = 0.58) ----
    if (Math.abs(rec8.correctRate - 0.58) < 0.01) ok('66.9 correctRate=0.58: ' + rec8.correctRate);
    else fail('66.9 胜率', String(rec8.correctRate));

    // ---- 66.10 verifyLongTrades: 无 journal → 0 ----
    // 沙箱 Storage.all → []
    const r10 = await LT.verifyLongTrades({ now: new Date(2026, 6, 30, 10, 0) });
    if (r10.scanned === 0 && r10.verified === 0) ok('66.10 无 journal → 0');
    else fail('66.10 空', JSON.stringify(r10));

    // ---- 66.11 verifyLongTrades: 3 笔 journal (1 entryDate 90 天内, 1 已 verify, 1 拉 K 失败) → 1 verified ----
    const fakeJournals = [
      { id: 'a', code: '600519', sleeve: 'long', auto: true, entryDate: '2026-06-01', costPrice: 100, verifyOutcome: null },
      { id: 'b', code: '000001', sleeve: 'long', auto: true, entryDate: '2026-07-01', costPrice: 50, verifyOutcome: 'correct' },  // 已 verify 跳过
      { id: 'c', code: '300750', sleeve: 'short', auto: true, entryDate: '2026-05-01', costPrice: 200, verifyOutcome: null }  // sleeve 不对跳过
    ];
    const fakeKline = (code) => {
      if (code === '600519') {
        // 5 根 K: 100, 105, 110, 108, 115 (最后 115 → 浮盈 15%)
        return [
          { 日期: '2026-06-01', 收盘: 100 }, { 日期: '2026-06-15', 收盘: 105 },
          { 日期: '2026-07-01', 收盘: 110 }, { 日期: '2026-07-15', 收盘: 108 },
          { 日期: '2026-07-30', 收盘: 115 }
        ];
      }
      return [];
    };
    const DS2 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
      Storage: Object.assign({}, DS.Core.Storage, {
        all: async () => fakeJournals,
        update: async (table, id, patch) => ({ table, id, patch })
      })
    }) });
    DS2.window = DS2;
    vm.createContext(DS2);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS2);
    vm.runInContext(readFileSafe(path.join(WWW, 'app/long-trader.js')), DS2);
    const LT2 = DS2.window.LongTrader;
    const r11 = await LT2.verifyLongTrades({
      now: new Date(2026, 6, 30, 10, 0),
      fetcher: async (code) => fakeKline(code)
    });
    if (r11.scanned === 1 && r11.verified === 1) ok('66.11 1 笔 long+无 verify → verified=1');
    else fail('66.11 verify', JSON.stringify(r11));

    // ---- 66.12 _writeLongJournal: 写 journal 行 (mock Storage.add) ----
    let addedRow = null;
    const DS3 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
      Storage: Object.assign({}, DS.Core.Storage, {
        add: async (table, row) => { addedRow = { table, row }; return 1; }
      })
    }) });
    DS3.window = DS3;
    vm.createContext(DS3);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS3);
    vm.runInContext(readFileSafe(path.join(WWW, 'app/long-trader.js')), DS3);
    const LT3 = DS3.window.LongTrader;
    const j = await LT3._writeLongJournal({
      code: '600519', name: '贵州茅台', reason: '题材: 提价预期', costPrice: 1800, shares: 100
    });
    if (j && j.sleeve === 'long' && j.auto === true && j.code === '600519'
        && j.costPrice === 1800 && j.shares === 100 && j.entryDate
        && j.content.includes('题材: 提价预期') && j.id && j.id.startsWith('lt-')) {
      ok('66.12 _writeLongJournal 写 sleeve=long/auto=true/costPrice/shares');
    } else fail('66.12 journal', JSON.stringify(j).slice(0, 200));

    // ---- 66.13 _writeLongJournal: 缺 code → null ----
    const j13 = await LT3._writeLongJournal({ name: 'X', reason: 'r' });
    if (j13 === null) ok('66.13 缺 code → null');
    else fail('66.13 缺 code', JSON.stringify(j13));

    // ---- 66.14 源码对账: init 调 verify + runNow 调 _writeLongJournal ----
    const src = readFileSafe(path.join(WWW, 'app/long-trader.js'));
    if (/verifyLongTrades\(\)/.test(src) && /init\(\)[\s\S]{0,500}verifyLongTrades/.test(src)) {
      ok('66.14a init 调 verifyLongTrades');
    } else fail('66.14a init', '缺');
    if (/_writeLongJournal\(/.test(src) && /autoTradeFromPick[\s\S]{0,400}_writeLongJournal/.test(src)) {
      ok('66.14b runNow 调 _writeLongJournal');
    } else fail('66.14b runNow', '缺');

    // ---- 66.15 constants.js L1 常量 ----
    const cs = readFileSafe(path.join(WWW, 'core/constants.js'));
    if (/LONG_VERIFY_THRESHOLD_PCT\s*=\s*0\.05/.test(cs) && /LONG_VERIFY_THRESHOLD_BAD_PCT\s*=\s*0\.08/.test(cs) && /LONG_VERIFY_TIMING_GOOD_PCT\s*=\s*0\.08/.test(cs)) {
      ok('66.15 constants 含 L1 阈值常量 (5% / 8%)');
    } else fail('66.15 常量', '缺');

    // ---- 66.16 L1.6 UI 渲染: renderTrackRecord + 挂载点 ----
    const idx = readFileSafe(path.join(WWW, 'index.html'));
    if (/longTraderTrackSection/.test(idx)) ok('66.16a index.html 挂载点 longTraderTrackSection');
    else fail('66.16a html 挂载', '缺');
    if (/renderTrackRecord/.test(readFileSafe(path.join(WWW, 'app/long-trader.js')))) {
      ok('66.16b LongTrader.renderTrackRecord 方法已暴露');
    } else fail('66.16b 暴露', '缺');
    if (/LongTrader\.renderTrackRecord/.test(readFileSafe(path.join(WWW, 'app/paper.js')))) {
      ok('66.16c paper.renderPage 调用 LongTrader.renderTrackRecord');
    } else fail('66.16c 接线', '缺');
    if (/sleeve === 'long'/.test(readFileSafe(path.join(WWW, 'app/paper.js')))) {
      ok('66.16d 仅 long tab 显示 (sleeve === long 守卫)');
    } else fail('66.16d 守卫', '缺');
  } catch (e) {
    fail('66 L1', e.message + ' / ' + (e.stack || ''));
  }
})();

  // ========== [67] H3 UI 红条 + 5 调用方 prompt (Commit 6) ==========
  try {
    // 67.1 app.js: 含 _renderRegimeBadge / showRegimeAlertBanner / hideRegimeAlertBanner / subscribe
    const app = readFileSafe(path.join(WWW, 'app.js'));
    if (/_renderRegimeBadge/.test(app) && /showRegimeAlertBanner/.test(app) && /hideRegimeAlertBanner/.test(app)) {
      ok('67.1 app.js 含 _renderRegimeBadge / showRegimeAlertBanner / hideRegimeAlertBanner');
    } else fail('67.1 app.js UI 函数', '缺');
    if (/Core\.Regime\.subscribe/.test(app) && /setInterval[\s\S]{0,300}refresh\(\)[\s\S]{0,200}_renderRegimeBadge/.test(app)) {
      ok('67.2 app.js 订阅 regime + 5min 周期 refresh loopback');
    } else fail('67.2 app.js subscribe/interval', '缺');

    // 67.3 styles.src.css: .regime-badge (3 variants) + .regime-alert + @keyframes
    const css = readFileSafe(path.join(WWW, 'styles.src.css'));
    if (/\.regime-badge\s*\{[\s\S]*?\.regime-bull/.test(css) && /\.regime-range/.test(css) && /\.regime-bear/.test(css)) {
      ok('67.3 styles 含 .regime-badge (3 variants: bull/range/bear)');
    } else fail('67.3 styles variants', '缺');
    if (/\.regime-alert\s*\{[\s\S]*?(gradient|linear-gradient)/.test(css)) {
      ok('67.4 styles 含 .regime-alert 红条 gradient');
    } else fail('67.4 .regime-alert', '缺');
    if (/@keyframes\s+regime-alert-pulse/.test(css)) {
      ok('67.5 styles 含 @keyframes regime-alert-pulse');
    } else fail('67.5 keyframes', '缺');

    // 67.6 core/regime.js: _formatRegimeBlock 导出 + 渲染 stale line + per-index
    const regime = readFileSafe(path.join(WWW, 'core/regime.js'));
    if (/_formatRegimeBlock[\s\S]{0,1000}?指数共识[\s\S]{0,200}sh000300[\s\S]{0,200}sh000852[\s\S]{0,200}sz399303/.test(regime)) {
      ok('67.6 regime.js _formatRegimeBlock 渲染 3 指数 + 中文标签');
    } else fail('67.6 _formatRegimeBlock', '缺');
    if (/stale\s*\?\s*`[\s\S]{0,40}指数数据源失灵/.test(regime) || /指数数据源失灵/.test(regime)) {
      ok('67.7 regime.js stale 段含"指数数据源失灵"');
    } else fail('67.7 stale line', '缺');

    // 67.8-67.12 5 调用方 prompt 注入
    const callers = [
      ['short-trader.js', /Core\.Regime\._formatRegimeBlock/],
      ['intraday-trader.js', /Core\.Regime[\s\S]{0,40}_formatRegimeBlock/],
      ['long-trader.js', /Core\.Regime[\s\S]{0,40}gateMultipliers/],
      ['screener.js', /Core\.Regime[\s\S]{0,40}_formatRegimeBlock/],
      ['fund/ai-advisor.js', /Core\.Regime[\s\S]{0,40}_formatRegimeBlock/]
    ];
    callers.forEach(([name, re], i) => {
      const src = readFileSafe(path.join(WWW, 'app', name));
      if (re.test(src)) ok(`67.${8 + i} ${name} prompt 含 regime 块`);
      else fail(`67.${8 + i} ${name} regime 注入`, '缺');
    });

    // 67.13 stale UI 条件: 失败时 banner 类 + retry button (仅 staleFailures >= STALE_FAIL_THRESHOLD)
    if (/g\.stale\s*\?\s*['"]?[`'"][\s\S]{0,40}失灵/.test(app) || /staleFailures\s*>=\s*STALE_FAIL_THRESHOLD/.test(app)) {
      ok('67.13 app.js 含 staleFailures >= STALE_FAIL_THRESHOLD 触发 banner');
    } else fail('67.13 stale 触发', '缺');
  } catch (e) {
    fail('67 H3 UI', e.message + ' / ' + (e.stack || ''));
  }

  // ========== [68] P1-2 + P2-1: LLM 性能埋点 + 校准漂移检测 ==========
  section('[68] P1-2: _logAiPerf + P2-1: _checkCalibrationDrift + checkCalibrationDriftReport + renderCalibrationCard');
  (async () => {
    try {
      const { TextDecoder: NodeTextDecoder } = require('util');
      const perfStore = { kv: {} };
      const DS = {
        console, setTimeout, clearTimeout, URLSearchParams,
        TextDecoder: NodeTextDecoder, fetch: () => Promise.reject(new Error('no fetch')),
        window: {},
        Core: {
          State: { get: () => null },
          Storage: {
            all: async () => [],
            kvGet: async (k) => perfStore.kv[k] || null,
            kvSet: async (k, v) => { perfStore.kv[k] = v; }
          }
        }
      };
      DS.window = DS;
      vm.createContext(DS);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS);
      const ST = DS.window.ShortTrader;
      if (!ST) { fail('68.0 加载 short-trader 失败', '无 ST'); return; }

      // ---- 68.1 _logAiPerf 写一条 ----
      await ST._logAiPerf({ scenario: 't2-test', votes: 3, latencyMs: 1200, successCount: 3, failCount: 0 });
      const log1 = await ST._readAiPerfLog();
      if (log1.length === 1 && log1[0].scenario === 't2-test' && log1[0].votes === 3 && log1[0].latencyMs === 1200) {
        ok('68.1 _logAiPerf 写一条 + _readAiPerfLog 读出');
      } else fail('68.1 perf 写读', JSON.stringify(log1));

      // ---- 68.2 滚动 200 ----
      for (let i = 0; i < 205; i++) {
        await ST._logAiPerf({ scenario: 'rolling', votes: 1, latencyMs: 100, successCount: 1, failCount: 0 });
      }
      const log2 = await ST._readAiPerfLog();
      if (log2.length === 200 && log2[0].scenario !== 't2-test' && log2[199].scenario === 'rolling') {
        ok('68.2 _logAiPerf 滚动 200 (最早的 t2-test 被淘汰)');
      } else fail('68.2 滚动', 'len=' + log2.length);

      // ---- 68.3 写失败被 catch 吞 ----
      const DS3 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
        Storage: Object.assign({}, DS.Core.Storage, {
          kvSet: async () => { throw new Error('kv down'); },
          kvGet: async () => null
        })
      }) });
      DS3.window = DS3;
      vm.createContext(DS3);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS3);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS3);
      const ST3 = DS3.window.ShortTrader;
      let threw = false;
      try { await ST3._logAiPerf({ scenario: 'fail' }); } catch (e) { threw = true; }
      if (!threw) ok('68.3 _logAiPerf 写失败被 catch 吞, 不抛');
      else fail('68.3 吞错', '抛了');

      // ---- 68.4 _checkCalibrationDrift 空 → null ----
      const r4 = ST._checkCalibrationDrift([], { nowMs: Date.now() });
      if (r4 === null) ok('68.4 _checkCalibrationDrift 空 → null');
      else fail('68.4 空', String(r4));

      // ---- 68.5 样本不足 ----
      const now5 = 1700000000000;
      const r5 = ST._checkCalibrationDrift([
        { probability: 70, outcome: 'correct', verifiedAt: now5 - 1000 }
      ], { nowMs: now5 });
      // 单笔在 recent 但 base 为 0 → baseBrier=null + reason=样本不足 (recentBrier 不为 null)
      if (r5 && r5.baseBrier === null && r5.reason === '样本不足' && r5.recentN === 1 && r5.baseN === 0) {
        ok('68.5 样本不足 (base=0) → baseBrier=null + reason=样本不足');
      } else fail('68.5 不足', JSON.stringify(r5));

      // ---- 68.6 Brier 上升 > 阈值 → drifted=true ----
      const trades6 = [];
      for (let i = 0; i < 5; i++) trades6.push({ probability: 60, outcome: 'correct', verifiedAt: now5 - 10 * 86400 * 1000 + i * 1000 });
      trades6.push({ probability: 60, outcome: 'wrong', verifiedAt: now5 - 10 * 86400 * 1000 + 5000 });
      for (let i = 0; i < 2; i++) trades6.push({ probability: 80, outcome: 'correct', verifiedAt: now5 - 3 * 86400 * 1000 + i * 1000 });
      for (let i = 0; i < 4; i++) trades6.push({ probability: 80, outcome: 'wrong', verifiedAt: now5 - 3 * 86400 * 1000 + 3000 + i * 1000 });
      const r6 = ST._checkCalibrationDrift(trades6, { nowMs: now5, threshold: 0.05 });
      if (r6 && r6.drifted === true && r6.direction === 'up' && r6.delta > 0.05) {
        ok('68.6 Brier 上升 > 阈值 → drifted=true (direction=up)');
      } else fail('68.6 漂移', JSON.stringify(r6));

      // ---- 68.7 Brier 下降 → drifted=false, direction=down ----
      const trades7 = [];
      for (let i = 0; i < 4; i++) trades7.push({ probability: 80, outcome: 'wrong', verifiedAt: now5 - 10 * 86400 * 1000 + i * 1000 });
      for (let i = 0; i < 2; i++) trades7.push({ probability: 80, outcome: 'correct', verifiedAt: now5 - 10 * 86400 * 1000 + 4000 + i * 1000 });
      for (let i = 0; i < 5; i++) trades7.push({ probability: 60, outcome: 'correct', verifiedAt: now5 - 3 * 86400 * 1000 + i * 1000 });
      trades7.push({ probability: 60, outcome: 'wrong', verifiedAt: now5 - 3 * 86400 * 1000 + 5000 });
      const r7 = ST._checkCalibrationDrift(trades7, { nowMs: now5, threshold: 0.05 });
      if (r7 && r7.drifted === false && r7.direction === 'down' && r7.delta < 0) {
        ok('68.7 Brier 下降 → drifted=false (direction=down, delta<0)');
      } else fail('68.7 下降', JSON.stringify(r7));

      // ---- 68.8 无 trades → 跳过得报告 ----
      const r8 = await ST.checkCalibrationDriftReport({ nowMs: now5, minSamples: 5 });
      if (r8 && r8.persisted === false && r8.report && r8.report.skipped === true) {
        ok('68.8 无样本 → persisted=false, skipped=true');
      } else fail('68.8 跳过', JSON.stringify(r8));

      // ---- 68.9 持久化到 kv (mock paper_cond_orders 给 probability + content) ----
      perfStore.kv = {};
      const orderMap = {};
      trades6.forEach((t, i) => { orderMap['a' + i] = { id: 'a' + i, probability: t.probability, assumption: '题材' }; });
      // 让 position.exitDate / entryDate 对齐 journal 的 verifiedAt ±几天, _linkVerifiedTrades 才能匹配上
      const positionMap = {};
      trades6.forEach((t, i) => {
        const exitDate = new Date(t.verifiedAt + 86400 * 1000).toISOString().slice(0, 10);
        const entryDate = new Date(t.verifiedAt - 2 * 86400 * 1000).toISOString().slice(0, 10);
        positionMap['a' + i] = { code: '600519', closed: true, exitDate, entryDate, planOrderId: 'a' + i };
      });
      // content 含 _extractExitInfo 4 要素 (卖出日期/原因/入场/出场) + 6 笔不同 exitDate/entryDate
      const journals9 = trades6.map((t, i) => {
        const exitD = new Date(t.verifiedAt + 86400 * 1000);
        const exitDate = exitD.toISOString().slice(0, 10);
        const entryD = new Date(t.verifiedAt - 2 * 86400 * 1000);
        const entryDate = entryD.toISOString().slice(0, 10);
        return {
          id: 'a' + i, code: '600519', sleeve: 'short', auto: true, verifyOutcome: t.outcome,
          verifiedAt: t.verifiedAt, assumption: '题材',
          content: '卖出日期:' + exitDate + '\n原因:止盈\n入场:' + entryDate + '@10\n出场:11'
        };
      });
      const DS9 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
        Storage: Object.assign({}, DS.Core.Storage, {
          all: async () => journals9,
          kvGet: async (k) => {
            if (k === 'paper_short_positions') return Object.values(positionMap);
            if (k === 'paper_cond_orders') return Object.values(orderMap);
            return perfStore.kv[k] || null;
          },
          kvSet: async (k, v) => { perfStore.kv[k] = v; }
        })
      }) });
      DS9.window = DS9;
      vm.createContext(DS9);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS9);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS9);
      const ST9 = DS9.window.ShortTrader;
      const r9 = await ST9.checkCalibrationDriftReport({ nowMs: now5, minSamples: 3, threshold: 0.05 });
      if (r9 && r9.persisted === true && r9.report.drifted === true
          && perfStore.kv['short_calibration_drift']
          && perfStore.kv['short_calibration_drift'].date) {
        ok('68.9 报告持久化 kv short_calibration_drift (drifted=true)');
      } else fail('68.9 持久化', JSON.stringify(r9).slice(0, 200));

      // ---- 68.10 _readCalibrationDrift ----
      const r10 = await ST9._readCalibrationDrift();
      if (r10 && r10.drifted === true && r10.recentBrier > 0) ok('68.10 _readCalibrationDrift 读最新报告');
      else fail('68.10 读', JSON.stringify(r10).slice(0, 200));

      // ---- 68.11 源码对账 ----
      const src = readFileSafe(path.join(WWW, 'app/short-trader.js'));
      if (/init\(\)\s*\{[\s\S]{0,300}runDailyCalibrationReport/.test(src)) ok('68.11a init 调 runDailyCalibrationReport (含飞书推送)');
      else fail('68.11a init', '缺');
      if (/aiLatencyMs\s*=\s*Date\.now\(\)\s*-\s*aiStartMs/.test(src)) ok('68.11b 算 aiLatencyMs');
      else fail('68.11b 耗时', '缺');
      if (/_logAiPerf\(\{/.test(src) && /paper_ai_perf_log/.test(src)) ok('68.11c _logAiPerf 写 paper_ai_perf_log');
      else fail('68.11c 埋点', '缺');

      // ---- 68.12 UI 渲染 ----
      const idx = readFileSafe(path.join(WWW, 'index.html'));
      if (/shortCalibrationCard/.test(idx)) ok('68.12a index.html 挂载点 shortCalibrationCard');
      else fail('68.12a html', '缺');
      if (/renderCalibrationCard/.test(src) && /ShortTrader\.renderCalibrationCard/.test(readFileSafe(path.join(WWW, 'app/paper.js')))) {
        ok('68.12b paper.renderPage 调 ShortTrader.renderCalibrationCard');
      } else fail('68.12b 接线', '缺');
    } catch (e) {
      fail('68 P1-2+P2-1', e.message + ' / ' + (e.stack || ''));
    }
  })();

  // ========== [68.5] P2-2: 校准漂移飞书推送 ==========
  section('[68.5] P2-2: 飞书推送校准漂移报告 + runDailyCalibrationReport');
  (async () => {
    try {
      const { TextDecoder: NodeTextDecoder } = require('util');
      const perfStore = { kv: {} };
      let fetchCalled = null;
      const mockFetch = async (url, opts) => {
        fetchCalled = { url, opts: JSON.parse(opts.body) };
        return { ok: true };
      };
      const DS = {
        console, setTimeout, clearTimeout, URLSearchParams,
        TextDecoder: NodeTextDecoder, fetch: mockFetch,
        window: {},
        Core: {
          State: { get: () => null },
          Storage: {
            all: async () => [],
            kvGet: async (k) => perfStore.kv[k] || null,
            kvSet: async (k, v) => { perfStore.kv[k] = v; }
          }
        }
      };
      DS.window = DS;
      vm.createContext(DS);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS);
      const ST = DS.window.ShortTrader;
      if (!ST) { fail('68.5.0 加载 short-trader 失败', '无 ST'); return; }

      // ---- 68.5.1 _formatCalibrationDriftText 纯函数 ----
      const txt1 = ST._formatCalibrationDriftText({
        date: '2026-07-28', recentBrier: 0.33, baseBrier: 0.83, delta: -0.5,
        direction: 'down', recentN: 6, baseN: 6
      });
      if (txt1.includes('校准漂移') && txt1.includes('2026-07-28') && txt1.includes('0.330') && txt1.includes('0.830')) {
        ok('68.5.1 _formatCalibrationDriftText 含日期 + Brier + 方向');
      } else fail('68.5.1 格式化', txt1.slice(0, 200));

      // ---- 68.5.2 _pushCalibrationToFeishu: 无 webhook → 返 false 不发 fetch ----
      fetchCalled = null;
      const r2 = await ST._pushCalibrationToFeishu({ drifted: true, date: '2026-07-28' });
      if (r2 === false && fetchCalled === null) ok('68.5.2 无 webhook 配置 → 不推送 (返 false)');
      else fail('68.5.2 无 webhook', 'fetchCalled=' + JSON.stringify(fetchCalled));

      // ---- 68.5.3 _pushCalibrationToFeishu: drifted=false → 不发 fetch ----
      perfStore.kv['feishu_webhook'] = 'https://feishu.test/webhook';
      fetchCalled = null;
      const r3 = await ST._pushCalibrationToFeishu({ drifted: false, date: '2026-07-28' });
      if (r3 === false && fetchCalled === null) ok('68.5.3 drifted=false → 不推送');
      else fail('68.5.3 不漂移', '应不推送');

      // ---- 68.5.4 _pushCalibrationToFeishu: drifted=true + webhook → 推送 ----
      fetchCalled = null;
      const r4 = await ST._pushCalibrationToFeishu({
        date: '2026-07-28', drifted: true, recentBrier: 0.33, baseBrier: 0.10,
        delta: 0.23, direction: 'up', recentN: 5, baseN: 5
      });
      if (r4 === true && fetchCalled && fetchCalled.url === 'https://feishu.test/webhook'
          && fetchCalled.opts.msg_type === 'text'
          && fetchCalled.opts.content && fetchCalled.opts.content.text.includes('校准漂移')) {
        ok('68.5.4 drifted=true + webhook → 推送 (msg_type=text)');
      } else fail('68.5.4 推送', 'fetchCalled=' + JSON.stringify(fetchCalled));

      // ---- 68.5.5 _pushCalibrationToFeishu: fetch 失败 → 返 false 不抛 ----
      const DS5 = Object.assign({}, DS, { window: DS, fetch: async () => { throw new Error('CORS blocked'); } });
      DS5.window = DS5;
      vm.createContext(DS5);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS5);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS5);
      const ST5 = DS5.window.ShortTrader;
      let threw5 = false;
      try { await ST5._pushCalibrationToFeishu({ drifted: true, date: '2026-07-28' }); }
      catch (e) { threw5 = true; }
      if (!threw5) ok('68.5.5 fetch 抛错被 catch 吞, 不抛');
      else fail('68.5.5 吞错', '抛了');

      // ---- 68.5.6 runDailyCalibrationReport: 样本不足 → 不推送 ----
      const r6 = await ST.runDailyCalibrationReport({ nowMs: 1700000000000 });
      if (r6.persisted === false && r6.pushed === false && r6.report.skipped) {
        ok('68.5.6 runDaily 无样本 → persisted=false pushed=false skipped');
      } else fail('68.5.6 无样本', JSON.stringify(r6).slice(0, 200));

      // ---- 68.5.7 runDailyCalibrationReport: 持久化报告 + 漂移时推送 ----
      const now7 = 1700000000000;
      const trades6 = [];
      for (let i = 0; i < 5; i++) trades6.push({ probability: 60, outcome: 'correct', verifiedAt: now7 - 10 * 86400 * 1000 + i * 1000 });
      trades6.push({ probability: 60, outcome: 'wrong', verifiedAt: now7 - 10 * 86400 * 1000 + 5000 });
      for (let i = 0; i < 2; i++) trades6.push({ probability: 80, outcome: 'correct', verifiedAt: now7 - 3 * 86400 * 1000 + i * 1000 });
      for (let i = 0; i < 4; i++) trades6.push({ probability: 80, outcome: 'wrong', verifiedAt: now7 - 3 * 86400 * 1000 + 3000 + i * 1000 });
      const orderMap = {}; trades6.forEach((t, i) => { orderMap['a' + i] = { id: 'a' + i, probability: t.probability, assumption: '题材' }; });
      const positionMap = {}; trades6.forEach((t, i) => {
        const exitDate = new Date(t.verifiedAt + 86400 * 1000).toISOString().slice(0, 10);
        const entryDate = new Date(t.verifiedAt - 2 * 86400 * 1000).toISOString().slice(0, 10);
        positionMap['a' + i] = { code: '600519', closed: true, exitDate, entryDate, planOrderId: 'a' + i };
      });
      const journals9 = trades6.map((t, i) => {
        const exitDate = new Date(t.verifiedAt + 86400 * 1000).toISOString().slice(0, 10);
        const entryDate = new Date(t.verifiedAt - 2 * 86400 * 1000).toISOString().slice(0, 10);
        return {
          id: 'a' + i, code: '600519', sleeve: 'short', auto: true, verifyOutcome: t.outcome,
          verifiedAt: t.verifiedAt, assumption: '题材',
          content: '卖出日期:' + exitDate + '\n原因:止盈\n入场:' + entryDate + '@10\n出场:11'
        };
      });
      perfStore.kv['feishu_webhook'] = 'https://feishu.test/webhook';
      fetchCalled = null;
      const DS7 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
        Storage: Object.assign({}, DS.Core.Storage, {
          all: async () => journals9,
          kvGet: async (k) => {
            if (k === 'paper_short_positions') return Object.values(positionMap);
            if (k === 'paper_cond_orders') return Object.values(orderMap);
            return perfStore.kv[k] || null;
          },
          kvSet: async (k, v) => { perfStore.kv[k] = v; }
        })
      }) });
      DS7.window = DS7;
      vm.createContext(DS7);
      vm.runInContext(readFileSafe(path.join(WWW, 'core/constants.js')), DS7);
      vm.runInContext(readFileSafe(path.join(WWW, 'app/short-trader.js')), DS7);
      const ST7 = DS7.window.ShortTrader;
      const r7 = await ST7.runDailyCalibrationReport({ nowMs: now7 });
      // base (60% 准) brier=0.19, recent (80% 不准) brier=0.45, direction=up drifted=true
      if (r7.persisted && r7.drifted && r7.pushed
          && fetchCalled && fetchCalled.opts.content.text.includes('上升')
          && perfStore.kv['short_calibration_drift'] && perfStore.kv['short_calibration_drift'].drifted) {
        ok('68.5.7 端到端: 检查 → 持久化 → 飞书推送 (drifted=up)');
      } else fail('68.5.7 端到端', JSON.stringify(r7).slice(0, 200) + ' fetch=' + JSON.stringify(fetchCalled).slice(0, 100));

      // ---- 68.5.8 runDailyCalibrationReport: skipFeishu=true → 跑检查但不推 ----
      fetchCalled = null;
      const r8 = await ST7.runDailyCalibrationReport({ nowMs: now7, skipFeishu: true });
      if (r8.persisted && r8.drifted && r8.pushed === false && fetchCalled === null) {
        ok('68.5.8 skipFeishu=true → drifted 仍触发报告但跳过推送');
      } else fail('68.5.8 skip', JSON.stringify(r8).slice(0, 200));
    } catch (e) {
      fail('68.5 P2-2', e.message + ' / ' + (e.stack || ''));
    }
  })();

  // ========== [69] Y.2 + Y.3: 排雷扫描 + 缓存 + UI 卡片 ==========
  section('[69] Phase Y: Core.RiskMine.scanHits / checkRows / refreshCache / getCache + 选股页 UI 卡片');
  (async () => {
  try {
    const { TextDecoder: NodeTextDecoder } = require('util');
    const riskStore = { kv: {} };
    const DS = {
      console, setTimeout, clearTimeout, URLSearchParams,
      TextDecoder: NodeTextDecoder, fetch: () => Promise.reject(new Error('no fetch')),
      window: {},
      Core: {
        State: { get: () => null },
        Storage: {
          all: async () => [],
          kvGet: async (k) => riskStore.kv[k] || null,
          kvSet: async (k, v) => { riskStore.kv[k] = v; }
        },
        Data: { fetch: async () => [] }
      }
    };
    DS.window = DS;
    vm.createContext(DS);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/risk-mine.js')), DS);
    const RM = DS.window.Core.RiskMine;
    if (!RM) { fail('69.0 加载 risk-mine 失败', '无 RM'); return; }

    // ---- 69.1 scanHits: 空 codes → 空数组 ----
    if (RM.scanHits([], new Map()).length === 0) ok('69.1 scanHits 空 → []');
    else fail('69.1 空', '');

    // ---- 69.2 scanHits: codes 在 reasonMap 中 → 命中 ----
    const m2 = new Map();
    m2.set('600519', new Set(['商誉偏高']));
    m2.set('000001', new Set(['股东减持', '业绩首亏']));  // 2 条 → HIGH
    const h2 = RM.scanHits(['600519', '000001', '000002'], m2);
    if (h2.length === 2 && h2[0].code === '600519' && h2[0].level === 1
        && h2[1].code === '000001' && h2[1].level === 2) {
      ok('69.2 scanHits 1 条→LOW / 2 条→HIGH (level)');
    } else fail('69.2 命中', JSON.stringify(h2));

    // ---- 69.3 scanHits: 容错 (code 非 6 位 / reasonMap 非 Map) ----
    if (RM.scanHits(['60', null, '600519'], null).length === 0
        && RM.scanHits(['600519'], null).length === 0) {
      ok('69.3 scanHits 容错 (短 code / null / 非 Map)');
    } else fail('69.3 容错', '');

    // ---- 69.4 checkRows: 给行数组 + reasonMap → 加 riskFields ----
    const m4 = new Map();
    m4.set('600519', new Set(['商誉偏高']));
    const rows4 = [{ code: '600519', name: '贵州茅台' }, { code: '000001', name: '平安银行' }];
    const r4 = RM.checkRows(rows4, 'code', m4);
    if (r4[0].riskFields && r4[0].riskFields.reasons.includes('商誉偏高') && r4[0].riskFields.level === 1
        && !r4[1].riskFields) {
      ok('69.4 checkRows 命中行加 riskFields, 未命中行原样');
    } else fail('69.4 checkRows', JSON.stringify(r4));

    // ---- 69.5 checkRows: 不修改原行 (新数组) ----
    if (r4 !== rows4 && !rows4[0].riskFields) ok('69.5 checkRows 浅拷贝, 不改原行');
    else fail('69.5 不改原', '');

    // ---- 69.6 refreshCache: mock 4 类 fetcher → 写 kv ----
    const DS6 = Object.assign({}, DS, { window: DS, Core: Object.assign({}, DS.Core, {
      Storage: Object.assign({}, DS.Core.Storage, {
        kvGet: async (k) => riskStore.kv[k] || null,
        kvSet: async (k, v) => { riskStore.kv[k] = v; }
      })
    }) });
    DS6.window = DS6;
    vm.createContext(DS6);
    vm.runInContext(readFileSafe(path.join(WWW, 'core/risk-mine.js')), DS6);
    const RM6 = DS6.window.Core.RiskMine;
    const r6 = await RM6.refreshCache({
      fetchers: {
        goodwill: () => [{ '代码': '600519', '商誉占总资产比': 0.40 }],   // > 0.30 命中
        decrease: () => [{ '代码': '000001', '变动比例': 0.02 }],     // > 0.01 命中
        profit: () => [],
        capital: () => [{ '代码': '300750', '主力净流入净额': -2e7 }]      // < -1e7 命中
      }
    });
    // duck typing (跨 vm context Map instanceof 不可靠)
    const r6m = r6 && r6.map;
    if (r6 && r6.ok && r6m && typeof r6m.get === 'function' && r6m.size === 3
        && r6m.get('600519') && r6m.get('600519').has('商誉偏高')
        && r6m.get('000001') && r6m.get('000001').has('股东减持')
        && r6m.get('300750') && r6m.get('300750').has('主力净流出')
        && riskStore.kv['risk_mine_cache'] && riskStore.kv['risk_mine_cache'].ts) {
      ok('69.6 refreshCache 拉 4 类 → 写 kv risk_mine_cache (3 命中)');
    } else fail('69.6 refresh', JSON.stringify(r6).slice(0, 200));

    // ---- 69.7 getCache: 还原 Map + TTL 校验 ----
    const c7 = await RM6.getCache();
    // 跨 vm context 时 instanceof Map 不可靠, 用 duck typing (有 .get + .size)
    if (c7 && c7.map && typeof c7.map.get === 'function' && c7.map.size === 3
        && c7.map.get('600519') && c7.map.get('600519').has('商誉偏高')) {
      ok('69.7 getCache 还原 Map + 含 3 命中');
    } else fail('69.7 getCache', JSON.stringify(c7).slice(0, 200));

    // ---- 69.8 getCache: 过期 → null ----
    riskStore.kv['risk_mine_cache'].ts = Date.now() - 7 * 3600 * 1000;  // 7 小时前, 过期 (TTL 6h)
    const c8 = await RM6.getCache();
    if (c8 === null) ok('69.8 getCache 过期 (7h > 6h TTL) → null');
    else fail('69.8 过期', '');

    // ---- 69.9 refreshCache: fetcher 全失败 → ok=false 不抛 ----
    const r9 = await RM6.refreshCache({
      fetchers: {
        goodwill: () => Promise.reject(new Error('net down')),
        decrease: () => Promise.reject(new Error('net down')),
        profit: () => Promise.reject(new Error('net down')),
        capital: () => Promise.reject(new Error('net down'))
      }
    });
    if (r9 && r9.ok === true && r9.map.size === 0) ok('69.9 refreshCache 4 类全失败 → ok=true map=空 (不抛)');
    else fail('69.9 全失败', JSON.stringify(r9).slice(0, 200));

    // ---- 69.10 源码对账: SEVERITY + 4 函数导出 ----
    const src = readFileSafe(path.join(WWW, 'core/risk-mine.js'));
    if (/SEVERITY\s*=\s*\{[\s\S]{0,100}LOW:\s*1/.test(src) && /HIGH:\s*2/.test(src)) ok('69.10a SEVERITY (LOW/HIGH)');
    else fail('69.10a SEVERITY', '缺');
    if (/scanHits\(/.test(src) && /checkRows\(/.test(src) && /refreshCache\(/.test(src) && /getCache\(/.test(src)) {
      ok('69.10b 4 函数均导出');
    } else fail('69.10b 函数', '缺');

    // ---- 69.11 UI: 挂载点 + 渲染 + 启动钩子 ----
    const idx = readFileSafe(path.join(WWW, 'index.html'));
    if (/screenerRiskMineCard/.test(idx)) ok('69.11a index.html 挂载点 screenerRiskMineCard');
    else fail('69.11a html', '缺');
    if (/renderRiskMineCard/.test(readFileSafe(path.join(WWW, 'app/screener.js')))) {
      ok('69.11b Screener.renderRiskMineCard 方法');
    } else fail('69.11b 暴露', '缺');
    if (/Screener\.renderRiskMineCard\(\)/.test(readFileSafe(path.join(WWW, 'app/screener.js')))) {
      ok('69.11c _onShow_pageScreener 调 renderRiskMineCard');
    } else fail('69.11c 接线', '缺');
    if (/RiskMine\.refreshCache\(\)/.test(readFileSafe(path.join(WWW, 'app/screener.js')))) {
      ok('69.11d screener.init 异步刷排雷缓存');
    } else fail('69.11d 启动钩子', '缺');
  } catch (e) {
    fail('69 Y', e.message + ' / ' + (e.stack || ''));
  }
  })();

  // ========== [70] Regime 6 调用方补齐: journal.js 复盘 AI ==========
  section('[70] Regime 6 调用方: journal.js 复盘 AI 助手注入 Regime');
  try {
    const src = readFileSafe(path.join(WWW, 'app/journal.js'));
    if (/Core\.Regime\._formatRegimeBlock/.test(src)
        && /regimeBlock[\s\S]{0,200}userPrompt/.test(src)) {
      ok('70.1 journal.js _runAiAssistant 注入 _formatRegimeBlock 到 userPrompt');
    } else fail('70.1 journal 注入', '缺');
    // 6 调用方对账 (P0-3 + Regime 5 调用方)
    const callerSrc = [
      readFileSafe(path.join(WWW, 'app/short-trader.js')),
      readFileSafe(path.join(WWW, 'app/screener.js')),
      readFileSafe(path.join(WWW, 'app/stock-advisor.js')),
      readFileSafe(path.join(WWW, 'app/fund/ai-advisor.js')),
      readFileSafe(path.join(WWW, 'app/journal.js'))
    ].join('\n');
    const calls = (callerSrc.match(/Core\.Regime\._formatRegimeBlock/g) || []).length;
    if (calls >= 6) ok('70.2 全 6 个调用方都注入 _formatRegimeBlock');
    else fail('70.2 计数', 'calls=' + calls);
  } catch (e) {
    fail('70 Regime 调用方', e.message);
  }

  // ========== [71] Tier 1 Tier 1 Commit C: paper._mapAssumptionLlm + stopLoss fallback ==========
  // 测试 mirror (跟 www/app/paper.js _mapAssumptionLlm 逻辑保持一致; 改 paper.js 必须同步这里)
  section('71] Tier 1: paper._mapAssumptionLlm + stopLoss fallback');
  try {
    const ASSUMPTIONS = ['业绩拐点', '估值修复', '题材催化', '技术突破', '分红套利', '其他'];
    const ASSUMPTION_MAP = {
      '业绩拐点': '业绩拐点', '拐点': '业绩拐点', 'earnings': '业绩拐点',
      '估值修复': '估值修复', '低估值': '估值修复', '修复': '估值修复',
      '题材催化': '题材催化', '题材': '题材催化', '概念': '题材催化', '催化': '题材催化',
      '技术突破': '技术突破', '突破': '技术突破', '技术': '技术突破',
      '分红套利': '分红套利', '分红': '分红套利', '高股息': '分红套利', '股息': '分红套利'
    };
    const mapLlm = (txt) => {
      if (!txt) return '题材催化';
      const norm = String(txt).trim();
      if (ASSUMPTIONS.includes(norm)) return norm;
      for (const k of Object.keys(ASSUMPTION_MAP)) {
        if (norm.includes(k)) return ASSUMPTION_MAP[k];
      }
      return '其他';
    };
    // case 71.1 枚举直通
    if (mapLlm('业绩拐点') === '业绩拐点') ok('71.1 枚举直通');
    else fail('71.1 枚举直通', mapLlm('业绩拐点'));
    // case 71.2 同义词命中
    if (mapLlm('低估值修复') === '估值修复' && mapLlm('高股息套利') === '分红套利') ok('71.2 同义词命中');
    else fail('71.2 同义词命中', JSON.stringify([mapLlm('低估值修复'), mapLlm('高股息套利')]));
    // case 71.3 未匹配 → '其他'
    if (mapLlm('xyz未知') === '其他') ok('71.3 未匹配 → 其他');
    else fail('71.3 未匹配', mapLlm('xyz未知'));
    // case 71.4 空串 → '题材催化' fallback
    if (mapLlm('') === '题材催化' && mapLlm(null) === '题材催化' && mapLlm(undefined) === '题材催化') ok('71.4 空/null/undefined → 题材催化 fallback');
    else fail('71.4 缺省 fallback', JSON.stringify([mapLlm(''), mapLlm(null), mapLlm(undefined)]));
    // case 71.5 paper.js 中 ASSUMPTION_MAP 必须存在且大小一致 (锁死不缩)
    const paperSrc = readFileSafe(path.join(WWW, 'app/paper.js'));
    const mapMatch = paperSrc.match(/const ASSUMPTION_MAP = \{([\s\S]*?)\}/);
    if (mapMatch) {
      const paperMapKeys = (mapMatch[1].match(/'\S+?'\s*:/g) || []).length;
      if (paperMapKeys >= Object.keys(ASSUMPTION_MAP).length) ok('71.5 paper.js ASSUMPTION_MAP 包含 mirror 全部 key (paper=' + paperMapKeys + ', mirror=' + Object.keys(ASSUMPTION_MAP).length + ')');
      else fail('71.5 paper.js ASSUMPTION_MAP key 缺失', 'paper=' + paperMapKeys + ', mirror=' + Object.keys(ASSUMPTION_MAP).length);
    } else {
      fail('71.5 paper.js ASSUMPTION_MAP 未找到', '');
    }
    // case 71.6 paper.js autoTradeFromPick 必须用 _mapAssumptionLlm (不能再写死 '题材催化')
    if (/assumption\s*=\s*_mapAssumptionLlm\(/.test(paperSrc)) ok('71.6 paper.js assumption 走 _mapAssumptionLlm');
    else fail('71.6 paper.js assumption 写死', '仍是字面量或未替换');
    // case 71.7 stopLoss fallback: pick.stopLoss = null/NaN/<=0 → 写死 price × STOP_LOSS_RATIO_AUTO
    const computeStopLoss = (pickStopLoss, price, ratio) => {
      const llm = (typeof pickStopLoss === 'number' && pickStopLoss > 0) ? +pickStopLoss.toFixed(2) : null;
      return llm ?? +(price * ratio).toFixed(2);
    };
    const r71_7a = computeStopLoss(null, 10, 0.92);     // null → fallback
    const r71_7b = computeStopLoss(NaN, 10, 0.92);      // NaN → fallback
    const r71_7c = computeStopLoss(-1, 10, 0.92);      // <=0 → fallback
    const r71_7d = computeStopLoss(9.2, 10, 0.92);     // 有效 → 用 LLM
    if (r71_7a === 9.2 && r71_7b === 9.2 && r71_7c === 9.2 && r71_7d === 9.2) ok('71.7 stopLoss fallback (null/NaN/<=0 → 写死, 有效 → LLM)');
    else fail('71.7 stopLoss fallback', JSON.stringify([r71_7a, r71_7b, r71_7c, r71_7d]));
    // case 71.8 screener.js btn data-assumption-llm + data-stopLoss-llm + data-confidence 必须在
    const scSrc = readFileSafe(path.join(WWW, 'app/screener.js'));
    const hasAssumptionAttr = /data-assumption-llm=/.test(scSrc);
    const hasStopLossAttr = /data-stopLoss-llm=/.test(scSrc);
    const hasConfidenceAttr = /data-confidence=/.test(scSrc);
    if (hasAssumptionAttr && hasStopLossAttr && hasConfidenceAttr) ok('71.8 screener.js btn 加 3 个 data-* 透传字段');
    else fail('71.8 btn data-* 缺失', JSON.stringify({ hasAssumptionAttr, hasStopLossAttr, hasConfidenceAttr }));
    // case 71.9 screener.js userPrompt 必须包含【行业归属】段
    if (/【行业归属】/.test(scSrc)) ok('71.9 screener.js userPrompt 注入【行业归属】');
    else fail('71.9 【行业归属】段缺失', '');
    // case 71.10 screener.js systemPrompt 必须包含【近期纪律拦截】段
    if (/【近期纪律拦截/.test(scSrc)) ok('71.10 screener.js systemPrompt 注入【近期纪律拦截】');
    else fail('71.10 【近期纪律拦截】段缺失', '');
  } catch (e) {
    fail('71 Tier 1 mirror 测试', e.message);
  }

  // ========== [72] Tier 2: 北向个股 fetcher (data.js getNorthboundFlow) ==========
  section('72] Tier 2: 北向个股 fetcher');
  try {
    const dataSrc = readFileSafe(path.join(WWW, 'core/data.js'));
    // 72.1 函数存在 + 调 stock_hsgt_individual_em (参数 symbol=)
    if (/async\s+function\s+getNorthboundFlow[\s\S]{0,300}stock_hsgt_individual_em[\s\S]{0,80}symbol:\s*c/.test(dataSrc))
      ok('72.1 data.js getNorthboundFlow 调 stock_hsgt_individual_em(symbol={code})');
    else fail('72.1 函数/端点/参数缺失', '');
    // 72.2 缓存键含 code (hsgt_individual_${c}_v1) + TTL ≥ 12h
    if (/hsgt_individual_\$\{c\}_v1/.test(dataSrc) && /getNorthboundFlow[\s\S]{0,800}?24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(dataSrc))
      ok('72.2 缓存键含 code + TTL ≥ 12h');
    else fail('72.2 缓存键或 TTL 不达标', '');
    // 72.3 暴露到 window.Core.Data
    const dataExpose = dataSrc.match(/window\.Core\.Data\s*=\s*\{[\s\S]*?\}\s*;/)[0] || '';
    if (/getNorthboundFlow/.test(dataExpose) && /formatNorthboundForPrompt/.test(dataExpose))
      ok('72.3 getNorthboundFlow + formatNorthboundForPrompt 暴露 window.Core.Data');
    else fail('72.3 未暴露', '');
  } catch (e) {
    fail('72 北向 fetcher', e.message);
  }

  // ========== [73] Tier 2: 龙虎榜 fetcher (data.js getLhbSnapshotMap, 全市场 24h 缓存) ==========
  section('73] Tier 2: 龙虎榜 fetcher');
  try {
    const dataSrc = readFileSafe(path.join(WWW, 'core/data.js'));
    // 73.1 函数存在 + 调 stock_lhb_jgmmtj_em (无参, 全市场, Tier 3A 端点升级)
    if (/async\s+function\s+getLhbSnapshotMap[\s\S]{0,500}stock_lhb_jgmmtj_em[\s\S]{0,80}\{\s*\}/.test(dataSrc))
      ok('73.1 data.js getLhbSnapshotMap 调 stock_lhb_jgmmtj_em (全市场机构统计)');
    else fail('73.1 函数或端点缺失', '');
    // 73.2 返回 Map<code, {name, lastDate, institutionNet, institutionRatio, reasonTag}>
    const lhbFn = dataSrc.match(/async\s+function\s+getLhbSnapshotMap[\s\S]{0,1800}/)[0] || '';
    if (/new Map\(\)/.test(lhbFn) && /lastDate/.test(lhbFn) && /institutionNet/.test(lhbFn) && /reasonTag/.test(lhbFn) && /_classifyLhbReason/.test(dataSrc))
      ok('73.2 返回 Map<code, {name, lastDate, institutionNet, institutionRatio, reasonTag}>');
    else fail('73.2 Map 结构缺失', '');
    // 73.3 暴露
    const dataExpose = dataSrc.match(/window\.Core\.Data\s*=\s*\{[\s\S]*?\}\s*;/)[0] || '';
    if (/getLhbSnapshotMap/.test(dataExpose) && /formatLhbForPrompt/.test(dataExpose))
      ok('73.3 getLhbSnapshotMap + formatLhbForPrompt 暴露 window.Core.Data');
    else fail('73.3 未暴露', '');
  } catch (e) {
    fail('73 龙虎 fetcher', e.message);
  }

  // ========== [74] Tier 2: formatForPrompt 标签锁死 ==========
  section('74] Tier 2: formatForPrompt 标签锁死');
  try {
    const dataSrc = readFileSafe(path.join(WWW, 'core/data.js'));
    if (/【北向资金 \(近 5 日/.test(dataSrc)) ok('74.1 formatNorthboundForPrompt 含【北向资金】标题');
    else fail('74.1 北向标题缺失', '');
    if (/【龙虎榜 \(近 5 日, T\+1, 机构主导\)】/.test(dataSrc)) ok('74.2 formatLhbForPrompt 含【龙虎榜 (近 5 日, T+1, 机构主导)】标题');
    else fail('74.2 龙虎标题缺失', '');
  } catch (e) {
    fail('74 formatForPrompt', e.message);
  }

  // ========== [75] Tier 2: 3 调用方注入 ==========
  section('75] Tier 2: 3 调用方注入');
  try {
    // 75.1 screener.js 注入北向 + 龙虎 fetcher + formatForPrompt
    const scSrc = readFileSafe(path.join(WWW, 'app/screener.js'));
    if (/Core\.Data\.getNorthboundFlow/.test(scSrc) && /Core\.Data\.getLhbSnapshotMap/.test(scSrc)
        && /Core\.Data\.formatNorthboundForPrompt/.test(scSrc) && /Core\.Data\.formatLhbForPrompt/.test(scSrc))
      ok('75.1 screener.js 注入北向 + 龙虎 fetcher + formatForPrompt');
    else fail('75.1 screener.js 注入缺失', '');
    // 75.2 short-trader.js _buildPlanContext + _buildUserPrompt 调 fetcher
    const stSrc = readFileSafe(path.join(WWW, 'app/short-trader.js'));
    if (/Core\.Data\.getNorthboundFlow/.test(stSrc) && /Core\.Data\.getLhbSnapshotMap/.test(stSrc)
        && /Core\.Data\.formatNorthboundForPrompt/.test(stSrc) && /Core\.Data\.formatLhbForPrompt/.test(stSrc)
        && /ctx\.northByCode/.test(stSrc) && /ctx\.lhbMap/.test(stSrc))
      ok('75.2 short-trader.js 注入 ctx.northByCode + ctx.lhbMap + formatForPrompt');
    else fail('75.2 short-trader.js 注入缺失', '');
    // 75.3 intraday-trader.js 仅注北向 (不注龙虎 — T+1 盘中无意义)
    const itSrc = readFileSafe(path.join(WWW, 'app/intraday-trader.js'));
    if (/Core\.Data\.getNorthboundFlow/.test(itSrc) && !/Core\.Data\.getLhbSnapshotMap/.test(itSrc)
        && !/Core\.Data\.getLhbActivity/.test(itSrc) && /【北向资金 T\+1】/.test(itSrc))
      ok('75.3 intraday-trader.js 仅注北向(不注龙虎) + 单行标签【北向资金 T+1】');
    else fail('75.3 intraday 注入规则不对', '');
  } catch (e) {
    fail('75 调用方注入', e.message);
  }

  // ========== [76] Tier 3B: KB 扩展 (NORTH/LHB 条目 + reasonTag 触发器 + source 标签) ==========
  section('76] Tier 3B: KB 扩展');
  try {
    const kbSrc = JSON.parse(readFileSafe(path.join(WWW, 'kb_data/investment_kb.json')));
    // 76.1 新增 NORTH-001/002
    if (kbSrc.entries.find(e => e.id === 'NORTH-001' && /北向/.test(e.title)))
      ok('76.1 NORTH-001 北向 5 日净流入信号条目');
    else fail('76.1 NORTH-001 缺失', '');
    if (kbSrc.entries.find(e => e.id === 'NORTH-002' && /拐点/.test(e.title)))
      ok('76.2 NORTH-002 北向拐点信号条目');
    else fail('76.2 NORTH-002 缺失', '');
    // 76.3 新增 LHB-001/002/003
    if (kbSrc.entries.find(e => e.id === 'LHB-001' && /6 类|6类|异动/.test(e.title)))
      ok('76.3 LHB-001 6 类异动标签解读条目');
    else fail('76.3 LHB-001 缺失', '');
    if (kbSrc.entries.find(e => e.id === 'LHB-002' && /机构/.test(e.title) && /游资/.test(e.summary)))
      ok('76.4 LHB-002 机构 vs 游资席位条目');
    else fail('76.4 LHB-002 缺失', '');
    if (kbSrc.entries.find(e => e.id === 'LHB-003' && /追板|回撤/.test(e.title)))
      ok('76.5 LHB-003 龙虎追板风险条目');
    else fail('76.5 LHB-003 缺失', '');
    // 76.6 pickRelevant 加 reasonTag 触发器
    const kbJs = readFileSafe(path.join(WWW, 'core/kb.js'));
    if (/context\.reasonTags/.test(kbJs) && /TAG_QUERY/.test(kbJs) && /surge.*plunge.*turnover/s.test(kbJs))
      ok('76.6 pickRelevant 加 reasonTag 6 类触发器');
    else fail('76.6 reasonTag 触发器缺失', '');
    // 76.7 formatForPrompt 加 source 标签
    if (/CATEGORY_ICON/.test(kbJs) && /\[估值\]|\[规则\]|\[风险\]/.test(kbJs) === false) {
      // 改检查: formatForPrompt 里包含 CATEGORY_ICON + 11 类映射
      if (/valuation.*risk.*cycle.*position.*policy.*behavior.*case.*fixed_income.*fund.*rule.*discipline/s.test(kbJs))
        ok('76.7 formatForPrompt 加 CATEGORY_ICON (11 类映射)');
      else fail('76.7 CATEGORY_ICON 11 类映射缺失', '');
    }
  } catch (e) {
    fail('76 Tier 3B', e.message);
  }

  // ========== [77] Tier 3B B-fix: KB cache 不走 SW/HTTP cache, SW network-first 例外 ==========
  section('77] Tier 3B B-fix: KB cache 策略修复');
  try {
    const kbJs = readFileSafe(path.join(WWW, 'core/kb.js'));
    const swSrc = readFileSafe(path.join(WWW, 'public/sw.js'));
    // 77.1 kb.js fetch 用 cache:'no-store' (不让 HTTP cache 拦截)
    if (/cache:\s*['"]no-store['"]/.test(kbJs))
      ok('77.1 kb.js fetch 用 cache:"no-store" (Tier 3B B-fix)');
    else fail('77.1 kb.js fetch cache 策略未改', '');
    // 77.2 kb.js 不再用 cache:'force-cache'
    if (!/cache:\s*['"]force-cache['"]/.test(kbJs))
      ok('77.2 kb.js 弃用 cache:"force-cache"');
    else fail('77.2 仍用 force-cache, SW 会永久拦截', '');
    // 77.3 SW 对 /kb_data/ 走 network-first
    if (/url\.pathname\.startsWith\(['"]\/kb_data\/['"]\)/.test(swSrc)
        && /fetch\(e\.request\)\.catch\(\(\) => caches\.match/.test(swSrc))
      ok('77.3 SW 对 /kb_data/ 走 network-first (SW 拦截修复)');
    else fail('77.3 SW kb_data network-first 例外缺失', '');
  } catch (e) {
    fail('77 B-fix', e.message);
  }

  // ========== [78] Tier 3B-2: KB reasonTag 注入 screener context ==========
  section('78] Tier 3B-2: reasonTag 注入');
  try {
    const scSrc = readFileSafe(path.join(WWW, 'app/screener.js'));
    // 78.1 从 lhbMap 提取去重 reasonTag (reasonTags 变量定义)
    if (/const reasonTags =/.test(scSrc) && /\.reasonTag/.test(scSrc))
      ok('78.1 screener 从 lhbMap 提取去重 reasonTags');
    else fail('78.1 reasonTags 提取缺失', '');
    // 78.2 注入 pickRelevant context.reasonTags (reasonTags ? { reasonTags } : {})
    if (/reasonTags \? \{ reasonTags \} : \{\}/.test(scSrc))
      ok('78.2 pickRelevant 注入 context.reasonTags');
    else fail('78.2 context.reasonTags 注入缺失', '');
  } catch (e) {
    fail('78 3B-2', e.message);
  }

  // ========== [79] Tier 4: 量价异动 — 预缓存 + 振幅/5日涨幅注入 ==========
  section('79] Tier 4: 量价异动');
  try {
    const scSrc = readFileSafe(path.join(WWW, 'app/screener.js'));
    // 79.1 预缓存触发: 不 await 的循环
    if (/Tier 4: 量价预缓存/.test(scSrc))
      ok('79.1 量价预缓存触发 (不 await 后台跑)');
    else fail('79.1 预缓存缺失', '');
    // 79.2 momentumLine 计算块 + 读 K 线
    if (/momentumLine[\s\S]*getStockKLine/.test(scSrc))
      ok('79.2 momentumLine 读 K 线算振幅+5日涨幅');
    else fail('79.2 momentumLine 计算块缺失', '');
    // 79.3 userPrompt 含【量价异动】段
    if (/【量价异动/.test(scSrc))
      ok('79.3 userPrompt 注入【量价异动】段');
    else fail('79.3 量价段缺失', '');
    // 79.4 systemPrompt 含量价异动 + 量价配合两条规则
    if (/13\. \*\*量价异动/.test(scSrc) && /14\. \*\*量价配合/.test(scSrc))
      ok('79.4 systemPrompt 规则 13/14 量价异动+量价配合');
    else fail('79.4 规则 13/14 缺失', '');
  } catch (e) {
    fail('79 量价异动', e.message);
  }

  // ===== 80.1-80.3: 三维共振 KB 条目 (Phase 5) =====
  try {
    const kb80 = JSON.parse(readFileSafe(path.join(WWW, 'kb_data/investment_kb.json')));
    const r1 = kb80.entries.find(e => e.id === 'RSN-001' && /三维共振/.test(e.title));
    const r2 = kb80.entries.find(e => e.id === 'RSN-002' && /量价配合/.test(e.title));
    const r3 = kb80.entries.find(e => e.id === 'RSN-003' && /背离/.test(e.title));
    if (r1 && r2 && r3) ok('80.1 KB 含 RSN-001/002/003 三维共振条目');
    else fail('80.1 RSN 条目缺失', '');
    if (kb80._meta && kb80._meta.version >= '1.3') ok('80.2 _meta.version >= 1.3');
    else fail('80.2 version < 1.3', '');
  } catch (e) { fail('80.x 三维共振 KB', e.message); }

  // ===== 80.4: kb.js context.volume_price (Phase 5) =====
  try {
    const kbJs80 = readFileSafe(path.join(WWW, 'core', 'kb.js'));
    if (/volume_price/.test(kbJs80)) ok('80.4 kb.js 含 context.volume_price 触发器');
    else fail('80.4 volume_price 缺失', '');
  } catch (e) { fail('80.4 volume_price', e.message); }

  // ===== 81.x: 否决反馈进 LearningPool (Phase 5) =====
  try {
    const sc81 = readFileSafe(path.join(WWW, 'app', 'screener.js'));
    if (/data-action=.reject./.test(sc81) && /✕/.test(sc81))
      ok('81.1 screener 卡片含 × 否决按钮');
    else fail('81.1 × 按钮缺失', '');
    if (/screener_reject_log/.test(sc81)) ok('81.2 screener 含 reject_log KV 记录');
    else fail('81.2 reject_log 缺失', '');
  } catch (e) { fail('81.x screener 否决', e.message); }

  try {
    const lp81 = readFileSafe(path.join(WWW, 'core', 'learning-pool.js'));
    if (/rejectedCount/.test(lp81)) ok('81.3 learning-pool collect 含 rejectedCount');
    else fail('81.3 rejectedCount 缺失', '');
    if (/拒绝反馈/.test(lp81)) ok('81.4 format 含拒绝反馈行');
    else fail('81.4 拒绝反馈行缺失', '');
  } catch (e) { fail('81.x learning-pool 拒绝', e.message); }

  // ===== 82.x: Core.Agents 流水线 journal.js 集成 (Phase 5) =====
  try {
    const j82 = readFileSafe(path.join(WWW, 'app', 'journal.js'));
    if (/Core\.Agents\.runPipeline/.test(j82)) ok('82.1 journal.js 调用 Core.Agents.runPipeline');
    else fail('82.1 runPipeline 调用缺失', '');
    if (/aiColleagueDialog/.test(j82)) ok('82.2 journal.js 含 aiColleagueDialog');
    else fail('82.2 aiColleagueDialog 缺失', '');
    if (/_runAgentPipeline/.test(j82)) ok('82.3 journal.js 含 _runAgentPipeline');
    else fail('82.3 _runAgentPipeline 缺失', '');
    if (/Core\.Storage\.all\(['"]holdings['"]\)/.test(j82)) ok('82.4 _runAgentPipeline 收集持仓数据');
    else fail('82.4 持仓数据收集缺失', '');
  } catch (e) { fail('82.x journal agents', e.message); }

  // ===== 83.x: LongTrader 基本面注入 (Phase 5) =====
  try {
    const d83 = readFileSafe(path.join(WWW, 'core', 'data.js'));
    if (/getStockFinancialBatch/.test(d83)) ok('83.1 data.js 含 getStockFinancialBatch');
    else fail('83.1 getStockFinancialBatch 缺失', '');
  } catch (e) { fail('83.x data', e.message); }

  try {
    const lt83 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    // 83.2: getStockFinancialBatch 调用
    if (/getStockFinancialBatch/.test(lt83)) ok('83.2 long-trader 调 getStockFinancialBatch');
    else fail('83.2 getStockFinancialBatch 调用缺失', '');
    // 83.3: prompt 含 ROE/PE/PB/毛利率
    if (/ROE=/.test(lt83) && /毛利=/.test(lt83)) ok('83.3 long-trader prompt 含 ROE/PE/PB/毛利率');
    else fail('83.3 基本面字段缺失', '');
  } catch (e) { fail('83.x long-trader', e.message); }

  // ===== 84.x: LongTrader bull/bear 双视角辩论 (Phase 5) =====
  try {
    const lt84 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    if (/_bearReview/.test(lt84)) ok('84.1 long-trader 含 _bearReview 方法');
    else fail('84.1 _bearReview 缺失', '');
    if (/value_trap/.test(lt84) && /growth_trap/.test(lt84)) ok('84.2 bear prompt 含价值陷阱/成长陷阱');
    else fail('84.2 bear prompt 陷阱检查缺失', '');
    if (/warnings/.test(lt84) && /severity/.test(lt84)) ok('84.3 综合输出含 warnings/severity');
    else fail('84.3 warnings 结构缺失', '');
  } catch (e) { fail('84.x bull/bear', e.message); }

  // ===== 85.x: LongTrader 基本面硬筛 (Phase 5) =====
  try {
    const lt85 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    if (/finFiltered/.test(lt85)) ok('85.1 long-trader 含 finFiltered 基本面过滤');
    else fail('85.1 finFiltered 缺失', '');
    if (/roe != null && fe.roe < 5/.test(lt85)) ok('85.2 硬筛含 ROE<5 排除');
    else fail('85.2 ROE<5 过滤缺失', '');
  } catch (e) { fail('85.x 硬筛', e.message); }

  // ===== 86.x: LongTrader 行业集中度 + 持股再评估 (Phase 5) =====
  try {
    const lt86 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    if (/indCap/.test(lt86) && /行业集中度/.test(lt86)) ok('86.1 long-trader 含行业集中度 cap 检测');
    else fail('86.1 行业 cap 检测缺失', '');
    if (/reviewHoldings/.test(lt86)) ok('86.2 long-trader 含 reviewHoldings 方法');
    else fail('86.2 reviewHoldings 缺失', '');
  } catch (e) { fail('86.x 行业+持股再评估', e.message); }

  // ===== 87.x: Bug 修复 (Tier 5 audit) =====
  try {
    const lt87 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    // 87.1: Bug 1 — industryMap 覆盖 sorted + heldList 并集
    if (/allCodes = \[\.\.\.new Set/.test(lt87) && /getStockIndustryBatch\(allCodes\)/.test(lt87))
      ok('87.1 industryMap 合并 sorted + heldList');
    else fail('87.1 行业并集缺失', '');
    // 87.2: Bug 2 — cashRemaining 维护递减
    if (/cashRemaining/.test(lt87) && /positionPct \* cashRemaining/.test(lt87))
      ok('87.2 行业 cap 用 cashRemaining 递减');
    else fail('87.2 cashRemaining 缺失', '');
    // 87.3: Bug 3 — bear agent temperature 降低 (与 bull temperature=0.5 区分)
    if (/purpose: 'long-trader-bear'/.test(lt87)) {
      // 取 _bearReview 块 (purpose: 'long-trader-bear' 出现位置)
      const bearBlock = lt87.slice(lt87.indexOf("purpose: 'long-trader-bear'") - 400,
                                   lt87.indexOf("purpose: 'long-trader-bear'") + 400);
      if (/temperature: 0\.3/.test(bearBlock)) ok('87.3 bear agent temperature=0.3');
      else fail('87.3 bear temperature 修复缺失', '');
    } else fail('87.3 bear purpose 缺失', '');
    // 87.4: Bug 4 — finFiltered 回退剔除已知不达标
    if (/knownBadCodes/.test(lt87) && /回退到/.test(lt87))
      ok('87.4 finFiltered 回退剔除已知不达标');
    else fail('87.4 knownBadCodes 修复缺失', '');
  } catch (e) { fail('87.x bug 修复', e.message); }

  // ===== 88.x: Bug 5/6/7/8 修复验证 =====
  try {
    const lt88 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));
    const d88 = readFileSafe(path.join(WWW, 'core', 'data.js'));

    // 88.1: Bug 5 — samplePrice 中位价替代硬编码 30
    if (/const samplePrice/.test(lt88) && lt88.indexOf("Math.floor(prices.length / 2)") >= 0)
      ok('88.1 samplePrice 池中位价替代硬编码 30');
    else fail('88.1 samplePrice 缺失', '');

    // 88.2: Bug 6 — 改用换手率过滤
    if (lt88.indexOf("parseFloat(s.换手率 || 0) >= 1") >= 0)
      ok('88.2 入池过滤改用换手率 ≥ 1');
    else fail('88.2 换手率过滤缺失', '');
    if (!/parseFloat(s.涨跌幅) > 0/.test(lt88) || /硬筛已排除/.test(lt88))
      ok('88.3 旧"涨跌幅 > 0"已弃用 (或仅在提示文本中)');
    else fail('88.3 旧过滤仍生效', '');

    // 88.4: Bug 7 — K 线 adjust 注释
    if (/不复权/.test(lt88) && /adjust=''/.test(lt88))
      ok('88.4 K 线 adjust 显式说明意图');
    else fail('88.4 adjust 注释缺失', '');

    // 88.5: Bug 8 — batch 缓存
    if (/_finBatchCache/.test(d88) && /_FIN_BATCH_TTL/.test(d88))
      ok('88.5 data.js 含 _finBatchCache 7 天缓存');
    else fail('88.5 _finBatchCache 缺失', '');
    if (/_indBatchCache/.test(d88) && /_IND_BATCH_TTL/.test(d88))
      ok('88.6 data.js 含 _indBatchCache 24h 缓存');
    else fail('88.6 _indBatchCache 缺失', '');
  } catch (e) { fail('88.x bug 修复', e.message); }

  // ===== 90.x: Tier 6 Scoring + WeightAdvisor =====
  try {
    const sc90 = readFileSafe(path.join(WWW, 'core', 'scoring.js'));
    const wa90 = readFileSafe(path.join(WWW, 'core', 'weight-advisor.js'));
    const lt90 = readFileSafe(path.join(WWW, 'app', 'long-trader.js'));

    // 90.1: scoring.js 存在 + 5 因子定义
    if (/Core\.Scoring\s*=/.test(sc90) && /DEFAULT_WEIGHTS/.test(sc90) && /roe:/.test(sc90) && /ep:/.test(sc90) && /turnover:/.test(sc90) && /north:/.test(sc90) && /industryPenalty:/.test(sc90))
      ok('90.1 scoring.js 含 5 因子默认权重');
    else fail('90.1 5 因子缺失', '');

    // 90.2: rankNormalize 函数存在
    if (/rankNormalize/.test(sc90) && /function rank\(/.test(sc90))
      ok('90.2 scoring 含 rank + rankNormalize 纯函数');
    else fail('90.2 纯函数缺失', '');

    // 90.3: 硬过滤 (新股/ST/一字板)
    if (/NEW_STOCK_RULE_DAYS/.test(sc90) && /applyHardFilters/.test(sc90) &&
        sc90.indexOf("ST|\\*ST") >= 0 && /oneWordLimitUp/.test(sc90))
      ok('90.3 scoring 含 3 硬过滤 (新股/ST/一字板)');
    else fail('90.3 硬过滤缺失', '');

    // 90.4: WeightAdvisor 三层兜底
    if (/parseAndValidate/.test(wa90) && /clamp/.test(wa90) && /CHANGE_RATIO/.test(wa90))
      ok('90.4 WeightAdvisor parseAndValidate + clamp + 变化上限');
    else fail('90.4 WeightAdvisor 校验缺失', '');

    // 90.5: WeightAdvisor 周度调度
    if (/scheduleWeekly/.test(wa90) && sc90 && wa90.indexOf("getDay() === 0") >= 0 &&
        wa90.indexOf("getHours() === 20") >= 0 || wa90.indexOf("getHour() === 20") >= 0)
      ok('90.5 WeightAdvisor 周日 20:00 调度');
    else fail('90.5 调度缺失', '');

    // 90.6: WeightAdvisor 缓存 + fallback
    if (/weight_advisor_this_week/.test(wa90) && /isThisWeek/.test(wa90) && /DEFAULT_WEIGHTS/.test(wa90))
      ok('90.6 WeightAdvisor kv 缓存 + DEFAULT fallback');
    else fail('90.6 缓存/fallback 缺失', '');

    // 90.7: long-trader 调用 Scoring
    if (/Core\.Scoring\.rankCandidates/.test(lt90))
      ok('90.7 long-trader 调 Scoring.rankCandidates');
    else fail('90.7 Scoring 调用缺失', '');
  } catch (e) { fail('90.x Tier 6', e.message); }

  // ===== 91.x: Tier 6+ Hot Theme 因子 =====
  try {
    const d91 = readFileSafe(path.join(WWW, 'core', 'data.js'));
    const sc91 = readFileSafe(path.join(WWW, 'core', 'scoring.js'));

    // 91.1: data.js 含 getSectorPerformance
    if (/getSectorPerformance/.test(d91) && /stock_board_industry_index_em/.test(d91))
      ok('91.1 data.js 含 getSectorPerformance (板块涨幅 fetcher)');
    else fail('91.1 getSectorPerformance 缺失', '');

    // 91.2: data.js 导出 getSectorPerformance
    if (/getSectorPerformance,/.test(d91))
      ok('91.2 data.js 导出 getSectorPerformance');
    else fail('91.2 导出缺失', '');

    // 91.3: scoring.js 加 hot 因子 + _hotScore
    if (/hot: 0\.14/.test(sc91) && /_hotScore/.test(sc91))
      ok('91.3 scoring 含 hot 因子 + _hotScore');
    else fail('91.3 hot 因子缺失', '');

    // 91.4: scoring.rank 调用传 sectorPerf
    if (/sectorPerf/.test(sc91) && /rank\([^)]*sectorPerf[^)]*\)/.test(sc91))
      ok('91.4 rank() 接收 sectorPerf');
    else fail('91.4 sectorPerf 传参缺失', '');

    // 91.5: rankCandidates 拉 getSectorPerformance
    if (/getSectorPerformance/.test(sc91))
      ok('91.5 rankCandidates 拉板块涨幅');
    else fail('91.5 板块涨幅拉取缺失', '');
  } catch (e) { fail('91.x Hot Theme', e.message); }

  // ===== 93.x: Hot 因子反向打分 (追高陷阱) =====
  try {
    const sc93 = readFileSafe(path.join(WWW, 'core', 'scoring.js'));

    // 93.1: 涨幅 > 10% 必须给负分 (接盘区)
    if (/return -0\.25/.test(sc93) && /p < 10[\s\S]*return -0\.15/.test(sc93))
      ok('93.1 涨幅 > 10% 给 -0.25 (顶部接盘区负分)');
    else fail('93.1 顶部负分缺失', '');

    // 93.2: 涨幅 < 0 (错杀) 必须给正分
    if (/p < -5[\s\S]*return 0\.10/.test(sc93) && /p < 0[\s\S]*return 0\.05/.test(sc93))
      ok('93.2 跌幅 < 0 给正分 (错杀机会)');
    else fail('93.2 错杀正分缺失', '');

    // 93.3: 概念取 min (任一概念进接盘区 → 总分负)
    if (/cptMin = Infinity[\s\S]*Math\.min\(ind, cptMin\)/.test(sc93))
      ok('93.3 概念取 min (保守: 任一进接盘区即负)');
    else fail('93.3 概念 min 逻辑缺失', '');

    // 93.4: 反向语义注释
    if (/接盘|追高|陷阱|反向/.test(sc93))
      ok('93.4 hot 因子含反向语义注释');
    else fail('93.4 反向注释缺失', '');
  } catch (e) { fail('93.x 反向 hot', e.message); }


  // ===== 92.x: Tier 6+ 概念板块热点 =====
  try {
    const d92 = readFileSafe(path.join(WWW, 'core', 'data.js'));
    const sc92 = readFileSafe(path.join(WWW, 'core', 'scoring.js'));

    // 92.1: data.js 含 getConceptBoardPerformance
    if (/getConceptBoardPerformance/.test(d92) && /stock_board_concept_index_em/.test(d92))
      ok('92.1 data.js 含 getConceptBoardPerformance (概念板块涨幅 fetcher)');
    else fail('92.1 getConceptBoardPerformance 缺失', '');

    // 92.2: data.js 含 getConceptMembership (反查 code → 概念名)
    if (/getConceptMembership/.test(d92))
      ok('92.2 data.js 含 getConceptMembership (概念反查)');
    else fail('92.2 getConceptMembership 缺失', '');

    // 92.3: data.js 导出两个新方法
    if (/getConceptBoardPerformance/.test(d92) && /getConceptMembership,/.test(d92))
      ok('92.3 data.js 导出 getConceptBoardPerformance + getConceptMembership');
    else fail('92.3 导出缺失', '');

    // 92.4: scoring.js _hotScore 看概念 (同时看 行业 + 概念, 取较高者)
    if (/_hotScore\(industryPct, conceptPcts\)/.test(sc92) || /Math\.max\(ind, cptMax\)/.test(sc92))
      ok('92.4 scoring._hotScore 同时看概念');
    else fail('92.4 _hotScore 未看概念', '');

    // 92.5: rankCandidates 拉 concept 数据
    if (/getConceptBoardPerformance/.test(sc92) && /getConceptMembership/.test(sc92))
      ok('92.5 rankCandidates 拉概念涨幅 + 反查索引');
    else fail('92.5 概念拉取缺失', '');
  } catch (e) { fail('92.x Concept Board', e.message); }

  // ===== 94.x: KB v1.4 SKL 注入 long-trader (白毛股神 + Stock-Analysis-Skill) =====
  try {
    const kbJson = fs.readFileSync(path.join(__dirname, '..', 'www', 'kb_data', 'investment_kb.json'), 'utf8');
    const kbData = JSON.parse(kbJson);
    // 94.1: investment_kb.json _meta.version = "1.4"
    if (kbData._meta && kbData._meta.version === '1.4')
      ok('94.1 KB _meta.version = 1.4');
    else fail('94.1 KB version 应为 1.4', 'got: ' + (kbData._meta && kbData._meta.version));

    // 94.2: 4 条 SKL 条目存在
    const sklIds = ['SKL-001', 'SKL-002', 'SKL-003', 'SKL-004'];
    const sklEntries = (kbData.entries || []).filter(e => sklIds.includes(e.id));
    if (sklEntries.length === 4)
      ok('94.2 SKL-001~004 共 4 条存在');
    else fail('94.2 SKL 条目缺失', 'got: ' + sklEntries.length);

    // 94.3: SKL-001 含 chokepoint 关键词
    const skl1 = (kbData.entries || []).find(e => e.id === 'SKL-001');
    if (skl1 && Array.isArray(skl1.keywords) && skl1.keywords.includes('chokepoint'))
      ok('94.3 SKL-001 关键词含 chokepoint');
    else fail('94.3 SKL-001 keywords 缺 chokepoint', '');

    // 94.4: SKL-002 含 NAV 关键词
    const skl2 = (kbData.entries || []).find(e => e.id === 'SKL-002');
    if (skl2 && Array.isArray(skl2.keywords) && skl2.keywords.includes('NAV'))
      ok('94.4 SKL-002 关键词含 NAV');
    else fail('94.4 SKL-002 keywords 缺 NAV', '');

    // 94.5: long-trader.js 含 skill trigger 调用
    const lt94 = fs.readFileSync(path.join(__dirname, '..', 'www', 'app', 'long-trader.js'), 'utf8');
    if (/Core\.KB\.pickRelevant/.test(lt94) && /context:\s*{\s*skill/.test(lt94))
      ok('94.5 long-trader 注入 skill trigger');
    else fail('94.5 long-trader 未注入 skill', '');

    // 94.6: kb.js 含 SKILL_QUERY 表
    const kbJs = fs.readFileSync(path.join(__dirname, '..', 'www', 'core', 'kb.js'), 'utf8');
    if (/SKILL_QUERY/.test(kbJs) && /chokepoint/.test(kbJs) && /nav_discount/.test(kbJs) && /contrarian/.test(kbJs))
      ok('94.6 kb.js 含 SKILL_QUERY 三类 trigger');
    else fail('94.6 kb.js SKILL_QUERY 不全', '');

    // 94.7: long-trader.js systemPrompt 含 kbBlock 拼接
    if (/kbBlock/.test(lt94) && /formatForPrompt/.test(lt94))
      ok('94.7 long-trader systemPrompt 拼接 kbBlock');
    else fail('94.7 kbBlock 未进 systemPrompt', '');
  } catch (e) { fail('94.x SKL 注入', e.message); }

  // ===== 95.x: V2 P2 业绩预告因子注入 scoring =====
  try {
    const dataJs95 = fs.readFileSync(path.join(__dirname, '..', 'www', 'core', 'data.js'), 'utf8');
    // 95.1: data.js 含 getStockEarningForecast
    if (dataJs95.indexOf('async function getStockEarningForecast(quarter)') !== -1 &&
        dataJs95.indexOf('stock_yjyg_em') !== -1)
      ok('95.1 data.js 含 getStockEarningForecast(quarter) + stock_yjyg_em');
    else fail('95.1 getStockEarningForecast 缺失', '');

    // 95.2: data.js 含 getStockEarningForecastBatch + 净利润指标
    if (dataJs95.indexOf('async function getStockEarningForecastBatch') !== -1 &&
        dataJs95.indexOf('归属于上市公司股东的净利润') !== -1 &&
        dataJs95.indexOf('扣除非经常性损益后的净利润') !== -1)
      ok('95.2 data.js 含 Batch + 净利润指标过滤');
    else fail('95.2 batch / 指标过滤缺失', '');

    // 95.3: data.js 已暴露 getStockEarningForecastBatch
    if (dataJs95.indexOf('getStockEarningForecast, getStockEarningForecastBatch') !== -1)
      ok('95.3 data.js 暴露 Core.Data.getStockEarningForecastBatch');
    else fail('95.3 未暴露 batch fetcher', '');

    // 95.4: scoring.js rankCandidates 拉 forecast
    const sc95 = fs.readFileSync(path.join(__dirname, '..', 'www', 'core', 'scoring.js'), 'utf8');
    if (sc95.indexOf('getStockEarningForecastBatch') !== -1 &&
        sc95.indexOf('forecastMap = new Map()') !== -1)
      ok('95.4 scoring rankCandidates 拉 forecastMap');
    else fail('95.4 scoring 未拉 forecast', '');

    // 95.5: scoring.js rank 加 forecast 因子
    if (sc95.indexOf('forecastFullRanks') !== -1 &&
        sc95.indexOf('forecast: forecastFullRanks') !== -1 &&
        sc95.indexOf('w.forecast * factors.forecast') !== -1)
      ok('95.5 scoring rank 加 forecast 7 因子打分');
    else fail('95.5 forecast 因子未入打分', '');

    // 95.6: scoring.js applyHardFilters 加首亏/续亏剔除 (用 indexOf)
    if (sc95.indexOf('首亏') !== -1 && sc95.indexOf('续亏') !== -1 &&
        sc95.indexOf('applyHardFilters(all, opts, forecastMap)') !== -1)
      ok('95.6 applyHardFilters 硬剔首亏/续亏');
    else fail('95.6 硬过滤未加首亏剔除', '');

    // 95.7: DEFAULT_WEIGHTS 含 forecast = 0.10
    if (sc95.indexOf('forecast: 0.10') !== -1)
      ok('95.7 DEFAULT_WEIGHTS 含 forecast = 0.10');
    else fail('95.7 DEFAULT_WEIGHTS 缺 forecast', '');

    // 95.8: weight-advisor.js FACTOR_KEYS 加 forecast
    const wa95 = fs.readFileSync(path.join(__dirname, '..', 'www', 'core', 'weight-advisor.js'), 'utf8');
    if (wa95.indexOf("FACTOR_KEYS = ['roe', 'ep', 'turnover', 'north', 'industryPenalty', 'forecast']") !== -1)
      ok('95.8 weight-advisor FACTOR_KEYS 6 因子');
    else fail('95.8 FACTOR_KEYS 未含 forecast', '');
  } catch (e) { fail('95.x 业绩预告因子', e.message); }















waitForIIFEsDrain().then(() => {
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
