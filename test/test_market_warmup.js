/* eslint-disable */
// vm sandbox test for Market.warmup
// Run: node test/test_market_warmup.js
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const WWW = path.join(ROOT, 'www');
const src = fs.readFileSync(path.join(WWW, 'core', 'market.js'), 'utf-8');

let passed = 0, failed = 0;
const ok = (n) => { console.log(`  \x1b[32m✓\x1b[0b ${n}`); passed++; };
const fail = (n, m) => { console.log(`  \x1b[31m✗\x1b[0b ${n}: ${m}`); failed++; };
const eq = (a, b, msg) => ((JSON.stringify(a) === JSON.stringify(b)) ? ok(msg) : fail(msg, `expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`));
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  // ---- sandbox 1: warmup 走通 (无缓存 → 拉 wide+style → 拿到 mock items) ----
  console.log('\n[1] warmup cold path');
  {
    const fakeStore = {};
    const sandbox = {
      window: {},
      console,
      Date,
      setTimeout,
      Promise,
      fetch: () => Promise.reject(new Error('no network in test')),
      Core: {
        Data: {
          getStockSpotTencent: async () => {
            throw new Error('network off');
          }
        },
        Storage: {
          cacheGet: async (key) => fakeStore[key] || null,
          cacheSet: async (key, val) => { fakeStore[key] = val; }
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;

    // stub _fetchIndices to return mock items (we can't hit Tencent)
    // _fetchIndices is closure-private, but Market.get uses Core.Data.getStockSpotTencent.
    // We mock getStockSpotTencent above to throw — so Market.get will fail.
    // Better: stub via Market.get directly? No — warmup calls this.get(...).
    // So we monkey-patch Market.get to return mock snapshots.
    const wideItems = [{ code: 'sh000001', name: '上证指数', price: 3245.67, change: 0.85, changeAmt: 27.4 }];
    const styleItems = [{ code: 'sh000016', name: '上证50', price: 2789.12, change: -0.32, changeAmt: -8.9 }];
    Market.get = async (group) => ({
      group,
      items: group === 'wide' ? wideItems : styleItems,
      top: [], bottom: [],
      ts: Date.now(),
      stale: false
    });

    Market.warmup();
    await wait(60);
    const snap = fakeStore['market_warmup'];
    if (!snap) fail('warmup 写入快照', 'fakeStore[market_warmup] 为空');
    else {
      if (Array.isArray(snap.wide) && snap.wide.length === 1 && snap.wide[0].code === 'sh000001') ok('wide items 落地');
      else fail('wide items', JSON.stringify(snap.wide));
      if (Array.isArray(snap.style) && snap.style.length === 1 && snap.style[0].code === 'sh000016') ok('style items 落地');
      else fail('style items', JSON.stringify(snap.style));
      if (typeof snap.ts === 'number' && Date.now() - snap.ts < 5000) ok('snap.ts 新鲜');
      else fail('snap.ts', String(snap.ts));
    }
  }

  // ---- sandbox 2: force=false + 新鲜缓存 → 跳过网络 ----
  console.log('\n[2] warmup fresh-cache short-circuit');
  {
    let getCalls = 0;
    const freshSnap = { wide: [{ code: 'sh000001', name: '上证指数', price: 1, change: 0, changeAmt: 0 }], style: [], ts: Date.now() };
    const sandbox = {
      window: {},
      console,
      Date,
      setTimeout,
      Promise,
      Core: {
        Data: {},
        Storage: {
          cacheGet: async (key) => key === 'market_warmup' ? freshSnap : null,
          cacheSet: async () => {}
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;
    Market.get = async () => { getCalls++; return { items: [] }; };
    Market.warmup();
    await wait(60);
    if (getCalls === 0) ok('未调 Market.get, 走缓存短路');
    else fail('缓存短路', `Market.get 被调 ${getCalls} 次`);
  }

  // ---- sandbox 3: force=true → 无视缓存, 强行拉 ----
  console.log('\n[3] warmup force=true 绕过缓存');
  {
    let getCalls = 0;
    const freshSnap = { wide: [], style: [], ts: Date.now() };
    const sandbox = {
      window: {},
      console,
      Date,
      setTimeout,
      Promise,
      Core: {
        Data: {},
        Storage: {
          cacheGet: async (key) => key === 'market_warmup' ? freshSnap : null,
          cacheSet: async () => {}
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;
    Market.get = async () => { getCalls++; return { items: [] }; };
    Market.warmup({ force: true });
    await wait(60);
    if (getCalls === 2) ok('强制拉 wide+style 各一次 (2 次 get 调用)');
    else fail('force=true', `expected 2 get calls, got ${getCalls}`);
  }

  // ---- sandbox 4: opts.delay → setTimeout 包一层 ----
  console.log('\n[4] warmup delay 延迟触发');
  {
    let getCalls = 0;
    const sandbox = {
      window: {},
      console,
      Date,
      setTimeout,
      Promise,
      Core: {
        Data: {},
        Storage: {
          cacheGet: async () => null,
          cacheSet: async () => {}
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;
    Market.get = async () => { getCalls++; return { items: [] }; };
    const t0 = Date.now();
    Market.warmup({ delay: 100 });
    await wait(20);
    if (getCalls === 0) ok('20ms 内未触发 (delay=100 起效)');
    else fail('delay 提前触发', `getCalls=${getCalls}`);
    await wait(150);
    if (getCalls === 2 && Date.now() - t0 >= 100) ok('100ms 后 wide+style 都触发');
    else fail('delay 后未触发', `getCalls=${getCalls}, elapsed=${Date.now() - t0}`);
  }

  // ---- sandbox 5: get() 内部抛 → warmup 不抛, 只 console.warn ----
  console.log('\n[5] warmup 异常吞掉 (fire-and-forget)');
  {
    const warns = [];
    const sandbox = {
      window: {},
      console: { ...console, warn: (m) => warns.push(String(m)) },
      Date,
      setTimeout,
      Promise,
      Core: {
        Data: {},
        Storage: {
          cacheGet: async () => { throw new Error('cacheGet boom'); },
          cacheSet: async () => {}
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;
    Market.get = async () => { throw new Error('network down'); };
    let threw = false;
    try {
      Market.warmup();
    } catch (e) { threw = true; }
    await wait(60);
    if (!threw) ok('同步调用未抛');
    else fail('warmup 同步抛', '');
    const sawWarn = warns.some(w => w.includes('warmup'));
    if (sawWarn) ok('console.warn 命中 "warmup" 关键字');
    else fail('console.warn', JSON.stringify(warns));
  }

  // ---- sandbox 6: get/refresh 签名未变 ----
  console.log('\n[6] get/refresh 签名保持');
  {
    const sandbox = {
      window: {},
      console,
      Date,
      setTimeout,
      Promise,
      Core: {
        Data: {},
        Storage: {
          cacheGet: async () => null,
          cacheSet: async () => {}
        }
      }
    };
    sandbox.window.Core = sandbox.Core;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(src, ctx);
    const Market = ctx.window.Core.Market;
    if (Market.get.constructor.name === 'AsyncFunction' && Market.get.length === 1) ok('get(group) async, arity=1');
    else fail('get 签名', `ctor=${Market.get.constructor.name}, arity=${Market.get.length}`);
    if (Market.refresh.constructor.name === 'AsyncFunction' && Market.refresh.length === 1) ok('refresh(group) async, arity=1');
    else fail('refresh 签名', `ctor=${Market.refresh.constructor.name}, arity=${Market.refresh.length}`);
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });