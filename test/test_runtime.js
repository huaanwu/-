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

// ========== [8] Toast 模块加载 + 函数引用 ==========
section('8] Core.Toast 加载与函数绑定');
const TOAST_PATH = path.join(ROOT, 'www', 'core', 'toast.js');
if (!fs.existsSync(TOAST_PATH)) {
  fail('toast load', `文件不存在: ${TOAST_PATH}`);
} else {
  // 最小 DOM mock(toast.js 用 getElementById + createElement + setTimeout)
  const toastRootChildren = [];
  const toastCtx = vm.createContext({
    window: ctx.window,
    console,
    setTimeout, clearTimeout,
    document: {
      getElementById(id) {
        if (id === 'toastRoot') {
          return {
            appendChild(child) { toastRootChildren.push(child); return child; }
          };
        }
        return null;
      },
      createElement(tag) {
        return {
          tagName: tag,
          className: '',
          textContent: '',
          style: {},
          remove() {}
        };
      }
    }
  });
  try {
    vm.runInContext(fs.readFileSync(TOAST_PATH, 'utf-8'), toastCtx, { filename: TOAST_PATH });
  } catch (e) {
    fail('toast load', `执行失败: ${e.message}`);
  }
  const Toast = toastCtx.window.Core && toastCtx.window.Core.Toast;
  if (!Toast) {
    fail('toast', 'window.Core.Toast 未挂载');
  } else {
    ok('toast.js loaded → window.Core.Toast 已挂载');
    // 函数引用齐
    ['show', 'success', 'error', 'info', 'warning'].forEach(fn => {
      if (typeof Toast[fn] === 'function') ok(`Toast.${fn} 是函数`);
      else fail(`Toast.${fn}`, '类型应为 function');
    });

    // 调用 show:不依赖真实 DOM 写入,但不应抛错
    function t_toast(name, fn, expectedType) {
      toastRootChildren.length = 0;
      try {
        fn(`test-${name}`);
        const last = toastRootChildren[toastRootChildren.length - 1];
        if (last && last.className === `toast ${expectedType}`) ok(`${name} → appendChild class="${last.className}"`);
        else fail(name, `appendChild 内容不符合,实际 className=${last && last.className}`);
      } catch (e) {
        fail(name, `调用抛出: ${e.message}`);
      }
    }
    t_toast('show(info)',     (m) => Toast.show(m, 'info'),         'info');
    t_toast('show(success)',  (m) => Toast.show(m, 'success'),      'success');
    t_toast('show(error)',    (m) => Toast.show(m, 'error'),        'error');
    t_toast('show(warning)',  (m) => Toast.show(m, 'warning'),      'warning');
    t_toast('success()',      (m) => Toast.success(m),              'success');
    t_toast('error()',        (m) => Toast.error(m),                'error');
    t_toast('info()',         (m) => Toast.info(m),                 'info');
    t_toast('warning()',      (m) => Toast.warning(m),              'warning');

    // textContent 透传:用户消息里的 <script> 应作为纯文本(不解析为 HTML)
    toastRootChildren.length = 0;
    Toast.show('<script>alert(1)</script>', 'warning');
    const xssEl = toastRootChildren[toastRootChildren.length - 1];
    if (xssEl && xssEl.textContent === '<script>alert(1)</script>') {
      ok('Toast 用 textContent 而非 innerHTML(XSS 安全)');
    } else {
      fail('Toast XSS', `textContent 应等于原文,实际 ${xssEl && JSON.stringify(xssEl.textContent)}`);
    }

    // 缺 toastRoot 元素时:不抛错,降级 console.log
    const origLog = console.log;
    let logMsg = null;
    console.log = (...args) => { logMsg = args.join(' '); };
    const noRootCtx = vm.createContext({
      window: {},
      console,
      setTimeout, clearTimeout,
      document: { getElementById: () => null }
    });
    vm.runInContext(fs.readFileSync(TOAST_PATH, 'utf-8'), noRootCtx, { filename: TOAST_PATH });
    noRootCtx.window.Core.Toast.show('降级消息', 'error');
    if (logMsg && logMsg.includes('降级消息') && logMsg.includes('error')) {
      ok('Toast.show 无 root 时降级 console.log');
    } else {
      fail('Toast 降级', `日志内容不符: ${logMsg}`);
    }
    console.log = origLog;
  }
}

