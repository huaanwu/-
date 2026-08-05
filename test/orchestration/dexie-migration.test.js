/**
 * 任务 B: Dexie 全部表真 migration — v2 → v3 → v4 → v6 → v7 → v8
 *
 * 验证:
 *   1. fake-indexeddb 装载成功 → global.indexedDB 可用
 *   2. Dexie 全部表 schema 声明串成完整 version chain
 *   3. v2 (10 表) 写 holdings → v3 升级后 holdings 还在
 *   4. v3 (13 表) 写 agent_runs → v4 升级后 holdings + agent_runs 还在
 *   5. v4 (14 表) 写 research_pool → v6 升级后前 3 级数据仍在
 *   6. v6 (18 表) 写 decision_traces → v7 升级后数据仍在
 *   7. v7 (23 表) 写 pool_snapshots → v8 升级后 holdings + pool_snapshots 全在
 *   8. v8 (24 表) 全部表可用 (toArray ← Dexie 原生)
 *   9. v8 全 24 表 count 断言 (v8 最终形态)
 *   10. 跨版本迁移冪等: 重复打开 DB 数据不丢失
 *
 * 跑法: node test/orchestration/dexie-migration.test.js
 */
'use strict';

require('fake-indexeddb/auto');

const Dexie = require('dexie');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}

const DB_NAME = 'stockmaster-mig-test';
const ALL_TABLE_NAMES_V8 = [
  'watchlist','holdings','transactions','journals','alerts','funds',
  'cashflow','cache','kv','settings_snapshots',  // v2 (10)
  'ai_call_log','agent_runs','ai_traces',          // v3 (3)
  'research_pool',                                  // v4 (1)
  'decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution', // v6 (4)
  'pool_snapshots','steward_plans','rule_candidates','steward_lessons','rule_overrides', // v7 (5)
  'sub_strategies'                                  // v8 (1)
];

function makeDbV2() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  return db;
}

function makeDbV3() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  db.version(3).stores({
    ai_call_log: '++id, ts, page, purpose, runId',
    agent_runs: '&runId, intent, strategy, ts, ok',
    ai_traces: '++id, runId, kind, ts'
  });
  return db;
}

function makeDbV4() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  db.version(3).stores({
    ai_call_log: '++id, ts, page, purpose, runId',
    agent_runs: '&runId, intent, strategy, ts, ok',
    ai_traces: '++id, runId, kind, ts'
  });
  db.version(4).stores({
    research_pool: '&code, market, name, addedAt, tags'
  });
  return db;
}

function makeDbV6() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  db.version(3).stores({
    ai_call_log: '++id, ts, page, purpose, runId',
    agent_runs: '&runId, intent, strategy, ts, ok',
    ai_traces: '++id, runId, kind, ts'
  });
  db.version(4).stores({
    research_pool: '&code, market, name, addedAt, tags'
  });
  db.version(6).stores({
    decision_traces: '&traceId, runId, strategy, agentType, code, ts, sleeve, regime, factor',
    trade_journal_ext: '++id, journalId, code, sleeve, matched, exitDate',
    missed_opportunities: '++id, code, date, signalType, sleeve, notedAt',
    weekly_attribution: '&weekId, strategy, ts'
  });
  return db;
}

function makeDbV7() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  db.version(3).stores({
    ai_call_log: '++id, ts, page, purpose, runId',
    agent_runs: '&runId, intent, strategy, ts, ok',
    ai_traces: '++id, runId, kind, ts'
  });
  db.version(4).stores({
    research_pool: '&code, market, name, addedAt, tags'
  });
  db.version(6).stores({
    decision_traces: '&traceId, runId, strategy, agentType, code, ts, sleeve, regime, factor',
    trade_journal_ext: '++id, journalId, code, sleeve, matched, exitDate',
    missed_opportunities: '++id, code, date, signalType, sleeve, notedAt',
    weekly_attribution: '&weekId, strategy, ts'
  });
  db.version(7).stores({
    pool_snapshots: '&snapId, date, sleeve, ts',
    steward_plans: '&planId, date, status, ts',
    rule_candidates: '&candId, status, ts, source',
    steward_lessons: '++id, code, sleeve, ts, pattern, strategy',
    rule_overrides: '&overrideId, ts, scope, refId, status'
  });
  return db;
}

function makeDbV8() {
  const db = new Dexie(DB_NAME);
  db.version(2).stores({
    watchlist: '&code, name, market, addedAt',
    holdings: '&id, code, name, market, type, createdAt',
    transactions: '&id, holdingId, code, type, date, createdAt',
    journals: '&id, code, date, createdAt, updatedAt',
    alerts: '&id, code, type, active, createdAt',
    funds: '&code, name, type, addedAt',
    cashflow: '&id, date, type, createdAt',
    cache: '&key, expiresAt',
    kv: '&key',
    settings_snapshots: '&id, ts, reason'
  });
  db.version(3).stores({
    ai_call_log: '++id, ts, page, purpose, runId',
    agent_runs: '&runId, intent, strategy, ts, ok',
    ai_traces: '++id, runId, kind, ts'
  });
  db.version(4).stores({
    research_pool: '&code, market, name, addedAt, tags'
  });
  db.version(6).stores({
    decision_traces: '&traceId, runId, strategy, agentType, code, ts, sleeve, regime, factor',
    trade_journal_ext: '++id, journalId, code, sleeve, matched, exitDate',
    missed_opportunities: '++id, code, date, signalType, sleeve, notedAt',
    weekly_attribution: '&weekId, strategy, ts'
  });
  db.version(7).stores({
    pool_snapshots: '&snapId, date, sleeve, ts',
    steward_plans: '&planId, date, status, ts',
    rule_candidates: '&candId, status, ts, source',
    steward_lessons: '++id, code, sleeve, ts, pattern, strategy',
    rule_overrides: '&overrideId, ts, scope, refId, status'
  });
  db.version(8).stores({
    sub_strategies: '&strategyId, sleeve, status, ts'
  });
  return db;
}

