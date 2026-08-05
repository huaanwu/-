// ============== auto-tuner.js · 系统自动调参引擎 ==============
// 第 5 层学习闭环: 周期扫 4 项信号 → 规则式决策 → 走 AIFeedback 落盘。
// 严守 4 不可妥协立场:
//   1. 用户优先: 24h 内手动改过 SETTINGS → 拒
//   2. 空仓合法: bear 下 gates/holding 不动, 只调 positionMultiplier
//   3. 大道至简: 4 项信号 + 5 条规则, 不上 ML
//   4. 赚钱机会: 7d 后 down 比率反升 → 自动回滚, 调参器自校准
//
// 重构 (?v=daemon1): 实际 signals/guard/decide 逻辑迁到 auto-tuner-pure.mjs,
// execute / rollbackAll / approvePending / scheduleWeekly 留在浏览器 (依赖 AIFeedback 落盘)

const AUTO_LOG_KEY = '_rw_auto_adjustments_log';
const AUTO_LOG_MAX = 50;
const PENDING_KEY = '_rw_pending_auto_adjustment';
const PENDING_MAX = 10;
const TTL_7D = 7 * 24 * 60 * 60 * 1000;
const TTL_24H = 24 * 60 * 60 * 1000;
const LARGE_STEP_RATIO = 0.05;
const MIN_SAMPLE = 20;

// 引入纯函数模块
const _pure = (window.ReverseWatch && window.ReverseWatch.AutoTunerPure) || null;

