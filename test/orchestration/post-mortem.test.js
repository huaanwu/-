/**
 * V8 — PostMortem (事后复盘) 单元测试
 *
 * 覆盖:
 *   1. _loadTodayTrades: 按 sleeve + 日期 + 未做过 postMortem 过滤
 *   2. _aggregateByCode: 按 code 聚合多笔成交
 *   3. _loadTraces: 拿同一 code 当日 decision_traces
 *   4. _askAiForPostMortem: 喂 AI 写 80-150 字
 *   5. runOnce: 整体跑通 (AI 返回 → 写回 trade_journal_ext.postMortem/postMortemAt)
 *   6. 失败兜底 (AI 抛错 → 标 "post-mortem 失败" + errors)
 *   7. 同 code 多笔只发一次 AI (聚合)
 *   8. 已做过的不重复 (postMortemAt 存在则跳过)
 *   9. init 注册到 Scheduler
 *   10. 源码对账
 *
 * 跑法: node test/orchestration/post-mortem.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const PM_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'post-mortem.js'), 'utf8');

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
  sb.Core = {
    Storage: {
      all: async (t) => allTables[t] || [],
      put: async (t, row) => {
        if (!allTables[t]) allTables[t] = [];
        const idx = allTables[t].findIndex(r => r.id === row.id);
        if (idx >= 0) allTables[t][idx] = row;
        else allTables[t].push(row);
        return row.id;
      },
      listDecisionTracesByStrategy: async (s, since, until) => {
        return ((allTables.decision_traces || [])).filter(r => r.strategy === s && (!since || r.ts >= since) && (!until || r.ts < until));
      }
    },
    AI: opts.noAi ? null : {
      call: async (sys, prompt, meta) => {
        if (opts.aiThrow) throw new Error('mocked AI failure');
        return '✅ 做对: 时机合理。❌ 做错: 未设止损。💡 下次: 严格执行 PnL ' + (prompt.includes('PnL 10') ? '10' : '0') + '% 止损。';
      }
    },
    Scheduler: opts.noScheduler ? null : {
      register: (name, fn, ms, opts2) => { sb._registered = sb._registered || []; sb._registered.push({ name, fn, ms, opts: opts2 }); return () => {}; }
    }
  };
  sb._allTables = allTables;
  vm.createContext(sb);
  return sb;
}

// ===== 情形 1: _loadTodayTrades 过滤 =====
describe('情形 1: _loadTodayTrades 按 sleeve + 日期 + 未做过过滤', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: 0.10 },
    { id: 2, code: '000001', sleeve: 'short', exitDate: '20260731', pnl: -0.05 },
    { id: 3, code: '300750', sleeve: 'short', exitDate: '20260730', pnl: 0.05 },  // 昨天, 跳过
    { id: 4, code: '600036', sleeve: 'long', exitDate: '20260731', pnl: 0.02 },    // long sleeve, 跳过
    { id: 5, code: '000002', sleeve: 'short', exitDate: '20260731', pnl: 0.03, postMortemAt: 12345 }  // 已做过
  ];
  const trades = await P._loadTodayTrades('short', '20260731');
  assert(trades.length === 2, `2 条未做过的 (${trades.length})`);
  const codes = trades.map(t => t.code).sort();
  assert(JSON.stringify(codes) === JSON.stringify(['000001', '600519']), `codes = ${codes}`);
});

// ===== 情形 2: _aggregateByCode 聚合 =====
describe('情形 2: _aggregateByCode 按 code 聚合', () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  const trades = [
    { code: '600519', pnl: 0.10 },
    { code: '000001', pnl: -0.05 },
    { code: '600519', pnl: 0.05 },
    { code: '300750', pnl: 0.02 },
    { code: '600519', pnl: -0.03 }
  ];
  const grouped = P._aggregateByCode(trades);
  assert(grouped.length === 3, `3 个 code (${grouped.length})`);
  const a519 = grouped.find(g => g.code === '600519');
  assert(a519 && a519.trades.length === 3, '600519 聚合 3 笔');
  assert(+(a519.totalPnl).toFixed(4) === 0.12, `600519 PnL 0.10+0.05-0.03=0.12 (${a519.totalPnl})`);
  // 空 code 跳过
  const empty = P._aggregateByCode([{ code: null }]);
  assert(empty.length === 0, 'null code 跳过');
});

// ===== 情形 3: _loadTraces 拿同日 traces =====
describe('情形 3: _loadTraces 拿同日 code traces', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  sb._allTables.decision_traces = [
    { traceId: 't1', strategy: 'short', code: '600519', ts: 1000 },
    { traceId: 't2', strategy: 'short', code: '600519', ts: 2000 },
    { traceId: 't3', strategy: 'short', code: '000001', ts: 3000 },
    { traceId: 't4', strategy: 'long', code: '600519', ts: 4000 }   // long, 不返回
  ];
  const traces = await P._loadTraces('600519', 0, 86400000);
  assert(traces.length === 2, `2 条 short/600519 (${traces.length})`);
  assert(traces[0].traceId === 't1' || traces[1].traceId === 't2', '含 t1/t2');
});

// ===== 情形 4: _askAiForPostMortem 喂 AI =====
describe('情形 4: _askAiForPostMortem 喂 AI', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  const text = await P._askAiForPostMortem('600519', 0.10, [{ exitPrice: 110, planPrice: 100, pnl: 0.10 }], []);
  assert(typeof text === 'string' && text.length > 0, '返回非空字符串');
  assert(text.length <= 500, `≤ 500 字 (${text.length})`);
});

// ===== 情形 5: AI 不可用时抛错 =====
describe('情形 5: AI 不可用时抛错', async () => {
  const sb = buildSandbox({ noAi: true });
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  let threw = false;
  try {
    await P._askAiForPostMortem('600519', 0.1, [{ pnl: 0.1 }], []);
  } catch (e) { threw = true; }
  assert(threw, 'Core.AI.call 缺失应抛错');
});

// ===== 情形 6: runOnce 整体跑通 =====
describe('情形 6: runOnce 整体跑通 + 写回 trade_journal_ext', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'short', exitDate: '20260731', planPrice: 100, exitPrice: 110, pnl: 0.10 },
    { id: 2, code: '000001', sleeve: 'short', exitDate: '20260731', planPrice: 10, exitPrice: 9.5, pnl: -0.05 }
  ];
  const result = await P.runOnce(new Date('2026-07-31T16:00:00'), 'short');
  assert(result.scanned === 2, `scanned=2 (${result.scanned})`);
  assert(result.postMortemCount === 2, `postMortemCount=2 (${result.postMortemCount})`);
  const updated1 = sb._allTables.trade_journal_ext.find(t => t.id === 1);
  assert(typeof updated1.postMortem === 'string' && updated1.postMortem.length > 0, '600519 写回 postMortem');
  assert(typeof updated1.postMortemAt === 'number', '600519 写回 postMortemAt (timestamp)');
});

// ===== 情形 7: AI 失败兜底 =====
describe('情形 7: AI 失败兜底 (写 post-mortem 失败)', async () => {
  const sb = buildSandbox({ aiThrow: true });
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: 0.10 }
  ];
  const result = await P.runOnce(new Date('2026-07-31T16:00:00'), 'short');
  assert(result.errors.length === 1, `errors 1 条 (${result.errors.length})`);
  const t = sb._allTables.trade_journal_ext[0];
  assert(t.postMortem.includes('post-mortem 失败'), `postMortem 标 "post-mortem 失败" (${t.postMortem})`);
  assert(t.postMortemAt > 0, 'postMortemAt 仍写入');
});

// ===== 情形 8: 同 code 多笔只发一次 AI =====
describe('情形 8: 同 code 多笔只发一次 AI (聚合)', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  let aiCalled = 0;
  sb.window.Core.AI.call = async () => { aiCalled++; return 'mock pm'; };
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: 0.05 },
    { id: 2, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: 0.05 },
    { id: 3, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: -0.03 },
    { id: 4, code: '000001', sleeve: 'short', exitDate: '20260731', pnl: 0.02 }
  ];
  await P.runOnce(new Date('2026-07-31T16:00:00'), 'short');
  assert(aiCalled === 2, `AI 调用 2 次 (2 个 code, ${aiCalled})`);
});

// ===== 情形 9: 已做过的不重复 =====
describe('情形 9: 已做过 postMortem 的不重复', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'short', exitDate: '20260731', pnl: 0.10, postMortem: '旧复盘', postMortemAt: 1234567 }
  ];
  const result = await P.runOnce(new Date('2026-07-31T16:00:00'), 'short');
  assert(result.scanned === 0, '已做过 → scanned=0');
  assert(result.postMortemCount === 0, '已做过 → postMortemCount=0');
});

// ===== 情形 10: init 注册到 Scheduler =====
describe('情形 10: init 注册到 Scheduler', async () => {
  const sb = buildSandbox();
  vm.runInContext(PM_SRC, sb, { filename: 'post-mortem.js' });
  const P = sb.window.Core.AI.PostMortem;
  await P.init();
  assert(sb._registered && sb._registered.find(r => r.name === 'post-mortem'), '注册 post-mortem task');
  const reg = sb._registered.find(r => r.name === 'post-mortem');
  assert(reg.ms === 60 * 60 * 1000, 'intervalMs = 1h');
  assert(reg.opts && reg.opts.jitterMs === 15 * 60 * 1000, 'jitterMs = 15min');
});

// ===== 情形 11: 源码对账 =====
describe('情形 11: 源码对账', () => {
  assert(/_loadTodayTrades/.test(PM_SRC), '_loadTodayTrades 私有');
  assert(/_aggregateByCode/.test(PM_SRC), '_aggregateByCode 私有');
  assert(/_loadTraces/.test(PM_SRC), '_loadTraces 私有');
  assert(/_askAiForPostMortem/.test(PM_SRC), '_askAiForPostMortem 私有');
  assert(/runOnce\s*\(/.test(PM_SRC), 'runOnce 公开');
  assert(/init\s*\(/.test(PM_SRC), 'init 公开');
  assert(/postMortemAt/.test(PM_SRC), '写 postMortemAt');
  assert(/Core.Scheduler.register/.test(PM_SRC), '调 Scheduler.register');
  assert(/post-mortem/.test(PM_SRC), 'task 名 post-mortem');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V8 PostMortem: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();