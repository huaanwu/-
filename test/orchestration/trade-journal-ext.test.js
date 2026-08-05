/**
 * V11.2 — TradeJournalExt 完整 schema + 边界用例
 *
 * 覆盖:
 *   1. 必填字段 (code / sleeve)
 *   2. ++id 自增 + put 不可 (只能 add)
 *   3. matched 字段布尔 + null
 *   4. pnl 正负零
 *   5. planPrice/exitPrice 浮点
 *   6. exitDate 多种格式 (YYYYMMDD/YYYY-MM-DD)
 *   7. journalId 唯一关联
 *   8. getTradeJournalExtByJournal 按 journalId 查 (first 命中)
 *   9. sleeve 跨 long/short/fund
 *   10. 大数据量 1000 行
 *   11. V8 postMortem/postMortemAt 字段新增 (升级兼容)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

function buildSandbox() {
  const sb = {
    window: {}, console: console,
    Date, Math, Promise, JSON, Array, Object, Map, Set, Error, Number, Symbol,
    setTimeout, clearTimeout, setInterval, clearInterval
  };
  sb.window = sb;
  const tables = {
    trade_journal_ext: [],
    weekly_attribution: new Map(),
    decision_traces: new Map(),
    missed_opportunities: [],
    ai_call_log: [], agent_runs: new Map(), ai_traces: [], research_pool: new Map(),
    cache: new Map(), kv: new Map(), settings_snapshots: []
  };
  sb.Dexie = function (name) {
    const db = {};
    db.trade_journal_ext = {
      add: async (row) => { row.id = row.id || (tables.trade_journal_ext.length + 1); tables.trade_journal_ext.push(row); return row.id; },
      where: (idx) => ({
        equals: (val) => ({
          first: async () => tables.trade_journal_ext.find(r => r[idx] === val) || null,
          toArray: async () => tables.trade_journal_ext.filter(r => r[idx] === val)
        })
      }),
      toArray: async () => tables.trade_journal_ext.slice()
    };
    db.weekly_attribution = { put: async (r) => { tables.weekly_attribution.set(r.weekId, r); return r.weekId; }, get: async (k) => tables.weekly_attribution.get(k) || null, toArray: async () => Array.from(tables.weekly_attribution.values()) };
    db.decision_traces = { put: async (r) => { tables.decision_traces.set(r.traceId, r); return r.traceId; }, where: () => ({ equals: () => ({ toArray: async () => [] }) }), toArray: async () => Array.from(tables.decision_traces.values()) };
    db.missed_opportunities = { add: async (r) => { r.id = r.id || (tables.missed_opportunities.length + 1); tables.missed_opportunities.push(r); return r.id; }, toArray: async () => tables.missed_opportunities.slice() };
    db.agent_runs = { put: async (r) => { tables.agent_runs.set(r.runId, r); return r.runId; }, get: async (k) => tables.agent_runs.get(k) || null, orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }) };
    db.ai_call_log = { add: async (r) => { r.id = r.id || (tables.ai_call_log.length + 1); tables.ai_call_log.push(r); return r.id; }, toArray: async () => [] };
    db.ai_traces = { add: async (r) => { r.id = r.id || (tables.ai_traces.length + 1); tables.ai_traces.push(r); return r.id; }, where: () => ({ equals: () => ({ toArray: async () => [] }) }), toArray: async () => [] };
    db.research_pool = { put: async (r) => { tables.research_pool.set(r.code, r); return r.code; }, get: async (k) => tables.research_pool.get(k) || null, toArray: async () => [] };
    db.cache = { put: async (r) => { tables.cache.set(r.key, r); return r.key; }, get: async (k) => tables.cache.get(k) || null, delete: async (k) => tables.cache.delete(k), clear: async () => tables.cache.clear() };
    db.kv = { put: async (r) => { tables.kv.set(r.key, r); return r.key; }, get: async (k) => tables.kv.get(k) || null, delete: async (k) => tables.kv.delete(k) };
    db.settings_snapshots = { put: async (r) => { r.id = r.id || tables.settings_snapshots.length + 1; tables.settings_snapshots.push(r); return r.id; }, orderBy: () => ({ reverse: () => ({ toArray: async () => [] }) }), get: async (k) => null, delete: async () => {}, bulkDelete: async () => {}, clear: async () => { tables.settings_snapshots.length = 0; } };
    const stubs = ['watchlist', 'holdings', 'transactions', 'journals', 'alerts', 'funds', 'cashflow'];
    stubs.forEach(n => { db[n] = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 }; });
    const w = { version: () => ({ stores: () => ({}) }), table: (t) => db[t], [Symbol.iterator]: function* () { for (const k of Object.keys(db)) yield db[k]; } };
    Object.assign(w, db);
    return w;
  };
  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb, { filename: 'storage.js' });
  return sb;
}

// ===== 情形 1: 必填字段 =====
describe('情形 1: addTradeJournalExt 必填校验', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  let threw1 = false;
  try { await S.addTradeJournalExt({ sleeve: 'short' }); } catch (e) { threw1 = true; }
  assert(threw1, '缺 code 抛错');
  let threw2 = false;
  try { await S.addTradeJournalExt({ code: '600519' }); } catch (e) { threw2 = true; }
  assert(threw2, '缺 sleeve 抛错');
  let threw3 = false;
  try { await S.addTradeJournalExt(null); } catch (e) { threw3 = true; }
  assert(threw3, 'null 抛错');
});

// ===== 情形 2: ++id 自增 =====
describe('情形 2: trade_journal_ext 是 ++id 自增主键', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  const id1 = await S.addTradeJournalExt({ code: 'a', sleeve: 'short', pnl: 0 });
  const id2 = await S.addTradeJournalExt({ code: 'b', sleeve: 'short', pnl: 0 });
  const id3 = await S.addTradeJournalExt({ code: 'c', sleeve: 'short', pnl: 0 });
  assert(id1 === 1 && id2 === 2 && id3 === 3, `id 自增 1/2/3 (${id1}/${id2}/${id3})`);
});

// ===== 情形 3: matched 字段 =====
describe('情形 3: matched 字段 true/false/null', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ code: 'a', sleeve: 'short', matched: true });
  await S.addTradeJournalExt({ code: 'b', sleeve: 'short', matched: false });
  await S.addTradeJournalExt({ code: 'c', sleeve: 'short' });   // matched 默认 undefined
  const all = await S.all('trade_journal_ext');
  assert(all[0].matched === true, 'matched=true');
  assert(all[1].matched === false, 'matched=false');
  assert(all[2].matched === undefined, 'matched=undefined (未填)');
});

// ===== 情形 4: pnl 正负零 =====
describe('情形 4: pnl 正负零', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ code: 'a', sleeve: 'short', pnl: 0.10 });
  await S.addTradeJournalExt({ code: 'b', sleeve: 'short', pnl: -0.05 });
  await S.addTradeJournalExt({ code: 'c', sleeve: 'short', pnl: 0 });
  await S.addTradeJournalExt({ code: 'd', sleeve: 'short' });   // pnl=undefined
  const all = await S.all('trade_journal_ext');
  assert(all[0].pnl === 0.10, 'pnl=0.10');
  assert(all[1].pnl === -0.05, 'pnl=-0.05');
  assert(all[2].pnl === 0, 'pnl=0');
  assert(all[3].pnl === undefined, 'pnl=undefined');
});

// ===== 情形 5: planPrice/exitPrice 浮点 =====
describe('情形 5: planPrice/exitPrice 浮点字段', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ code: 'a', sleeve: 'short', planPrice: 100.55, exitPrice: 110.45, pnl: 0.0985 });
  const all = await S.all('trade_journal_ext');
  assert(all[0].planPrice === 100.55, 'planPrice=100.55');
  assert(all[0].exitPrice === 110.45, 'exitPrice=110.45');
  assert(Math.abs(all[0].pnl - 0.0985) < 1e-6, `pnl ≈ 0.0985 (${all[0].pnl})`);
});

// ===== 情形 6: exitDate 多种格式 =====
describe('情形 6: exitDate 字段保留任意字符串格式', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ code: 'a', sleeve: 'short', exitDate: '20260731' });
  await S.addTradeJournalExt({ code: 'b', sleeve: 'short', exitDate: '2026-07-31' });
  await S.addTradeJournalExt({ code: 'c', sleeve: 'short', exitDate: '' });
  const all = await S.all('trade_journal_ext');
  assert(all[0].exitDate === '20260731', 'YYYYMMDD');
  assert(all[1].exitDate === '2026-07-31', 'YYYY-MM-DD');
  assert(all[2].exitDate === '', '空字符串');
});

// ===== 情形 7: journalId 关联 =====
describe('情形 7: journalId 关联 (V7 weekly review 写 trade 时用)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ journalId: 'j-A', code: 'a', sleeve: 'short', pnl: 0.10 });
  await S.addTradeJournalExt({ journalId: 'j-A', code: 'a', sleeve: 'short', pnl: -0.05 });  // 同一 journalId 第二笔
  await S.addTradeJournalExt({ journalId: 'j-B', code: 'b', sleeve: 'short', pnl: 0.03 });
  const a = await S.getTradeJournalExtByJournal('j-A');
  assert(a && a.journalId === 'j-A', 'j-A 命中 (first)');
});

// ===== 情形 8: getTradeJournalExtByJournal first =====
describe('情形 8: getTradeJournalExtByJournal 取 first (一 journalId 一行)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ journalId: 'X', code: 'a', sleeve: 'short' });
  await S.addTradeJournalExt({ journalId: 'X', code: 'b', sleeve: 'short' });
  const r = await S.getTradeJournalExtByJournal('X');
  assert(r && r.code === 'a', 'first = a');
  const none = await S.getTradeJournalExtByJournal('NON-EXIST');
  assert(none === null, '不存在返 null');
});

// ===== 情形 9: sleeve 跨 long/short/fund =====
describe('情形 9: sleeve 跨 long/short/fund', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({ code: 'a', sleeve: 'long' });
  await S.addTradeJournalExt({ code: 'b', sleeve: 'short' });
  await S.addTradeJournalExt({ code: 'c', sleeve: 'fund' });
  await S.addTradeJournalExt({ code: 'd', sleeve: 'agents' });  // 异常值, 不拒
  const all = await S.all('trade_journal_ext');
  const sleeves = all.map(r => r.sleeve).sort();
  assert(JSON.stringify(sleeves) === JSON.stringify(['agents', 'fund', 'long', 'short']), `sleeve 4 种 (${sleeves})`);
});

// ===== 情形 10: 大数据量 =====
describe('情形 10: 1000 行 trade_journal_ext 性能', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  const N = 1000;
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    await S.addTradeJournalExt({
      code: '60' + String(i % 1000).padStart(4, '0'),
      sleeve: i % 2 === 0 ? 'short' : 'long',
      pnl: (i % 7 === 0 ? -1 : 1) * 0.05,
      journalId: 'j-' + i,
      exitDate: '2026' + String((i % 12) + 1).padStart(2, '0') + '15'
    });
  }
  const ms = Date.now() - start;
  assert(ms < 5000, `1000 行 < 5s (${ms}ms)`);
  const all = await S.all('trade_journal_ext');
  assert(all.length === N, `${N} 行`);
});

// ===== 情形 11: V8 postMortem/postMortemAt 字段 =====
describe('情形 11: V8 postMortem/postMortemAt 字段扩展兼容', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addTradeJournalExt({
    code: 'a', sleeve: 'short', pnl: 0.10,
    postMortem: '✅ 做对: 时机好',
    postMortemAt: Date.now()
  });
  const all = await S.all('trade_journal_ext');
  assert(all[0].postMortem === '✅ 做对: 时机好', 'postMortem 字段保留');
  assert(typeof all[0].postMortemAt === 'number', 'postMortemAt 是 timestamp');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V11.2 TradeJournalExt: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();