// ----- storage helpers -----
function getLog(limit = 20) {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_LOG_KEY) || '[]');
    return Array.isArray(raw) ? raw.slice(0, limit) : [];
  } catch (e) { console.warn('[auto-tuner] getLog 解析失败:', e.message); return []; }
}
function pushAutoLog(entry) {
  const log = (() => {
    try { return JSON.parse(localStorage.getItem(AUTO_LOG_KEY) || '[]'); }
    catch (e) { console.warn('[auto-tuner] pushAutoLog 解析失败:', e.message); return []; }
  })();
  if (!Array.isArray(log)) return;
  const idx = log.findIndex(e => e.ts === entry.ts && e.adjustment?.target === entry.adjustment?.target);
  if (idx >= 0) log[idx] = entry;  // 已有同 ts+target → 覆盖 (回填 perfSnapshot 用)
  else log.unshift(entry);
  if (log.length > AUTO_LOG_MAX) log.length = AUTO_LOG_MAX;
  try { localStorage.setItem(AUTO_LOG_KEY, JSON.stringify(log)); }
  catch (e) { console.warn('[auto-tuner] 写 log 失败:', e.message); }
}
function getPending() {
  try {
    const raw = JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { console.warn('[auto-tuner] getPending 解析失败:', e.message); return []; }
}

// ----- 节流 helper: 扫描近 7d 内"系统+用户"都调过的 target 集合 -----
// 防止 AutoTuner + AI chat 联合轮流调同一字段导致节流失效 (主节流看 ts, 7d 内整体)
// 但同字段 7d 内已调过 → 直接跳过, 避免 chat 周一调 sectorMin, AutoTuner 周日再调一遍
function getRecentlyTunedTargets(now = Date.now()) {
  const out = new Set();
  // 1) 扫 _rw_auto_adjustments_log (系统)
  try {
    const auto = JSON.parse(localStorage.getItem(AUTO_LOG_KEY) || '[]');
    if (Array.isArray(auto)) {
      auto.forEach(e => {
        if (e && e.ts && (now - e.ts) < TTL_7D && e.status !== 'rolledBack' && e.adjustment?.target) {
          out.add(e.adjustment.target);
        }
      });
    }
  } catch (e) { console.warn('[auto-tuner] getRecentlyTunedTargets 扫 auto log 失败:', e.message); }
  // 2) 扫 _rw_adjustments_log (用户 chat + applyAdjustments)
  try {
    const rw = window.ReverseWatch || {};
    const user = (rw.AIFeedback && typeof rw.AIFeedback.getHistory === 'function')
      ? rw.AIFeedback.getHistory(50) : [];
    user.forEach(e => {
      if (e && e.ts && (now - e.ts) < TTL_7D && e.status !== 'reverted' && e.target) {
        out.add(e.target);
      }
    });
  } catch (e) { console.warn('[auto-tuner] getRecentlyTunedTargets 扫 user log 失败:', e.message); }
  return out;
}

// ----- 工具: 截断到区间 -----
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ----- 浏览器侧 deps 注入器 (纯函数用) -----
function _pureDeps() {
  const rw = window.ReverseWatch || {};
  return {
    loadActiveFeedback: (now) => (typeof rw.loadActiveFeedback === 'function') ? rw.loadActiveFeedback(now) : {},
    loadHoldingFb: () => (typeof rw.loadHoldingFb === 'function') ? rw.loadHoldingFb() : {},
    getHolding: () => (typeof rw.loadHolding === 'function') ? rw.loadHolding() : {},
    getUserAdjustments: () => (rw.AIFeedback && typeof rw.AIFeedback.getHistory === 'function') ? rw.AIFeedback.getHistory(50) : [],
    getSettings: () => rw.SETTINGS || {}
  };
}

// ----- signals / guard / decide 走纯函数 (降级到 inline 实现作兜底) -----
function _computeSignals(now = Date.now()) {
  if (_pure && typeof _pure.computeSignals === 'function') {
    return _pure.computeSignals({ deps: _pureDeps(), now });
  }
  return { downRatio: null, sampleSize: 0, downCount: 0, upCount: 0, ruleDownRate: {}, passRate: null, userAdjusted: [] };
}

function _shouldSkip(now = Date.now()) {
  if (_pure && typeof _pure.shouldSkip === 'function') {
    return _pure.shouldSkip({ deps: _pureDeps(), now });
  }
  return { skip: true, reason: '纯函数未加载 (降级)', signals: null };
}

function _decide(signals) {
  if (_pure && typeof _pure.decide === 'function') {
    return _pure.decide(signals, { deps: _pureDeps() });
  }
  return [];
}

// ----- LLM 注释 (大调需批准场景) -----
async function _llmExplain(a, signals) {
  const rw = window.ReverseWatch || {};
  try {
    const sys = `你是反向策略顾问, 用户偏好: ${(rw.AIFeedback && rw.AIFeedback.getCustomPrompt) ? rw.AIFeedback.getCustomPrompt() : '(无)'}, 信号: down=${((signals.downRatio||0)*100).toFixed(0)}% pass=${((signals.passRate||0)*100).toFixed(0)}%`;
    if (!rw.AIAdapter || typeof rw.AIAdapter.callLLM !== 'function') return '(无 LLM adapter)';
    const reply = await rw.AIAdapter.callLLM(
      `请用 1 句话 (≤30 字) 解释为什么建议 ${a.target} 从 ${a.oldValue} 调到 ${a.value}: ${a.reason}`,
      { systemPrompt: sys, maxTokens: 100 }
    );
    return reply || '(无解释)';
  } catch (e) { console.warn('[auto-tuner] LLM 解释失败:', e.message); return '(LLM 失败)'; }
}

// ----- 执行 adjustments -----
async function _execute(adjustments, signals) {
  const rw = window.ReverseWatch || {};
  const results = { tiny: [], pending: [], skipped: [] };
  for (const a of adjustments) {
    if (!rw.AIFeedback || typeof rw.AIFeedback.previewAdjustment !== 'function') {
      results.skipped.push({ a, reason: 'AIFeedback 不可用' });
      continue;
    }
    const old = rw.AIFeedback.previewAdjustment(a);
    if (!old || old.ok === false) { results.skipped.push({ a, reason: 'preview 失败' }); continue; }
    // 步长计算 (相对值, 0 旧值时用绝对值)
    const stepPct = old.oldValue !== 0 && old.oldValue != null
      ? Math.abs((a.value - old.oldValue) / old.oldValue)
      : Math.abs(a.value || 0);
    const isLarge = stepPct > LARGE_STEP_RATIO;
    if (isLarge) {
      // 大调: 暂存 + LLM 注释 + 不落盘
      const pending = getPending();
      pending.unshift({ ...a, ts: Date.now(), oldValue: old.oldValue, llmReason: await _llmExplain(a, signals) });
      try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending.slice(0, PENDING_MAX))); }
      catch (e) { console.warn('[auto-tuner] 写 pending 失败:', e.message); }
      results.pending.push(a);
    } else {
      // 小调: 直接落盘 (走 AIFeedback.applyAdjustments → 自动派 rw:ai-adjustments-applied)
      rw.AIFeedback.applyAdjustments([a]);
      results.tiny.push(a);
    }
    pushAutoLog({ ts: Date.now(), adjustment: a, signals, status: isLarge ? 'pending' : 'applied' });
  }
  // 派事件让 app.js render() 重渲
  if (results.tiny.length > 0 || results.pending.length > 0) {
    document.dispatchEvent(new CustomEvent('rw:auto-tuning-applied', { detail: results }));
  }
  return results;
}

// ----- 7d 后回填 perfSnapshot + 反向信号自动回滚 -----
async function _evaluatePerf() {
  const rw = window.ReverseWatch || {};
  const log = (() => {
    try { return JSON.parse(localStorage.getItem(AUTO_LOG_KEY) || '[]'); }
    catch (e) { console.warn('[auto-tuner] _evaluatePerf 读 log 失败:', e.message); return []; }
  })();
  if (!Array.isArray(log)) return { evaluated: 0, rolledBack: 0 };
  const now = Date.now();
  let evaluated = 0, rolledBack = 0;
  for (const entry of log) {
    if (!entry || entry.status !== 'applied' || entry.perfSnapshot) continue;
    if ((now - entry.ts) < TTL_7D) continue;
    // 用 entry.signals.downRatio 作为 beforeDown (entry 写入时的快照, 不重算)
    const beforeDown = entry.signals?.downRatio ?? 0;
    const afterFb = _computeSignals(now);
    const afterDown = afterFb.downRatio ?? 0;
    entry.perfSnapshot = { beforeDown, afterDown, improved: afterDown < beforeDown };
    evaluated++;
    if (afterDown > beforeDown + 0.05 && entry.adjustment && entry.adjustment.target) {
      // 反向信号: 自动回滚
      if (rw.AIFeedback && typeof rw.AIFeedback.applyAdjustments === 'function') {
        const rolled = rw.AIFeedback.applyAdjustments([{
          target: entry.adjustment.target,
          value: entry.adjustment.oldValue,
          reason: '反向信号: 调参后 down 比率反升, 自动回滚'
        }]);
        entry.status = 'rolledBack';
        entry.rollbackResult = rolled[0];
        rolledBack++;
      }
    }
    pushAutoLog(entry);  // 回写
  }
  return { evaluated, rolledBack };
}

