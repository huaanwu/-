/**
 * ST Sub-Strategy — Strategies 模块单元测试 (28 项)
 *
 * 覆盖:
 *   A. Strategies.list/get (4 项)
 *   B. create 校验 (3 项: strategyId 必填 / 重复拒 / rules 格式)
 *   C. freeze/unfreeze (2 项)
 *   D. tickExperiment (4 项: 实验期满升正式 / 实验期满冻结 / 未到期不动 / 过期时正确判断)
 *   E. suggest (4 项: 空 lessons / 单 cluster / 多 cluster / 拍板后落库)
 *   F. KB 污染守卫 (3 项: sub-strategy rules 不写 KB JSON / tickExperiment 不动 KB / suggest 不写库)
 *   G. 模块挂载 (2 项)
 *   H. KIMI-6 连亏熔断 (6 项: 3 笔全亏 freeze+熔断期 / 盈利打断不触发 / 期内 already-frozen /
 *        到期恢复 / 只统计最近 3 笔 / 常数与 _recentLosses)
 *
 * 跑法: node test/orchestration/strategies.test.js
 * 必须返回 28/0 通过
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const STRAT_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'strategies.js'), 'utf8');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }

/**
 * 内存 fake Dexie (含 sub_strategies / steward_lessons / rule_overrides 等)
 */
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
      delete: async (key) => { rows.delete(key); },
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
    sub_strategies: 'strategyId', rule_overrides: 'overrideId', kv: 'key'
  };

  sb.Dexie = function (name) {
    const inst = { name, version: () => ({ stores: () => ({}) }) };
    Object.assign(inst, makeFakeDb(allTables, pkMap));
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};

  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb);
  sb.Core.Storage.init();
  vm.runInContext(STRAT_SRC, sb);
  return sb;
}

// =========================================================================
// A. Strategies.list/get — 4 项
// =========================================================================
console.log('\n[A] Strategies.list/get (4 项)');

async function runAll() {

// A1. 列表空时返 []
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const list = await Strat.list();
  assertTrue(Array.isArray(list) && list.length === 0, 'A1 空表 → list 返空数组');
}

// A2. 按 sleeve 过滤
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'long-1', sleeve: 'long', name: 'L1', rules: [{ kind: 'screener', ref: 'roe', weight: 1 }] });
  await Strat.create({ strategyId: 'long-2', sleeve: 'long', name: 'L2', rules: [{ kind: 'screener', ref: 'pe', weight: 1 }] });
  await Strat.create({ strategyId: 'short-1', sleeve: 'short', name: 'S1', rules: [{ kind: 'kb', ref: 'MAO-001', weight: 1 }] });
  const longs = await Strat.list({ sleeve: 'long' });
  assertEq(longs.length, 2, 'A2 list({sleeve:long}) → 2 条');
  assertTrue(longs.every(s => s.sleeve === 'long'), 'A2 sleeve=long 过滤');
}

// A3. 按 status 过滤
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'a', sleeve: 'long', name: 'A', rules: [{ kind: 'screener', ref: 'roe', weight: 1 }] });
  await Strat.create({ strategyId: 'b', sleeve: 'long', name: 'B', rules: [{ kind: 'screener', ref: 'pe', weight: 1 }] });
  await Strat.freeze('a');
  const frozen = await Strat.list({ status: 'frozen' });
  assertEq(frozen.length, 1, 'A3 list({status:frozen}) → 1 条');
  assertEq(frozen[0].strategyId, 'a', 'A3 frozen 是 a');
}

// A4. get 取单条 / 不存在返 null
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'foo', sleeve: 'long', name: 'F', rules: [{ kind: 'screener', ref: 'roe', weight: 1 }] });
  const got = await Strat.get('foo');
  assertTrue(got && got.strategyId === 'foo' && got.name === 'F', 'A4 get(foo) 返原 row');
  const missing = await Strat.get('not-exist');
  assertEq(missing, null, 'A4 get(not-exist) 返 null');
}

// =========================================================================
// B. create 校验 — 3 项
// =========================================================================
console.log('\n[B] create 校验 (3 项)');

