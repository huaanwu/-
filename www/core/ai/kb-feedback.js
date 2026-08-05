/**
 * KBFeedback - KB 命中率统计 + 自动调权重 (v0.2.24 V9)
 *
 * 设计:
 *   - 每次 PolicyBundle.load() 注入 KB 时, 调 KBFeedback.record({strategy, kbIds, runId, ts})
 *     → 落内存 ring buffer (默认 500 行, 超出滚动截断)
 *   - 周日 WeeklyAttribution 跑完后, KBFeedback.flushWeek() 计算本周 hit rate
 *     (AI 实际引用 KB entry 数 / AI 看过的 KB entry 数), 写 kb_hit_log 表
 *   - hit rate < 30% → 微调 KB_BY_STRATEGY 顺序, 把低 hit 的 category 后置 (调用 PolicyBundle.refresh())
 *
 * 不引入新表 (V3 schema 不变), 复用现有 kv: kb_hit_log (主键 ts+strategy+runId)
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const K = window.Core.AI = window.Core.AI || {};

  const RING_LIMIT = 500;
  const HIT_RATE_THRESHOLD = 0.30;   // 低于 30% 触发自动调权
  const LOW_HIT_CATEGORIES_TO_DEMOTE = 1;   // 把 hit rate 最差的 1 个 category 后置

  // 内存 ring buffer (跨页面会话丢失 OK, 落库是 source of truth)
  const _ring = [];

  /**
   * 记录一次 AI 决策的 KB 引用
   * @param {object} evt
   * @param {string} evt.strategy
   * @param {string[]} evt.kbIds - 注入 prompt 的 KB entry id 列表
   * @param {string} [evt.runId]
   * @param {number} [evt.ts]
   * @returns {Promise<{logged: boolean}>}
   */
  async function record(evt) {
    if (!evt || !evt.strategy || !Array.isArray(evt.kbIds)) {
      return { logged: false };
    }
    const row = {
      strategy: evt.strategy,
      kbIds: evt.kbIds.slice(),   // 防外部修改
      runId: evt.runId || null,
      ts: evt.ts || Date.now()
    };
    _ring.push(row);
    if (_ring.length > RING_LIMIT) _ring.shift();   // ring buffer 滚动
    // 异步写 kv (不阻塞 caller)
    try {
      const kv = (await Core.Storage.kvGet('kb_hit_log')) || [];
      kv.push(row);
      // ring buffer 上限
      while (kv.length > RING_LIMIT) kv.shift();
      await Core.Storage.kvSet('kb_hit_log', kv);
    } catch (e) {
      console.warn('[KBFeedback] 写 kv 失败:', e && e.message || e);
    }
    return { logged: true };
  }

  /**
   * 计算本周某 strategy 的 hit rate + 各 category hit rate
   * 注意: "hit" 定义 = AI 实际引用过的 KB id (从 weekly_attribution.summary 文本里 grep)
   *       "seen" 定义 = 注入 prompt 的 KB id (kb_hit_log)
   *
   * @returns {Promise<{strategy, weekStart, weekEnd, totalSeen, totalHit, hitRate, byCategory: {cat: hitRate}}>}
   */
  async function flushWeek(strategy, now = new Date(), opts = {}) {
    if (!Core.Storage) return null;
    const sinceTs = opts.sinceTs;
    const untilTs = opts.untilTs;
    // 1. 拿本周 kb_hit_log
    let logs = [];
    try {
      const all = (await Core.Storage.kvGet('kb_hit_log')) || [];
      logs = all.filter(r => r.strategy === strategy && r.ts >= sinceTs && r.ts < untilTs);
    } catch (e) {
      console.warn('[KBFeedback] 读 kb_hit_log 失败:', e && e.message || e);
    }
    if (logs.length === 0) {
      return { strategy, weekStart: sinceTs, weekEnd: untilTs, totalSeen: 0, totalHit: 0, hitRate: null, byCategory: {} };
    }
    // 2. 拿本周 weekly_attribution 的 AI summary (用于 grep 哪些 KB id 被引用)
    let summaries = [];
    try {
      const all = (await Core.Storage.all('weekly_attribution')) || [];
      const weekId = (opts.weekId) || (Core.AI && Core.AI.WeeklyAttribution && Core.AI.WeeklyAttribution.weekIdOf(now));
      summaries = all.filter(r => r.strategy === strategy && r.weekId === (weekId + ':' + strategy)).map(r => r.summary || '');
    } catch (e) {
      console.warn('[KBFeedback] 读 weekly_attribution 失败:', e && e.message || e);
    }
    const summaryText = summaries.join('\n');
    // 3. seen: 注入过的所有 KB id (去重)
    const seenMap = {};
    for (const r of logs) {
      for (const id of r.kbIds) seenMap[id] = (seenMap[id] || 0) + 1;
    }
    // 4. hit: 在 summary 文本里出现的 KB id
    let totalSeen = 0, totalHit = 0;
    const byCategory = {};
    const KB = Core.KB;
    for (const id of Object.keys(seenMap)) {
      totalSeen += seenMap[id];
      // 简化: 用 id 前缀当 category (e.g. "VALUATION-001" → "valuation")
      const catPrefix = id.split('-')[0].toLowerCase();
      const cat = _normalizeCategory(catPrefix);
      if (summaryText.indexOf(id) >= 0) {
        totalHit += seenMap[id];
        byCategory[cat] = byCategory[cat] || { seen: 0, hit: 0 };
        byCategory[cat].hit += seenMap[id];
      }
      byCategory[cat] = byCategory[cat] || { seen: 0, hit: 0 };
      byCategory[cat].seen += seenMap[id];
    }
    // 5. byCategory 算 hit rate
    const byCategoryRate = {};
    for (const cat of Object.keys(byCategory)) {
      const s = byCategory[cat].seen;
      const h = byCategory[cat].hit;
      byCategoryRate[cat] = s > 0 ? +(h / s).toFixed(4) : null;
    }
    const hitRate = totalSeen > 0 ? +(totalHit / totalSeen).toFixed(4) : null;
    return { strategy, weekStart: sinceTs, weekEnd: untilTs, totalSeen, totalHit, hitRate, byCategory: byCategoryRate };
  }

  function _normalizeCategory(prefix) {
    // KB id 命名: VALUATION-XXX / RISK-XXX / CYCLE-XXX 等
    const map = {
      valuation: 'valuation',
      risk: 'risk',
      cycle: 'cycle',
      position: 'position',
      policy: 'policy',
      behavior: 'behavior',
      case: 'case',
      fixed_income: 'fixed_income',
      fixed: 'fixed_income',
      fund: 'fund',
      rule: 'rule',
      discipline: 'discipline',
      macro: 'macro_signal',
      macro_signal: 'macro_signal',
      history: 'history_analog',
      history_analog: 'history_analog',
      mao: 'rule'
    };
    return map[prefix] || prefix;
  }

  /**
   * 自动调权重: 找 hit rate 最差的 category, 后置一位
   * 注: PolicyBundle.KB_BY_STRATEGY 是 const, 不能直接改; 改成 PolicyBundle 暴露 setter
   *   这里只生成建议数组 (新顺序), 调用方决定是否落库
   * @returns {Promise<{strategy, oldOrder: string[], newOrder: string[], demotedCategory: string|null}>}
   */
  async function suggestReorder(strategy, weekReport = null) {
    if (!Core.AI || !Core.AI.PolicyBundle) {
      return { strategy, oldOrder: [], newOrder: [], demotedCategory: null };
    }
    const oldOrder = (Core.AI.PolicyBundle._KB_BY_STRATEGY && Core.AI.PolicyBundle._KB_BY_STRATEGY[strategy])
      ? Core.AI.PolicyBundle._KB_BY_STRATEGY[strategy].slice()
      : [];
    if (!weekReport) weekReport = await flushWeek(strategy, new Date(), {});
    if (!weekReport || weekReport.hitRate === null || weekReport.hitRate >= HIT_RATE_THRESHOLD) {
      return { strategy, oldOrder, newOrder: oldOrder.slice(), demotedCategory: null };
    }
    if (!weekReport.byCategory) {
      return { strategy, oldOrder, newOrder: oldOrder.slice(), demotedCategory: null };
    }
    // 找 hit rate 最差的 category (且 seen > 0)
    const cats = Object.entries(weekReport.byCategory)
      .filter(([c, r]) => r !== null && oldOrder.indexOf(c) >= 0)
      .sort((a, b) => a[1] - b[1]);
    if (cats.length === 0) {
      return { strategy, oldOrder, newOrder: oldOrder.slice(), demotedCategory: null };
    }
    const demotedCategory = cats[0][0];
    const demotedIdx = oldOrder.indexOf(demotedCategory);
    if (demotedIdx < 0) {
      return { strategy, oldOrder, newOrder: oldOrder.slice(), demotedCategory: null };
    }
    const newOrder = oldOrder.slice();
    newOrder.splice(demotedIdx, 1);
    newOrder.push(demotedCategory);
    return { strategy, oldOrder, newOrder, demotedCategory };
  }

  /**
   * 应用 reorder 建议: 写入 PolicyBundle 内存表 + kv 持久化 (重启可恢复)
   */
  async function applyReorder(strategy, newOrder) {
    if (!Core.AI || !Core.AI.PolicyBundle) return false;
    if (Core.AI.PolicyBundle._setKbOrder) {
      Core.AI.PolicyBundle._setKbOrder(strategy, newOrder);
    }
    try {
      const all = (await Core.Storage.kvGet('kb_order_override')) || {};
      all[strategy] = newOrder;
      await Core.Storage.kvSet('kb_order_override', all);
    } catch (e) {
      console.warn('[KBFeedback] 持久化 kb_order_override 失败:', e && e.message || e);
    }
    return true;
  }

  /**
   * 启动: 加载 kb_order_override 到 PolicyBundle
   */
  async function init() {
    if (!Core.Storage) return;
    try {
      const all = (await Core.Storage.kvGet('kb_order_override')) || {};
      if (Core.AI && Core.AI.PolicyBundle && Core.AI.PolicyBundle._setKbOrder) {
        for (const k of Object.keys(all)) {
          Core.AI.PolicyBundle._setKbOrder(k, all[k]);
        }
      }
    } catch (e) {
      console.warn('[KBFeedback] 启动加载 kb_order_override 失败:', e && e.message || e);
    }
  }

  // 调试用
  function _ringSnapshot() {
    return _ring.slice();
  }
  function _ringClear() {
    _ring.length = 0;
  }

  K.KBFeedback = {
    record,
    flushWeek,
    suggestReorder,
    applyReorder,
    init,
    // 调试
    _ringSnapshot,
    _ringClear,
    // 常量
    RING_LIMIT,
    HIT_RATE_THRESHOLD
  };
})();