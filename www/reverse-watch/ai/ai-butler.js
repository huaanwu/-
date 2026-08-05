/**
 * ReverseWatch.AI.Butler — 全页管家面板渲染 (F4.7 挂载点)
 *
 * 设计: renderButlerPanel(snapshot, container) 把账户快照 + 管家周报渲染成单卡片。
 *       失败时只显示骨架, 不阻塞主页面其他模块 (try/catch 全包裹)。
 *
 * 调 callLLM: butlerReport() (ai-adapter.js)
 * 读 SETTINGS: configLLM().butlerTone (决定周报语气)
 */
(function () {
  'use strict';

  window.ReverseWatch = window.ReverseWatch || {};
  const B = window.ReverseWatch.AI = window.ReverseWatch.AI || {};

  const SECTION_ID = 'reverseButlerPanel';

  /**
   * renderButlerPanel — F4.7 section 挂载函数
   * @param {{holdings?:object[], pnl?:object, regime?:string, ranAt?:string}} snapshot
   * @param {HTMLElement} [container] 不传则用 #reverseButlerPanel
   * @returns {Promise<HTMLElement|null>}
   */
  async function renderButlerPanel(snapshot, container) {
    const mount = container || document.getElementById(SECTION_ID);
    if (!mount) return null;
    try {
      mount.innerHTML = '<div class="ai-loading">⏳ 管家生成中...</div>';
      const cfg = (window.ReverseWatch.AI.configLLM) ? window.ReverseWatch.AI.configLLM() : {};
      const tone = cfg.butlerTone || 'concise';
      let report = '';
      try {
        const A = window.ReverseWatch.AI && window.ReverseWatch.AI.butlerReport;
        if (A) report = await A(snapshot || {});
      } catch (e) {
        console.warn('[ReverseWatch.AI.Butler] LLM 周报失败:', e && e.message);
        report = '';
      }
      if (!report) report = _fallbackReport(snapshot);
      const esc = (window.Core && Core.Util && Core.Util.escapeHtml) || ((s) => String(s));
      mount.innerHTML = `
        <div class="ai-butler-card" data-tone="${esc(tone)}">
          <div class="ai-butler-head">🤖 管家周报 <span class="ai-butler-tone">${esc(tone)}</span></div>
          <div class="ai-butler-body">${esc(report)}</div>
        </div>
      `;
      return mount;
    } catch (e) {
      console.error('[ReverseWatch.AI.Butler] renderButlerPanel 外层异常:', e && e.message);
      mount.innerHTML = '<div class="ai-empty">⚠ 管家面板暂时不可用</div>';
      return mount;
    }
  }

  /** 离线兜底: 不调 AI, 用快照直接拼 */
  function _fallbackReport(snapshot) {
    const s = snapshot || {};
    const n = (s.holdings || []).length;
    const reg = s.regime || '未知';
    return `持仓 ${n} 只, 当前市场状态 ${reg}。下周关注 4 闸阈值与持仓规则命中情况。`;
  }

  B.renderButlerPanel = renderButlerPanel;
  B.SECTION_ID = SECTION_ID;
})();