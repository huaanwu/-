/**
 * V11.1 — DecisionTrace 完整 schema + 边界用例
 *
 * 覆盖:
 *   1. 字段必填校验 (traceId / runId / strategy)
 *   2. ts 自动填 (缺省 Date.now)
 *   3. listDecisionTracesByRun 按 runId 查
 *   4. listDecisionTracesByStrategy 时间区间过滤
 *   5. 同 traceId 覆盖 (put 语义)
 *   6. payload 自由字段 (任意形状)
 *   7. sleeve/regime/factor 字段透传
 *   8. agentType 多种格式
 *   9. 索引覆盖 (runId/strategy/agentType/code/ts)
 *   10. 大数据量 (1000 行) 性能可接受
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
 * 内存模拟 Dexie 完整 storage (覆盖 decision_traces 全部 API)
 */
function buildSandbox() {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number, Symbol
  };
  sb.window = sb;

  // 模拟 Dexie 各表 (用 Map 简化)
  const tables = {
    decision_traces: new Map(),    // key=traceId, value=row
    trade_journal_ext: [],          // ++id, array
    missed_opportunities: [],       // ++id
    weekly_attribution: new Map(),  // key=compositeKey
    ai_call_log: [],
    agent_runs: new Map(),
    ai_traces: [],
    research_pool: new Map(),
    cache: new Map(),
    kv: new Map(),
    settings_snapshots: []
  };

  sb.Dexie = function Dexie(name) {
    this.name = name;
    const db = {};
    // 各表 mock
    db.decision_traces = {
      put: async (row) => { tables.decision_traces.set(row.traceId, row); return row.traceId; },
      where: (idx) => ({
        equals: (val) => ({
          toArray: async () => Array.from(tables.decision_traces.values()).filter(r => r[idx] === val)
        })
      }),
      toArray: async () => Array.from(tables.decision_traces.values())
    };
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
    db.missed_opportunities = {
      add: async (row) => { row.id = row.id || (tables.missed_opportunities.length + 1); tables.missed_opportunities.push(row); return row.id; },
      toArray: async () => tables.missed_opportunities.slice()
    };
    db.weekly_attribution = {
      put: async (row) => { tables.weekly_attribution.set(row.weekId, row); return row.weekId; },
      get: async (k) => tables.weekly_attribution.get(k) || null,
      toArray: async () => Array.from(tables.weekly_attribution.values())
    };
    db.agent_runs = {
      put: async (row) => { tables.agent_runs.set(row.runId, row); return row.runId; },
      get: async (k) => tables.agent_runs.get(k) || null,
      orderBy: () => ({ reverse: () => ({ toArray: async () => Array.from(tables.agent_runs.values()).sort((a, b) => (b.ts || 0) - (a.ts || 0)) }) })
    };
    db.ai_call_log = {
      add: async (row) => { row.id = row.id || (tables.ai_call_log.length + 1); tables.ai_call_log.push(row); return row.id; },
      toArray: async () => tables.ai_call_log.slice()
    };
    db.ai_traces = {
      add: async (row) => { row.id = row.id || (tables.ai_traces.length + 1); tables.ai_traces.push(row); return row.id; },
      where: () => ({ equals: () => ({ toArray: async () => [] }) }),
      toArray: async () => tables.ai_traces.slice()
    };
    db.research_pool = {
      put: async (row) => { tables.research_pool.set(row.code, row); return row.code; },
      get: async (k) => tables.research_pool.get(k) || null,
      toArray: async () => Array.from(tables.research_pool.values())
    };
    db.cache = {
      put: async (row) => { tables.cache.set(row.key, row); return row.key; },
      get: async (k) => tables.cache.get(k) || null,
      delete: async (k) => tables.cache.delete(k),
      clear: async () => tables.cache.clear()
    };
    db.kv = {
      put: async (row) => { tables.kv.set(row.key, row); return row.key; },
      get: async (k) => tables.kv.get(k) || null,
      delete: async (k) => tables.kv.delete(k)
    };
    db.settings_snapshots = {
      put: async (row) => { tables.settings_snapshots.push(row); return row.id; },
      orderBy: () => ({ reverse: () => ({ toArray: async () => tables.settings_snapshots.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0)) }) }),
      get: async (k) => tables.settings_snapshots.find(s => s.id === k) || null,
      delete: async (k) => { const i = tables.settings_snapshots.findIndex(s => s.id === k); if (i >= 0) tables.settings_snapshots.splice(i, 1); },
      bulkDelete: async (keys) => { tables.settings_snapshots = tables.settings_snapshots.filter(s => !keys.includes(s.id)); },
      clear: async () => { tables.settings_snapshots.length = 0; }
    };
    // 其它表 (not used in V11.1 but storage.js init needs)
    db.watchlist = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.holdings = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.transactions = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.journals = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.alerts = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.funds = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };
    db.cashflow = { put: async () => 1, get: async () => null, toArray: async () => [], where: () => ({ equals: () => ({ toArray: async () => [] }) }), delete: async () => {}, clear: async () => {}, add: async () => 1 };

    const wrapper = {
      version: () => ({ stores: () => ({}) }),
      table: (t) => db[t],
      [Symbol.iterator]: function* () { for (const k of Object.keys(db)) yield db[k]; }
    };
    // 直接挂 db.* 属性到 wrapper (Dexie API 兼容 — db.decision_traces 直接访问)
    Object.assign(wrapper, db);
    return wrapper;
  };

  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb, { filename: 'storage.js' });
  return sb;
}

