/**
 * V3 — Storage v6: 4 表 + 10 helper 单元测试
 *
 * 用内存 fake 模拟 Dexie 接口 (Dexie 不可在 Node 直接跑)
 *   fakeDb: { tableName: Map<key, row>, _nextAutoId: Map<key, num> }
 *   add(table, row): auto-key++
 *   put(table, row): 覆盖主键
 *   get(table, key): 取行
 *   where(table, index).equals(v).toArray(): 索引查
 *   toArray(): 全表
 *
 * 覆盖:
 *   1. DB_VERSION = 6 (与 storage.js 一致)
 *   2. version(6) 声明的 4 个 store 名字
 *   3. decision_traces: addDecisionTrace + listDecisionTracesByRun + listDecisionTracesByStrategy + ts 过滤
 *   4. trade_journal_ext: addTradeJournalExt + getTradeJournalExtByJournal (主键 ++id)
 *   5. missed_opportunities: addMissedOpportunity + listMissedOpportunities (倒序 + limit)
 *   6. weekly_attribution: saveWeeklyAttribution + getWeeklyAttribution + listWeeklyAttribution (按 strategy 过滤)
 *   7. 缺主键抛错 (fail-fast)
 *   8. helper 暴露在 Core.Storage 上
 *
 * 跑法: node test/orchestration/storage-v6.test.js
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

/**
 * 内存 fake Dexie (支持 add/put/get/where/equals/toArray, 足够测 4 表)
 * 主键可以是数字 (++id) 或字符串 (&xxx)
 *   - 数字主键: row.id 自动赋值
 *   - 字符串主键: row 主键字段名 (traceId/weekId/code)
 *   - 字符串主键 (数字 fake 用 'name' 字段标识哪个字段作主键)
 */
function makeFakeDb(tables, primaryKeys) {
  // primaryKeys: { tableName: 主键字段名 }
  const PK = primaryKeys || {
    decision_traces: 'traceId',
    trade_journal_ext: 'id',
    missed_opportunities: 'id',
    weekly_attribution: 'weekId'
  };
  const db = {};
  tables.forEach(name => {
    const rows = new Map();
    let autoId = 1;
    const pkField = PK[name] || 'id';
    const tbl = {
      add: async (row) => {
        if (pkField === 'id') {
          if (row.id == null) row.id = autoId++;
          else if (typeof row.id === 'number' && row.id >= autoId) autoId = row.id + 1;
          rows.set(row.id, row);
          return row.id;
        }
        // 字符串主键 (traceId / weekId)
        const keyVal = row[pkField];
        if (keyVal == null) throw new Error('add: 缺主键 ' + pkField);
        rows.set(keyVal, row);
        return keyVal;
      },
      put: async (row) => {
        if (pkField === 'id') {
          if (row.id == null) row.id = autoId++;
          rows.set(row.id, row);
          return row.id;
        }
        const keyVal = row[pkField];
        if (keyVal == null) throw new Error('put: 缺主键 ' + pkField);
        rows.set(keyVal, row);
        return keyVal;
      },
      get: async (key) => rows.get(key) || null,
      toArray: async () => Array.from(rows.values()),
      where: (idx) => ({
        equals: (v) => ({
          toArray: async () => Array.from(rows.values()).filter(r => r[idx] === v),
          first: async () => Array.from(rows.values()).find(r => r[idx] === v) || null
        })
      }),
      clear: async () => { rows.clear(); }
    };
    db[name] = tbl;
  });
  return db;
}

/**
 * 构建 sandbox: 注入 window.Dexie + fake db
 * storage.js 不需要 Dexie 真实实现, 仅 init() 时 new Dexie(DB_NAME)
 * 我们拦截 init() 调用, 直接返 mock db
 */
function buildSandbox(opts = {}) {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number
  };
  sb.window = sb;

  // mock Dexie
  const tablesV2 = ['watchlist','holdings','transactions','journals','alerts','funds','cashflow','cache','kv','settings_snapshots'];
  const tablesV3 = ['ai_call_log','agent_runs','ai_traces'];
  const tablesV4 = ['research_pool'];
  const tablesV6 = ['decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  const allTables = [...tablesV2, ...tablesV3, ...tablesV4, ...tablesV6];

  function FakeDexie(name) {
    const db = makeFakeDb(allTables, {
      decision_traces: 'traceId',
      trade_journal_ext: 'id',
      missed_opportunities: 'id',
      weekly_attribution: 'weekId'
    });
    return {
      name,
      version: (v) => ({
        stores: (schema) => {
          // 仅记录声明, 不实际建表 (fake 已经全建)
          return { stores: schema };
        }
      }),
      // 暴露 table 直接访问 (storage.js 用 d[table].add)
      _tables: db
    };
  }

  // 让 storage.js 调 new Dexie() 时返 mock
  sb.Dexie = function (name) {
    const inst = FakeDexie(name);
    // 兼容 storage.js 直接通过 instance[table].add 调用
    Object.assign(inst, inst._tables);
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};

  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb, { filename: 'storage.js' });
  return sb;
}

