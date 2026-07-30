/**
 * Core.Agents - 多智能体 (5.3.1)
 *
 * 三个 agent 各司其职, 一个 orchestrator 路由:
 *   observer  观察者: 拉事实 (持仓/告警/复盘/行情) → JSON observations
 *   analyst   分析师: 看数据找问题/机会 → JSON findings
 *   coach     教练:   给行动 (加减仓/止损/止盈/观望) → JSON actions
 *   orchestrator: 按 intent 串起来, 返回完整链路 + final
 *
 * 设计原则:
 *   - 每个 agent 是纯函数: (ctx, opts) → {ok, summary, data, raw, model, isLocal}
 *   - LLM 严格 JSON 输出, 候选值校验, 非法值回退默认
 *   - 测试友好: 可注入 deps.callLLM 覆盖 Core.AI.call
 *   - 本地 LLM 优先 (5.3.3): 默认 opts.local=true, 让家庭部署跑得起
 */
(function() {
  'use strict';

  // ===== 公共 JSON 候选值 (LLM 必须从这里选) =====
  const ALLOWED = {
    observationCategory: ['holding', 'alert', 'journal', 'market', 'news', 'other'],
    observationSeverity: ['info', 'warning', 'critical'],
    findingType: ['positive', 'negative', 'neutral', 'uncertain'],
    findingConfidence: ['low', 'medium', 'high'],
    coachAction: ['hold', 'add', 'reduce', 'exit', 'watch', 'rebalance', 'investigate'],
    coachUrgency: ['low', 'medium', 'high', 'immediate']
  };

  // ===== 容错: 把 LLM 返回解析成数组, 非法字段用默认 =====
  function _coerceList(rawText, key, allowedValues) {
    let parsed = null;
    try {
      // 去掉可能的 ```json 包裹
      const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch (e) {
      // 尝试截取 { ... } 段
      const m = rawText.match(/\{[\s\S]*\}/);
      if (m) {
        try { parsed = JSON.parse(m[0]); } catch (e2) { return []; }
      } else {
        return [];
      }
    }
    const list = parsed?.[key];
    if (!Array.isArray(list)) return [];
    return list.filter(item => item && typeof item === 'object').map(item => {
      // 校验枚举值
      if (allowedValues) {
        for (const field of Object.keys(allowedValues)) {
          if (item[field] && !allowedValues[field].includes(item[field])) {
            item[field] = allowedValues[field][0];
          }
        }
      }
      return item;
    });
  }

  /**
   * Y9: ctx 结构化摘要 — 按字段类型分别截断, 拼成自然语言列表 (不是 JSON)
   * 之前 JSON.stringify(ctx).slice(0, 6000) 会切到中间, 输出非法 JSON, LLM 必然解析失败
   * 保留关键字段: holdings (前 10 条简码), alerts (前 5 条), recentJournals (标题前 8),
   *   market/news/observations/findings (纯文本)
   */
  function _summarizeCtx(ctx) {
    if (!ctx || typeof ctx !== 'object') return '(空)';
    const lines = [];
    if (Array.isArray(ctx.holdings) && ctx.holdings.length > 0) {
      // P0.1: 持仓行注入成本/现价/市值, 锚定 coach 的 targetPrice
      // P0.2: 末尾加省略提示
      const total = ctx.holdings.length;
      const shown = Math.min(10, total);
      lines.push(`## 持仓 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.holdings.slice(0, 10).forEach(h => {
        const code = h.code || h['代码'] || '';
        const name = h.name || h['名称'] || '';
        const cost = parseFloat(h.costPrice != null ? h.costPrice : h.cost) || null;
        const price = parseFloat(h.currentPrice != null ? h.currentPrice : h.price) || null;
        const mv = code && ctx.portfolio && ctx.portfolio.valueByCode ? ctx.portfolio.valueByCode[code] : null;
        const pl = h.profitLossPct != null ? (h.profitLossPct * 100).toFixed(1) + '%' : '';
        const parts = [];
        if (cost) parts.push(`成本 ${cost.toFixed(2)}`);
        if (price) parts.push(`现价 ${price.toFixed(2)}`);
        if (mv) parts.push(`市值 ${(mv / 10000).toFixed(1)}万`);
        if (pl) parts.push(`盈亏 ${pl}`);
        lines.push(`- ${code} ${name}${parts.length ? '  [' + parts.join(' / ') + ']' : ''}`);
      });
    }
    // P1.2: 组合段 (在持仓后插入, LLM 看到总盘 + 现金约束)
    if (ctx.portfolio && typeof ctx.portfolio === 'object') {
      const p = ctx.portfolio;
      const ta = (p.totalAssets / 10000).toFixed(1);
      const cash = (p.cash / 10000).toFixed(1);
      const stk = (p.stockMkt / 10000).toFixed(1);
      const fnd = p.fundMkt > 0 ? (p.fundMkt / 10000).toFixed(1) : null;
      const cashPct = p.totalAssets > 0 ? (p.cash / p.totalAssets * 100).toFixed(1) : '0';
      lines.push(`## 组合 (实盘)`);
      lines.push(`- 总资产: ${ta}万 (股票 ${stk}万${fnd ? ` / 基金 ${fnd}万` : ''} / 现金 ${cash}万 ${cashPct}%)`);
      if (p.quoteFail > 0) lines.push(`- [降级] ${p.quoteFail} 只持仓行情拉取失败, 现价用成本价兜底, 估值偏宽`);
    }
    if (Array.isArray(ctx.alerts) && ctx.alerts.length > 0) {
      const total = ctx.alerts.length;
      const shown = Math.min(5, total);
      lines.push(`## 提醒 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.alerts.slice(0, 5).forEach(a => {
        const code = a.code || '';
        const t = a.type || '';
        const c = a.condition || a.threshold || '';
        lines.push(`- ${code} ${t}${c ? ' ' + c : ''}`);
      });
    }
    if (Array.isArray(ctx.recentJournals) && ctx.recentJournals.length > 0) {
      const total = ctx.recentJournals.length;
      const shown = Math.min(8, total);
      lines.push(`## 近期复盘 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.recentJournals.slice(0, 8).forEach(j => {
        const d = j.date || '';
        const t = j.title || j.code || '';
        const a = j.assumption || '';
        lines.push(`- ${d} ${t}${a ? ' (假设: ' + a + ')' : ''}`);
      });
    }
    if (Array.isArray(ctx.observations) && ctx.observations.length > 0) {
      const total = ctx.observations.length;
      const shown = Math.min(12, total);
      lines.push(`## 观察点 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.observations.slice(0, 12).forEach(o => {
        lines.push(`- [${o.severity || '?'}] ${o.text || JSON.stringify(o)}`);
      });
    }
    if (Array.isArray(ctx.findings) && ctx.findings.length > 0) {
      const total = ctx.findings.length;
      const shown = Math.min(10, total);
      lines.push(`## 诊断 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.findings.slice(0, 10).forEach(f => {
        lines.push(`- [${f.confidence || '?'}/${f.type || '?'}] ${f.text || JSON.stringify(f)}`);
      });
    }
    // P1.2: 宏观段 (macro 已是 formatForPrompt 后的字符串, 或 {degraded,reason} 标记)
    if (typeof ctx.macro === 'string' && ctx.macro.length > 0) {
      lines.push(`## 宏观\n${ctx.macro.slice(0, 800)}`);
    } else if (ctx.macro && ctx.macro.degraded) {
      lines.push(`## 宏观\n[降级] ${ctx.macro.reason || '宏观数据不可用'}`);
    }
    // P1.2: 市场宽度段
    if (ctx.marketWidth && typeof ctx.marketWidth === 'object') {
      const w = ctx.marketWidth;
      const statusLabel = ({ bull: '偏多', bear: '偏空', neutral: '震荡', unknown: '未知' })[w.status] || w.status || '未知';
      const advPct = w.advancePct != null ? w.advancePct.toFixed(1) + '%' : '?';
      lines.push(`## 市场宽度`);
      lines.push(`- 涨 ${w.advance || 0} / 跌 ${w.decline || 0} / 平 ${w.flat || 0} (${advPct} 涨, ${statusLabel})`);
      if (w.partial) lines.push(`- [降级] ${w.partial}`);
    }
    if (typeof ctx.market === 'string' && ctx.market.length > 0) {
      // P0.2: 截断提示
      lines.push(`## 市场\n${ctx.market.slice(0, 800)}${ctx.market.length > 800 ? '\n... [截断]' : ''}`);
    } else if (ctx.market && typeof ctx.market === 'object') {
      const s = JSON.stringify(ctx.market);
      lines.push(`## 市场\n${s.slice(0, 800)}${s.length > 800 ? '\n... [截断]' : ''}`);
    }
    if (typeof ctx.news === 'string' && ctx.news.length > 0) {
      lines.push(`## 新闻\n${ctx.news.slice(0, 800)}${ctx.news.length > 800 ? '\n... [截断]' : ''}`);
    } else if (Array.isArray(ctx.news) && ctx.news.length > 0) {
      const total = ctx.news.length;
      const shown = Math.min(5, total);
      lines.push(`## 新闻 (共 ${total} 条, 取前 ${shown}${total > shown ? `, 省略 ${total - shown} 条` : ''})`);
      ctx.news.slice(0, 5).forEach(n => lines.push(`- ${n.title || n.text || JSON.stringify(n)}`));
    }
    // Phase 1.6: 数据来源摘要 (新注入) — 告诉 AI 数据有多新/来自哪/校验状态
    if (typeof ctx.sourceDigest === 'string' && ctx.sourceDigest.length > 0) {
      lines.push(`## 数据来源摘要\n${ctx.sourceDigest}`);
    }
    return lines.length > 0 ? lines.join('\n') : '(无事实)';
  }

  // ===== 1. Observer =====
  // ctx: { holdings, alerts, recentJournals, market, news }
  // 产出: { observations: [{category, code, text, severity, source}] }
  async function runObserver(ctx, opts = {}) {
    const sys = `你是一个投资观察者助手. 你的任务是基于用户给的事实, 提取出有意义的"观察点".
只输出严格 JSON, 不要任何解释. 格式:
{"observations":[{"category":"${ALLOWED.observationCategory.join('|')}","code":"股票代码或基金代码,无则空","text":"一句话观察,30字内","severity":"${ALLOWED.observationSeverity.join('|')}","source":"holding|alert|journal|market|news"}]}
每个事实一条, 最多 8 条. 没有值得说的就返回空数组.`;

    const prompt = `以下是我的事实, 请提取观察点:
${_summarizeCtx(ctx)}`;

    try {
      const deps = opts.deps || { callLLM: null };
      const text = deps.callLLM
        ? await deps.callLLM({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.3 })
        : await Core.AI.call({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.3 });
      const observations = _coerceList(text, 'observations', {
        category: ALLOWED.observationCategory,
        severity: ALLOWED.observationSeverity
      });
      return {
        ok: true,
        summary: `观察者提取 ${observations.length} 条观察`,
        data: { observations },
        raw: text
      };
    } catch (e) {
      return { ok: false, summary: '观察者失败: ' + e.message, data: { observations: [] }, raw: '', error: e.message };
    }
  }

  // ===== 2. Analyst =====
  // ctx: { observations, holdings?, ... }
  // 产出: { findings: [{type, code, text, confidence}] }
  async function runAnalyst(ctx, opts = {}) {
    const sys = `你是投资分析师. 基于"观察点"做诊断: 找出风险/机会/中性信号.
只输出严格 JSON, 不要任何解释. 格式:
{"findings":[{"type":"${ALLOWED.findingType.join('|')}","code":"股票代码或基金代码,无则空","text":"一句话结论,40字内","confidence":"${ALLOWED.findingConfidence.join('|')}"}]}
最多 6 条. 只保留有意义的诊断, 没看出来就空数组.`;

    const prompt = `观察点如下, 请诊断:
${_summarizeCtx(ctx)}`;

    try {
      const deps = opts.deps || { callLLM: null };
      const text = deps.callLLM
        ? await deps.callLLM({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.4 })
        : await Core.AI.call({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.4 });
      const findings = _coerceList(text, 'findings', {
        type: ALLOWED.findingType,
        confidence: ALLOWED.findingConfidence
      });
      return {
        ok: true,
        summary: `分析师给出 ${findings.length} 条诊断`,
        data: { findings },
        raw: text
      };
    } catch (e) {
      return { ok: false, summary: '分析师失败: ' + e.message, data: { findings: [] }, raw: '', error: e.message };
    }
  }

  // ===== 3. Coach =====
  // ctx: { findings, observations, ... }
  // 产出: { actions: [{code, action, reason, urgency, targetPrice?}], watchlist: [] }
  async function runCoach(ctx, opts = {}) {
    const sys = `你是个人投资教练. 基于诊断结果, 给出具体可执行的行动建议.
只输出严格 JSON, 不要任何解释. 格式:
{"actions":[{"code":"股票代码或基金代码","action":"${ALLOWED.coachAction.join('|')}","reason":"一句话,30字内","urgency":"${ALLOWED.coachUrgency.join('|')}","targetPrice":数字或null}],"watchlist":[]}
最多 4 条 actions. 保守为先: 不确定就 hold. 行动必须对应到具体 code.`;

    const prompt = `诊断结论如下, 请给行动建议:
${_summarizeCtx(ctx)}`;

    try {
      const deps = opts.deps || { callLLM: null };
      const text = deps.callLLM
        ? await deps.callLLM({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.3 })
        : await Core.AI.call({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: 0.3 });
      const actions = _coerceList(text, 'actions', {
        action: ALLOWED.coachAction,
        urgency: ALLOWED.coachUrgency
      });
      const watchlist = (() => {
        try {
          const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
          const j = JSON.parse(cleaned);
          return Array.isArray(j.watchlist) ? j.watchlist.slice(0, 6) : [];
        } catch (e) { return []; }
      })();
      return {
        ok: true,
        summary: `教练给出 ${actions.length} 条行动建议`,
        data: { actions, watchlist },
        raw: text
      };
    } catch (e) {
      return { ok: false, summary: '教练失败: ' + e.message, data: { actions: [], watchlist: [] }, raw: '', error: e.message };
    }
  }

  // ===== Orchestrator: 按 intent 路由 =====
  // intent: 'observe' | 'diagnose' | 'next' | 'today' | 'full'
  //   observe  → 只跑 observer
  //   diagnose → observer + analyst
  //   next     → analyst + coach (用已有 observations 跳过 observer)
  //   today    → observer + analyst + coach (全链路, 日常复盘用)
  //   full     → 全链路 + 完整 trace
  // ctx: 任何事实 (holdings/alerts/journals/market/news 等)
  // 返回: { intent, steps: [{agent, ok, summary, data}], final, summary, totalMs }
  async function runPipeline(intent, ctx, opts = {}) {
    const start = Date.now();
    const steps = [];
    const i = String(intent || 'today').toLowerCase();
    let observations = [];
    let findings = [];

    if (i === 'observe') {
      const r = await runObserver(ctx, opts);
      steps.push({ agent: 'observer', ok: r.ok, summary: r.summary, data: r.data });
      if (!r.ok) return { intent: i, steps, final: null, summary: '观察者失败', totalMs: Date.now() - start };
      observations = r.data.observations;
    } else if (i === 'diagnose') {
      const r1 = await runObserver(ctx, opts);
      steps.push({ agent: 'observer', ok: r1.ok, summary: r1.summary, data: r1.data });
      if (r1.ok) observations = r1.data.observations;
      const r2 = await runAnalyst({ observations, ...ctx }, opts);
      steps.push({ agent: 'analyst', ok: r2.ok, summary: r2.summary, data: r2.data });
      if (r2.ok) findings = r2.data.findings;
    } else if (i === 'next') {
      // 已有 observations (ctx.observations), 直接走 analyst+coach
      observations = ctx.observations || [];
      const r2 = await runAnalyst({ observations, ...ctx }, opts);
      steps.push({ agent: 'analyst', ok: r2.ok, summary: r2.summary, data: r2.data });
      if (r2.ok) findings = r2.data.findings;
      const r3 = await runCoach({ findings, observations, ...ctx }, opts);
      steps.push({ agent: 'coach', ok: r3.ok, summary: r3.summary, data: r3.data });
      return {
        intent: i,
        steps,
        final: r3.ok ? r3.data : null,
        summary: r3.ok ? r3.summary : '教练失败',
        totalMs: Date.now() - start
      };
    } else {
      // today / full → 全链路
      const r1 = await runObserver(ctx, opts);
      steps.push({ agent: 'observer', ok: r1.ok, summary: r1.summary, data: r1.data });
      if (r1.ok) observations = r1.data.observations;
      const r2 = await runAnalyst({ observations, ...ctx }, opts);
      steps.push({ agent: 'analyst', ok: r2.ok, summary: r2.summary, data: r2.data });
      if (r2.ok) findings = r2.data.findings;
      const r3 = await runCoach({ findings, observations, ...ctx }, opts);
      steps.push({ agent: 'coach', ok: r3.ok, summary: r3.summary, data: r3.data });
      return {
        intent: i,
        steps,
        final: r3.ok ? r3.data : null,
        summary: r3.ok ? r3.summary : '教练失败',
        totalMs: Date.now() - start
      };
    }

    // observe / diagnose 的 final
    const last = steps[steps.length - 1];
    return {
      intent: i,
      steps,
      final: last.ok ? last.data : null,
      summary: last.ok ? last.summary : '失败',
      totalMs: Date.now() - start
    };
  }

  // ===== 工具: 快速构造 ctx (从 Core.Storage 拉事实) =====
  // 轻量级, 避免和模块耦合; 真正数据由调用方注入
  function _summary(steps) {
    if (!steps.length) return '无步骤';
    const ok = steps.filter(s => s.ok).length;
    return `${ok}/${steps.length} 步成功`;
  }

  window.Core = window.Core || {};
  window.Core.Agents = {
    runObserver,
    runAnalyst,
    runCoach,
    runPipeline,
    ALLOWED,
    _coerceList,
    _summary,
    _summarizeCtx
  };
})();
