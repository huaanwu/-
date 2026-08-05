/**
 * ReverseWatch.AI.Detail — 详情页 AI 简评升级 (替 aiChiefAnalyst 兜底)
 *
 * 设计: renderDetailAI(c, tech) 优先用 AI.Adapter.stockAdvisor (新),
 *       失败/未配置时回退 aiChiefAnalyst() 兜底, 保证详情页永远有内容。
 *
 * 调 callLLM: stockAdvisor() 内部 (ai-adapter.js)
 * 读 SETTINGS: 否 (走 Adapter 的封装)
 */
(function () {
  'use strict';

  window.ReverseWatch = window.ReverseWatch || {};
  const D = window.ReverseWatch.AI = window.ReverseWatch.AI || {};

  /**
   * renderDetailAI — 详情弹窗 AI 简评节点渲染
   * @param {{code:string, name:string}} c 标的
   * @param {object} tech 5 维技术指标 {ma, macd, rsi, vol, pe}
   * @param {HTMLElement} [mount] 容器; 不传则不渲染 DOM 只返字符串
   * @returns {Promise<string>} 最终文案
   */
  async function renderDetailAI(c, tech, mount) {
    let text = '';
    try {
      const A = window.ReverseWatch.AI && window.ReverseWatch.AI.stockAdvisor;
      if (A) text = await A(c, { tech: tech || {} });
    } catch (e) {
      console.warn('[ReverseWatch.AI.Detail] 升级路径失败, 走兜底:', e && e.message);
      text = '';
    }
    if (!text) text = aiChiefAnalyst(c, tech);
    if (mount) {
      mount.innerHTML = `<div class="ai-brief">${(window.Core && Core.Util && Core.Util.escapeHtml) ? Core.Util.escapeHtml(text) : text}</div>`;
    }
    return text;
  }

  /**
   * aiChiefAnalyst — 离线兜底 (无 AI 也能给出基于规则的简评)
   * 保留旧签名, 不依赖 LLM, 确保详情页"零 AI 也能用"
   * @param {{code:string, name:string}} c
   * @param {{ma?:number, macd?:number, rsi?:number, vol?:number, pe?:number}} tech
   * @returns {string} 中文简评 60-100 字
   */
  function aiChiefAnalyst(c, tech) {
    const t = tech || {};
    const parts = [];
    if (typeof t.rsi === 'number') parts.push(t.rsi > 70 ? 'RSI 超买' : t.rsi < 30 ? 'RSI 超卖' : 'RSI 中性');
    if (typeof t.macd === 'number') parts.push(t.macd > 0 ? 'MACD 金叉' : 'MACD 死叉');
    if (typeof t.pe === 'number') parts.push('PE ' + t.pe.toFixed(1));
    const sig = parts.length ? parts.join(' + ') : '数据不足';
    return `${c.name}(${c.code}) ${sig}; 反向策略建议观望 4 闸通过后再决策。`;
  }

  D.renderDetailAI = renderDetailAI;
  D.aiChiefAnalyst = aiChiefAnalyst;
})();