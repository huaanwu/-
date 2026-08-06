// ============== risk-mine.js · reverse-watch 基本面排雷 ==============
// 简化版: 复用主项目 Core.RiskMine 的 4 类判定逻辑 (商誉/减持/业绩/资金)
// 数据来源: dev-proxy /api/akshare/{item_id} (无需主项目, 直接调 AKTools)
// 缓存: localStorage _rw_risk_cache (TTL 6h)
// 闸位: reverseScreener 第 5 闸调用 scanRisk(code), 命中就排掉

const RISK_CACHE_KEY = '_rw_risk_cache';
const RISK_TTL_MS = 6 * 60 * 60 * 1000;

// 并发去重: 同 code 同时被多次请求时只跑一次 scanRisk (避免重复 IO / 写覆盖)
// 不同 code 仍并行 (Promise.all 不动)
const _inflight = new Map();

// 复用主项目 REASONS (字段名一致, 不污染)
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

// 阈值 (与主项目 Core.RiskMine 保持一致, 防止 drift)
const GOODWILL_RATIO_THRESHOLD = 0.30;
const DECREASE_PCT_THRESHOLD = 0.01;

function getProxyBase() {
  return (typeof PROXY_BASE !== 'undefined' ? PROXY_BASE : 'http://127.0.0.1:8089').replace(/\/$/, '');
}

// fetchAkshare 返回值 (2026-08-04 修订: 区分"接口不存在"与"网络失败"):
//   - Array: 真数据 (length=0 也是 ok, 表示"该接口扫了, 没数据")
//   - null: 接口不存在/被移除 (aktools 返 {"error":"未找到该接口..."}) — 局部降级, 不影响其他端点
//   - 不抛: 网络/HTTP 错误 → 也返回 null, 走 fail-isolation 通道
async function fetchAkshare(path) {
  const url = `${getProxyBase()}/api/akshare/${path}`;
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = await r.json();
    // aktools 接口不存在/参数错时会返 {"error": "未找到该接口..."} 或 {"detail": "..."}
    // 这种不是数组, 直接当 null 处理 (单端点降级, 不影响整体)
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      if (body.error || body.detail) {
        console.warn('[risk-mine] 端点不存在或参数错:', path, '→', body.error || body.detail);
        return null;
      }
    }
    return Array.isArray(body) ? body : null;
  } catch (e) {
    console.warn('[risk-mine] akshare 拉取失败:', path, e.message);
    return null;
  }
}

