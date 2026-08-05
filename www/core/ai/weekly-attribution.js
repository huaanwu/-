/**
 * WeeklyAttribution - 周度 AI 归因 (v0.2.24 V7)
 *
 * 每周日 21:00 自动跑(由 WeeklyReview 调度)
 * 流程:
 *   1. 算当前 weekId (YYYY-WW, ISO 周编号)
 *   2. 算本周时间窗 (sinceTs = 周一 00:00, untilTs = 下周一 00:00)
 *   3. 拉本周 decision_traces + trade_journal_ext + missed_opportunities (按 strategy)
 *   4. 算简单统计 (totalPnl / winRate / regimeAvg / factorAvg / aiCalls / journalCount / topGainer / topLoser)
 *   5. 喂 AI 写一段 summary (引用决策事件 + 实际成交对账, 不超过 400 字)
 *   6. 落 weekly_attribution (主键 `${weekId}:${strategy}`, V3 复合键防跨策略覆盖)
 *
 * AI 失败兜底: 不重试, summary 标 "AI 归因失败: <error>", 仍然落库
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const W = window.Core.AI = window.Core.AI || {};

  /**
   * ISO 周编号 (YYYY-WW) — 取本周一作为本周起点
   * 兼容: 不同浏览器 Date.prototype.toISOString 对 UTC 周编号不同
   *   这里走「Monday-based week, ISO 8601」标准
   */
  function weekIdOf(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const dayNum = t.getUTCDay() || 7;   // Sun=0 → 7
    t.setUTCDate(t.getUTCDate() + 4 - dayNum);   // 移到本周四所在的周
    const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((t - yearStart) / 86400000) + 1) / 7);
    return t.getUTCFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }

  /**
   * 算本周时间窗 [sinceTs, untilTs)
   * 起点: 本周一 00:00 (本地时区)
   * 终点: 下周一 00:00
   */
  function weekWindowOf(d) {
    const day = d.getDay();   // 0=Sun, 1=Mon, ..., 6=Sat
    const offsetToMon = day === 0 ? -6 : 1 - day;
    const mon = new Date(d.getFullYear(), d.getMonth(), d.getDate() + offsetToMon, 0, 0, 0, 0);
    const nextMon = new Date(mon.getTime() + 7 * 86400000);
    return { sinceTs: mon.getTime(), untilTs: nextMon.getTime(), weekStart: mon, weekEnd: nextMon };
  }

  /**
   * 拉本周某 strategy 的所有事件, 返回汇总
   * @param {string} strategy 'long'|'short'|'fund'|'agents'|'all'
   * @returns {Promise<{weekId, sinceTs, untilTs, strategy, decisionCount, exitCount, missedCount, totalPnl, winRate, regimeAvg, factorAvg, topGainer, topLoser, journalCount}>}
   */
  async function collectWeek(strategy, now) {
    if (!Core.Storage) throw new Error('WeeklyAttribution: Core.Storage 未加载');
    const win = weekWindowOf(now);
    const weekId = weekIdOf(now);
    // decision_traces
    let traces = [];
    try {
      if (strategy === 'all' || strategy === 'agents') {
        // agents: 拉全部 strategy 不为 long/short/fund 的 (即 observer/analyst/coach 杂项)
        if (Core.Storage.listDecisionTracesByStrategy) {
          traces = await Core.Storage.listDecisionTracesByStrategy('agents', win.sinceTs, win.untilTs);
        }
      } else if (Core.Storage.listDecisionTracesByStrategy) {
        traces = await Core.Storage.listDecisionTracesByStrategy(strategy, win.sinceTs, win.untilTs);
      }
    } catch (e) {
      console.warn('[WeeklyAttribution] 拉 decision_traces 失败:', e.message || e);
    }
    // trade_journal_ext
    let exits = [];
    try {
      const all = (await Core.Storage.all('trade_journal_ext')) || [];
      exits = all.filter(t =>
        t && t.sleeve === strategy
        && t.exitDate && typeof t.exitDate === 'string'
        && exitsDateInWeek(t.exitDate, win.weekStart, win.weekEnd)
      );
    } catch (e) {
      console.warn('[WeeklyAttribution] 拉 trade_journal_ext 失败:', e.message || e);
    }
    // missed_opportunities
    let missed = [];
    try {
      const all = (await Core.Storage.all('missed_opportunities')) || [];
      missed = all.filter(m =>
        m && m.sleeve === strategy
        && typeof m.notedAt === 'number'
        && m.notedAt >= win.sinceTs && m.notedAt < win.untilTs
      );
    } catch (e) {
      console.warn('[WeeklyAttribution] 拉 missed_opportunities 失败:', e.message || e);
    }

    // 简单统计
    const wins = exits.filter(t => (t.pnl || 0) > 0).length;
    const losses = exits.filter(t => (t.pnl || 0) < 0).length;
    const winRate = exits.length > 0 ? +(wins / exits.length).toFixed(4) : null;
    const totalPnl = exits.length > 0 ? +(exits.reduce((s, t) => s + (t.pnl || 0), 0)).toFixed(4) : 0;
    const regimeMap = {}, factorList = [];
    for (const t of traces) {
      if (t.regime) regimeMap[t.regime] = (regimeMap[t.regime] || 0) + 1;
      if (typeof t.factor === 'number') factorList.push(t.factor);
    }
    const regimeAvg = Object.keys(regimeMap).length > 0
      ? Object.entries(regimeMap).sort((a, b) => b[1] - a[1])[0][0]
      : null;
    const factorAvg = factorList.length > 0
      ? +(factorList.reduce((s, v) => s + v, 0) / factorList.length).toFixed(3)
      : null;

    // topGainer / topLoser (按 code 聚合 PnL)
    const byCode = {};
    for (const t of exits) {
      if (!byCode[t.code]) byCode[t.code] = { code: t.code, pnl: 0, count: 0 };
      byCode[t.code].pnl += (t.pnl || 0);
      byCode[t.code].count += 1;
    }
    const sorted = Object.values(byCode).sort((a, b) => b.pnl - a.pnl);
    const topGainer = sorted.length > 0 && sorted[0].pnl > 0 ? { code: sorted[0].code, pnl: +sorted[0].pnl.toFixed(4), count: sorted[0].count } : null;
    const topLoser = sorted.length > 1 && sorted[sorted.length - 1].pnl < 0
      ? { code: sorted[sorted.length - 1].code, pnl: +sorted[sorted.length - 1].pnl.toFixed(4), count: sorted[sorted.length - 1].count }
      : null;

    // journalCount: trade_journal_ext matched=true 的数 (回填到 journals 的)
    const journalCount = exits.filter(t => t.matched === true).length;

    return {
      weekId,
      sinceTs: win.sinceTs,
      untilTs: win.untilTs,
      strategy,
      decisionCount: traces.length,
      exitCount: exits.length,
      missedCount: missed.length,
      totalPnl,
      winRate,
      regimeAvg,
      factorAvg,
      topGainer,
      topLoser,
      journalCount,
      // 摘要样本 (供 AI 总结用, 上限 5 条决策 + 5 条成交 + 3 条错过)
      tracesSample: traces.slice(-5),
      exitsSample: exits.slice(-5),
      missedSample: missed.slice(-3)
    };
  }

  /**
   * 判定 exitDate (YYYYMMDD 字符串, 含 0 填充) 是否落在 [weekStart, weekEnd) 区间
   * 兼容: exitDate 也可能是 'YYYY-MM-DD'
   */
  function exitsDateInWeek(exitDate, weekStart, weekEnd) {
    let y, m, d;
    if (exitDate.length === 8) {
      y = +exitDate.slice(0, 4);
      m = +exitDate.slice(4, 6) - 1;
      d = +exitDate.slice(6, 8);
    } else if (exitDate.length === 10) {
      y = +exitDate.slice(0, 4);
      m = +exitDate.slice(5, 7) - 1;
      d = +exitDate.slice(8, 10);
    } else {
      return false;
    }
    const t = new Date(y, m, d).getTime();
    return t >= weekStart.getTime() && t < weekEnd.getTime();
  }

  /**
   * 喂 AI 写 summary (≤400 字), 失败时兜底
   * @returns {Promise<string>}
   */
  async function _askAiForSummary(week, summarySystem) {
    try {
      if (!Core.AI || typeof Core.AI.call !== 'function') {
        throw new Error('Core.AI.call 不可用');
      }
      const prompt = buildPrompt(week);
      const sys = summarySystem || '你是一个稳健的 A 股投资助手, 基于给定数据写一段不超过 400 字的周度归因。要求: 1) 数字直接从数据里抄, 2) 指出本周最值得记住的一件事 + 最该警惕的一件事, 3) 风格克制不夸张。';
      const out = await Core.AI.call(sys, prompt, { page: 'weekly-review', purpose: 'weekly-attribution' });
      const text = (typeof out === 'string' ? out : (out && out.text) || '').trim();
      if (!text) throw new Error('AI 返回空');
      return text.length > 1500 ? text.slice(0, 1500) + '…' : text;
    } catch (e) {
      return 'AI 归因失败: ' + (e && e.message || e) + ' (本周 ' + week.decisionCount + ' 次决策, ' + week.exitCount + ' 笔成交, 胜率 ' + (week.winRate === null ? 'N/A' : (week.winRate * 100).toFixed(0) + '%') + ')';
    }
  }

  function buildPrompt(week) {
    const lines = [];
    lines.push(`## 周度归因数据 (${week.weekId}, strategy=${week.strategy})`);
    lines.push(`时间窗: ${new Date(week.sinceTs).toISOString().slice(0, 10)} ~ ${new Date(week.untilTs - 86400000).toISOString().slice(0, 10)}`);
    lines.push(`AI 决策: ${week.decisionCount} 次`);
    lines.push(`实际成交 (trade_journal_ext): ${week.exitCount} 笔`);
    lines.push(`错过机会 (missed_opportunities): ${week.missedCount} 条`);
    lines.push(`累计 PnL: ${week.totalPnl}`);
    lines.push(`胜率: ${week.winRate === null ? 'N/A' : (week.winRate * 100).toFixed(1) + '%'}`);
    lines.push(`主导 regime: ${week.regimeAvg || 'N/A'}`);
    lines.push(`平均 factor: ${week.factorAvg === null ? 'N/A' : week.factorAvg}`);
    if (week.topGainer) lines.push(`最大盈利: ${week.topGainer.code} (${week.topGainer.pnl}, 共 ${week.topGainer.count} 笔)`);
    if (week.topLoser) lines.push(`最大亏损: ${week.topLoser.code} (${week.topLoser.pnl}, 共 ${week.topLoser.count} 笔)`);
    lines.push(`回填 journals 数: ${week.journalCount}`);
    lines.push('');
    if (week.tracesSample && week.tracesSample.length > 0) {
      lines.push('### AI 决策样本 (最近 5 条)');
      for (const t of week.tracesSample) {
        lines.push(`- ${t.ts ? new Date(t.ts).toISOString().slice(0, 10) : '?'} ${t.code || ''} ${t.agentType || ''} sleeve=${t.sleeve || ''} factor=${t.factor === null || t.factor === undefined ? 'N/A' : t.factor}`);
      }
      lines.push('');
    }
    if (week.exitsSample && week.exitsSample.length > 0) {
      lines.push('### 实际成交样本 (最近 5 笔)');
      for (const t of week.exitsSample) {
        lines.push(`- ${t.exitDate || '?'} ${t.code} ${t.sleeve || ''} pnl=${t.pnl}`);
      }
      lines.push('');
    }
    if (week.missedSample && week.missedSample.length > 0) {
      lines.push('### 错过机会样本 (最近 3 条)');
      for (const m of week.missedSample) {
        lines.push(`- ${m.date || '?'} ${m.code} signal=${m.signalType} score=${m.score || 'N/A'}`);
      }
      lines.push('');
    }
    lines.push('请基于以上数据, 用中文写一段不超过 400 字的归因 (1 段即可, 不要 markdown 标题)。');
    return lines.join('\n');
  }

  /**
   * 跑一次完整的周度归因 ETL (拉数据 + AI 总结 + 落库)
   * @param {Date} [now]
   * @param {string[]|null} [strategies] 限定 strategy 列表; null 表示 long + short + agents 三类都跑
   * @returns {Promise<Array<{strategy, weekId, saved: boolean, summary: string}>>}
   */
  async function runOnce(now = new Date(), strategies = null) {
    const list = strategies || ['long', 'short', 'agents'];
    const results = [];
    for (const strategy of list) {
      try {
        const week = await collectWeek(strategy, now);
        const summary = await _askAiForSummary(week);
        const row = {
          weekId: week.weekId,
          strategy,
          totalPnl: week.totalPnl,
          winRate: week.winRate,
          regimeAvg: week.regimeAvg,
          factorAvg: week.factorAvg,
          aiCalls: week.decisionCount,
          journalCount: week.journalCount,
          topGainer: week.topGainer,
          topLoser: week.topLoser,
          summary,
          ts: Date.now(),
          // 扩展字段 (V7 ETL 留个尾巴供后续 V8 post-mortem / V9 kb-feedback 用)
          exitCount: week.exitCount,
          missedCount: week.missedCount,
          tracesSample: week.tracesSample,
          exitsSample: week.exitsSample,
          missedSample: week.missedSample
        };
        let saved = false;
        if (Core.Storage.saveWeeklyAttribution) {
          await Core.Storage.saveWeeklyAttribution(row);
          saved = true;
        }
        results.push({ strategy, weekId: week.weekId, saved, summary });
      } catch (e) {
        console.warn('[WeeklyAttribution] ' + strategy + ' 失败:', e && e.message || e);
        results.push({ strategy, weekId: weekIdOf(now), saved: false, summary: '归因失败: ' + (e && e.message || e) });
      }
    }
    return results;
  }

  W.WeeklyAttribution = {
    weekIdOf,
    weekWindowOf,
    collectWeek,
    runOnce,
    // 测试钩子 (内部用)
    _exitsDateInWeek: exitsDateInWeek,
    _buildPrompt: buildPrompt
  };
})();