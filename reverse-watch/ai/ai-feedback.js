// ============== ai-feedback.js · AI adjustment 落盘 + 回滚 ==============
// LLM 在 chat 里输出 {target, value, reason}, 这里负责:
//   1. preview: 算出 old/new diff 字段描述 (给 UI 渲染 diff 卡片)
//   2. apply:  写入 localStorage, 记录到 _rw_adjustments_log
//   3. rollback: 按 id 把 old/new 颠倒写回去
//
// target 命名空间:
//   gates.*        → 写 SETTINGS.gates + saveSettings()
//   holding.*      → 写 HOLDING_KEY + saveHolding()
//   preference.*   → 写 _rw_custom_prompt (不算 adjustment, 不进 log)
//   pool.exclude   → 维护 _rw_pool_excludes 列表 (不算 adjustment, 不进 log)

const CUSTOM_PROMPT_KEY = '_rw_custom_prompt';
const POOL_EXCLUDES_KEY = '_rw_pool_excludes';
const ADJUSTMENTS_LOG_KEY = '_rw_adjustments_log';
const ADJUSTMENTS_LOG_MAX = 50;

// ----- storage helpers -----
function getCustomPrompt() {
  try { return localStorage.getItem(CUSTOM_PROMPT_KEY) || ''; }
  catch (e) { console.warn('[ai-feedback] getCustomPrompt 失败:', e.message); return ''; }
}
function setCustomPrompt(p) {
  try { localStorage.setItem(CUSTOM_PROMPT_KEY, p || ''); }
  catch (e) { console.warn('[ai-feedback] 写 customPrompt 失败:', e.message); }
}
function getPoolExcludes() {
  try {
    const raw = localStorage.getItem(POOL_EXCLUDES_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) { console.warn('[ai-feedback] getPoolExcludes 解析失败:', e.message); return []; }
}
function setPoolExcludes(arr) {
  try { localStorage.setItem(POOL_EXCLUDES_KEY, JSON.stringify(arr)); }
  catch (e) { console.warn('[ai-feedback] 写 poolExcludes 失败:', e.message); }
  document.dispatchEvent(new CustomEvent('rw:pool-exclude-changed', { detail: { list: arr } }));
}
function getLog() {
  try {
    const raw = localStorage.getItem(ADJUSTMENTS_LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { console.warn('[ai-feedback] getLog 解析失败:', e.message); return []; }
}
function pushLog(entry) {
  const log = getLog();
  log.unshift(entry);
  if (log.length > ADJUSTMENTS_LOG_MAX) log.length = ADJUSTMENTS_LOG_MAX;
  try { localStorage.setItem(ADJUSTMENTS_LOG_KEY, JSON.stringify(log)); }
  catch (e) { console.warn('[ai-feedback] 写 log 失败:', e.message); }
}

// ----- 解析 target -----
// target 例: "gates.sectorMin" / "holding.fishTailTrimPct" / "preference.customPrompt" / "pool.exclude"
function parseTarget(target) {
  const [ns, ...rest] = String(target || '').split('.');
  return { ns, field: rest.join('.') || ns };
}

// ----- 读现值 (供 preview) -----
// 必须经 window.ReverseWatch.* 拿 (避免模块作用域问题)
function readCurrent(target) {
  const { ns, field } = parseTarget(target);
  const rw = window.ReverseWatch || {};
  if (ns === 'gates') {
    const gates = (rw.SETTINGS && rw.SETTINGS.gates) || {};
    return gates[field];
  }
  if (ns === 'holding') {
    // LX-1 修: rw.holding 不存在, 用 rw.loadHolding() (已暴露在 window.ReverseWatch.loadHolding)
    const h = (rw.loadHolding && rw.loadHolding()) || rw.holding || (rw.Holding && rw.Holding.loadHolding && rw.Holding.loadHolding());
    return h ? h[field] : undefined;
  }
  if (ns === 'preference') {
    if (field === 'customPrompt') return getCustomPrompt();
  }
  if (ns === 'pool' && field === 'exclude') return getPoolExcludes();
  return undefined;
}

// ----- 写新值 -----
// 写入失败时抛错, 由调用方决定是否回滚
// [P1 #10+#11] 走 AIFeedbackPure.validateAdjustment: 白名单 + 范围校验
//   防止 LLM 写 holding.cash=99999 (字段不在白名单) 或 holding.cashReservePct=2000 (比例超 1)
function writeValue(target, newValue) {
  const rw = window.ReverseWatch || {};
  // [P1 #10+#11] 校验入口: 浏览器侧 _rw_ai_feedback_pure 已经通过 module 加载
  const Pure = rw.AIFeedbackPure;
  if (Pure && typeof Pure.validateAdjustment === 'function') {
    const v = Pure.validateAdjustment(target, newValue);
    if (!v.ok) {
      console.warn('[ai-feedback] 拒绝调整:', target, '=', newValue, '原因:', v.message);
      // [P1 #10+#11] 用特殊 return false + 把 message 写进 console (UI 端会显示)
      //   不能 throw 因为 applyAdjustments 期望 graceful fail
      writeValue._lastRejectMessage = v.message;
      return false;
    }
  }
  const { ns, field } = parseTarget(target);
  if (ns === 'gates') {
    if (rw.SETTINGS && rw.SETTINGS.gates) {
      // L4-1 修: newValue===undefined 时 delete key, 避免 NaN 比较崩 4 闸
      if (newValue === undefined) delete rw.SETTINGS.gates[field];
      else rw.SETTINGS.gates[field] = newValue;
      if (rw.saveSettings) rw.saveSettings(rw.SETTINGS);
      return true;
    }
  }
  if (ns === 'holding') {
    if (rw.saveHolding) {
      // L4-1 修: 同上, undefined 时跳过写入 (saveHolding 内部会 merge, 不能直接传 undefined)
      if (newValue === undefined) {
        // 用空对象 patch 该字段, 借助 merge 行为不行, 直接 delete holding 字段
        const cur = (rw.loadHolding && rw.loadHolding()) || {};
        delete cur[field];
        rw.saveHolding(cur);
      } else {
        rw.saveHolding({ [field]: newValue });
      }
      return true;
    }
  }
  if (ns === 'preference') {
    if (field === 'customPrompt') {
      setCustomPrompt(newValue);
      return true;
    }
  }
  if (ns === 'pool' && field === 'exclude') {
    // 智能合并: 单只新值 (e.g. RiskMine 自动建议 [code]) → addPoolExclude (append + dedup)
    //         整体替换 (e.g. 用户手动清空) → setPoolExcludes
    if (Array.isArray(newValue) && newValue.length === 1 && typeof newValue[0] === 'string') {
      addPoolExclude(newValue[0]);
      return true;
    } else if (Array.isArray(newValue)) {
      setPoolExcludes(newValue);
      return true;
    }
  }
  return false;
}

// ----- previewAdjustment -----
// 返回 {target, ns, field, oldValue, newValue, summary, ok} 给 UI 渲染 diff
function previewAdjustment(a) {
  const target = a.target;
  const newValue = a.value;
  const oldValue = readCurrent(target);
  const { ns, field } = parseTarget(target);
  const fmt = (v) => {
    if (v === null || v === undefined) return '(空)';
    if (Array.isArray(v)) return `[${v.join(', ')}]`;
    if (typeof v === 'number') return Math.abs(v) < 1 ? (v * 100).toFixed(1) + '%' : v.toFixed(2);
    return String(v);
  };
  const summary = `${ns}.${field}: ${fmt(oldValue)} → ${fmt(newValue)}`;
  const isCountable = ns === 'gates' || ns === 'holding';
  return {
    target,
    ns,
    field,
    oldValue,
    newValue,
    reason: a.reason || '(无说明)',
    summary,
    ok: isCountable || ns === 'preference' || (ns === 'pool' && field === 'exclude')
  };
}

// ----- applyAdjustments -----
// list = [{target, value, reason}, ...]
// 返回 [{id, ok, message}]
function applyAdjustments(list) {
  const results = [];
  for (const a of list || []) {
    const prev = previewAdjustment(a);
    if (!prev.ok) {
      results.push({ target: a.target, ok: false, message: `未知 target: ${a.target}` });
      continue;
    }
    const ok = writeValue(a.target, a.value);
    if (!ok) {
      // [P1 #10+#11] writeValue 失败原因可能是白名单/范围拒绝, 透传给 UI
      const reason = writeValue._lastRejectMessage || '写入失败';
      results.push({ target: a.target, ok: false, message: reason });
      continue;
    }
    // preference.customPrompt / pool.exclude 不进 log (不是真调整, 只是偏好)
    if (prev.ns === 'preference' || (prev.ns === 'pool' && prev.field === 'exclude')) {
      results.push({ target: a.target, ok: true, message: prev.summary });
      continue;
    }
    const id = 'adj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const logEntry = {
      id, ts: Date.now(),
      target: a.target,
      oldValue: prev.oldValue,
      newValue: a.value,
      reason: a.reason || '(无说明)',
      status: 'applied'
    };
    pushLog(logEntry);
    results.push({ id, target: a.target, ok: true, message: prev.summary, entry: logEntry });
    // 触发 app.js 监听
    document.dispatchEvent(new CustomEvent('rw:ai-adjustments-applied', {
      detail: { entry: logEntry, results }
    }));
  }
  return results;
}

// ----- rollback -----
function rollbackAdjustment(id) {
  const log = getLog();
  const entry = log.find(e => e.id === id);
  if (!entry) return { ok: false, message: `找不到 id: ${id}` };
  if (entry.status === 'reverted') return { ok: false, message: '已回滚过' };
  const ok = writeValue(entry.target, entry.oldValue);
  if (!ok) return { ok: false, message: '回滚写入失败' };
  entry.status = 'reverted';
  try { localStorage.setItem(ADJUSTMENTS_LOG_KEY, JSON.stringify(log)); }
  catch (e) { console.warn('[ai-feedback] 回滚写 log 失败:', e.message); }
  document.dispatchEvent(new CustomEvent('rw:ai-adjustments-applied', {
    detail: { rollback: entry }
  }));
  return { ok: true, message: `回滚 ${entry.target}` };
}

function rollbackAll() {
  const log = getLog();
  let count = 0;
  for (const e of log) {
    if (e.status === 'applied' && writeValue(e.target, e.oldValue)) {
      e.status = 'reverted';
      count++;
    }
  }
  try { localStorage.setItem(ADJUSTMENTS_LOG_KEY, JSON.stringify(log)); }
  catch (e) { console.warn('[ai-feedback] rollbackAll 写 log 失败:', e.message); }
  return { count };
}

function getHistory(limit = 10) {
  return getLog().slice(0, limit);
}

function clearHistory() {
  try { localStorage.removeItem(ADJUSTMENTS_LOG_KEY); return true; }
  catch (e) { console.warn('[ai-feedback] clearHistory 失败:', e.message); return false; }
}

// ----- 让 app.js 可直接调用 "把 pool 排除 X 写入" -----
function addPoolExclude(code) {
  const list = getPoolExcludes();
  if (!list.includes(code)) list.push(code);
  setPoolExcludes(list);
  // L5-2 修: 派发事件让 app.js render() 重渲 (pool.exclude 不进 adjustments_log, rw:ai-adjustments-applied 不触发)
  document.dispatchEvent(new CustomEvent('rw:pool-exclude-changed', { detail: { code, list } }));
  return list;
}
function removePoolExclude(code) {
  const list = getPoolExcludes().filter(c => c !== code);
  setPoolExcludes(list);
  document.dispatchEvent(new CustomEvent('rw:pool-exclude-changed', { detail: { code, list } }));
  return list;
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AIFeedback = {
  getCustomPrompt, setCustomPrompt,
  getPoolExcludes, setPoolExcludes, addPoolExclude, removePoolExclude,
  previewAdjustment, applyAdjustments,
  rollbackAdjustment, rollbackAll,
  getHistory, clearHistory,
  // 内部用, 给 chat 暴露 (避免 chat 重新解析)
  parseTarget, readCurrent, writeValue
};