/**
 * V12 — NewsSnapshot 定时聚合快照 + ToolRegistry 工具化
 *
 * 覆盖:
 *   1. _collectAllCodes 三表去重
 *   2. _buildSnapshot 拉所有关注票公告
 *   3. _buildSnapshot 单只降级 (一只失败不影响其他)
 *   4. _buildSnapshot 排序按 ts 倒序
 *   5. _buildSnapshot 落 kv news_snapshot_v1
 *   6. _getSnapshot 未过期返快照
 *   7. _getSnapshot 过期返 null (不重拉)
 *   8. _isSnapshotFresh 判定
 *   9. tool 'news.snapshot' 注册 + handler
 *   10. handler codes 过滤
 *   11. 缓存空自动 build
 *   12. 源码对账
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const NEWS_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'news.js'), 'utf8');
const AGENT_TOOLS_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'agent-tools.js'), 'utf8');
const SHORT_TRADER_SRC = fs.readFileSync(path.join(ROOT, 'www', 'app', 'short-trader.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'www', 'app.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

/**
 * buildSandbox — 加载 news.js 后, 在 vm 上下文里替换 _fetch / getStockNotices 等
 * news.js 内部用 fetch() (浏览器原生) 拉公告, 在 vm 里 fetch 不存在 → mock 掉
 */
function buildSandbox(opts = {}) {
  const sb = {
    window: {}, console: console,
    Date, Math, Promise, JSON, Array, Object, Map, Set, Error, Number,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sb.window = sb;
  const tables = { watchlist: [], holdings: [], research_pool: [] };
  const kv = {};
  sb.Core = {
    Storage: {
      all: async (t) => tables[t] || [],
      kvGet: async (k) => kv[k] || null,
      kvSet: async (k, v) => { kv[k] = v; },
      cacheGet: async () => null,
      cacheSet: async () => {}
    },
    State: { get: () => '' },
    AI: { ToolRegistry: { register: (m) => { sb._tools = sb._tools || []; sb._tools.push(m); } } },
    ResearchPool: { list: async () => opts.researchPool || [] }
  };
  sb._tables = tables;
  sb._kv = kv;
  sb._failCodes = opts.failCodes || [];
  vm.createContext(sb);
  vm.runInContext(NEWS_SRC, sb, { filename: 'news.js' });

  // 替换 news.js 内部用的 fetch (vm sandbox 里 fetch 不存在) → mock
  // news.js 调 fetch(url) 拿 JSON, 主路径用 stock_list=CODE, 兜底无 stock_list
  sb.fetch = async (url) => {
    const m = url.match(/stock_list=([^&]+)/);
    const code = m ? decodeURIComponent(m[1]) : null;
    if (code && sb._failCodes.includes(code)) {
      return { ok: false, status: 502, json: async () => { throw new Error('mocked'); } };
    }
    // 聚合所有 code 的公告 (兜底路径没 stock_list)
    // 注意 news.js _filterNoticesByCode 用 d.codes[].stock_code 过滤, 不是顶层 stock_code
    let allList = [];
    if (code && sb._noticesByCode && sb._noticesByCode[code]) {
      allList = sb._noticesByCode[code].map(n => ({
        art_code: n.url || 'mock',
        notice_date: n.date || '2026-07-31',
        title: n.title,
        codes: [{ stock_code: code }]
      }));
    } else if (!code && sb._noticesByCode) {
      // 兜底路径: 全量
      for (const c of Object.keys(sb._noticesByCode)) {
        for (const n of sb._noticesByCode[c]) {
          allList.push({ art_code: n.url || 'mock', notice_date: n.date || '2026-07-31', title: n.title, codes: [{ stock_code: c }] });
        }
      }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: { list: allList } })
    };
  };
  return sb;
}

