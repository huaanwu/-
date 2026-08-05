/**
 * Core.Scheduler — 跨域定时调度器 (v0.2.24 V2)
 *
 * 设计:
 *   - 轻量轮询: 每 60s tick, 检查每个 task 的 lastRunMap + intervalMs
 *   - 注册 API: register(name, fn, intervalMs, opts?)
 *   - 重叠防护: 同名 task 在跑时跳过本次 tick
 *   - 失败兜底: 单 task 抛错不污染其他 task
 *   - 不引入 cron 库, 走「绝对间隔」模型 (够 v0.2.24 用)
 *
 * 用法 (app.js init 末尾):
 *   Core.Scheduler.init();                                        // 启动 60s tick
 *   Core.Scheduler.register('regime-refresh', () => Regime.refresh(), 5*60*1000);
 *   Core.Scheduler.register('paper-eod', () => Paper.maybeGenerateEodReport(), 60*60*1000);
 */
(function () {
  'use strict';
  window.Core = window.Core || {};

  const TICK_MS = 60 * 1000;

  /**
   * task: {
   *   name: string
   *   fn: () => Promise|void
   *   intervalMs: number
   *   lastRunAt: number (ms)
   *   lastResult: 'ok'|'fail'|null
   * }
   */
  const _tasks = new Map();
  const _running = new Set();
  let _timer = null;

  /**
   * 注册一个定时任务
   * @param {string} name  任务名 (唯一)
   * @param {Function} fn  任务函数 (async/同步都行)
   * @param {number} intervalMs  最小间隔 ms (例: 5*60*1000 = 5 分钟)
   * @param {object} [opts]
   * @param {boolean} [opts.runOnInit=false]  init 时立即跑一次
   * @param {number} [opts.jitterMs=0]  跑前 sleep 随机 ms, 防止多 task 同时触发
   * @returns {Function} 注销函数
   */
  function register(name, fn, intervalMs, opts) {
    opts = opts || {};
    if (!name || typeof fn !== 'function') {
      console.warn('[Scheduler] register 缺参数:', name, typeof fn);
      return function () {};
    }
    if (_tasks.has(name)) {
      console.warn('[Scheduler] task 已存在, 覆盖:', name);
    }
    _tasks.set(name, {
      name: name,
      fn: fn,
      intervalMs: intervalMs,
      lastRunAt: 0,
      lastResult: null,
      runOnInit: !!opts.runOnInit,
      jitterMs: opts.jitterMs || 0
    });
    return function unregister() {
      _tasks.delete(name);
    };
  }

  /**
   * 取消所有 task + 停 timer
   */
  function stop() {
    if (_timer) {
      clearInterval(_timer);
      _timer = null;
    }
    _tasks.clear();
    _running.clear();
  }

  /**
   * 启动 60s tick 循环
   */
  function init() {
    if (_timer) return;
    _timer = setInterval(_tick, TICK_MS);
    // 启动时跑一次 runOnInit 的 task
    _tasks.forEach(function (t) {
      if (t.runOnInit) _runOne(t);
    });
  }

  /**
   * tick 主循环: 检查每个 task 是否到期, 是则跑
   */
  async function _tick() {
    const now = Date.now();
    const ready = [];
    _tasks.forEach(function (t) {
      if (_running.has(t.name)) return;
      if (now - t.lastRunAt >= t.intervalMs) ready.push(t);
    });
    if (ready.length === 0) return;
    // 并发跑 (不互等, 单个失败不拖垮)
    ready.forEach(_runOne);
  }

  /**
   * 跑一个 task (内部用, 含重叠防护 + 兜底)
   */
  async function _runOne(t) {
    if (_running.has(t.name)) return;
    _running.add(t.name);
    try {
      if (t.jitterMs > 0) {
        await new Promise(function (r) { setTimeout(r, Math.random() * t.jitterMs); });
      }
      await t.fn();
      t.lastResult = 'ok';
    } catch (e) {
      t.lastResult = 'fail';
      console.warn('[Scheduler] task 失败:', t.name, e && e.message || e);
    } finally {
      t.lastRunAt = Date.now();
      _running.delete(t.name);
    }
  }

  /**
   * 立即强制跑一个 task (无视 intervalMs, 用于手动触发)
   */
  function runNow(name) {
    const t = _tasks.get(name);
    if (!t) {
      console.warn('[Scheduler] runNow 找不到 task:', name);
      return;
    }
    _runOne(t);
  }

  /**
   * 调试用: 列出所有 task + 上次运行时间 + 上次结果
   */
  function list() {
    return Array.from(_tasks.values()).map(function (t) {
      return {
        name: t.name,
        intervalMs: t.intervalMs,
        lastRunAt: t.lastRunAt,
        lastResult: t.lastResult,
        running: _running.has(t.name)
      };
    });
  }

  window.Core.Scheduler = {
    register: register,
    init: init,
    stop: stop,
    runNow: runNow,
    list: list
  };
})();