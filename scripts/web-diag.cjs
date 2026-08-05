#!/usr/bin/env node
/**
 * V13 web 界面诊断 (简洁版): 用 vm sandbox 加载全部 index.html 引用的脚本,
 * 只输出文件名和错误消息, 不输出源码。
 */
'use strict';
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'www');

// 模拟浏览器全局 (最小集, 不够的让 vm throw 我们抓住)
const sandbox = {};
function buildSandbox() {
  const s = {
    window: sandbox,
    self: sandbox,
    global: sandbox,
    top: sandbox,
    parent: sandbox,
    document: {
      querySelector: () => null, addEventListener: () => {},
      createElement: () => ({}), body: { appendChild: () => {} },
      getElementById: () => null, title: 'SM', createTextNode: () => ({}),
      documentElement: { style: {} },
      createComment: () => ({}),
    },
    console: { log: () => {}, warn: () => {}, error: (e) => { if (typeof e === 'string') scriptErrors.push(e); }, info: () => {}, debug: () => {} },
    setTimeout: (fn) => { fn(); return 1; },
    setInterval: () => 1, clearTimeout: () => {}, clearInterval: () => {},
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}), text: () => Promise.resolve(''), blob: () => Promise.resolve({}) }),
    navigator: { userAgent: 'SM', language: 'zh-CN' },
    location: { href: 'http://localhost:3003/', hash: '', search: '', pathname: '/', reload: () => {} },
    history: { pushState: () => {}, replaceState: () => {} },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    Notification: { requestPermission: () => Promise.resolve('granted'), permission: 'granted' },
    alert: () => {}, confirm: () => true, prompt: () => null,
    indexedDB: { open: () => ({ onerror: null, onupgradeneeded: null, onsuccess: null, result: {} }) },
    Worker: class { postMessage(){} terminate(){} addEventListener(){} },
    CustomEvent: class { constructor(t){this.type=t} },
    addEventListener: () => {}, dispatchEvent: () => {},
    requestAnimationFrame: (fn) => { fn(); return 0; },
    postMessage: () => {},
    XMLHttpRequest: class { open(){} send(){} setRequestHeader(){} },
    Blob: class { constructor(p){this.parts=p} },
    URL: { createObjectURL: () => 'blob:', revokeObjectURL: () => {} },
    Promise: Promise,
    Reflect: Reflect,
    Proxy: Proxy,
    Array: Array, Object: Object, String: String, Number: Number, Boolean: Boolean,
    Map: Map, Set: Set, WeakMap: WeakMap, WeakSet: WeakSet,
    RegExp: RegExp, Date: Date, Math: Math, JSON: JSON,
    Error: Error, TypeError: TypeError, RangeError: RangeError, SyntaxError: SyntaxError,
    isNaN: isNaN, parseInt: parseInt, parseFloat: parseFloat,
    encodeURI: encodeURI, encodeURIComponent: encodeURIComponent,
    decodeURI: decodeURI, decodeURIComponent: decodeURIComponent,
    undefined: undefined, null: null, true: true, false: false,
    Uint8Array: Uint8Array, Uint16Array: Uint16Array, Uint32Array: Uint32Array,
    Int8Array: Int8Array, Int16Array: Int16Array, Int32Array: Int32Array,
    Float32Array: Float32Array, Float64Array: Float64Array,
    ArrayBuffer: ArrayBuffer, DataView: DataView,
    TextEncoder: class { encode(s){return Buffer.from(s,'utf8')} },
    TextDecoder: class { decode(b){return Buffer.from(b).toString('utf8')} },
    MutationObserver: class { observe(){} disconnect(){} },
    IntersectionObserver: class { observe(){} unobserve(){} disconnect(){} },
    ResizeObserver: class { observe(){} unobserve(){} disconnect(){} },
    crypto: { randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==='x'?r:(r&0x3|0x8)).toString(16); }) },
    matchMedia: () => ({ matches: false, addListener: () => {}, removeListener: () => {} }),
    screen: { width: 1920, height: 1080 },
  };
  Object.assign(sandbox, s);
  return vm.createContext(sandbox);
}

const scriptErrors = [];
const ctx = buildSandbox();
const errors = [];

function loadScript(filePath, displayName) {
  try {
    const code = fs.readFileSync(filePath, 'utf8');
    vm.runInContext(code, ctx, { filename: displayName, timeout: 5000 });
    return true;
  } catch (e) {
    const short = e.message.split('\n')[0].slice(0, 150);
    errors.push({ file: displayName, msg: short });
    return false;
  }
}

function decodeName(raw) {
  // for feishu-app-settings etc that use decodeURIComponent in source
  return raw;
}

// ---- 1. 库 ----
loadScript(path.join(ROOT, 'lib', 'echarts.min.js'), 'lib/echarts.min.js');
loadScript(path.join(ROOT, 'lib', 'dexie.min.js'), 'lib/dexie.min.js');

// ---- 2. Core ----
const coreFiles = [
  'util.js', 'storage.js', 'settings-sync.js', 'data.js',
  'data/schema.js', 'data/normalize.js', 'data/provenance.js', 'data/facade.js',
  'similar-market.js', 'kb.js', 'alerts-agent.js', 'risk-mine.js',
  'scoring.js', 'weight-advisor.js', 'user-profile.js',
  'state.js', 'constants.js', 'portfolio.js', 'discipline.js', 'pending.js',
  'premortem.js', 'prebacktest.js', 'crosscheck.js',
  'toast.js', 'ai-service.js', 'behavioral.js',
  'research-pool.js',
  'agent.js', 'agent-tools.js', 'ai-call-log.js',
  'ai/effect-request.js', 'ai/tool-registry.js', 'ai/tracing.js', 'ai/orchestrator.js',
  'ai/entry.js',
  'ai/policy-bundle.js', 'ai/weekly-attribution.js', 'ai/post-mortem.js', 'ai/kb-feedback.js',
  'scheduler.js',
  'self-consistency.js', 'learning-pool.js',
  'macro.js', 'cycle.js', 'screener-rules.js', 'state-matrix.js',
  'news.js', 'market.js', 'sync.js',
  'agents.js',
  'router.js', 'market-width.js', 'regime.js',
];
for (const f of coreFiles) loadScript(path.join(ROOT, 'core', f), 'core/' + f);

// ---- 3. App ----
const appFiles = [
  'research-pool.js',
  'watchlist.js', 'stock-advisor.js', 'holdings.js', 'paper.js',
  'short-trader.js', 'long-trader.js',
  'weekly-review.js',
  'journal.js', 'screener.js',
  'fund.js', 'fund/macro-bar.js', 'fund/news-bar.js', 'fund/seed.js',
  'fund/ai-advisor.js', 'fund/portfolio-risk.js', 'fund/news-impact.js',
  'fund/rebalance.js', 'fund/buy-import.js', 'fund/weekly-report.js',
  'backtest.js', 'alerts.js', 'account.js', 'market-bar.js',
  'agent-ui.js',
  'feishu-app-settings.js',
];
for (const f of appFiles) loadScript(path.join(ROOT, 'app', f), 'app/' + f);

// ---- 4. app.js ----
loadScript(path.join(ROOT, 'app.js'), 'app.js');

// ---- 报告 ----
const ok = 72 + 10 - errors.length;
console.log(`成功: ${ok}  失败: ${errors.length}`);
for (const e of errors) console.log(`❌ ${e.file}: ${e.msg}`);
if (errors.length === 0) console.log('✅ 全部脚本加载成功');
