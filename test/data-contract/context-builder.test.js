/**
 * ContextBuilder 单测 — Phase 2.3
 *
 * 覆盖:
 *   1. 'observe' strategy 拉 watchlist + 不拉 holdings
 *   2. 'diagnose' strategy 拉 holdings + alerts + recentJournals + portfolio/macro/marketWidth
 *   3. Promise.allSettled: portfolio/macro/marketWidth 任一失败不污染其他
 *   4. partialErrors 含失败的 source + msg
 *   5. sourceDigest 由 quote envelopes 聚合生成
 *   6. renderForPrompt 输出含 ## 数据来源摘要 + ## 数据缺失警告
 *   7. holdings 走 Facade.getQuoteMany 批量, 不逐只拉
 *   8. 'today' strategy 拉 todayTransactions
 *   9. 空 watchlist / 空 holdings 不报错
 *   10. opts.paper 控制 holdings 是否包含模拟盘
 *
 * 跑法: node test/data-contract/context-builder.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'schema.js'), 'utf8');
const NORM_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'normalize.js'), 'utf8');
const PROV_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'provenance.js'), 'utf8');
const FACADE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'facade.js'), 'utf8');
const CB_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'context-builder.js'), 'utf8');

function buildSandbox({ portfolioOk = true, macroOk = true, marketWidthOk = true, watchlist = [], holdings = [] } = {}) {
  const sandbox = { window: {}, console };
  sandbox.window.Core = { Data: {} };
  sandbox.Core = sandbox.window.Core;

  const store = {};
  sandbox.Core.Storage = {
    cacheGet: async k => store[k] || null,
    cacheSet: async (k, v) => { store[k] = v; },
    all: async (collection) => {
      if (collection === 'watchlist') return watchlist;
      if (collection === 'holdings') return holdings;
      if (collection === 'alerts') return [];
      if (collection === 'journals') return [];
      if (collection === 'transactions') return [];
      return [];
    }
  };

  // mock portfolio / macro / marketWidth
  sandbox.Core.Portfolio = {
    getAssets: async () => portfolioOk ? { cash: 100000, stockMkt: 50000, fundMkt: 0 } : (() => { throw new Error('portfolio fail'); })()
  };
  sandbox.Core.Macro = {
    get: async () => macroOk ? { cpi: 2.5 } : (() => { throw new Error('macro fail'); })(),
    formatForPrompt: (m) => m ? `CPI=${m.cpi}` : null
  };
  sandbox.Core.MarketWidth = {
    getMarketWidth: async () => marketWidthOk ? { upCount: 3500, downCount: 1500 } : (() => { throw new Error('marketWidth fail'); })()
  };

  // mock facade fetcher (tencent only)
  let tencentCalls = 0;
  sandbox.Core.Data.getStockSpotTencent = async (codes) => {
    tencentCalls++;
    return codes.map(c => ({
      '代码': c, '名称': `Mock-${c}`,
      '最新价': '1730.00', '昨收': '1720.00',
      '今开': '1725.00', '最高': '1735.00', '最低': '1718.00',
      '成交量': '12345', '总成交额': '45678.90',
      '换手率': '0.85', '市盈率': '28.5',
      '流通市值': '21730.50', '总市值': '21730.50',
      '涨跌额': '10.00', '涨跌幅': '0.58%',
      '时间': '20260730103000'
    }));
  };
  sandbox.Core.Data._sinaFetch = async () => { throw new Error('n/a'); };
  sandbox.Core.Data.fetch = async () => { throw new Error('n/a'); };
  sandbox.tencentCalls = () => tencentCalls;

  vm.createContext(sandbox);
  vm.runInContext(SCHEMA_SRC, sandbox, { filename: 'schema.js' });
  vm.runInContext(NORM_SRC, sandbox, { filename: 'normalize.js' });
  vm.runInContext(PROV_SRC, sandbox, { filename: 'provenance.js' });
  vm.runInContext(FACADE_SRC, sandbox, { filename: 'facade.js' });
  vm.runInContext(CB_SRC, sandbox, { filename: 'context-builder.js' });

  return sandbox;
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
const _describes = [];
function describe(name, fn) { console.log('\n' + name); _describes.push(fn()); }
async function runDescribes() { for (const d of _describes) await d; }

(async () => {

// ===== 情形 1: 'observe' strategy 拉 watchlist, 不拉 holdings =====
describe('情形 1: observe strategy → watchlist only', async () => {
  const sb = buildSandbox({ watchlist: [{ code: '600519' }, { code: '000001' }] });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('observe');
  assert(ctx.strategy === 'observe', 'strategy = observe');
  assert(Array.isArray(ctx.slices.watchlist) && ctx.slices.watchlist.length === 2, 'watchlist 长度=2');
  assert(ctx.slices.holdings === undefined, 'holdings 未拉');
  assert(ctx.slices.alerts === undefined, 'alerts 未拉');
  assert(ctx.slices.portfolio === undefined, 'portfolio 未拉');
  assert(ctx.slices.recentJournals === undefined, 'recentJournals 未拉');
  assert(ctx.sourceDigest && ctx.sourceDigest.includes('tengxun'), 'sourceDigest 聚合 quote envelopes');
});

// ===== 情形 2: 'diagnose' strategy 全 slice =====
describe('情形 2: diagnose strategy → holdings + alerts + journals + portfolio/macro/marketWidth', async () => {
  const sb = buildSandbox({
    watchlist: [{ code: '600519' }],
    holdings: [{ code: '600519', name: '茅台', qty: 100, costPrice: 1500, isPaper: false }]
  });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  assert(ctx.slices.holdings && ctx.slices.holdings.length === 1, 'holdings 含 1 条');
  assert(ctx.slices.holdings[0].currentPrice === 1730, 'holdings[0].currentPrice = 1730 (走 facade)');
  assert(ctx.slices.holdings[0].quoteEnvelope && ctx.slices.holdings[0].quoteEnvelope.symbol === '600519', 'holdings[0].quoteEnvelope 注入');
  assert(Array.isArray(ctx.slices.watchlist) && ctx.slices.watchlist.length === 1, 'watchlist 含 1 条');
  assert(Array.isArray(ctx.slices.alerts), 'alerts 是数组');
  assert(Array.isArray(ctx.slices.recentJournals), 'recentJournals 是数组');
  assert(ctx.slices.portfolio && ctx.slices.portfolio.cash === 100000, 'portfolio 拉到');
  assert(ctx.slices.macro === 'CPI=2.5', 'macro 格式化正确');
  assert(ctx.slices.marketWidth && ctx.slices.marketWidth.upCount === 3500, 'marketWidth 拉到');
});

// ===== 情形 3: Promise.allSettled 语义 — macro fail 不影响 portfolio =====
describe('情形 3: portfolio/macro/marketWidth 任一失败不污染', async () => {
  const sb = buildSandbox({ macroOk: false });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  assert(ctx.slices.portfolio && ctx.slices.portfolio.cash === 100000, 'portfolio 仍正常');
  assert(ctx.slices.macro === null, 'macro 失败 → null');
  assert(ctx.slices.marketWidth && ctx.slices.marketWidth.upCount === 3500, 'marketWidth 仍正常');
});

// ===== 情形 4: partialErrors 含失败 source + msg =====
describe('情形 4: partialErrors 记录失败 source', async () => {
  const sb = buildSandbox({ portfolioOk: false, macroOk: false, marketWidthOk: false });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  const sources = ctx.partialErrors.map(e => e.source);
  assert(sources.includes('portfolio'), 'partialErrors 含 portfolio');
  assert(sources.includes('macro'), 'partialErrors 含 macro');
  assert(sources.includes('marketWidth'), 'partialErrors 含 marketWidth');
  ctx.partialErrors.forEach(e => assert(typeof e.msg === 'string' && e.msg.length > 0, `${e.source} msg 非空`));
});

// ===== 情形 5: sourceDigest 由 quote envelopes 聚合 =====
describe('情形 5: sourceDigest 聚合 quote envelopes', async () => {
  const sb = buildSandbox({ watchlist: [{ code: '600519' }] });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('observe');
  assert(typeof ctx.sourceDigest === 'string', 'sourceDigest 是字符串');
  assert(ctx.sourceDigest.includes('tengxun'), 'sourceDigest 含 provider');
  assert(ctx.sourceDigest.includes('realtime'), 'sourceDigest 含 freshness');
});

// ===== 情形 6: renderForPrompt 含 ## 数据来源摘要 + ## 数据缺失警告 =====
describe('情形 6: renderForPrompt 输出格式', async () => {
  // 含 watchlist → sourceDigest 非空 → 含 ## 数据来源摘要
  const sb = buildSandbox({ watchlist: [{ code: '600519' }], portfolioOk: false });
  const ctx = await sb.window.Core.Data.ContextBuilder.build('observe');
  const md = sb.window.Core.Data.ContextBuilder.renderForPrompt(ctx);
  assert(md.includes('## Context'), 'md 含 ## Context');
  assert(md.includes('strategy=observe'), 'md 含 strategy 标签');
  assert(md.includes('## 数据来源摘要'), 'md 含 ## 数据来源摘要');
  // 单独看 partialErrors-only 场景
  const sb2 = buildSandbox({ portfolioOk: false });
  const ctx2 = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  const md2 = sb2.window.Core.Data.ContextBuilder.renderForPrompt(ctx2);
  assert(md2.includes('## 数据缺失警告'), 'partialErrors-only md 含 ## 数据缺失警告');
  assert(md2.includes('portfolio:'), 'partialErrors-only md 含 portfolio 失败项');
});

// ===== 情形 7: holdings 走 Facade.getQuoteMany 批量 =====
describe('情形 7: holdings 走批量 (tencent 调 1 次)', async () => {
  const sb = buildSandbox({
    holdings: [
      { code: '600519', name: '茅台', qty: 100, costPrice: 1500, isPaper: false },
      { code: '000001', name: '平安', qty: 200, costPrice: 12, isPaper: false },
      { code: '600036', name: '招行', qty: 300, costPrice: 30, isPaper: false }
    ]
  });
  await sb.window.Core.Data.ContextBuilder.build('diagnose');
  assert(sb.tencentCalls() === 1, 'tencent 调 1 次 (批量)');
});

// ===== 情形 8: 'today' strategy 拉 todayTransactions =====
describe('情形 8: today strategy → todayTransactions', async () => {
  const sb = buildSandbox({ watchlist: [{ code: '600519' }] });
  // mock transactions
  const todayTs = Date.now();
  const yesterdayTs = todayTs - 86400000 * 2;
  sb.Core.Storage.all = async (collection) => {
    if (collection === 'transactions') {
      return [
        { code: '600519', side: 'buy', qty: 100, ts: todayTs },
        { code: '000001', side: 'sell', qty: 200, ts: yesterdayTs }  // 昨天的, 不应出现
      ];
    }
    if (collection === 'watchlist') return [{ code: '600519' }];
    return [];
  };
  const ctx = await sb.window.Core.Data.ContextBuilder.build('today');
  assert(Array.isArray(ctx.slices.todayTransactions), 'todayTransactions 是数组');
  assert(ctx.slices.todayTransactions.length === 1, '只含今日 1 条 (昨天被过滤)');
  assert(ctx.slices.todayTransactions[0].code === '600519', 'todayTransactions[0] = 600519');
});

// ===== 情形 9: 空 watchlist / 空 holdings 不报错 =====
describe('情形 9: 空数据不报错', async () => {
  const sb = buildSandbox({ watchlist: [], holdings: [] });
  const ctx1 = await sb.window.Core.Data.ContextBuilder.build('observe');
  assert(Array.isArray(ctx1.slices.watchlist) && ctx1.slices.watchlist.length === 0, '空 watchlist');
  assert(ctx1.sourceDigest === '', '空 sourceDigest = ""');
  const ctx2 = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  assert(ctx2.slices.holdings.length === 0, '空 holdings');
  assert(ctx2.sourceDigest === '', 'diagnose 空 sourceDigest = ""');
});

// ===== 情形 10: opts.paper=true 时 holdings 含模拟盘 =====
describe('情形 10: opts.paper 控制模拟盘 inclusion', async () => {
  const sb = buildSandbox({
    holdings: [
      { code: '600519', name: '茅台', qty: 100, isPaper: false },
      { code: '600000', name: '浦发', qty: 1000, isPaper: true }
    ]
  });
  // 默认 paper=false (只看实盘)
  const ctx1 = await sb.window.Core.Data.ContextBuilder.build('diagnose');
  assert(ctx1.slices.holdings.length === 1, '默认不含模拟盘 (1 条实盘)');
  assert(ctx1.slices.holdings[0].code === '600519', '第一条是 600519 实盘');
  // paper=true
  const ctx2 = await sb.window.Core.Data.ContextBuilder.build('diagnose', { paper: true });
  assert(ctx2.slices.holdings.length === 2, 'paper=true 含模拟盘 (2 条)');
});

await runDescribes();

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail > 0 ? 1 : 0);

})();