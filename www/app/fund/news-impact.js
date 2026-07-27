/**
 * Fund.NewsImpact - 新闻→持仓影响 UI
 *
 * 纯函数 _analyzeNewsImpact 在主文件 fund.js (被 test_all.js vm 测)
 * 本子文件只承载 UI 部分: 拉新闻 → 调主文件纯函数 → 渲染
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund.newsImpactDialog = async function() {
    // 1. 拉持仓
    const list = await Core.Storage.all('funds');
    const holdings = list.filter(f => f.shares && f.shares > 0).map(f => ({
      code: f.code, name: f.name, type: f.type
    }));
    if (holdings.length === 0) {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal"><h3>📰 新闻→持仓影响</h3>
            <div style="padding:20px;text-align:center;color:var(--text-muted);">无持仓, 无法分析</div>
            <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
          </div>
        </div>`;
      document.getElementById('modalRoot').innerHTML = html;
      return;
    }

    // 2. 拉新闻
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:760px;width:100%;">
          <h3>📰 新闻 → 持仓影响</h3>
          <div id="niLoading" style="padding:20px;text-align:center;color:var(--text-muted);">⏳ 拉取财新新闻 + 匹配持仓影响...</div>
          <div id="niResult"></div>
          <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
        </div>
      </div>`;

    let snap = null;
    try { snap = await Core.News.get(); }
    catch (e) {
      document.getElementById('niLoading').innerHTML = `<div style="color:var(--down);">⚠ 新闻拉取失败: ${escapeHtml(e.message)} (需要 aktools 跑着)</div>`;
      return;
    }
    if (!snap || !snap.relevant || snap.relevant.length === 0) {
      document.getElementById('niLoading').innerHTML = '<div style="color:var(--text-muted);">无相关新闻</div>';
      return;
    }

    // 3. 规则匹配 (主文件 _analyzeNewsImpact 纯函数)
    const impacts = this._analyzeNewsImpact(snap.relevant, holdings);
    this._renderNewsImpact(snap, impacts, holdings);
  };

  window.Fund._renderNewsImpact = function(snap, impacts, holdings) {
    const ld = document.getElementById('niLoading');
    const el = document.getElementById('niResult');
    if (ld) ld.remove();
    if (!el) return;

    if (impacts.length === 0) {
      el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">📭 ${snap.relevant.length} 条相关新闻中, 无匹配规则的"对持仓有影响"内容<br><span style="font-size:11px;">(都是中性新闻或关键词未覆盖)</span></div>`;
      return;
    }

    // 汇总: 利好持仓 / 利空持仓
    const byHolding = {};
    for (const imp of impacts) {
      for (const it of imp.items) {
        const code = it.holding.code;
        if (!byHolding[code]) byHolding[code] = { holding: it.holding, pos: 0, neg: 0, neut: 0 };
        if (it.impact === 'positive') byHolding[code].pos++;
        else if (it.impact === 'negative') byHolding[code].neg++;
        else byHolding[code].neut++;
      }
    }
    const summaryHTML = `
      <div style="background:var(--bg-base);padding:8px;border-radius:6px;margin-bottom:12px;font-size:12px;">
        <strong>📊 对你持仓的总体影响</strong> (基于 ${impacts.length}/${snap.relevant.length} 条匹配新闻):
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
          ${Object.values(byHolding).map(b => {
            const code = escapeHtml(b.holding.code);
            const name = escapeHtml(b.holding.name || '');
            let label = '➖ 中性';
            let color = 'var(--text-muted)';
            if (b.pos > b.neg) { label = `📈 利好 ${b.pos} 条`; color = 'var(--up)'; }
            else if (b.neg > b.pos) { label = `📉 利空 ${b.neg} 条`; color = 'var(--down)'; }
            return `<span style="background:var(--bg-card);padding:3px 8px;border-radius:4px;border:1px solid ${color};">
              <strong>${code}</strong> ${name} <span style="color:${color};font-weight:600;">${label}</span>
            </span>`;
          }).join('')}
        </div>
      </div>
    `;

    // 每条新闻
    const itemsHTML = impacts.map(imp => {
      const positive = imp.items.filter(i => i.impact === 'positive');
      const negative = imp.items.filter(i => i.impact === 'negative');
      const dominant = positive.length >= negative.length ? 'positive' : 'negative';
      const domColor = dominant === 'positive' ? 'var(--up)' : 'var(--down)';
      const domIcon = dominant === 'positive' ? '📈' : '📉';
      const domLabel = dominant === 'positive' ? '利好' : '利空';

      const tag = escapeHtml(imp.news.tag || '财经');
      const summary = escapeHtml(imp.news.summary || '');
      const url = escapeHtml(imp.news.url || '#');

      const affectedHTML = imp.items.map(i => {
        const c = i.impact === 'positive' ? 'var(--up)' : (i.impact === 'negative' ? 'var(--down)' : 'var(--text-muted)');
        const icon = i.impact === 'positive' ? '↑' : (i.impact === 'negative' ? '↓' : '·');
        return `<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">
          <span style="color:${c};font-weight:600;">${icon} ${escapeHtml(i.holding.code)} ${escapeHtml(i.holding.name || '')}</span>
          <span style="color:var(--text-muted);"> — ${i.reasons[0] || ''}</span>
        </div>`;
      }).join('');

      return `<div class="data-card" style="margin-bottom:8px;padding:10px;border-left:3px solid ${domColor};">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
          <span class="news-tag" style="background:${domColor}22;color:${domColor};">${domIcon} ${domLabel}</span>
          <a href="${url}" target="_blank" rel="noopener" style="font-size:10px;color:var(--text-muted);text-decoration:none;">原文 →</a>
        </div>
        <a href="${url}" target="_blank" rel="noopener" class="news-title" style="font-size:12px;color:var(--text);text-decoration:none;line-height:1.5;display:block;">${summary}</a>
        <div style="margin-top:4px;">${affectedHTML}</div>
      </div>`;
    }).join('');

    el.innerHTML = summaryHTML + itemsHTML;
  };
})();