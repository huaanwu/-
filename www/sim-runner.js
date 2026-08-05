/**
 * SimRunner - 模拟盘实时监控 SPA (v0.2.24 V10)
 *
 * 4 section:
 *   1. 决策流 — decision_traces 最近 50 条, 按时间倒序
 *   2. PnL 曲线 — paper_snapshots 折线图 (echarts)
 *   3. 周度归因 — weekly_attribution 最近 12 周, AI summary
 *   4. 错过机会 — missed_opportunities 最近 100 条
 *
 * 数据源: 全部走 Core.Storage (Dexie) 读, 不调 LLM
 *
 * 用法: 浏览器打开 /sim-runner.html (独立 SPA, 不依赖主 app.js)
 */
(function () {
  'use strict';
  window.SimRunner = {
    _autoRefreshTimer: null,
    _autoRefreshEnabled: false,
    _sectionSwitchBound: false,

    /**
     * 初始化: 绑定导航 + 立即加载第一个 section
     */
    init() {
      if (!this._sectionSwitchBound) {
        const buttons = document.querySelectorAll('.sim-nav button[data-section]');
        buttons.forEach(btn => {
          btn.addEventListener('click', () => {
            buttons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            document.querySelectorAll('.sim-section').forEach(s => s.classList.remove('active'));
            const target = btn.dataset.section;
            const sec = document.getElementById(target);
            if (sec) sec.classList.add('active');
            // 切到 PnL section 时画图
            if (target === 'simSectionPnl') this._renderPnlChart();
            if (target === 'simSectionWeekly') this._renderWeekly();
            if (target === 'simSectionMissed') this._renderMissed();
            if (target === 'simSectionFlow') this._renderFlow();
          });
        });
        this._sectionSwitchBound = true;
      }
      this.refresh();
    },

    refresh() {
      this._renderFlow();
      this._renderPnlSummary();
      this._renderPnlChart();
      this._renderWeekly();
      this._renderMissed();
    },

    toggleAuto() {
      if (this._autoRefreshEnabled) {
        if (this._autoRefreshTimer) clearInterval(this._autoRefreshTimer);
        this._autoRefreshTimer = null;
        this._autoRefreshEnabled = false;
        const btn = document.getElementById('simAutoBtn');
        if (btn) btn.textContent = '▶ 自动刷新';
      } else {
        this._autoRefreshTimer = setInterval(() => this.refresh(), 30 * 1000);
        this._autoRefreshEnabled = true;
        const btn = document.getElementById('simAutoBtn');
        if (btn) btn.textContent = '⏸ 停止自动';
      }
    },

    // ========== Section 1: 决策流 ==========
    async _renderFlow() {
      const el = document.getElementById('simFlowContent');
      if (!el) return;
      try {
        const all = await Core.Storage.all('decision_traces');
        const rows = (all || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 50);
        if (rows.length === 0) {
          el.innerHTML = '<div class="sim-empty">暂无决策记录 (decision_traces 空)</div>';
          return;
        }
        const html = rows.map(r => {
          const ts = r.ts ? new Date(r.ts).toISOString().slice(0, 16).replace('T', ' ') : '?';
          const sleeveTag = r.sleeve ? `<span class="sim-tag ${r.sleeve}">${r.sleeve}</span>` : '';
          const factor = r.factor === null || r.factor === undefined ? '-' : r.factor.toFixed(2);
          const payload = JSON.stringify(r.payload || {}).slice(0, 100);
          return `<div class="sim-row">
            <div>${ts} ${sleeveTag} <b>${r.code || '(empty)'}</b> ${r.agentType || ''}</div>
            <div style="font-size:11px;color:var(--text-muted);">regime=${r.regime || '-'} factor=${factor} ${payload}</div>
          </div>`;
        }).join('');
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<div class="sim-empty">加载失败: ' + (e && e.message || e) + '</div>';
      }
    },

    // ========== Section 2: PnL ==========
    async _renderPnlSummary() {
      const el = document.getElementById('simPnlSummary');
      if (!el) return;
      try {
        const snaps = (await Core.Storage.kvGet('paper_snapshots')) || [];
        if (snaps.length === 0) {
          el.innerHTML = '<div class="sim-empty">暂无快照 (paper_snapshots 空)</div>';
          return;
        }
        const last = snaps[snaps.length - 1];
        const first = snaps[0];
        const pnl = last.paperTotal && first.paperTotal ? (last.paperTotal - first.paperTotal) : null;
        const shortLast = last.shortTotal;
        const shortFirst = first.shortTotal;
        const shortPnl = (shortLast != null && shortFirst != null) ? (shortLast - shortFirst) : null;
        const html = `
          <div class="sim-stat"><div>📅 快照数</div><div class="sim-stat-num">${snaps.length}</div></div>
          <div class="sim-stat"><div>💰 最近长线</div><div class="sim-stat-num">${(last.paperTotal || 0).toFixed(0)}</div></div>
          <div class="sim-stat"><div>⚡ 最近短线</div><div class="sim-stat-num">${shortLast != null ? shortLast.toFixed(0) : '-'}</div></div>
          <div class="sim-stat"><div>📈 长线累计 PnL</div><div class="sim-stat-num">${pnl != null ? (pnl >= 0 ? '+' : '') + pnl.toFixed(0) : '-'}</div></div>
          <div class="sim-stat"><div>📈 短线累计 PnL</div><div class="sim-stat-num">${shortPnl != null ? (shortPnl >= 0 ? '+' : '') + shortPnl.toFixed(0) : '-'}</div></div>
        `;
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<div class="sim-empty">加载失败: ' + (e && e.message || e) + '</div>';
      }
    },

    async _renderPnlChart() {
      const el = document.getElementById('simPnlContent');
      if (!el) return;
      try {
        const snaps = (await Core.Storage.kvGet('paper_snapshots')) || [];
        if (snaps.length === 0) {
          el.innerHTML = '<div class="sim-empty">暂无快照</div>';
          return;
        }
        // 渲染 echarts
        if (typeof echarts === 'undefined') {
          el.innerHTML = '<div class="sim-empty">echarts 未加载</div>';
          return;
        }
        const dates = snaps.map(s => s.date);
        const longTotal = snaps.map(s => s.paperTotal || 0);
        const shortTotal = snaps.map(s => s.shortTotal);
        const chart = echarts.init(el);
        chart.setOption({
          tooltip: { trigger: 'axis' },
          legend: { data: ['长线总资产', '短线总资产'], top: 0 },
          xAxis: { type: 'category', data: dates },
          yAxis: { type: 'value', name: '资产 (元)' },
          series: [
            { name: '长线总资产', type: 'line', data: longTotal, smooth: true, itemStyle: { color: '#1e88e5' } },
            { name: '短线总资产', type: 'line', data: shortTotal, smooth: true, itemStyle: { color: '#e65100' } }
          ]
        });
        window.addEventListener('resize', () => chart.resize(), { once: true });
      } catch (e) {
        el.innerHTML = '<div class="sim-empty">加载失败: ' + (e && e.message || e) + '</div>';
      }
    },

    // ========== Section 3: 周度归因 ==========
    async _renderWeekly() {
      const el = document.getElementById('simWeeklyContent');
      if (!el) return;
      try {
        const all = await Core.Storage.all('weekly_attribution');
        const rows = (all || []).sort((a, b) => (b.ts || 0) - (a.ts || 0)).slice(0, 12);
        if (rows.length === 0) {
          el.innerHTML = '<div class="sim-empty">暂无周度归因 (weekly_attribution 空)</div>';
          return;
        }
        const html = rows.map(r => {
          const tag = r.strategy ? `<span class="sim-tag ${r.strategy}">${r.strategy}</span>` : '';
          const pnl = r.totalPnl != null ? (r.totalPnl >= 0 ? '+' : '') + (r.totalPnl * 100).toFixed(2) + '%' : '-';
          const winRate = r.winRate != null ? (r.winRate * 100).toFixed(0) + '%' : '-';
          const summary = (r.summary || '').slice(0, 300);
          return `<div class="sim-card">
            <div style="display:flex;justify-content:space-between;align-items:center;">
              <strong>${r.weekId}</strong> ${tag}
              <span style="font-size:12px;color:var(--text-muted);">PnL ${pnl} · 胜率 ${winRate} · AI 调用 ${r.aiCalls || 0}</span>
            </div>
            <div style="margin-top:6px;font-size:13px;line-height:1.5;">${Core.Util.escapeHtml(summary)}</div>
          </div>`;
        }).join('');
        el.innerHTML = html;
      } catch (e) {
        el.innerHTML = '<div class="sim-empty">加载失败: ' + (e && e.message || e) + '</div>';
      }
    },

    // ========== Section 4: 错过机会 ==========
    async _renderMissed() {
      const el = document.getElementById('simMissedContent');
      const sumEl = document.getElementById('simMissedSummary');
      try {
        const all = await Core.Storage.all('missed_opportunities');
        const rows = (all || []).sort((a, b) => (b.notedAt || 0) - (a.notedAt || 0)).slice(0, 100);
        if (sumEl) {
          if (rows.length === 0) {
            sumEl.innerHTML = '<div class="sim-empty">暂无错过机会</div>';
          } else {
            const bySleeve = {};
            for (const r of rows) bySleeve[r.sleeve] = (bySleeve[r.sleeve] || 0) + 1;
            const stats = Object.entries(bySleeve).map(([k, v]) =>
              `<div class="sim-stat"><div>${k}</div><div class="sim-stat-num">${v}</div></div>`
            ).join('');
            sumEl.innerHTML = `<div class="sim-stat"><div>总计</div><div class="sim-stat-num">${rows.length}</div></div>${stats}`;
          }
        }
        if (!el) return;
        if (rows.length === 0) {
          el.innerHTML = '<div class="sim-empty">暂无错过机会</div>';
          return;
        }
        const html = rows.map(r => {
          const ts = r.notedAt ? new Date(r.notedAt).toISOString().slice(0, 10) : '?';
          const tag = r.sleeve ? `<span class="sim-tag ${r.sleeve}">${r.sleeve}</span>` : '';
          const ctx = r.context ? JSON.stringify(r.context).slice(0, 120) : '';
          return `<div class="sim-missed">
            <div>${ts} ${tag} <b>${r.code || '?'}</b> signal=${r.signalType || '-'} score=${r.score != null ? r.score.toFixed(2) : '-'}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${Core.Util.escapeHtml(ctx)}</div>
          </div>`;
        }).join('');
        el.innerHTML = html;
      } catch (e) {
        if (el) el.innerHTML = '<div class="sim-empty">加载失败: ' + (e && e.message || e) + '</div>';
      }
    }
  };

  // 自动启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => SimRunner.init());
  } else {
    SimRunner.init();
  }
})();