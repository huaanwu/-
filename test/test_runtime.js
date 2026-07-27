#!/usr/bin/env node
/**
 * StockMaster 运行时单元测试
 * 跑法: node test/test_runtime.js  或  npm test
 *
 * 测试 Core.Util 关键函数的运行时行为:
 *   - escapeHtml: XSS 防护边界
 *   - parseStockInput: 股票代码格式解析
 *   - fmtNum / fmtPct / fmtMoney: 数值格式化与 nullish 处理
 *
 * 加载方式: util.js 是浏览器侧 IIFE,这里用 vm sandbox 喂一个最小 window 全局,
 *          然后从 sandbox 里读出 window.Core.Util。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const UTIL_PATH = path.join(ROOT, 'www', 'core', 'util.js');

let passed = 0, failed = 0;
const errors = [];

function ok(name) { console.log(`  \x1b[32m✓\x1b[0b ${name}`); passed++; }
function fail(name, msg) { console.log(`  \x1b[31m✗\x1b[0b ${name}: ${msg}`); failed++; errors.push(`${name}: ${msg}`); }
function section(title) { console.log(`\n\x1b[1m[${title}]\x1b[0b`); }
function eq(a, b) { return Object.is(a, b); }

// ========== 加载 util.js ==========
section('0] 加载 www/core/util.js');
if (!fs.existsSync(UTIL_PATH)) {
  fail('load', `文件不存在: ${UTIL_PATH}`);
  process.exit(1);
}
const source = fs.readFileSync(UTIL_PATH, 'utf-8');
const ctx = vm.createContext({
  window: {},
  console,
  setTimeout, clearTimeout,
});
try {
  vm.runInContext(source, ctx, { filename: UTIL_PATH });
} catch (e) {
  fail('load', `执行 util.js 失败: ${e.message}`);
  process.exit(1);
}
const Util = ctx.window.Core && ctx.window.Core.Util;
if (!Util) {
  fail('load', 'window.Core.Util 未挂载');
  process.exit(1);
}
const { escapeHtml, parseStockInput, fmtNum, fmtPct, fmtMoney, pctClass, uuid } = Util;
ok('util.js loaded → window.Core.Util 已挂载');

// ========== [1] escapeHtml XSS 防护 ==========
section('1] escapeHtml XSS 边界');
function t_escape(name, input, expected) {
  const got = escapeHtml(input);
  if (got === expected) ok(name);
  else fail(name, `期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(got)}`);
}
t_escape('null → ""',          null,                                                '');
t_escape('undefined → ""',     undefined,                                           '');
t_escape('空字符串',           '',                                                  '');
t_escape('& 转义',             '&',                                                 '&amp;');
t_escape('< 转义',             '<',                                                 '&lt;');
t_escape('> 转义',             '>',                                                 '&gt;');
t_escape('" 转义',             '"',                                                 '&quot;');
t_escape("' 转义",             "'",                                                 '&#39;');
t_escape('完整 XSS 注入',      '<script>alert(1)</script>',                         '&lt;script&gt;alert(1)&lt;/script&gt;');
t_escape('属性注入',           '" onerror="x',                                      '&quot; onerror=&quot;x');
t_escape('混合字符',           '<a href="x">b&c</a>',                              '&lt;a href=&quot;x&quot;&gt;b&amp;c&lt;/a&gt;');
t_escape('中文 + 数字',        '茅台 600519',                                       '茅台 600519');
t_escape('emoji 不变',         '🚀 StockMaster',                                    '🚀 StockMaster');

// ========== [2] parseStockInput ==========
section('2] parseStockInput 格式解析');
function t_parse(name, input, expectedCode, expectedName) {
  const got = parseStockInput(input);
  if (!got && expectedCode === null) return ok(name);
  if (!got) return fail(name, `期望 ${JSON.stringify({code: expectedCode, name: expectedName})}, 实际 null`);
  if (got.code === expectedCode && got.name === expectedName) ok(name);
  else fail(name, `期望 ${JSON.stringify({code: expectedCode, name: expectedName})}, 实际 ${JSON.stringify(got)}`);
}
t_parse('标准格式 600519 贵州茅台',     '600519 贵州茅台',    '600519', '贵州茅台');
t_parse('中文逗号',                     '600519，贵州茅台',   '600519', '贵州茅台');
t_parse('英文逗号',                     '600519,Kweichow',    '600519', 'Kweichow');
t_parse('纯代码',                       '000001',             '000001', '');
t_parse('sz 前缀无法解析',              'sz000002',           null,    null);  // 源码 ^(\d{6}) 锚字符串开头,前缀不匹配
t_parse('含 .SZ 后缀',                  '300750.SZ',          '300750', '.SZ');  // 后缀算进 name
t_parse('非法输入 abc',                 'abc',                null,    null);
t_parse('空字符串',                     '',                   null,    null);
t_parse('null',                         null,                 null,    null);
t_parse('undefined',                    undefined,            null,    null);
t_parse('含中文但无数字',               '贵州茅台',           null,    null);

// ========== [3] fmtNum ==========
section('3] fmtNum 数值格式化');
function t_fmtNum(name, input, decimals, expected) {
  const got = fmtNum(input, decimals);
  if (got === expected) ok(name);
  else fail(name, `fmtNum(${JSON.stringify(input)}, ${decimals}) 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(got)}`);
}
t_fmtNum('null',                  null,            2, '-');
t_fmtNum('undefined',             undefined,       2, '-');
t_fmtNum('NaN',                   NaN,             2, '-');
t_fmtNum('0',                     0,               2, '0.00');
t_fmtNum('1234.5 默认 2 位',      1234.5,          2, '1,234.50');
t_fmtNum('负数',                  -1234.5,         2, '-1,234.50');
t_fmtNum('decimals=0',            1234.5,          0, '1,235');
t_fmtNum('decimals=4',            1.234567,        4, '1.2346');
t_fmtNum('大数',                  1234567.89,      2, '1,234,567.89');
t_fmtNum('负零(JS 原生行为)',      -0,              2, '-0.00');

// ========== [4] fmtPct(注意乘 100 行为) ==========
section('4] fmtPct 百分比(小数 × 100)');
function t_fmtPct(name, input, decimals, expected) {
  const got = fmtPct(input, decimals);
  if (got === expected) ok(name);
  else fail(name, `fmtPct(${JSON.stringify(input)}, ${decimals}) 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(got)}`);
}
t_fmtPct('null',                  null,            2, '-');
t_fmtPct('undefined',             undefined,       2, '-');
t_fmtPct('NaN',                   NaN,             2, '-');
t_fmtPct('0 → +0.00%(源码行为)',  0,               2, '+0.00%');  // v >= 0 加 + 号
t_fmtPct('0.0256 → +2.56%',       0.0256,          2, '+2.56%');
t_fmtPct('负数 -0.0134',          -0.0134,         2, '-1.34%');
t_fmtPct('decimals=0',            0.0256,          0, '+3%');
t_fmtPct('decimals=4',            0.025678,        4, '+2.5678%');
t_fmtPct('1 → +100.00%',          1,               2, '+100.00%');
t_fmtPct('-1 → -100.00%',         -1,              2, '-100.00%');

// ========== [5] fmtMoney ==========
section('5] fmtMoney 带 ¥ 前缀');
function t_fmtMoney(name, input, decimals, expected) {
  const got = fmtMoney(input, decimals);
  if (got === expected) ok(name);
  else fail(name, `fmtMoney(${JSON.stringify(input)}, ${decimals}) 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(got)}`);
}
t_fmtMoney('null',                null,            2, '-');
t_fmtMoney('undefined',           undefined,       2, '-');
t_fmtMoney('NaN',                 NaN,             2, '-');
t_fmtMoney('0',                   0,               2, '¥0.00');
t_fmtMoney('12345',               12345,           2, '¥12,345.00');
t_fmtMoney('负数',                -1234.5,         2, '¥-1,234.50');
t_fmtMoney('大数',                1234567.89,      2, '¥1,234,567.89');

// ========== [6] pctClass 涨跌色 ==========
section('6] pctClass 涨跌色 class');
function t_pctClass(name, input, expected) {
  const got = pctClass(input);
  if (got === expected) ok(name);
  else fail(name, `pctClass(${JSON.stringify(input)}) 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(got)}`);
}
t_pctClass('null',                null,            'flat');
t_pctClass('undefined',           undefined,       'flat');
t_pctClass('NaN',                 NaN,             'flat');
t_pctClass('正',                  0.05,            'up');
t_pctClass('负',                  -0.05,           'down');
t_pctClass('零',                  0,               'flat');

// ========== [7] uuid 格式 ==========
section('7] uuid 格式校验');
const u = uuid();
if (typeof u === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(u)) {
  ok(`uuid 格式正确: ${u}`);
} else {
  fail('uuid', `格式不符: ${u}`);
}
// 两次生成应当不同
if (uuid() !== uuid()) ok('uuid 两次不同');
else fail('uuid 重复', '两次调用产生相同 UUID');

// ========== 总结 ==========
console.log('');
console.log(`\x1b[1m结果:\x1b[0m 通过 ${passed}, 失败 ${failed}`);
if (failed > 0) {
  console.log('\x1b[31m失败用例:\x1b[0m');
  errors.forEach(e => console.log(`  - ${e}`));
  process.exit(1);
}
process.exit(0);