// ===== 情形 1: DB_VERSION = 8 (v0.2.26 ST 加 sub_strategies) =====
describe('情形 1: DB_VERSION 升到 7', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  assert(S.DB_VERSION === 8, `DB_VERSION = 8 (实际 ${S.DB_VERSION})`);
  assert(S.DB_NAME === 'stockmaster', 'DB_NAME = stockmaster');
});

// ===== 情形 2: 4 个新 helper 已暴露 =====
describe('情形 2: 4 表对应 10 helper 暴露', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  // decision_traces
  assert(typeof S.addDecisionTrace === 'function', 'addDecisionTrace 暴露');
  assert(typeof S.listDecisionTracesByRun === 'function', 'listDecisionTracesByRun 暴露');
  assert(typeof S.listDecisionTracesByStrategy === 'function', 'listDecisionTracesByStrategy 暴露');
  // trade_journal_ext
  assert(typeof S.addTradeJournalExt === 'function', 'addTradeJournalExt 暴露');
  assert(typeof S.getTradeJournalExtByJournal === 'function', 'getTradeJournalExtByJournal 暴露');
  // missed_opportunities
  assert(typeof S.addMissedOpportunity === 'function', 'addMissedOpportunity 暴露');
  assert(typeof S.listMissedOpportunities === 'function', 'listMissedOpportunities 暴露');
  // weekly_attribution
  assert(typeof S.saveWeeklyAttribution === 'function', 'saveWeeklyAttribution 暴露');
  assert(typeof S.getWeeklyAttribution === 'function', 'getWeeklyAttribution 暴露');
  assert(typeof S.listWeeklyAttribution === 'function', 'listWeeklyAttribution 暴露');
});

// ===== 情形 3: addDecisionTrace + 索引查询 =====
describe('情形 3: decision_traces 增改查', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'observer', code: '600519', sleeve: 'long', regime: 'bull', factor: 1.0, ts: 1000 });
  await S.addDecisionTrace({ traceId: 't2', runId: 'r1', strategy: 'long', agentType: 'analyst', code: '000001', sleeve: 'long', regime: 'bull', factor: 1.0, ts: 2000 });
  await S.addDecisionTrace({ traceId: 't3', runId: 'r2', strategy: 'short', agentType: 'coach', code: '300750', sleeve: 'short', regime: 'bear', factor: 0.0, ts: 3000 });

  const r1 = await S.listDecisionTracesByRun('r1');
  assert(r1.length === 2, `runId=r1 返 2 条 (实际 ${r1.length})`);
  assert(r1.find(t => t.traceId === 't1'), 't1 在 r1 结果里');

  const longs = await S.listDecisionTracesByStrategy('long');
  assert(longs.length === 2, `strategy=long 返 2 条`);

  // ts 区间过滤
  const filtered = await S.listDecisionTracesByStrategy('long', 1500, 2500);
  assert(filtered.length === 1 && filtered[0].traceId === 't2', `ts [1500,2500) 过滤只剩 t2`);

  // put 覆盖
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', code: '600519', updated: true });
  const updated = await S.listDecisionTracesByRun('r1');
  assert(updated.find(t => t.traceId === 't1').updated === true, 'put 覆盖原 traceId=t1');
});

// ===== 情形 4: trade_journal_ext =====
describe('情形 4: trade_journal_ext 主键++id', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  const id1 = await S.addTradeJournalExt({ journalId: 'j1', code: '600519', sleeve: 'long', planPrice: 100, exitPrice: 110, pnl: 0.1, exitDate: '2026-08-01', matched: true });
  const id2 = await S.addTradeJournalExt({ journalId: 'j2', code: '000001', sleeve: 'short', planPrice: 50, exitPrice: 45, pnl: 0.1, exitDate: '2026-08-02', matched: true });
  assert(typeof id1 === 'number' && id1 > 0, `id1 是数字 (${id1})`);
  assert(typeof id2 === 'number' && id2 > id1, `id2 > id1 (${id2} > ${id1})`);

  const got = await S.getTradeJournalExtByJournal('j1');
  assert(got && got.code === '600519' && got.planPrice === 100, 'getTradeJournalExtByJournal(j1) 返正确行');
});

