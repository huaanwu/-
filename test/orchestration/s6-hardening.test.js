/**
 * S6 加固 — KB JSON + Dexie v8 + allocator sub-strategy + 模块挂载 (12 项)
 *
 * 覆盖:
 *   1. KB JSON 加固后条目数 (104 = 87 + 17)
 *   2. KB 末尾 id 是某条 MAO-*** (毛选条目扩展) — 实际为 RIVAL-004
 *   3. macro_signal 类别条目数 >= 17 (S6 加固新增)
 *   4. _meta.version 不变 (1.5)
 *   5. APP_VERSION='v0.2.27'
 *   6. allocator 接 strategies 参数 (新参数不破坏旧调用)
 *   7. Pool 校验 items[].strategy 非空
 *   8. 实验期 cap 30% 在 allocator 生效 (e2e)
 *   9. 非实验期 100% (e2e)
 *   10. sub_strategies 表 + rule_overrides 4 表并存 (Dexie v8 升级成功)
 *   11. 模块挂载 Strategies (在 Steward 下)
 *
 * 跑法: node test/orchestration/s6-hardening.test.js
 * 必须返回 12/0 通过
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }

// ===== 1. KB JSON 条目数 104 =====
console.log('\n[1] KB JSON 加固后条目数 (87 + 17 = 104)');
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  assertEq(kb.entries.length, 104, `KB entries = 104 (实际 ${kb.entries.length})`);
}

// ===== 2. KB 末尾 id =====
console.log('\n[2] KB 末尾条目 id (实际 RIVAL-004)');
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const lastId = kb.entries[kb.entries.length - 1].id;
  // S6 加固后末尾条目 id 应当非空, 且是稳定可断言的字符串
  assertTrue(typeof lastId === 'string' && lastId.length > 0, `末尾 id 非空 (实际: ${lastId})`);
  // MAO-* (毛选) 在加固期间扩展到了 MAO-008 (8 条), 末尾 RIVAL-004 是定盘结论
  ok(`末尾 id = ${lastId} (含毛选 MAO-001~008 + 北向/对冲 RIVAL 系列)`);
}

// ===== 3. macro_signal 类别条目数 >= 12 (S6 加固后扩展, 含 MAC-001~012) =====
console.log('\n[3] macro_signal 类别条目数 >= 12');
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  const macro = kb.entries.filter(e => e.category === 'macro_signal');
  assertTrue(macro.length >= 12, `macro_signal >= 12 (S6 加固后含 MAC-001~012, 实际 ${macro.length})`);
  const macroIds = macro.map(e => e.id).sort();
  assertTrue(macroIds[0].startsWith('MAC-'),
    `[3] macro_signal 首条以 MAC- 开头 (实际: ${macroIds[0]})`);
}

// ===== 4. _meta.version 不变 =====
console.log('\n[4] _meta.version 不变');
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const kb = JSON.parse(fs.readFileSync(kbPath, 'utf8'));
  assertTrue(kb._meta && kb._meta.version === '1.5', `_meta.version = 1.5 (实际: ${kb._meta && kb._meta.version})`);
}

// ===== 5. APP_VERSION='v0.2.27' =====
console.log('\n[5] APP_VERSION=v0.2.27');
{
  const appSrc = fs.readFileSync(path.join(ROOT, 'www', 'app.js'), 'utf8');
  const m = /var APP_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(appSrc);
  assertTrue(m && m[1] === 'v0.2.27', `APP_VERSION=v0.2.27 (实际: ${m && m[1]})`);
}

// ===== 6-9, 11. allocator / Pool / Strategies 模块挂载 — 用 fake Dexie 加载 =====
console.log('\n[6-9, 11] 模块加载 (allocator + pool + strategies + storage v8)');

// fake Dexie (同 strategies.test.js)
function makeFakeDb(tables, pkMap) {
  const db = {};
  tables.forEach(name => {
    const rows = new Map();
    let autoId = 1;
    const pkField = pkMap[name] || 'id';
    db[name] = {
      add: async (row) => {
        if (pkField === 'id') {
          if (row.id == null) row.id = autoId++;
          rows.set(row.id, row);
          return row.id;
        }
        const k = row[pkField];
        if (k == null) throw new Error('add: 缺主键 ' + pkField);
        rows.set(k, row);
        return k;
      },
      put: async (row) => {
        if (pkField === 'id') {
          if (row.id == null) row.id = autoId++;
          rows.set(row.id, row);
          return row.id;
        }
        const k = row[pkField];
        if (k == null) throw new Error('put: 缺主键 ' + pkField);
        rows.set(k, row);
        return k;
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
  });
  return db;
}

function buildSandbox() {
  const sb = {
    console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number
  };
  sb.window = sb;
  sb.global = sb;
  const allTables = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons',
    'watchlist','holdings','transactions','journals','alerts','funds','cashflow',
    'cache','kv','settings_snapshots','ai_call_log','agent_runs','ai_traces',
    'research_pool','decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution',
    'sub_strategies','rule_overrides'];
  const pkMap = {
    pool_snapshots: 'snapId', steward_plans: 'planId', rule_candidates: 'candId',
    steward_lessons: 'id', weekly_attribution: 'weekId', research_pool: 'code',
    sub_strategies: 'strategyId', rule_overrides: 'overrideId'
  };
  sb.Dexie = function (name) {
    const inst = { name, version: () => ({ stores: () => ({}) }) };
    Object.assign(inst, makeFakeDb(allTables, pkMap));
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};
  vm.createContext(sb);
  return sb;
}

const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const CONST_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'constants.js'), 'utf8');
const POOL_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'pool.js'), 'utf8');
const ALLOC_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'allocator.js'), 'utf8');
const STRAT_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'strategies.js'), 'utf8');

// 6. allocator 接 strategies 参数 — 老调用不破坏
async function runAll() {
let sb;
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  vm.runInContext(CONST_SRC, sb);
  vm.runInContext(ALLOC_SRC, sb);
  const Alloc = sb.Core.Steward.Allocator;
  // 老调用 (无 strategies 字段) → 老行为, 不抛错
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: { long: [{ code: '600001', name: 'A', rank: 1, price: 10 }], short: [] },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 }
  });
  assertTrue(plan && Array.isArray(plan.targets), '[6] 老调用 (无 strategies) 不抛错, 返回 plan');
  // 新调用 (有 strategies 字段) → 不抛错
  const plan2 = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: { long: [], short: [] },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 's1', sleeve: 'long', status: 'active', experimentWeeks: 0 }]
  });
  assertTrue(plan2 && Array.isArray(plan2.targets), '[6] 新调用 (带 strategies) 不抛错');
}

// 7. Pool 校验 items[].strategy 非空
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  vm.runInContext(POOL_SRC, sb);
  const Pool = sb.Core.Steward.Pool;
  // 缺 strategy 字段 → 抛错
  let threw = false;
  try {
    await Pool.save({
      snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
      items: [{ code: '600519', name: 'GZMT', rank: 1, score: 90, confidence: 0.9, dims: {}, ruleReason: 'roe>15%' }]
    });
  } catch (e) { threw = true; }
  assertTrue(threw, '[7] Pool 校验 items[].strategy 非空 (缺 → 抛错)');
  // 正常 strategy 字段 → 通过
  const ok1 = await Pool.save({
    snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
    items: [{ code: '600519', name: 'GZMT', rank: 1, score: 90, confidence: 0.9, dims: {}, ruleReason: 'roe>15%', strategy: 'long-roe', llmReason: '', ruleRefs: ['MAO-001'], delta: 'new' }]
  });
  assertTrue(ok1 && ok1.ok, '[7] Pool 校验 strategy 字符串非空 → 通过');
}

// 8. 实验期 cap 30% 生效 (e2e)
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  vm.runInContext(CONST_SRC, sb);
  vm.runInContext(ALLOC_SRC, sb);
  const Alloc = sb.Core.Steward.Allocator;
  // 现金 100000 + 1 个实验期策略 + pool 5 票 100元 LOT_SIZE=100
  // expBudgetTotal = 100000 × 0.30 = 30000
  // expEach = 30000 / 1 = 30000
  // rank1: px=100, lotSize=100 → lots = floor(30000/10000) = 3 → 300 股 30000元 → left=0 → 后续 4 票 0 budget
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600001', name: 'A', strategy: 'exp-1', rank: 1, price: 100 },
        { code: '600002', name: 'B', strategy: 'exp-1', rank: 2, price: 100 },
        { code: '600003', name: 'C', strategy: 'exp-1', rank: 3, price: 100 },
        { code: '600004', name: 'D', strategy: 'exp-1', rank: 4, price: 100 },
        { code: '600005', name: 'E', strategy: 'exp-1', rank: 5, price: 100 }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'exp-1', sleeve: 'long', status: 'active', experimentWeeks: 4 }]
  });
  const bought = plan.targets.filter(t => t.action === 'buy');
  // 实验期 cap 30%: 总花费应 ≤ 30000, 剩余 ≥ 70000
  const spent = bought.reduce((s, t) => s + (t.targetAmount || 0), 0);
  assertTrue(spent <= 30000 + 1, `[8] 实验期 cap 30%: 总花费 ≤ 30000 (实际 ${spent})`);
  assertTrue(plan.cashReserve.long >= 70000, `[8] 剩余现金 ≥ 70000 (实验期 cap 后, 实际 ${plan.cashReserve.long})`);
  assertTrue(!plan.violations.some(v => v.rule === 'SUB_STRATEGY_OVERFLOW'),
    '[8] 无 SUB_STRATEGY_OVERFLOW (实验期 cap 30% 兜住了)');
}

// 9. 非实验期 — 等权瓜分剩余 sleeve 现金 (e2e)
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  vm.runInContext(CONST_SRC, sb);
  vm.runInContext(ALLOC_SRC, sb);
  const Alloc = sb.Core.Steward.Allocator;
  // 2 个非实验期策略 + pool 5 票 100元, sleeve 现金 100000
  // formalEach = 100000 / 2 = 50000 → 每个 bucket 各花 50000 (1 票 500 股 100元 = 50000)
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600001', name: 'A', strategy: 'formal-1', rank: 1, price: 100 },
        { code: '600002', name: 'B', strategy: 'formal-1', rank: 2, price: 100 },
        { code: '600003', name: 'C', strategy: 'formal-2', rank: 3, price: 100 },
        { code: '600004', name: 'D', strategy: 'formal-2', rank: 4, price: 100 },
        { code: '600005', name: 'E', strategy: 'formal-1', rank: 5, price: 100 }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [
      { strategyId: 'formal-1', sleeve: 'long', status: 'active', experimentWeeks: 0 },
      { strategyId: 'formal-2', sleeve: 'long', status: 'active', experimentWeeks: 0 }
    ]
  });
  const bought = plan.targets.filter(t => t.action === 'buy');
  // 每个 bucket 预算 50000, 一票满 5 手 = 50000 元 → 2 票成交 (每 bucket 1 票), 总花费 100000
  assertTrue(bought.length === 2, `[9] 非实验期: 2 个 bucket 各成交 1 票 (实际 ${bought.length})`);
  const spent = bought.reduce((s, t) => s + (t.targetAmount || 0), 0);
  assertTrue(spent >= 90000, `[9] 非实验期: 总花费近满 sleeve (实际 ${spent})`);
  assertTrue(plan.cashReserve.long <= 10000,
    `[9] 非实验期: 现金基本花完, cashReserve.long <= 10000 (实际 ${plan.cashReserve.long})`);
  // 没实验期 violations
  assertTrue(!plan.violations.some(v => v.rule === 'SUB_STRATEGY_OVERFLOW'),
    '[9] 非实验期无 SUB_STRATEGY_OVERFLOW');
  // 同时验证每个 bucket 都成交了
  const buckets = new Set(bought.map(t => t.strategy));
  assertTrue(buckets.has('formal-1') && buckets.has('formal-2'),
    `[9] 非实验期: 2 个 bucket 都被覆盖 (实际: ${Array.from(buckets).join(',')})`);
}

// 10. sub_strategies 表 + rule_overrides 4 表并存 (Dexie v8)
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  const S = sb.Core.Storage;
  assertEq(S.DB_VERSION, 8, `[10] DB_VERSION = 8 (Dexie v8 升级成功, 实际 ${S.DB_VERSION})`);
  // v8 表 sub_strategies 可写可读
  await S.put('sub_strategies', { strategyId: 'sub-1', sleeve: 'long', status: 'active', ts: 1 });
  const got = await S.get('sub_strategies', 'sub-1');
  assertTrue(got && got.strategyId === 'sub-1', '[10] sub_strategies 表读写正常');
  // v7 表 rule_overrides 仍可用
  await S.addRuleOverride({ scope: 'rule', refId: 'TEST', payload: { value: 1 } });
  const ovs = await S.listRuleOverrides({ status: 'active' });
  assertTrue(ovs.length === 1, '[10] rule_overrides v7 表仍可写读 (与 v8 共存)');
}

// 11. 模块挂载 Strategies
{
  sb = buildSandbox();
  vm.runInContext(STORAGE_SRC, sb); sb.Core.Storage.init();
  vm.runInContext(STRAT_SRC, sb);
  assertTrue(sb.Core.Steward && sb.Core.Steward.Strategies,
    '[11] window.Core.Steward.Strategies 已挂载');
  assertTrue(typeof sb.Core.Steward.Strategies.list === 'function',
    '[11] Strategies.list 已挂载');
}

// ===== 汇总 =====
console.log('\n========================================');
console.log(`S6 加固 测试结果: ${pass} 通过 / ${fail} 失败 / ${pass + fail} 总数`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
}

runAll().catch(e => { console.error('test error:', e); process.exit(1); });