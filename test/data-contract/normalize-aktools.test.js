/**
 * normalize.aktools 单测 — Phase 2.1
 *
 * aktools stock_zh_a_spot_em 接口返 snake_case 字段:
 *   ts_code (格式 '600519.SH'), name, trade_date,
 *   open, high, low, close, prev_close,
 *   vol (手), amount (千),
 *   change (元), pct_chg (百分数),
 *   turnover_rate (% 数字), pe (倍),
 *   total_mv (万元), circ_mv (万元)
 *
 * 关键单位差异 (vs 腾讯 / 新浪):
 *   - vol 是手 → ×100 = 股
 *   - amount 是千 → ×1000 = 元 (待核实, 若实际是万则 ×1e4)
 *   - total_mv / circ_mv 是亿元 → ×1e8 = 元
 *
 * 跑法: node test/data-contract/normalize-aktools.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'schema.js'), 'utf8');
const NORM_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'normalize.js'), 'utf8');

const sandbox = { window: {}, console };
sandbox.window.Core = { Data: {} };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'schema.js' });
vm.runInContext(NORM_SRC, sandbox, { filename: 'normalize.js' });

const { normalizeAktools, _pctFromAktools } = sandbox.window.Core.Data.Normalize;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// 情形 1: 完整字段 — aktools snake_case
describe('情形 1: 完整字段(snake_case, aktools stock_zh_a_spot_em)', () => {
  const raw = {
    ts_code: '600519.SH', name: '贵州茅台',
    trade_date: '20260730',
    open: 1725.0, high: 1735.0, low: 1718.0, close: 1730.0, prev_close: 1720.0,
    vol: 12345.0,          // 手
    amount: 456789.0,      // 千 (×1000 → 456,789,000 元)
    change: 10.0,
    pct_chg: 0.58,
    turnover_rate: 0.85,
    pe: 28.5,
    total_mv: 21730.5,     // 万元
    circ_mv: 21730.5       // 万元
  };
  const p = normalizeAktools(raw);
  assert(p && p.symbol === '600519', 'symbol 从 ts_code 600519.SH 抽取 → 600519');
  assert(p.name === '贵州茅台', 'name 抽取正确');
  assert(p.market === 'SH', 'market 推为 SH');
  assert(p.price === 1730, 'price = close = 1730');
  assert(p.prevClose === 1720, 'prevClose = prev_close = 1720');
  assert(p.change === 10, 'change = raw.change = 10');
  assert(p.changePercent === 0.0058, 'changePercent = pct_chg / 100 = 0.0058');
  assert(p.volume === 1234500, 'volume = vol × 100 = 1234500 股');
  assert(p.amount === 456789000, 'amount = amount × 1000 = 456789000 元');
  assert(p.turnoverRate === 0.85, 'turnoverRate = 0.85');
  assert(p.pe === 28.5, 'pe = 28.5');
  assert(p.totalMarketCap === 2173050000000, 'totalMarketCap = total_mv × 1e8 = 2173050000000 元 (2.17 万亿, 茅台量级)');
  assert(p.circMarketCap === 2173050000000, 'circMarketCap = circ_mv × 1e8 = 2173050000000 元');
  assert(p.timestamp === '20260730', 'timestamp = trade_date');
});

// 情形 2: ts_code 不带 .SH 后缀
describe('情形 2: ts_code 不带市场后缀', () => {
  const raw = {
    ts_code: '000001', name: '平安银行',
    close: 12.5, prev_close: 12.3,
    vol: 500000, amount: 62000
  };
  const p = normalizeAktools(raw);
  assert(p.symbol === '000001', 'symbol = 000001');
  assert(p.market === 'SZ', '000xxx → SZ');
});

// 情形 3: 中文键兜底 (兼容早期 aktools 字段名)
describe('情形 3: 中文键兜底', () => {
  const raw = {
    代码: '600519', 名称: '贵州茅台',
    最新价: 1730, 昨收: 1720,
    成交量: 12345, 总成交额: 45678.9,
    涨跌额: 10, 涨跌幅: '0.58%',
    时间: '20260730103000'
  };
  const p = normalizeAktools(raw);
  assert(p.symbol === '600519', 'symbol 从中文键抽取');
  assert(p.price === 1730, 'price 从 最新价 抽取');
  assert(p.volume === 1234500, 'volume = 12345 × 100 (中文键也是手)');
});

// 情形 4: change / pct_chg 缺失, 自算
describe('情形 4: change + pct_chg 缺失, 自算', () => {
  const raw = {
    ts_code: '600519.SH', name: '贵州茅台',
    close: 1730, prev_close: 1720
  };
  const p = normalizeAktools(raw);
  assert(p.change === 10, 'change 自算 = 1730 - 1720 = 10');
  assert(p.changePercent === null, 'pct_chg 缺失 → changePercent = null');
});

// 情形 5: 缺失关键字段
describe('情形 5: 关键字段缺失', () => {
  const raw = { ts_code: '000001.SZ', name: '平安银行' };
  const p = normalizeAktools(raw);
  assert(p !== null, 'normalize 仍返 payload');
  assert(p.symbol === '000001', 'symbol 抽取');
  assert(p.price === null, 'close 缺失 → price = null');
  assert(p.change === null, 'change 缺失 + prev_close 缺失 → change = null');
});

// 情形 6: _pctFromAktools
describe('情形 6: _pctFromAktools', () => {
  assert(_pctFromAktools(0.58) === 0.0058, '0.58 → 0.0058');
  assert(_pctFromAktools(-1.23) === -0.0123, '-1.23 → -0.0123');
  assert(_pctFromAktools(null) === null, 'null → null');
  assert(_pctFromAktools('0.5') === 0.005, '字符串 "0.5" → 0.005');
});

// 边界
describe('边界', () => {
  assert(normalizeAktools(null) === null, 'normalizeAktools(null) → null');
  assert(normalizeAktools('foo') === null, 'normalizeAktools(字符串) → null');
  assert(normalizeAktools({}) !== null, 'normalizeAktools({}) 仍返 payload');
});

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail > 0 ? 1 : 0);