// B1. strategyId 必填
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  let threw = false;
  try {
    await Strat.create({ strategyId: '', sleeve: 'long', name: 'X', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  } catch (e) { threw = true; }
  assertTrue(threw, 'B1 空 strategyId → 抛错');
}

// B2. 重复 strategyId 拒绝
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'dup', sleeve: 'long', name: 'A', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  let threw = false;
  try {
    await Strat.create({ strategyId: 'dup', sleeve: 'long', name: 'B', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  } catch (e) { threw = true; }
  assertTrue(threw, 'B2 重复 strategyId → 抛错 (拒绝覆盖)');
}

// B3. rules 格式非法 → 抛错
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  let threw = false;
  try {
    await Strat.create({ strategyId: 'bad', sleeve: 'long', name: 'X', rules: [{ kind: 'invalid-kind', ref: 'r', weight: 1 }] });
  } catch (e) { threw = true; }
  assertTrue(threw, 'B3 rules kind 非法 → 抛错');
}

// =========================================================================
// C. freeze/unfreeze — 2 项
// =========================================================================
console.log('\n[C] freeze/unfreeze (2 项)');

// C1. freeze 后 status=frozen
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'fr', sleeve: 'long', name: 'F', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  const frozen = await Strat.freeze('fr');
  assertEq(frozen.status, 'frozen', 'C1 freeze → status=frozen');
  const fresh = await Strat.get('fr');
  assertEq(fresh.status, 'frozen', 'C1 freeze 后重读 → status=frozen');
}

// C2. unfreeze 后 status=active
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'uf', sleeve: 'long', name: 'U', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  await Strat.freeze('uf');
  const unfrozen = await Strat.unfreeze('uf');
  assertEq(unfrozen.status, 'active', 'C2 unfreeze → status=active');
}

// =========================================================================
// D. tickExperiment — 4 项
// =========================================================================
console.log('\n[D] tickExperiment (4 项)');

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// D1. 实验期满 + 高胜率 → 升正式 (experimentWeeks=0)
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  // createdAt 设 5 周前, experimentWeeks=4, 已到期
  const oldTs = Date.now() - 5 * WEEK_MS;
  await Storage.put('sub_strategies', {
    strategyId: 'exp-good', sleeve: 'long', name: 'G', rules: [{ kind: 'screener', ref: 'r', weight: 1 }],
    experimentWeeks: 4, status: 'active', createdAt: oldTs, ts: oldTs
  });
  // 注入 10 笔 win + 2 笔 loss = 83% 胜率
  for (let i = 0; i < 10; i++) {
    await Storage.add('steward_lessons', { code: '600519', sleeve: 'long', pattern: 'p', decision: 'buy', outcome: 'win', pnl: 100, strategy: 'exp-good', ts: oldTs + i * 1000 });
  }
  await Storage.add('steward_lessons', { code: '600519', sleeve: 'long', pattern: 'p', decision: 'buy', outcome: 'loss', pnl: -10, strategy: 'exp-good', ts: oldTs + 11000 });

  const r = await Strat.tickExperiment(Date.now());
  assertEq(r.evaluated, 1, 'D1 evaluated=1');
  assertEq(r.promoted, 1, 'D1 高胜率 → promoted=1');
  assertEq(r.frozen, 0, 'D1 frozen=0');
  const promoted = await Strat.get('exp-good');
  assertEq(promoted.experimentWeeks, 0, 'D1 实验期满升正式 → experimentWeeks=0');
  assertTrue(promoted.lastEval && promoted.lastEval.verdict === 'promote', 'D1 lastEval.verdict=promote');
}