// ===== 情形 1: 字段必填 =====
describe('情形 1: addDecisionTrace 必填校验', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  let threw1 = false;
  try { await S.addDecisionTrace({ runId: 'r1', strategy: 'long', agentType: 'x' }); } catch (e) { threw1 = true; }
  assert(threw1, '缺 traceId 抛错');

  let threw2 = false;
  try { await S.addDecisionTrace(null); } catch (e) { threw2 = true; }
  assert(threw2, 'null 抛错');

  let threw3 = false;
  try { await S.addDecisionTrace({}); } catch (e) { threw3 = true; }
  assert(threw3, '空对象抛错');
});

// ===== 情形 2: ts 自动填 =====
describe('情形 2: ts 缺省自动填 Date.now', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  const before = Date.now();
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'x' });
  const after = Date.now();
  const all = await S.listDecisionTracesByRun('r1');
  assert(all[0].ts >= before && all[0].ts <= after, `ts 在 before/after 之间 (${all[0].ts})`);
});

// ===== 情形 3: listDecisionTracesByRun =====
describe('情形 3: listDecisionTracesByRun 按 runId 查', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addDecisionTrace({ traceId: 't1', runId: 'run-A', strategy: 'long', agentType: 'x' });
  await S.addDecisionTrace({ traceId: 't2', runId: 'run-A', strategy: 'long', agentType: 'x' });
  await S.addDecisionTrace({ traceId: 't3', runId: 'run-B', strategy: 'short', agentType: 'y' });
  const a = await S.listDecisionTracesByRun('run-A');
  assert(a.length === 2, `run-A 2 条 (${a.length})`);
  const b = await S.listDecisionTracesByRun('run-B');
  assert(b.length === 1, `run-B 1 条`);
  const empty = await S.listDecisionTracesByRun('run-Z');
  assert(empty.length === 0, 'run-Z 0 条');
});

// ===== 情形 4: listDecisionTracesByStrategy 时间区间 =====
describe('情形 4: listDecisionTracesByStrategy 时间区间', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'x', ts: 100 });
  await S.addDecisionTrace({ traceId: 't2', runId: 'r2', strategy: 'long', agentType: 'x', ts: 200 });
  await S.addDecisionTrace({ traceId: 't3', runId: 'r3', strategy: 'long', agentType: 'x', ts: 300 });
  await S.addDecisionTrace({ traceId: 't4', runId: 'r4', strategy: 'short', agentType: 'y', ts: 200 });

  // sinceTs=150, untilTs=350 → [t2(200), t3(300)]
  const ranged = await S.listDecisionTracesByStrategy('long', 150, 350);
  assert(ranged.length === 2, `区间 [150,350) → 2 条 (${ranged.length})`);

  // sinceTs only
  const after = await S.listDecisionTracesByStrategy('long', 200);
  assert(after.length === 2, `since=200 → 2 条 (${after.length})`);

  // untilTs only
  const before = await S.listDecisionTracesByStrategy('long', undefined, 250);
  assert(before.length === 2, `until=250 → 2 条 (${before.length})`);
});

