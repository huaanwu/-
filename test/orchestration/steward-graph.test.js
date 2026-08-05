/**
 * V14 G5 — Steward.Graph (决策图谱数据模型) 单元测试 (20 项)
 *
 * 覆盖:
 *   [1] buildFromRun 8 组
 *       - 1a 空 traces (只有 run → plan + result)
 *       - 1b 单 plan (单 tool → 2 节点 1 calls 边)
 *       - 1c 多 tool (3 tools → 4 节点 produces 链)
 *       - 1d reflect 链接 (reflect→最近 plan/tool reflects_on 边)
 *       - 1e 错误 runId (getAgentRun 返 null → 空 traces → 仅 plan+result)
 *       - 1f 含 summary 节点 (不再补 result)
 *       - 1g kind=result 也算 result 节点
 *       - 1h 节点/边 id 唯一 + 含 runId meta
 *   [2] buildFromPlan 6 组
 *       - 2a 空 plan (planId 不存在 → 空数组)
 *       - 2b 单 input (决策头 + 1 input + consumes 边)
 *       - 2c 多 rule (violations + defaults → 唯一 rule 集)
 *       - 2d 节点计数 (decision + 4 inputs + N rules + M outputs)
 *       - 2e 边计数 (consumes/applies/produces 总数)
 *       - 2f 空 targets → (无 targets) output 节点
 *   [3] 模块挂载 4 组
 *       - 3a window.Core.Steward.Graph 全方法
 *       - 3b _nodeTypes 含 7 类 + 颜色
 *       - 3c _edgeTypes 含 5 类 + dashed 标记
 *       - 3d IIFE 二次加载不重复挂载
 *   [4] KB 污染守卫 2 组
 *       - 4a 图谱节点不含 KB 写路径 (serialize 后 grep KB 操作 → 0)
 *       - 4b override 不污染 KB 哈希 (本测试覆盖的所有 build* 调用)
 *
 * 跑法: node test/orchestration/steward-graph.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const GRAPH_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'graph.js'), 'utf8');
const KB_PATH = path.join(ROOT, 'www', 'kb_data', 'investment_kb.json');
const KB_HASH_BEFORE = _sha256File(KB_PATH);

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }

function _sha256File(p) {
  if (!fs.existsSync(p)) return 'FILE_NOT_EXISTS';
  const buf = fs.readFileSync(p);
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 内存 fake Dexie — 支持 add/put/get/where().equals().toArray() */
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
      bulkAdd: async (arr) => {
        for (const row of arr) {
          if (row.id == null) row.id = autoId++;
          rows.set(row.id, row);
        }
        return arr.length;
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

  const allTables = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons',
    'watchlist','holdings','transactions','journals','alerts','funds','cashflow',
    'cache','kv','settings_snapshots','ai_call_log','agent_runs','ai_traces',
    'research_pool','decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  const pkMap = {
    pool_snapshots: 'snapId', steward_plans: 'planId', rule_candidates: 'candId',
    steward_lessons: 'id', weekly_attribution: 'weekId', research_pool: 'code',
    agent_runs: 'runId'
  };

  const fakeDb = makeFakeDb(allTables, pkMap);
  sb.Dexie = function (name) {
    const inst = { name, version: () => ({ stores: () => ({}) }) };
    Object.assign(inst, fakeDb);
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};

  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb);
  vm.runInContext(GRAPH_SRC, sb);
  sb.Core.Storage.init();
  return sb;
}

