/**
 * V13 阶段 5 — 飞书会话的待确认状态
 *
 * 背景: 飞书卡片回调后, 用户下一条可能只回 "确认" 而不带工具名.
 *       解析器不能再次要求 LLM 提取工具, 应该直接从这条消息里复用待办工具.
 *
 * 边界:
 *   - 状态仅存活在主进程内存中, 重启即清空 (无持久化 — 安全取舍)
 *   - 同一 openId 同时只允许 1 个待确认 ask, 新 ask 自动覆盖旧 ask
 *   - 等待时间默认 5 分钟 (与 permission.js 一致)
 */
'use strict';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

class PendingConfirmations {
  constructor(opts = {}) {
    this.ttlMs = opts.ttlMs || DEFAULT_TTL_MS;
    this._byOpenId = new Map();
    this._timers = new Map();
  }

  _cancelTimer(openId) {
    const t = this._timers.get(openId);
    if (t) clearTimeout(t);
    this._timers.delete(openId);
  }

  set(openId, payload) {
    if (!openId || !payload || !payload.tool) return null;
    this._cancelTimer(openId);
    const entry = {
      openId,
      tool: String(payload.tool),
      args: payload.args && typeof payload.args === 'object' ? payload.args : {},
      rationale: payload.rationale || '',
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs
    };
    this._byOpenId.set(openId, entry);
    const timer = setTimeout(() => {
      const cur = this._byOpenId.get(openId);
      // 清理 + 再次自检 (以 set 时建立的 entry.expiresAt 为准, 避免覆盖延长 TTL 后误清)
      if (cur && cur.expiresAt <= Date.now() + 5) this._byOpenId.delete(openId);
      this._timers.delete(openId);
    }, this.ttlMs);
    if (typeof timer.unref === 'function') timer.unref();
    this._timers.set(openId, timer);
    return entry;
  }

  get(openId) {
    if (!openId) return null;
    const cur = this._byOpenId.get(openId);
    if (!cur) return null;
    if (cur.expiresAt <= Date.now()) {
      this._cancelTimer(openId);
      this._byOpenId.delete(openId);
      return null;
    }
    return cur;
  }

  consume(openId) {
    if (!openId) return null;
    const cur = this.get(openId);
    this._cancelTimer(openId);
    this._byOpenId.delete(openId);
    return cur;
  }

  clear() {
    for (const id of Array.from(this._byOpenId.keys())) this._cancelTimer(id);
    this._byOpenId.clear();
  }
}

module.exports = { PendingConfirmations, DEFAULT_TTL_MS };
