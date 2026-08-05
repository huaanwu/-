// ============== risk-mine-pure.mjs · 基本面排雷 (纯函数判定) ==============
// 浏览器 + Node 通用: 注入 fetchAkshare (数据源) + state (缓存读写)
// 原 ai/risk-mine.js 抽出来, 复用主项目 Core.RiskMine 的 4 类判定逻辑
//
// 注入约定:
//   deps.fetchAkshare(path)  → Promise<Array|null>  (null 表示端点不存在, fail-isolation)
//   state.safeRead/safeWrite                       (缓存, 浏览器/Node 通用)

import { makeStateAdapter, IS_NODE } from '../state-adapter.mjs';

const RISK_CACHE_KEY = '_rw_risk_cache';
const RISK_TTL_MS = 6 * 60 * 60 * 1000;

const REASONS = {
  GOODWILL: '商誉偏高',
  DECREASE: '股东减持',
  LOSS_FIRST: '业绩首亏',
  LOSS_CONTINUE: '业绩续亏',
  LOSS_DECREASE: '业绩预减'
};
const SEVERITY = {
  [REASONS.GOODWILL]: 'high',
  [REASONS.DECREASE]: 'medium',
  [REASONS.LOSS_FIRST]: 'high',
  [REASONS.LOSS_CONTINUE]: 'high',
  [REASONS.LOSS_DECREASE]: 'high'
};

const GOODWILL_RATIO_THRESHOLD = 0.30;
const DECREASE_PCT_THRESHOLD = 0.01;

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 纯函数: 给定 (code + 3 类数据), 判定 reasons[]
// 浏览器 + Node 都能直接调, 不依赖 IO
function judgeRisks(code, goodwillList, decreaseList, profitList) {
  const reasons = new Set();
  if (Array.isArray(goodwillList)) {
    const row = goodwillList.find(r => r.代码 === code || r.code === code);
    if (row) {
      const ratio = _num(row['商誉占总资产比'] ?? row['商誉占比']);
      if (ratio != null && ratio > GOODWILL_RATIO_THRESHOLD * 100) reasons.add(REASONS.GOODWILL);
    }
  }
  if (Array.isArray(decreaseList)) {
    const rows = decreaseList.filter(r => r.代码 === code || r.code === code);
    for (const r of rows) {
      const ratio = Math.abs(_num(r['变动比例'] ?? r['减持比例']) || 0);
      if (ratio > DECREASE_PCT_THRESHOLD * 100) { reasons.add(REASONS.DECREASE); break; }
    }
  }
  if (Array.isArray(profitList)) {
    const row = profitList.find(r => r.代码 === code || r.code === code);
    if (row) {
      const type = String(row['业绩预告类型'] ?? row['预告类型'] ?? '');
      if (type.includes('首亏')) reasons.add(REASONS.LOSS_FIRST);
      else if (type.includes('续亏')) reasons.add(REASONS.LOSS_CONTINUE);
      else if (type.includes('预减')) reasons.add(REASONS.LOSS_DECREASE);
    }
  }
  return [...reasons];
}

// IO + 判定: 拉数据 + 调 judgeRisks, 写缓存
// opts: { fetchAkshare, state, now }
// 返回: { reasons, status: 'ok'|'failed' }
async function scanRisk(code, opts = {}) {
  const state = opts.state || makeStateAdapter();
  const fetchAkshare = opts.fetchAkshare || (async () => null);
  const now = opts.now || Date.now();

  // 1. 读缓存
  const cache = state.safeReadJson(RISK_CACHE_KEY, {});
  const hit = cache[code];
  if (hit && hit.status === 'ok' && (now - hit.ts) < RISK_TTL_MS) {
    return { reasons: hit.reasons || [], status: 'ok', fromCache: true };
  }

  // 2. 并行拉 2 类数据 (stock_sj_em 已被 akshare 移除, 减持暂时停用)
  const [goodwillList, profitList] = await Promise.all([
    fetchAkshare('stock_sy_em'),
    fetchAkshare('stock_yjyg_em')
  ]);
  const decreaseList = []; // stock_sj_em 已废弃
  const allFailed = [goodwillList, profitList].every(r => r === null);

  // 3. 判定
  const reasons = judgeRisks(code, goodwillList, decreaseList, profitList);
  const status = allFailed ? 'failed' : 'ok';

  // 4. 写缓存
  cache[code] = { ts: now, status, reasons };
  state.safeWrite(RISK_CACHE_KEY, cache);
  return { reasons, status, fromCache: false };
}

// 同步读缓存 (screener 第 5 闸快速判定)
function readCachedRisk(code, opts = {}) {
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const cache = state.safeReadJson(RISK_CACHE_KEY, {});
  const hit = cache[code];
  if (hit && hit.status === 'ok' && (now - hit.ts) < RISK_TTL_MS) return hit.reasons || [];
  return null;
}

function readCachedStatus(code, opts = {}) {
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const cache = state.safeReadJson(RISK_CACHE_KEY, {});
  const hit = cache[code];
  if (!hit) return 'unknown';
  if ((now - (hit.ts || 0)) >= RISK_TTL_MS) return 'unknown';
  return hit.status || 'unknown';
}

async function prewarmPoolRisk(codes, opts = {}) {
  if (!Array.isArray(codes) || codes.length === 0) return;
  const fetchAkshare = opts.fetchAkshare || (async () => null);
  const state = opts.state || makeStateAdapter();
  const now = opts.now || Date.now();
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  const todo = codes.filter(c => readCachedRisk(c, { state, now }) === null);
  if (todo.length === 0) return;
  console.log('[risk-mine-pure] 预热排雷缓存:', todo.length, '只');
  let done = 0;
  await Promise.all(todo.map(c => scanRisk(c, { fetchAkshare, state, now }).catch(() => ({ reasons: [], status: 'failed' })).finally(() => {
    done++;
    try { onProgress(done, todo.length); } catch (e) { console.warn('[risk-mine-pure] onProgress 回调失败:', e.message); }
  })));
}

function describeRisk(reasons) {
  if (!reasons || reasons.length === 0) return '✅ 无基本面风险';
  return '⚠️ ' + reasons.map(r => `${r} (${SEVERITY[r] || '?'})`).join('; ');
}

// 并发去重: 同 code in-flight Promise 复用 (避免重复 IO / 写覆盖)
const _inflight = new Map();
async function scanRiskDedup(code, opts = {}) {
  if (_inflight.has(code)) return _inflight.get(code);
  const p = scanRisk(code, opts);
  _inflight.set(code, p);
  try { return await p; } finally { _inflight.delete(code); }
}

// 浏览器侧暴露 (供 app.js + ai-chat.js 调)
if (!IS_NODE) {
  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.RiskMinePure = { scanRisk: scanRiskDedup, readCachedRisk, readCachedStatus, prewarmPoolRisk, describeRisk, judgeRisks, REASONS, SEVERITY };
}

export { scanRisk, scanRiskDedup, readCachedRisk, readCachedStatus, prewarmPoolRisk, describeRisk, judgeRisks, REASONS, SEVERITY };