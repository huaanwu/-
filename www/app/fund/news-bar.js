/**
 * Fund.NewsBar - 财经新闻条 (财新, 6h 缓存, top 5)
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund._renderNewsBar = async function() {
    let bar = document.getElementById('fundNewsBar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'fundNewsBar';
      bar.className = 'news-bar';
      // 插在 macro bar 之后
      const macro = document.getElementById('fundMacroBar');
      if (macro && macro.nextSibling) {
        macro.parentNode.insertBefore(bar, macro.nextSibling);
      } else {
        document.getElementById('fundSummary').parentNode.insertBefore(bar, document.getElementById('fundSummary'));
      }
    }
    bar.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">⏳ 加载财经新闻...</div>';

    try {
      const snap = await Core.News.get();
      const top = snap.relevant.slice(0, 5);
      bar.innerHTML = `
        <div class="news-bar-head">
          <span>📰 近期财经新闻 (财新, 相关 top ${top.length}/${snap.relevant.length})</span>
          <span class="news-bar-time">${new Date(snap.generated).toLocaleString()}</span>
          <button class="btn btn-sm btn-ghost" onclick="Fund._refreshNewsBar()">🔄</button>
        </div>
        <div class="news-list">
          ${top.map((it, i) => `
            <div class="news-item">
              <span class="news-tag">${escapeHtml(it.tag || '')}</span>
              <a href="${escapeHtml(it.url || '#')}" target="_blank" rel="noopener" class="news-title">${escapeHtml(it.summary || '')}</a>
            </div>
          `).join('') || '<div style="font-size:11px;color:var(--text-muted);">无强相关内容 (仍加载了 ' + snap.total + ' 篇)</div>'}
        </div>
      `;
    } catch (e) {
      bar.innerHTML = `<div style="font-size:12px;color:var(--down);padding:8px 0;">⚠ 新闻加载失败: ${escapeHtml(e.message)}</div>`;
    }
  };

  window.Fund._refreshNewsBar = async function() {
    await Core.News.refresh();
    return this._renderNewsBar();
  };
})();