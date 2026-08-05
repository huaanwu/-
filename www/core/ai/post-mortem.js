/**
 * PostMortem - 事后复盘 (v0.2.24 V8)
 *
 * 每天 15:30 paper.maybeGenerateEodReport 之后自动跑, 给当天每条 sleeve='short' 的成交
 * 写一段事后归因 (what went right / what went wrong / could-do-better)
 * 落 trade_journal_ext 字段 postMortem + postMortemAt, 累计一周聚合到 weekly_attribution
 *
 * 设计:
 *   - 输入: trade_journal_ext.sleeve='short' && !postMortemAt && exitDate=今天
 *   - 拿对应时段的 decision_traces (同一 sleeve + 同 code)
 *   - 喂 AI 写 80-150 字事后复盘 (避免上下文爆炸)
 *   - 写回 trade_journal_ext (postMortem / postMortemAt)
 *   - 失败兜底: 标 "post-mortem 失败: <error>"
 *   - 同 ticker 同日多笔成交时聚合复盘 (避免重复喂 AI)
 *
 * 调度: 注册到 Core.Scheduler, 每天 15:45 跑 (给 EOD 15:30 留 15 分钟缓冲)
 *   通过 paper.maybeGenerateEodReport 后置 hook 触发更稳 (paper.js 改 V8 阶段先不做)
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const A = window.Core.AI = window.Core.AI || {};

  /**
   * 拿今天 sleeve='short' 的成交 (未做过 post-mortem 的)
   * @returns {Promise<Array>}
   */
  async function _loadTodayTrades(sleeve, date) {
    if (!Core.Storage || typeof Core.Storage.all !== 'function') return [];
    const all = (await Core.Storage.all('trade_journal_ext')) || [];
    return all.filter(t => t && t.sleeve === sleeve && t.exitDate === date && !t.postMortemAt);
  }

  /**
   * 按 code 聚合今天的多笔成交
   */
  function _aggregateByCode(trades) {
    const map = {};
    for (const t of trades) {
      if (!t.code) continue;
      if (!map[t.code]) map[t.code] = { code: t.code, trades: [], totalPnl: 0 };
      map[t.code].trades.push(t);
      map[t.code].totalPnl += (t.pnl || 0);
    }
    return Object.values(map);
  }

  /**
   * 拿某 code 当天的 decision_traces (供 prompt 用)
   */
  async function _loadTraces(code, sinceTs, untilTs) {
    if (!Core.Storage || typeof Core.Storage.listDecisionTracesByStrategy !== 'function') return [];
    try {
      const all = (await Core.Storage.listDecisionTracesByStrategy('short', sinceTs, untilTs)) || [];
      return all.filter(t => t.code === code).slice(-3);
    } catch (e) {
      return [];
    }
  }

  /**
   * 喂 AI 写单条事后复盘 (80-150 字)
   */
  async function _askAiForPostMortem(code, totalPnl, trades, traces) {
    if (!Core.AI || typeof Core.AI.call !== 'function') {
      throw new Error('Core.AI.call 不可用');
    }
    const sys = '你是一个稳健的 A 股短线复盘助手。基于给定数据写 80-150 字的事后归因, 分三点: ✅ 做对的事 / ❌ 做错的事 / 💡 下次能改进的。只用一段, 不超过 150 字, 数字直接从数据抄。';
    const lines = [];
    lines.push(`## 事后复盘 ${code} (短线, 当日累计 PnL ${(totalPnl * 100).toFixed(2)}%)`);
    lines.push(`成交笔数: ${trades.length}`);
    for (const t of trades) {
      lines.push(`- ${t.type || 'exit'} @${t.exitPrice} plan=${t.planPrice} pnl=${(t.pnl * 100).toFixed(2)}%`);
    }
    if (traces && traces.length > 0) {
      lines.push('相关决策:');
      for (const tr of traces) {
        lines.push(`- ${tr.agentType || ''} ${tr.regime || ''} factor=${tr.factor === null || tr.factor === undefined ? 'N/A' : tr.factor} payload=${JSON.stringify(tr.payload || {}).slice(0, 120)}`);
      }
    }
    const prompt = lines.join('\n') + '\n\n请用中文写 80-150 字事后复盘。';
    const out = await Core.AI.call(sys, prompt, { page: 'post-mortem', purpose: 'short-post-mortem' });
    const text = (typeof out === 'string' ? out : (out && out.text) || '').trim();
    if (!text) throw new Error('AI 返回空');
    return text.length > 500 ? text.slice(0, 500) + '…' : text;
  }

  /**
   * 跑一次事后复盘 (当天所有 sleeve='short' 未做过的成交)
   * @param {Date} [now]
   * @returns {Promise<{scanned: number, postMortemCount: number, errors: string[]}>}
   */
  async function runOnce(now = new Date(), sleeve = 'short') {
    const result = { scanned: 0, postMortemCount: 0, errors: [] };
    const today = now.toISOString().slice(0, 10).replace(/-/g, '');
    const trades = await _loadTodayTrades(sleeve, today);
    result.scanned = trades.length;
    if (trades.length === 0) return result;

    // 聚合按 code
    const grouped = _aggregateByCode(trades);
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime();
    const dayEnd = dayStart + 86400000;

    for (const group of grouped) {
      const traces = await _loadTraces(group.code, dayStart, dayEnd);
      let pm = '';
      try {
        pm = await _askAiForPostMortem(group.code, group.totalPnl, group.trades, traces);
      } catch (e) {
        pm = 'post-mortem 失败: ' + (e && e.message || e);
        result.errors.push(group.code + ': ' + (e && e.message || e));
      }
      // 写回 trade_journal_ext 所有同 code 笔
      try {
        for (const t of group.trades) {
          await Core.Storage.put('trade_journal_ext', {
            ...t,
            postMortem: pm,
            postMortemAt: Date.now()
          });
          result.postMortemCount += 1;
        }
      } catch (e) {
        console.warn('[PostMortem] 写回 trade_journal_ext 失败:', e && e.message || e);
        result.errors.push(group.code + ' write: ' + (e && e.message || e));
      }
      // S5 闭环: 每组复盘完后写一条 steward_lessons (失败吞, 不阻塞 post-mortem)
      try {
        if (Core.Steward && Core.Steward.Lessons && typeof Core.Steward.Lessons.recordLesson === 'function') {
          const wins = group.trades.filter(t => (t.pnl || 0) > 0).length;
          const wr = group.trades.length > 0 ? wins / group.trades.length : 0.5;
          await Core.Steward.Lessons.recordLesson({
            decision: {
              code: group.code,
              sleeve: sleeve,
              strategy: (traces && traces.length > 0 && traces[traces.length - 1].strategy) || 'default',
              pattern: 'post-mortem:' + sleeve,
              action: group.trades[0] && group.trades[0].type || 'exit',
              regime: traces && traces.length > 0 ? traces[traces.length - 1].regime : null
            },
            outcome: { pnl: group.totalPnl, winRate: wr },
            postMortem: pm
          });
        }
      } catch (e) {
        console.warn('[PostMortem] recordLesson 失败 (吞):', e && e.message || e);
      }
    }
    return result;
  }

  /**
   * 调度: 每天 15:45 跑 (EOD 15:30 后留 15 分钟缓冲)
   * 启动时立即补跑一次
   */
  async function init() {
    if (!Core.Scheduler || typeof Core.Scheduler.register !== 'function') {
      console.warn('[PostMortem] Core.Scheduler 不可用');
      return;
    }
    Core.Scheduler.register('post-mortem', () => runOnce(new Date(), 'short'), 60 * 60 * 1000, {
      jitterMs: 15 * 60 * 1000,   // 任意 1h tick 内 +15min 抖动
      runOnInit: false
    });
    // 启动时立即补跑
    try {
      await runOnce(new Date(), 'short');
    } catch (e) {
      console.warn('[PostMortem] 启动补跑失败:', e && e.message || e);
    }
  }

  /**
   * 手动触发
   */
  async function runNow() {
    return await runOnce(new Date(), 'short');
  }

  A.PostMortem = {
    init,
    runNow,
    runOnce,
    // 测试钩子
    _loadTodayTrades,
    _aggregateByCode,
    _loadTraces,
    _askAiForPostMortem
  };
})();