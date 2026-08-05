/**
 * V13 阶段 2 — Electron 主进程调度器 (daemon 化骨架)
 *
 * 与 V2 Core.Scheduler (renderer 端) 并存, 不冲突:
 *   - Core.Scheduler (renderer): UI 关闭即停, 跑 UI 相关 task
 *   - Daemon (main): 独立常驻, 跑数据/分析/AI 调度, 关闭 BrowserWindow 不停
 *
 * 设计:
 *   - setInterval 60s tick, 调 tick(now)
 *   - 注册 task: { name, interval, fn, lastRunAt }
 *   - 错失败不中断下一个 tick
 *   - 心跳上报 task 状态
 */
'use strict';

class Daemon {
  constructor(opts = {}) {
    this.opts = opts;
    this.tasks = new Map();   // name -> { name, interval, fn, lastRunAt, lastError, runCount }
    this.tickHandle = null;
    this.startedAt = null;
    this.running = new Set(); // 当前正在跑 (防重叠)
  }

  /**
   * 注册 task
   * @param {string} name
   * @param {number} intervalMs 跑间隔 (ms)
   * @param {Function} fn async (now: Date) => Promise
   * @param {object} [opts] { jitterMs, runOnInit }
   */
  register(name, intervalMs, fn, opts = {}) {
    if (typeof fn !== 'function') throw new Error('[Daemon] task fn 必须是函数: ' + name);
    if (intervalMs < 1000) throw new Error('[Daemon] interval 至少 1000ms: ' + name);
    if (this.tasks.has(name)) throw new Error('[Daemon] task 已存在: ' + name);
    this.tasks.set(name, {
      name,
      interval: intervalMs,
      fn,
      lastRunAt: 0,
      lastError: null,
      runCount: 0,
      jitterMs: opts.jitterMs || 0,
      runOnInit: !!opts.runOnInit
    });
  }

  /** 启动 daemon (开始 60s tick) */
  start() {
    if (this.tickHandle) return;   // 已启动
    this.startedAt = Date.now();
    this.tickHandle = setInterval(() => this._onTick(), 60 * 1000);
    console.log('[Daemon] 启动, 注册 ' + this.tasks.size + ' 个 task');
    // runOnInit 的 task 立刻跑 (不 await, 后台)
    if (this.opts.runOnInit !== false) {
      this._onTick().catch(() => {});
    }
  }

  /** 停止 daemon */
  stop() {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
      console.log('[Daemon] 停止');
    }
  }

  /** 60s tick — 触发到期 task */
  async _onTick() {
    const now = Date.now();
    for (const task of this.tasks.values()) {
      if (this.running.has(task.name)) continue;   // 防重叠
      const elapsed = now - task.lastRunAt;
      if (elapsed >= task.interval) {
        // jitter 偏移 (避免同时跑)
        const jitter = task.jitterMs ? Math.floor(Math.random() * task.jitterMs) : 0;
        this._runTask(task, now + jitter).catch(() => {});
      }
    }
  }

  async _runTask(task, scheduledAt) {
    this.running.add(task.name);
    try {
      await new Promise(r => setTimeout(r, Math.max(0, scheduledAt - Date.now())));
      const t0 = Date.now();
      await task.fn(new Date());
      const dur = Date.now() - t0;
      task.lastRunAt = Date.now();
      task.lastError = null;
      task.runCount++;
      console.log('[Daemon] ' + task.name + ' 完成, 耗时 ' + dur + 'ms');
    } catch (e) {
      task.lastRunAt = Date.now();   // 失败也算跑过, 避免每 60s 都重试同一个坏 task
      task.lastError = e.message || String(e);
      task.runCount++;
      console.warn('[Daemon] ' + task.name + ' 失败: ' + task.lastError);
    } finally {
      this.running.delete(task.name);
    }
  }

  /** 强制立刻跑一个 task (绕 interval 限制) */
  async runNow(name) {
    const task = this.tasks.get(name);
    if (!task) throw new Error('[Daemon] task 不存在: ' + name);
    await this._runTask(task, Date.now());
  }

  /** 列出所有 task 状态 */
  status() {
    const out = [];
    for (const t of this.tasks.values()) {
      out.push({
        name: t.name,
        interval: t.interval,
        lastRunAt: t.lastRunAt,
        runCount: t.runCount,
        lastError: t.lastError,
        running: this.running.has(t.name)
      });
    }
    return out;
  }
}

module.exports = { Daemon };