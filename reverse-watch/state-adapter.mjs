// ============== state-adapter.mjs · 浏览器/Node 通用存储适配 ==============
// 浏览器侧: localStorage
// Node 侧: 写 reverse-watch/_rw_daemon_state.json + _rw_scheduler_last_run.json
// 用途: 让 screener / regime / risk-mine / auto-tuner 纯函数既能在浏览器跑,
//       也能在 daemon (Node) 跑, 同一份代码, 不重复实现
//
// 关键约束:
// - 浏览器侧 write 必须走 try/catch + console.warn (CLAUDE.md)
// - Node 侧用 fs.writeFileSync 原子写 (临时文件 + rename)
// - 所有 JSON.parse 必须 try/catch, 失败返空 (不阻塞调用方)

const IS_NODE = typeof window === 'undefined' && typeof process !== 'undefined' && process.versions != null;

function makeStateAdapter(opts = {}) {
  const cwd = opts.cwd || (IS_NODE ? process.cwd() : '');
  // 反向: `reverse-watch` 子目录, daemon cwd 是 D:\get\stock-master, 所以要 +1 层
  const fsPath = opts.fsPath || (IS_NODE ? `${cwd}/reverse-watch` : '');

  function safeRead(key, fallback = null) {
    if (!IS_NODE) {
      try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); }
      catch (e) { console.warn('[state-adapter] localStorage 读失败:', key, e.message); return fallback; }
    }
    // Node: 读 fs 文件, 没有返 fallback
    try {
      const fs = require('node:fs');
      const path = `${fsPath}/_rw_state_${key}.json`;
      if (!fs.existsSync(path)) return fallback;
      return JSON.parse(fs.readFileSync(path, 'utf-8'));
    } catch (e) { console.warn('[state-adapter] fs 读失败:', key, e.message); return fallback; }
  }

  function safeWrite(key, value) {
    if (!IS_NODE) {
      try { localStorage.setItem(key, JSON.stringify(value)); return true; }
      catch (e) { console.warn('[state-adapter] localStorage 写失败:', key, e.message); return false; }
    }
    try {
      const fs = require('node:fs');
      const path = `${fsPath}/_rw_state_${key}.json`;
      const tmp = `${path}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
      fs.renameSync(tmp, path);  // 原子替换
      return true;
    } catch (e) { console.warn('[state-adapter] fs 写失败:', key, e.message); return false; }
  }

  function safeReadJson(key, fallback = {}) {
    const r = safeRead(key, fallback);
    return r == null ? fallback : r;
  }

  return { safeRead, safeWrite, safeReadJson, isNode: IS_NODE };
}

// 浏览器侧暴露 window.ReverseWatch.StateAdapter
if (!IS_NODE) {
  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.StateAdapter = { make: makeStateAdapter };
}

export { makeStateAdapter, IS_NODE };