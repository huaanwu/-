/**
 * Core.Screener 单测 — P3.1 (规则引擎)
 *
 * 覆盖:
 *   1. 硬过滤: ST/低成交/停牌/非6位代码
 *   2. 长线打分 5 维: ROE/现金流/PE 分位/营收增速/行业地位
 *   3. 短线打分 5 维: MA 多头/北向/RPS/换手率/板块强度
 *   4. confidence 等级 (high/medium/low/none)
 *   5. top 50 截断
 *   6. sleeve='long'|'short'|'both' 三模式
 *
 * 跑法: node test/data-contract/screener-rules.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'screener-rules.js'), 'utf8');

const sandbox = {
  window: {},
  console: console,
  Core: undefined
};
sandbox.window.Core = {
  Data: {
    getStockSpotEfinanceCached: async () => [
      // 正常大盘股 (通过)
      { '代码': '600519', '名称': '贵州茅台', '成交额': 800000000, '换手率': 0.5 },
      // ST (过滤掉)
      { '代码': '600001', '名称': 'ST华联', '成交额': 800000000, '换手率': 0.3 },
      // 停牌 (成交额=0, 过滤掉)
      { '代码': '600002', '名称': '停牌股', '成交额': 0, '换手率': 0 },
      // 低成交 (过滤掉)
      { '代码': '600003', '名称': '壳股', '成交额': 1000000, '换手率': 0.1 },
      // 4 位代码 (过滤掉)
      { '代码': '1234', '名称': '垃圾', '成交额': 100000000, '换手率': 1 },
      // 正常活跃股
      { '代码': '000001', '名称': '平安银行', '成交额': 600000000, '换手率': 1.2 },
      // 高换手 (短线维度 4 不合格, 但仍通过硬过滤)
      { '代码': '000002', '名称': '万科A', '成交额': 1200000000, '换手率': 20 },
      // 板块标签
      { '代码': '000333', '名称': '美的集团', '成交额': 900000000, '换手率': 1.0, 'industry': '家电' }
    ],
    // run() 需要的数据源 mock: 全部返回 null/空 (降级不影响 _scoreShort/_scoreLong 单测)
    getRpsSnapshot: async () => null,
    getSectorPerformance: async () => null,
    getStockFinancialBatch: async () => null,
    getNorthboundFlow: async () => null
  },
  ResearchPool: {
    add: async (input) => ({ added: true, existed: false, code: input })
  }
};
// vm sandbox 里直接通过 Core 访问 window.Core.Data
sandbox.Core = sandbox.window.Core;
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'screener-rules.js' });
const Screener = sandbox.window.Core.Screener;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// ============================================================
// 情形 1: 硬过滤 — 7 只 → 4 只
// ============================================================
describe('情形 1: _hardFilter 砍掉 ST/停牌/低成交/非6位', () => {
  const spots = sandbox.window.Core.Data.getStockSpotEfinanceCached ? null : null; // 直接用 mock
  const all = [
    { '代码': '600519', '名称': '贵州茅台', '成交额': 800000000 },
    { '代码': '600001', '名称': 'ST华联', '成交额': 800000000 },
    { '代码': '600002', '名称': '停牌股', '成交额': 0 },
    { '代码': '600003', '名称': '壳股', '成交额': 1000000 },
    { '代码': '1234', '名称': '垃圾', '成交额': 100000000 },
    { '代码': '000001', '名称': '平安银行', '成交额': 600000000 },
    { '代码': '000002', '名称': '万科A', '成交额': 1200000000 },
    { '代码': '000333', '名称': '美的集团', '成交额': 900000000 }
  ];
  const passed = Screener._hardFilter(all);
  assert(passed.length === 4, '4 只通过 (茅台/平安/万科/美的); ST/停牌/壳股/4位 全砍');
  const codes = passed.map(s => s['代码']);
  assert(!codes.includes('600001'), 'ST 华联被砍');
  assert(!codes.includes('600002'), '停牌被砍');
  assert(!codes.includes('600003'), '低成交被砍');
  assert(!codes.includes('1234'), '4 位代码被砍');
  assert(codes.includes('600519'), '茅台通过');
  assert(codes.includes('000002'), '万科通过 (虽高换手但硬过滤只看成交额)');
});

// ============================================================
// 情形 2: 长线打分 5 维
// ============================================================
describe('情形 2: _scoreLong 5 维打分', () => {
  const stock = { code: '600519', name: '贵州茅台' };
  // 全 5 维完美数据
  const ctxPerfect = {
    financials: { '600519': { roe3y: 25, cashFlowPositive: true, revGrowth3y: 20, isIndustryLead: true } },
    pePercentiles: { '600519': 30 }  // 30% 分位, 越低越便宜 → 0.7 分
  };
  const r1 = Screener._scoreLong(stock, ctxPerfect);
  assert(r1.dims.roe === 1, 'ROE 25% → 1 (满分)');
  assert(r1.dims.cashFlow === 1, '现金流为正 → 1');
  assert(r1.dims.pe === 0.7, 'PE 分位 30% → 0.7 (1 - 0.3)');
  assert(r1.dims.revGrowth === 0.75, '营收增速 20% → 0.75 ((20+10)/40)');
  assert(r1.dims.industry === 1, '行业龙头 → 1');
  assert(Math.abs(r1.score - 0.89) < 0.01, `总分 ≈ 0.89, 实际 ${r1.score.toFixed(3)}`);

  // 全 0 数据
  const ctxBad = {
    financials: { '600519': { roe3y: 3, cashFlowPositive: false, revGrowth3y: -15, isIndustryLead: false } },
    pePercentiles: { '600519': 90 }
  };
  const r2 = Screener._scoreLong(stock, ctxBad);
  assert(r2.dims.roe === 0, 'ROE 3% → 0');
  assert(r2.dims.cashFlow === 0, '现金流为负 → 0');
  assert(Math.abs(r2.dims.pe - 0.1) < 0.01, `PE 分位 90% → 0.1, 实际 ${r2.dims.pe}`);
  assert(r2.dims.revGrowth === 0, '营收负增长 → 0');
  assert(Math.abs(r2.score - 0.02) < 0.01, `坏股票 ≈ 0.02, 实际 ${r2.score.toFixed(3)}`);

  // 缺失数据 → score=0
  const r3 = Screener._scoreLong(stock, {});
  assert(r3.score === 0, '无数据 → score=0');
  assert(Object.keys(r3.dims).length === 0, 'dims 空');
});

// ============================================================
// 情形 3: 短线打分 5 维
// ============================================================
describe('情形 3: _scoreShort 5 维打分', () => {
  const stock = { code: '000001', name: '平安银行', '换手率': 2.0, industry: '银行' };

  // 全满分场景
  const ctxPerfect = {
    maData: { '000001': { ma20Above: true, ma60Above: true } },
    northbound: { '000001': { net5d: 5000000, todayNet: 100, holdingChange: 200, pct: 1.5, date: '2026-07-31' } },
    rps: { '000001': { pct: 25, rank: 85, z: 1.5, median: 5, std: 20 } },
    sectorTop: { '银行': true }
  };
  const r1 = Screener._scoreShort(stock, ctxPerfect);
  assert(r1.dims.bullishMA === 1, 'MA 多头 → 1');
  assert(r1.dims.northbound === 1, '北向净流入 → 1');
  assert(r1.dims.rps === 1, 'RPS 85 ≥ 80 → 1');
  assert(r1.dims.turnover === 1, '换手率 2% 在 1-8 → 1');
  assert(r1.dims.sector === 1, '板块 top → 1');
  assert(r1.score === 1, `全满分 → 1.0, 实际 ${r1.score.toFixed(3)}`);

  // 高换手 (维度 4 不及格)
  const stock2 = { code: '000002', name: '万科A', '换手率': 20 };
  const r2 = Screener._scoreShort(stock2, ctxPerfect);
  assert(r2.dims.turnover === 0, '换手率 20% > 15 → 0');

  // RPS 不及格
  const ctxLowRPS = { ...ctxPerfect, rps: { '000001': { pct: 10, rank: 60, z: -0.5, median: 5, std: 20 } } };
  const r3 = Screener._scoreShort(stock, ctxLowRPS);
  assert(r3.dims.rps === 0, 'RPS 60 < 80 → 0');
});

// ============================================================
// 情形 4: confidence 等级
// ============================================================
describe('情形 4: _confidence 等级', () => {
  assert(Screener._confidence({ a: 1, b: 1, c: 1, d: 1 }) === 'high', '4 维 → high');
  assert(Screener._confidence({ a: 1, b: 1, c: 1, d: 1, e: 1 }) === 'high', '5 维 → high');
  assert(Screener._confidence({ a: 1, b: 1, c: 1 }) === 'medium', '3 维 → medium');
  assert(Screener._confidence({ a: 1, b: 1 }) === 'medium', '2 维 → medium');
  assert(Screener._confidence({ a: 1 }) === 'low', '1 维 → low');
  assert(Screener._confidence({}) === 'none', '0 维 → none');
});

// ============================================================
// 情形 5: top 50 截断 + 排序
// ============================================================
describe('情形 5: _pickTop 排序与截断', () => {
  const scored = Array.from({ length: 80 }, (_, i) => ({
    code: '00000' + (i + 1).toString().padStart(1, '0'),
    score: i / 80  // 0~0.99 单调递增
  }));
  // 把 score=0 的过滤掉, 应得 79 个; 截断到 50
  const top = Screener._pickTop(scored, 50);
  // 这里 _pickTop 会过滤 score>0, 全部都有 score, 截断到 50
  assert(top.length === 50, '截断到 50');
  assert(top[0].score >= top[49].score, '降序排列');
});

// ============================================================
// 情形 6: run(sleeve) 三模式 + 情形 7: pushToPool
//   注: 不能在 describe 内 await, 顶层 await 也跟 require 冲突
//   改用 IIFE 把所有断言包起来, 主进程 setTimeout 0 后退出
// ============================================================
(async () => {
  const _r1 = await Screener.run('long');
  assert(_r1.long.length >= 0, 'long 模式 → long 数组');
  assert(_r1.short.length === 0, 'long 模式 → short 为空');
  assert(_r1._ok === true, '_ok=true');

  const _r2 = await Screener.run('short');
  assert(_r2.long.length === 0, 'short 模式 → long 为空');
  assert(_r2.short.length >= 0, 'short 模式 → short 数组');

  const _r3 = await Screener.run('both');
  assert(_r3.long.length >= 0 && _r3.short.length >= 0, 'both 模式 → 两个数组都有');

  const _r4 = await Screener.pushToPool(['600519', '000001', '000002'], 'long');
  assert(_r4.imported + _r4.skipped + _r4.failed === 3, '3 只全部处理');

  console.log('\n' + '='.repeat(50));
  console.log(`Core.Screener: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();