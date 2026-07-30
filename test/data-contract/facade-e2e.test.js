/**
 * Phase 1.6 — 端到端验证 sourceDigest 注入链
 *
 * 不依赖浏览器, vm sandbox 加载:
 *   - schema.js, normalize.js, provenance.js, facade.js
 * 模拟 journal.js 的 ctx 装配, 验证:
 *   1. DataFacade.getQuote 返回的 envelope 含完整 provenance + validation
 *   2. Provenance.digest 把多个 envelope 聚合成 1 行压缩文本
 *   3. agents.js _summarizeCtx 把它渲染进 ## 数据来源摘要 section
 *   4. 模拟 LLM 把它拼到回复开头, 输出"数据来源:腾讯 / 时效:realtime / 校验:passed"字样
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_DIR = path.join(ROOT, 'www', 'core');

function load(filename) {
  return fs.readFileSync(path.join(SRC_DIR, filename), 'utf8');
}

// ===== 沙箱: 模拟 window + window.Core.Data + 最小 Core.Storage mock =====
const sandbox = {
  window: {},
  console: console
};
sandbox.window.Core = { Data: {} };
const ctx = vm.createContext(sandbox);

// Storage mock (journal.js 用 cacheGet/cacheSet, 但本测试不真用)
sandbox.window.Core = sandbox.window.Core || {};
sandbox.window.Core.Storage = {
  cacheGet: async () => null,
  cacheSet: async () => {}
};
// schema.js 不依赖 Core, 直接跑
vm.runInContext(load('data/schema.js'), sandbox, { filename: 'schema.js' });
vm.runInContext(load('data/normalize.js'), sandbox, { filename: 'normalize.js' });
vm.runInContext(load('data/provenance.js'), sandbox, { filename: 'provenance.js' });

// facade.js 走 window.Core.Data.getStockSpotTencent, 我们注入 mock
sandbox.window.Core.Data = sandbox.window.Core.Data || {};
sandbox.window.Core.Data.getStockSpotTencent = async function(symbols) {
  // 模拟腾讯原始响应
  return symbols.map(code => {
    if (code === '600519') return {
      '代码': '600519', '名称': '贵州茅台',
      '最新价': '1730.00', '昨收': '1720.00',
      '今开': '1725.00', '最高': '1735.00', '最低': '1718.00',
      '成交量': '12345', '总成交额': '45678.90',
      '换手率': '0.85', '市盈率': '28.5',
      '流通市值': '21730.50', '总市值': '21730.50',
      '涨跌额': '10.00', '涨跌幅': '0.58%',
      '时间': '20260730103000'
    };
    if (code === '000001') return {
      '代码': '000001', '名称': '平安银行',
      '最新价': '12.50', '昨收': '12.30',
      '今开': '12.30', '最高': '12.55', '最低': '12.20',
      '成交量': '500000', '总成交额': '62000',
      '换手率': '0.5', '市盈率': '5.2',
      '流通市值': '2538', '总市值': '2538',
      '涨跌额': '0.20', '涨跌幅': '1.63%',
      '时间': '20260730103000'
    };
    return null;
  }).filter(Boolean);
};
// facade.js 里裸引用 `Core.Storage.cacheGet`, 把 window.Core 也挂到顶层
sandbox.Core = sandbox.window.Core;
vm.runInContext(load('data/facade.js'), sandbox, { filename: 'facade.js' });

const { Schema, Provenance, Normalize, Facade } = sandbox.window.Core.Data;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓', msg); }
  else { fail++; console.error('  ✗', msg); }
}
async function main() {
  console.log('\n=== Phase 1.6 端到端验证 ===\n');

  // 1. 拉两条 envelope
  const env1 = await Facade.getQuote('600519');
  const env2 = await Facade.getQuote('000001');
  const envelopes = [env1, env2];

  console.log('\n--- 步骤 1: getQuote 返回 envelope 含完整字段 ---');
  assert(env1.category === Schema.CATEGORIES.QUOTE, 'env1.category = quote');
  assert(env1.provider === Schema.PROVIDERS.TENGXUN, 'env1.provider = tengxun');
  assert(env1.freshness === Schema.FRESHNESS.REALTIME, 'env1.freshness = realtime');
  assert(env1.schemaVersion === 'quote.v3', 'env1.schemaVersion = quote.v3');
  assert(env1.validation.status === Schema.VALIDATION_STATUS.PASSED, 'env1.validation.status = passed');
  assert(env1.quality === Schema.QUALITY.OK, 'env1.quality = ok (因为 validation.passed)');
  assert(env1.provenance && Array.isArray(env1.provenance.chain), 'env1.provenance.chain 是数组');
  assert(env1.provenance.chain[0] === 'tengxun', 'provenance.chain[0] = tengxun');
  assert(env1.provenance.chain[1] === 'normalize.tengxun', 'provenance.chain[1] = normalize.tengxun');
  assert(env1.provenance.collectedBy === 'data.quote.get', 'collectedBy = data.quote.get');
  assert(env1.payload.price === 1730, 'env1.payload.price = 1730 (normalize 生效)');
  assert(env1.payload.change === 10, 'env1.payload.change = 10 (自算)');

  console.log('\n--- 步骤 2: Provenance.digest 聚合多条 envelope ---');
  const sourceDigest = Provenance.digest(envelopes);
  console.log('  sourceDigest =', JSON.stringify(sourceDigest));
  assert(sourceDigest.length > 0, 'digest 非空');
  assert(sourceDigest.includes('tengxun'), 'digest 含 tengxun');
  assert(sourceDigest.includes('realtime'), 'digest 含 realtime');
  assert(sourceDigest.includes('passed'), 'digest 含 passed');
  assert(!sourceDigest.includes('未通过校验'), '全部 passed, digest 无"未通过校验"段');

  console.log('\n--- 步骤 3: journal.js ctx 装配路径模拟 ---');
  // 模拟 journal.js 的 ctx 构造 (复刻 app/journal.js 245-250 行附近)
  const journalCtx = {
    holdings: [],
    alerts: [],
    recentJournals: [],
    quoteEnvelopes: envelopes,
    sourceDigest: sourceDigest  // 注入
  };

  // _summarizeCtx 不需要 vm, 直接从 agents.js 抠出来
  const agentsSrc = load('agents.js');
  const m = agentsSrc.match(/function _summarizeCtx\(ctx\)\s*\{[\s\S]*?\n  \}/);
  if (!m) throw new Error('未找到 _summarizeCtx');
  // 把抠出来的函数放到沙箱执行
  vm.runInContext(m[0] + '\nwindow._summarizeCtx = _summarizeCtx;', sandbox);
  const summarized = sandbox.window._summarizeCtx(journalCtx);
  console.log('\n--- _summarizeCtx 输出 ---');
  console.log(summarized);
  assert(summarized.includes('## 数据来源摘要'), '含 ## 数据来源摘要 段');
  assert(summarized.includes('tengxun'), '摘要段含 tengxun');
  assert(summarized.includes('passed'), '摘要段含 passed');

  console.log('\n--- 步骤 4: 模拟 AI 把 sourceDigest 拼到回答开头 ---');
  // 这是 AI 端注入的最终可见文本 (本机 LLM 接到 prompt 后输出)
  const aiAnswer = `数据来源:${envelopes[0].provider} / 时效:${envelopes[0].freshness} / 校验:${envelopes[0].validation.status}\n\n观察: 茅台当前价 ${envelopes[0].payload.price} 元, 日涨幅 ${(envelopes[0].payload.changePercent * 100).toFixed(2)}%。\n(基于 sourceDigest: ${sourceDigest})`;
  console.log('\n--- AI 回答示例 ---');
  console.log(aiAnswer);
  assert(aiAnswer.includes('数据来源:腾讯') || aiAnswer.includes('数据来源:tengxun'), 'AI 回答出现「数据来源:腾讯」');
  assert(aiAnswer.includes('时效:realtime'), 'AI 回答出现「时效:realtime」');
  assert(aiAnswer.includes('校验:passed'), 'AI 回答出现「校验:passed」');

  console.log(`\n========== ${pass} passed, ${fail} failed ==========`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(e => { console.error('FATAL:', e); process.exit(2); });