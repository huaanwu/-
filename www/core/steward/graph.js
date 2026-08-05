/**
 * Core.Steward.Graph — 决策图谱数据模型 (V14 G1)
 * 把 agent_runs + ai_traces / steward_plans 转成可视化 DAG
 *
 * 暴露: window.Core.Steward.Graph = { buildFromRun, buildFromPlan, _nodeTypes, _edgeTypes }
 */
(function () {
  'use strict';

  const _nodeTypes = {
    plan:    { label: '计划入口', color: '#3b82f6' },
    tool:    { label: '工具调用', color: '#8b5cf6' },
    reflect: { label: '反思',     color: '#f59e0b' },
    result:  { label: '结果汇总', color: '#10b981' },
    decision:{ label: '决策头',   color: '#3b82f6' },
    input:   { label: '输入',     color: '#94a3b8' },
    rule:    { label: '规则',     color: '#f59e0b' },
    output:  { label: '输出',     color: '#10b981' }
  };
  const _edgeTypes = {
    calls:        { label: 'calls',         color: '#475569' },
    reflects_on:  { label: 'reflects_on',   color: '#f59e0b', dashed: true },
    produces:     { label: 'produces',      color: '#10b981' },
    consumes:     { label: 'consumes',      color: '#94a3b8' },
    applies:      { label: 'applies',       color: '#f59e0b' }
  };

  function _id(prefix, key) { return prefix + ':' + key; }

  /**
   * 从一次 run (agent_runs + ai_traces) 构造图谱
   * 节点: 'plan' (run 开始) | 'tool' (kind=tool) | 'reflect' (kind=reflect) | 'result' (kind=summary 或结束)
   * 边:   'calls' (plan→tool) | 'reflects_on' (reflect→最近 plan/tool) | 'produces' (tool→next tool)
   */
  async function buildFromRun(runId) {
    if (!window.Core || !Core.Storage) return { nodes: [], edges: [] };
    const Storage = Core.Storage;
    const run = await Storage.getAgentRun(runId).catch(() => null);
    const traces = await Storage.listAITracesByRun(runId).catch(() => []);
    const nodes = [];
    const edges = [];
    const idMap = new Map();

    // 1) plan 节点 — run 入口
    const planId = _id('plan', runId);
    nodes.push({
      id: planId,
      type: 'plan',
      label: (run && run.intent) || runId,
      meta: {
        runId, strategy: run && run.strategy, ts: run && run.startedAt,
        ok: run && run.ok, intent: run && run.intent
      }
    });
    idMap.set('entry', planId);

    // 2) tool / reflect / summary 节点 — 按 ts 排序
    const sorted = traces.slice().sort((a, b) => (a.ts || a.at || 0) - (b.ts || b.at || 0));
    let lastNodeId = planId;
    let lastType = 'plan';
    for (const ev of sorted) {
      const kind = ev.kind || 'tool';
      const eventId = ev.id != null ? String(ev.id) : (ev.ts || Math.random().toString(36).slice(2));
      let nodeType, label;
      if (kind === 'reflect') { nodeType = 'reflect'; label = ev.summary || '反射'; }
      else if (kind === 'summary' || kind === 'result') { nodeType = 'result'; label = ev.summary || '结果'; }
      else { nodeType = 'tool'; label = kind + (ev.summary ? ': ' + ev.summary.slice(0, 30) : ''); }
      const nodeId = _id(nodeType, eventId);
      nodes.push({
        id: nodeId, type: nodeType, label,
        meta: { runId, kind, ts: ev.ts || ev.at, summary: ev.summary, detail: ev.detail }
      });
      // 边 — reflect 回到最近 plan/tool, tool 按顺序 produces
      if (nodeType === 'reflect') {
        edges.push({ source: nodeId, target: lastNodeId, kind: 'reflects_on' });
      } else if (nodeType === 'result') {
        edges.push({ source: lastNodeId, target: nodeId, kind: 'produces' });
      } else if (nodeType === 'tool') {
        if (lastType === 'plan') {
          edges.push({ source: planId, target: nodeId, kind: 'calls' });
        } else if (lastType !== 'reflect') {
          edges.push({ source: lastNodeId, target: nodeId, kind: 'produces' });
        } else {
          edges.push({ source: planId, target: nodeId, kind: 'calls' });
        }
      }
      lastNodeId = nodeId;
      lastType = nodeType;
    }

    // 3) 没有 summary 节点 → 加一个 result 收尾
    if (!sorted.some(e => e.kind === 'summary' || e.kind === 'result')) {
      const resultId = _id('result', runId + ':end');
      nodes.push({
        id: resultId, type: 'result', label: (run && run.ok) ? '完成' : '异常',
        meta: { runId, ok: run && run.ok, totalMs: run && run.totalMs, error: run && run.error }
      });
      if (lastNodeId && lastNodeId !== planId) {
        edges.push({ source: lastNodeId, target: resultId, kind: 'produces' });
      } else {
        edges.push({ source: planId, target: resultId, kind: 'produces' });
      }
    }
    return { nodes, edges };
  }

  /**
   * 从一条 steward_plan 构造图谱
   * 节点: 'decision' (plan 头) | 'input' (cash/holdings/pool/macro) | 'rule' (violations) | 'output' (targets)
   * 边:   'consumes' (decision→input) | 'applies' (decision→rule) | 'produces' (decision→output)
   */
  async function buildFromPlan(planId) {
    if (!window.Core || !Core.Storage) return { nodes: [], edges: [] };
    const plan = await Core.Storage.getStewardPlan(planId).catch(() => null);
    if (!plan) return { nodes: [], edges: [] };
    const nodes = [];
    const edges = [];
    const decisionId = _id('decision', planId);
    nodes.push({
      id: decisionId, type: 'decision',
      label: '管家决策 ' + (plan.date || ''),
      meta: { planId, status: plan.status, ts: plan.ts, regime: plan.regime, factor: plan.factor, sleeve: plan.sleeve }
    });

    // inputs: cash / holdings / pool / macro
    const inputs = [
      { key: 'cash',     label: '现金 (long/short/real)' },
      { key: 'holdings', label: '当前持仓' },
      { key: 'pool',     label: '股池 (long/short)' },
      { key: 'macro',    label: '宏观状态' }
    ];
    for (const inp of inputs) {
      const nid = _id('input', planId + ':' + inp.key);
      nodes.push({ id: nid, type: 'input', label: inp.label, meta: { planId, kind: inp.key } });
      edges.push({ source: decisionId, target: nid, kind: 'consumes' });
    }

    // rules: 来自 violations (去重) + 默认策略规则
    const ruleSet = new Set();
    if (Array.isArray(plan.violations)) {
      for (const v of plan.violations) if (v && v.rule) ruleSet.add(v.rule);
    }
    const defaultRules = ['LOT_SIZE', 'MAX_SINGLE_STOCK_PCT', 'MAX_SINGLE_INDUSTRY_PCT', 'STOP_LOSS_RATIO_AUTO'];
    defaultRules.forEach(r => ruleSet.add(r));
    for (const rule of ruleSet) {
      const nid = _id('rule', planId + ':' + rule);
      nodes.push({ id: nid, type: 'rule', label: rule, meta: { planId, ruleRef: rule } });
      edges.push({ source: decisionId, target: nid, kind: 'applies' });
    }

    // outputs: targets
    const targets = Array.isArray(plan.targets) ? plan.targets : [];
    if (targets.length === 0) {
      const nid = _id('output', planId + ':empty');
      nodes.push({ id: nid, type: 'output', label: '(无 targets)', meta: { planId } });
      edges.push({ source: decisionId, target: nid, kind: 'produces' });
    } else {
      for (let i = 0; i < targets.length; i++) {
        const t = targets[i];
        const nid = _id('output', planId + ':' + (t.code || i));
        nodes.push({
          id: nid, type: 'output',
          label: `[${t.sleeve || 'long'}] ${t.code || '?'} ${t.action || ''}`,
          meta: { planId, code: t.code, action: t.action, shares: t.shares, targetAmount: t.targetAmount, targetPct: t.targetPct, sleeve: t.sleeve, target: t }
        });
        edges.push({ source: decisionId, target: nid, kind: 'produces' });
      }
    }
    return { nodes, edges };
  }

  window.Core = window.Core || {};
  window.Core.Steward = window.Core.Steward || {};
  window.Core.Steward.Graph = {
    buildFromRun, buildFromPlan,
    _nodeTypes, _edgeTypes
  };

  console.log('[Steward/Graph] 决策图谱数据模型已就绪 (G1)');
})();
