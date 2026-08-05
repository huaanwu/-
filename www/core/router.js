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

  /**
   * P2-9: 返回当前所有合法 pageId (从 DOM 实时扫, 无需手动维护白名单).
   * 优先从 .nav-item[data-page] 读, 兜底扫 .page[id] 容器, 合并去重.
   * 用于 agent-tools 的 ui.navigateTo 等需要白名单校验的场景.
   * @returns {string[]}
   */
  function listPages() {
    const ids = new Set();
    document.querySelectorAll('.nav-item[data-page]').forEach(el => { if (el.dataset.page) ids.add(el.dataset.page); });
    document.querySelectorAll('.page[id]').forEach(el => { if (el.id) ids.add(el.id); });
    return Array.from(ids);
  }

  window.Core = window.Core || {};
  window.Core.Router = { switchPage, goSettings, listPages };
})();
