/**
 * V9 — KBFeedback (KB 命中率统计 + 自动调权重) 单元测试
 *
 * 覆盖:
 *   1. record: 写 ring buffer + kv
 *   2. ring buffer 上限 RING_LIMIT 滚动截断
 *   3. record 缺参时静默返回 logged=false
 *   4. flushWeek: 算 totalSeen/totalHit/hitRate + byCategory
 *   5. flushWeek: 空数据返 hitRate=null
 *   6. suggestReorder: hit rate 低于阈值时 demote 最低 category
 *   7. suggestReorder: hit rate 高于阈值时不动
 *   8. applyReorder: 写 PolicyBundle + 持久化 kv
 *   9. init 加载 kb_order_override
 *   10. 源码对账
 *
 * 跑法: node test/orchestration/kb-feedback.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const KBF_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'kb-feedback.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

function buildSandbox(opts = {}) {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    JSON, Array, Object, Map, Set, Error, Number
  };
  sb.window = sb;
  const allTables = {};
  const kvStore = {};
  sb.Core = {
    Storage: {
      kvGet: async (k) => kvStore[k] || null,
      kvSet: async (k, v) => { kvStore[k] = v; },
      all: async (t) => allTables[t] || []
    },
    KB: { get: async () => [] },
    AI: {
      PolicyBundle: {
        _KB_BY_STRATEGY: {
          long: ['valuation', 'cycle', 'position', 'risk'],
          short: ['risk', 'behavior', 'case', 'macro_signal']
        },
        _setKbOrder: function(strategy, newOrder) {
          this._KB_BY_STRATEGY[strategy] = newOrder.slice();
        }
      },
      WeeklyAttribution: { weekIdOf: () => '2026-W31' }
    }
  };
  sb._kv = kvStore;
  sb._allTables = allTables;
  vm.createContext(sb);
  return sb;
}

// ===== 情形 1: record 写 ring + kv =====
describe('情形 1: record 写 ring buffer + kv', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const r = await K.record({ strategy: 'long', kbIds: ['VALUATION-001', 'RISK-002'], runId: 'r1' });
  assert(r.logged === true, 'logged=true');
  const ring = K._ringSnapshot();
  assert(ring.length === 1, 'ring 1 行');
  assert(ring[0].strategy === 'long', 'strategy 保留');
  assert(ring[0].kbIds.length === 2, 'kbIds 保留');
  assert(sb._kv.kb_hit_log && sb._kv.kb_hit_log.length === 1, 'kv 也写 1 行');
});

// ===== 情形 2: ring buffer 滚动截断 =====
describe('情形 2: ring buffer 上限 RING_LIMIT 滚动截断', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const LIMIT = K.RING_LIMIT;
  // 写 LIMIT + 10 条
  for (let i = 0; i < LIMIT + 10; i++) {
    await K.record({ strategy: 'short', kbIds: ['RISK-' + i], ts: 1000 + i });
  }
  const ring = K._ringSnapshot();
  assert(ring.length === LIMIT, `ring 长度 = ${LIMIT} (${ring.length})`);
  // 第一条是 i=10 (前面 10 条被滚动掉)
  assert(ring[0].kbIds[0] === 'RISK-10', `最早的是 RISK-10 (${ring[0].kbIds[0]})`);
  // kv 也滚动
  assert(sb._kv.kb_hit_log.length === LIMIT, `kv 也滚动到 ${LIMIT}`);
});

// ===== 情形 3: record 缺参静默 =====
describe('情形 3: record 缺参返回 logged=false', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  let threw = false;
  try {
    await K.record(null);
    await K.record(undefined);
    await K.record({ strategy: 'long' });  // 缺 kbIds
    await K.record({ kbIds: ['x'] });     // 缺 strategy
  } catch (e) { threw = true; }
  assert(!threw, '缺参不抛错');
  assert(K._ringSnapshot().length === 0, 'ring 仍 0 行');
});

// ===== 情形 4: flushWeek 算 hit rate + byCategory =====
describe('情形 4: flushWeek 算 hit rate + byCategory', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  // 注入 5 行 kb_hit_log
  sb._kv.kb_hit_log = [
    { strategy: 'long', kbIds: ['VALUATION-001', 'RISK-002', 'CYCLE-003'], ts: 1000 },
    { strategy: 'long', kbIds: ['VALUATION-001'], ts: 2000 },
    { strategy: 'long', kbIds: ['RISK-002', 'POSITION-004'], ts: 3000 },
    { strategy: 'short', kbIds: ['X-1'], ts: 4000 }  // 不在 long, 跳过
  ];
  // weekly_attribution 含 summary, 引用了 VALUATION-001 + RISK-002, 没引用 CYCLE/POSITION
  sb._allTables.weekly_attribution = [{
    weekId: '2026-W31:long', strategy: 'long', summary: '本周看到 VALUATION-001 的低估机会, 但 RISK-002 提示了回撤风险'
  }];
  const report = await K.flushWeek('long', new Date(), { sinceTs: 0, untilTs: 99999999 });
  assert(report.totalSeen === 6, `totalSeen=6 (4+1+2, ${report.totalSeen})`);
  // hit: VALUATION-001 出现 2 次, RISK-002 出现 2 次 = 4 次
  assert(report.totalHit === 4, `totalHit=4 (${report.totalHit})`);
  assert(report.hitRate === +(4 / 6).toFixed(4), `hitRate ≈ 0.6667 (${report.hitRate})`);
  // byCategory 是 hit rate 数字 (0~1), 不是 seen/hit 对象
  assert(report.byCategory.valuation === 1, `valuation hit rate=1 (2/2)`);
  assert(report.byCategory.risk === 1, `risk hit rate=1 (2/2)`);
  assert(report.byCategory.cycle === 0, `cycle hit rate=0 (1/1 没命中)`);
  assert(report.byCategory.position === 0, `position hit rate=0 (1/1 没命中)`);
});

// ===== 情形 5: flushWeek 空数据 =====
describe('情形 5: flushWeek 无数据返 hitRate=null', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const report = await K.flushWeek('long', new Date(), { sinceTs: 0, untilTs: 99999999 });
  assert(report.totalSeen === 0, 'totalSeen=0');
  assert(report.totalHit === 0, 'totalHit=0');
  assert(report.hitRate === null, 'hitRate=null');
});

// ===== 情形 6: suggestReorder hit rate 低时 demote =====
describe('情形 6: suggestReorder hit rate 低时 demote 最差 category', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const weekReport = {
    strategy: 'long',
    totalSeen: 10, totalHit: 2, hitRate: 0.20,  // 低于阈值 0.30
    byCategory: {
      valuation: 0.5,   // 50%
      cycle: 0.05,      // 最差
      position: 0.10,
      risk: 0.40
    }
  };
  const out = await K.suggestReorder('long', weekReport);
  assert(out.demotedCategory === 'cycle', `demote cycle (${out.demotedCategory})`);
  assert(JSON.stringify(out.newOrder) === JSON.stringify(['valuation', 'position', 'risk', 'cycle']),
    `newOrder = ${out.newOrder}`);
});

// ===== 情形 7: suggestReorder hit rate 高于阈值时不动 =====
describe('情形 7: suggestReorder hit rate 高于阈值不动', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const weekReport = {
    strategy: 'long',
    totalSeen: 10, totalHit: 5, hitRate: 0.50,
    byCategory: { valuation: 0.5, cycle: 0.4, position: 0.6, risk: 0.5 }
  };
  const out = await K.suggestReorder('long', weekReport);
  assert(out.demotedCategory === null, '不 demote');
  assert(JSON.stringify(out.newOrder) === JSON.stringify(out.oldOrder), 'newOrder = oldOrder');
});

// ===== 情形 8: applyReorder =====
describe('情形 8: applyReorder 写 PolicyBundle + kv', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  const r = await K.applyReorder('long', ['risk', 'valuation', 'cycle', 'position']);
  assert(r === true, 'applyReorder=true');
  // PolicyBundle._KB_BY_STRATEGY.long 已变
  const order = sb.window.Core.AI.PolicyBundle._KB_BY_STRATEGY.long;
  assert(JSON.stringify(order) === JSON.stringify(['risk', 'valuation', 'cycle', 'position']),
    `PolicyBundle long = ${order}`);
  // kv 持久化
  assert(sb._kv.kb_order_override && sb._kv.kb_order_override.long, 'kv.kb_order_override 写入');
});

// ===== 情形 9: init 加载 kb_order_override =====
describe('情形 9: init 加载 kb_order_override 到 PolicyBundle', async () => {
  const sb = buildSandbox();
  vm.runInContext(KBF_SRC, sb, { filename: 'kb-feedback.js' });
  const K = sb.window.Core.AI.KBFeedback;
  sb._kv.kb_order_override = {
    short: ['macro_signal', 'risk', 'behavior', 'case']
  };
  await K.init();
  const order = sb.window.Core.AI.PolicyBundle._KB_BY_STRATEGY.short;
  assert(JSON.stringify(order) === JSON.stringify(['macro_signal', 'risk', 'behavior', 'case']),
    `short 顺序恢复 = ${order}`);
});

// ===== 情形 10: 源码对账 =====
describe('情形 10: 源码对账', () => {
  assert(/record\s*\(/.test(KBF_SRC), 'KBFeedback.record');
  assert(/flushWeek\s*\(/.test(KBF_SRC), 'KBFeedback.flushWeek');
  assert(/suggestReorder\s*\(/.test(KBF_SRC), 'KBFeedback.suggestReorder');
  assert(/applyReorder\s*\(/.test(KBF_SRC), 'KBFeedback.applyReorder');
  assert(/init\s*\(/.test(KBF_SRC), 'KBFeedback.init');
  assert(/RING_LIMIT\s*=\s*500/.test(KBF_SRC), 'RING_LIMIT = 500');
  assert(/HIT_RATE_THRESHOLD/.test(KBF_SRC), 'HIT_RATE_THRESHOLD 常量');
  assert(/kb_hit_log/.test(KBF_SRC), 'kv key = kb_hit_log');
  assert(/kb_order_override/.test(KBF_SRC), 'kv key = kb_order_override');
  assert(/_normalizeCategory/.test(KBF_SRC), '_normalizeCategory 私有');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V9 KBFeedback: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();