/**
 * normalize.tengxun 单测 — Phase 1.7
 *
 * 覆盖 5 种情形:
 *   1. 价格字段: 完整行情, 验证 price/prevClose/open/high/low 转换
 *   2. 涨跌幅: "1.23%" 字符串 -> 0.0123 (小数); "停牌" -> null
 *   3. 停牌: 全部价格字段为空字符串, 应该返 null 不返 0
 *   4. 成交量: 手 × 100 = 股; 成交额 万 × 10000 = 元
 *   5. 缺失字段: 关键字段 undefined, 不应该崩, 应该返 null
 *
 * 跑法: node test/data-contract/normalize-tengxun.test.js
 * 不依赖浏览器 / DOM / IndexedDB (vm sandbox 加载 normalize.js)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'schema.js'), 'utf8');
const NORM_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'normalize.js'), 'utf8');

// vm sandbox: 模拟 window + window.Core.Data.Schema
const sandbox = {
  window: {},
  console: console
};
sandbox.window.Core = { Data: {} };
vm.createContext(sandbox);
vm.runInContext(SRC, sandbox, { filename: 'schema.js' });
vm.runInContext(NORM_SRC, sandbox, { filename: 'normalize.js' });

const { normalizeTengxun, _num, _pctFromTengxun, _marketOf } = sandbox.window.Core.Data.Normalize;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) {
  console.log('\n' + name);
  fn();
}

// ============================================================
// 情形 1: 价格字段完整转换
// ============================================================
describe('情形 1: 价格字段完整转换 (贵州茅台正常行情)', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': '1730.00', '昨收': '1720.00',
    '今开': '1725.00', '最高': '1735.00', '最低': '1718.00',
    '成交量': '12345', '总成交额': '45678.90',
    '换手率': '0.85', '市盈率': '28.5',
    '流通市值': '21730.50', '总市值': '21730.50',
    '涨跌额': '10.00', '涨跌幅': '0.58%',
    '时间': '20260730103000'
  };
  const p = normalizeTengxun(raw);
  assert(p && p.symbol === '600519', 'symbol 抽取正确');
  assert(p.name === '贵州茅台', 'name 抽取正确');
  assert(p.market === 'SH', 'market 推为 SH');
  assert(p.price === 1730, 'price 解析为 number (1730)');
  assert(p.prevClose === 1720, 'prevClose 解析为 1720');
  assert(p.open === 1725, 'open 解析为 1725');
  assert(p.high === 1735, 'high 解析为 1735');
  assert(p.low === 1718, 'low 解析为 1718');
  assert(p.timestamp === '20260730103000', 'timestamp 保留字符串');
});

// ============================================================
// 情形 2: 涨跌幅字符串解析
// ============================================================
describe('情形 2: 涨跌幅字符串解析', () => {
  assert(_pctFromTengxun('0.58%') === 0.0058, '"0.58%" -> 0.0058 (小数)');
  assert(_pctFromTengxun('-1.23%') === -0.0123, '"-1.23%" -> -0.0123');
  assert(_pctFromTengxun(' 0.5 % ') === 0.005, '空格容忍');
  assert(_pctFromTengxun('') === null, '空字符串 -> null');
  assert(_pctFromTengxun('停牌') === null, '"停牌" -> null');
  assert(_pctFromTengxun('-') === null, '"-" -> null');
  assert(_pctFromTengxun(null) === null, 'null -> null');
  assert(_pctFromTengxun('abc%') === null, '乱码 -> null');
});

// ============================================================
// 情形 3: 停牌 (价格字段全部空字符串)
// ============================================================
describe('情形 3: 停牌时所有价格为 null, 不应为 0', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': '', '昨收': '', '今开': '', '最高': '', '最低': '',
    '成交量': '', '总成交额': '',
    '涨跌额': '', '涨跌幅': '停牌',
    '时间': '20260730103000'
  };
  const p = normalizeTengxun(raw);
  assert(p !== null, 'normalize 不返 null (raw 本身有效)');
  assert(p.price === null, '停牌 price = null (不是 0)');
  assert(p.prevClose === null, '停牌 prevClose = null');
  assert(p.change === null, '停牌 change = null (不能算 price-prevClose, 都是 null)');
  assert(p.changePercent === null, '停牌 changePercent = null');
  assert(p.volume === null, '停牌 volume = null');
  assert(p.amount === null, '停牌 amount = null');
  assert(p.symbol === '600519', '停牌时 symbol/name 仍然正确抽取');
  assert(p.name === '贵州茅台', '停牌时 name 仍然正确抽取');
});

// ============================================================
// 情形 4: 量价单位换算 (手 -> 股, 万 -> 元)
// ============================================================
describe('情形 4: 成交量 × 100 (手->股); 成交额 × 10000 (万->元)', () => {
  const raw = {
    '代码': '600519', '名称': '贵州茅台',
    '最新价': '1730.00', '昨收': '1720.00',
    '今开': '1725.00', '最高': '1735.00', '最低': '1718.00',
    '成交量': '12345', '总成交额': '45678.90',
    '换手率': '0.85', '市盈率': '28.5',
    '流通市值': '21730.50', '总市值': '21730.50',
    '涨跌额': '10.00', '涨跌幅': '0.58%',
    '时间': '20260730103000'
  };
  const p = normalizeTengxun(raw);
  assert(p.volume === 1234500, 'volume = 12345 × 100 = 1234500 股');
  assert(p.amount === 456789000, 'amount = 45678.90 × 10000 = 456789000 元');
  assert(p.circMarketCap === 2173050000000, '流通市值 = 21730.50 × 1e8 = 2173050000000 元');
  assert(p.totalMarketCap === 2173050000000, '总市值 同上');
});

// ============================================================
// 情形 5: 缺失字段 (关键字段 undefined)
// ============================================================
describe('情形 5: 关键字段缺失时, normalize 不应崩', () => {
  const raw = {
    '代码': '000001', '名称': '平安银行',
    // 其它字段全部缺失
  };
  const p = normalizeTengxun(raw);
  assert(p !== null, 'normalize 仍然返 payload (而不是 null)');
  assert(p.symbol === '000001', 'symbol 仍然正确');
  assert(p.market === 'SZ', '000xxx 推为 SZ');
  assert(p.price === null, '缺失 price = null');
  assert(p.change === null, '缺失 change = null (不能从 null 减 null)');
  assert(p.changePercent === null, '缺失 changePercent = null');
  assert(p.volume === null, '缺失 volume = null');
  assert(p.timestamp === '', '缺失 timestamp 返空字符串');
});

// ============================================================
// 边界: null / 非对象输入
// ============================================================
describe('边界: null / 非对象输入', () => {
  assert(normalizeTengxun(null) === null, 'normalizeTengxun(null) -> null');
  assert(normalizeTengxun(undefined) === null, 'normalizeTengxun(undefined) -> null');
  assert(normalizeTengxun('字符串') === null, 'normalizeTengxun(字符串) -> null');
  assert(normalizeTengxun({}) !== null, 'normalizeTengxun({}) 仍返 payload (空 raw 也是合法)');
});

// ============================================================
// _marketOf 单元
// ============================================================
describe('_marketOf 推市场', () => {
  assert(_marketOf('600519') === 'SH', '600xxx -> SH');
  assert(_marketOf('000001') === 'SZ', '000xxx -> SZ');
  assert(_marketOf('300059') === 'SZ', '300xxx -> SZ (创业板)');
  assert(_marketOf('500001') === 'SH', '500xxx -> SH (沪市基金)');
  assert(_marketOf('159919') === 'SZ', '159xxx -> SZ (深市基金)');
});

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail > 0 ? 1 : 0);