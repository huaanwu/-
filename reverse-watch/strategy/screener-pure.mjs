// ============== screener-pure.mjs · 反向 4 闸筛选 (纯函数) ==============
// 浏览器 + Node 通用: 注入 deps (依赖函数) + state (状态读写)
// 原 app.js:1039-1094 reverseScreener 抽出来, 行为 100% 一致
//
// deps 注入约定:
//   deps.getPoolExcludes()     → string[]  (chat 维护的"用户否定名单")
//   deps.loadFeedback(code)    → {verdict, ts, note} | null  (7d TTL 已应用)
//   deps.readCachedRisk(code)  → string[] | null  (RiskMine 缓存, 同步快速读)
//   deps.shuffle(arr, rng)     → 随机打乱, 给定 rng 函数保证可复现
//
// state 注入:
//   state.safeRead(key, fallback)  /  state.safeWrite(key, value)
//   默认用 makeStateAdapter() 自动选 localStorage/fs

// state-adapter.mjs 在上级目录, 原来写 './state-adapter.mjs' 导致 ES module 加载 404
import { makeStateAdapter, IS_NODE } from '../state-adapter.mjs';

const DEFAULT_GATES = { sectorMin: 0.55, pbDeltaMin: 15, quantRejectPct: 0.5, excludeLeaders: true };

function defaultDeps() {
  // 浏览器侧走 window.ReverseWatch 全局, Node 侧注入空 deps 让调用方必须提供
  if (IS_NODE) return {};
  const rw = window.ReverseWatch || {};
  return {
    getPoolExcludes: () => {
      try { return JSON.parse(localStorage.getItem('_rw_pool_excludes') || '[]'); }
      catch (e) { console.warn('[screener-pure] getPoolExcludes 失败:', e.message); return []; }
    },
    loadFeedback: (code) => {
      try {
        const all = JSON.parse(localStorage.getItem('_rw_feedback') || '{}');
        const fb = all[code];
        if (!fb || (Date.now() - (fb.ts || 0)) >= 7 * 24 * 60 * 60 * 1000) return null;
        return fb;
      } catch (e) { console.warn('[screener-pure] loadFeedback 失败:', e.message); return null; }
    },
    readCachedRisk: (code) => {
      if (rw.RiskMine && typeof rw.RiskMine.readCachedRisk === 'function') return rw.RiskMine.readCachedRisk(code);
      return null;
    },
    shuffle: (arr, rng) => {
      const a = arr.slice();
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  };
}

// 跑反向 4 闸: 返回 { passed: [...], blocked: [{code, name, reason}], stats }
// gates 走 SETTINGS.gates, 没有时用 DEFAULT_GATES
// rng 默认 Math.random (Node 测可注入 seeded RNG)
function runReverseScreener(pool, opts = {}) {
  const deps = opts.deps || defaultDeps();
  const state = opts.state || makeStateAdapter();
  const G = opts.gates || DEFAULT_GATES;
  const rng = opts.rng || Math.random;
  const now = opts.now || Date.now();
  const TTL_7D = 7 * 24 * 60 * 60 * 1000;

  const shuffled = (deps.shuffle || defaultDeps().shuffle)(pool, rng);
  const passed = [];
  const blocked = [];
  const excludes = (deps.getPoolExcludes || defaultDeps().getPoolExcludes)() || [];

  for (const s of shuffled) {
    // 第 0 闸: 用户曾主动排除
    if (excludes.includes(s.code)) {
      blocked.push({ code: s.code, name: s.name, reason: `用户/AI 已排除 (${s.code})` });
      continue;
    }
    // 学习闭环 ①: 用户反馈 down 自动加排除 (短期 7d)
    const fb = (deps.loadFeedback || defaultDeps().loadFeedback)(s.code);
    if (fb && fb.verdict === 'down' && (now - (fb.ts || 0)) < TTL_7D) {
      blocked.push({ code: s.code, name: s.name, reason: `用户曾否定 (${s.name}, ${fb.note || '无备注'})` });
      continue;
    }
    if (G.excludeLeaders && s.isSectorLeader) {
      blocked.push({ code: s.code, name: s.name, reason: `是板块龙头 (${s.sector})` });
      continue;
    }
    if (s.limitsUpRate_2d < G.sectorMin) {
      blocked.push({ code: s.code, name: s.name, reason: `板块封板率 ${(s.limitsUpRate_2d*100).toFixed(0)}% < ${(G.sectorMin*100).toFixed(0)}%` });
      continue;
    }
    const pbDelta = s.sectorPbMedian - s.pbPercentile;
    if (pbDelta < G.pbDeltaMin) {
      blocked.push({ code: s.code, name: s.name, reason: `PB 分位差 ${pbDelta}pp < ${G.pbDeltaMin}pp (反向条件)` });
      continue;
    }
    if (s.style === 'fish') {
      blocked.push({ code: s.code, name: s.name, reason: `近期鱼尾行情 / 板块过强` });
      continue;
    }
    if (s.hasQuantSeat && rng() < G.quantRejectPct) {
      blocked.push({ code: s.code, name: s.name, reason: `量化席位风险` });
      continue;
    }
    // 第 5 闸: 基本面排雷 (RiskMine 缓存)
    const cached = (deps.readCachedRisk || defaultDeps().readCachedRisk)(s.code);
    if (cached && cached.length > 0) {
      blocked.push({ code: s.code, name: s.name, reason: `基本面风险: ${cached.join(', ')}` });
      continue;
    }
    passed.push({ ...s, pbDelta });
  }
  // AutoTuner 信号 ③ 池子吞吐率来源
  const stats = { passed: passed.length, blocked: blocked.length, ts: now };
  state.safeWrite('_rw_screener_stats', stats);
  return { passed, blocked, stats };
}

// 浏览器侧暴露
if (!IS_NODE) {
  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.ScreenerPure = { runReverseScreener, DEFAULT_GATES };
}

export { runReverseScreener, DEFAULT_GATES };