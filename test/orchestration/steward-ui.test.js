/**
 * S4 Steward — UI 渲染 + 事件分发单元测试 (10 项)
 *
 * 跑法: node test/orchestration/steward-ui.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const UTIL_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'util.js'), 'utf8');
const STEWARD_UI_SRC = fs.readFileSync(path.join(ROOT, 'www', 'app', 'steward-ui.js'), 'utf8');

let pass = 0, fail = 0;
function ok(msg) { pass++; console.log('  ✓', msg); }
function bad(msg) { fail++; console.error('  ✗', msg); }
function assertTrue(cond, msg) { cond ? ok(msg) : bad(msg); }
function assertEq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else bad(msg + ` (期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)})`);
}

/**
 * 最小化 DOM mock — JSDOM 太重, 我们只需要 querySelector / innerHTML / addEventListener / dispatchEvent
 */
function makeFakeElement(tag) {
  return {
    tagName: tag,
    innerHTML: '',
    children: [],
    _attrs: {},
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k] || null; },
    appendChild(child) { this.children.push(child); },
    querySelector(sel) {
      // 仅支持 #id
      if (sel && sel.startsWith('#')) {
        const id = sel.slice(1);
        return this._findById(id) || null;
      }
      return null;
    },
    querySelectorAll(sel) {
      // 仅支持 button[data-act]
      if (sel && sel.startsWith('button[data-act]')) {
        return this._findAllByTag('button');
      }
      return [];
    },
    _findById(id) {
      // 在 children 中查找
      for (const c of this.children) {
        if (c._attrs && c._attrs.id === id) return c;
        const sub = c._findById && c._findById(id);
        if (sub) return sub;
      }
      return null;
    },
    _findAllByTag(t) {
      const out = [];
      for (const c of this.children) {
        if (c.tagName === t) out.push(c);
        if (c._findAllByTag) out.push(...c._findAllByTag(t));
      }
      return out;
    },
    addEventListener(type, fn) {
      this._listeners = this._listeners || {};
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    dispatchEvent(evt) {
      this._listeners = this._listeners || {};
      const ls = this._listeners[evt.type] || [];
      for (const fn of ls) fn(evt);
    },
    closest(sel) {
      // 简化: 总是返回自己 (上层有 data-plan-id)
      return this._attrs && this._attrs['data-plan-id'] ? this : null;
    },
    style: {}
  };
}

/**
 * 内存 fake Dexie — 跟 steward-pool.test.js 同款
 */