// ========== [9] StockAdvisor 模块加载 + API 完备 (Phase R) ==========
section('9] StockAdvisor 模块加载 (Phase R)');
const SA_PATH = path.join(ROOT, 'www', 'app', 'stock-advisor.js');
if (!fs.existsSync(SA_PATH)) {
  fail('stock-advisor load', `文件不存在: ${SA_PATH}`);
} else {
  // 模拟 document + 全局函数(toastError / escapeHtml / Fund.closeModal)
  const saMockEls = {};
  const saCtx = vm.createContext({
    window: ctx.window,
    console,
    setTimeout, clearTimeout,
    Date,
    Math,
    JSON,
    parseFloat, parseInt, isNaN,
    navigator: {},
    document: {
      getElementById(id) {
        if (!saMockEls[id]) {
          saMockEls[id] = {
            innerHTML: '',
            textContent: '',
            appendChild(c) { return c; },
            querySelectorAll() { return []; },
            remove() {},
            parentElement: saMockEls[id]
          };
        }
        return saMockEls[id];
      },
      createElement(tag) {
        return {
          tagName: tag,
          className: '',
          style: {},
          dataset: {},
          appendChild(c) { return c; },
          remove() {},
          parentElement: { appendChild(c) { return c; }, querySelectorAll() { return []; } }
        };
      }
    },
    Core: {
      Util: ctx.window.Core.Util,
      Data: {
        getStockFinancial: () => Promise.resolve({}),
        getStockFinancialHistory: () => Promise.resolve([]),
        getAiContextSnapshot: () => Promise.resolve({}),
        getIntlSnapshot: () => Promise.resolve({}),
        getStockQuote: () => Promise.resolve({}),
        formatAiContextForPrompt: () => '',
        formatIntlForPrompt: () => ''
      },
      AI: {
        call: () => Promise.resolve(''),
        selfCheck: () => Promise.resolve('✓ self-check 通过')
      },
      KB: {
        pickRelevant: () => Promise.resolve([]),
        formatForPrompt: () => ''
      },
      Storage: { all: () => Promise.resolve([]) }
    },
    toastError: () => {},
    toastSuccess: () => {},
    Fund: { closeModal: () => {} },
    Promise
  });
  try {
    vm.runInContext(fs.readFileSync(SA_PATH, 'utf-8'), saCtx, { filename: SA_PATH });
  } catch (e) {
    fail('stock-advisor load', `执行失败: ${e.message}`);
  }
  const SA = saCtx.window.StockAdvisor;
  if (!SA) {
    fail('StockAdvisor', 'window.StockAdvisor 未挂载');
  } else {
    ok('stock-advisor.js loaded → window.StockAdvisor 已挂载');
    // 必备 API
    ['show', 'switchTab', 'refresh'].forEach(fn => {
      if (typeof SA[fn] === 'function') ok(`StockAdvisor.${fn} 是函数`);
      else fail(`StockAdvisor.${fn}`, '类型应为 function');
    });

    // _test_extractHistory 字段容错 (Phase R)
    if (typeof SA._test_extractHistory !== 'function') {
      fail('StockAdvisor._test_extractHistory', '未暴露');
    } else {
      const realAkshare = [
        { REPORT_DATE: '2026-03-31', REPORT_TYPE: '一季报',
          TOTALOPERATEREVE: 54702912385.23, TOTALOPERATEREVETZ: 6.34,
          PARENTNETPROFIT: 27242512886.45, PARENTNETPROFITTZ: 1.47,
          KCFJCXSYJLR: 27239985194.41,
          XSMLL: 89.76, XSJLL: 52.22, ROEJQ: 10.57, ZZCJLL: 9.03,
          ZCFZL: 12.12, XJLLB: 0.70, EPSJB: 21.76, BPS: 216.32 },
        { REPORT_DATE: '2025-12-31', REPORT_TYPE: '年报',
          TOTALOPERATEREVE: 188802570000, PARENTNETPROFIT: 89000000000,
          XSMLL: 88.5, ROEJQ: 24.5, ZCFZL: 13.0, EPSJB: 70.0 }
      ];
      const hist = SA._test_extractHistory(realAkshare);
      if (!Array.isArray(hist) || hist.length !== 2) {
        fail('extractHistory', `返回长度异常: ${hist && hist.length}`);
      } else {
        ok('extractHistory: 返回 2 期');
        // 第一期: 大写缩写字段提取
        const r0 = hist[0];
        if (r0.period === '2026-03-31') ok('extractHistory: period=REPORT_DATE 提取正确');
        else fail('extractHistory.period', `实际=${r0.period}`);
        if (r0.revenue === 54702912385.23) ok('extractHistory: revenue=TOTALOPERATEREVE 提取正确');
        else fail('extractHistory.revenue', `实际=${r0.revenue}`);
        if (r0.revenueYoY === 6.34) ok('extractHistory: revenueYoY=TOTALOPERATEREVETZ 提取正确');
        else fail('extractHistory.revenueYoY', `实际=${r0.revenueYoY}`);
        if (r0.netProfit === 27242512886.45) ok('extractHistory: netProfit=PARENTNETPROFIT 提取正确');
        else fail('extractHistory.netProfit', `实际=${r0.netProfit}`);
        if (r0.grossMargin === 89.76) ok('extractHistory: grossMargin=XSMLL 提取正确');
        else fail('extractHistory.grossMargin', `实际=${r0.grossMargin}`);
        if (r0.roe === 10.57) ok('extractHistory: roe=ROEJQ 提取正确');
        else fail('extractHistory.roe', `实际=${r0.roe}`);
        if (r0.debtRatio === 12.12) ok('extractHistory: debtRatio=ZCFZL 提取正确');
        else fail('extractHistory.debtRatio', `实际=${r0.debtRatio}`);
        if (r0.eps === 21.76) ok('extractHistory: eps=EPSJB 提取正确');
        else fail('extractHistory.eps', `实际=${r0.eps}`);
        if (r0.bps === 216.32) ok('extractHistory: bps=BPS 提取正确');
        else fail('extractHistory.bps', `实际=${r0.bps}`);
        if (r0.cashflowRatio === 0.70) ok('extractHistory: cashflowRatio=XJLLB 提取正确');
        else fail('extractHistory.cashflowRatio', `实际=${r0.cashflowRatio}`);

        // 兼容旧中文键名 (新浪 stock_financial_abstract 等)
        const legacyRaw = [
          { 报告日期: '2025-12-31', 营业总收入: 100000000, 净利润: 50000000,
            销售毛利率: 30, ROE: 15, 资产负债率: 50, EPS: 1.5 }
        ];
        const histLegacy = SA._test_extractHistory(legacyRaw);
        if (histLegacy && histLegacy[0] && histLegacy[0].revenue === 100000000) {
          ok('extractHistory: 兼容中文键名 (新浪版)');
        } else {
          fail('extractHistory legacy', `中文键名 fallback 失败: ${JSON.stringify(histLegacy)}`);
        }

        // 空数组返回 null
        if (SA._test_extractHistory([]) === null) ok('extractHistory: 空数组 → null');
        else fail('extractHistory empty', '应返回 null');

        // 非数组返回 null
        if (SA._test_extractHistory(null) === null && SA._test_extractHistory({}) === null) {
          ok('extractHistory: 非数组 → null');
        } else {
          fail('extractHistory non-array', '应返回 null');
        }

        // 只取最近 4 期
        const six = SA._test_extractHistory(Array.from({length: 6}, (_, i) => ({
          REPORT_DATE: `2025-${String(i+1).padStart(2,'0')}-01`, TOTALOPERATEREVE: i * 1000
        })));
        if (six && six.length === 4) ok('extractHistory: 超过 4 期只取前 4');
        else fail('extractHistory cap', `应=4, 实际=${six && six.length}`);
      }
    }
  }
}

// ========== 总结 ==========
console.log('');
console.log(`\x1b[1m结果:\x1b[0m 通过 ${passed}, 失败 ${failed}`);
if (failed > 0) {
  console.log('\x1b[31m失败用例:\x1b[0m');
  errors.forEach(e => console.log(`  - ${e}`));
  process.exit(1);
}
process.exit(0);