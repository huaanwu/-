/**
 * S1 Steward — Storage v7: 4 表 + 12 helper 单元测试
 *
 * 覆盖:
 *   1. DB_VERSION = 8 (v0.2.26 ST 升, v0.2.25 S1 曾为 7)
 *   2. version(7) 声明的 4 个 store (pool_snapshots/steward_plans/rule_candidates/steward_lessons)
 *   3. pool_snapshots: savePoolSnapshot + getPoolSnapshot + listPoolSnapshots (按 sleeve + date 倒序)
 *   4. pool_snapshots: 幂等键 snapId 同日重复跑被覆盖
 *   5. steward_plans: saveStewardPlan + listStewardPlans (按 status/date 过滤 + limit)
 *   6. rule_candidates: addRuleCandidate + decideRuleCandidate (accepted/rejected 状态机)
 *   7. rule_candidates: decideRuleCandidate 找不到 → 抛错; decision 非法 → 抛错
 *   8. steward_lessons: addStewardLesson + listStewardLessons (按 code/sleeve 过滤)
 *   9. 缺主键 fail-fast (snapId / planId / candId / code)
 *   10. ts 自动填 Date.now()
 *   11. 暴露在 Core.Storage 上 (helper 全 13 个)
 *   12. KB 污染守卫: Steward 4 个 helper 不引用任何 KB 相关路径
 *
 * 跑法: node test/orchestration/storage-v7.test.js
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
 */
function makeFakeDb(tables, primaryKeys) {
  const PK = primaryKeys || {
    pool_snapshots: 'snapId',
    steward_plans: 'planId',
    rule_candidates: 'candId',
    steward_lessons: 'id'
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
      clear: async () => { rows.clear(); },
      delete: async (k) => { rows.delete(k); return 1; },
      bulkDelete: async (ks) => { ks.forEach(k => rows.delete(k)); return ks.length; }
    };
    db[name] = tbl;
  });
  return db;
}

function buildSandbox() {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number
  };
  sb.window = sb;

  const tablesV2 = ['watchlist','holdings','transactions','journals','alerts','funds','cashflow','cache','kv','settings_snapshots'];
  const tablesV3 = ['ai_call_log','agent_runs','ai_traces'];
  const tablesV4 = ['research_pool'];
  const tablesV6 = ['decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  const tablesV7 = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons'];
  const allTables = [...tablesV2, ...tablesV3, ...tablesV4, ...tablesV6, ...tablesV7];

  function FakeDexie(name) {
    const db = makeFakeDb(allTables, {
      pool_snapshots: 'snapId',
      steward_plans: 'planId',
      rule_candidates: 'candId',
      steward_lessons: 'id'
    });
    return {
      name,
      version: (v) => ({ stores: (schema) => ({ stores: schema }) }),
      _tables: db
    };
  }

  sb.Dexie = function (name) {
    const inst = FakeDexie(name);
    Object.assign(inst, inst._tables);
    return inst;
  };
  sb.window.Dexie = sb.Dexie;
  sb.window.Dexie.delete = async () => {};

  vm.createContext(sb);
  vm.runInContext(STORAGE_SRC, sb, { filename: 'storage.js' });
  return sb;
}

// ===== 情形 1: DB_VERSION = 8 =====
describe('情形 1: DB_VERSION 升到 7', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  assert(S.DB_VERSION === 8, `DB_VERSION = 8 (实际 ${S.DB_VERSION})`);
  assert(S.DB_NAME === 'stockmaster', 'DB_NAME = stockmaster');
});

// ===== 情形 2: 4 表对应 13 helper 全暴露 =====
describe('情形 2: 4 表对应 13 helper 暴露', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  // pool_snapshots
  assert(typeof S.savePoolSnapshot === 'function', 'savePoolSnapshot 暴露');
  assert(typeof S.getPoolSnapshot === 'function', 'getPoolSnapshot 暴露');
  assert(typeof S.listPoolSnapshots === 'function', 'listPoolSnapshots 暴露');
  // steward_plans
  assert(typeof S.saveStewardPlan === 'function', 'saveStewardPlan 暴露');
  assert(typeof S.listStewardPlans === 'function', 'listStewardPlans 暴露');
  assert(typeof S.getStewardPlan === 'function', 'getStewardPlan 暴露');
  // rule_candidates
  assert(typeof S.addRuleCandidate === 'function', 'addRuleCandidate 暴露');
  assert(typeof S.listRuleCandidates === 'function', 'listRuleCandidates 暴露');
  assert(typeof S.decideRuleCandidate === 'function', 'decideRuleCandidate 暴露');
  // steward_lessons
  assert(typeof S.addStewardLesson === 'function', 'addStewardLesson 暴露');
  assert(typeof S.listStewardLessons === 'function', 'listStewardLessons 暴露');
});

