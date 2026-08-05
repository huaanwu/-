/**
 * WeeklyReview - 周度归因调度器 (v0.2.24 V7)
 *
 * 调度逻辑:
 *   - 注册到 Core.Scheduler (每日 09:00 跑一次, 内部判定是否周日)
 *   - 周日 21:00 强制跑一次 (用 Core.Scheduler.jitterMs 做随机延迟, 防多实例碰撞)
 *   - 手动: WeeklyReview.runNow() 强制跑
 *   - 启动 (app.js init): 立即跑一次 (runOnInit, 失败吞), 补错过的归因 (例如上次周日没开机)
 *
 * 依赖:
 *   - Core.Storage.saveWeeklyAttribution
 *   - Core.AI.WeeklyAttribution.runOnce
 *   - Core.Scheduler
 *
 * 注意: 周度归因 ETL 由 Core.AI.WeeklyAttribution 完成, 本模块只负责调度时机
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const W = window.Core.AI = window.Core.AI || {};

  // 周日判定 (本地时区)
  function _isSunday(d = new Date()) {
    return d.getDay() === 0;
  }

  // 上周日判定 (周一早上跑, 补归因)
  function _isMonday(d = new Date()) {
    return d.getDay() === 1;
  }

  /**
   * 跑一次周度归因 (入口)
   * @param {Date} [now]
   * @param {string[]} [strategies] 限定 strategy 列表
   * @returns {Promise<Array>}
   */
  async function runOnce(now = new Date(), strategies = null) {
    if (!Core.AI || !Core.AI.WeeklyAttribution || typeof Core.AI.WeeklyAttribution.runOnce !== 'function') {
      console.warn('[WeeklyReview] Core.AI.WeeklyAttribution 不可用');
      return [];
    }
    try {
      const results = await Core.AI.WeeklyAttribution.runOnce(now, strategies);
      // 跑完打个标 (kv weekly_review_last_run)
      try {
        await Core.Storage.kvSet('weekly_review_last_run', {
          ts: Date.now(),
          date: now.toISOString().slice(0, 10),
          count: results.length,
          strategies: (strategies || ['long', 'short', 'agents']).join(',')
        });
      } catch (e) {
        console.warn('[WeeklyReview] 写 last_run 标记失败:', e && e.message || e);
      }
      // S5 闭环: weekly-attribution 算完后, 自动从本周 lessons 蒸馏候选
      // (候选写 rule_candidates 表, 不直接动 KB JSON, 走人审)
      try {
        if (Core.Steward && Core.Steward.Lessons && typeof Core.Steward.Lessons.distill === 'function') {
          // 拿本周 lessons (sinceTs = 本周一 00:00)
          const day = now.getDay();
          const offsetToMon = day === 0 ? -6 : 1 - day;
          const sinceTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetToMon, 0, 0, 0, 0).getTime();
          const filterList = strategies || ['long', 'short', 'agents'];
          let allCandidates = [];
          for (const sleeve of filterList) {
            const lessons = await Core.Steward.Lessons.listLessons({ sleeve, limit: 200 });
            const recent = (lessons || []).filter(l => (l.ts || 0) >= sinceTs);
            const cands = Core.Steward.Lessons.distill(recent);
            allCandidates = allCandidates.concat(cands);
          }
          // 自动写候选 (status=pending), 不直接改 KB
          for (const c of allCandidates) {
            if (Core.Storage && typeof Core.Storage.addRuleCandidate === 'function') {
              const candId = 'cand-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
              try {
                await Core.Storage.addRuleCandidate({
                  candId,
                  status: 'pending',
                  source: `weekly-review.${sleeve || 'all'}.${new Date().toISOString().slice(0, 10)}`,
                  pattern: c.pattern,
                  code: c.code,
                  sleeve: c.sleeve,
                  sampleWinRate: c.sampleWinRate,
                  deviation: c.deviation,
                  sampleSize: c.sampleSize,
                  direction: c.direction,
                  suggestedAction: c.suggestedAction,
                  ts: Date.now()
                });
              } catch (e) { /* 重复 candId / 同 source 已存在都吞 */ }
            }
          }
        }
      } catch (e) {
        console.warn('[WeeklyReview] distill 候选失败 (吞):', e && e.message || e);
      }
      return results;
    } catch (e) {
      console.warn('[WeeklyReview] runOnce 失败:', e && e.message || e);
      return [];
    }
  }

  /**
   * 调度器 tick: 检查是否到时间, 是则跑
   * 触发条件:
   *   - 周日 21:00 后 (且 24 小时内没跑过, 防止重复)
   *   - 周一 09:00 后 (补跑昨天的归因)
   */
  async function _tick(injectedNow) {
    const now = injectedNow || new Date();
    const hour = now.getHours();
    // 只在周日 21:00 后 或 周一全天 跑
    const isSundayEvening = _isSunday(now) && hour >= 21;
    const isMondayAllDay = _isMonday(now);
    if (!isSundayEvening && !isMondayAllDay) return;
    // 检查今日是否已跑过
    let last = null;
    try {
      last = await Core.Storage.kvGet('weekly_review_last_run');
    } catch (e) { /* ignore */ }
    const today = now.toISOString().slice(0, 10);
    if (last && last.date === today) return;   // 今日已跑
    await runOnce(now);
  }

  /**
   * 启动: 注册 Scheduler + 启动时补跑 (失败吞)
   */
  async function init() {
    if (!Core.Scheduler || typeof Core.Scheduler.register !== 'function') {
      console.warn('[WeeklyReview] Core.Scheduler 不可用, 不注册');
      return;
    }
    // 每日 09:00 跑一次 (内部判定周日/周一才真跑)
    Core.Scheduler.register('weekly-review', _tick, 60 * 60 * 1000, {
      jitterMs: 10 * 60 * 1000,    // 09:00 ± 10 分钟, 防多实例对齐
      runOnInit: false
    });
    // 启动时立即跑一次 (补归因)
    try {
      await runOnce(new Date());
    } catch (e) {
      console.warn('[WeeklyReview] 启动补跑失败:', e && e.message || e);
    }
  }

  /**
   * 手动触发
   */
  async function runNow() {
    return await runOnce(new Date());
  }

  W.WeeklyReview = {
    init,
    runNow,
    runOnce,
    // 测试钩子
    _isSunday,
    _isMonday,
    _tick
  };
})();