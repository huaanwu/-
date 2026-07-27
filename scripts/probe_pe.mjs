#!/usr/bin/env node
/**
 * probe_pe.mjs - B-3 估值偏离接口探针
 *
 * 目的: 验证 akshare `stock_market_pe_lg` 接口真实返回结构,
 *      对比 stock-master `_judgeValuation` 期望的字段, 判断是否可对接。
 *
 * 跑法 (PowerShell 7):
 *   python -m aktools --host 127.0.0.1 --port 8088 &    # 启 aktools
 *   node scripts/probe_pe.mjs                          # 跑探针
 *
 * 结论 (2026-07-27 探针跑出):
 *   真实接口 stock_market_pe_lg 返回**月度历史时序** (344 行, 1997-2026),
 *   字段: {日期, 指数, 平均市盈率} (单只指数的历史月度 PE)
 *
 *   stock-master 产品代码 (_judgeValuation / _fetchMarketValuation) 期望:
 *   {index_name, pe_ttm, pb, pe_percentile_5y} 这种**指数级别实时快照**,
 *   与真实接口**完全不匹配** — 拿不到 index_name, 拿不到 pb, 拿不到 pe_percentile_5y 分位字段。
 *
 *   现有 alerts.js `_checkValuation` 跑起来会:
 *     1. wanted.includes('上证'/'深证'/'创业板'/'科创50') 全失败 (没有 index_name 字段)
 *     2. items.length === 0 → verdict = null → 静默跳过 (不通知)
 *   即: 用户即使建了估值规则, 永不会触发 (静默假阴性)。
 *
 * 决策:
 *   B-3 估值偏离功能**实际未生效**, 需另找指数级 PE 分位数据源。
 *   候选: akshare stock_index_pe_lg (待验) / 雪球 / 中证指数官网。
 *
 * 此探针不入 npm scripts, 仅供手工跑回归用 (无需 aktools 时直接 node 也行, 仅打印预期不匹配)。
 */

const AKTOOLS = 'http://127.0.0.1:8088/api/public';

async function probe() {
  console.log('=== B-3 估值偏离接口探针 ===');
  console.log(`aktools: ${AKTOOLS}/stock_market_pe_lg`);
  let arr;
  try {
    const res = await fetch(`${AKTOOLS}/stock_market_pe_lg`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    arr = await res.json();
  } catch (e) {
    console.error('aktools 不可达:', e.message);
    console.error('请先启: python -m aktools --host 127.0.0.1 --port 8088');
    process.exit(1);
  }

  console.log(`返回行数: ${arr.length}`);
  console.log(`字段: ${Object.keys(arr[0] || {}).join(', ')}`);
  console.log(`首行: ${JSON.stringify(arr[0])}`);
  console.log(`末行: ${JSON.stringify(arr[arr.length - 1])}`);

  const hasIndexName = arr.some(r => 'index_name' in r || 'name' in r);
  const hasPb = arr.some(r => 'pb' in r);
  const hasPct = arr.some(r => 'pe_percentile_5y' in r || 'percentile' in r);

  console.log('\n=== 与 _judgeValuation 期望对比 ===');
  console.log(`✓ index_name 字段: ${hasIndexName ? '有' : '❌ 缺 (接口是时序, 无指数名)'}`);
  console.log(`✓ pe_ttm 字段:    ${arr.some(r => 'pe_ttm' in r || '平均市盈率' in r) ? '有 (可用 平均市盈率 兜底)' : '❌ 缺'}`);
  console.log(`✓ pb 字段:        ${hasPb ? '有' : '❌ 缺'}`);
  console.log(`✓ pe_percentile_5y: ${hasPct ? '有' : '❌ 缺 (需客户端算分位)'}`);

  if (!hasIndexName && !hasPct) {
    console.log('\n⚠ 结论: 现有 B-3 _checkValuation 永不触发 (静默假阴性)');
    console.log('  修复路径: 改用 stock_index_pe_lg 或客户端自算 5 年分位');
  }
}

probe().catch(e => { console.error(e); process.exit(1); });