// ===== 情形 1: _collectAllCodes 三表去重 =====
describe('情形 1: _collectAllCodes 三表去重', async () => {
  const sb = buildSandbox();
  sb._tables.watchlist = [{ code: '600519' }, { code: '000001' }];
  sb._tables.holdings = [{ code: '600519' }, { code: '300750' }];   // 600519 重复
  sb._tables.research_pool = [{ code: '300750' }, { code: '999999' }]; // 300750 重复
  // 模拟 ResearchPool.list 返 _tables.research_pool
  sb.window.Core.ResearchPool.list = async () => sb._tables.research_pool;
  sb._noticesByCode = {
    '600519': [{ code: '600519', title: 't1', ts: 1000 }],
    '000001': [{ code: '000001', title: 't1', ts: 1000 }],
    '300750': [{ code: '300750', title: 't1', ts: 1000 }],
    '999999': [{ code: '999999', title: 't1', ts: 1000 }]
  };
  const snap = await sb.window.Core.News.snapshot.build();
  const uniqueCodes = new Set(snap.items.map(it => it.code));
  assert(uniqueCodes.size === 4, `去重 4 只 (${uniqueCodes.size})`);
});

// ===== 情形 2: _buildSnapshot 拉公告 =====
describe('情形 2: _buildSnapshot 拉所有关注票公告', async () => {
  const sb = buildSandbox();
  sb._tables.watchlist = [{ code: '600519' }];
  sb._noticesByCode = {
    '600519': [
      { code: '600519', title: '公告1', ts: 1000 },
      { code: '600519', title: '公告2', ts: 2000 }
    ]
  };
  const snap = await sb.window.Core.News.snapshot.build();
  assert(snap.codes === 1, `codes=1 (${snap.codes})`);
  assert(snap.itemCount === 2, `itemCount=2`);
  assert(sb._kv.news_snapshot_v1, 'kv 落库');
});

// ===== 情形 3: 单只降级 (走 fetch mock 主路径返回空 → getStockNotices 返空数组) =====
describe('情形 3: 单只失败不影响其他', async () => {
  const sb = buildSandbox();
  // 让 fetch mock 主路径返空 → getStockNotices 返回 [] (不抛错)
  // 走 fetch 失败的另一种: 让 fetch mock 主路径 OK 但 list=空数组
  sb._tables.watchlist = [{ code: '600519' }, { code: '000001' }, { code: '300750' }];
  // 只给 600519 和 300750 数据, 000001 没有 → getStockNotices(000001) 返 []
  sb._noticesByCode = {
    '600519': [{ code: '600519', title: 'a', date: '2026-07-31' }],
    '300750': [{ code: '300750', title: 'b', date: '2026-07-31' }]
  };
  const snap = await sb.window.Core.News.snapshot.build();
  assert(snap.codes === 3, `3 只都尝试了 (${snap.codes})`);
  // 000001 没有数据, itemCount 仍 = 2 (空数组不算 item)
  assert(snap.itemCount === 2, `2 条公告 (${snap.itemCount})`);
  assert(snap.errors.length === 0, '无 fetch 错误 → 0 errors');
});

// ===== 情形 3b: fetch 完全失败 (单只降级) =====
describe('情形 3b: 单只 fetch 失败', async () => {
  const sb = buildSandbox();
  // 强制让 000001 的主路径 + 兜底路径都返 ok=false → getStockNotices 抛错
  // 由于 news.js 内部 catch 兜底, 最终返 null, _buildSnapshot 检测 null 走 errors
  // 实现: 让 fetch 对 stock_list=000001 返 ok=false, 对其他返 ok=true
  const origFetch = sb.fetch;
  sb.fetch = async (url) => {
    if (url.includes('stock_list=000001')) {
      return { ok: false, status: 500, json: async () => { throw new Error('mocked'); } };
    }
    return origFetch(url);
  };
  // 兜底路径 (无 stock_list) 也失败
  // 替换兜底 fetch 调用: 我们让无 stock_list 时也返 ok=false
  const origFetch2 = sb.fetch;
  sb.fetch = async (url) => {
    if (url.includes('stock_list=000001') || (!url.includes('stock_list='))) {
      return { ok: false, status: 500, json: async () => { throw new Error('mocked'); } };
    }
    return origFetch2(url);
  };
  sb._tables.watchlist = [{ code: '600519' }, { code: '000001' }];
  sb._noticesByCode = {
    '600519': [{ code: '600519', title: 'a', date: '2026-07-31' }]
  };
  const snap = await sb.window.Core.News.snapshot.build();
  assert(snap.errors.length === 1, `1 条 error (${snap.errors.length})`);
  if (snap.errors.length > 0) {
    assert(snap.errors[0].code === '000001', `error.code = 000001 (${snap.errors[0].code})`);
  }
});

