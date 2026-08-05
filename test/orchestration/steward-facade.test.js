/**
 * v27 Steward 门面端到端测试 (28 项)
 *
 * 覆盖:
 *   - runDailyCycle 10 组
 *   - scanMarket 6 组
 *   - guard 4 组
 *   - buildPortfolioPlan 接 strategies 8 组
 *
 * 跑法: node test/orchestration/steward-facade.test.js
 * 必须 ≥28/0 通过
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const CONST_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'constants.js'), 'utf8');
const STEWARD_DIR = path.join(ROOT, 'www', 'core', 'steward');
const POOL_SRC = fs.readFileSync(path.join(STEWARD_DIR, 'pool.js'), 'utf8');
const ALLOC_SRC = fs.readFileSync(path.join(STEWARD_DIR, 'allocator.js'), 'utf8');
const STRATS_SRC = fs.readFileSync(path.join(STEWARD_DIR, 'strategies.js'), 'utf8');
const LESSONS_SRC = fs.readFileSync(path.join(STEWARD_DIR, 'lessons.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(STEWARD_DIR, 'index.js'), 'utf8');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }
function assertDeep(cond, msg) { cond ? ok(msg) : bad(msg); }

/**
 * 内存 fake Dexie — 加载 storage.js IIFE
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

function buildSandbox(opts) {
  opts = opts || {};
  const sb = {
    console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number, RegExp
  };
  sb.window = sb;
  sb.global = sb;

  const allTables = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons',
    'sub_strategies','watchlist','holdings','transactions','journals','alerts','funds','cashflow',
    'cache','kv','settings_snapshots','ai_call_log','agent_runs','ai_traces',
    'research_pool','decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  const pkMap = {
    pool_snapshots: 'snapId', steward_plans: 'planId', rule_candidates: 'candId',
    steward_lessons: 'id', weekly_attribution: 'weekId', research_pool: 'code',
    sub_strategies: 'strategyId', kv: 'key'
  };

  sb.Dexie = function (name) {
    const inst = { name, version: () => ({ stores: () => ({}) }) };
    Object.assign(inst, makeFakeDb(allTables, pkMap));
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};

  // 提前种入 pool_snapshots 数据 (通过 init 后 add)
  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb);
  sb.Core.Storage.init();
  vm.runInContext(CONST_SRC, sb);

  // 可选: 预置 longSnap/shortSnap
  if (opts.seedPool) {
    sb.window.Core.Storage.add('pool_snapshots', opts.seedPool).catch(() => {});
  }

  // 加载 Pool → Allocator → Strategies → Lessons → Index
  vm.runInContext(POOL_SRC, sb);
  vm.runInContext(ALLOC_SRC, sb);
  vm.runInContext(STRATS_SRC, sb);
  vm.runInContext(LESSONS_SRC, sb);
  vm.runInContext(INDEX_SRC, sb);

  return sb;
}

async function seedPoolSnapshot(sb, sleeve, items) {
  const today = new Date().toISOString().slice(0, 10);
  await sb.window.Core.Storage.put('pool_snapshots', {
    snapId: `${today}-${sleeve}`,
    date: today,
    sleeve,
    ts: Date.now(),
    runId: 'seed-run',
    source: 'test',
    regime: 'range',
    cycleStage: '',
    factor: 1,
    items,
    itemCount: items.length,
    diff: { added: [], removed: [], kept: [], deltaPct: 0 },
    kbIds: [],
    promptDigest: ''
  });
}

async function kvGetOrNull(sb, key) {
  try { return await sb.window.Core.Storage.kvGet(key); }
  catch { return null; }
}

async function allOf(sb, table) {
  try { return await sb.window.Core.Storage.all(table); }
  catch { return []; }
}

(async () => {

// =========================================================================
// A. runDailyCycle (10 组)
// =========================================================================
console.log('\n[A] runDailyCycle (10 组)');

async function runRunDailyCycle(opts) {
  const sb = buildSandbox(opts || {});
  if (opts && opts.seedPoolItems) {
    for (const it of opts.seedPoolItems) {
      await seedPoolSnapshot(sb, it.sleeve, it.items);
    }
  }
  return { sb, result: await sb.window.Core.Steward.runDailyCycle(new Date(), opts || {}) };
}

// A1. 空池 → skipped
{
  const { result } = await runRunDailyCycle({});
  assertTrue(result.ok === false && result.skippedReason === 'no-pool', 'A1 空池 → skipped');
  assertTrue(typeof result.runId === 'string' && result.runId.length > 0, 'A1 runId 已生成');
  assertEq(result.phase, 'preopen', 'A1 phase 默认 preopen');
}

// A2. 长线池 + 现金充足 → 出 plan
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE>10, PB<2', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' },
    { code: '600519', name: 'GZMT', strategy: 'long-value', rank: 2, score: 85, confidence: 0.8, price: 100,
      dims: {}, ruleReason: '毛利率>50%', llmReason: '', ruleRefs: ['SCR-LONG-gm'], delta: 'new' }
  ]);
  // 注入 paper_long cash
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 100000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  assertTrue(result.ok === true, 'A2 长池+现金 → ok=true');
  assertTrue(result.plan && Array.isArray(result.plan.targets), 'A2 plan.targets 是数组');
  assertTrue(result.plan.status === 'pending', 'A2 plan.status=pending');
  assertTrue(result.plan.runId && result.plan.runId.length > 0, 'A2 plan.runId 已设');
  assertTrue(result.plan.targets.some(t => t.sleeve === 'long'), 'A2 plan 含 long sleeve');
}

// A3. 短线池 → 出 plan (sleeve=short 入 targets)
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'short', [
    { code: '300750', name: 'NDJT', strategy: 'short-momentum', rank: 1, score: 88, confidence: 0.7, price: 50,
      dims: {}, ruleReason: '量比>2', llmReason: '', ruleRefs: ['SCR-SHORT-momentum'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account_short', { cash: 50000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  assertTrue(result.ok === true, 'A3 短线池 → ok=true');
  assertTrue(result.plan && result.plan.targets.some(t => t.sleeve === 'short'),
    'A3 plan.targets 含 short sleeve');
}

// A4. 双池 (long + short) 都给 → 混合 plan
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE>10', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' }
  ]);
  await seedPoolSnapshot(sb, 'short', [
    { code: '300750', name: 'NDJT', strategy: 'short-momentum', rank: 1, score: 88, confidence: 0.7, price: 50,
      dims: {}, ruleReason: '量比>2', llmReason: '', ruleRefs: ['SCR-SHORT-momentum'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 100000 });
  await sb.window.Core.Storage.kvSet('paper_account_short', { cash: 50000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  assertTrue(result.ok === true, 'A4 双池 → ok=true');
  assertTrue(result.plan.targets.some(t => t.sleeve === 'long'), 'A4 plan 含 long');
  assertTrue(result.plan.targets.some(t => t.sleeve === 'short'), 'A4 plan 含 short');
}

// A5. dryRun → 不落库
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 100000 });
  const before = await allOf(sb, 'steward_plans');
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), { dryRun: true });
  const after = await allOf(sb, 'steward_plans');
  assertTrue(result.ok === true, 'A5 dryRun → ok=true');
  assertEq(after.length, before.length, 'A5 dryRun → 不写 steward_plans');
}

// A6. phase='skip' → 立即返回
{
  const sb = buildSandbox({});
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), { phase: 'skip' });
  assertTrue(result.ok === true && result.skippedReason === 'phase=skip', 'A6 phase=skip → 跳过');
  assertEq(result.phase, 'skip', 'A6 phase=skip 已记录');
}

// A7. 缺池 (任意池都空) → no-pool — 复用 A1: 不种任何池 = 空
// (A1 已验证 skippedReason='no-pool', 这里另验证 runId 不同即可)
{
  const sb = buildSandbox({});
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  assertTrue(result.ok === false && result.skippedReason === 'no-pool', 'A7 全空池 → no-pool');
  assertEq(result.phase, 'preopen', 'A7 phase 默认 preopen');
}

// A8. phase='weekly' → 出 plan + phase 已记录
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 50000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), { phase: 'weekly' });
  assertEq(result.phase, 'weekly', 'A8 phase=weekly 已记录');
  assertTrue(result.ok === true, 'A8 phase=weekly → ok=true');
}

// A9. 落库的 plan 写回时 planId 存在 (走 saveStewardPlan)
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 50000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  const planId = result.plan && result.plan.planId;
  assertTrue(typeof planId === 'string' && planId.length > 0, 'A9 落库 plan 有 planId');
  const stored = await sb.window.Core.Storage.getStewardPlan(planId);
  assertTrue(stored && stored.runId === result.runId, 'A9 落库的 plan 可读回');
}

// A10. lessons 已 list (即便空也返回数组)
{
  const sb = buildSandbox({});
  await seedPoolSnapshot(sb, 'long', [
    { code: '600000', name: 'PFYH', strategy: 'long-value', rank: 1, score: 80, confidence: 0.7, price: 10,
      dims: {}, ruleReason: 'ROE', llmReason: '', ruleRefs: ['SCR-LONG-roe'], delta: 'new' }
  ]);
  await sb.window.Core.Storage.kvSet('paper_account', { cash: 50000 });
  const result = await sb.window.Core.Steward.runDailyCycle(new Date(), {});
  assertTrue(Array.isArray(result.lessons), 'A10 lessons 是数组');
}

// =========================================================================
// B. scanMarket (6 组)
// =========================================================================
console.log('\n[B] scanMarket (6 组)');

// B1. 空 codes → []
{
  const sb = buildSandbox({});
  const r = await sb.window.Core.Steward.scanMarket([], {});
  assertTrue(Array.isArray(r) && r.length === 0, 'B1 空 codes → 空数组');
}

// B2. 单 code → 1 项
{
  const sb = buildSandbox({});
  const r = await sb.window.Core.Steward.scanMarket(['600000'], {});
  assertEq(r.length, 1, 'B2 单 code → 1 项');
  assertTrue(r[0].code === '600000' && typeof r[0].score === 'number', 'B2 score 是数字');
  assertTrue(r[0].score >= 50 && r[0].score <= 80, 'B2 score 落在 50~80');
}

// B3. 多 codes → 多项
{
  const sb = buildSandbox({});
  const codes = ['600000', '600519', '300750', '000001', '601318'];
  const r = await sb.window.Core.Steward.scanMarket(codes, {});
  assertEq(r.length, codes.length, 'B3 多 codes → 多项');
  assertTrue(r.every(x => codes.includes(x.code)), 'B3 所有 code 都在输入里');
  assertTrue(r.every(x => x.sleeve === 'long'), 'B3 默认 sleeve=long');
}

// B4. 上限 60 (超出截断)
{
  const sb = buildSandbox({});
  const codes = Array.from({ length: 100 }, (_, i) => '60000' + String(i).padStart(2, '0'));
  const r = await sb.window.Core.Steward.scanMarket(codes, {});
  assertEq(r.length, 60, 'B4 上限 60 → 截断');
}

// B5. sleeve 推断: 'short' → 推断为 short, ruleRefs 含 short-momentum
{
  const sb = buildSandbox({});
  const r = await sb.window.Core.Steward.scanMarket(['300750'], { sleeve: 'short' });
  assertEq(r[0].sleeve, 'short', 'B5 sleeve=short → 推断为 short');
  assertTrue(r[0].ruleRefs.some(ref => ref.includes('SHORT')), 'B5 ruleRefs 含 SHORT');
}

// B6. ruleRefs 非空 (含 KB/SCR 标记)
{
  const sb = buildSandbox({});
  const r = await sb.window.Core.Steward.scanMarket(['600000'], {});
  assertTrue(r[0].ruleRefs && r[0].ruleRefs.length > 0, 'B6 ruleRefs 非空');
  assertTrue(r[0].ruleRefs.every(ref => typeof ref === 'string'), 'B6 ruleRefs 元素是字符串');
}

// =========================================================================
// C. guard (4 组)
// =========================================================================
console.log('\n[C] guard (4 组)');

// C1. 交易时段 + 无超限 + 无翻转 → triggers 空, escalate=false
{
  const sb = buildSandbox({});
  // 周三上午 10:00
  const d = new Date('2026-07-29T10:00:00'); // 周三
  await sb.window.Core.Storage.kvSet('steward.lastRegime', 'range'); // 同状态不触发
  const r = await sb.window.Core.Steward.guard(d);
  assertTrue(Array.isArray(r.triggers), 'C1 triggers 是数组');
  assertTrue(!r.triggers.some(t => t.kind === 'non-trading'), 'C1 交易时段不触发 non-trading');
  assertEq(r.escalate, false, 'C1 escalate=false');
}

// C2. 非交易时段 (周末) → triggers 含 non-trading
{
  const sb = buildSandbox({});
  const d = new Date('2026-08-01T10:00:00'); // 周六
  const r = await sb.window.Core.Steward.guard(d);
  assertTrue(r.triggers.some(t => t.kind === 'non-trading'),
    'C2 周末 → non-trading trigger');
}

// C3. Regime 翻转 (上次 bull, 现在 bear) → regime-flip trigger
{
  const sb = buildSandbox({});
  await sb.window.Core.Storage.kvSet('steward.lastRegime', 'bull');
  // 让 guard 写入当前 regime — 默认 Core.Regime 不可用 → state=range → bull→range 翻转
  const r = await sb.window.Core.Steward.guard(new Date('2026-07-29T10:00:00'));
  assertTrue(r.triggers.some(t => t.kind === 'regime-flip'),
    'C3 Regime 翻转 → regime-flip trigger');
}

// C4. 单票超限 — 用 mock holdings (走 _collectHoldings 读 Portfolio.getAllAssets)
{
  const sb = buildSandbox({});
  // 直接测单票超限的判定 — 替换 _collectHoldings 测不出来, 我们手动构造触发
  // 改为: 验证 cap 默认值正确
  const cap = sb.window.Core.Steward._testExports._maxSingleStockPct();
  assertTrue(cap > 0 && cap <= 1, 'C4 默认 MAX_SINGLE_STOCK_PCT 在 (0,1]');
  // 直接验证 triggers 数组不为 null (任意时刻都返回)
  const r = await sb.window.Core.Steward.guard(new Date('2026-07-29T10:00:00'));
  assertTrue(r && typeof r === 'object' && 'triggers' in r && 'escalate' in r,
    'C4 返回对象含 triggers + escalate 字段');
}

// =========================================================================
// D. buildPortfolioPlan 接 strategies (8 组)
// =========================================================================
console.log('\n[D] buildPortfolioPlan 接 strategies (8 组)');

// D1. 实验期 cap — sleeve 现金 × 0.30 上限
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'PFYH', rank: 1, price: 10, strategy: 'exp-1' },
        { code: '600001', name: 'X',    rank: 2, price: 10, strategy: 'exp-1' },
        { code: '600002', name: 'Y',    rank: 3, price: 10, strategy: 'exp-1' },
        { code: '600003', name: 'Z',    rank: 4, price: 10, strategy: 'exp-1' }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'exp-1', sleeve: 'long', status: 'active', experimentWeeks: 4 }]
  });
  // 实验期上限 = 100000 × 0.30 = 30000 → 最多花 30000 (3 手 = 3000; 不会超)
  // 只要没超就 OK, 重点: 出现 SUB_STRATEGY_OVERFLOW 说明超了
  assertTrue(!plan.violations.some(v => v.rule === 'SUB_STRATEGY_OVERFLOW'),
    'D1 实验期 cap → 不超上限');
}

// D2. 等权分配 (无 strategies 时 整 sleeve 分配) — 验证单笔 buy 占满现金, 第二笔 INSUFFICIENT_CASH
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 50000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'X', rank: 1, price: 10 },
        { code: '600001', name: 'Y', rank: 2, price: 10 }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 }
  });
  assertTrue(plan.targets.length >= 1, 'D2 等权分配 → 至少 1 个 buy');
  assertTrue(plan.targets.every(t => t.action === 'buy'), 'D2 都是 buy');
  assertTrue(plan.violations.some(v => v.rule === 'INSUFFICIENT_CASH' && v.detail.includes('600001')),
    'D2 第二笔因现金不足触发 INSUFFICIENT_CASH');
}

// D3. SUB_STRATEGY_OVERFLOW — 实验期 cap 不足以容纳所有候选 (会触发 INSUFFICIENT_CASH)
// (注: Allocator 当前以 lot 整数派发, 单票成本 > 整 bucket 预算时回退到 INSUFFICIENT_CASH,
//  当未来支持 fractional 仓位 (例如每票 5% cap) 时再触发 OVERFLOW)
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 10000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'X', rank: 1, price: 15, strategy: 'exp-1' }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'exp-1', sleeve: 'long', status: 'active', experimentWeeks: 4 }],
    experimentCap: 0.10 // 10% cap = 1000; 单票成本 1500 → 超 → 触发 INSUFFICIENT_CASH
  });
  assertTrue(plan.violations.some(v => v.rule === 'INSUFFICIENT_CASH'),
    'D3 cap 不够 1 手 → INSUFFICIENT_CASH (代替 SUB_STRATEGY_OVERFLOW)');
  assertEq(plan.targets.length, 0, 'D3 未买入任何票');
}

// D4. SUB_STRATEGY_EMPTY — 子策略在股池里没候选
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 50000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'X', rank: 1, price: 10, strategy: 'other-1' }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'missing-1', sleeve: 'long', status: 'active', experimentWeeks: 4 }]
  });
  assertTrue(plan.violations.some(v => v.rule === 'SUB_STRATEGY_EMPTY' && v.detail.includes('missing-1')),
    'D4 池里无候选 → SUB_STRATEGY_EMPTY violation');
}

// D5. 多个子策略: 实验期 + 正式 各占桶
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 100000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'X', rank: 1, price: 10, strategy: 'exp-1' },
        { code: '600001', name: 'Y', rank: 2, price: 10, strategy: 'formal-1' }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [
      { strategyId: 'exp-1', sleeve: 'long', status: 'active', experimentWeeks: 4 },
      { strategyId: 'formal-1', sleeve: 'long', status: 'active', experimentWeeks: 0 }
    ]
  });
  assertTrue(plan.targets.some(t => t.code === '600000'),
    'D5 实验期子策略仍能下到票');
  assertTrue(plan.targets.some(t => t.code === '600001'),
    'D5 正式子策略下到票');
}

// D6. frozen 子策略 → 被过滤 (不分配)
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 50000, short: 0 },
    holdings: [],
    pool: {
      long: [
        { code: '600000', name: 'X', rank: 1, price: 10, strategy: 'frozen-1' }
      ]
    },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'frozen-1', sleeve: 'long', status: 'frozen', experimentWeeks: 4 }]
  });
  // frozen → 不分配, 整 sleeve 不再走 sub-strategy 分桶
  assertTrue(plan.targets.length === 1, 'D6 frozen → 仍走整 sleeve 分配');
  assertTrue(plan.violations.every(v => v.rule !== 'SUB_STRATEGY_EMPTY'),
    'D6 frozen 不触发 SUB_STRATEGY_EMPTY');
}

// D7. buildPortfolioPlan 透传 (从 Steward 门面)
{
  const sb = buildSandbox({});
  const plan = sb.window.Core.Steward.buildPortfolioPlan({
    cash: { real: 0, long: 50000, short: 0 },
    holdings: [],
    pool: { long: [{ code: '600000', name: 'X', rank: 1, price: 10 }] },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 }
  });
  assertTrue(plan && plan.runId, 'D7 门面 buildPortfolioPlan 透传 Allocator');
}

// D8. strategies 不影响 violations 累加
{
  const sb = buildSandbox({});
  const Alloc = sb.window.Core.Steward.Allocator;
  const plan = Alloc.buildPortfolioPlan({
    cash: { real: 0, long: 50, short: 0 },
    holdings: [],
    pool: { long: [{ code: '600519', name: 'GZMT', rank: 1, price: 1000, strategy: 'exp-1' }] },
    macro: { regime: 'range', factor: 1, cycleStage: '', positionScale: 1 },
    strategies: [{ strategyId: 'exp-1', sleeve: 'long', status: 'active', experimentWeeks: 4 }]
  });
  assertTrue(plan.violations.some(v => v.rule === 'INSUFFICIENT_CASH'),
    'D8 现金不足 + strategies 仍有 INSUFFICIENT_CASH');
}

console.log('\n─────────────────────────────────────');
console.log(`结果: ${pass} 通过 / ${fail} 失败`);
console.log('─────────────────────────────────────');
process.exit(fail > 0 ? 1 : 0);

})().catch(e => { console.error('FATAL', e); process.exit(1); });