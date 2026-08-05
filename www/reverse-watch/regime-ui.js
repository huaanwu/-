/**
 * ReverseWatch.RegimeUI — 顶栏状态灯渲染 (3 色 + stale 红闪)
 *
 * 只负责 DOM, 不做策略。订阅 RegimeDetector.subscribe(), 状态变才重画
 * 现有 reverse-watch/app.js 的 STATUS_LIGHTS_ID 容器被它接管
 */
(function () {
  'use strict';

  const LIGHT_ID = 'reverseRegimeLight';      // 顶栏新元素, 非现有 reverseStatusLights
  const COLORS = { bull: '#16a34a', bear: '#dc2626', range: '#ca8a04', stale: '#6b7280' };
  const LABELS = { bull: '趋势市 · 主升', bear: '下跌市 · 防御', range: '震荡市 · 反向', stale: '失灵' };

  /**
   * 首次挂载: 找到 LIGHT_ID 容器, 渲染当前 state
   * 依赖 DOM 已就绪 (reverse-watch/app.js init() 之后调)
   */
  function mount() {}

  /**
   * 重画: subscribe() 回调里调, 输入 { state, since, stale, confidence }
   * 用 emoji + 色块 + "持续 N 天" 文案, 不画图表 (图表走 renderKLineSvg)
   */
  function render(stateObj) {}

  /**
   * 卸/清理: 页面切走时取消订阅, 防泄漏
   */
  function unmount() {}

  window.ReverseWatch = window.ReverseWatch || {};
  window.ReverseWatch.RegimeUI = { mount, render, unmount };
})();