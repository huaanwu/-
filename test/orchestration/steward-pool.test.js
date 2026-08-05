/**
 * S3 Steward — Pool 股池快照模块单元测试 (24 项)
 *
 * 跑法: node test/orchestration/steward-pool.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const POOL_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'pool.js'), 'utf8');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }
function assertThrows(fn, regex, msg) {
  // 处理两种形态: 同步抛 + async 抛
  let p;
  try { p = fn(); } catch (e) { if (regex.test(e.message)) { ok(msg); return; } else { bad(msg + ' 同步抛但消息不符: ' + e.message); return; } }
  if (p && typeof p.then === 'function') {
    return p.then(
      () => bad(msg + ' (async 未抛)'),
      (e) => { if (regex.test(e.message)) ok(msg); else bad(msg + ' async 抛错但消息不符: ' + e.message); }
    );
  }
  bad(msg + ' (未抛)');
}

/**
 * 内存 fake Dexie — 支持 add/put/get/where().equals().toArray()
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
      clear: async () => { rows.clear(); },
      delete: async (k) => { rows.delete(k); return 1; },
      bulkDelete: async (ks) => { ks.forEach(k => rows.delete(k)); return ks.length; }
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

  const allTables = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons',
    'watchlist','holdings','transactions','journals','alerts','funds','cashflow',
    'cache','kv','settings_snapshots','ai_call_log','agent_runs','ai_traces',
    'research_pool','decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  const pkMap = {
    pool_snapshots: 'snapId', steward_plans: 'planId', rule_candidates: 'candId',
    steward_lessons: 'id', weekly_attribution: 'weekId', research_pool: 'code'
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
  vm.runInContext(POOL_SRC, sb);
  sb.Core.Storage.init();
  return sb;
}

// =====================================================================
// 异步段: 字段校验拒收 + diff 纯函数 + 模块挂载 + save/get/list/turnover
// =====================================================================
async function runAsyncTests() {
  console.log('\n[A1] 字段校验拒收 (8 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    await assertThrows(() => Pool.save(null), /非空/, 'A1a save(null) 拒');
    await assertThrows(() => Pool.save({ date: '2026-07-31', sleeve: 'long' }), /snapId/, 'A1b 缺 snapId 拒');
    await assertThrows(() => Pool.save({ snapId: 'x', sleeve: 'long' }), /date/, 'A1c 缺 date 拒');
    await assertThrows(() => Pool.save({ snapId: 'x', date: '2026-07-31' }), /sleeve/, 'A1d 缺 sleeve 拒');
    await assertThrows(() => Pool.save({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', items: [] }), /items 不能为空/, 'A1e 空 items 拒');
    await assertThrows(() => Pool.save({ snapId: 'x-long', date: '2026-07-31', sleeve: 'wrong', items: [{ code: '600000', strategy: 'st-x', ruleReason:'x' }] }), /sleeve 仅/, 'A1f 非法 sleeve 拒');
    await assertThrows(() => Pool.save({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', items: [{ code: '600000', strategy: 'st-x', ruleReason:'' }] }), /ruleReason 不能为空/, 'A1g 空 ruleReason 拒');
    await assertThrows(() => Pool.save({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
      items: [{ code: '600000', strategy: 'st-x', ruleReason:'a' }, { code: '600000', strategy: 'st-x', ruleReason:'b' }] }), /重复 code/, 'A1h 重复 code 拒');
  }

  console.log('\n[A2] diff 纯函数 (4 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    const a = { items: [{ code: 'A' }, { code: 'B' }, { code: 'C' }] };
    const b = { items: [{ code: 'B' }, { code: 'C' }, { code: 'D' }, { code: 'E' }] };
    const d = Pool.diff(a, b);
    assertTrue(Array.isArray(d.added) && d.added.length === 2 && d.added.includes('D') && d.added.includes('E'), 'D1a added=[D,E]');
    assertTrue(d.removed.length === 1 && d.removed[0] === 'A', 'D1b removed=[A]');
    assertTrue(d.kept.length === 2 && d.kept.includes('B') && d.kept.includes('C'), 'D1c kept=[B,C]');
    assertEq(d.deltaPct, 25, 'D2 deltaPct=round((2-1)/4*100)=25');

    const dEmpty = Pool.diff(null, b);
    assertTrue(dEmpty.added.length === 0 && dEmpty.removed.length === 0, 'D3 a=null → 全空');

    const dMix = Pool.diff({ items: [{ code: 'A' }] }, { items: [{ code: 'B' }] });
    assertTrue(dMix.added.length === 1 && dMix.removed.length === 1, 'D4 sleeve 错位也能算 diff');

    // 不一致 sleeve 不报错, 全当 added/removed
    const dNone = Pool.diff(null, null);
    assertTrue(dNone.added.length === 0 && dNone.kept.length === 0, 'D5 a=b=null → 全空');
  }

  console.log('\n[A3] 模块挂载 (2 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    const required = ['save', 'get', 'latest', 'list', 'diff', 'turnover', 'TABLE'];
    let allOk = true;
    for (const m of required) if (typeof Pool[m] === 'undefined') { allOk = false; bad('G1 缺方法: ' + m); }
    if (allOk) ok('G1 Pool 全方法暴露');
    assertEq(Pool.TABLE, 'pool_snapshots', 'G2 TABLE 字段正确');
  }

  console.log('\n[B1] 形态规范化 (4 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    await Pool.save({
      snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
      items: [
        { code: '600000', name: '浦发', strategy: 'st-x', ruleReason:'roe>10' },
        { code: '600001', name: '邯钢', strategy: 'st-x', ruleReason:'pb<2' }
      ]
    });
    const got = await Pool.get('2026-07-31', 'long');
    assertTrue(got !== null, 'B1.0 save 后 get 拿到');
    const it0 = got.items[0];
    assertEq(it0.rank, 1, 'B1.1 第一个 rank=1');
    assertEq(it0.score, 0, 'B1.2 score 默认 0');
    assertTrue(it0.dims && typeof it0.dims === 'object' && Object.keys(it0.dims).length === 0, 'B1.3 dims 默认 {}');
    assertEq(it0.delta, 'keep', 'B1.4 delta 默认 keep');
    assertTrue(Array.isArray(got.kbIds) && got.kbIds.length === 0, 'B1.5 kbIds 默认空数组');
    assertEq(got.promptDigest, '', 'B1.6 promptDigest 默认空串');
    assertEq(got.itemCount, 2, 'B1.7 itemCount 自动算 = 2');
    assertTrue(got.diff && got.diff.added.length === 2, 'B1.8 diff.added 兜底含 2 个 code');
    assertTrue(got.diff.removed.length === 0, 'B1.9 diff.removed 默认空');

    // 浏览器实测发现: Pool.save normItems 漏 price 字段 → Allocator 全部 MISSING_PRICE
    // 守护: 显式传 price 必须保留
    await Pool.save({
      snapId: '2026-08-03-long', date: '2026-08-03', sleeve: 'long',
      items: [
        { code: '600519', name: '贵州茅台', strategy: 'long-value-001', ruleReason: 'ROE>20', price: 1680, rank: 1 },
        { code: '000858', name: '五粮液', strategy: 'long-value-001', ruleReason: 'ROE>20', price: 145, rank: 2 }
      ]
    });
    const got2 = await Pool.get('2026-08-03', 'long');
    assertEq(got2.items[0].price, 1680, 'B1.10 Pool.save 保留 price 字段 (守护)');
    assertEq(got2.items[1].price, 145, 'B1.11 第二条 price 也保留');
    // 不传 price → 默认 0 (而非 undefined / NaN)
    await Pool.save({
      snapId: '2026-08-04-long', date: '2026-08-04', sleeve: 'long',
      items: [{ code: 'A', strategy: 'st-x', ruleReason: 'no price' }]
    });
    const got3 = await Pool.get('2026-08-04', 'long');
    assertEq(got3.items[0].price, 0, 'B1.12 不传 price → 默认 0');
  }

  console.log('\n[B2] latest/list 查询 (4 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    await Pool.save({ snapId: '2026-07-29-long', date: '2026-07-29', sleeve: 'long', items: [{ code: 'A', strategy: 'st-x', ruleReason:'x' }] });
    await Pool.save({ snapId: '2026-07-30-long', date: '2026-07-30', sleeve: 'long', items: [{ code: 'B', strategy: 'st-x', ruleReason:'y' }] });
    await Pool.save({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', items: [{ code: 'C', strategy: 'st-x', ruleReason:'z' }] });
    await Pool.save({ snapId: '2026-07-31-short', date: '2026-07-31', sleeve: 'short', items: [{ code: 'D', strategy: 'st-x', ruleReason:'s' }] });

    const today = await Pool.latest('long', new Date('2026-07-31'));
    assertTrue(today && today.snapId === '2026-07-31-long', 'B2.1 latest 当天命中');

    const back1 = await Pool.latest('long', new Date('2026-08-02'));
    assertTrue(back1 && back1.date === '2026-07-31', 'B2.2 latest 回退到最近一份');

    const far = await Pool.latest('long', new Date('2026-09-30'));
    assertEq(far, null, 'B2.3 latest 7 天外 → null');

    const list = await Pool.list('long', 10);
    assertEq(list.length, 3, 'B2.4 list 共 3 条 long');
    assertEq(list[0].date, '2026-07-31', 'B2.5 list[0] 是最近');
    assertEq(list[2].date, '2026-07-29', 'B2.6 list 末尾是最远');

    const short = await Pool.list('short', 10);
    assertEq(short.length, 1, 'B2.7 list sleeve=short 只 1 条');
  }

  console.log('\n[B3] 幂等性 (2 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    await Pool.save({
      snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
      items: [{ code: 'A', strategy: 'st-x', ruleReason:'r1' }, { code: 'B', strategy: 'st-x', ruleReason:'r2' }],
      ts: 100
    });
    await new Promise(r => setTimeout(r, 5));
    await Pool.save({
      snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long',
      items: [{ code: 'C', strategy: 'st-x', ruleReason:'r3' }],
      ts: 200
    });
    const got = await Pool.get('2026-07-31', 'long');
    assertEq(got.items.length, 1, 'B3.1 二次 save 覆盖 items');
    assertEq(got.items[0].code, 'C', 'B3.2 二次 save 后只剩 C');
    assertEq(got.itemCount, 1, 'B3.3 itemCount 也覆盖');
    assertEq(got.ts, 200, 'B3.4 ts 取最新的');
  }

  console.log('\n[B4] turnover (2 项)');
  {
    const sb = buildSandbox();
    const Pool = sb.Core.Steward.Pool;
    // 只有 1 条 → samples=1, avgTurnover=0
    await Pool.save({ snapId: '2026-07-30-long', date: '2026-07-30', sleeve: 'long', items: [{ code: 'A', strategy: 'st-x', ruleReason:'x' }] });
    let t = await Pool.turnover('long');
    assertEq(t.samples, 1, 'B4.1 <2 条 → samples=1');
    assertEq(t.avgTurnover, 0, 'B4.2 turnover=0');

    // 加一条, removed=0 → turnover=0
    await Pool.save({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', items: [{ code: 'A', strategy: 'st-x', ruleReason:'x' }] });
    t = await Pool.turnover('long');
    assertTrue(t.samples >= 1 && t.avgTurnover === 0, 'B4.3 全留 turnover=0');

    // 加第 3 条, 再加第 4 条(替换) → removed/total > 0
    await Pool.save({ snapId: '2026-08-01-long', date: '2026-08-01', sleeve: 'long',
      items: [{ code: 'A', strategy: 'st-x', ruleReason:'x' }, { code: 'B', strategy: 'st-x', ruleReason:'x' }] });
    await Pool.save({ snapId: '2026-08-02-long', date: '2026-08-02', sleeve: 'long',
      items: [{ code: 'C', strategy: 'st-x', ruleReason:'x' }, { code: 'B', strategy: 'st-x', ruleReason:'x' }] });
    t = await Pool.turnover('long');
    assertTrue(t.samples >= 2 && t.avgTurnover > 0, 'B4.4 有 removed 时 avgTurnover > 0');
  }

  // ===== 输出汇总 =====
  console.log('\n========');
  console.log(`S3 Steward-Pool 测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

runAsyncTests().catch(e => {
  console.error('顶层异常:', e);
  process.exit(1);
});