// ===== 情形 5: 同 traceId 覆盖 =====
describe('情形 5: 同 traceId 覆盖 (put 语义)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'x', payload: { a: 1 } });
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'x', payload: { a: 2 } });
  const all = await S.listDecisionTracesByRun('r1');
  assert(all.length === 1, `覆盖 → 1 条 (${all.length})`);
  assert(all[0].payload.a === 2, `payload 更新为 2 (${all[0].payload.a})`);
});

// ===== 情形 6: payload 自由字段 =====
describe('情形 6: payload 自由形状', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addDecisionTrace({ traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'x', payload: { picks: [{ code: '600519' }], note: '自定义' } });
  const r = await S.listDecisionTracesByRun('r1');
  assert(Array.isArray(r[0].payload.picks), 'payload.picks 是数组');
  assert(r[0].payload.note === '自定义', 'payload.note 保留');
});

// ===== 情形 7: sleeve/regime/factor 透传 =====
describe('情形 7: sleeve/regime/factor 透传', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.addDecisionTrace({
    traceId: 't1', runId: 'r1', strategy: 'short', agentType: 'x',
    sleeve: 'short', regime: 'bear', factor: 0
  });
  const r = await S.listDecisionTracesByRun('r1');
  assert(r[0].sleeve === 'short', 'sleeve=short');
  assert(r[0].regime === 'bear', 'regime=bear');
  assert(r[0].factor === 0, 'factor=0 (熊市不开仓)');
});

// ===== 情形 8: agentType 多种格式 =====
describe('情形 8: agentType 多种格式', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  const formats = ['llmPickTop', 'phase_morning', 'phase_midday', 'phase_close', 'observer', 'analyst', 'coach', 'fund.weeklyReport'];
  for (let i = 0; i < formats.length; i++) {
    await S.addDecisionTrace({ traceId: 't' + i, runId: 'r' + i, strategy: 'agents', agentType: formats[i] });
  }
  const all = await S.listDecisionTracesByStrategy('agents');
  const types = all.map(r => r.agentType).sort();
  assert(JSON.stringify(types) === JSON.stringify(formats.slice().sort()), `agentType 全部保留 (${types.length})`);
});

// ===== 情形 9: 索引覆盖 =====
describe('情形 9: 索引字段 (runId/strategy/agentType/code/ts/sleeve/regime/factor)', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  // storage.js 第 80-85 行声明 v6 schema, 检查
  const idx = 'decision_traces: \'&traceId, runId, strategy, agentType, code, ts, sleeve, regime, factor\'';
  const src = STORAGE_SRC;
  assert(src.includes(idx), 'v6 schema 包含所有索引字段');
});

// ===== 情形 10: 大数据量 =====
describe('情形 10: 1000 行 decision_traces 性能可接受', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  const N = 1000;
  const start = Date.now();
  for (let i = 0; i < N; i++) {
    await S.addDecisionTrace({
      traceId: 't' + i, runId: i < 500 ? 'A' : 'B', strategy: i % 2 === 0 ? 'long' : 'short',
      agentType: 'phase_morning', code: '60' + String(i % 1000).padStart(4, '0'),
      ts: 1000000 + i, sleeve: i % 2 === 0 ? 'long' : 'short'
    });
  }
  const insertMs = Date.now() - start;
  assert(insertMs < 5000, `1000 行 insert < 5s (${insertMs}ms)`);

  const qStart = Date.now();
  const a = await S.listDecisionTracesByRun('A');
  const qMs = Date.now() - qStart;
  assert(a.length === 500, `run-A 500 行`);
  assert(qMs < 500, `查询 < 500ms (${qMs}ms)`);
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V11.1 DecisionTrace: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();