/**
 * Fund.PortfolioRisk - 组合风险指标 UI
 *
 * 纯函数 _computePortfolioMetrics 在主文件 fund.js (被 test_all.js vm 测)
 * 本子文件只承载 UI 部分: 拉历史净值 → 调主文件纯函数 → 渲染
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund.portfolioRiskDialog = async function() {
    const list = await Core.Storage.all('funds');
    const holdings = [];
    const codes = [];
    for (const f of list) {
      if (!f.shares || f.shares <= 0) continue;
      // 拉最新净值
      let currentNav = null;
      try {
        const data = await Core.Data.getFundSpot(f.code);
        if (Array.isArray(data) && data.length > 0) {
          currentNav = parseFloat(data[data.length - 1].单位净值 || data[data.length - 1]['单位净值'] || data[data.length - 1].value);
        }
      } catch (e) { /* skip */ }
      if (!currentNav) continue;
      holdings.push({
        code: f.code, name: f.name, type: f.type,
        shares: f.shares, currentNav,
        value: f.shares * currentNav
      });
      codes.push(f.code);
    }

    if (holdings.length === 0) {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal"><h3>📊 组合风险</h3>
            <div style="padding:20px;text-align:center;color:var(--text-muted);">无持仓, 无法计算</div>
            <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
          </div>
        </div>`;
      document.getElementById('modalRoot').innerHTML = html;
      return;
    }

    // 拉过去 1 年日净值
    const end = new Date();
    const start = new Date();
    start.setFullYear(start.getFullYear() - 1);
    const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

    const navHistory = {};
    const loading = (pre) => {
      const el = document.getElementById('prLoading');
      if (el) el.textContent = pre;
    };

    // 先显示加载
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:680px;width:100%;">
          <h3>📊 组合风险指标</h3>
          <div id="prLoading" style="padding:20px;text-align:center;color:var(--text-muted);">⏳ 拉取 ${codes.length} 只基金 1 年日净值...</div>
          <div id="prResult"></div>
          <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
        </div>
      </div>`;

    // 并行拉
    await Promise.all(codes.map(async (code, i) => {
      loading(`⏳ 拉取 (${i + 1}/${codes.length}) ${code}...`);
      try {
        const data = await Core.Data.getFundHistory(code, fmt(start), fmt(end));
        if (Array.isArray(data) && data.length > 0) {
          navHistory[code] = data.map(d => ({
            date: (d.净值日期 || d.x日期 || '').replace(/-/g, ''),
            nav: parseFloat(d.单位净值 || d['单位净值'] || d.y)
          })).filter(x => x.date && x.nav);
        }
      } catch (e) {
        console.warn('[Fund] 拉历史净值失败:', code, e);
      }
    }));

    // 算 (主文件 _computePortfolioMetrics)
    const result = this._computePortfolioMetrics(holdings, navHistory);
    this._renderPortfolioRisk(result);
  };

  window.Fund._renderPortfolioRisk = function(result) {
    const el = document.getElementById('prResult');
    const ld = document.getElementById('prLoading');
    if (ld) ld.remove();
    if (!el) return;

    if (!result.ok) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">${escapeHtml(result.reason)}</div>`;
      return;
    }

    const m = result.metrics;
    const p = result.period;
    const riskColor = (x, isDD) => {
      if (isDD) return x > -0.05 ? 'var(--up)' : (x < -0.2 ? 'var(--down)' : 'var(--text)');
      return x > 0 ? 'var(--up)' : (x < 0 ? 'var(--down)' : 'var(--text-muted)');
    };

    // 6 个指标卡
    const cards = `
      <div class="summary-cards" style="grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
        <div class="summary-card">
          <div class="label">年化收益</div>
          <div class="value ${riskColor(m.annualReturn)}">${(m.annualReturn * 100).toFixed(2)}%</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">复利 ${(m.cumAnnual * 100).toFixed(2)}%</div>
        </div>
        <div class="summary-card">
          <div class="label">年化波动</div>
          <div class="value">${(m.annualVol * 100).toFixed(2)}%</div>
        </div>
        <div class="summary-card">
          <div class="label">最大回撤</div>
          <div class="value ${riskColor(m.maxDD, true)}">${(m.maxDD * 100).toFixed(2)}%</div>
        </div>
        <div class="summary-card">
          <div class="label">Sharpe</div>
          <div class="value">${m.sharpe.toFixed(2)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">风险调整</div>
        </div>
        <div class="summary-card">
          <div class="label">Sortino</div>
          <div class="value">${m.sortino > 0 ? m.sortino.toFixed(2) : '-'}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">下行调整</div>
        </div>
        <div class="summary-card">
          <div class="label">Calmar</div>
          <div class="value">${m.calmar > 0 ? m.calmar.toFixed(2) : '-'}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">收益/回撤</div>
        </div>
      </div>
      <div style="font-size:11px;color:var(--text-muted);line-height:1.6;background:var(--bg-base);padding:8px;border-radius:4px;">
        📅 区间: ${escapeHtml(p.start)} - ${escapeHtml(p.end)} (${p.tradingDays} 交易日 ≈ ${p.years.toFixed(2)} 年)<br>
        💰 组合总市值: ${fmtMoney(result.totalValue)}<br>
        🎯 胜率: ${(m.winRate * 100).toFixed(1)}% · 最佳日: ${(m.bestDay * 100).toFixed(2)}% · 最差日: ${(m.worstDay * 100).toFixed(2)}%
      </div>
      <div style="margin-top:12px;font-size:11px;color:var(--text-muted);line-height:1.6;">
        💡 <strong>读法</strong>:<br>
        • <strong>Sharpe > 1</strong>: 风险调整后收益不错<br>
        • <strong>最大回撤</strong>: 历史上最坏情况下, 跌了多少<br>
        • <strong>Sortino</strong>: 只看下行波动, 涨的波动不算风险<br>
        • <strong>Calmar</strong>: 年化收益 / 最大回撤, 越高越好
      </div>
    `;

    el.innerHTML = cards;
  };
})();