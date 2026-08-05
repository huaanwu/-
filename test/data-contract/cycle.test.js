/**
 * Core.Cycle 单测 — P2 (宏观周期定位)
 *
 * 覆盖:
 *   1. 5 维信号打分 (边界: -5/0/+5)
 *   2. 阶段判定 (defensive / stalemate_bear / stalemate_bull / offensive)
 *   3. 降级契约: 信号全失 → stage='unknown' + confidence='none'
 *   4. 降级契约: 部分失 → confidence='low'/'medium'
 *   5. getCyclePosition 整合 (mock Data/KB/MarketWidth)
 *   6. formatForPrompt 模板正确
 *
 * 跑法: node test/data-contract/cycle.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'cycle.js'), 'utf8');

function makeSandbox(opts = {}) {
  const sandbox = {
    window: {},
    console: console
  };
  // 模拟 Core (cycle.js 是 IIFE, 直接读 window.Core)
  const cacheStore = {};
  sandbox.window.Core = {
    State: { get: () => 'default' },
    Storage: {
      cacheGet: async (k) => cacheStore[k] || null,
      cacheSet: async (k, v) => { cacheStore[k] = v; }
    },
    Data: {
      fetch: opts.fetch || (async () => null),
      Normalize: {
        parseMoneySupply: opts.parseMoneySupply || ((d) => {
          if (!Array.isArray(d) || !d.length) return null;
          const r = d[0];
          const m2 = parseFloat(r['货币和准货币(M2)-同比增长']);
          const m1 = parseFloat(r['货币(M1)-同比增长']);
          if (isNaN(m2)) return null;
          return {
            date: r['月份'] || '',
            m2_yoy: m2,
            m1_yoy: isNaN(m1) ? null : m1,
            m0_yoy: null
          };
        })
      }
    },
    KB: {
      get: opts.kbGet || (async () => [
        { id: 'CYC-007', category: 'cycle', title: '当前周期定位', summary: '周金涛框架 2024-2026 是结构性机会窗口' },
        { id: 'MAO-001', category: 'rule', title: '矛盾论', summary: '主要矛盾决定其他矛盾' },
        { id: 'HIS-006', category: 'history_analog', title: '当前剧本', summary: '2024-2026' },
        { id: 'MAC-001', category: 'macro_signal', title: 'M1-M2 剪刀差', summary: '正数=资金活化' }
      ])
    },
    MarketWidth: opts.marketWidth || { get: async () => null }
  };
  vm.createContext(sandbox);
  return sandbox;
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ============================================================
// 情形 1: 5 维信号打分边界 (Stage 判定)
// ============================================================
describe('情形 1: _stageFromScore 阶段判定', () => {
  // 直接调 _stageFromScore, 因为这是纯函数
  const sandbox = makeSandbox();
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const { _stageFromScore, _scoreSignals } = sandbox.window.Core.Cycle;

  assert(_stageFromScore(5) === 'offensive', 'score=5 → offensive');
  assert(_stageFromScore(3) === 'offensive', 'score=3 → offensive');
  assert(_stageFromScore(2) === 'stalemate_bull', 'score=2 → stalemate_bull');
  assert(_stageFromScore(1) === 'stalemate_bull', 'score=1 → stalemate_bull');
  assert(_stageFromScore(0) === 'stalemate_bear', 'score=0 → stalemate_bear');
  assert(_stageFromScore(-1) === 'stalemate_bear', 'score=-1 → stalemate_bear');
  assert(_stageFromScore(-2) === 'defensive', 'score=-2 → defensive');
  assert(_stageFromScore(-5) === 'defensive', 'score=-5 → defensive');
});

// ============================================================
// 情形 2: _scoreSignals 5 维打分
// ============================================================
describe('情形 2: _scoreSignals 5 维打分', () => {
  const sandbox = makeSandbox();
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const { _scoreSignals } = sandbox.window.Core.Cycle;

  // 全正向: m1m2>0, shrz>12, pmi>52, yieldVal<2.5, width>70 → +5
  let r = _scoreSignals({ m1m2: 1, shrz: 13, pmi: 53, yieldVal: 2.3, width: 75 });
  assert(r.score === 5, '全最强信号 → +5');
  assert(r.n === 5, '5 项可用');

  // 全负向 → -5
  r = _scoreSignals({ m1m2: -3, shrz: 7, pmi: 47, yieldVal: 3.6, width: 25 });
  assert(r.score === -5, '全最弱信号 → -5');

  // 中性 (剪刀差 0~−2 不计分) → 0
  r = _scoreSignals({ m1m2: -1, shrz: 10, pmi: 50, yieldVal: 3.0, width: 50 });
  assert(r.score === 0, '中性 5 维 → 0');

  // 部分缺失 (n=3): m1m2/pmi/width → +3
  r = _scoreSignals({ m1m2: 1, shrz: null, pmi: 53, yieldVal: null, width: 75 });
  assert(r.score === 3, '3 项可用 → +3');
  assert(r.n === 3, 'n=3 正确');
});

// ============================================================
// 情形 3: getCyclePosition — 全数据可用场景
// ============================================================
describe('情形 3: getCyclePosition 全数据可用', () => {
  const sandbox = makeSandbox({
    fetch: async (key, path) => {
      if (path === 'macro_china_money_supply') {
        return [{ '月份': '2026年06月份', '货币和准货币(M2)-同比增长': 8.0, '货币(M1)-同比增长': 4.0 }];
      }
      if (path === 'macro_china_shrzgm') {
        // 升序, 末条最新
        return [
          { '月份': '202504', '社会融资规模增量': 7000 },
          { '月份': '202505', '社会融资规模增量': 8500 },
          { '月份': '202604', '社会融资规模增量': 6245 }
        ];
      }
      if (path === 'macro_china_pmi_yearly') {
        return [{ '日期': '2025-08-31', '今值': 49.4 }];
      }
      if (path === 'macro_china_shibor_all') {
        return [{ '日期': '2026-07-29', '1Y-定价': 2.7 }];
      }
      return null;
    },
    marketWidth: { get: async () => ({ breadth: 65 }) }
  });
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const Cycle = sandbox.window.Core.Cycle;

  return Cycle.getCyclePosition().then(p => {
    assert(p._ok === true, '_ok=true (5 维全可用)');
    assert(p.confidence === 'high', 'confidence=high (5 项可用)');
    // 实际打分: m1m2=4-8=-4 (<-2 → -1); shrz=6245(8-12 中性 0); pmi=49.4(<48 不成立 → 0); yield=2.7(2.5-3.5 中性 0); width=65(<70 不成立 → 0) = -1
    assert(p.threeStage === 'stalemate_bear', '当前 -1 → stalemate_bear');
    assert(p.macroScore === -1, 'macroScore = -1');
    assert(p.signals.m1m2 === -4, 'M1-M2 剪刀差 -4 (P0 修复正确)');
    assert(p.signals.shrz === 6245, 'shrz 取末条 (升序接口)');
    assert(p.signals.pmi === 49.4, 'PMI 取首条 (降序接口, 跳过 null 行)');
    assert(p.signals.yieldVal === 2.7, 'Shibor 1Y = 2.7');
    assert(p.signals.width === 65, '市场宽度 = 65');
    assert(p.kbText.includes('周金涛'), 'kbText 包含 KB 周期条目');
    assert(p.kbText.includes('M1-M2 剪刀差'), 'kbText 包含 MAC-001');
  });
});

// ============================================================
// 情形 4: 降级 — 全数据失败 → stage='unknown'
// ============================================================
describe('情形 4: 降级 — 全数据失败 → stage=unknown', () => {
  const sandbox = makeSandbox({
    fetch: async () => null,  // 全部失败
    marketWidth: { get: async () => null }
  });
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const Cycle = sandbox.window.Core.Cycle;

  return Cycle.getCyclePosition().then(p => {
    assert(p._ok === false, '_ok=false');
    assert(p.confidence === 'none', 'confidence=none');
    assert(p.threeStage === 'unknown', 'stage=unknown');
    assert(p.macroScore === 0, 'macroScore=0');
    assert(p.reasoning.includes('不可用'), 'reasoning 标注「不可用」');
    assert(p.kbText.length > 0, 'kbText 仍输出 (KB 静态定义)');
  });
});

// ============================================================
// 情形 5: 降级 — 部分失败
// ============================================================
describe('情形 5: 降级 — 部分失败 (n=2)', () => {
  const sandbox = makeSandbox({
    fetch: async (key, path) => {
      if (path === 'macro_china_money_supply') {
        return [{ '月份': '2026-06', '货币和准货币(M2)-同比增长': 8.0, '货币(M1)-同比增长': 4.0 }];
      }
      // 其他全失败
      return null;
    },
    marketWidth: { get: async () => null }
  });
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const Cycle = sandbox.window.Core.Cycle;

  return Cycle.getCyclePosition().then(p => {
    assert(p._ok === true, '_ok=true (部分可用)');
    assert(p.confidence === 'low', 'confidence=low (仅 1 项可用)');
    assert(p.threeStage === 'stalemate_bear', 'stage=stalemate_bear (1 项 -1 分)');
  });
});

// ============================================================
// 情形 6: formatForPrompt 模板
// ============================================================
describe('情形 6: formatForPrompt 模板正确', () => {
  const sandbox = makeSandbox();
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const { formatForPrompt } = sandbox.window.Core.Cycle;

  const fakePos = {
    _generatedAt: Date.now(),
    threeStage: 'stalemate_bull',
    confidence: 'high',
    macroScore: 2,
    signals: { m1m2: 1.5, shrz: 13, pmi: 53, yieldVal: 2.3, width: 75 },
    dates: { m1m2: '2026-06', shrz: '202604', pmi: '2025-08-31', yield: '2026-07-29' },
    kbText: '### KB\n- CYC-007 周金涛'
  };
  const txt = formatForPrompt(fakePos);
  assert(txt.includes('## 宏观周期定位'), 'header');
  assert(txt.includes('战略相持偏多'), '阶段名');
  assert(txt.includes('50-70%'), '仓位建议');
  assert(txt.includes('板块轮动'), '战术要点');
  assert(txt.includes('high'), '置信度');
  assert(txt.includes('+2'), '分数');
  assert(txt.includes('M1-M2 剪刀差 = 1.5'), '信号明细');
  assert(txt.includes('### KB'), 'KB 文本');

  const unknownTxt = formatForPrompt({
    threeStage: 'unknown',
    confidence: 'none',
    macroScore: 0,
    signals: {},
    dates: {},
    kbText: '### KB',
    _generatedAt: Date.now()
  });
  assert(unknownTxt.includes('不可用'), 'unknown 模板标注「不可用」');
  assert(!unknownTxt.includes('建议仓位'), 'unknown 模板不输出仓位建议');
});

// ============================================================
// 情形 7: KB 缓存 (第二次调直接命中)
// ============================================================
describe('情形 7: KB 缓存生效', () => {
  let fetchCount = 0;
  const sandbox = makeSandbox({
    fetch: async (key, path) => {
      fetchCount++;
      if (path === 'macro_china_money_supply') return [{ '月份': '2026-06', '货币和准货币(M2)-同比增长': 8, '货币(M1)-同比增长': 4 }];
      return null;
    },
    marketWidth: { get: async () => null }
  });
  vm.runInContext(SRC, sandbox, { filename: 'cycle.js' });
  const Cycle = sandbox.window.Core.Cycle;

  return Cycle.getCyclePosition()
    .then(p1 => Cycle.getCyclePosition().then(p2 => {
      assert(fetchCount <= 5, '第二次调不应再次 fetch (缓存命中, 实际 fetch 数 ≤ 5)');
      assert(p2.threeStage === p1.threeStage, '两次结果一致');
    }));
});

console.log('\n' + '='.repeat(50));
console.log(`Core.Cycle: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);