// ===== 情形 5: missed_opportunities =====
describe('情形 5: missed_opportunities 倒序 + limit', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.addMissedOpportunity({ code: 'a', signalType: 'regime_bull', sleeve: 'long', score: 0.8, notedAt: 1000 });
  await S.addMissedOpportunity({ code: 'b', signalType: 'valuation', sleeve: 'long', score: 0.6, notedAt: 2000 });
  await S.addMissedOpportunity({ code: 'c', signalType: 'cycle', sleeve: 'short', score: 0.9, notedAt: 3000 });

  const all = await S.listMissedOpportunities(0); // 0 = 不限
  assert(all.length === 3, `全量返 3 条`);
  assert(all[0].code === 'c' && all[0].notedAt === 3000, '倒序: c(3000) 在前');

  const top2 = await S.listMissedOpportunities(2);
  assert(top2.length === 2, `limit=2 返 2 条`);
  assert(top2[0].code === 'c' && top2[1].code === 'b', 'limit=2 返 c + b');

  // 自动填 date (YYYYMMDD)
  const first = await S.listMissedOpportunities(0);
  assert(typeof first[0].date === 'string' && first[0].date.length === 8, 'date 自动填 YYYYMMDD');
});

// ===== 情形 6: weekly_attribution =====
describe('情形 6: weekly_attribution 按 strategy + weekId', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.saveWeeklyAttribution({ weekId: '2026-31', strategy: 'long', totalPnl: 0.05, winRate: 0.6, summary: 'long OK', ts: 1000 });
  await S.saveWeeklyAttribution({ weekId: '2026-31', strategy: 'short', totalPnl: -0.02, winRate: 0.4, summary: 'short 亏', ts: 1000 });
  await S.saveWeeklyAttribution({ weekId: '2026-32', strategy: 'long', totalPnl: 0.08, winRate: 0.7, summary: 'long 强', ts: 2000 });

  const wk31 = await S.getWeeklyAttribution('2026-31', 'long');
  assert(wk31 && wk31.totalPnl === 0.05 && wk31.summary === 'long OK', 'getWeeklyAttribution(2026-31, long) 返 long 周报');

  // 不存在的 weekId
  const wk99 = await S.getWeeklyAttribution('2026-99');
  assert(wk99 === null, '不存在 weekId 返 null');

  const longs = await S.listWeeklyAttribution('long');
  assert(longs.length === 2, `strategy=long 返 2 周`);
  // ts 倒序: 32(ts=2000) 在前, 31(ts=1000) 在后
  assert(longs[0].weekId.indexOf('2026-32') >= 0 && longs[1].weekId.indexOf('2026-31') >= 0, '按 ts 倒序: 32 在前');

  const all = await S.listWeeklyAttribution(null);
  assert(all.length === 3, 'strategy=null 返全 3 周');
});

// ===== 情形 7: 缺主键抛错 =====
describe('情形 7: 缺主键 fail-fast', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  // addDecisionTrace 缺 traceId
  let threw1 = false;
  try { await S.addDecisionTrace({}); } catch (e) { threw1 = true; }
  assert(threw1, 'addDecisionTrace({}) 抛错 (缺 traceId)');

  // addTradeJournalExt 缺 code
  let threw2 = false;
  try { await S.addTradeJournalExt({ sleeve: 'long' }); } catch (e) { threw2 = true; }
  assert(threw2, 'addTradeJournalExt 缺 code 抛错');

  // addTradeJournalExt 缺 sleeve
  let threw3 = false;
  try { await S.addTradeJournalExt({ code: 'a' }); } catch (e) { threw3 = true; }
  assert(threw3, 'addTradeJournalExt 缺 sleeve 抛错');

  // addMissedOpportunity 缺 code
  let threw4 = false;
  try { await S.addMissedOpportunity({}); } catch (e) { threw4 = true; }
  assert(threw4, 'addMissedOpportunity({}) 抛错 (缺 code)');

  // saveWeeklyAttribution 缺 weekId
  let threw5 = false;
  try { await S.saveWeeklyAttribution({}); } catch (e) { threw5 = true; }
  assert(threw5, 'saveWeeklyAttribution({}) 抛错 (缺 weekId)');
});

// ===== 情形 8: ts 自动填 =====
describe('情形 8: 不传 ts 自动填 Date.now()', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  const before = Date.now();
  await S.addDecisionTrace({ traceId: 'auto-ts', strategy: 'long' });
  const after = Date.now();
  const got = await S.listDecisionTracesByRun(null); // 不能查 runId=null, 走 toArray
  // 用 put 模拟: 拿所有决策
  const all = (await S.listDecisionTracesByStrategy('long')).filter(t => t.traceId === 'auto-ts');
  assert(all.length === 1 && all[0].ts >= before && all[0].ts <= after, 'addDecisionTrace 自动填 ts');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V3 Storage v6: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();