/**
 * V5 — ShortTrader._recordDecisionTrace + _recordMissedOpportunity 单元测试
 *
 * 覆盖:
 *   1. _recordDecisionTrace 写 decision_traces (runId + phase + decision)
 *   2. agentType 自动拼 'phase_'+phase
 *   3. factor 从 PolicyBundle._factorFor('short', regime) 拿
 *   4. Core.Storage 缺失时静默吞错
 *   5. _recordMissedOpportunity 只写 ok=false 的票
 *   6. signalType 拼 'short_'+signal
 *   7. plans 空数组静默跳过
 *   8. plan 非对象时静默吞错
 *   9. source code 集成 (源码对账)
 *
 * 跑法: node test/orchestration/short-trader-trace.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SHORT_SRC = fs.readFileSync(path.join(ROOT, 'www', 'app', 'short-trader.js'), 'utf8');

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
  const traces = [];
  const missed = [];
  sb.Core = {
    Storage: {
      addDecisionTrace: opts.noStorage ? undefined : async (t) => { traces.push(t); return t.traceId; },
      addMissedOpportunity: opts.noStorage ? undefined : async (m) => { missed.push(m); return missed.length; },
      kvGet: async () => null,
      kvSet: async () => {}
    },
    Regime: {
      gateMultipliers: () => ({ state: opts.regime || 'range', label: '震荡', positionScale: 0.6 })
    },
    PolicyBundle: {
      _factorFor: (sleeve, state) => {
        const t = { long:{bull:1,range:0.7,bear:0.3}, short:{bull:0.8,range:0.6,bear:0} };
        const v = t[sleeve] && t[sleeve][state];
        return typeof v === 'number' ? v : 0.6;
      }
    },
    Constants: {},
    Paper: {},
    Scheduler: { register: () => () => {} },
    Data: {}
  };
  vm.createContext(sb);
  vm.runInContext(SHORT_SRC, sb, { filename: 'short-trader.js' });
  return { sb, traces, missed };
}

// ===== 情形 1: _recordDecisionTrace 落库 =====
describe('情形 1: _recordDecisionTrace 写 decision_traces', async () => {
  const { sb, traces } = buildSandbox();
  const ST = sb.window.ShortTrader;
  assert(typeof ST._recordDecisionTrace === 'function', '_recordDecisionTrace 暴露');

  await ST._recordDecisionTrace({
    runId: 'short-morning-12345-abc',
    phase: 'morning',
    decision: { action: 'plan', reason: '波动率高', source: 'ai' },
    ts: 1000
  });
  assert(traces.length === 1, `1 条 trace 写入 (实际 ${traces.length})`);
  const t = traces[0];
  assert(t.traceId === 'short-morning-12345-abc:short', `traceId = runId:short (${t.traceId})`);
  assert(t.runId === 'short-morning-12345-abc', 'runId 保留');
  assert(t.strategy === 'short', 'strategy=short');
  assert(t.agentType === 'phase_morning', `agentType=phase_morning (${t.agentType})`);
  assert(t.code === 'plan', `code=action (${t.code})`);
  assert(t.sleeve === 'short', 'sleeve=short');
  assert(t.regime === 'range', 'regime 从 Core.Regime 拿');
  assert(t.factor === 0.6, 'factor 从 PolicyBundle._factorFor(short, range) = 0.6');
  assert(t.payload.phase === 'morning', 'payload.phase 保留');
  assert(t.payload.action === 'plan', 'payload.action 保留');
  assert(t.payload.reason === '波动率高', 'payload.reason 保留');
  assert(t.payload.source === 'ai', 'payload.source 保留');
});

// ===== 情形 2: agentType 自动拼 =====
describe('情形 2: agentType = "phase_<phase>"', async () => {
  const { sb, traces } = buildSandbox();
  const ST = sb.window.ShortTrader;
  await ST._recordDecisionTrace({ runId: 'r1', phase: 'midday', decision: { action: 'review' } });
  await ST._recordDecisionTrace({ runId: 'r2', phase: 'close', decision: { action: 'report' } });
  await ST._recordDecisionTrace({ runId: 'r3', phase: 'morning', decision: { action: 'skip' } });
  assert(traces[0].agentType === 'phase_midday', 'midday → phase_midday');
  assert(traces[1].agentType === 'phase_close', 'close → phase_close');
  assert(traces[2].agentType === 'phase_morning', 'morning → phase_morning');
});

// ===== 情形 3: factor 从 regime 自动取 =====
describe('情形 3: factor 跟 regime 联动 (PolicyBundle)', async () => {
  // bull: factor=0.8
  const { sb, traces } = buildSandbox({ regime: 'bull' });
  const ST = sb.window.ShortTrader;
  await ST._recordDecisionTrace({ runId: 'r1', phase: 'morning', decision: { action: 'plan' } });
  assert(traces[0].factor === 0.8, 'short × bull factor = 0.8');

  // bear: factor=0
  const { sb: sb2, traces: traces2 } = buildSandbox({ regime: 'bear' });
  const ST2 = sb2.window.ShortTrader;
  await ST2._recordDecisionTrace({ runId: 'r2', phase: 'morning', decision: { action: 'plan' } });
  assert(traces2[0].factor === 0, 'short × bear factor = 0 (熊市不开仓)');
});

// ===== 情形 4: Core.Storage 缺失 =====
describe('情形 4: Core.Storage 缺失时静默吞错', async () => {
  const { sb } = buildSandbox({ noStorage: true });
  const ST = sb.window.ShortTrader;
  let threw = false;
  try {
    await ST._recordDecisionTrace({ runId: 'r1', phase: 'morning', decision: { action: 'plan' } });
  } catch (e) { threw = true; }
  assert(!threw, 'Core.Storage 缺失不抛错');
});

// ===== 情形 5: _recordMissedOpportunity 只写 ok=false =====
describe('情形 5: _recordMissedOpportunity 只记 ok=false 的票', async () => {
  const { sb, missed } = buildSandbox();
  const ST = sb.window.ShortTrader;
  assert(typeof ST._recordMissedOpportunity === 'function', '_recordMissedOpportunity 暴露');

  await ST._recordMissedOpportunity({
    date: '2026-07-31',
    plans: [
      { code: 'a', ok: true },
      { code: 'b', ok: false, signal: 'volatility_low', score: 0.5, reason: '波动率不够' },
      { code: 'c', ok: false, signal: 'cash_short', score: 0.7, error: '现金不够' },
      { ok: false },  // 没 code, 跳过
      { code: 'd', ok: true }
    ]
  });
  assert(missed.length === 2, `2 条 missed (b + c, 实际 ${missed.length})`);
  assert(missed[0].code === 'b', 'b 在前');
  assert(missed[0].signalType === 'short_volatility_low', 'signalType=short_volatility_low');
  assert(missed[0].sleeve === 'short', 'sleeve=short');
  assert(missed[0].score === 0.5, 'score 保留');
  assert(missed[0].context.reason === '波动率不够', 'context.reason 保留');
  assert(missed[1].code === 'c' && missed[1].signalType === 'short_cash_short', 'c → short_cash_short');
});

// ===== 情形 6: plans 为空数组 =====
describe('情形 6: plans 空数组不写任何行', async () => {
  const { sb, missed } = buildSandbox();
  const ST = sb.window.ShortTrader;
  await ST._recordMissedOpportunity({ date: '2026-07-31', plans: [] });
  assert(missed.length === 0, '空 plans → 0 行');
});

// ===== 情形 7: plan 非对象 =====
describe('情形 7: plan=null / plan=undefined 静默吞错', async () => {
  const { sb, missed } = buildSandbox();
  const ST = sb.window.ShortTrader;
  let threw1 = false;
  try { await ST._recordMissedOpportunity(null); } catch (e) { threw1 = true; }
  let threw2 = false;
  try { await ST._recordMissedOpportunity(undefined); } catch (e) { threw2 = true; }
  let threw3 = false;
  try { await ST._recordMissedOpportunity({ plans: 'not array' }); } catch (e) { threw3 = true; }
  assert(!threw1 && !threw2 && !threw3, 'null/undefined/非数组都不抛');
  assert(missed.length === 0, '3 次调用 0 行');
});

// ===== 情形 8: 源码对账 =====
describe('情形 8: short-trader.js 源码对账', () => {
  const src = SHORT_SRC;
  assert(/_recordDecisionTrace\s*\(/.test(src), '_recordDecisionTrace 函数定义');
  assert(/_recordMissedOpportunity\s*\(/.test(src), '_recordMissedOpportunity 函数定义');
  // _runPhase 函数体内 (从 async _runPhase 到下一个方法定义) 包含 _recordDecisionTrace
  const runPhaseMatch = src.match(/async _runPhase[\s\S]*?(?=\n    (?:async |\* )?\w)/);
  const runPhaseBody = runPhaseMatch ? runPhaseMatch[0] : '';
  assert(/_recordDecisionTrace/.test(runPhaseBody), '_runPhase 函数体内调 _recordDecisionTrace');
  // maybeGeneratePlan 函数体内包含 _recordMissedOpportunity 调用上下文
  const missedCtxMatch = src.match(/maybeGeneratePlan[\s\S]{0,500}_recordMissedOpportunity/);
  assert(!!missedCtxMatch, 'maybeGeneratePlan 后调 _recordMissedOpportunity');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`V5 ShortTrader trace: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();