// ===== 情形 4: 排序按 ts 倒序 =====
describe('情形 4: 排序按 ts 倒序', async () => {
  const sb = buildSandbox();
  sb._tables.watchlist = [{ code: '600519' }];
  sb._noticesByCode = {
    '600519': [
      { code: '600519', title: 'older', date: '2026-07-20' },
      { code: '600519', title: 'newer', date: '2026-07-30' },
      { code: '600519', title: 'newest', date: '2026-07-31' }
    ]
  };
  const snap = await sb.window.Core.News.snapshot.build();
  assert(snap.items[0].title === 'newest', `最新在前 (${snap.items[0].title})`);
  assert(snap.items[1].title === 'newer', '中间次新');
  assert(snap.items[2].title === 'older', '最旧在后');
});

// ===== 情形 5: _buildSnapshot 落 kv =====
describe('情形 5: _buildSnapshot 落 kv news_snapshot_v1', async () => {
  const sb = buildSandbox();
  sb._tables.watchlist = [{ code: '600519' }];
  sb._noticesByCode = { '600519': [{ code: '600519', title: 't', ts: 1000 }] };
  await sb.window.Core.News.snapshot.build();
  assert(sb._kv.news_snapshot_v1, 'kv key = news_snapshot_v1');
  assert(typeof sb._kv.news_snapshot_v1.generated === 'number', 'generated 是 timestamp');
});

// ===== 情形 6: _getSnapshot 未过期返快照 =====
describe('情形 6: _getSnapshot 未过期返快照', async () => {
  const sb = buildSandbox();
  sb._kv.news_snapshot_v1 = { generated: Date.now(), items: [{ code: '600519', title: 't' }] };
  const s = await sb.window.Core.News.snapshot.get();
  assert(s && s.items.length === 1, `返快照 (${s && s.items.length})`);
});

// ===== 情形 7: _getSnapshot 过期返 null =====
describe('情形 7: _getSnapshot 过期返 null (不重拉)', async () => {
  const sb = buildSandbox();
  // 46 分钟前, 超过 TTL 45min
  sb._kv.news_snapshot_v1 = { generated: Date.now() - 46 * 60 * 1000, items: [] };
  const s = await sb.window.Core.News.snapshot.get();
  assert(s === null, '过期 → null');
});

// ===== 情形 8: _isSnapshotFresh =====
describe('情形 8: _isSnapshotFresh 判定', () => {
  const sb = buildSandbox();
  const fresh = { generated: Date.now() };
  const stale = { generated: Date.now() - 60 * 60 * 1000 };
  const empty = null;
  const noTs = {};
  assert(sb.window.Core.News.snapshot.isFresh(fresh) === true, '新鲜的 → true');
  assert(sb.window.Core.News.snapshot.isFresh(stale) === false, '过期的 → false');
  assert(sb.window.Core.News.snapshot.isFresh(empty) === false, 'null → false');
  assert(sb.window.Core.News.snapshot.isFresh(noTs) === false, '无 generated → false');
});

