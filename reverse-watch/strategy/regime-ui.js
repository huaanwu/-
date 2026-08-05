// ============== RegimeUI · 顶栏状态灯渲染 ==============
// 在 F1 KPI 上方插入"今日市场状态"横条: 3 色徽标 + hint + 切换日志 (可折叠)
// BEAR 下候选为空时显示"今日防守, 无新开仓"而非空白
// 安全: 全部用 textContent / createElement, 不碰 innerHTML, 防 hint/strategy 名注入

const REGIME_COLOR = {
  bull: { color: '#ef4444', label: '🐂 牛市', desc: '顺势追强 / 仓位 ×1.0' },
  range_weak: { color: '#eab308', label: '🐢 震荡 (弱)', desc: '反向破羊 / 仓位 ×0.5' },
  range_strong: { color: '#f97316', label: '⚡ 震荡 (强)', desc: '反向禁用 / 仓位 ×0.3' },
  // 熊市: 用红色警示 (中国市场: 红=涨/暖/警示), 不要再用绿色 (绿=跌/冷/可买)
  bear: { color: '#dc2626', label: '🐻 熊市', desc: '现金为王 / 仓位 ×0.0 (空仓合法)' }
};

function el(tag, attrs = {}, text = null) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k === 'class') e.className = v;
    else e.setAttribute(k, v);
  }
  if (text != null) e.textContent = String(text);
  return e;
}

function clearChildren(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function renderRegimeBar(regime, metaLineEl) {
  if (!metaLineEl) return;
  clearChildren(metaLineEl);
  const cfg = REGIME_COLOR[regime.regime] || REGIME_COLOR.range_weak;

  const pill = el('span', { class: 'regime-pill' }, cfg.label);
  Object.assign(pill.style, {
    background: cfg.color, color: '#fff',
    padding: '2px 10px', borderRadius: '12px',
    fontWeight: '600', marginRight: '8px'
  });

  const hint = el('span', { class: 'regime-hint' }, regime.hint || cfg.desc);
  Object.assign(hint.style, { color: '#888', fontSize: '12px', marginRight: '8px' });

  const mult = el('span', { class: 'regime-mult' }, cfg.desc);
  Object.assign(mult.style, { color: cfg.color, fontWeight: '600', marginRight: '12px' });

  metaLineEl.appendChild(pill);
  metaLineEl.appendChild(hint);
  metaLineEl.appendChild(mult);
  appendHistoryWidget(metaLineEl);
}

function appendHistoryWidget(parent) {
  const hist = JSON.parse(localStorage.getItem('_rw_regime_history') || '[]');
  if (!hist.length) return;
  const details = el('details', { class: 'regime-history' });
  Object.assign(details.style, { marginLeft: '12px', display: 'inline-block' });
  const summary = el('summary', {}, `切换历史 (${hist.length})`);
  Object.assign(summary.style, { cursor: 'pointer', color: '#888', fontSize: '11px' });
  details.appendChild(summary);
  const box = el('div', {}, '');
  Object.assign(box.style, { fontSize: '11px', color: '#aaa', padding: '4px 0' });
  hist.slice(0, 3).forEach(h => {
    const from = (REGIME_COLOR[h.from]?.label) || String(h.from);
    const to = (REGIME_COLOR[h.to]?.label) || String(h.to);
    const item = el('span', { class: 'hist-item', style: { marginRight: '8px' } }, `${h.date}: ${from} → ${to}`);
    box.appendChild(item);
  });
  details.appendChild(box);
  parent.appendChild(details);
}

// 熊市空态文案 — 返回 DOM 节点, 由调用方挂载
function renderBearEmpty() {
  const wrap = el('div', { class: 'empty-bear' });
  Object.assign(wrap.style, {
    padding: '24px', textAlign: 'center',
    color: '#dc2626', background: '#fef2f2',
    borderRadius: '8px', margin: '16px 0'
  });
  wrap.appendChild(el('div', { style: { fontSize: '18px', fontWeight: '600' } }, '🐻 熊市: 仓位 ×0.0'));
  wrap.appendChild(el('div', { style: { marginTop: '8px', color: '#666' } }, '今日防守, 无新开仓'));
  wrap.appendChild(el('div', { style: { marginTop: '4px', fontSize: '12px', color: '#999' } },
    '启动每周定投 ETF (中证500+沪深300 各半), 触及月度 -8% 熔断则停投'));
  return wrap;
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.RegimeUI = { renderRegimeBar, renderBearEmpty, REGIME_COLOR };