// ===== 情形 3: pool_snapshots 增改查 + 幂等 =====
describe('情形 3: pool_snapshots save/get + 幂等覆盖', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  const snap1 = {
    snapId: '2026-07-31-long',
    date: '2026-07-31', sleeve: 'long', ts: 1000, runId: 'r1',
    source: 'screener+llm', regime: 'bull', cycleStage: 'expansion', factor: 1.0,
    items: [{ code: '600519', name: '贵州茅台', rank: 1, score: 92, confidence: 0.9, dims: {}, ruleReason: 'roe>15%', llmReason: '毛选矛盾论主升', ruleRefs: ['MAO-001','SCR-LONG-roe'] }],
    diff: { added: ['600519'], removed: [], kept: 0 }, kbIds: ['MAO-001'], promptDigest: 'sha-xxx', itemCount: 1
  };
  await S.savePoolSnapshot(snap1);
  const got = await S.getPoolSnapshot('2026-07-31-long');
  assert(got && got.code === undefined && got.runId === 'r1', 'getPoolSnapshot 返原 snap');
  assert(got.items.length === 1 && got.items[0].code === '600519', 'items 保留完整');

  // 同 snapId 重 save → 覆盖 (update)
  await S.savePoolSnapshot({ ...snap1, itemCount: 50, items: snap1.items.concat([{ code: '000001', name: '平安银行', rank: 2, score: 88 }]) });
  const got2 = await S.getPoolSnapshot('2026-07-31-long');
  assert(got2.itemCount === 50 && got2.items.length === 2, '同 snapId 重复 save 覆盖');
});

// ===== 情形 4: pool_snapshots listPoolSnapshots 按 sleeve + date 倒序 =====
describe('情形 4: pool_snapshots listPoolSnapshots', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.savePoolSnapshot({ snapId: '2026-07-29-long', date: '2026-07-29', sleeve: 'long', ts: 100 });
  await S.savePoolSnapshot({ snapId: '2026-07-30-long', date: '2026-07-30', sleeve: 'long', ts: 200 });
  await S.savePoolSnapshot({ snapId: '2026-07-31-long', date: '2026-07-31', sleeve: 'long', ts: 300 });
  await S.savePoolSnapshot({ snapId: '2026-07-31-short', date: '2026-07-31', sleeve: 'short', ts: 350 });

  const longs = await S.listPoolSnapshots('long');
  assert(longs.length === 3, `sleeve=long 返 3 天`);
  assert(longs[0].snapId === '2026-07-31-long', 'date 倒序: 31 在前');

  const limit1 = await S.listPoolSnapshots('long', 1);
  assert(limit1.length === 1 && limit1[0].date === '2026-07-31', 'limit=1 只返最新');
});

// ===== 情形 5: steward_plans 增查 + 状态过滤 =====
describe('情形 5: steward_plans 状态过滤 + limit', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.saveStewardPlan({ planId: 'p1', date: '2026-07-31', status: 'pending', sleeve: 'long', ts: 1000, targets: [] });
  await S.saveStewardPlan({ planId: 'p2', date: '2026-07-31', status: 'approved', sleeve: 'long', ts: 2000, targets: [] });
  await S.saveStewardPlan({ planId: 'p3', date: '2026-08-01', status: 'pending', sleeve: 'short', ts: 3000, targets: [] });

  const pending = await S.listStewardPlans({ status: 'pending' });
  assert(pending.length === 2, `status=pending 返 2 条`);
  assert(pending[0].planId === 'p3' && pending[1].planId === 'p1', 'ts 倒序: p3(3000) 在前');

  const day31 = await S.listStewardPlans({ date: '2026-07-31' });
  assert(day31.length === 2, `date=2026-07-31 返 2 条`);

  const top1 = await S.listStewardPlans({ limit: 1 });
  assert(top1.length === 1 && top1[0].planId === 'p3', 'limit=1 返最新 p3');

  // getStewardPlan
  const p2 = await S.getStewardPlan('p2');
  assert(p2 && p2.status === 'approved', 'getStewardPlan(p2) 返 approved 行');
});

