/**
 * S5 — Steward.Lessons (学习闭环 + 规则候选) 单元测试 (22 项)
 *
 * 覆盖:
 *   1. recordLesson 阈值(2 次不出候选, 3 次出) [2 项]
 *   2. distill 6 组: 空 / 单条 / <3 / ≥3 不显著 / ≥3 显著正 / ≥3 显著负
 *   3. applyCandidate 4 组: accepted / rejected / 错 decision / 缺 candId
 *   4. listCandidates 2 组: pending 过滤 / 全量
 *   5. KB 污染守卫 4 组: investment_kb.json 哈希 4 次操作前后不变
 *   6. listLessons 2 组: 按 code 过滤 / limit
 *   7. 模块挂载 2 组: 6 方法 + 2 常量
 *
 * 跑法: node test/orchestration/steward-lessons.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const STORAGE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'storage.js'), 'utf8');
const LESSONS_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'steward', 'lessons.js'), 'utf8');
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
function assertThrows(fn, regex, msg) {
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

function _sha256File(p) {
  if (!fs.existsSync(p)) return 'FILE_NOT_EXISTS';
  const buf = fs.readFileSync(p);
  const crypto = require('crypto');
  return crypto.createHash('sha256').update(buf).digest('hex');
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
    steward_lessons: 'id', weekly_attribution: 'weekId', research_pool: 'code'
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
  vm.runInContext(LESSONS_SRC, sb);

  // 注入 storage.js 没暴露但 lessons.js 要用的 helpers
  sb.Core.Storage.listRuleCandidates = async (status, limit) => {
    let rows = await fakeDb.rule_candidates.toArray();
    if (status) rows = rows.filter(r => r.status === status);
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return limit > 0 ? rows.slice(0, limit) : rows;
  };
  sb.Core.Storage.decideRuleCandidate = async (candId, decision, opts) => {
    const cand = await fakeDb.rule_candidates.get(candId);
    if (!cand) throw new Error('decideRuleCandidate: 找不到 ' + candId);
    if (decision !== 'accepted' && decision !== 'rejected') throw new Error('decision 必须 accepted/rejected');
    cand.status = decision;
    cand.decidedAt = Date.now();
    cand.decidedBy = (opts && opts.approvedBy) || 'user';
    cand.decidedNote = (opts && opts.note) || '';
    await fakeDb.rule_candidates.put(cand);
    return cand;
  };
  sb.Core.Storage.addRuleCandidate = async (cand) => {
    cand.ts = cand.ts || Date.now();
    cand.status = cand.status || 'pending';
    return await fakeDb.rule_candidates.put(cand);
  };
  sb.Core.Storage.listStewardLessons = async (filter) => {
    let rows = await fakeDb.steward_lessons.toArray();
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (filter && filter.code) rows = rows.filter(r => r.code === filter.code);
    if (filter && filter.sleeve) rows = rows.filter(r => r.sleeve === filter.sleeve);
    if (filter && filter.pattern) rows = rows.filter(r => r.pattern === filter.pattern);
    if (filter && filter.limit) rows = rows.slice(0, filter.limit);
    return rows;
  };

  sb.Core.Storage.init();
  return sb;
}

// =====================================================================
async function runAsyncTests() {
  // ===== [1] recordLesson 阈值 (2 项) =====
  console.log('\n[1] recordLesson 阈值');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;

    // 1a: 第 1-2 次不出候选
    const r1 = await L.recordLesson({
      decision: { code: '600519', sleeve: 'short', pattern: 'breakout' },
      outcome: { pnl: 0.05, winRate: 1.0 }
    });
    assertTrue(typeof r1.lessonId === 'number' && r1.lessonId > 0, '1a1 第 1 次写 lessonId');
    assertEq(r1.candidateId, null, '1a2 第 1 次不生成候选');

    const r2 = await L.recordLesson({
      decision: { code: '600519', sleeve: 'short', pattern: 'breakout' },
      outcome: { pnl: 0.03, winRate: 1.0 }
    });
    assertEq(r2.candidateId, null, '1a3 第 2 次仍不生成候选 (2 < 3)');

    // 1b: 第 3 次且胜率偏差 ≥15pp → 生成候选
    const r3 = await L.recordLesson({
      decision: { code: '600519', sleeve: 'short', pattern: 'breakout' },
      outcome: { pnl: 0.08, winRate: 1.0 }
    });
    assertTrue(typeof r3.candidateId === 'string' && r3.candidateId.length > 0,
      `1b1 第 3 次生成候选 (${r3.candidateId})`);
    // 第 4 次同 source 已有 pending, 应复用
    const r4 = await L.recordLesson({
      decision: { code: '600519', sleeve: 'short', pattern: 'breakout' },
      outcome: { pnl: 0.10, winRate: 1.0 }
    });
    assertEq(r4.candidateId, r3.candidateId, '1b2 第 4 次幂等复用同候选');
  }

  // ===== [2] distill 6 组 =====
  console.log('\n[2] distill 纯函数');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;

    // 2a: 空
    assertEq(L.distill([]).length, 0, '2a1 空数组返 []');
    assertEq(L.distill(null).length, 0, '2a2 null 返 []');

    // 2b: 单条
    const single = L.distill([{ code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 }]);
    assertEq(single.length, 0, '2b1 单条不出候选 (1 < 3)');

    // 2c: 3 条但胜率 50% → 偏差 0 < 15pp → 不出
    const flat = [
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.05 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: -0.05 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.05 }
    ];
    // wr = 2/3 = 0.667, deviation = 0.167 ≥ 0.15 → 出
    const flatOut = L.distill(flat);
    assertTrue(flatOut.length === 1, `2c1 wr=2/3 (dev=0.167) 出 1 候选 (${flatOut.length})`);

    // 2d: 3 条全正 wr=1.0 dev=0.5 → 出 (reinforce)
    const allWin = L.distill([
      { code: 'B', sleeve: 'long', pattern: 'value', pnl: 0.10 },
      { code: 'B', sleeve: 'long', pattern: 'value', pnl: 0.08 },
      { code: 'B', sleeve: 'long', pattern: 'value', pnl: 0.12 }
    ]);
    assertTrue(allWin.length === 1 && allWin[0].direction === 'reinforce',
      `2d1 3 全正 → reinforce (${allWin[0] && allWin[0].direction})`);

    // 2e: 3 条全负 wr=0 → 出 (caution)
    const allLose = L.distill([
      { code: 'C', sleeve: 'short', pattern: 'momentum', pnl: -0.10 },
      { code: 'C', sleeve: 'short', pattern: 'momentum', pnl: -0.08 },
      { code: 'C', sleeve: 'short', pattern: 'momentum', pnl: -0.12 }
    ]);
    assertTrue(allLose.length === 1 && allLose[0].direction === 'caution',
      `2e1 3 全负 → caution (${allLose[0] && allLose[0].direction})`);

    // 2f: 3 条但 sleeve 不同 → 不合并
    const mixed = L.distill([
      { code: 'D', sleeve: 'short', pattern: 'x', pnl: 0.1 },
      { code: 'D', sleeve: 'short', pattern: 'x', pnl: 0.1 },
      { code: 'D', sleeve: 'long', pattern: 'x', pnl: 0.1 }
    ]);
    assertEq(mixed.length, 0, '2f1 不同 sleeve 分组不合并');

    // 2g: 多组 — A 全正 + B wr=2/3(0.667) 偏差 0.167 ≥ 0.15, 两个都出
    const multi = L.distill([
      // A/short/p 全正 → reinforce
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 },
      // B/short/q wr=2/3 dev=0.167 ≥ 0.15 → reinforce
      { code: 'B', sleeve: 'short', pattern: 'q', pnl: 0.05 },
      { code: 'B', sleeve: 'short', pattern: 'q', pnl: -0.05 },
      { code: 'B', sleeve: 'short', pattern: 'q', pnl: 0.05 }
    ]);
    assertEq(multi.length, 2, `2g1 A 和 B 都出候选 (${multi.length})`);

    // 2h: 多组 — 全平局 (wr 接近 0.5) 不出
    const allFlat = L.distill([
      { code: 'X', sleeve: 'short', pattern: 'p', pnl: 0.01 },
      { code: 'X', sleeve: 'short', pattern: 'p', pnl: -0.01 },
      { code: 'X', sleeve: 'short', pattern: 'p', pnl: 0.01 },
      { code: 'X', sleeve: 'short', pattern: 'p', pnl: -0.01 },
      { code: 'X', sleeve: 'short', pattern: 'p', pnl: 0.01 }
    ]);
    assertEq(allFlat.length, 0, `2h1 wr=3/5(0.6) dev=0.1 < 0.15 不出 (${allFlat.length})`);
  }

  // ===== [3] applyCandidate 4 组 =====
  console.log('\n[3] applyCandidate');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;
    // 先造一个候选
    await L.recordLesson({
      decision: { code: 'X', sleeve: 'short', pattern: 'p' },
      outcome: { pnl: 0.10, winRate: 1.0 }
    });
    await L.recordLesson({
      decision: { code: 'X', sleeve: 'short', pattern: 'p' },
      outcome: { pnl: 0.10, winRate: 1.0 }
    });
    await L.recordLesson({
      decision: { code: 'X', sleeve: 'short', pattern: 'p' },
      outcome: { pnl: 0.10, winRate: 1.0 }
    });
    const cands = await L.listCandidates({ status: 'pending' });
    const candId = cands[0].candId;

    // 3a: accepted
    const accepted = await L.applyCandidate(candId, 'accepted', { approvedBy: 'tester', note: 'lgtm' });
    assertEq(accepted.status, 'accepted', '3a1 改 status=accepted');
    assertEq(accepted.decidedBy, 'tester', '3a2 decidedBy 写入');
    assertEq(accepted.decidedNote, 'lgtm', '3a3 decidedNote 写入');

    // 3b: 改 rejected 接受后还能再 rejected (state machine, 双向允许)
    const rejected = await L.applyCandidate(candId, 'rejected', { approvedBy: 'tester' });
    assertEq(rejected.status, 'rejected', '3b1 改 status=rejected');

    // 3c: 错 decision 抛错
    await assertThrows(() => L.applyCandidate(candId, 'invalid'), /必须 accepted\/rejected/, '3c1 错 decision 抛错');

    // 3d: 缺 candId 抛错
    await assertThrows(() => L.applyCandidate(null, 'accepted'), /candId/, '3d1 缺 candId 抛错');
  }

  // ===== [4] listCandidates 2 组 =====
  console.log('\n[4] listCandidates');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;
    // 造 2 个 candidate (同 code 3 次全正触发), 然后 accept 1 个
    for (let i = 0; i < 3; i++) {
      await L.recordLesson({
        decision: { code: 'P', sleeve: 'short', pattern: 'p' },
        outcome: { pnl: 0.10, winRate: 1.0 }
      });
    }
    for (let i = 0; i < 3; i++) {
      await L.recordLesson({
        decision: { code: 'Q', sleeve: 'short', pattern: 'q' },
        outcome: { pnl: -0.10, winRate: 0.0 }
      });
    }
    const all = await L.listCandidates({});
    assertTrue(all.length >= 1, `4a1 全量返回 (${all.length})`);

    const pending = await L.listCandidates({ status: 'pending' });
    assertTrue(pending.every(c => c.status === 'pending'), '4b1 status=pending 全是 pending');
    assertTrue(pending.length === 2, `4b2 两个 candidate 都 pending (${pending.length})`);
  }

  // ===== [5] KB 污染守卫 4 组 =====
  console.log('\n[5] KB 污染守卫 (哈希不变)');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;

    // 5a: recordLesson × 5
    for (let i = 0; i < 5; i++) {
      await L.recordLesson({
        decision: { code: 'KB1', sleeve: 'short', pattern: 'p' },
        outcome: { pnl: 0.10, winRate: 1.0 }
      });
    }
    assertEq(_sha256File(KB_PATH), KB_HASH_BEFORE, '5a1 recordLesson×5 后 KB 哈希不变');

    // 5b: applyCandidate accepted
    const cands = await L.listCandidates({ status: 'pending' });
    if (cands.length > 0) {
      await L.applyCandidate(cands[0].candId, 'accepted', { approvedBy: 'tester' });
    }
    assertEq(_sha256File(KB_PATH), KB_HASH_BEFORE, '5b1 applyCandidate accepted 后 KB 哈希不变');

    // 5c: applyCandidate rejected
    const cands2 = await L.listCandidates({ status: 'pending' });
    if (cands2.length > 0) {
      await L.applyCandidate(cands2[0].candId, 'rejected', { approvedBy: 'tester' });
    }
    assertEq(_sha256File(KB_PATH), KB_HASH_BEFORE, '5c1 applyCandidate rejected 后 KB 哈希不变');

    // 5d: distill 纯函数 (不写库, 但保险起见跑一下)
    L.distill([
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 },
      { code: 'A', sleeve: 'short', pattern: 'p', pnl: 0.1 }
    ]);
    assertEq(_sha256File(KB_PATH), KB_HASH_BEFORE, '5d1 distill 后 KB 哈希不变');
  }

  // ===== [6] listLessons 2 组 =====
  console.log('\n[6] listLessons');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;
    await L.recordLesson({ decision: { code: 'L1', sleeve: 'short' }, outcome: { pnl: 0.1 } });
    await L.recordLesson({ decision: { code: 'L1', sleeve: 'short' }, outcome: { pnl: -0.1 } });
    await L.recordLesson({ decision: { code: 'L2', sleeve: 'long' }, outcome: { pnl: 0.1 } });

    const l1 = await L.listLessons({ code: 'L1' });
    assertTrue(l1.length === 2 && l1.every(l => l.code === 'L1'), `6a1 按 code 过滤 (${l1.length})`);

    const lim = await L.listLessons({ limit: 2 });
    assertEq(lim.length, 2, `6b1 limit 截断 (${lim.length})`);
  }

  // ===== [7] 模块挂载 2 组 =====
  console.log('\n[7] 模块挂载');
  {
    const sb = buildSandbox();
    const L = sb.Core.Steward.Lessons;
    const required = ['recordLesson', 'distill', 'listCandidates', 'applyCandidate', 'listLessons'];
    let allOk = true;
    for (const m of required) if (typeof L[m] === 'undefined') { allOk = false; bad('7a 缺方法: ' + m); }
    if (allOk) ok('7a 全方法暴露');
    assertEq(L.LESSON_THRESHOLD, 3, '7b LESSON_THRESHOLD=3');
    assertEq(L.TABLE_LESSONS, 'steward_lessons', '7c TABLE_LESSONS');
    assertEq(L.TABLE_CANDIDATES, 'rule_candidates', '7d TABLE_CANDIDATES');
  }

  // ===== 输出汇总 =====
  console.log('\n========');
  console.log(`S5 Steward-Lessons 测试: ${pass} 通过, ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}

runAsyncTests().catch(e => {
  console.error('顶层异常:', e);
  process.exit(1);
});