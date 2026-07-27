/**
 * Fund.MacroBar - 顶部宏观数据条
 * 24h 缓存, 后台拉, 不阻塞主渲染
 * 依赖: window.Fund(主文件已挂)
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund._renderMacroBar = async function() {
    let bar = document.getElementById('fundMacroBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fundMacroBar';
      bar.className = 'macro-bar';
      // 插在 summaryEl 之前
      const summary = document.getElementById('fundSummary');
      summary.parentNode.insertBefore(bar, summary);
    }
    bar.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">⏳ 加载宏观数据...</div>';

    try {
      const snap = await Core.Macro.get();
      const d = snap.data;
      const items = [];
      if (d.lpr_1y !== undefined) items.push({ label: 'LPR 1Y', val: d.lpr_1y + '%', sub: d.lpr_date });
      if (d.fdr007 !== undefined) items.push({ label: '回购 7d', val: d.fdr007 + '%', sub: d.repo_date, hint: '↓ 越低资金越松' });
      if (d.cpi !== undefined) items.push({ label: 'CPI YoY', val: d.cpi + '%', sub: d.cpi_date, hint: d.cpi < 0.5 ? '⚠ 通缩' : '' });
      if (d.pmi !== undefined) {
        const state = d.pmi > 50 ? '📈 扩张' : '📉 收缩';
        items.push({ label: 'PMI', val: d.pmi.toString(), sub: d.pmi_date, hint: state });
      }
      if (d.m2 !== undefined) items.push({ label: 'M2 YoY', val: d.m2 + '%', sub: d.m2_date });

      bar.innerHTML = `
        <div class="macro-bar-head">
          <span>🌐 宏观环境快照 (24h 缓存)</span>
          <span class="macro-bar-time">${new Date(snap.generated).toLocaleString()}</span>
          <button class="btn btn-sm btn-ghost" onclick="Fund._refreshMacroBar()">🔄</button>
        </div>
        <div class="macro-bar-grid">
          ${items.map(i => `
            <div class="macro-item">
              <div class="macro-label">${i.label}</div>
              <div class="macro-val">${i.val}</div>
              <div class="macro-sub">${i.sub || ''} ${i.hint || ''}</div>
            </div>
          `).join('')}
        </div>
      `;
    } catch (e) {
      bar.innerHTML = `<div style="font-size:12px;color:var(--down);padding:8px 0;">⚠ 宏观数据加载失败: ${escapeHtml(e.message)} (需要 AKShare 代理运行)</div>`;
    }
  };

  window.Fund._refreshMacroBar = async function() {
    await Core.Macro.refresh();
    return this._renderMacroBar();
  };
})();