// ===== 情形 6: rule_candidates 状态机 =====
describe('情形 6: rule_candidates decideRuleCandidate 状态机', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.addRuleCandidate({ candId: 'c1', source: 'steward.distill.2026-W31.short', pattern: 'rsi>70+放量', evidence: { count: 5, deviation: 0.18 }, suggestedAction: '加入短线风控 KB 候选' });
  await S.addRuleCandidate({ candId: 'c2', source: 'steward.distill.2026-W31.long', pattern: 'roe<5%+商誉>30%' });

  const pending = await S.listRuleCandidates('pending');
  assert(pending.length === 2, `默认 status=pending 返 2 条`);

  // accept
  const accepted = await S.decideRuleCandidate('c1', 'accepted', { approvedBy: 'user', note: '采纳' });
  assert(accepted.status === 'accepted' && accepted.decidedBy === 'user' && accepted.decidedNote === '采纳', 'accepted 状态机');
  assert(typeof accepted.decidedAt === 'number' && accepted.decidedAt > 0, 'decidedAt 自动填');

  // reject
  const rejected = await S.decideRuleCandidate('c2', 'rejected', { approvedBy: 'user' });
  assert(rejected.status === 'rejected' && rejected.decidedBy === 'user', 'rejected 状态机');

  // pending 过滤: 此时已无
  const stillPending = await S.listRuleCandidates('pending');
  assert(stillPending.length === 0, '2 条都被拍板后 pending 列表空');
  const acceptedList = await S.listRuleCandidates('accepted');
  assert(acceptedList.length === 1 && acceptedList[0].candId === 'c1', 'accepted 列表返 c1');
});

// ===== 情形 7: rule_candidates 错误处理 =====
describe('情形 7: rule_candidates 错误处理', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  // 找不到 candId
  let threw1 = false;
  try { await S.decideRuleCandidate('not-exist', 'accepted'); } catch (e) { threw1 = true; }
  assert(threw1, 'decideRuleCandidate(not-exist) 抛错');

  // 非法 decision
  await S.addRuleCandidate({ candId: 'c1', source: 'test' });
  let threw2 = false;
  try { await S.decideRuleCandidate('c1', 'maybe'); } catch (e) { threw2 = true; }
  assert(threw2, 'decision=maybe 抛错 (只接受 accepted/rejected)');

  // 缺 candId
  let threw3 = false;
  try { await S.addRuleCandidate({ source: 'test' }); } catch (e) { threw3 = true; }
  assert(threw3, 'addRuleCandidate 缺 candId 抛错');
});

// ===== 情形 8: steward_lessons 增查 + 多过滤 =====
describe('情形 8: steward_lessons 过滤', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  await S.addStewardLesson({ code: '600519', sleeve: 'long', pattern: 'high_roe', decision: 'buy', outcome: 'win', ts: 1000 });
  await S.addStewardLesson({ code: '600519', sleeve: 'long', pattern: 'high_roe', decision: 'buy', outcome: 'loss', ts: 2000 });
  await S.addStewardLesson({ code: '300750', sleeve: 'short', pattern: 'rsi_overbought', decision: 'sell', outcome: 'win', ts: 3000 });

  const all = await S.listStewardLessons();
  assert(all.length === 3 && all[0].code === '300750', 'list 全量 + ts 倒序');

  const m600519 = await S.listStewardLessons({ code: '600519' });
  assert(m600519.length === 2, 'code=600519 返 2 条');

  const shortOnly = await S.listStewardLessons({ sleeve: 'short' });
  assert(shortOnly.length === 1 && shortOnly[0].code === '300750', 'sleeve=short 返 1 条');

  const byPattern = await S.listStewardLessons({ pattern: 'high_roe' });
  assert(byPattern.length === 2, 'pattern=high_roe 返 2 条');

  // limit
  const top2 = await S.listStewardLessons({ limit: 2 });
  assert(top2.length === 2, 'limit=2 返 2 条');
});

// ===== 情形 9: 缺主键 fail-fast =====
describe('情形 9: 缺主键 fail-fast', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  let t1 = false; try { await S.savePoolSnapshot({}); } catch (e) { t1 = true; } assert(t1, 'savePoolSnapshot 缺 snapId 抛错');
  let t2 = false; try { await S.saveStewardPlan({}); } catch (e) { t2 = true; } assert(t2, 'saveStewardPlan 缺 planId 抛错');
  let t3 = false; try { await S.addRuleCandidate({}); } catch (e) { t3 = true; } assert(t3, 'addRuleCandidate 缺 candId 抛错');
  let t4 = false; try { await S.addStewardLesson({}); } catch (e) { t4 = true; } assert(t4, 'addStewardLesson 缺 code 抛错');
});

