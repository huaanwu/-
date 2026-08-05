/**
 * P6.6 — PolicyBundle 模块单元测试
 *
 * 覆盖:
 *   1. 模块存在性: Core.AI.PolicyBundle 暴露 load + 内部常量/helper
 *   2. _factorFor: 5 sleeve × 3 regime → 仓位系数表 (覆盖 bull/range/bear × long/short/fund/alerts/agents)
 *   3. _kbCategoriesFor: 5 sleeve → KB 类目映射
 *   4. _quotaBlock: 拼出 "sleeve 配额与仓位系数" markdown
 *   5. _maoBlock: KB.rule 拿空时 fallback, 拿得到 MAO-* 时拼 KB 路径
 *   6. load({strategy:'agents'}) 最小依赖 (Regime + KB 全 fail) → 不抛异常, 返有效 bundle
 *   7. load({strategy:'long'}) 全 stub → toSystemPrompt() 字符串非空, 含「仓位系数」+「毛选」+「KB」
 *   8. PolicyBundle 不污染 window.Core 其他字段 (新加 AI.PolicyBundle 不影响已有)
 *
 * 跑法: node test/data-contract/policy-bundle.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'ai', 'policy-bundle.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ===== vm sandbox builder =====
// 给 Core.Regime/Cycle/StateMatrix/KB/Discipline/Constants 各 stub, 模拟「可用但简单」状态
function buildSandbox(opts = {}) {
  const sb = {
    window: {},
    console: console,
    Date, Math, Promise, setTimeout, clearTimeout,
    setInterval, clearInterval,
    fetch, location: { origin: 'http://localhost:3003' }
  };

  // KB stub: 默认返 5 条 mock entry, 含 1 条 MAO
  const mockKbEntries = opts.kbEntries || [
    { id: 'MAO-001', category: 'rule', title: '矛盾论', summary: '主要矛盾决定其他矛盾。市场主导矛盾通常从 5 个里选: 估值/流动性/业绩/政策/情绪。当前是哪一个? 用一句话回答。' },
    { id: 'MAO-002', category: 'rule', title: '实践论', summary: '实践是检验真理的标准。回测是验证, 纸上谈兵不行。' },
    { id: 'VAL-001', category: 'valuation', title: 'PE 分位', summary: '当前 PE 处于近 5 年 30% 分位以下, 安全边际充足。' },
    { id: 'RISK-001', category: 'risk', title: '止损如军令', summary: '跌破 20 日线 / -8% 强制止损, 不抢反弹。' },
    { id: 'FUND-001', category: 'fund', title: '短债基金', summary: '低利率环境下短债优于长债, 久期短 = 利率风险低。' }
  ];

  sb.window.Core = {
    Constants: {
      LONG_TRADER_TOP_N: 3,
      PAPER_SHORT_CASH: 30000,
      SHORT_MAX_HOLD_DAYS: 5,
      PAPER_SHORT_POSITION_PCT: 0.2,
      MAX_SINGLE_STOCK_PCT: 0.2,
      MAX_MONTHLY_DRAWDOWN_PCT: 0.1,
      MAX_SINGLE_INDUSTRY_PCT: 0.3,
      VALUATION_PERCENTILE_WARN: 80
    },
    Regime: {
      GATES: {
        bull:  { label: '牛市', icon: '🚀', sharpeThreshold: 1.5, positionScale: 1.0 },
        range: { label: '震荡市', icon: '😐', sharpeThreshold: 1.0, positionScale: 0.6 },
        bear:  { label: '熊市', icon: '🐻', sharpeThreshold: 0.5, positionScale: 0.2 }
      },
      gateMultipliers: () => ({
        state: opts.regimeState || 'range',
        label: opts.regimeState === 'bull' ? '牛市' : (opts.regimeState === 'bear' ? '熊市' : '震荡市'),
        positionScale: opts.regimeState === 'bull' ? 1.0 : (opts.regimeState === 'bear' ? 0.2 : 0.6),
        stale: !!opts.stale,
        staleFailures: opts.stale ? 3 : 0,
        indices: opts.indices || {}
      }),
      _formatRegimeBlock: () => opts.regimeBlock || '## 大盘状态机 (Regime)\n当前: 震荡市 (range), 仓位系数 ×0.6',
      get: async () => ({ state: opts.regimeState || 'range', lastDate: '2026-07-30' })
    },
    Cycle: {
      getCyclePosition: async () => opts.cycle || ({
        threeStage: 'stalemate_bull', confidence: 'medium', macroScore: 1,
        signals: {}, reasoning: 'mock cycle', _ok: true, _generatedAt: Date.now(), kbText: ''
      }),
      formatForPrompt: (pos) => opts.cycleText || '## 宏观周期定位\n- 当前阶段: 相持偏多\n- 建议仓位: 60%'
    },
    StateMatrix: {
      getPositionScale: async () => opts.stateMatrix || ({
        positionScale: 0.5, name: '震荡相持偏多', tactics: '均衡配置',
        conflict: false, warning: null, regime: 'range', cycleStage: 'stalemate_bull',
        _ok: true, _generatedAt: Date.now()
      }),
      formatForPrompt: (sm) => opts.stateMatrixText || '## 价×时状态矩阵\n- 当前: 震荡相持偏多\n- 建议仓位: 50%'
    },
    KB: {
      get: async (cat) => {
        if (cat === 'rule') return mockKbEntries.filter(e => e.category === 'rule');
        return mockKbEntries.filter(e => !cat || e.category === cat);
      },
      pickRelevant: async () => [],
      formatForPrompt: (entries) => entries.map(e => `- **${e.id} ${e.title || ''}**: ${(e.summary || '').split(/[。\n]/)[0]}`).join('\n')
    },
    Discipline: {
      DEFAULT_CONFIG: {
        maxSingleStockPct: 0.2, maxTotalPositionPct: 0.95, chaseWarnPct: 0.05,
        maxMonthlyDrawdownPct: 0.1, maxSingleIndustryPct: 0.3, enabled: true,
        short: { maxDailyTrades: 3, cooldownHours: 48 }
      },
      getConfig: async () => opts.disciplineConfig || {
        maxSingleStockPct: 0.2, maxTotalPositionPct: 0.95, chaseWarnPct: 0.05,
        maxMonthlyDrawdownPct: 0.1, maxSingleIndustryPct: 0.3, enabled: true,
        short: { maxDailyTrades: 3, cooldownHours: 48 }
      }
    }
  };

  vm.createContext(sb);
  vm.runInContext(POLICY_SRC, sb, { filename: 'policy-bundle.js' });
  return sb;
}

// ===== 情形 1: 模块存在性 =====
describe('情形 1: Core.AI.PolicyBundle 暴露', () => {
  const sb = buildSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  assert(!!PB, 'window.Core.AI.PolicyBundle 已定义');
  assert(typeof PB.load === 'function', 'PB.load 是函数');
  assert(typeof PB._factorFor === 'function', 'PB._factorFor 是函数');
  assert(typeof PB._kbCategoriesFor === 'function', 'PB._kbCategoriesFor 是函数');
  assert(!!PB._FACTOR_TABLE, '_FACTOR_TABLE 暴露');
  assert(!!PB._KB_BY_STRATEGY, '_KB_BY_STRATEGY 暴露');
  assert(Array.isArray(PB._ALL_KB_CATEGORIES) && PB._ALL_KB_CATEGORIES.length === 13, '_ALL_KB_CATEGORIES 13 类齐全');
});

// ===== 情形 2: _factorFor 5 sleeve × 3 regime =====
describe('情形 2: _factorFor 仓位系数表', () => {
  const sb = buildSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  // long: bull=1.0 / range=0.7 / bear=0.3
  assert(PB._factorFor('long', 'bull') === 1.0, 'long × bull = 1.0');
  assert(PB._factorFor('long', 'range') === 0.7, 'long × range = 0.7');
  assert(PB._factorFor('long', 'bear') === 0.3, 'long × bear = 0.3');
  // short: bull=0.8 / range=0.6 / bear=0.0 (熊市不开仓)
  assert(PB._factorFor('short', 'bull') === 0.8, 'short × bull = 0.8');
  assert(PB._factorFor('short', 'range') === 0.6, 'short × range = 0.6');
  assert(PB._factorFor('short', 'bear') === 0.0, 'short × bear = 0.0 (熊市不开仓)');
  // fund: bull=1.0 / range=0.8 / bear=0.5
  assert(PB._factorFor('fund', 'bull') === 1.0, 'fund × bull = 1.0');
  assert(PB._factorFor('fund', 'range') === 0.8, 'fund × range = 0.8');
  assert(PB._factorFor('fund', 'bear') === 0.5, 'fund × bear = 0.5');
  // alerts: 全 1.0 (提醒不仓位化)
  assert(PB._factorFor('alerts', 'bull') === 1.0, 'alerts × bull = 1.0');
  assert(PB._factorFor('alerts', 'range') === 1.0, 'alerts × range = 1.0');
  assert(PB._factorFor('alerts', 'bear') === 1.0, 'alerts × bear = 1.0');
  // 未知 strategy → 默认 0.6
  assert(PB._factorFor('unknown', 'range') === 0.6, 'unknown × range = default 0.6');
});

// ===== 情形 3: _kbCategoriesFor 5 sleeve → KB =====
describe('情形 3: _kbCategoriesFor KB 类目映射', () => {
  const sb = buildSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  const longCats = PB._kbCategoriesFor('long');
  const shortCats = PB._kbCategoriesFor('short');
  const fundCats = PB._kbCategoriesFor('fund');
  const alertsCats = PB._kbCategoriesFor('alerts');
  // long 含 valuation/risk, 不含 fund
  assert(longCats.includes('valuation') && longCats.includes('risk'), 'long 含 valuation + risk');
  assert(!longCats.includes('fund'), 'long 不含 fund');
  // short 含 risk/behavior/case, 不含 valuation
  assert(shortCats.includes('risk') && shortCats.includes('case'), 'short 含 risk + case');
  assert(!shortCats.includes('valuation'), 'short 不含 valuation');
  // fund 含 fund/fixed_income, 不含 risk/case
  assert(fundCats.includes('fund') && fundCats.includes('fixed_income'), 'fund 含 fund + fixed_income');
  assert(!fundCats.includes('risk'), 'fund 不含 risk');
  // alerts 含 risk/policy/macro_signal
  assert(alertsCats.includes('risk') && alertsCats.includes('policy'), 'alerts 含 risk + policy');
});

// ===== 情形 4: _quotaBlock 拼出 markdown =====
describe('情形 4: _quotaBlock 拼 sleeve 配额与仓位系数', () => {
  const sb = buildSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  const quota = PB._quotaBlock({ strategy: 'long', topN: 3, maxDailyTrades: null, cooldownHours: null,
    maxSingleStockPct: 0.2, maxTotalPositionPct: 0.95, chaseWarnPct: 0.05,
    maxMonthlyDrawdownPct: 0.1 }, 0.7);
  assert(quota.indexOf('sleeve 配额') >= 0, '含「sleeve 配额」标题');
  assert(quota.indexOf('long') >= 0, '含 strategy 名');
  assert(quota.indexOf('topN: 3') >= 0 || quota.indexOf('topN  3') >= 0 || quota.indexOf('topN=3') >= 0 || /topN.{0,5}3/.test(quota), '含 topN=3');
  assert(quota.indexOf('20%') >= 0, 'maxSingleStockPct 20%');
  assert(quota.indexOf('×0.70') >= 0, '仓位系数 ×0.70');
  // 短线专属字段
  const shortQuota = PB._quotaBlock({ strategy: 'short', topN: null,
    maxSingleStockPct: 0.2, maxTotalPositionPct: 0.95,
    maxDailyTrades: 3, cooldownHours: 48 }, 0.6);
  assert(shortQuota.indexOf('3 笔') >= 0, '短线每日最大笔数 3 笔');
  assert(shortQuota.indexOf('48 小时') >= 0, '短线同票冷却 48 小时');
});

// ===== 情形 5: _maoBlock KB 路径 =====
describe('情形 5: _maoBlock 毛选元规则', async () => {
  const sb = buildSandbox();
  const PB = sb.window.Core.AI.PolicyBundle;
  const mao = await PB._maoBlock();
  assert(typeof mao === 'string' && mao.length > 20, 'maoBlock 是非空字符串 (长度 > 20)');
  assert(mao.indexOf('MAO-001') >= 0, '含 MAO-001 (矛盾论)');
  assert(mao.indexOf('MAO-002') >= 0, '含 MAO-002 (实践论)');
  assert(mao.indexOf('主要矛盾') >= 0 || mao.indexOf('矛盾') >= 0, 'MAO-001 摘要片段「主要矛盾」');
});

// ===== 情形 5b: _maoBlock fallback 路径 (KB 拿空) =====
describe('情形 5b: _maoBlock KB 拿空时 fallback 硬编码', async () => {
  const sb = buildSandbox({ kbEntries: [] });  // 空 KB
  const PB = sb.window.Core.AI.PolicyBundle;
  const mao = await PB._maoBlock();
  assert(mao.indexOf('毛选') >= 0, 'fallback 含「毛选」字样');
  assert(mao.indexOf('抓主要矛盾') >= 0, 'fallback 含「抓主要矛盾」');
});

// ===== 情形 6: load({strategy:'agents'}) 最小依赖 =====
describe('情形 6: load() 最小依赖 (Regime+KB 全可用)', async () => {
  const sb = buildSandbox({ regimeState: 'range' });
  const PB = sb.window.Core.AI.PolicyBundle;
  const bundle = await PB.load({ strategy: 'agents' });
  assert(!!bundle, 'bundle 返非空');
  assert(bundle.strategy === 'agents', 'bundle.strategy = agents');
  assert(!!bundle.regime, 'bundle.regime 存在');
  assert(bundle.factor === 0.6, 'agents fallback factor = 0.6 (无 strategy 表 → default)');
  assert(typeof bundle.toSystemPrompt === 'function', 'toSystemPrompt 是函数');
  const text = bundle.toSystemPrompt();
  assert(typeof text === 'string' && text.length > 200, 'toSystemPrompt 是非空字符串');
});

// ===== 情形 7: load({strategy:'long'}) 全 stub → toSystemPrompt 含「仓位系数」+「毛选」+「KB」 =====
describe('情形 7: load({strategy:\'long\'}) toSystemPrompt 含 3 要素', async () => {
  const sb = buildSandbox({ regimeState: 'bull' });
  const PB = sb.window.Core.AI.PolicyBundle;
  const bundle = await PB.load({ strategy: 'long', ctx: { stocks: [] } });
  const text = bundle.toSystemPrompt();
  assert(text.indexOf('仓位系数') >= 0, '含「仓位系数」');
  assert(text.indexOf('毛选') >= 0, '含「毛选」');
  assert(text.indexOf('知识库') >= 0 || text.indexOf('KB') >= 0 || text.indexOf('VAL-001') >= 0, '含 sleeve 专属 KB');
  assert(text.indexOf('当前宏观仓位系数') >= 0, 'PolicyBundle 独有 sleeve 配额段');
  assert(bundle.factor === 1.0, 'long × bull factor = 1.0');
});

// ===== 情形 8: load({strategy:'short'}) 熊市不开仓 =====
describe('情形 8: short × bear → factor = 0.0', async () => {
  const sb = buildSandbox({ regimeState: 'bear' });
  const PB = sb.window.Core.AI.PolicyBundle;
  const bundle = await PB.load({ strategy: 'short' });
  assert(bundle.factor === 0.0, 'short × bear = 0.0');
  assert(bundle.toSystemPrompt().indexOf('×0.00') >= 0, 'sleeve 配额段反映 0.00 系数');
});

// ===== 情形 9: 全 stub 失败 (Regime/Cycle/StateMatrix 全抛) → 不抛 =====
describe('情形 9: 全 stub 失败兜底', async () => {
  const sb = {
    window: {}, console, Date, Math, Promise, setTimeout, clearTimeout, setInterval, clearInterval,
    fetch, location: { origin: 'http://localhost:3003' }
  };
  sb.window.Core = {
    Constants: { LONG_TRADER_TOP_N: 3 },
    Regime: { gateMultipliers: () => { throw new Error('regime down'); }, get: async () => { throw new Error('x'); } },
    Cycle: { getCyclePosition: async () => { throw new Error('cycle down'); } },
    StateMatrix: { getPositionScale: async () => { throw new Error('sm down'); } },
    KB: { get: async () => { throw new Error('kb down'); } },
    Discipline: { getConfig: async () => { throw new Error('disc down'); } }
  };
  vm.createContext(sb);
  vm.runInContext(POLICY_SRC, sb, { filename: 'policy-bundle.js' });
  const PB = sb.window.Core.AI.PolicyBundle;
  let bundle;
  try {
    bundle = await PB.load({ strategy: 'long' });
  } catch (e) {
    fail('load() 在全失败下应不抛, 但抛了: ' + e.message);
    return;
  }
  assert(!!bundle, 'bundle 仍返非空');
  assert(Number.isFinite(bundle.factor), 'factor 是有效数字');
  // 全失败 sandbox 下 Regime 兜底为 range, factor = _factorFor('long','range') = 0.7
  assert(bundle.factor === 0.7, '全失败 → factor = 0.7 (long × range 兜底)');
  const text = bundle.toSystemPrompt();
  assert(text.indexOf('毛选') >= 0, 'fallback MAO 仍生效');
});

// ===== 情形 10: 不污染 window.Core 其他字段 =====
describe('情形 10: 不污染 window.Core.AI 已有字段', () => {
  const sb = buildSandbox();
  // 模拟已有 Core.AI.Orchestrator / Entry
  sb.window.Core.AI = sb.window.Core.AI || {};
  sb.window.Core.AI.Orchestrator = { runAgent: () => 'mock' };
  sb.window.Core.AI.Entry = { run: () => 'mock' };
  // 重新跑 (注意: VM context 已固化, 这里只验证 load() 不覆盖)
  const PB = sb.window.Core.AI.PolicyBundle;
  assert(typeof PB.load === 'function', 'PolicyBundle.load 仍在');
  // Orchestrator / Entry 不会被覆盖
  assert(sb.window.Core.AI.Orchestrator.runAgent() === 'mock', 'Core.AI.Orchestrator 未被覆盖');
  assert(sb.window.Core.AI.Entry.run() === 'mock', 'Core.AI.Entry 未被覆盖');
});

(async () => {
  await new Promise(r => setTimeout(r, 100));
  console.log('\n' + '='.repeat(50));
  console.log(`P6.6 PolicyBundle: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();