(async () => {
  // 清理
  await Dexie.delete(DB_NAME).catch(() => {});

  // === [1] fake-indexeddb 装载成功 ===
  console.log('\n[1] fake-indexeddb 装载');
  assert(typeof globalThis.indexedDB !== 'undefined' || typeof indexedDB !== 'undefined',
    'indexedDB 全局可用');
  assert(typeof Dexie === 'function', 'Dexie 可用');

  // === [2] v2: 建库 + 写 holdings 1 条 ===
  console.log('\n[2] v2 建库 (10 表) + 写 holdings');
  const db2 = makeDbV2();
  await db2.open();
  await db2.holdings.put({ id: 'h1', code: '600519', name: '茅台', market: 'sh', type: 'stock', createdAt: Date.now() });
  await db2.close();

  // === [3] v3 升级: 验证 holdings 还在 ===
  console.log('\n[3] v3 升级 (13 表)');
  const db3 = makeDbV3();
  await db3.open();
  const h3 = await db3.holdings.get('h1');
  assert(h3 && h3.code === '600519' && h3.name === '茅台', 'v3 升级后 holdings 还在');
  // v3 新表可写
  await db3.agent_runs.put({ runId: 'r1', intent: 'test', strategy: 'long', ok: true, ts: 1000 });
  await db3.close();

  // === [4] v4 升级: 验证 holdings + agent_runs ===
  console.log('\n[4] v4 升级 (14 表)');
  const db4 = makeDbV4();
  await db4.open();
  const h4 = await db4.holdings.get('h1');
  assert(h4 && h4.code === '600519', 'v4 升级后 holdings 还在');
  const r4 = await db4.agent_runs.get('r1');
  assert(r4 && r4.intent === 'test', 'v4 升级后 agent_runs 还在');
  await db4.research_pool.put({ code: '000001', market: 'sz', name: '平安银行', addedAt: Date.now(), tags: 'bank' });
  await db4.close();

  // === [5] v6 升级: 验证前 3 级数据仍在 ===
  console.log('\n[5] v6 升级 (18 表)');
  const db6 = makeDbV6();
  await db6.open();
  const h6 = await db6.holdings.get('h1');
  assert(h6 && h6.code === '600519', 'v6 升级后 holdings 还在');
  const rp6 = await db6.research_pool.get('000001');
  assert(rp6 && rp6.name === '平安银行', 'v6 升级后 research_pool 还在');
  await db6.decision_traces.put({ traceId: 't1', runId: 'r1', strategy: 'long', code: '600519', ts: 2000 });
  await db6.close();

  // === [6] v7 升级 ===
  console.log('\n[6] v7 升级 (23 表)');
  const db7 = makeDbV7();
  await db7.open();
  const h7 = await db7.holdings.get('h1');
  assert(h7 && h7.code === '600519', 'v7 升级后 holdings 还在');
  const dt7 = await db7.decision_traces.get('t1');
  assert(dt7 && dt7.traceId === 't1', 'v7 升级后 decision_traces 还在');
  await db7.pool_snapshots.put({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', ts: 3000 });
  await db7.close();

  // === [7] v8 升级: 验证 holdings + pool_snapshots 全在 ===
  console.log('\n[7] v8 升级 (24 表)');
  const db8 = makeDbV8();
  await db8.open();
  // holdings 在 (跨 6 级迁移)
  const h8 = await db8.holdings.get('h1');
  assert(h8 && h8.code === '600519', 'v8 升级后 holdings 还在 (跨 v2→v8)');
  // pool_snapshots 在
  const ps8 = await db8.pool_snapshots.get('2026-07-31-long');
  assert(ps8 && ps8.sleeve === 'long', 'v8 升级后 pool_snapshots 还在');

  // === [8] 全 24 表可用 ===
  console.log('\n[8] v8 全 24 表可用性');
  for (const t of ALL_TABLE_NAMES_V8) {
    const arr = await db8[t].toArray();
    assert(Array.isArray(arr), `db.${t}.toArray() 可用 (${arr.length} 条)`);
  }

  // === [9] count 断言 ===
  console.log('\n[9] count 断言');
  assert((await db8.holdings.toArray()).length === 1, 'holdings = 1 条');
  assert((await db8.pool_snapshots.toArray()).length === 1, 'pool_snapshots = 1 条');
  assert((await db8.agent_runs.toArray()).length === 1, 'agent_runs = 1 条');
  assert((await db8.research_pool.toArray()).length === 1, 'research_pool = 1 条');
  assert((await db8.decision_traces.toArray()).length === 1, 'decision_traces = 1 条');

  // === [10] 跨版本迁移冪等 ===
  console.log('\n[10] 迁移冪等');
  await db8.close();
  const db8b = makeDbV8();
  await db8b.open();
  const h8b = await db8b.holdings.get('h1');
  assert(h8b && h8b.code === '600519', '重复打开 DB 后 holdings 仍可读');
  await db8b.close();

  await Dexie.delete(DB_NAME).catch(() => {});

  console.log('\n' + '='.repeat(50));
  console.log('Dexie migration: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => {
  console.error(e);
  process.exit(1);
});
