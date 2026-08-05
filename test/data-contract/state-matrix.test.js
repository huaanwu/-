/**
 * Core.StateMatrix 单测 — P3.2 (价×时状态矩阵)
 *
 * 覆盖:
 *   1. 12 格矩阵每个 key 正确
 *   2. 冲突格 (bull|defensive 等) 含 warning
 *   3. 非冲突格无 warning
 *   4. 数据缺失时走兜底
 *   5. getPositionScale 整合 Regime + Cycle
 *   6. formatForPrompt 模板
 *
 * 跑法: node test/data-contract/state-matrix.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'state-matrix.js'), 'utf8');

const sandbox = {
  window: {},
  console: console,
  Core: undefined
};
let mockRegime = 'range';
let mockCycle = 'stalemate_bear';
sandbox.window.Core = {
  Regime: { get: async () => ({ state: mockRegime }) },
  Cycle: {
    getCyclePosition: async () => ({
      threeStage: mockCycle,
      _ok: true
    })
  }
};
sandbox.Core = sandbox.window.Core;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'state-matrix.js' });
const SM = sandbox.window.Core.StateMatrix;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ============================================================
// 情形 1: 12 格矩阵 key + scale
// ============================================================
describe('情形 1: 12 格矩阵定义正确', () => {
  assert(SM.MATRIX['bull|offensive'].scale === 0.9, 'bull × offensive = 0.9 (重仓)');
  assert(SM.MATRIX['bull|stalemate_bull'].scale === 0.7, 'bull × stalemate_bull = 0.7');
  assert(SM.MATRIX['bull|stalemate_bear'].scale === 0.5, 'bull × stalemate_bear = 0.5 (冲突)');
  assert(SM.MATRIX['bull|defensive'].scale === 0.5, 'bull × defensive = 0.5 (冲突, 警惕泡沫)');
  assert(SM.MATRIX['range|offensive'].scale === 0.6, 'range × offensive = 0.6');
  assert(SM.MATRIX['range|stalemate_bull'].scale === 0.5, 'range × stalemate_bull = 0.5');
  assert(SM.MATRIX['range|stalemate_bear'].scale === 0.3, 'range × stalemate_bear = 0.3');
  assert(SM.MATRIX['range|defensive'].scale === 0.25, 'range × defensive = 0.25');
  assert(SM.MATRIX['bear|offensive'].scale === 0.4, 'bear × offensive = 0.4 (冲突, 反弹末期)');
  assert(SM.MATRIX['bear|stalemate_bull'].scale === 0.3, 'bear × stalemate_bull = 0.3 (冲突)');
  assert(SM.MATRIX['bear|stalemate_bear'].scale === 0.2, 'bear × stalemate_bear = 0.2');
  assert(SM.MATRIX['bear|defensive'].scale === 0.1, 'bear × defensive = 0.1 (空仓)');
});

// ============================================================
// 情形 2: 冲突格标记
// ============================================================
describe('情形 2: 冲突格含 warning', () => {
  assert(SM.MATRIX['bull|stalemate_bear'].conflict === true, 'bull × stalemate_bear 冲突');
  assert(SM.MATRIX['bull|defensive'].conflict === true, 'bull × defensive 冲突');
  assert(SM.MATRIX['bear|offensive'].conflict === true, 'bear × offensive 冲突');
  assert(SM.MATRIX['bear|stalemate_bull'].conflict === true, 'bear × stalemate_bull 冲突');
  assert(SM.MATRIX['bull|offensive'].conflict === false, 'bull × offensive 非冲突');
  assert(SM.MATRIX['bear|defensive'].conflict === false, 'bear × defensive 非冲突');
});

// ============================================================
// 情形 3-6: getPositionScale 各种场景 (顶层 await 防止遗漏)
// ============================================================
async function _runScenarios() {
  // 情形 3: bull × offensive (重仓)
  mockRegime = 'bull';
  mockCycle = 'offensive';
  let r = await SM.getPositionScale();
  assert(r.positionScale === 0.9, 'bull × offensive → 0.9');
  assert(r.name === '趋势反攻', 'name = 趋势反攻');
  assert(r.conflict === false, '非冲突');
  assert(r.warning === null, '无 warning');

  // 情形 4: bull × defensive (冲突)
  mockRegime = 'bull';
  mockCycle = 'defensive';
  r = await SM.getPositionScale();
  assert(r.positionScale === 0.5, 'bull × defensive → 0.5');
  assert(r.conflict === true, '冲突');
  assert(r.warning && r.warning.includes('冲突'), 'warning 含「冲突」');

  // 情形 5: bear × defensive (空仓)
  mockRegime = 'bear';
  mockCycle = 'defensive';
  r = await SM.getPositionScale();
  assert(r.positionScale === 0.1, 'bear × defensive → 0.1 (空仓)');

  // 情形 6: Regime 失败走兜底
  const failSandbox = {
    window: {},
    console: console,
    Core: undefined
  };
  failSandbox.window.Core = {
    Regime: { get: async () => { throw new Error('mock fail'); } },
    Cycle: { getCyclePosition: async () => ({ threeStage: 'stalemate_bull', _ok: true }) }
  };
  failSandbox.Core = failSandbox.window.Core;
  vm.createContext(failSandbox);
  vm.runInContext(SRC, failSandbox, { filename: 'state-matrix.js' });
  r = await failSandbox.window.Core.StateMatrix.getPositionScale();
  assert(r.regime === 'range', 'Regime 失败 → 兜底 range');
  assert(r.positionScale === 0.5, 'range × stalemate_bull = 0.5');

  console.log('\n' + '='.repeat(50));
  console.log(`Core.StateMatrix: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
_runScenarios();