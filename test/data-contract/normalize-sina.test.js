/**
 * normalize.sina 单测 — Phase 2.1
 *
 * 新浪 _sinaParse 返 GBK 解码后形态:
 *   {
 *     代码, 名称, 最新价, 昨收, 今开, 最高, 最低,
 *     成交量 (股), 成交额 (元), 涨跌额, 涨跌幅 (已是百分数数字),
 *     换手率 (null), 市盈率 (null), 流通市值 (null), 总市值 (null),
 *     时间
 *   }
 *
 * 与腾讯差异: 成交量是股直给不 ×100; 成交额是元直给不 ×10000;
 *             涨跌幅是数字 1.23 (不是字符串 "1.23%")
 *
 * 跑法: node test/data-contract/normalize-sina.test.js
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

const { normalizeSina, _pctFromSina, _marketOf } = sandbox.window.Core.Data.Normalize;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// 情形 1: 价格字段完整(新浪 GBK 解码后形态)
describe('情形 1: 价格字段(茅台正常行情)', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': 1730.00, '昨收': 1720.00,
    '今开': 1725.00, '最高': 1735.00, '最低': 1718.00,
    '成交量': 1234500, '成交额': 456789000,   // 股 / 元
    '涨跌额': 10.00, '涨跌幅': 0.58,            // 已是数字
    '换手率': null, '市盈率': null,
    '流通市值': null, '总市值': null,
    '时间': '2026-07-30 10:30:00'
  };
  const p = normalizeSina(raw);
  assert(p && p.symbol === '600519', 'symbol 抽取正确');
  assert(p.name === '贵州茅台', 'name 抽取正确');
  assert(p.market === 'SH', 'market 推为 SH');
  assert(p.price === 1730, 'price = 1730');
  assert(p.prevClose === 1720, 'prevClose = 1720');
  assert(p.change === 10, 'change 来自 raw.涨跌额 = 10 (新浪客户端已算)');
  assert(p.changePercent === 0.0058, 'changePercent = 0.58 / 100 = 0.0058');
  assert(p.volume === 1234500, 'volume 直给股数, 不 ×100');
  assert(p.amount === 456789000, 'amount 直给元, 不 ×10000');
});

// 情形 2: 涨跌幅边界
describe('情形 2: _pctFromSina 数字解析', () => {
  assert(_pctFromSina(0.58) === 0.0058, '0.58 → 0.0058');
  assert(_pctFromSina(-1.23) === -0.0123, '-1.23 → -0.0123');
  assert(_pctFromSina(0) === 0, '0 → 0');
  assert(_pctFromSina(null) === null, 'null → null');
  assert(_pctFromSina('') === null, '空字符串 → null');
  assert(_pctFromSina('1.23%') === 0.0123, '字符串 "1.23%" 也吃(防御性)');
  assert(_pctFromSina(' 0.5 ') === 0.005, '空格容忍');
  assert(_pctFromSina(NaN) === null, 'NaN → null');
});

// 情形 3: 涨跌额缺失, 自算
describe('情形 3: raw.涨跌额 缺失时, normalize.sina 自己算', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': 1730, '昨收': 1720,
    '涨跌额': null, '涨跌幅': null
  };
  const p = normalizeSina(raw);
  assert(p.change === 10, 'change 自算 = 1730 - 1720 = 10');
  assert(p.changePercent === null, '涨跌额缺失 + 涨跌幅缺失 → changePercent = null');
});

// 情形 4: 停牌(关键字段全空)
describe('情形 4: 停牌 (新浪全空字段)', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': '', '昨收': '', '今开': '', '最高': '', '最低': '',
    '成交量': '', '成交额': '',
    '涨跌额': '', '涨跌幅': '',
    '时间': '2026-07-30 10:30:00'
  };
  const p = normalizeSina(raw);
  assert(p !== null, 'normalize 不返 null');
  assert(p.price === null, '停牌 price = null');
  assert(p.change === null, '停牌 change = null');
  assert(p.volume === null, '停牌 volume = null');
  assert(p.amount === null, '停牌 amount = null');
});

// 情形 5: 单位换算 — volume 股直给 不 ×100 (关键, 与腾讯区别)
describe('情形 5: 成交量 是股, 不应 ×100 (与腾讯关键区别)', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': 1730, '昨收': 1720,
    '成交量': 1234500    // 股, 已是真实股数
  };
  const p = normalizeSina(raw);
  assert(p.volume === 1234500, 'volume = 1234500 (不 ×100)');
  assert(p.amount === null, 'amount 缺失 → null');
});

// 情形 6: 流通市值/总市值 — 新浪免费接口不返
describe('情形 6: 流通市值/总市值 null 透传', () => {
  const raw = {
    '代码': '000001', '名称': '平安银行',
    '最新价': 12.50, '昨收': 12.30,
    '流通市值': null, '总市值': null,
    '换手率': null, '市盈率': null
  };
  const p = normalizeSina(raw);
  assert(p.circMarketCap === null, 'circMarketCap = null (新浪不返)');
  assert(p.totalMarketCap === null, 'totalMarketCap = null (新浪不返)');
  assert(p.turnoverRate === null, 'turnoverRate = null (新浪不返)');
  assert(p.pe === null, 'pe = null (新浪不返)');
});

// 情形 7: 缺失字段
describe('情形 7: 关键字段缺失', () => {
  const raw = { '代码': '000001', '名称': '平安银行' };
  const p = normalizeSina(raw);
  assert(p !== null, 'normalize 仍返 payload');
  assert(p.symbol === '000001', 'symbol 正确');
  assert(p.market === 'SZ', '000xxx → SZ');
  assert(p.price === null, 'price 缺失 = null');
  assert(p.change === null, 'change 缺失 = null');
});

// 边界
describe('边界: null / 非对象输入', () => {
  assert(normalizeSina(null) === null, 'normalizeSina(null) → null');
  assert(normalizeSina(undefined) === null, 'normalizeSina(undefined) → null');
  assert(normalizeSina('字符串') === null, 'normalizeSina(字符串) → null');
  assert(normalizeSina({}) !== null, 'normalizeSina({}) 仍返 payload (空 raw 合法)');
});

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail > 0 ? 1 : 0);