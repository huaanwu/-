// ============== ai-detail.js · 详情页 AI 简评升级 ==============
// 升级现有 aiChiefAnalyst 规则化 5 段为 LLM 驱动, 但保留兜底。

async function renderDetailAI(c, tech, container) {
  if (!container) return;
  // 先渲染骨架 + 加载态
  container.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'detail-ai-wrap';
  const header = document.createElement('div');
  header.className = 'detail-ai-header';
  header.appendChild(document.createTextNode('🤖 AI 简评 · 加载中…'));
  wrap.appendChild(header);
  const body = document.createElement('div');
  body.className = 'detail-ai-body';
  body.textContent = '正在调用 LLM…';
  wrap.appendChild(body);
  container.appendChild(wrap);

  // 准备上下文: 学习闭环 4 层 + 技术
  const ctxParts = [];
  const ctxFn = window.ReverseWatch?.AIChat?.buildLearningContext;
  if (typeof ctxFn === 'function') {
    ctxParts.push(ctxFn());
  }
  if (tech) {
    ctxParts.push(`技术: MA20偏离 ${tech.chg20 ? (tech.chg20 * 100).toFixed(1) + '%' : '?'}, 量比 ${tech.volRatio ?? '?'}`);
  }
  try {
    // ?v=ai-detail-fix1: 把 tech 字段直接塞 stock, summarizeStock 会取 ma5/ma10/ma20/volRatio/price
    const stockWithTech = { ...c, tech };
    const r = await window.ReverseWatch.AIAdapter.summarizeStock(stockWithTech, ctxParts.join('\n'));
    header.textContent = `🤖 AI 简评 · ${r.provider} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    body.style.whiteSpace = 'pre-line';
    body.textContent = r.text || '（无内容）';
    // 加 🔄 重生成
    const refresh = document.createElement('button');
    refresh.className = 'btn-secondary';
    refresh.style.cssText = 'margin-top:8px;font-size:11px;';
    refresh.textContent = '🔄 重生成';
    refresh.onclick = () => renderDetailAI(c, tech, container);
    wrap.appendChild(refresh);
  } catch (e) {
    // 失败兜底: 规则化 5 段
    header.textContent = '🧠 AI 简评 · 规则版 (LLM 暂不可用)';
    let fallbackText = 'AI 不可用';
    try {
      // ES module 作用域下 aiChiefAnalyst 不在 window 上, 必须从 ReverseWatch 取
      const f = window.ReverseWatch && (window.ReverseWatch.aiChiefAnalyst || window.aiChiefAnalyst);
      if (typeof f === 'function') {
        fallbackText = f(c, tech) || 'AI 暂不可用';
      } else {
        fallbackText = `规则版未注册 (ReverseWatch.aiChiefAnalyst=${typeof (window.ReverseWatch && window.ReverseWatch.aiChiefAnalyst)})`;
      }
    } catch (inner) {
      fallbackText = `规则版生成失败: ${inner.message}`;
    }
    body.textContent = fallbackText;
    const note = document.createElement('div');
    note.style.cssText = 'margin-top:6px;font-size:11px;color:var(--danger);';
    note.textContent = `LLM 错误: ${e.message}`;
    wrap.appendChild(note);
  }
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AIDetail = { renderDetailAI };