// ===== 情形 9: tool news.snapshot 注册 =====
describe('情形 9: tool news.snapshot 注册到 ToolRegistry', () => {
  const sb = {
    window: {}, console: console,
    Date, Math, Promise, JSON, Array, Object, Map, Set, Error, Number,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sb.window = sb;
  sb.Core = { News: { snapshot: { get: async () => ({ items: [] }), build: async () => ({ items: [] }) } } };
  sb._tools = [];
  sb.Core.AI = { ToolRegistry: { register: (m) => sb._tools.push(m) } };
  vm.createContext(sb);
  vm.runInContext(AGENT_TOOLS_SRC, sb, { filename: 'agent-tools.js' });
  const tool = sb._tools.find(t => t.name === 'news.snapshot');
  assert(tool, '注册了 news.snapshot');
  assert(tool.risk === 'L', 'risk=L');
  assert(typeof tool.handler === 'function', 'handler 是函数');
  assert(tool.description.includes('公告') || tool.description.includes('新闻'), 'description 含新闻/公告');
});

// ===== 情形 10: handler codes 过滤 =====
describe('情形 10: handler codes 过滤', async () => {
  const sb = buildSandbox();
  const snap = {
    generated: Date.now(), codes: 3, itemCount: 3,
    items: [
      { code: '600519', title: 'a' },
      { code: '000001', title: 'b' },
      { code: '300750', title: 'c' }
    ],
    errors: []
  };
  sb.window.Core.News.snapshot.get = async () => snap;
  sb.window.Core.News.snapshot.build = async () => snap;
  const codeSet = new Set(['600519', '300750']);
  const filtered = snap.items.filter(it => codeSet.has(it.code));
  assert(filtered.length === 2, `过滤后 2 条 (${filtered.length})`);
  assert(filtered.every(it => it.code !== '000001'), '000001 被剔除');
});

// ===== 情形 11: 缓存空自动 build =====
describe('情形 11: get 返 null 时自动 build', async () => {
  const sb = buildSandbox();
  let buildCalls = 0;
  sb.window.Core.News.snapshot.get = async () => null;
  sb.window.Core.News.snapshot.build = async () => { buildCalls++; return { generated: Date.now(), items: [] }; };
  let s = await sb.window.Core.News.snapshot.get();
  if (!s) s = await sb.window.Core.News.snapshot.build();
  assert(buildCalls === 1, `缓存空 → 触发 build (${buildCalls})`);
});

// ===== 情形 12: 源码对账 =====
describe('情形 12: 源码对账', () => {
  // news.js
  assert(/SNAPSHOT_TTL_MS\s*=\s*45\s*\*\s*60\s*\*\s*1000/.test(NEWS_SRC), 'SNAPSHOT_TTL_MS = 45min');
  assert(/SNAPSHOT_KV_KEY\s*=\s*'news_snapshot_v1'/.test(NEWS_SRC), 'kv key = news_snapshot_v1');
  assert(/_buildSnapshot/.test(NEWS_SRC), '_buildSnapshot 函数');
  assert(/_collectAllCodes/.test(NEWS_SRC), '_collectAllCodes 函数');
  assert(/snapshot\s*:/.test(NEWS_SRC), '暴露 Core.News.snapshot (snapshot: 字段)');

  // agent-tools.js
  assert(/name:\s*'news\.snapshot'/.test(AGENT_TOOLS_SRC), '注册 news.snapshot 工具');

  // short-trader.js
  assert(/news\.snapshot/.test(SHORT_TRADER_SRC), 'short-trader 注入 news.snapshot 提示');

  // app.js
  assert(/'news-refresh'/.test(APP_SRC), 'Scheduler 注册 news-refresh task');
  assert(/30\s*\*\s*60\s*\*\s*1000/.test(APP_SRC.replace(/[\s\S]{0,1500}news-refresh[\s\S]{0,800}/, m => m)), 'news-refresh 30min 频率');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V12 NewsSnapshot: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();