// =====================================================================
async function runAsyncTests() {
  // ===== [1] buildFromRun 8 组 =====
  console.log('\n[1] buildFromRun (8 组)');

  // 1a: 空 traces — 只有 run → plan + result 节点
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-empty';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'test-empty', strategy: 'long', startedAt: 1000, ok: true });
    const g = await G.buildFromRun(runId);
    const types = g.nodes.map(n => n.type);
    assertTrue(types.includes('plan') && types.includes('result'),
      `1a1 空 traces 含 plan + result (${types.join(',')})`);
    assertEq(g.nodes.length, 2, `1a2 共 2 节点 (${g.nodes.length})`);
    assertEq(g.edges.length, 1, `1a3 共 1 边 (${g.edges.length})`);
  }

  // 1b: 单 plan + 单 tool → 2 节点 + 1 calls 边
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-single';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'long-pick', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 'getStockSpot', detail: {} }
    ]);
    const g = await G.buildFromRun(runId);
    const toolNodes = g.nodes.filter(n => n.type === 'tool');
    assertEq(toolNodes.length, 1, `1b1 单 tool 节点 (${toolNodes.length})`);
    const calls = g.edges.filter(e => e.kind === 'calls');
    assertTrue(calls.length >= 1, `1b2 含 calls 边 (${calls.length})`);
  }

  // 1c: 多 tool — 3 tools → produces 链
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-multi';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'multi', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 't1' },
      { runId, kind: 'tool', at: 1200, ts: 1200, summary: 't2' },
      { runId, kind: 'tool', at: 1300, ts: 1300, summary: 't3' }
    ]);
    const g = await G.buildFromRun(runId);
    const toolNodes = g.nodes.filter(n => n.type === 'tool');
    assertEq(toolNodes.length, 3, `1c1 三 tool 节点 (${toolNodes.length})`);
    const produces = g.edges.filter(e => e.kind === 'produces');
    assertTrue(produces.length >= 2, `1c2 produces 链 ≥2 边 (${produces.length})`);
  }

  // 1d: reflect 节点 → reflects_on 边回最近 plan/tool
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-reflect';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'reflect-test', strategy: 'short', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 'look' },
      { runId, kind: 'reflect', at: 1200, ts: 1200, summary: 'not enough', detail: {} }
    ]);
    const g = await G.buildFromRun(runId);
    const reflectNodes = g.nodes.filter(n => n.type === 'reflect');
    assertEq(reflectNodes.length, 1, `1d1 reflect 节点 (${reflectNodes.length})`);
    const refl = g.edges.filter(e => e.kind === 'reflects_on');
    assertEq(refl.length, 1, `1d2 reflects_on 边 (${refl.length})`);
    if (refl.length > 0) {
      assertEq(refl[0].source.startsWith('reflect:'), true, '1d3 reflects_on 源=reflect');
    }
  }

  // 1e: 错误 runId (run 不存在) → 优雅降级, 仍产 plan + result
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const g = await G.buildFromRun('run-not-exists');
    const planNodes = g.nodes.filter(n => n.type === 'plan');
    assertEq(planNodes.length, 1, `1e1 错误 runId 仍产 1 plan 节点 (${planNodes.length})`);
    assertTrue(planNodes[0].label === 'run-not-exists',
      `1e2 plan label 退化为 runId (${planNodes[0].label})`);
  }

  // 1f: 含 summary 节点 → 不补 result
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-summary';
    await sb.Core.Storage.addAgentRun({ runId, intent: 's', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 't' },
      { runId, kind: 'summary', at: 1200, ts: 1200, summary: 'all done' }
    ]);
    const g = await G.buildFromRun(runId);
    const resultNodes = g.nodes.filter(n => n.type === 'result');
    assertEq(resultNodes.length, 1, `1f1 summary 计入 result (${resultNodes.length})`);
    assertTrue(g.nodes.length === 3, `1f2 不重复补 result (${g.nodes.length})`);
  }

  // 1g: kind=result 与 kind=summary 一样
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-result-kind';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'r', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'result', at: 1100, ts: 1100, summary: 'done' }
    ]);
    const g = await G.buildFromRun(runId);
    const resultNodes = g.nodes.filter(n => n.type === 'result');
    assertTrue(resultNodes.length === 1, `1g1 kind=result 计入 (${resultNodes.length})`);
  }

  // 1h: 节点/边 id 唯一 + 含 runId meta
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-unique';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'u', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 'a' },
      { runId, kind: 'tool', at: 1200, ts: 1200, summary: 'b' }
    ]);
    const g = await G.buildFromRun(runId);
    const ids = g.nodes.map(n => n.id);
    const uniq = new Set(ids);
    assertEq(uniq.size, ids.length, `1h1 节点 id 唯一 (${ids.length})`);
    const allHaveRunId = g.nodes.every(n => n.meta && n.meta.runId === runId);
    assertTrue(allHaveRunId, '1h2 所有节点 meta.runId 正确');
  }

  // ===== [2] buildFromPlan 6 组 =====
  console.log('\n[2] buildFromPlan (6 组)');

  // 2a: 空 plan (planId 不存在) → 空数组
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const g = await G.buildFromPlan('plan-missing');
    assertEq(g.nodes.length, 0, `2a1 不存在 plan → 0 节点 (${g.nodes.length})`);
    assertEq(g.edges.length, 0, `2a2 不存在 plan → 0 边 (${g.edges.length})`);
  }

  // 2b: 单 input (决策头 + 4 inputs 默认)
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const planId = 'plan-b';
    await sb.Core.Storage.saveStewardPlan({
      planId, date: '2026-07-30', status: 'pending', regime: 'bull', factor: 1.2, sleeve: 'long',
      violations: [], targets: []
    });
    const g = await G.buildFromPlan(planId);
    const decisionNodes = g.nodes.filter(n => n.type === 'decision');
    assertEq(decisionNodes.length, 1, `2b1 decision 节点 (${decisionNodes.length})`);
    const inputs = g.nodes.filter(n => n.type === 'input');
    assertEq(inputs.length, 4, `2b2 4 input 节点 (${inputs.length})`);
    const consumes = g.edges.filter(e => e.kind === 'consumes');
    assertEq(consumes.length, 4, `2b3 4 consumes 边 (${consumes.length})`);
  }

  // 2c: 多 rule — violations + defaults 去重
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const planId = 'plan-c';
    await sb.Core.Storage.saveStewardPlan({
      planId, date: '2026-07-30', status: 'pending',
      violations: [
        { rule: 'CUSTOM_RULE_1' },
        { rule: 'LOT_SIZE' }, // 与 default 重, 应被 set 去重
        { rule: 'CUSTOM_RULE_2' }
      ],
      targets: []
    });
    const g = await G.buildFromPlan(planId);
    const rules = g.nodes.filter(n => n.type === 'rule');
    // 4 defaults + 2 custom = 6 unique
    assertEq(rules.length, 6, `2c1 rules 去重 = 6 (${rules.length})`);
    const applies = g.edges.filter(e => e.kind === 'applies');
    assertEq(applies.length, 6, `2c2 6 applies 边 (${applies.length})`);
  }

  // 2d: 节点计数 — decision + 4 inputs + N rules + M outputs
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const planId = 'plan-d';
    await sb.Core.Storage.saveStewardPlan({
      planId, date: '2026-07-30', status: 'approved',
      violations: [{ rule: 'X' }, { rule: 'Y' }],
      targets: [
        { code: '600519', action: 'buy', sleeve: 'long', shares: 100 },
        { code: '000001', action: 'sell', sleeve: 'long', shares: 200 }
      ]
    });
    const g = await G.buildFromPlan(planId);
    // decision(1) + inputs(4) + rules(4defaults+2custom=6) + outputs(2) = 13
    assertEq(g.nodes.length, 13, `2d1 节点总数 (${g.nodes.length})`);
  }

  // 2e: 边计数 — consumes(4) + applies(rules) + produces(outputs)
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const planId = 'plan-e';
    await sb.Core.Storage.saveStewardPlan({
      planId, date: '2026-07-30', status: 'approved',
      violations: [],
      targets: [
        { code: '600519', action: 'buy', sleeve: 'long' }
      ]
    });
    const g = await G.buildFromPlan(planId);
    // consumes(4) + applies(4) + produces(1) = 9
    assertEq(g.edges.length, 9, `2e1 边总数 (${g.edges.length})`);
    const consumes = g.edges.filter(e => e.kind === 'consumes').length;
    const applies = g.edges.filter(e => e.kind === 'applies').length;
    const produces = g.edges.filter(e => e.kind === 'produces').length;
    assertEq(consumes, 4, `2e2 consumes (${consumes})`);
    assertEq(applies, 4, `2e3 applies (${applies})`);
    assertEq(produces, 1, `2e4 produces (${produces})`);
  }

  // 2f: 空 targets → (无 targets) output 节点
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const planId = 'plan-f';
    await sb.Core.Storage.saveStewardPlan({
      planId, date: '2026-07-30', status: 'approved',
      violations: [], targets: []
    });
    const g = await G.buildFromPlan(planId);
    const emptyOut = g.nodes.find(n => n.type === 'output' && n.label === '(无 targets)');
    assertTrue(!!emptyOut, '2f1 含 (无 targets) output 节点');
    const produces = g.edges.filter(e => e.kind === 'produces' && e.target.includes(':empty'));
    assertEq(produces.length, 1, `2f2 produces→empty 边 (${produces.length})`);
  }

  // ===== [3] 模块挂载 4 组 =====
  console.log('\n[3] 模块挂载 (4 组)');

  // 3a: window.Core.Steward.Graph 全方法
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const required = ['buildFromRun', 'buildFromPlan'];
    let allOk = true;
    for (const m of required) if (typeof G[m] === 'undefined') { allOk = false; bad('3a 缺方法: ' + m); }
    if (allOk) ok('3a 全方法暴露');
    assertTrue(typeof G.buildFromRun === 'function', '3a1 buildFromRun is function');
    assertTrue(typeof G.buildFromPlan === 'function', '3a2 buildFromPlan is function');
  }

  // 3b: _nodeTypes 含 7 类 + 颜色
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const expected = ['plan', 'tool', 'reflect', 'result', 'decision', 'input', 'rule', 'output'];
    let allOk = true;
    for (const t of expected) {
      if (!G._nodeTypes[t]) { allOk = false; bad('3b 缺节点类型: ' + t); }
      else if (!G._nodeTypes[t].color) { allOk = false; bad('3b 节点类型无颜色: ' + t); }
    }
    if (allOk) ok(`3b _nodeTypes 含 ${expected.length} 类 + 颜色`);
  }

  // 3c: _edgeTypes 含 5 类 + dashed 标记
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const expected = ['calls', 'reflects_on', 'produces', 'consumes', 'applies'];
    let allOk = true;
    for (const t of expected) {
      if (!G._edgeTypes[t]) { allOk = false; bad('3c 缺边类型: ' + t); }
    }
    if (allOk) ok(`3c _edgeTypes 含 ${expected.length} 类`);
    assertEq(G._edgeTypes.reflects_on.dashed, true, '3c1 reflects_on 含 dashed 标记');
  }

  // 3d: IIFE 二次加载 — 不抛错 + 模块仍完整
  {
    const sb = buildSandbox();
    const G1 = sb.Core.Steward.Graph;
    let threw = false;
    try { vm.runInContext(GRAPH_SRC, sb); } catch (e) { threw = true; bad('3d 二次加载抛错: ' + e.message); }
    assertTrue(!threw, '3d1 IIFE 二次加载不抛错');
    const G2 = sb.Core.Steward.Graph;
    assertTrue(typeof G2.buildFromRun === 'function', '3d2 二次加载 buildFromRun 仍可用');
    assertTrue(typeof G2.buildFromPlan === 'function', '3d3 二次加载 buildFromPlan 仍可用');
    assertTrue(typeof G2._nodeTypes === 'object' && G2._nodeTypes.plan !== undefined,
      '3d4 二次加载 _nodeTypes 仍完整');
  }

  // ===== [4] KB 污染守卫 2 组 =====
  console.log('\n[4] KB 污染守卫 (2 组)');

  // 4a: 图谱节点不含 KB 写路径
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    const runId = 'run-pollute';
    await sb.Core.Storage.addAgentRun({ runId, intent: 'p', strategy: 'long', startedAt: 1000, ok: true });
    await sb.Core.Storage.addAITraces([
      { runId, kind: 'tool', at: 1100, ts: 1100, summary: 't' },
      { runId, kind: 'reflect', at: 1200, ts: 1200, summary: 'r' }
    ]);
    await G.buildFromRun(runId);
    await sb.Core.Storage.saveStewardPlan({
      planId: 'p1', date: '2026-07-30', status: 'pending', violations: [], targets: [{ code: 'X', sleeve: 'long' }]
    });
    await G.buildFromPlan('p1');
    const serialized = JSON.stringify({ _nodeTypes: G._nodeTypes, _edgeTypes: G._edgeTypes });
    // 查找 KB 写操作关键字 (kb_put / writeKb / updateKb / fs.writeFile)
    const writeKeywords = /kb\.put|writeKb|updateKb|fs\.writeFile|writeFileSync|kb_set/i;
    assertTrue(!writeKeywords.test(serialized), '4a1 graph 元数据无 KB 写路径关键字');
    // 进一步: graph.js 源码本身不应含 KB 写
    assertTrue(!writeKeywords.test(GRAPH_SRC), '4a2 graph.js 源码无 KB 写路径');
  }

  // 4b: 跑全套 build* 后 KB 哈希不变 (override 不污染 KB)
  {
    const sb = buildSandbox();
    const G = sb.Core.Steward.Graph;
    // 跑 5 次 buildFromRun + 5 次 buildFromPlan
    for (let i = 0; i < 5; i++) {
      const rid = 'run-' + i;
      await sb.Core.Storage.addAgentRun({ runId: rid, intent: 'x', strategy: 'long', startedAt: 1000 + i, ok: true });
      await sb.Core.Storage.addAITraces([
        { runId: rid, kind: 'tool', at: 1100 + i, ts: 1100 + i, summary: 't' }
      ]);
      await G.buildFromRun(rid);
      const pid = 'plan-' + i;
      await sb.Core.Storage.saveStewardPlan({
        planId: pid, date: '2026-07-30', status: 'pending',
        violations: [{ rule: 'R' + i }], targets: [{ code: 'X' + i, sleeve: 'long' }]
      });
      await G.buildFromPlan(pid);
    }
    assertEq(_sha256File(KB_PATH), KB_HASH_BEFORE, '4b1 跑 5×buildFromRun + 5×buildFromPlan 后 KB 哈希不变');
  }

  // ===== 输出汇总 =====
  console.log('\n========');
  console.log(`V14 G5 Steward-Graph 测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

runAsyncTests().catch(e => {
  console.error('顶层异常:', e);
  process.exit(1);
});