// D2. 实验期满 + 低胜率 → freeze
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const oldTs = Date.now() - 5 * WEEK_MS;
  await Storage.put('sub_strategies', {
    strategyId: 'exp-bad', sleeve: 'short', name: 'B', rules: [{ kind: 'screener', ref: 'r', weight: 1 }],
    experimentWeeks: 4, status: 'active', createdAt: oldTs, ts: oldTs
  });
  // 8 笔 loss + 2 笔 win = 20% 胜率 < 35% 阈值
  for (let i = 0; i < 8; i++) {
    await Storage.add('steward_lessons', { code: '300750', sleeve: 'short', pattern: 'p', decision: 'buy', outcome: 'loss', pnl: -100, strategy: 'exp-bad', ts: oldTs + i * 1000 });
  }
  await Storage.add('steward_lessons', { code: '300750', sleeve: 'short', pattern: 'p', decision: 'buy', outcome: 'win', pnl: 50, strategy: 'exp-good', ts: oldTs + 9000 });
  await Storage.add('steward_lessons', { code: '300750', sleeve: 'short', pattern: 'p', decision: 'buy', outcome: 'win', pnl: 50, strategy: 'exp-good', ts: oldTs + 10000 });

  const r = await Strat.tickExperiment(Date.now());
  assertEq(r.frozen, 1, 'D2 低胜率 → frozen=1');
  const frozen = await Strat.get('exp-bad');
  assertEq(frozen.status, 'frozen', 'D2 status=frozen');
}

// D3. 实验期未到期 → 不动
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const recent = Date.now() - 1 * WEEK_MS; // 只过 1 周, 实验期 4 周
  await Storage.put('sub_strategies', {
    strategyId: 'exp-fresh', sleeve: 'long', name: 'F', rules: [{ kind: 'screener', ref: 'r', weight: 1 }],
    experimentWeeks: 4, status: 'active', createdAt: recent, ts: recent
  });
  const r = await Strat.tickExperiment(Date.now());
  assertEq(r.evaluated, 0, 'D3 未到期 → evaluated=0');
  const fresh = await Strat.get('exp-fresh');
  assertEq(fresh.status, 'active', 'D3 未到期 → 状态不变');
  assertEq(fresh.experimentWeeks, 4, 'D3 未到期 → experimentWeeks 不变');
}

// D4. 实验期满正确判断 → 中间地带 (35%~55%) 保持观察
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const oldTs = Date.now() - 5 * WEEK_MS;
  await Storage.put('sub_strategies', {
    strategyId: 'exp-mid', sleeve: 'long', name: 'M', rules: [{ kind: 'screener', ref: 'r', weight: 1 }],
    experimentWeeks: 4, status: 'active', createdAt: oldTs, ts: oldTs
  });
  // 5 笔 win + 5 笔 loss = 50% 胜率 (灰色地带)
  for (let i = 0; i < 5; i++) {
    await Storage.add('steward_lessons', { code: '600519', sleeve: 'long', pattern: 'p', decision: 'buy', outcome: 'win', pnl: 100, strategy: 'exp-mid', ts: oldTs + i * 1000 });
  }
  for (let i = 0; i < 5; i++) {
    await Storage.add('steward_lessons', { code: '600519', sleeve: 'long', pattern: 'p', decision: 'buy', outcome: 'loss', pnl: -50, strategy: 'exp-mid', ts: oldTs + (5 + i) * 1000 });
  }
  const r = await Strat.tickExperiment(Date.now());
  assertEq(r.evaluated, 1, 'D4 evaluated=1');
  assertEq(r.promoted, 0, 'D4 中间地带 → promoted=0');
  assertEq(r.frozen, 0, 'D4 中间地带 → frozen=0');
  const mid = await Strat.get('exp-mid');
  assertEq(mid.status, 'active', 'D4 中间地带 → status 保持 active');
  assertEq(mid.experimentWeeks, 4, 'D4 中间地带 → experimentWeeks 仍为 4 (观察)');
  assertTrue(mid.lastEval && mid.lastEval.verdict === 'observe', 'D4 lastEval.verdict=observe');
}

// =========================================================================
// E. suggest — 4 项
// =========================================================================
console.log('\n[E] suggest (4 项)');

// E1. 空 lessons → []
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const drafts = Strat.suggest({ lessons: [] });
  assertTrue(Array.isArray(drafts) && drafts.length === 0, 'E1 空 lessons → []');
}

// E2. 单 cluster (同 pattern ≥3) → 1 条 draft
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const lessons = [
    { code: '600519', sleeve: 'long', pattern: 'high_roe', pnl: 100 },
    { code: '000001', sleeve: 'long', pattern: 'high_roe', pnl: 50 },
    { code: '600036', sleeve: 'long', pattern: 'high_roe', pnl: 80 }
  ];
  const drafts = Strat.suggest({ lessons });
  assertEq(drafts.length, 1, 'E2 同 pattern 3 笔 → 1 条 draft');
  assertTrue(drafts[0].name.includes('high_roe'), 'E2 draft.name 含 pattern');
  assertTrue(drafts[0].evidence.samples === 3, 'E2 evidence.samples=3');
}