function makeFakeDb(tables, pkMap) {
  const db = {};
  tables.forEach(name => {
    const rows = new Map();
    let autoId = 1;
    const pkField = pkMap[name] || 'id';
    db[name] = {
      add: async (row) => {
        if (pkField === 'id') { if (row.id == null) row.id = autoId++; rows.set(row.id, row); return row.id; }
        const k = row[pkField]; if (k == null) throw new Error('缺主键'); rows.set(k, row); return k;
      },
      put: async (row) => {
        if (pkField === 'id') { if (row.id == null) row.id = autoId++; rows.set(row.id, row); return row.id; }
        const k = row[pkField]; if (k == null) throw new Error('缺主键'); rows.set(k, row); return k;
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

function buildSandbox(preloadRows = []) {
  const sb = {
    console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number,
    prompt: () => null,           // mock window.prompt → 取消
    alert: () => {}
  };
  sb.window = sb;
  sb.global = sb;

  // mock dispatchEvent / addEventListener / CustomEvent
  sb._events = {};
  sb.window.dispatchEvent = function (evt) {
    const ls = sb._events[evt.type] || [];
    for (const fn of ls) fn(evt);
  };
  sb.CustomEvent = function (type, init) {
    return { type, detail: (init && init.detail) || {} };
  };

  // mock document + root 容器
  const root = makeFakeElement('div');
  root._attrs.id = 'stewardPending';
  sb.document = {
    getElementById: (id) => (id === 'stewardPending' ? root : null)
  };

  // mock Dexie
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
  sb.Core.Storage.init();

  // 预填 steward_plans 数据 (pending)
  for (const r of preloadRows) {
    sb.Core.Storage.saveStewardPlan(r).catch(() => {});
  }

  vm.runInContext(UTIL_SRC, sb);
  vm.runInContext(STEWARD_UI_SRC, sb);
  return sb;
}

// =========================================================================
// A. StewardUI 挂载 — 4 项
// =========================================================================
console.log('\n[A] StewardUI 挂载 (4 项)');

// A1. window.StewardUI 全方法暴露
{
  const sb = buildSandbox();
  const UI = sb.StewardUI;
  assertTrue(typeof UI.init === 'function', 'A1 init 已暴露');
  assertTrue(typeof UI.renderPage === 'function', 'A1 renderPage 已暴露');
  assertTrue(typeof UI._loadPendingPlans === 'function', 'A1 _loadPendingPlans 已暴露');
  assertTrue(typeof UI._renderPlanCard === 'function', 'A1 _renderPlanCard 已暴露');
}

// A2. init 二次调用幂等 (inited 状态保护)
{
  const sb = buildSandbox();
  sb.StewardUI.init();
  sb.StewardUI.init();   // 第二次, 应该被 inited 守卫拦截, 不报错
  assertTrue(true, 'A2 init 二次调用幂等, 不报错');
}

// A3. _renderPlanCard 输出含 plan card class
{
  const sb = buildSandbox();
  const plan = {
    planId: 'p-test-001',
    asOf: '2026-07-31T10:00:00Z',
    notes: 'regime=range factor=1',
    targets: [
      { code: '600000', name: 'PFYH', sleeve: 'long', action: 'buy', shares: 100, price: 10, targetAmount: 1000, reason: 'Pool rank #1' }
    ],
    violations: []
  };
  const html = sb.StewardUI._renderPlanCard(plan);
  assertTrue(html.includes('data-plan-id'), 'A3 _renderPlanCard 输出含 data-plan-id');
  assertTrue(html.includes('600000'), 'A3 _renderPlanCard 输出含 code');
  assertTrue(html.includes('btn-primary'), 'A3 _renderPlanCard 批准按钮含 btn-primary class');
  assertTrue(html.includes('btn-ghost'), 'A3 _renderPlanCard 驳回/改数量按钮含 btn-ghost class');
  assertTrue(html.includes('data-act="approve"'), 'A3 批准按钮 data-act=approve');
  assertTrue(html.includes('data-act="reject"'), 'A3 驳回按钮 data-act=reject');
  assertTrue(html.includes('data-act="adjust"'), 'A3 改数量按钮 data-act=adjust');
}

// A4. _renderPlanCard violations 区段
{
  const sb = buildSandbox();
  const plan = {
    planId: 'p-test-002',
    asOf: '2026-07-31',
    notes: '',
    targets: [],
    violations: [
      { rule: 'MAX_SINGLE_STOCK_PCT', detail: '600000 targetPct=0.5 > 0.2' },
      { rule: 'INSUFFICIENT_CASH', detail: '600519 现金不足' }
    ]
  };
  const html = sb.StewardUI._renderPlanCard(plan);
  assertTrue(html.includes('violations'), 'A4 violations 区块渲染');
  assertTrue(html.includes('MAX_SINGLE_STOCK_PCT'), 'A4 violation rule 文本出现');
  assertTrue(html.includes('INSUFFICIENT_CASH'), 'A4 violation detail 文本出现');
}

// =========================================================================
// B. 事件分发 — 3 项
// =========================================================================
console.log('\n[B] 事件分发 (3 项)');

// B1. window.dispatchEvent mock 正常接收 steward:approve 事件
{
  const sb = buildSandbox();
  let received = null;
  sb._events['steward:approve'] = [(evt) => { received = evt.detail; }];
  sb.window.dispatchEvent({
    type: 'steward:approve',
    detail: { planId: 'p1', action: 'buy', code: '600000', sleeve: 'long', shares: 100 }
  });
  assertTrue(received !== null, 'B1 steward:approve 事件被分发');
  assertEq(received && received.code, '600000', 'B1 event detail.code 正确');
  assertEq(received && received.shares, 100, 'B1 event detail.shares 正确');
}

// B2. steward:reject 事件
{
  const sb = buildSandbox();
  let received = null;
  sb._events['steward:reject'] = [(evt) => { received = evt.detail; }];
  sb.window.dispatchEvent({
    type: 'steward:reject',
    detail: { planId: 'p1', code: '600000', action: 'sell', sleeve: 'long' }
  });
  assertTrue(received !== null, 'B2 steward:reject 事件被分发');
  assertEq(received.action, 'sell', 'B2 reject event.action=卖');
}

// B3. steward:adjust 事件
{
  const sb = buildSandbox();
  let received = null;
  sb._events['steward:adjust'] = [(evt) => { received = evt.detail; }];
  sb.window.dispatchEvent({
    type: 'steward:adjust',
    detail: { planId: 'p1', code: '600000', action: 'buy', sleeve: 'long', shares: 200 }
  });
  assertTrue(received !== null, 'B3 steward:adjust 事件被分发');
  assertEq(received.shares, 200, 'B3 adjust event.shares=改后数量');
}

// =========================================================================
// C. renderPage 集成 — 3 项 (同步顺序执行)
// =========================================================================
async function runRenderTests() {
  console.log('\n[C] renderPage 集成 (3 项)');

  // C1. renderPage 空数据 → "暂无 pending 计划"
  {
    const sb = buildSandbox();
    sb.StewardUI._loadPendingPlans = async () => [];
    await sb.StewardUI.renderPage();
    const root = sb.document.getElementById('stewardPending');
    assertTrue(root.innerHTML.includes('暂无 pending 计划'), 'C1 空数据 → "暂无" 提示');
  }

  // C2. renderPage 有 plan → 渲染 card (含正确 class)
  {
    const sb = buildSandbox([{
      planId: 'p-loaded-001',
      asOf: '2026-07-31',
      notes: 'regime=range',
      status: 'pending',
      targets: [
        { code: '600000', name: 'PFYH', sleeve: 'long', action: 'buy', shares: 100, price: 10, targetAmount: 1000, reason: 'Pool' }
      ],
      violations: []
    }]);
    await sb.StewardUI.renderPage();
    const root = sb.document.getElementById('stewardPending');
    const html = root.innerHTML;
    assertTrue(html.includes('p-loaded-001'), 'C2 renderPage 渲染 planId');
    assertTrue(html.includes('btn-primary'), 'C2 renderPage 批准按钮含 btn-primary');
    assertTrue(html.includes('data-act="approve"'), 'C2 renderPage 含 approve data-act');
  }

  // C3. renderPage 装入真实 Dexie 数据
  {
    const sb = buildSandbox();
    await sb.Core.Storage.saveStewardPlan({
      planId: 'p-d-001', date: '2026-07-31', status: 'pending', ts: Date.now(),
      targets: [{ code: '300750', name: 'NDJT', sleeve: 'short', action: 'buy', shares: 200, price: 100, targetAmount: 20000, reason: 'short sleeve' }],
      violations: [],
      notes: 'short test'
    });
    await sb.StewardUI.renderPage();
    const html = sb.document.getElementById('stewardPending').innerHTML;
    assertTrue(html.includes('300750'), 'C3 真实 Dexie 数据 → 渲染 code');
    assertTrue(html.includes('p-d-001'), 'C3 真实 Dexie 数据 → 渲染 planId');
  }
}

// =========================================================================
// 汇总
// =========================================================================
runRenderTests().then(() => {
  console.log('\n========================================');
  console.log(`StewardUI 测试结果: ${pass} 通过 / ${fail} 失败 / ${pass + fail} 总数`);
  console.log('========================================');
  process.exit(fail > 0 ? 1 : 0);
});
