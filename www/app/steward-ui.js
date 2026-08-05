/**
 * StewardUI — 管家计划卡片 UI (S4)
 * 挂 window.StewardUI
 *
 * 数据源: Core.Storage.where('steward_plans', 'status', 'pending')
 * 交互: 每条 target 三个按钮 (批准 / 驳回 / 改数量)
 *   - 批准 → window.dispatchEvent('steward:approve', {detail:{planId, targetIndex, action, code, shares}})
 *   - 驳回 → 'steward:reject'
 *   - 改数量 → 'steward:adjust'
 *
 * S5 之前只渲染占位,事件分发后由管家监听者统一处理
 */
(function () {
  'use strict';
  const _state = { inited: false };

  function _escape(s) {
    if (window.Core && Core.Util && typeof Core.Util.escapeHtml === 'function') {
      return Core.Util.escapeHtml(s);
    }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function _fmtMoney(v) {
    if (window.Core && Core.Util && typeof Core.Util.fmtMoney === 'function') {
      return Core.Util.fmtMoney(v);
    }
    const n = Number(v) || 0;
    return n.toFixed(2);
  }

  function _dispatch(kind, payload) {
    try {
      window.dispatchEvent(new CustomEvent('steward:' + kind, { detail: payload }));
    } catch (e) {
      console.warn('[StewardUI] dispatch 失败:', kind, e);
    }
  }

  async function _loadPendingPlans() {
    if (!window.Core || !Core.Storage || typeof Core.Storage.where !== 'function') return [];
    try {
      const rows = await Core.Storage.where('steward_plans', 'status', 'pending');
      return Array.isArray(rows) ? rows : [];
    } catch (e) {
      console.warn('[StewardUI] 拉 pending plans 失败:', e);
      return [];
    }
  }

  function _renderPlanCard(plan) {
    const planId = _escape(plan && plan.planId);
    const asOf = _escape(plan && plan.asOf);
    const notes = _escape(plan && plan.notes);
    const targets = Array.isArray(plan && plan.targets) ? plan.targets : [];
    const violations = Array.isArray(plan && plan.violations) ? plan.violations : [];

    const targetsHtml = targets.length === 0
      ? '<div style="color:var(--text-muted);font-size:12px;padding:6px 0;">(本计划无 targets)</div>'
      : targets.map((t, i) => {
          const action = _escape(t.action);
          const code = _escape(t.code);
          const name = _escape(t.name || t.code);
          const sleeve = _escape(t.sleeve || 'long');
          const shares = Number(t.tradeShares != null ? t.tradeShares : t.shares) || 0;
          const price = Number(t.price) || 0;
          const amount = Number(t.targetAmount) || 0;
          const reason = _escape(t.reason || '');
          const decisionStatus = t.decisionStatus || 'pending';
          const isPending = decisionStatus === 'pending';
          const statusHtml = isPending
            ? ''
            : `<span style="font-size:11px;color:var(--text-muted);">${decisionStatus === 'approved' ? '已执行' : '已驳回'}</span>`;
          return `
            <div class="data-card" style="padding:8px 10px;margin-bottom:6px;">
              <div style="display:flex;justify-content:space-between;align-items:start;gap:8px;">
                <div style="flex:1;">
                  <div style="font-weight:600;">[${sleeve}] ${code} ${name} <span style="font-size:11px;color:var(--text-muted);">${action}</span></div>
                  <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${reason}</div>
                  <div style="font-size:11px;margin-top:2px;">执行数量: <b>${shares}</b> · 单价: ${price} · 金额: ${_fmtMoney(amount)}</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:4px;min-width:90px;">
                  ${isPending ? `<button class="btn btn-sm btn-primary" data-act="approve" data-idx="${i}">批准</button>
                  <button class="btn btn-sm btn-ghost" data-act="reject" data-idx="${i}">驳回</button>
                  ${t.action !== 'hold' ? `<button class="btn btn-sm btn-ghost" data-act="adjust" data-idx="${i}">改数量</button>` : ''}` : statusHtml}
                </div>
              </div>
            </div>
          `;
        }).join('');

    const violationsHtml = violations.length === 0
      ? ''
      : `<div style="margin-top:6px;font-size:11px;color:var(--down);">
          ⚠ ${violations.length} 项 violations
          <ul style="margin:4px 0 0 16px;padding:0;">
            ${violations.map(v => `<li>${_escape(v.rule)}: ${_escape(v.detail)}</li>`).join('')}
          </ul>
        </div>`;

    return `
      <div class="data-card" data-plan-id="${planId}" style="padding:12px;margin-bottom:10px;">
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:6px;">
          planId: <code>${planId}</code> · asOf: ${asOf}
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${notes}</div>
        ${targetsHtml}
        ${violationsHtml}
      </div>
    `;
  }

  async function renderPage() {
    const root = document.getElementById('stewardPending');
    if (!root) return;
    const plans = await _loadPendingPlans();
    if (plans.length === 0) {
      root.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;">暂无 pending 计划</div>';
      return;
    }
    root.innerHTML = plans.map(_renderPlanCard).join('');
    // 绑按钮事件
    root.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const card = e.target.closest('[data-plan-id]');
        const planId = card ? card.getAttribute('data-plan-id') : '';
        const idx = parseInt(btn.getAttribute('data-idx'), 10);
        const act = btn.getAttribute('data-act');
        const plan = plans.find(p => p.planId === planId);
        const target = plan && plan.targets ? plan.targets[idx] : null;
        if (!target) return;
        if (act === 'approve') {
          // APK 环境无 window.prompt, 直接使用默认 shares, 改数量走 adjust
          const shares = Number(target.tradeShares != null ? target.tradeShares : target.shares) || 0;
          if (target.action !== 'hold' && (!Number.isFinite(shares) || shares <= 0)) {
            if (window.Core && Core.Toast) Core.Toast.show('数量非法', 3000);
            return;
          }
          _dispatch('approve', {
            planId,
            targetIndex: idx,
            action: target.action,
            code: target.code,
            sleeve: target.sleeve,
            shares
          });
        } else if (act === 'reject') {
          _dispatch('reject', { planId, targetIndex: idx, code: target.code, action: target.action, sleeve: target.sleeve });
        } else if (act === 'adjust') {
          // 派事件给外层 modal 处理改数量, APK 兼容不弹 prompt
          _dispatch('adjust', {
            planId,
            targetIndex: idx,
            code: target.code,
            action: target.action,
            sleeve: target.sleeve,
            defaultShares: Number(target.tradeShares != null ? target.tradeShares : target.shares) || 0
          });
        }
      });
    });
  }

  // ========== V14 G2/G3: 决策图谱 + 微调 ==========

  /** 简易 SVG escape 防 XSS */
  function _escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 渲染一条 plan 的决策图谱 (DAG) 到 root 容器
   * 节点: decision / input / rule / output
   * 边:   consumes / applies / produces
   * 节点可点击 → dispatch('steward:showNode', {nodeId, kind})
   * 节点右下角小图标 (微调 handle) → 拖动 → dispatch('steward:tweakRule', {refId, value})
   */
  async function _renderDecisionGraph(planId, root) {
    if (!root) root = document.getElementById('stewardGraph');
    if (!root) return;
    if (!window.Core || !Core.Steward || !Core.Steward.Graph) {
      root.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">Graph 模块未加载</div>';
      return;
    }
    const graph = await Core.Steward.Graph.buildFromPlan(planId);
    const types = Core.Steward.Graph._nodeTypes;
    if (!graph.nodes || graph.nodes.length === 0) {
      root.innerHTML = '<div style="color:var(--text-muted);font-size:12px;">(本计划无图谱节点)</div>';
      return;
    }

    // 1) 布局 — 按 kind 列布局 (decision 列 / input 列 / rule 列 / output 列)
    const cols = { decision: 0, input: 1, rule: 2, output: 3 };
    const colWidth = 180;
    const rowHeight = 56;
    const padX = 16, padY = 16;
    const layout = new Map();     // nodeId → {x, y, w, h}
    const colCount = new Map();   // col → max row
    for (const n of graph.nodes) {
      const c = cols[n.type] != null ? cols[n.type] : 1;
      const row = (colCount.get(c) || 0);
      colCount.set(c, row + 1);
      const w = 156, h = 44;
      const x = padX + c * (colWidth);
      const y = padY + row * rowHeight;
      layout.set(n.id, { x, y, w, h });
    }
    const maxRows = Math.max(0, ...Array.from(colCount.values()));
    const svgW = padX * 2 + 4 * colWidth;
    const svgH = padY * 2 + (maxRows || 1) * rowHeight + 24;

    // 2) 节点矩形
    const nodeSvg = graph.nodes.map(n => {
      const lay = layout.get(n.id);
      const meta = types[n.type] || { color: '#64748b' };
      const fill = meta.color;
      const tweakable = (n.type === 'rule') || (n.type === 'output' && n.meta && n.meta.targetPct != null);
      const tweakIcon = tweakable
        ? `<g class="tweak" data-node-id="${_escAttr(n.id)}" data-ref-id="${_escAttr(n.meta.ruleRef || n.meta.code || '')}" data-kind="${_escAttr(n.type)}" style="cursor:ew-resize;">
             <circle cx="${lay.x + lay.w - 10}" cy="${lay.y + lay.h - 10}" r="7" fill="#fff" stroke="${fill}" stroke-width="1.5"/>
             <text x="${lay.x + lay.w - 10}" y="${lay.y + lay.h - 7}" text-anchor="middle" font-size="9" fill="${fill}">≷</text>
           </g>`
        : '';
      const label = _escAttr(n.label || n.id);
      return `<g class="node" data-node-id="${_escAttr(n.id)}" data-kind="${_escAttr(n.type)}" style="cursor:pointer;">
        <rect x="${lay.x}" y="${lay.y}" width="${lay.w}" height="${lay.h}" rx="6" fill="${fill}" opacity="0.18" stroke="${fill}" stroke-width="1.5"/>
        <text x="${lay.x + 8}" y="${lay.y + 18}" font-size="11" fill="#0f172a" font-weight="600">${meta.label || n.type}</text>
        <text x="${lay.x + 8}" y="${lay.y + 34}" font-size="11" fill="#0f172a">${label}</text>
        ${tweakIcon}
      </g>`;
    }).join('');

    // 3) 边 (箭头) — 用贝塞尔曲线从源节点右中 → 目标节点左中
    const tipW = 6, tipH = 8;
    const edgeSvg = graph.edges.map((e, i) => {
      const s = layout.get(e.source);
      const t = layout.get(e.target);
      if (!s || !t) return '';
      const x1 = s.x + s.w, y1 = s.y + s.h / 2;
      const x2 = t.x,        y2 = t.y + t.h / 2;
      const cx = (x1 + x2) / 2;
      const path = `M ${x1} ${y1} C ${cx} ${y1}, ${cx} ${y2}, ${x2} ${y2}`;
      const dir = (e.kind === 'consumes' || e.kind === 'applies') ? -1 : 1;
      const ax = x2 + dir * tipW;
      const ap = `M ${ax} ${y2 - tipH} L ${x2} ${y2} L ${ax} ${y2 + tipH} Z`;
      const color = (e.kind === 'applies') ? '#f59e0b' : (e.kind === 'consumes' ? '#94a3b8' : '#10b981');
      return `<g class="edge" data-edge-idx="${i}">
        <path d="${path}" fill="none" stroke="${color}" stroke-width="1.5" marker-end="none"/>
        <path d="${ap}" fill="${color}"/>
      </g>`;
    }).join('');

    // 4) 微调默认值 — rule: 0.20 (拉满), output: 0.10 (仓位)
    const tweaks = (await Core.Steward.Graph._nodeTypes) || types;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgW} ${svgH}" width="100%" height="${svgH}" style="background:#0f172a08;border-radius:6px;">
      <defs>
        <style>
          .node:hover rect { opacity:0.32; }
          .tweak:hover circle { fill:${'#fef3c7'}; }
        </style>
      </defs>
      ${edgeSvg}
      ${nodeSvg}
    </svg>`;
    root.innerHTML = svg;

    // 5) 节点点击 → showNode
    root.querySelectorAll('g.node').forEach(g => {
      g.addEventListener('click', () => {
        const nodeId = g.getAttribute('data-node-id');
        const kind = g.getAttribute('data-kind');
        _dispatch('showNode', { planId, nodeId, kind });
      });
    });
    // 6) 微调 handle — 鼠标按下 / 移动 → 派 tweakRule (direction: -1/+1)
    root.querySelectorAll('g.tweak').forEach(g => {
      let startX = null;
      let lastDir = 0;
      g.addEventListener('mousedown', (e) => {
        startX = e.clientX;
        lastDir = 0;
        e.preventDefault();
        const onMove = (mv) => {
          if (startX == null) return;
          const dx = mv.clientX - startX;
          lastDir = dx > 4 ? 1 : (dx < -4 ? -1 : lastDir);
        };
        const onUp = () => {
          document.removeEventListener('mousemove', onMove);
          document.removeEventListener('mouseup', onUp);
          if (lastDir !== 0) {
            const refId = g.getAttribute('data-ref-id');
            const nodeKind = g.getAttribute('data-kind');
            _dispatch('tweakRule', { planId, refId, nodeKind, direction: lastDir });
          }
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
      });
    });
  }

  /** 订阅 tweakRule: 写 rule_overrides (status=active), 然后调用 _recomputePlan */
  async function _onTweakRule(detail) {
    if (!window.Core || !Core.Storage || !Core.Steward || !Core.Steward.Allocator) return;
    const refId = detail && detail.refId;
    if (!refId) return;
    // 决定 delta 步长 (按 refId 类型)
    const step = 0.05;
    const dir = (detail.direction === 1) ? 1 : -1;
    const newValue = dir * step; // 简化: 拖动一次 ±0.05; 真实 UI 可累加
    try {
      await Core.Storage.addRuleOverride({
        scope: (refId.indexOf('.') === -1) ? 'rule' : 'weight',
        refId,
        payload: { value: newValue, delta: dir * step },
        status: 'active'
      });
      // 重跑 plan → diff
      const { oldPlan, newPlan, diff } = await Core.Steward.Allocator._recomputePlan(detail.planId);
      _dispatch('recomputed', { planId: detail.planId, oldPlan, newPlan, diff });
    } catch (e) {
      console.warn('[StewardUI] tweakRule 失败:', e);
    }
  }

  function init() {
    if (_state.inited) return;
    _state.inited = true;
    if (window.addEventListener) {
      window.addEventListener('steward:tweakRule', (e) => _onTweakRule(e && e.detail));
      window.addEventListener('steward:approve', (e) => _onApprove(e && e.detail));
      window.addEventListener('steward:reject', (e) => _onReject(e && e.detail));
    }
    window._onShow_pageSteward = () => renderPage().catch(e => console.warn('[StewardUI] 页面渲染失败:', e));
    console.log('[StewardUI] init');
  }

  async function _getPlan(planId) {
    if (!Core.Storage) return null;
    if (typeof Core.Storage.getStewardPlan === 'function') return await Core.Storage.getStewardPlan(planId);
    if (typeof Core.Storage.get === 'function') return await Core.Storage.get('steward_plans', planId);
    return null;
  }

  function _planStatus(targets) {
    const rows = Array.isArray(targets) ? targets : [];
    if (rows.some(t => (t.decisionStatus || 'pending') === 'pending')) return 'pending';
    return rows.some(t => t.decisionStatus === 'approved') ? 'executed' : 'rejected';
  }

  async function _saveTargetDecision(plan, targetIndex, decisionStatus, extra) {
    const targets = (plan.targets || []).map((t, i) => i === targetIndex
      ? { ...t, decisionStatus, ...extra }
      : t);
    const next = { ...plan, targets, status: _planStatus(targets), updatedAt: new Date().toISOString() };
    await Core.Storage.put('steward_plans', next);
    return next;
  }

  async function _findPaperHolding(target) {
    if (target.holdingId) {
      const direct = await Core.Storage.get('holdings', target.holdingId);
      if (direct && direct.isPaper) return direct;
    }
    const all = (await Core.Storage.all('holdings')) || [];
    const sleeve = target.sleeve === 'short' ? 'short' : 'long';
    return all.find(h => h && h.isPaper && h.code === target.code && (h.sleeve || 'long') === sleeve) || null;
  }

  async function _executeTarget(target, requestedShares) {
    if (!window.Paper) throw new Error('Paper 未就绪');
    const action = String(target.action || '').toLowerCase();
    if (action === 'hold') return { ok: true, shares: 0, mode: 'hold' };
    if (action === 'buy' || action === 'add') {
      if (typeof Paper.buy !== 'function') throw new Error('Paper.buy 不可用');
      const shares = Number(requestedShares || target.tradeShares || target.shares) || 0;
      if (shares <= 0) throw new Error(action + ' 计划缺少有效股数');
      const row = await Paper.buy(target.code, target.name || '', target.market || '', shares, {
        sleeve: target.sleeve || 'long', auto: true, reason: 'AI 管家计划: ' + action
      });
      if (!row) throw new Error(action + ' 未成交');
      return { ok: true, shares, mode: action };
    }
    if (action === 'sell' || action === 'trim') {
      if (typeof Paper.sell !== 'function') throw new Error('Paper.sell 不可用');
      const holding = await _findPaperHolding(target);
      if (!holding) throw new Error(action + ' 找不到对应模拟持仓');
      const fallback = action === 'sell' ? holding.shares : Math.max(1, Math.floor(holding.shares / 3));
      const shares = Math.min(holding.shares, Number(requestedShares || target.tradeShares || fallback) || 0);
      if (shares <= 0) throw new Error(action + ' 计划缺少有效股数');
      const row = await Paper.sell(holding.id, shares, { reason: 'AI 管家计划: ' + action });
      if (!row) throw new Error(action + ' 未成交');
      return { ok: true, shares, mode: action };
    }
    throw new Error('不支持的计划动作: ' + action);
  }

  // v27 P0: 按 target.action 执行, 成功后只更新当前目标
  async function _onApprove(detail) {
    if (!detail || !window.Core) return;
    const planId = detail.planId;
    const targetIndex = Number(detail.targetIndex);
    if (!planId || !Number.isInteger(targetIndex)) return { ok: false, error: '缺 planId/targetIndex' };
    try {
      const plan = await _getPlan(planId);
      const target = plan && plan.targets && plan.targets[targetIndex];
      if (!target) throw new Error('计划目标不存在');
      if ((target.decisionStatus || 'pending') !== 'pending') throw new Error('该目标已处理');
      const result = await _executeTarget(target, Number(detail.shares) || 0);
      await _saveTargetDecision(plan, targetIndex, 'approved', {
        executedAt: new Date().toISOString(), executedShares: result.shares, executionMode: result.mode
      });
      await renderPage();
      return { ok: true, result };
    } catch (e) {
      console.warn('[StewardUI] 批准执行失败:', e);
      if (Core.Toast) Core.Toast.show('计划执行失败: ' + e.message, 4000);
      return { ok: false, error: e.message };
    }
  }

  // v27 P0: 驳回只更新当前目标, 全部目标处理完再结束计划
  async function _onReject(detail) {
    if (!detail || !window.Core) return;
    const planId = detail.planId;
    const targetIndex = Number(detail.targetIndex);
    if (!planId || !Number.isInteger(targetIndex)) return { ok: false, error: '缺 planId/targetIndex' };
    try {
      const plan = await _getPlan(planId);
      const target = plan && plan.targets && plan.targets[targetIndex];
      if (!target) throw new Error('计划目标不存在');
      await _saveTargetDecision(plan, targetIndex, 'rejected', { rejectedAt: new Date().toISOString() });
      await renderPage();
      return { ok: true };
    } catch (e) {
      console.warn('[StewardUI] 标记 rejected 失败:', e);
      return { ok: false, error: e.message };
    }
  }

  window.StewardUI = {
    init,
    renderPage,
    _renderDecisionGraph,
    _onTweakRule,
    _onApprove,
    _onReject,
    _executeTarget,
    _planStatus,
    _loadPendingPlans,
    _renderPlanCard
  };
})();