// E3. 多 cluster → 多条 draft (按胜率降序)
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const lessons = [
    // cluster A: 5 笔全 win → 胜率 1.0
    { code: '600519', sleeve: 'long', pattern: 'patA', pnl: 100 },
    { code: '000001', sleeve: 'long', pattern: 'patA', pnl: 50 },
    { code: '600036', sleeve: 'long', pattern: 'patA', pnl: 80 },
    { code: '601318', sleeve: 'long', pattern: 'patA', pnl: 30 },
    { code: '600000', sleeve: 'long', pattern: 'patA', pnl: 20 },
    // cluster B: 3 笔 win + 1 笔 loss → 胜率 0.75
    { code: '300750', sleeve: 'long', pattern: 'patB', pnl: 100 },
    { code: '300760', sleeve: 'long', pattern: 'patB', pnl: 50 },
    { code: '300015', sleeve: 'long', pattern: 'patB', pnl: -20 },
    { code: '300014', sleeve: 'long', pattern: 'patB', pnl: 80 }
  ];
  const drafts = Strat.suggest({ lessons });
  assertEq(drafts.length, 2, 'E3 多 cluster → 2 条 draft');
  assertTrue(drafts[0].evidence.winRate > drafts[1].evidence.winRate, 'E3 drafts 按 winRate 降序');
}

// E4. suggest 是纯函数 → 不写 sub_strategies / rule_candidates 等表
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const lessons = [
    { code: '600519', sleeve: 'long', pattern: 'high_roe', pnl: 100 },
    { code: '000001', sleeve: 'long', pattern: 'high_roe', pnl: 50 },
    { code: '600036', sleeve: 'long', pattern: 'high_roe', pnl: 80 }
  ];
  const drafts = Strat.suggest({ lessons });
  // 拍板后用户手动调 create 落库 — 这里只验证 suggest 没自动写
  const allSubs = await Storage.all('sub_strategies');
  assertEq(allSubs.length, 0, 'E4 suggest 没自动写 sub_strategies (纯函数)');
  const allCands = await Storage.all('rule_candidates');
  assertEq(allCands.length, 0, 'E4 suggest 没自动写 rule_candidates');
  // 模拟拍板后落库
  await Strat.create({ strategyId: drafts[0].strategyId, sleeve: 'long', name: drafts[0].name, rules: drafts[0].rules });
  const after = await Storage.all('sub_strategies');
  assertEq(after.length, 1, 'E4 手动拍板 create 后 → sub_strategies 落库 1 条');
}

// =========================================================================
// F. KB 污染守卫 — 3 项
// =========================================================================
console.log('\n[F] KB 污染守卫 (3 项)');

// F1. sub-strategy rules 不写 KB JSON
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const before = fs.readFileSync(kbPath, 'utf8');
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  await Strat.create({ strategyId: 'kb-test', sleeve: 'long', name: 'KT', rules: [{ kind: 'kb', ref: 'MAO-001', weight: 1 }] });
  const after = fs.readFileSync(kbPath, 'utf8');
  assertEq(after, before, 'F1 create 不修改 KB JSON (rules 里只引用 KB id, 不写 KB 文件)');
}

// F2. tickExperiment 不动 KB
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const before = fs.readFileSync(kbPath, 'utf8');
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const oldTs = Date.now() - 5 * WEEK_MS;
  await Storage.put('sub_strategies', {
    strategyId: 'kb-tick', sleeve: 'long', name: 'KT', rules: [{ kind: 'kb', ref: 'MAO-001', weight: 1 }],
    experimentWeeks: 4, status: 'active', createdAt: oldTs, ts: oldTs
  });
  await Strat.tickExperiment(Date.now());
  const after = fs.readFileSync(kbPath, 'utf8');
  assertEq(after, before, 'F2 tickExperiment 不修改 KB JSON');
}