// ----- 主入口: 跑一次决策 -----
async function runOnce(opts = {}) {
  const forceSkip = opts.forceSkip === true;
  const now = Date.now();
  const guard = _shouldSkip(now);
  if (!forceSkip && guard.skip) {
    console.log('[auto-tuner] skip:', guard.reason);
    return { skipped: true, reason: guard.reason, signals: guard.signals };
  }
  const signals = guard.signals || _computeSignals(now);
  const adjustments = _decide(signals);
  if (adjustments.length === 0) {
    console.log('[auto-tuner] no adjustments (signals ok but no rule matched)');
    return { skipped: false, reason: 'no_rule_matched', signals };
  }
  const results = await _execute(adjustments, signals);
  return { skipped: false, results, signals, adjustments };
}

// ----- 一键回滚全部 (用户主动) -----
function rollbackAll() {
  const rw = window.ReverseWatch || {};
  const log = getLog(50);
  let count = 0;
  for (const e of log) {
    if (e && e.status === 'applied' && e.adjustment && e.adjustment.target && e.adjustment.oldValue != null) {
      if (rw.AIFeedback && typeof rw.AIFeedback.applyAdjustments === 'function') {
        rw.AIFeedback.applyAdjustments([{
          target: e.adjustment.target,
          value: e.adjustment.oldValue,
          reason: '用户一键回滚全部自动调参'
        }]);
        e.status = 'reverted';
        pushAutoLog(e);
        count++;
      }
    }
  }
  return { count };
}

// ----- 待批准列表: 用户批准 (apply) / 拒绝 (skip) -----
function approvePending(idx, approve = true) {
  const pending = getPending();
  if (idx < 0 || idx >= pending.length) return { ok: false, message: 'index 越界' };
  const entry = pending[idx];
  if (approve) {
    const rw = window.ReverseWatch || {};
    if (rw.AIFeedback && typeof rw.AIFeedback.applyAdjustments === 'function') {
      rw.AIFeedback.applyAdjustments([{ target: entry.target, value: entry.value, reason: entry.llmReason || entry.reason || '用户批准自动调参' }]);
      // 同步更新 log
      pushAutoLog({ ts: Date.now(), adjustment: entry, signals: {}, status: 'approved' });
    }
  }
  // 移除 pending
  pending.splice(idx, 1);
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(pending)); }
  catch (e) { console.warn('[auto-tuner] 移除 pending 失败:', e.message); }
  return { ok: true, approved: approve };
}

// ----- 定时调度: 每周日 16:00 -----
let _scheduleTimer = null;
function scheduleWeekly() {
  if (_scheduleTimer) clearTimeout(_scheduleTimer);
  const now = new Date();
  const dayOfWeek = now.getDay();  // 0=Sun
  const daysUntilSunday = (7 - dayOfWeek) % 7;
  const next = new Date(now);
  next.setDate(now.getDate() + (daysUntilSunday === 0 ? 7 : daysUntilSunday));
  next.setHours(16, 0, 0, 0);
  const ms = Math.max(1000, next - now);
  console.log('[auto-tuner] 下一次自动跑:', next.toLocaleString(), `(间隔 ${(ms/3600000).toFixed(1)}h)`);
  _scheduleTimer = setTimeout(async () => {
    try {
      // 先跑 7d perf 评估, 再跑决策
      await _evaluatePerf();
      await runOnce();
    } catch (e) { console.warn('[auto-tuner] 定时跑失败:', e.message); }
    scheduleWeekly();
  }, ms);
}

// ----- KPI 摘要 (顶部徽章用) -----
function getKpi() {
  const now = Date.now();
  const log = getLog(50);
  const weekCount = log.filter(e => e && e.ts && (now - e.ts) < TTL_7D && e.status !== 'pending').length;
  const pending = getPending();
  return { weekCount, pendingCount: pending.length, lastTs: log[0]?.ts || null };
}

// ----- 暴露 -----
window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AutoTuner = {
  runOnce,
  scheduleWeekly,
  rollbackAll,
  approvePending,
  getLog,
  getPending,
  getKpi,
  // 内部 (供测试)
  _computeSignals,
  _shouldSkip,
  _decide,
  _execute,
  _evaluatePerf,
  _llmExplain
};