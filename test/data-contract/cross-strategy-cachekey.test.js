/**
 * G1 cacheKey 跨策略隔离回归测试
 *
 * 覆盖:
 *   1. _strategyKey 纯函数: 'long' → 加 :long 段, 'default' → 保持原 key
 *   2. _strategyCacheGet 双查: 优先新 key, miss 降级读 legacy
 *   3. _strategyCacheSet 双写: 写新 key + legacy (legacy TTL + 7 天)
 *   4. strategy='default' 时 _strategyCacheGet / Set 不写 legacy (零回归)
 *   5. cacheGet 互不污染: strategy=A 写的数据, strategy=B 读不到 (用 baseKey 错误降级路径验证)
 *
 * 跑法: node test/data-contract/cross-strategy-cachekey.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data.js'), 'utf8');

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
function describe(name, fn) { console.log('\n' + name); fn(); }

// vm sandbox: 构造 Storage cacheMock (暴露 cacheGet / cacheSet 记录调用)
function buildDataSandbox() {
  const cache = new Map();  // key -> { value, expiresAt }
  // 模拟 cacheGet: 查 key, 过 TTL 返 null
  function cacheGet(key) {
    const entry = cache.get(key);
    if (!entry) return Promise.resolve(null);
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return Promise.resolve(null);
    }
    return Promise.resolve(entry.value);
  }
  function cacheSet(key, value, ttl) {
    cache.set(key, { value, expiresAt: Date.now() + ttl });
    return Promise.resolve();
  }
  // 记录所有 cacheSet 调用 (key + ttl), 验证双写
  const cacheSets = [];
  const origCacheSet = cacheSet;
  function trackedCacheSet(key, value, ttl) {
    cacheSets.push({ key, ttl });
    return origCacheSet(key, value, ttl);
  }

  const sandbox = {
    window: {},
    console: console,
    Date,
    Math,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch,
    location: { origin: 'http://localhost:3003' }
  };
  sandbox.window.Core = {
    Constants: {
      LONG_TRADER_CHECK_MS: 1800000, LONG_TRADER_TOP_N: 3, LONG_TRADER_HARD_SCREEN_TOP: 30,
      LONG_TRADER_RERUN_DAYS: 7, LONG_TRADER_MIN_CASH: 5000, LONG_TRADER_LOG_LIMIT: 100,
      LOT_SIZE: 100, STOP_LOSS_RATIO_AUTO: 0.08, MAX_SINGLE_STOCK_PCT: 0.2,
      CACHE_TTL_HOT: 60000, CACHE_TTL_WARM: 300000
    },
    State: { get: () => '' },
    Storage: {
      cacheGet,
      cacheSet: trackedCacheSet
    },
    Util: { uuid: () => 'u-' + Math.random().toString(36).slice(2, 8) }
  };
  vm.createContext(sandbox);
  vm.runInContext(DATA_SRC, sandbox, { filename: 'data.js' });
  return { sandbox, cache, cacheSets };
}

// ============================================================
// 情形 1: _strategyKey 纯函数
// ============================================================
describe('情形 1: _strategyKey 纯函数', () => {
  const { sandbox } = buildDataSandbox();
  const fn = sandbox.window.Core.Data._strategyKey;
  if (typeof fn !== 'function') { fail('_strategyKey 未暴露 (G1 helper 缺失)'); return; }
  assert(fn('kline_600519_daily', 'long') === 'kline_600519_daily:long', 'strategy=long 加 :long 段');
  assert(fn('kline_600519_daily', 'short') === 'kline_600519_daily:short', 'strategy=short 加 :short 段');
  assert(fn('kline_600519_daily', 'fund') === 'kline_600519_daily:fund', 'strategy=fund 加 :fund 段');
  assert(fn('kline_600519_daily', 'default') === 'kline_600519_daily', 'strategy=default 保持原 key');
  assert(fn('kline_600519_daily', undefined) === 'kline_600519_daily', 'strategy=undefined 保持原 key');
  assert(fn('kline_600519_daily', '') === 'kline_600519_daily', 'strategy=空字符串保持原 key');
});

// ============================================================
// 情形 2: _strategyCacheGet 双查 + legacy 降级
// ============================================================
describe('情形 2: _strategyCacheGet 双查 (新 key → legacy 降级)', async () => {
  const { sandbox, cache } = buildDataSandbox();
  const fn = sandbox.window.Core.Data._strategyCacheGet;
  if (typeof fn !== 'function') { fail('_strategyCacheGet 未暴露'); return; }

  // 仅 legacy 有数据 (模拟旧 APK 写过的)
  await sandbox.window.Core.Storage.cacheSet('kline_600519_daily', { price: 10, legacy: true }, 60000);
  const v1 = await fn('kline_600519_daily', 'long');
  assert(v1 === null, 'strategy=long 无新 key 时不降级读 legacy (避免跨策略污染), 返 null');

  // default 策略显式允许读 legacy
  const v1default = await fn('kline_600519_daily', 'default');
  assert(v1default && v1default.legacy === true, 'strategy=default 显式降级读 legacy');

  // 写新 key
  await sandbox.window.Core.Storage.cacheSet('kline_600519_daily:long', { price: 12, fresh: true }, 60000);
  const v2 = await fn('kline_600519_daily', 'long');
  assert(v2 && v2.fresh === true && v2.legacy === undefined, '新 key 存在时优先读新 key (legacy 被覆盖)');

  // 完全无数据
  const v3 = await fn('kline_nonexistent', 'long');
  assert(v3 === null, '无新 key + 无 legacy → null');
});

// ============================================================
// 情形 3: _strategyCacheSet 双写 (新 key + legacy 7 天)
// ============================================================
describe('情形 3: _strategyCacheSet 双写 (新 key + legacy + 7 天 TTL 加成)', async () => {
  const { sandbox, cacheSets, cache } = buildDataSandbox();
  const fn = sandbox.window.Core.Data._strategyCacheSet;
  if (typeof fn !== 'function') { fail('_strategyCacheSet 未暴露'); return; }

  // 清空记录
  cacheSets.length = 0;
  await fn('fund_hist_001', 'long', [{ date: '2026-01-01' }], 24 * 60 * 60 * 1000);

  const written = cacheSets.filter(s => s.key === 'fund_hist_001' || s.key === 'fund_hist_001:long');
  assert(written.length === 2, `写 2 个 key (新 + legacy), 实际 ${written.length}`);
  const newWrite = written.find(s => s.key === 'fund_hist_001:long');
  const legacyWrite = written.find(s => s.key === 'fund_hist_001');
  assert(!!newWrite, '写了 :long 新 key');
  assert(!!legacyWrite, '写了 legacy key (向后兼容)');
  // legacy TTL = 原 ttl + 7 天 = 24h + 168h = 192h = 691200000 ms
  const expectedLegacyTtl = 24 * 60 * 60 * 1000 + 7 * 24 * 60 * 60 * 1000;
  assert(legacyWrite && legacyWrite.ttl === expectedLegacyTtl, `legacy TTL + 7 天加成 (${legacyWrite && legacyWrite.ttl} === ${expectedLegacyTtl})`);
});

// ============================================================
// 情形 4: strategy=default 不双写 (零回归)
// ============================================================
describe('情形 4: strategy=default 不写 legacy key', async () => {
  const { sandbox, cacheSets } = buildDataSandbox();
  const fn = sandbox.window.Core.Data._strategyCacheSet;
  cacheSets.length = 0;
  await fn('kline_600519_daily', 'default', [{ close: 1 }], 24 * 60 * 60 * 1000);
  await fn('kline_600519_daily', undefined, [{ close: 2 }], 24 * 60 * 60 * 1000);
  await fn('kline_600519_daily', '', [{ close: 3 }], 24 * 60 * 60 * 1000);
  const writes = cacheSets.filter(s => s.key === 'kline_600519_daily' || s.key === 'kline_600519_daily:default');
  assert(writes.length === 3, '3 次 default 调用各写 1 个 key, 没双写');
  assert(writes.every(s => s.key === 'kline_600519_daily'), 'key 都是 baseKey, 无 :default 段');
});

// ============================================================
// 情形 5: 互不污染: strategy=A 写, strategy=B 读不到
// ============================================================
describe('情形 5: 跨策略互不污染 (strategy=A 数据对 B 不可见)', async () => {
  const { sandbox, cacheSets, cache } = buildDataSandbox();
  const get = sandbox.window.Core.Data._strategyCacheGet;
  const set = sandbox.window.Core.Data._strategyCacheSet;

  await set('kline_000001_daily', 'long', [{ close: 11, who: 'long' }], 60000);
  const vLong = await get('kline_000001_daily', 'long');
  assert(vLong && vLong[0] && vLong[0].who === 'long', 'long 读到 long 自己的新 key 数据');
  const vShort = await get('kline_000001_daily', 'short');
  assert(vShort === null, 'short 读不到 long 写的数据 (新 key :long ≠ :short, 且不允许降级 legacy)');
  const vFund = await get('kline_000001_daily', 'fund');
  assert(vFund === null, 'fund 读不到 long 写的数据');
  // legacy 都有 (双写期), default 可读
  const legacyRead = await get('kline_000001_daily', 'default');
  assert(legacyRead && legacyRead[0] && legacyRead[0].who === 'long', 'default 显式降级读 legacy (双写兼容)');
});

// ============================================================
// 情形 6: helper 是 window.Core.Data 公开 API
// ============================================================
describe('情形 6: 3 个 helper 全部暴露在 Core.Data 上', () => {
  const { sandbox } = buildDataSandbox();
  const D = sandbox.window.Core.Data;
  assert(typeof D._strategyKey === 'function', '_strategyKey 暴露');
  assert(typeof D._strategyCacheGet === 'function', '_strategyCacheGet 暴露');
  assert(typeof D._strategyCacheSet === 'function', '_strategyCacheSet 暴露');
});

(async () => {
  await new Promise(r => setTimeout(r, 100));
  console.log('\n' + '='.repeat(50));
  console.log(`G1 跨策略 cacheKey: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})();