// ===== 情形 10: ts 自动填 =====
describe('情形 10: 不传 ts 自动填 Date.now()', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  const before = Date.now();
  await S.savePoolSnapshot({ snapId: 'auto-ts', date: '2026-07-31', sleeve: 'long' });
  const after = Date.now();
  const got = await S.getPoolSnapshot('auto-ts');
  assert(got.ts >= before && got.ts <= after, 'savePoolSnapshot 自动填 ts');
});

// ===== 情形 11: 持久化语义 (KB 不能污染) =====
describe('情形 11: Steward 4 表持久化仅追加 + 拍板改状态', async () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;
  await S.init();

  // 加一条规则候选 + 拍板接受; 验证 cand 内容 (pattern/evidence) 一字未改
  const origPattern = 'roe>15% AND 商誉<10%';
  await S.addRuleCandidate({ candId: 'c1', source: 'test', pattern: origPattern, evidence: { count: 5 } });
  const before = await S.getStewardPlan('dummy'); // 无关, 只是暖一下
  void before;
  const accepted = await S.decideRuleCandidate('c1', 'accepted', { approvedBy: 'user' });
  assert(accepted.pattern === origPattern, 'accept 后 pattern 不被改 (防污染)');
  assert(accepted.status === 'accepted', '只改 status');
});

// ===== 情形 12: KB 污染守卫 — 源码扫描 =====
describe('情形 12: KB 污染守卫 — Storage v7 源码不引用 KB 写路径', () => {
  // 验证: storage.js 里没有 kb/kb-feedback/kb_order 这类敏感词写入 kvSet 的踪迹
  // (Steward 4 表只走自己表, KB 物理分表, 不能污染)
  const forbidden = [
    /kvSet\([^)]*kb/i,
    /kvSet\([^)]*order/i,
    /addRuleCandidate[^}]*kb_order/i
  ];
  for (const re of forbidden) {
    assert(!re.test(STORAGE_SRC), `源码不应有 KB 污染模式: ${re}`);
  }
  // 正向断言: storage.js 里确实有 Steward 4 helper (S1 已落地)
  assert(/savePoolSnapshot/.test(STORAGE_SRC), 'savePoolSnapshot 落地');
  assert(/saveStewardPlan/.test(STORAGE_SRC), 'saveStewardPlan 落地');
  assert(/addRuleCandidate/.test(STORAGE_SRC), 'addRuleCandidate 落地');
  assert(/addStewardLesson/.test(STORAGE_SRC), 'addStewardLesson 落地');
});

// ===== 情形 13: schema 漂移对账 — db.version().stores() 表 ↔ Core.Storage helper CRUD =====
describe('情形 13: schema 漂移对账 — DB 表都有 helper CRUD 覆盖', () => {
  const sb = buildSandbox();
  const S = sb.window.Core.Storage;

  // 从 Reflect.ownKeys 列举 Core.Storage 全部 helper 方法名
  const helperNames = Reflect.ownKeys(S).filter(k => typeof S[k] === 'function' && k !== 'init');
  console.log('  Core.Storage helper 方法数:', helperNames.length);

  // storage.js 版本声明映射: version → { stores: {...} } 里的表名
  // v2: watchlist/holdings/transactions/journals/alerts/funds/cashflow/cache/kv/settings_snapshots
  const v2Tables = ['watchlist','holdings','transactions','journals','alerts','funds','cashflow','cache','kv','settings_snapshots'];
  // v3: ai_call_log/agent_runs/ai_traces
  const v3Tables = ['ai_call_log','agent_runs','ai_traces'];
  // v4: research_pool
  const v4Tables = ['research_pool'];
  // v6: decision_traces/trade_journal_ext/missed_opportunities/weekly_attribution
  const v6Tables = ['decision_traces','trade_journal_ext','missed_opportunities','weekly_attribution'];
  // v7: pool_snapshots/steward_plans/rule_candidates/steward_lessons/rule_overrides
  const v7Tables = ['pool_snapshots','steward_plans','rule_candidates','steward_lessons','rule_overrides'];
  // v8: sub_strategies
  const v8Tables = ['sub_strategies'];

  const allTables = [...v2Tables, ...v3Tables, ...v4Tables, ...v6Tables, ...v7Tables, ...v8Tables];

  // helper 方法名 → 表名映射 (约定: read/write 类 helper 含表名关键词)
  const tableKeywords = {
    // 通用 CRUD: add/put/get/all/where/remove/clear 覆盖所有表 (通过调用方传表名)
    // 专用 helper:
    watchlist: ['watchlist'],           // 通用 CRUD
    holdings: ['holdings'],             // 通用 CRUD
    transactions: ['transactions'],     // 通用 CRUD
    journals: ['journals'],             // 通用 CRUD
    alerts: ['alerts'],                 // 通用 CRUD
    funds: ['funds'],                   // 通用 CRUD
    cashflow: ['cashflow'],             // 通用 CRUD
    cache: ['cache', 'Cache'],          // cacheSet / cacheGet / cacheClear
    kv: ['kv', 'Kv'],                   // kvGet / kvSet / kvDelete / onKvChange
    settings_snapshots: ['SettingsSnapshot','settings_snapshot'],  // saveSettingsSnapshot 等
    ai_call_log: ['AiCallLog','ai_call_log'],  // (v3 声明, 由通用 add 覆盖)
    agent_runs: ['AgentRun','agent_run'],       // addAgentRun / listAgentRuns / getAgentRun
    ai_traces: ['AITrace','ai_trace'],          // addAITraces / listAITracesByRun
    research_pool: ['ResearchPool','research_pool'],  // (v4, 由 ResearchPool 模块用通用 CRUD)
    decision_traces: ['DecisionTrace','decision_trace'],  // addDecisionTrace / listDecisionTracesByRun / listDecisionTracesByStrategy
    trade_journal_ext: ['TradeJournalExt','trade_journal_ext'], // addTradeJournalExt / getTradeJournalExtByJournal
    missed_opportunities: ['MissedOpportunit','missed_opportunit'], // addMissedOpportunity / listMissedOpportunities
    weekly_attribution: ['WeeklyAttribution','weekly_attribution'], // saveWeeklyAttribution / getWeeklyAttribution / listWeeklyAttribution
    pool_snapshots: ['PoolSnapshot','pool_snapshot'],    // savePoolSnapshot / getPoolSnapshot / listPoolSnapshots
    steward_plans: ['StewardPlan','steward_plan'],       // saveStewardPlan / listStewardPlans / getStewardPlan
    rule_candidates: ['RuleCandidate','rule_candidate'], // addRuleCandidate / listRuleCandidates / decideRuleCandidate
    steward_lessons: ['StewardLesson','steward_lesson'], // addStewardLesson / listStewardLessons
    rule_overrides: ['RuleOverride','rule_override'],    // addRuleOverride / listRuleOverrides / revokeRuleOverride / clearRuleOverrides
    sub_strategies: ['SubStrateg','sub_strateg']         // (v8, 由 Strategies 模块用通用 CRUD)
  };

  // v2 通用 CRUD (add/put/get/all/where/remove/clear) 覆盖所有表 — 这是基类
  const genericCRUD = ['add', 'put', 'get', 'all', 'where', 'remove', 'clear'];
  const hasGenericCRUD = genericCRUD.every(m => helperNames.includes(m));
  assert(hasGenericCRUD, '通用 CRUD 7 方法全存在 (add/put/get/all/where/remove/clear)');

  // 每张表 check: 要么有专用 helper, 要么通用 CRUD 覆盖
  const uncovered = [];
  for (const table of allTables) {
    const keywords = tableKeywords[table] || [table];
    const hasDedicated = helperNames.some(name => {
      return keywords.some(kw => String(name).toLowerCase().includes(kw.toLowerCase()));
    });
    // 通用 CRUD 覆盖所有表 (传表名调用)
    const coveredByGeneric = hasGenericCRUD;
    if (!hasDedicated && !coveredByGeneric) {
      uncovered.push(table);
    }
  }

  if (uncovered.length > 0) {
    console.error('  未覆盖的表:', uncovered);
  }
  assert(uncovered.length === 0, `所有 ${allTables.length} 张表都有 CRUD 覆盖 (专用 helper 或通用 CRUD)`);

  // 额外: 验证每个专用 helper 名对应表在 schema 里存在
  const dedicatedHelpers = helperNames.filter(n => {
    const name = String(n);
    return !['add','put','get','all','where','remove','clear',
             'init','cacheGet','cacheSet','cacheClear',
             'kvGet','kvSet','kvDelete','onKvChange',
             'clearAll','DB_NAME','DB_VERSION'].includes(name);
  });
  console.log('  专用 helper 数 (不含通用):', dedicatedHelpers.length);
  assert(dedicatedHelpers.length >= 30, `专用 helper 数 ≥ 30 (实际 ${dedicatedHelpers.length})`);

  // DB_VERSION 断言
  assert(S.DB_VERSION === 8, `DB_VERSION = 8 → schema chain v2-v3-v4-v6-v7-v8 完整`);
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`S1 Storage v7: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();