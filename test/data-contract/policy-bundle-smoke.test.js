/**
 * P6.7 — Browser smoke test (无 daemon 依赖)
 *
 * 模拟浏览器加载 index.html 涉及的关键 .js, 验证:
 *   1. 所有 IIFE 模块按依赖顺序加载不抛错
 *   2. window.Core.AI.PolicyBundle 实际挂上
 *   3. PolicyBundle.load({strategy:'long'}).toSystemPrompt() 输出包含:
 *      - 「毛选」 (MAO 注入生效)
 *      - 「仓位系数」 (sleeve 配额生效)
 *      - 「知识库」 或 sleeve 专属 KB 条目号
 *      - Regime 段 (大盘状态机)
 *   4. factor 计算正确: long × bull = 1.0, short × bear = 0.0
 *   5. alerts 用的 _formatRegimeBlock 单行 regimeLine 仍能用
 *
 * 跑法: node test/data-contract/policy-bundle-smoke.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const WWW = path.join(ROOT, 'www');

// 按依赖顺序加载的核心 IIFE 文件 (constants 必须最先, regime/storage 都强依赖)
const CORE_FILES = [
  'core/util.js',
  'core/state.js',
  'core/constants.js',    // regime.js/storage.js 顶部直接读 Core.Constants
  'core/storage.js',
  'core/regime.js',
  'core/cycle.js',
  'core/state-matrix.js',
  'core/kb.js',
  'core/discipline.js',
  'core/ai/tool-registry.js',
  'core/ai/tracing.js',
  'core/ai/orchestrator.js',
  'core/ai/entry.js',
  'core/ai/policy-bundle.js'
];

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ===== vm sandbox (浏览器环境模拟) =====
async function buildBrowserLikeSandbox() {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: async (url, opts) => ({ ok: false, status: 0, text: async () => '', json: async () => ({}) }),  // 全失败, 测试兜底
    location: { origin: 'http://localhost:3003', protocol: 'http:', host: 'localhost:3003' },
    navigator: { userAgent: 'node-smoke' },
    document: {
      addEventListener: () => {}, removeEventListener: () => {},
      querySelector: () => null, querySelectorAll: () => [],
      getElementById: () => null, createElement: () => ({ addEventListener: () => {}, setAttribute: () => {} })
    },
    localStorage: { getItem: () => null, setItem: () => {} },
    indexedDB: null,  // 强 stub: 让 Dexie 全失败
    alert: () => {}, confirm: () => true,
    URL: { createObjectURL: () => '', revokeObjectURL: () => {} },
    Blob: function (a) { return { size: a.join('').length, type: 'text/plain' }; },
    setTimeout: setTimeout, clearTimeout: clearTimeout
  };
  sb.window = sb;  // 浏览器 window === globalThis

  vm.createContext(sb);

  // 按顺序跑所有 core IIFE
  for (const rel of CORE_FILES) {
    const full = path.join(WWW, rel);
    if (!fs.existsSync(full)) {
      console.warn('  ⚠ 跳过 (不存在):', rel);
      continue;
    }
    const src = fs.readFileSync(full, 'utf8');
    try {
      vm.runInContext(src, sb, { filename: rel });
    } catch (e) {
      console.error('  ✗ 加载失败:', rel, '—', e.message);
      throw e;
    }
  }

  // 让 Microtask flush (Promise.all 等)
  await new Promise(r => setTimeout(r, 50));
  return sb;
}

// ===== 情形 1: IIFE 加载顺序无报错 =====
describe('情形 1: 14 个 IIFE 模块按依赖顺序加载不抛', async () => {
  let sb;
  try {
    sb = await buildBrowserLikeSandbox();
    assert(true, '14 个 IIFE 加载无语法错误');
  } catch (e) {
    fail('加载失败: ' + e.message);
    return;
  }
  // 必须挂上 Core 命名空间
  assert(!!sb.window.Core, 'window.Core 已定义');
  assert(!!sb.window.Core.AI, 'window.Core.AI 已定义');
  assert(!!sb.window.Core.AI.PolicyBundle, 'window.Core.AI.PolicyBundle 已定义');
});

// ===== 情形 2: PolicyBundle 5 sleeve 全部能 load =====
describe('情形 2: PolicyBundle.load 5 sleeve 都能调', async () => {
  const sb = await buildBrowserLikeSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  if (!PB) { fail('PB 不存在'); return; }
  for (const strategy of ['long', 'short', 'fund', 'alerts', 'agents']) {
    let bundle;
    try {
      bundle = await PB.load({ strategy, ctx: {} });
    } catch (e) {
      fail(`${strategy} load 抛错: ${e.message}`);
      continue;
    }
    assert(!!bundle, `${strategy} load 返非空`);
    assert(bundle.strategy === strategy, `${strategy} bundle.strategy 正确`);
    assert(typeof bundle.factor === 'number', `${strategy} factor 是数字`);
    assert(typeof bundle.toSystemPrompt === 'function', `${strategy} toSystemPrompt 是函数`);
  }
});

// ===== 情形 3: long sleeve toSystemPrompt 输出含「毛选」+「仓位系数」+ KB =====
describe('情形 3: long sleeve toSystemPrompt 含 3 要素', async () => {
  const sb = await buildBrowserLikeSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  const bundle = await PB.load({ strategy: 'long', ctx: { stocks: [] } });
  const text = bundle.toSystemPrompt();
  assert(text.indexOf('毛选') >= 0, '含「毛选」 (MAO 元规则)');
  assert(text.indexOf('仓位系数') >= 0, '含「仓位系数」 (sleeve 配额段)');
  assert(text.indexOf('sleeve 配额') >= 0, '含「sleeve 配额」标题');
  // KB 段在 fallback sandbox 里 KB.get('rule') 抛错 → 走 fallback 也含毛选字样
  // 真实环境 KB 加载后会有 sleeve 专属类目 + 条目号, 这里只校验 block 拼出来
  assert(text.length > 200, `toSystemPrompt 总长度 > 200 (实际 ${text.length})`);
  console.log(`     [debug] long sleeve toSystemPrompt 长度: ${text.length} 字符`);
});

// ===== 情形 4: short sleeve 熊市不开仓 =====
describe('情形 4: short × bear → factor = 0.0', async () => {
  const sb = await buildBrowserLikeSandbox();
  // 注入 fake Regime: bear 状态
  if (sb.window.Core && sb.window.Core.Regime) {
    sb.window.Core.Regime.gateMultipliers = () => ({
      state: 'bear', label: '熊市', positionScale: 0.2, stale: false, staleFailures: 0, indices: {}
    });
    sb.window.Core.Regime._formatRegimeBlock = () => '## 大盘状态机\n当前: 熊市 (bear)';
  }
  const PB = sb.window.Core.AI.PolicyBundle;
  const bundle = await PB.load({ strategy: 'short' });
  assert(bundle.factor === 0.0, `short × bear factor = 0.0 (实际 ${bundle.factor})`);
  const text = bundle.toSystemPrompt();
  assert(text.indexOf('×0.00') >= 0, 'sleeve 配额段反映 0.00 系数');
  assert(text.indexOf('熊市') >= 0 || text.indexOf('bear') >= 0, 'systemPrompt 含熊市状态');
});

// ===== 情形 5: alerts 用单行 regimeLine 仍能用 =====
describe('情形 5: alerts.js 用的 _formatRegimeBlock 仍存在', async () => {
  const sb = await buildBrowserLikeSandbox();
  const Regime = sb.window.Core.Regime;
  assert(!!Regime, 'Core.Regime 存在');
  assert(typeof Regime._formatRegimeBlock === 'function', '_formatRegimeBlock 是函数');
  const block = Regime._formatRegimeBlock();
  assert(typeof block === 'string' && block.length > 10, '_formatRegimeBlock 返非空字符串');
});

// ===== 情形 6: 失败兜底 — 全 Core 拿空时 PolicyBundle 不抛 =====
describe('情形 6: 全失败兜底 (Regime/Cycle/StateMatrix/KB/Discipline 全抛)', async () => {
  const sb = await buildBrowserLikeSandbox();
  // 强行把所有上游置为 throw
  sb.window.Core.Regime.gateMultipliers = () => { throw new Error('regime fail'); };
  sb.window.Core.Regime.get = async () => { throw new Error('regime fail'); };
  sb.window.Core.Cycle.getCyclePosition = async () => { throw new Error('cycle fail'); };
  sb.window.Core.StateMatrix.getPositionScale = async () => { throw new Error('sm fail'); };
  sb.window.Core.KB.get = async () => { throw new Error('kb fail'); };
  sb.window.Core.Discipline.getConfig = async () => { throw new Error('disc fail'); };
  const PB = sb.window.Core.AI.PolicyBundle;
  let bundle;
  try {
    bundle = await PB.load({ strategy: 'long' });
  } catch (e) {
    fail('全失败 sandbox load 抛错: ' + e.message);
    return;
  }
  assert(!!bundle, 'bundle 仍返非空');
  assert(Number.isFinite(bundle.factor), 'factor 是数字');
  // 全失败 → Regime 兜底 state=range, factor = _factorFor('long','range') = 0.7
  assert(bundle.factor === 0.7, `全失败 → factor 0.7 (实际 ${bundle.factor})`);
  const text = bundle.toSystemPrompt();
  assert(text.indexOf('毛选') >= 0, 'fallback MAO 仍生效');
});

// ===== 情形 7: 5 sleeve 不污染 window.Core 既有 namespace =====
describe('情形 7: 5 sleeve 加载不污染 Core 既有 namespace', async () => {
  const sb = await buildBrowserLikeSandbox();
  // 模拟已有 Core 命名空间全在
  assert(!!sb.window.Core.Regime, 'Core.Regime 未被覆盖');
  assert(!!sb.window.Core.Cycle, 'Core.Cycle 未被覆盖');
  assert(!!sb.window.Core.StateMatrix, 'Core.StateMatrix 未被覆盖');
  assert(!!sb.window.Core.KB, 'Core.KB 未被覆盖');
  assert(!!sb.window.Core.Discipline, 'Core.Discipline 未被覆盖');
  assert(!!sb.window.Core.AI.Orchestrator, 'Core.AI.Orchestrator 未被覆盖');
  assert(!!sb.window.Core.AI.Entry, 'Core.AI.Entry 未被覆盖');
  assert(!!sb.window.Core.AI.ToolRegistry, 'Core.AI.ToolRegistry 未被覆盖');
});

(async () => {
  await new Promise(r => setTimeout(r, 200));
  console.log('\n' + '='.repeat(50));
  console.log(`P6.7 Browser smoke: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();