// F3. suggest 不写库 (KB / sub_strategies / rule_candidates)
{
  const kbPath = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
  const before = fs.readFileSync(kbPath, 'utf8');
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  Strat.suggest({ lessons: [
    { code: '600519', sleeve: 'long', pattern: 'p', pnl: 100 },
    { code: '000001', sleeve: 'long', pattern: 'p', pnl: 50 },
    { code: '600036', sleeve: 'long', pattern: 'p', pnl: 80 }
  ]});
  const afterKb = fs.readFileSync(kbPath, 'utf8');
  assertEq(afterKb, before, 'F3 suggest 不写 KB JSON');
  assertEq((await Storage.all('sub_strategies')).length, 0, 'F3 suggest 不写 sub_strategies');
  assertEq((await Storage.all('rule_candidates')).length, 0, 'F3 suggest 不写 rule_candidates');
}

// =========================================================================
// G. 模块挂载 — 2 项
// =========================================================================
console.log('\n[G] 模块挂载 (2 项)');

// G1. window.Core.Steward.Strategies 全方法暴露
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  assertTrue(typeof Strat.list === 'function', 'G1 list 暴露');
  assertTrue(typeof Strat.get === 'function', 'G1 get 暴露');
  assertTrue(typeof Strat.create === 'function', 'G1 create 暴露');
  assertTrue(typeof Strat.freeze === 'function', 'G1 freeze 暴露');
  assertTrue(typeof Strat.unfreeze === 'function', 'G1 unfreeze 暴露');
  assertTrue(typeof Strat.tickExperiment === 'function', 'G1 tickExperiment 暴露');
  assertTrue(typeof Strat.suggest === 'function', 'G1 suggest 暴露');
  assertTrue(typeof Strat._stats === 'function', 'G1 _stats (内部) 暴露');
  assertEq(Strat.TABLE, 'sub_strategies', 'G1 TABLE=sub_strategies');
  assertEq(Strat.DEFAULT_EXPERIMENT_WEEKS, 4, 'G1 DEFAULT_EXPERIMENT_WEEKS=4');
}

// G2. IIFE 二次加载不报错
{
  const sb = buildSandbox();
  delete sb.Core.Steward;
  let err = null;
  try {
    vm.runInContext(STRAT_SRC, sb);
  } catch (e) {
    err = e;
  }
  assertTrue(err === null, 'G2 IIFE 二次加载不抛错');
  assertTrue(sb.Core && sb.Core.Steward && sb.Core.Steward.Strategies,
    'G2 二次加载后 Strategies 仍挂载');
}

// =========================================================================
// H. KIMI-6 连亏熔断 — 6 项
// =========================================================================
console.log('\n[H] KIMI-6 连亏熔断 (6 项)');

