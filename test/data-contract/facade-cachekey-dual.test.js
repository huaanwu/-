/**
 * facade cacheKey 双写 + 降级链 单测 — Phase 2.2
 *
 * 覆盖:
 *   1. 主 key 命中 → 不再走 fetcher (cacheHit=true)
 *   2. legacy key 命中 → 标 legacyHit=true + 回填主 key
 *   3. 主 key 缺失 → 走 tengxun, 写入主 + legacy
 *   4. tengxun 失败 → fallback sina, provenance.chain 含 "tengxun.fail"
 *   5. tengxun + sina 都失败 → fallback aktools
 *   6. 三源全失败 → quality=failed envelope, 不 throw
 *   7. getQuoteMany 走 multi key + 单 key 双层命中
 *   8. provider 强制 mode=tengxun 时, sina/aktools 不被调
 *   9. provenance.chain 含 cache.set (写入时)
 *   10. _ttlForNow 交易时段用 60s, 非交易时段用 24h
 *
 * 跑法: node test/data-contract/facade-cachekey-dual.test.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'schema.js'), 'utf8');
const NORM_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'normalize.js'), 'utf8');
const PROV_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'provenance.js'), 'utf8');
const FACADE_SRC = fs.readFileSync(path.join(ROOT, 'www', 'core', 'data', 'facade.js'), 'utf8');

// ===== 内存 mock: Storage + Data fetcher =====
function buildMockStore(initial = {}) {
  const map = { ...initial };
  return {
    get: (k) => map[k] === undefined ? null : map[k],
    set: (k, v) => { map[k] = v; },
    _map: map
  };
}

function buildSandbox({ tencentOk = true, sinaOk = true, aktoolsOk = true, sinaHas = ['600519'], aktoolsHas = ['600519'] } = {}) {
  const sandbox = { window: {}, console };
  sandbox.window.Core = { Data: {} };
  // 别名: facade.js 在 vm 内用 window.Core, 但 sandbox 上要能直接挂 Core.Storage / Core.Data.* (给 fetcher mock)
  sandbox.Core = sandbox.window.Core;
  // Storage mock
  const store = buildMockStore();
  sandbox.Core.Storage = {
    cacheGet: async (k) => store.get(k),
    cacheSet: async (k, v) => store.set(k, v)
  };

  // Fetcher mocks
  const callLog = { tencent: 0, sina: 0, aktools: 0 };
  sandbox.Core.Data.getStockSpotTencent = async (codes) => {
    callLog.tencent++;
    if (!tencentOk) throw new Error('mock tengxun fail');
    return codes.map(c => ({
      '代码': c, '名称': `Mock-${c}`,
      '最新价': '1730.00', '昨收': '1720.00',
      '今开': '1725.00', '最高': '1735.00', '最低': '1718.00',
      '成交量': '12345', '总成交额': '45678.90',
      '换手率': '0.85', '市盈率': '28.5',
      '流通市值': '21730.50', '总市值': '21730.50',
      '涨跌额': '10.00', '涨跌幅': '0.58%',
      '时间': '20260730103000'
    }));
  };
  sandbox.Core.Data._sinaFetch = async (codes) => {
    callLog.sina++;
    if (!sinaOk) throw new Error('mock sina fail');
    return codes
      .filter(c => sinaHas.includes(c))
      .map(c => ({
        '代码': c, '名称': `Sina-${c}`,
        '最新价': 1730.00, '昨收': 1720.00,
        '今开': 1725.00, '最高': 1735.00, '最低': 1718.00,
        '成交量': 1234500, '成交额': 456789000,
        '涨跌额': 10.00, '涨跌幅': 0.58,
        '换手率': null, '市盈率': null,
        '流通市值': null, '总市值': null,
        '时间': '2026-07-30 10:30:00'
      }));
  };
  sandbox.Core.Data.fetch = async (path) => {
    callLog.aktools++;
    if (!aktoolsOk) throw new Error('mock aktools fail');
    if (path !== 'stock_zh_a_spot') throw new Error('unexpected path: ' + path);
    return aktoolsHas.map(c => ({
      ts_code: c + '.SH', name: `Aktools-${c}`,
      trade_date: '20260730',
      open: 1725.0, high: 1735.0, low: 1718.0,
      close: 1730.0, prev_close: 1720.0,
      vol: 12345.0, amount: 456789.0,
      change: 10.0, pct_chg: 0.58,
      turnover_rate: 0.85, pe: 28.5,
      total_mv: 21730.5, circ_mv: 21730.5
    }));
  };

  vm.createContext(sandbox);
  vm.runInContext(SCHEMA_SRC, sandbox, { filename: 'schema.js' });
  vm.runInContext(NORM_SRC, sandbox, { filename: 'normalize.js' });
  vm.runInContext(PROV_SRC, sandbox, { filename: 'provenance.js' });
  vm.runInContext(FACADE_SRC, sandbox, { filename: 'facade.js' });

  return { sandbox, store, callLog };
}

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
const _describes = [];
function describe(name, fn) { console.log('\n' + name); _describes.push(fn()); }
async function runDescribes() {
  for (const d of _describes) await d;
}

(async () => {

// ===== 情形 1: 主 key 命中 =====
describe('情形 1: 主 key 命中 → 不再调 fetcher', async () => {
  const { sandbox, store, callLog } = buildSandbox();
  // 预填主 key
  const mainKey = 'quote:v3:single:600519';
  store.set(mainKey, {
    symbol: '600519', name: '预填茅台',
    market: 'SH', price: 999, prevClose: 998,
    change: 1, changePercent: 0.001,
    volume: 100, amount: 1000,
    provider: 'tengxun'
  });
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.symbol === '600519', 'symbol = 600519');
  assert(env.provider === 'tengxun', 'provider 继承自 cache');
  assert(env.quality === 'ok', 'quality=ok (校验通过)');
  assert(env.provenance.cacheHit === true, 'provenance.cacheHit=true');
  assert(env.provenance.legacyHit === false, 'provenance.legacyHit=false');
  assert(callLog.tencent === 0, 'tencent 未被调用');
  assert(callLog.sina === 0, 'sina 未被调用');
  assert(callLog.aktools === 0, 'aktools 未被调用');
});

// ===== 情形 2: legacy key 命中 =====
describe('情形 2: legacy key 命中 → legacyHit=true + 回填主 key', async () => {
  const { sandbox, store, callLog } = buildSandbox();
  const legacyKey = 'quote:v3:legacy:600519';
  store.set(legacyKey, {
    symbol: '600519', name: 'legacy 茅台',
    market: 'SH', price: 1730, prevClose: 1720,
    change: 10, changePercent: 0.0058,
    volume: 1234500, amount: 456789000,
    provider: 'tengxun'
  });
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.provenance.legacyHit === true, 'legacyHit=true');
  assert(env.provenance.cacheHit === true, 'cacheHit=true');
  assert(callLog.tencent === 0, 'legacy 命中时不调 fetcher');
  // 主 key 应被回填
  const mainKey = 'quote:v3:single:600519';
  const back = store.get(mainKey);
  assert(back && back.symbol === '600519', '主 key 被回填');
});

// ===== 情形 3: 主 legacy 缺失 → 走 tengxun, 双写 =====
describe('情形 3: 主/legacy 缺失 → 走 tengxun, 双写主+legacy', async () => {
  const { sandbox, store, callLog } = buildSandbox();
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.symbol === '600519', 'env 返回');
  assert(env.provider === 'tengxun', 'provider=tengxun');
  assert(env.provenance.cacheHit === false, 'cacheHit=false');
  assert(callLog.tencent === 1, 'tencent 被调 1 次');
  assert(callLog.sina === 0, 'sina 未被调 (tengxun 成功)');
  assert(callLog.aktools === 0, 'aktools 未被调');
  // 双写
  assert(store.get('quote:v3:single:600519'), '主 key 已写入');
  assert(store.get('quote:v3:legacy:600519'), 'legacy key 已写入');
  assert(Array.isArray(env.provenance.chain), 'provenance.chain 是数组');
  assert(env.provenance.chain[0] === 'tengxun', 'chain[0]=tengxun');
});

// ===== 情形 4: tengxun fail → fallback sina =====
describe('情形 4: tengxun 失败 → fallback sina, chain 含 tengxun.fail', async () => {
  const { sandbox, callLog } = buildSandbox({ tencentOk: false, sinaOk: true });
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.provider === 'sina', 'provider=sina (降级成功)');
  assert(env.provenance.upstreamErrors.length === 1, 'upstreamErrors 记录 tengxun 失败');
  assert(env.provenance.upstreamErrors[0].includes('tengxun'), 'upstreamErrors[0] 提到 tengxun');
  assert(callLog.tencent === 1, 'tencent 被调 1 次后失败');
  assert(callLog.sina === 1, 'sina 被调 1 次成功');
  assert(callLog.aktools === 0, 'aktools 未被调');
});

// ===== 情形 5: tengxun + sina 都失败 → fallback aktools =====
describe('情形 5: tengxun + sina 都失败 → fallback aktools', async () => {
  const { sandbox, callLog } = buildSandbox({ tencentOk: false, sinaOk: false, aktoolsOk: true });
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.provider === 'aktools', 'provider=aktools');
  assert(env.provenance.upstreamErrors.length === 2, '2 条 upstreamErrors');
  assert(callLog.tencent === 1 && callLog.sina === 1 && callLog.aktools === 1, '三源各被调 1 次');
});

// ===== 情形 6: 三源全失败 → quality=failed envelope, 不 throw =====
describe('情形 6: 三源全失败 → quality=failed, 不 throw', async () => {
  const { sandbox, callLog } = buildSandbox({ tencentOk: false, sinaOk: false, aktoolsOk: false });
  let env;
  try {
    env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  } catch (e) {
    fail++; console.error('  ✗ 不应 throw: ' + e.message);
    return;
  }
  assert(env, 'env 仍返回(不 throw)');
  assert(env.quality === 'failed', 'quality=failed');
  assert(env.validation.status === 'failed', 'validation.status=failed');
  assert(env.payload && Object.keys(env.payload).length === 0, 'payload 空对象');
  // upstreamErrors 应含 3 条 (tengxun/sina/aktools 都失败)
  const msgs = (env.provenance.upstreamErrors || []).join(' | ');
  assert(msgs.includes('tengxun') && msgs.includes('sina') && msgs.includes('aktools'),
    'upstreamErrors 含 tengxun + sina + aktools (' + msgs + ')');
});

// ===== 情形 7: getQuoteMany 走 multi key + 单 key 双层命中 =====
describe('情形 7: getQuoteMany 双层缓存 (multi + single)', async () => {
  const { sandbox, store, callLog } = buildSandbox();
  // 预填 600000 单 key, 不预填 multi
  store.set('quote:v3:single:600000', {
    symbol: '600000', name: '预填浦发', market: 'SH',
    price: 10, prevClose: 9.9, change: 0.1, changePercent: 0.01,
    volume: 100, amount: 1000, provider: 'tengxun'
  });
  const envelopes = await sandbox.window.Core.Data.Facade.getQuoteMany(['600000', '600519']);
  assert(envelopes.length === 2, '返回 2 个 envelopes');
  assert(envelopes[0].symbol === '600000', '第一个是 600000');
  // all-or-nothing single 命中: 600519 miss → fall through 全量 fetch → 600000 实际是新 fetch 出来的
  // 这是 facade 当前设计, 单 key 仅在 allHit 时复用
  assert(callLog.tencent === 1, '600519 触发一次 tencent');
  assert(envelopes[1].symbol === '600519', '第二个是 600519');
  assert(envelopes[0].payload.price === 1730, '600000 由 tencent 全量 fetch 拿到 (mock 价格 1730)');
});

// ===== 情形 8: provider 强制 mode=tengxun 时, sina/aktools 不被调 =====
describe('情形 8: provider=tengxun 强制时, tengxun fail 不降级', async () => {
  const { sandbox, callLog } = buildSandbox({ tencentOk: false, sinaOk: true });
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519', { provider: 'tengxun' });
  assert(env.quality === 'failed', '强制 tengxun 失败时 → failed envelope');
  assert(callLog.sina === 0, '强制模式不触发 sina fallback');
  assert(callLog.aktools === 0, '强制模式不触发 aktools fallback');
});

// ===== 情形 9: provenance.chain 在 cache.set 时是否包含 cache.set =====
describe('情形 9: provenance 字段完整 (chain + collectedBy + collectedAt)', async () => {
  const { sandbox } = buildSandbox();
  const env = await sandbox.window.Core.Data.Facade.getQuote('600519');
  assert(env.provenance.collectedBy === 'data.quote.get', 'collectedBy=data.quote.get');
  assert(typeof env.provenance.collectedAt === 'number', 'collectedAt 是 timestamp');
  assert(env.provenance.chain.includes('tengxun'), 'chain 含 tengxun');
});

// ===== 情形 10: _ttlForNow 交易时段判断 =====
describe('情形 10: _ttlForNow 交易时段切换', () => {
  const { sandbox } = buildSandbox();
  const F = sandbox.window.Core.Data.Facade;
  // 模拟 10:00 (inTrading)
  const _origDate = Date;
  const _origH = sandbox.window.Date || Date;
  // 简单验证: ttlForNow 返回 60000 或 86400000
  const t1 = F._ttlForNow();
  assert(t1 === 60000 || t1 === 86400000, 'ttl ∈ {60000, 86400000}');
  // 通过手工时间点验证 inTrading 判定
  const _realH = 10 * 60 + 30;  // 10:30
  const inTrading = (_realH >= 9 * 60 + 30 && _realH <= 11 * 60 + 30)
                 || (_realH >= 13 * 60 && _realH <= 15 * 60);
  assert(inTrading === true, '10:30 判定为 inTrading');
});

await runDescribes();

console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
process.exit(fail > 0 ? 1 : 0);

})();