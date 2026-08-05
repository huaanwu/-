/**
 * Core.Bus — 事件总线 (Phase 4)
 *
 * 设计:
 *   - Core.Bus.emit/on/off: 轻量事件总线, 无外部依赖
 *   - agent-tools.js 9 个 renderer-only 工具的副作用经 emit('effect', {...}) 投递给 app.js 订阅者
 *
 * 事件约定:
 *   emit('effect', { kind, ... })   — 通用副作用事件
 *     kind='ui':       { target, op }        → renderer 刷新指定 UI
 *     kind='storage':  { collection, op, data } → renderer 刷新存储相关 UI
 *     kind='remote':   { url, method }        → renderer 标记网络请求
 *
 * P6.8 审计清理: 移除 EffectRequest 工厂 (L77-119), tool-registry.js:167 全部
 *   effectRequest: null, agent-tools.js 走裸 emit, 工厂无人消费。
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  // ===== 事件总线 =====

  /** @type {Object<string, Function[]>} */
  const _handlers = {};

  /**
   * 订阅事件
   * @param {string} event  事件名 (如 'effect')
   * @param {Function} handler  (payload) => void
   * @returns {Function} unsubscribe 函数
   */
  function on(event, handler) {
    if (!event || typeof handler !== 'function') return function () {};
    if (!_handlers[event]) _handlers[event] = [];
    _handlers[event].push(handler);
    return function unsubscribe() { off(event, handler); };
  }

  /**
   * 退订事件
   * @param {string} event
   * @param {Function} [handler]  不传则退订该事件所有 handler
   */
  function off(event, handler) {
    if (!_handlers[event]) return;
    if (!handler) {
      delete _handlers[event];
      return;
    }
    _handlers[event] = _handlers[event].filter(function (h) { return h !== handler; });
    if (_handlers[event].length === 0) delete _handlers[event];
  }

  /**
   * 触发事件
   * @param {string} event
   * @param {*} payload
   */
  function emit(event, payload) {
    var list = _handlers[event];
    if (!list || !list.length) return;
    // 快照, 防止 handler 中 off 导致遍历异常
    var snapshot = list.slice();
    for (var i = 0; i < snapshot.length; i++) {
      try { snapshot[i](payload); } catch (e) { console.warn('[Bus]', event, 'handler 异常:', e); }
    }
  }

  /** 当前事件订阅数 (调试用) */
  function listenerCount(event) {
    return _handlers[event] ? _handlers[event].length : 0;
  }

  Core.Bus = { emit, on, off, listenerCount };
})();