// H1. 最近 3 笔全亏 → freeze + circuitUntil (3 天后)
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const now = 1_700_000_000_000;
  await Strat.create({ strategyId: 's-loss', sleeve: 'short', name: '连亏策略', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  const lessons = [
    { strategy: 's-loss', pnl: -100, ts: now - 3 * 86400e3 },
    { strategy: 's-loss', pnl: -50, ts: now - 2 * 86400e3 },
    { strategy: 's-loss', pnl: -80, ts: now - 1 * 86400e3 }
  ];
  const r = await Strat.checkLossStreak({ strategyId: 's-loss', lessons, now });
  assertEq(r.status, 'frozen', 'H1 最近 3 笔全亏 → frozen');
  assertTrue(r.circuitUntil === now + 3 * 86400e3, 'H1 circuitUntil = now + 3 天');
  const s = await Strat.get('s-loss');
  assertTrue(s.status === 'frozen' && s.lastCircuit && s.lastCircuit.tripCount === 1, 'H1 策略 frozen + lastCircuit 记录');
  const circuit = await Storage.kvGet('steward_circuit_s-loss');
  assertTrue(circuit && circuit.until === now + 3 * 86400e3, 'H1 kv 熔断标记写入');
}

// H2. 有 2 笔亏损 + 1 笔盈利 → 不触发 (连亏必须连续且 ≥3)
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const now = 1_700_000_000_000;
  await Strat.create({ strategyId: 's-mixed', sleeve: 'short', name: '混合', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  const lessons = [
    { strategy: 's-mixed', pnl: -100, ts: now - 3 * 86400e3 },
    { strategy: 's-mixed', pnl: 50, ts: now - 2 * 86400e3 },   // 盈利打断连亏
    { strategy: 's-mixed', pnl: -80, ts: now - 1 * 86400e3 }
  ];
  const r = await Strat.checkLossStreak({ strategyId: 's-mixed', lessons, now });
  assertEq(r.status, 'active', 'H2 中间有盈利 → 不触发熔断');
  const s = await Strat.get('s-mixed');
  assertEq(s.status, 'active', 'H2 策略保持 active');
}

// H3. 熔断期内再次检查 → already-frozen, 不重复计数
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const now = 1_700_000_000_000;
  await Strat.create({ strategyId: 's-repeat', sleeve: 'short', name: 'R', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  await Storage.kvSet('steward_circuit_s-repeat', { at: now - 1 * 86400e3, until: now + 1 * 86400e3, trips: 1 });
  const lessons = [{ strategy: 's-repeat', pnl: -10, ts: now }];
  const r = await Strat.checkLossStreak({ strategyId: 's-repeat', lessons, now });
  assertEq(r.status, 'already-frozen', 'H3 熔断期内 → already-frozen');
  const circuit = await Storage.kvGet('steward_circuit_s-repeat');
  assertEq(circuit.trips, 1, 'H3 trips 不重复累加');
}

// H4. 熔断期到期 → 清标记 + 恢复 active
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const Storage = sb.Core.Storage;
  const now = 1_700_000_000_000;
  await Strat.create({ strategyId: 's-recover', sleeve: 'short', name: 'R2', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  await Strat.freeze('s-recover');
  await Storage.kvSet('steward_circuit_s-recover', { at: now - 4 * 86400e3, until: now - 1 * 86400e3, trips: 1 });
  const r = await Strat.checkLossStreak({ strategyId: 's-recover', lessons: [], now });
  assertEq(r.status, 'active', 'H4 熔断期已过 → 恢复 active');
  const circuit = await Storage.kvGet('steward_circuit_s-recover');
  assertEq(circuit, null, 'H4 熔断标记已清除');
  const s = await Strat.get('s-recover');
  assertEq(s.status, 'active', 'H4 策略回 active');
}

// H5. 只统计最近 3 笔 (更早的亏损不算)
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  const now = 1_700_000_000_000;
  await Strat.create({ strategyId: 's-old', sleeve: 'long', name: 'O', rules: [{ kind: 'screener', ref: 'r', weight: 1 }] });
  const lessons = [
    { strategy: 's-old', pnl: -100, ts: now - 10 * 86400e3 },  // 更早的亏损忽略
    { strategy: 's-old', pnl: 50, ts: now - 2 * 86400e3 },
    { strategy: 's-old', pnl: 80, ts: now - 1 * 86400e3 }
  ];
  const r = await Strat.checkLossStreak({ strategyId: 's-old', lessons, now });
  assertEq(r.status, 'active', 'H5 更早亏损不参与连亏统计, 最近 3 笔有盈利');
}

// H6. 常数与 _recentLosses 暴露
{
  const sb = buildSandbox();
  const Strat = sb.Core.Steward.Strategies;
  assertEq(Strat.LOSS_STREAK_TRIP, 3, 'H6 LOSS_STREAK_TRIP=3');
  assertEq(Strat.CIRCUIT_DAYS, 3, 'H6 CIRCUIT_DAYS=3');
  assertTrue(typeof Strat.checkLossStreak === 'function', 'H6 checkLossStreak 暴露');
  assertEq(Strat._recentLosses([{ pnl: -1, ts: 2 }, { pnl: -2, ts: 1 }], 2).length, 2, 'H6 _recentLosses 全亏 2 笔');
  assertEq(Strat._recentLosses([{ pnl: -1, ts: 2 }, { pnl: 2, ts: 1 }], 2).length, 0, 'H6 _recentLosses 有盈利 → 空');
}

// =========================================================================
// 汇总
// =========================================================================
console.log('\n========================================');
console.log(`Strategies 测试结果: ${pass} 通过 / ${fail} 失败 / ${pass + fail} 总数`);
console.log('========================================');
process.exit(fail > 0 ? 1 : 0);
}

runAll().catch(e => { console.error('test error:', e); process.exit(1); });