function _num(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[%,]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// 检查单只股票的 4 类风险, 返回 reasons[] 数组 (空数组=无风险)
// 语义区分: reasons.length>0 = 命中风险; reasons.length===0 = 已扫无风险; 抛错/全失败 = 写 status:'failed', 调用方 catch 走"扫描失败" UI
async function scanRisk(code) {
  // 0. 并发去重: 同 code 的 in-flight Promise 直接复用
  if (_inflight.has(code)) return _inflight.get(code);
  const p = _doScan(code);
  _inflight.set(code, p);
  try { return await p; } finally { _inflight.delete(code); }
}

// 实际扫描逻辑 (原 scanRisk body)
async function _doScan(code) {
  // 1. 先读缓存 (只看 status='ok' 的; 'failed' 视为无效)
  try {
    const raw = localStorage.getItem(RISK_CACHE_KEY);
    if (raw) {
      const cache = JSON.parse(raw);
      const hit = cache[code];
      if (hit && hit.status === 'ok' && (Date.now() - hit.ts) < RISK_TTL_MS) {
        return hit.reasons || [];
      }
    }
  } catch (e) { console.warn('[risk-mine] 读缓存失败:', e.message); }

  // 2. 并行拉 2 类数据 (2026-08-04 修订: akshare 新版已移除 stock_sj_em 减持端点)
  //    原 3 路 (商誉 + 减持 + 业绩) → 现 2 路 (商誉 + 业绩); REASONS.DECREASE 保留向后兼容老缓存
  //    fail-isolation: fetchAkshare 返 null 表示"端点不可用", 返 [] 表示"可用但无数据"
  const fetchResults = await Promise.all([
    fetchAkshare('stock_sy_em'),
    fetchAkshare('stock_yjyg_em')
  ]);
  const [goodwillList, profitList] = fetchResults;
  const decreaseList = []; // 已废弃: stock_sj_em 接口不存在, 减持检测暂时停用
  // allFailed 严格判定: 全部接口都返 null (端点不存在/网络挂) 才算失败; 单端点降级不影响整体
  const allFailed = fetchResults.every(r => r === null);

  const reasons = new Set();

  // (A) 商誉: stock_sy_em 行字段 { 代码, 名称, 商誉占总资产比 }
  if (Array.isArray(goodwillList)) {
    const row = goodwillList.find(r => r.代码 === code || r.code === code);
    if (row) {
      const ratio = _num(row['商誉占总资产比'] ?? row['商誉占比']);
      if (ratio != null && ratio > GOODWILL_RATIO_THRESHOLD * 100) {
        reasons.add(REASONS.GOODWILL);
      }
    }
  }

  // (B) 减持: stock_sj_em 行字段 { 代码, 变动比例 }
  if (Array.isArray(decreaseList)) {
    const rows = decreaseList.filter(r => r.代码 === code || r.code === code);
    for (const r of rows) {
      const ratio = Math.abs(_num(r['变动比例'] ?? r['减持比例']) || 0);
      if (ratio > DECREASE_PCT_THRESHOLD * 100) {
        reasons.add(REASONS.DECREASE);
        break;
      }
    }
  }

  // (C) 业绩预告: stock_yjyg_em 行字段 { 代码, 业绩预告类型 }
  if (Array.isArray(profitList)) {
    const row = profitList.find(r => r.代码 === code || r.code === code);
    if (row) {
      const type = String(row['业绩预告类型'] ?? row['预告类型'] ?? '');
      if (type.includes('首亏')) reasons.add(REASONS.LOSS_FIRST);
      else if (type.includes('续亏')) reasons.add(REASONS.LOSS_CONTINUE);
      else if (type.includes('预减')) reasons.add(REASONS.LOSS_DECREASE);
    }
  }

  const out = [...reasons];

  // 3. 写缓存: 全失败 (proxy 挂了) 写 status:'failed', 不掩盖为"无风险"
  try {
    const raw = localStorage.getItem(RISK_CACHE_KEY) || '{}';
    const cache = JSON.parse(raw);
    if (allFailed) {
      cache[code] = { ts: Date.now(), status: 'failed', reasons: [] };
    } else {
      cache[code] = { ts: Date.now(), status: 'ok', reasons: out };
    }
    localStorage.setItem(RISK_CACHE_KEY, JSON.stringify(cache));
  } catch (e) { console.warn('[risk-mine] 写缓存失败:', e.message); }

  return out;
}

// 同步读缓存 (reverseScreener 在主流程里需要快速判定, 不阻塞等 LLM)
// 返回值:
//   - null: 未扫 / 过期 / 状态失败 (一律视为"未知", 让调用方决定如何兜底)
//   - []: 已扫, 无风险
//   - [r1, r2]: 已扫, 命中风险
function readCachedRisk(code) {
  try {
    const raw = localStorage.getItem(RISK_CACHE_KEY);
    if (!raw) return null;
    const cache = JSON.parse(raw);
    const hit = cache[code];
    // 只信 status:'ok'; 'failed' 或未设置 status 都视为无效, 走再扫
    if (hit && hit.status === 'ok' && (Date.now() - hit.ts) < RISK_TTL_MS) {
      return hit.reasons || [];
    }
    return null;
  } catch (e) { console.warn('[risk-mine] readCachedRisk 失败:', e.message); return null; }
}

// 是否上次扫描失败 (用于 UI 区分"已扫无风险"vs"扫失败")
function readCachedStatus(code) {
  try {
    const raw = localStorage.getItem(RISK_CACHE_KEY);
    if (!raw) return 'unknown';
    const cache = JSON.parse(raw);
    const hit = cache[code];
    if (!hit) return 'unknown';
    if ((Date.now() - (hit.ts || 0)) >= RISK_TTL_MS) return 'unknown';
    return hit.status || 'unknown';
  } catch (e) { console.warn('[risk-mine] readCachedStatus 失败:', e.message); return 'unknown'; }
}

// 批量预热: reverseScreener 入口调一次, 把 passed 池里所有 code 异步扫一遍
// opts.onProgress(done, total) — 每扫完一只回调, 0-indexed done, total 不变 (已过滤 todo.length)
async function prewarmPoolRisk(codes, opts = {}) {
  if (!Array.isArray(codes)) return;
  const todo = codes.filter(c => readCachedRisk(c) === null);
  if (todo.length === 0) return;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
  console.log('[risk-mine] 预热排雷缓存:', todo.length, '只');
  let done = 0;
  await Promise.all(todo.map(c => scanRisk(c).catch(() => []).finally(() => {
    done++;
    try { onProgress(done, todo.length); } catch (e) { console.warn('[risk-mine] onProgress 回调失败:', e.message); }
  })));
}

// UI 显示: 给详情 modal 用 (跟主项目 checkRows 风格对齐)
function describeRisk(reasons) {
  if (!reasons || reasons.length === 0) return '✅ 无基本面风险';
  return '⚠️ ' + reasons.map(r => `${r} (${SEVERITY[r] || '?'})`).join('; ');
}

window.ReverseWatch = window.ReverseWatch || {};
// 重构 ( ): 实际逻辑迁到 ai/risk-mine-pure.mjs, 浏览器侧仅留薄 wrapper
// 供 daemon (Node) 复用同一份纯函数, 保证 scanRisk 行为一致
// fetchAkshare 保留本地 (浏览器侧走 dev-proxy :8089, Node daemon 走自己的实现)
const rw0 = window.ReverseWatch;
const _pure = rw0.RiskMinePure;
const _wrappedScanRisk = _pure ? (code) => _pure.scanRisk(code, { fetchAkshare }) : null;
window.ReverseWatch.RiskMine = {
  scanRisk: _wrappedScanRisk || scanRisk,  // 纯函数未加载时降级到原实现
  readCachedRisk: _pure ? (code) => _pure.readCachedRisk(code) : readCachedRisk,
  readCachedStatus: _pure ? (code) => _pure.readCachedStatus(code) : readCachedStatus,
  prewarmPoolRisk: _pure ? (codes, opts) => _pure.prewarmPoolRisk(codes, { fetchAkshare, ...(opts || {}) }) : prewarmPoolRisk,
  describeRisk: _pure ? _pure.describeRisk : describeRisk,
  REASONS,
  SEVERITY
};