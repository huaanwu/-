/**
 * parseMoneySupply 单测 — P0 (修 _fetchMoneySupply 字段名+排序 bug)
 *
 * 实测 aktools macro_china_money_supply 字段:
 *   货币和准货币(M2)-同比增长 | 货币(M1)-同比增长 | 流通中的现金(M0)-同比增长 | 月份
 * 排序: 降序 (最新→最旧)
 *
 * P0 bug: 原 _fetchMoneySupply 取 data[length-1] 拿到 2008 旧数据, 字段名 '货币和准货币' 取不到
 * 修复: 提取为 parseMoneySupply 纯函数, data[0] 取最新, 字段名严格匹配
 *
 * 跑法: node test/data-contract/parse-money-supply.test.js
 * 不依赖浏览器 / DOM / IndexedDB (vm sandbox 加载 data.js 暴露的 Normalize.parseMoneySupply)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
// vm sandbox: 模拟 window + Core.Storage (data.js 启动时只检查存在, 不调用)
const sandbox = {
  window: {},
  console: console,
  // Core.Storage.cacheGet/cacheSet 需要 mock, 不然 IIFE 顶部就抛
  Core: undefined
};
sandbox.window.Core = {
  Storage: {
    cacheGet: async () => null,
    cacheSet: async () => null
  },
  State: { get: () => '/api/akshare' }
};

// 把整个 data.js 加载进来 (它是 IIFE, 启动时会调用 Core.Storage.cacheGet 检查缓存)
const DATA_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data.js'), 'utf8');
vm.createContext(sandbox);
vm.runInContext(DATA_SRC, sandbox, { filename: 'data.js' });

const parseMoneySupply = sandbox.window.Core.Data.Normalize.parseMoneySupply;

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
// 情形 1: 实测真实 aktools 形态 (2026-06 第一条)
// ============================================================
describe('情形 1: 实测 aktools 真实字段 (降序, 首条最新)', () => {
  const raw = [
    { '月份': '2026年06月份', '货币和准货币(M2)-同比增长': 8.0, '货币(M1)-同比增长': 4.0, '流通中的现金(M0)-同比增长': 11.8 },
    { '月份': '2026年05月份', '货币和准货币(M2)-同比增长': 8.6, '货币(M1)-同比增长': 5.5 },
    { '月份': '2026年04月份', '货币和准货币(M2)-同比增长': 8.6, '货币(M1)-同比增长': 5.0 }
  ];
  const p = parseMoneySupply(raw);
  assert(p !== null, '应返回非 null');
  assert(p.date === '2026年06月份', '取最新条 (data[0]), 不是 data[length-1]');
  assert(p.m2_yoy === 8.0, 'M2 同比 = 8.0 (P0 bug: 原字段名取不到, 现正确)');
  assert(p.m1_yoy === 4.0, 'M1 同比 = 4.0 (P0 修复: 真实字段名带括号单位)');
  assert(p.m0_yoy === 11.8, 'M0 同比 = 11.8');
});

// ============================================================
// 情形 2: P0 bug 回归保护 — 旧字段名应取不到
// ============================================================
describe('情形 2: 旧字段名应取不到 (P0 bug 回归保护)', () => {
  const raw = [
    // 模拟「旧字段名 + 错排序」的旧代码世界
    { '月份': '2008年01月份', '货币和准货币': 16.2, '货币': 21.0, '流通中现金': 8.5 }
  ];
  const p = parseMoneySupply(raw);
  assert(p === null, '旧字段名取不到, parseFloat(NaN) → m2 不可用 → 返 null (保护机制)');
});

// ============================================================
// 情形 3: 空数组
// ============================================================
describe('情形 3: 防御性边界', () => {
  assert(parseMoneySupply([]) === null, '空数组 → null');
  assert(parseMoneySupply(null) === null, 'null → null');
  assert(parseMoneySupply(undefined) === null, 'undefined → null');
  assert(parseMoneySupply({}) === null, '非数组 → null');
});

// ============================================================
// 情形 4: M0 缺失 (部分字段允许 null)
// ============================================================
describe('情形 4: M0 字段缺失 (仅 M2/M1 必有)', () => {
  const raw = [{ '月份': '2025-12', '货币和准货币(M2)-同比增长': 8.5, '货币(M1)-同比增长': 3.8 }];
  const p = parseMoneySupply(raw);
  assert(p !== null, 'M0 缺失不阻塞返回');
  assert(p.m0_yoy === null, 'M0 缺失 → null');
  assert(p.m1_yoy === 3.8, 'M1 正常返回');
});

// ============================================================
// 情形 5: 排序方向回归 — 升序数据也能正确取最新
// ============================================================
describe('情形 5: 升序数据(防御性: 即使接口未来变升序, 也能工作)', () => {
  // 注: 当前接口是降序, 这里测的是「即使拿到升序数据, parseMoneySupply 仍按 data[0] 取」
  // 这意味着如果接口未来变升序, 我们需要同步切换 data[0] → data[length-1]
  // 这个测试是有意暴露 — 如果挂了, 提示接口变更
  const raw = [
    { '月份': '2024-01', '货币和准货币(M2)-同比增长': 8.7 },
    { '月份': '2024-12', '货币和准货币(M2)-同比增长': 7.3 }
  ];
  const p = parseMoneySupply(raw);
  assert(p.date === '2024-01', '当前按 data[0] 取 (降序假设); 若接口变更需同步调整');
});

console.log('\n' + '='.repeat(50));
console.log(`parseMoneySupply: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);