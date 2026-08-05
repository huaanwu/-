/**
 * 毛选元规则注入单测 — P3.3
 *
 * 覆盖:
 *   1. _maoBlockSync: 不阻塞, 返回非空 fallback
 *   2. _maoBlockAsync: KB 加载完后从 KB.rule 取 MAO 条目
 *   3. _maoBlockAsync: KB 不可用时 fallback
 *   4. _buildPrompt: sys 头部含毛选关键字
 *   5. _buildPrompt: 三 agent (observer/analyst/coach) 都注入
 *
 * 跑法: node test/data-contract/mao-discipline.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const ORCH_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'orchestrator.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ============================================================
// 情形 1: _maoBlockSync fallback (不依赖 KB)
// ============================================================
describe('情形 1: _maoBlockSync 返回非空 fallback', () => {
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  const block = Orch._maoBlockSync();
  assert(typeof block === 'string' && block.length > 50, '返回非空字符串');
  assert(block.includes('主要矛盾'), '含「主要矛盾」');
  assert(block.includes('敌进我退'), '含「敌进我退」');
  assert(block.includes('实事求是'), '含「实事求是」');
});

// ============================================================
// 情形 2: _buildPrompt 注入 mao 关键字 (三 agent 都注入)
// ============================================================
describe('情形 2: _buildPrompt 三 agent 都含毛选', () => {
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  const fakeMao = '## 交易纪律元规则\n1. 抓主要矛盾 (《矛盾论》)\n2. 没有调查就没有发言权 (《调查研究》)\n3. 集中优势兵力 (《战略战术》)\n4. 敌进我退 (《论持久战》)\n';

  for (const t of ['observer', 'analyst', 'coach']) {
    const { sys } = Orch._buildPrompt(t, fakeMao);
    assert(sys.startsWith(fakeMao), `${t}: sys 头部以 maoBlock 开头`);
    assert(sys.includes('主要矛盾'), `${t}: 含「主要矛盾」`);
    assert(sys.includes('敌进我退'), `${t}: 含「敌进我退」`);
  }
});

// ============================================================
// 情形 3: _buildPrompt 不传 maoBlock → 用 sync fallback
// ============================================================
describe('情形 3: _buildPrompt 不传 maoBlock → sync fallback', () => {
  const sandbox = { window: {}, console: console };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  const { sys } = Orch._buildPrompt('observer');  // 不传参
  assert(sys.includes('主要矛盾') || sys.includes('持久战'), 'sync fallback 也含毛选关键词');
});

// ============================================================
// 情形 4: _maoBlockAsync KB 不可用 → fallback
// ============================================================
describe('情形 4: _maoBlockAsync KB 不可用 → fallback', async () => {
  const sandbox = { window: {}, console: console };
  sandbox.window.Core = { KB: undefined };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  const block = await Orch._maoBlockAsync();
  assert(block.includes('主要矛盾'), 'KB 不可用 → fallback 含毛选关键词');
});

// ============================================================
// 情形 5: _maoBlockAsync KB 有 MAO 条目 → 取 KB 内容
// ============================================================
describe('情形 5: _maoBlockAsync KB 有 MAO → 取 KB', async () => {
  const sandbox = { window: {}, console: console };
  sandbox.window.Core = {
    KB: {
      get: async (cat) => {
        if (cat === 'rule') {
          return [
            { id: 'MAO-001', title: '矛盾论: 当前主要矛盾是什么', summary: '市场主导矛盾通常从 5 个里选: 估值/流动性/业绩/政策/情绪。' },
            { id: 'MAO-002', title: '实践论: 认识-实践-再认识', summary: '决策前先扫一眼自己的「教训池」, 避免重复犯错。' },
            { id: 'MAO-003', title: '实事求是', summary: '拒绝套用通用策略。' }
          ];
        }
        return [];
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  const block = await Orch._maoBlockAsync();
  assert(block.includes('MAO-001'), '含 MAO-001');
  assert(block.includes('市场主导矛盾'), '含 KB summary 摘录');
  assert(block.includes('MAO-003'), '含 MAO-003');
  assert(block.includes('教训池'), '含 MAO-002 的关键词');
});

// ============================================================
// 情形 6: _loadMaoDiscipline promise 缓存 (第二次调不重 fetch)
// ============================================================
describe('情形 6: _loadMaoDiscipline promise 缓存', async () => {
  let callCount = 0;
  const sandbox = { window: {}, console: console };
  sandbox.window.Core = {
    KB: {
      get: async () => {
        callCount++;
        return [{ id: 'MAO-001', title: 't', summary: 's。' }];
      }
    }
  };
  vm.createContext(sandbox);
  vm.runInContext(ORCH_SRC, sandbox, { filename: 'orchestrator.js' });
  const Orch = sandbox.window.Core.AI.Orchestrator;
  await Orch._maoBlockAsync();
  await Orch._maoBlockAsync();
  await Orch._maoBlockAsync();
  assert(callCount === 1, `KB.get 应只调 1 次 (实际 ${callCount})`);
});

(async () => {
  // 等所有 async 跑完
  await new Promise(r => setTimeout(r, 100));
  console.log('\n' + '='.repeat(50));
  console.log(`毛选注入: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();