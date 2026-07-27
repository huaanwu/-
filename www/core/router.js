/**
 * Core.Router - 页面切换
 */
(function() {
  'use strict';

  /**
   * 切换到指定页面
   * @param {string} pageId - e.g. 'pageWatchlist'
   */
  function switchPage(pageId) {
    // 1) 隐藏所有 page
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    // 2) 显示目标
    const target = document.getElementById(pageId);
    if (!target) {
      console.warn('[Router] page not found:', pageId);
      return;
    }
    target.classList.add('active');
    // 3) 滚动到顶部
    const main = document.querySelector('.app-main');
    if (main) main.scrollTop = 0;
    // 4) 同步 nav 高亮
    document.querySelectorAll('.nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.page === pageId);
    });
    // 5) 更新状态 + 触发 onShow
    Core.State.set('currentPage', pageId);
    // 各域脚本可以挂 onShow[pageId] 函数
    const handler = window['_onShow_' + pageId];
    if (typeof handler === 'function') {
      try { handler(); }
      catch (e) { console.warn(`[onShow:${pageId}]`, e); }
    }
  }

  /**
   * 跳到设置页
   */
  function goSettings() {
    switchPage('pageSettings');
  }

  window.Core = window.Core || {};
  window.Core.Router = { switchPage, goSettings };
})();
