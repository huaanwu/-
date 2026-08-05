/**
 * V7 — WeeklyAttribution + WeeklyReview 单元测试
 *
 * 覆盖:
 *   1. weekIdOf: ISO 周编号
 *   2. weekWindowOf: 周一到下周一时间窗
 *   3. collectWeek: 拉本周决策/成交/错过 + 统计
 *   4. _exitsDateInWeek: 多种日期格式
 *   5. _buildPrompt: 输出包含数字 + 样本
 *   6. runOnce: AI 不可用时降级落库 (无 AI 返回)
 *   7. WeeklyReview._tick: 周日/周一才触发, 每日防重复
 *   8. WeeklyReview.init: 注册到 Scheduler + 启动时补跑
 *   9. 源码对账
 *
 * 跑法: node test/orchestration/weekly-attribution.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ATTR_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'weekly-attribution.js'), 'utf8');
const REVIEW_SRC = fs.readFileSync(path.join(ROOT, 'www', 'app', 'weekly-review.js'), 'utf8');

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
  // 默认 Storage: 接受所有表查询, 内存中保存
  const allTables = {};
  sb.Core = {
    Storage: {
      addDecisionTrace: async () => 1,
      listDecisionTracesByStrategy: async (s, since, until) => {
        const rows = (allTables.decision_traces || []);
        return rows.filter(r => r.strategy === s && (!since || r.ts >= since) && (!until || r.ts < until));
      },
      all: async (t) => allTables[t] || [],
      saveWeeklyAttribution: async (row) => {
        if (!allTables.weekly_attribution) allTables.weekly_attribution = [];
        // 模拟 storage.js 内部把 weekId 拼成 compositeKey
        const savedRow = Object.assign({}, row, { weekId: row.weekId + ':' + row.strategy });
        const idx = allTables.weekly_attribution.findIndex(r => r.weekId === savedRow.weekId);
        if (idx >= 0) allTables.weekly_attribution[idx] = savedRow;
        else allTables.weekly_attribution.push(savedRow);
        return savedRow.weekId;
      },
      kvGet: async (k) => (allTables.kv || {})[k] || null,
      kvSet: async (k, v) => {
        allTables.kv = allTables.kv || {};
        allTables.kv[k] = v;
      },
      get: async () => null
    },
    AI: opts.noAi ? null : {
      call: async (sys, prompt, opts2) => '本周 AI 决策' + (opts2 && opts2.purpose || '') + ' 总结: ' + (prompt.includes('Pnl: 0.1234') ? '含Pnl' : '无Pnl')
    },
    Scheduler: opts.noScheduler ? null : { register: (name, fn) => { sb._registered = sb._registered || []; sb._registered.push(name); return () => {}; } }
  };
  sb._allTables = allTables;
  vm.createContext(sb);
  return sb;
}

// ===== 情形 1: weekIdOf 算 ISO 周 =====
describe('情形 1: weekIdOf 算 ISO 周编号', () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  // 2026-01-01 (Thu) → 2026-W01
  const r1 = W.weekIdOf(new Date('2026-01-01T12:00:00'));
  assert(/^2026-W\d{2}$/.test(r1), `格式 YYYY-WW (${r1})`);
  // 2026-07-31 (Fri) → 2026-W31
  const r2 = W.weekIdOf(new Date('2026-07-31T12:00:00'));
  assert(r2 === '2026-W31', `2026-07-31 → ${r2}`);
  // 2026-12-31 (Thu) → 2026-W53 (跨年边界)
  const r3 = W.weekIdOf(new Date('2026-12-31T12:00:00'));
  assert(/^202[56]-W\d{2}$/.test(r3), `年末 ${r3}`);
});

// ===== 情形 2: weekWindowOf =====
describe('情形 2: weekWindowOf 时间窗', () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  // 2026-07-31 (Fri) → 周一 = 2026-07-27, 下周一 = 2026-08-03
  const win = W.weekWindowOf(new Date('2026-07-31T15:00:00'));
  assert(win.weekStart.getDay() === 1, 'weekStart 是周一');
  assert(win.weekStart.getFullYear() === 2026 && win.weekStart.getMonth() === 6 && win.weekStart.getDate() === 27, 'weekStart = 2026-07-27');
  assert(win.untilTs - win.sinceTs === 7 * 86400000, '时间窗 = 7 天');
  // 周日 → 周一是 6 天前
  const sun = new Date('2026-07-26T10:00:00');  // Sun
  const win2 = W.weekWindowOf(sun);
  assert(win2.weekStart.getDate() === 20, `周日 → 上周一 7/20 (${win2.weekStart.getDate()})`);
});

// ===== 情形 3: _exitsDateInWeek 多种格式 =====
describe('情形 3: _exitsDateInWeek 多种日期格式', () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  const weekStart = new Date('2026-07-27T00:00:00');
  const weekEnd = new Date('2026-08-03T00:00:00');
  // YYYYMMDD 格式
  assert(W._exitsDateInWeek('20260731', weekStart, weekEnd) === true, 'YYYYMMDD 在窗内');
  assert(W._exitsDateInWeek('20260726', weekStart, weekEnd) === false, 'YYYYMMDD 在窗外 (前一天)');
  assert(W._exitsDateInWeek('20260803', weekStart, weekEnd) === false, 'YYYYMMDD 窗外 (下周一)');
  // YYYY-MM-DD 格式
  assert(W._exitsDateInWeek('2026-07-31', weekStart, weekEnd) === true, 'YYYY-MM-DD 在窗内');
  assert(W._exitsDateInWeek('2026-07-20', weekStart, weekEnd) === false, 'YYYY-MM-DD 窗外');
  // 非法
  assert(W._exitsDateInWeek('2026', weekStart, weekEnd) === false, '短字符串返回 false');
  assert(W._exitsDateInWeek('', weekStart, weekEnd) === false, '空字符串返回 false');
});

// ===== 情形 4: collectWeek 汇总 =====
describe('情形 4: collectWeek 汇总 (含决策/成交/错过)', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  // 注入样本: 本周决策 + 本周成交 + 本周错过
  const now = new Date('2026-07-31T12:00:00');   // Fri
  const win = W.weekWindowOf(now);
  sb._allTables.decision_traces = [
    { traceId: 't1', runId: 'r1', strategy: 'long', agentType: 'llmPickTop', code: '600519', sleeve: 'long', regime: 'bull', factor: 1.0, ts: win.sinceTs + 86400000 },
    { traceId: 't2', runId: 'r2', strategy: 'long', agentType: 'llmPickTop', code: '000001', sleeve: 'long', regime: 'bull', factor: 1.0, ts: win.sinceTs + 2 * 86400000 },
    { traceId: 't3', runId: 'r3', strategy: 'long', agentType: 'llmPickTop', code: '999999', sleeve: 'long', regime: 'range', factor: 0.7, ts: win.sinceTs + 100 }  // 也在窗内
  ];
  sb._allTables.trade_journal_ext = [
    { id: 1, code: '600519', sleeve: 'long', planPrice: 100, exitPrice: 110, pnl: 0.10, exitDate: '20260730', matched: true },
    { id: 2, code: '000001', sleeve: 'long', planPrice: 10, exitPrice: 9, pnl: -0.10, exitDate: '20260731', matched: true },
    { id: 3, code: '600519', sleeve: 'long', planPrice: 100, exitPrice: 115, pnl: 0.15, exitDate: '20260731', matched: true },  // 另一笔 600519 让 topGainer 显著 > 0
    { id: 4, code: '300750', sleeve: 'long', planPrice: 200, exitPrice: 220, pnl: 0.10, exitDate: '20260720', matched: false }   // 窗外
  ];
  sb._allTables.missed_opportunities = [
    { id: 1, code: 'a', sleeve: 'long', signalType: 'short_volatility_low', score: 0.5, notedAt: win.sinceTs + 86400000 }
  ];
  const week = await W.collectWeek('long', now);
  assert(week.weekId === '2026-W31', `weekId = ${week.weekId}`);
  assert(week.decisionCount === 3, `decisionCount=3 (${week.decisionCount})`);
  assert(week.exitCount === 3, `exitCount=3 (窗外那条剔除, ${week.exitCount})`);
  assert(week.missedCount === 1, `missedCount=1`);
  assert(week.winRate === +(2 / 3).toFixed(4), `胜率 2/3 ≈ 0.6667 (${week.winRate})`);
  assert(week.totalPnl === 0.15, `totalPnl = 0.10 + -0.10 + 0.15 = 0.15 (${week.totalPnl})`);
  assert(week.regimeAvg === 'bull', `regimeAvg = bull (2 次 vs 1 次 range)`);
  assert(week.factorAvg === 0.9, `factorAvg = (1+1+0.7)/3 ≈ 0.9 (${week.factorAvg})`);
  assert(week.topGainer && week.topGainer.code === '600519', `topGainer=600519 (${week.topGainer && week.topGainer.code})`);
  assert(week.topLoser && week.topLoser.code === '000001', 'topLoser=000001');
  assert(week.journalCount === 3, `journalCount=3 (matched=true 的)`);
  assert(week.tracesSample.length === 3, 'tracesSample 3 条');
  assert(week.exitsSample.length === 3, 'exitsSample 3 条');
});

// ===== 情形 5: _buildPrompt 输出 =====
describe('情形 5: _buildPrompt 包含关键数字', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  const now = new Date('2026-07-31T12:00:00');
  const win = W.weekWindowOf(now);
  const fakeWeek = {
    weekId: '2026-W31',
    sinceTs: win.sinceTs,
    untilTs: win.untilTs,
    strategy: 'long',
    decisionCount: 5,
    exitCount: 3,
    missedCount: 1,
    totalPnl: 0.1234,
    winRate: 0.67,
    regimeAvg: 'bull',
    factorAvg: 0.85,
    topGainer: { code: '600519', pnl: 0.05, count: 2 },
    topLoser: { code: '000001', pnl: -0.03, count: 1 },
    journalCount: 3,
    tracesSample: [{ ts: win.sinceTs + 86400000, code: '600519', agentType: 'llmPickTop', sleeve: 'long', factor: 1.0 }],
    exitsSample: [{ exitDate: '20260731', code: '600519', sleeve: 'long', pnl: 0.10 }],
    missedSample: [{ date: '20260730', code: 'a', signalType: 'short_x', score: 0.5 }]
  };
  const prompt = W._buildPrompt(fakeWeek);
  assert(prompt.includes('2026-W31'), '含 weekId');
  assert(prompt.includes('strategy=long'), '含 strategy');
  assert(prompt.includes('AI 决策: 5'), '含决策数');
  assert(prompt.includes('实际成交 (trade_journal_ext): 3'), '含成交数');
  assert(prompt.includes('0.1234'), '含 totalPnl');
  assert(prompt.includes('67.0%') || prompt.includes('67%'), '含胜率百分比');
  assert(prompt.includes('bull'), '含 regimeAvg');
  assert(prompt.includes('最大盈利: 600519'), '含 topGainer');
  assert(prompt.includes('最大亏损: 000001'), '含 topLoser');
  assert(prompt.includes('## AI 决策样本'), '含决策样本标题');
});

// ===== 情形 6: runOnce AI 不可用时降级 =====
describe('情形 6: runOnce 在 AI 不可用时仍落库', async () => {
  const sb = buildSandbox({ noAi: true });
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  const now = new Date('2026-07-31T12:00:00');
  const results = await W.runOnce(now, ['long']);
  assert(results.length === 1, '1 条结果');
  assert(results[0].strategy === 'long', 'strategy=long');
  assert(results[0].saved === true, 'saved=true');
  assert(results[0].summary.includes('AI 归因失败'), 'summary 含降级提示');
  assert(sb._allTables.weekly_attribution.length === 1, 'weekly_attribution 1 行');
  const row = sb._allTables.weekly_attribution[0];
  assert(row.weekId === '2026-W31:long', `主键 = ${row.weekId}`);
  assert(row.strategy === 'long', 'strategy 字段保留');
});

// ===== 情形 7: runOnce 跑 3 strategy =====
describe('情形 7: runOnce 默认跑 long + short + agents', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  const W = sb.window.Core.AI.WeeklyAttribution;
  const now = new Date('2026-07-31T12:00:00');
  const results = await W.runOnce(now);
  assert(results.length === 3, '3 条结果');
  const strategies = results.map(r => r.strategy).sort();
  assert(JSON.stringify(strategies) === JSON.stringify(['agents', 'long', 'short']), `strategies = ${strategies}`);
});

// ===== 情形 8: WeeklyReview._tick 周日/周一 =====
describe('情形 8: WeeklyReview._tick 触发条件', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  vm.runInContext(REVIEW_SRC, sb, { filename: 'weekly-review.js' });
  const R = sb.window.Core.AI.WeeklyReview;

  // _tick 内部调 Core.AI.WeeklyAttribution.runOnce, stub 那个
  let called = 0;
  const origWA = sb.window.Core.AI.WeeklyAttribution;
  sb.window.Core.AI.WeeklyAttribution = {
    runOnce: async () => { called++; return []; }
  };
  // 周日 22:00
  await R._tick(new Date('2026-07-26T22:00:00'));
  assert(called === 1, `周日 22:00 触发 (${called})`);
  // 周一 10:00
  await R._tick(new Date('2026-07-27T10:00:00'));
  assert(called === 2, `周一 10:00 触发 (${called})`);
  // 周三 10:00: 不触发
  await R._tick(new Date('2026-07-29T10:00:00'));
  assert(called === 2, `周三 10:00 不触发 (${called})`);
  // 周日 18:00 (21:00 前): 不触发
  await R._tick(new Date('2026-07-26T18:00:00'));
  assert(called === 2, `周日 18:00 不触发 (${called})`);
  sb.window.Core.AI.WeeklyAttribution = origWA;
});

// ===== 情形 9: WeeklyReview 每日防重复 =====
describe('情形 9: WeeklyReview 今日已跑过则跳过', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  vm.runInContext(REVIEW_SRC, sb, { filename: 'weekly-review.js' });
  const R = sb.window.Core.AI.WeeklyReview;
  let called = 0;
  sb.window.Core.AI.WeeklyAttribution = {
    runOnce: async () => { called++; return []; }
  };
  // 模拟今日已跑
  const today = new Date('2026-07-26T22:00:00').toISOString().slice(0, 10);
  sb._allTables.kv = { weekly_review_last_run: { date: today, ts: Date.now() } };
  await R._tick(new Date('2026-07-26T22:00:00'));
  assert(called === 0, '今日已跑过, _tick 跳过');
});

// ===== 情形 10: WeeklyReview.init 注册 Scheduler =====
describe('情形 10: WeeklyReview.init 注册到 Scheduler', async () => {
  const sb = buildSandbox();
  vm.runInContext(ATTR_SRC, sb, { filename: 'weekly-attribution.js' });
  vm.runInContext(REVIEW_SRC, sb, { filename: 'weekly-review.js' });
  const R = sb.window.Core.AI.WeeklyReview;
  await R.init();
  assert(sb._registered && sb._registered.includes('weekly-review'), '注册 weekly-review task');
});

// ===== 情形 11: 源码对账 =====
describe('情形 11: 源码对账', () => {
  assert(/weekIdOf\s*\(/.test(ATTR_SRC), 'WeeklyAttribution.weekIdOf');
  assert(/weekWindowOf\s*\(/.test(ATTR_SRC), 'WeeklyAttribution.weekWindowOf');
  assert(/collectWeek\s*\(/.test(ATTR_SRC), 'WeeklyAttribution.collectWeek');
  assert(/runOnce\s*\(/.test(ATTR_SRC), 'WeeklyAttribution.runOnce');
  assert(/_askAiForSummary/.test(ATTR_SRC), 'WeeklyAttribution._askAiForSummary (私有)');
  assert(/AI 归因失败/.test(ATTR_SRC), 'AI 失败降级文本');
  assert(/saveWeeklyAttribution/.test(ATTR_SRC), '调 saveWeeklyAttribution');

  assert(/init\s*\(/.test(REVIEW_SRC), 'WeeklyReview.init');
  assert(/runNow\s*\(/.test(REVIEW_SRC), 'WeeklyReview.runNow');
  assert(/Core.Scheduler.register/.test(REVIEW_SRC), 'WeeklyReview 注册到 Scheduler');
  assert(/weekly-review/.test(REVIEW_SRC), 'task 名 weekly-review');
  assert(/_isSunday|_isMonday/.test(REVIEW_SRC), '周日/周一判定');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V7 WeeklyAttribution + WeeklyReview: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();