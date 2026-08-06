// ============== reverse-watch/ai/daemon-status-ui.js · F4.8 daemon panel 渲染 ==============
// #156: 修复僵尸 panel (index.html L69-85 写死 ID, 但无 JS 渲染, 永远加载中)
// #157: onboarding 黑洞 — ds===null / !heartbeatAt 时显 placeholder 红卡
//
// 设计: 复用 ai-butler 的 window._daemonState (app.js firstRender 写入)
// 失败/未启动/无心跳 → 推 🛰 daemon 未启动 placeholder 卡, 提示 pm2 start

// P0 #169: 不再依赖 ai-butler 导出的 renderDaemonSummary, 本地实现 (避免双维护)

function _renderDaemonSummary(ds) {
  const card = document.createElement('div');
  card.className = 'daemon-card';
  const head = document.createElement('div');
  head.className = 'daemon-head';
  const title = document.createElement('span');
  title.className = 'daemon-title';
  title.textContent = '🛰 daemon 操盘大脑';
  const hb = ds.heartbeatAt ? new Date(ds.heartbeatAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
  const age = document.createElement('span');
  age.className = 'daemon-age';
  age.textContent = `心跳 ${hb}`;
  head.appendChild(title);
  head.appendChild(age);
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'daemon-grid';
  const regime = (ds.regime && ds.regime.current) || 'unknown';
  const mult = (ds.regime && ds.regime.positionMultiplier);
  const port = ds.portfolio || {};
  const holdingsN = (port.holdings != null) ? port.holdings : (Array.isArray(window._daemonState?.localHoldings) ? window._daemonState.localHoldings.length : '—');
  const stockMkt = port.stockMkt != null ? port.stockMkt : '—';
  const alertsN = Array.isArray(ds.alerts) ? ds.alerts.length : 0;
  const cells = [
    ['regime', regime],
    ['仓位倍数', mult != null ? mult.toFixed(2) : '—'],
    ['持仓', `${holdingsN} 只`],
    ['市值', typeof stockMkt === 'number' ? stockMkt.toLocaleString('zh-CN') : stockMkt],
    ['告警', `${alertsN} 条`],
    ['状态', (ds.daemon && ds.daemon.status) || 'ok']
  ];
  cells.forEach(([label, value]) => {
    const c = document.createElement('div');
    c.className = 'cell';
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.textContent = String(value);
    c.appendChild(l);
    c.appendChild(v);
    grid.appendChild(c);
  });
  card.appendChild(grid);
  return card;
}

export function mountDaemonStatusUI() {
  const panel = document.querySelector('#daemonStatusCard');
  if (!panel) return;
  panel.replaceChildren();

  const ds = window._daemonState || null;
  const summary = (ds && ds.heartbeatAt) ? _renderDaemonSummary(ds) : null;

  if (!summary) {
    // P0 #157: onboarding 黑洞 — daemon 未起, 推 placeholder 红卡 + 启动提示
    panel.appendChild(_renderPlaceholder());
    return;
  }

  // 真有 daemon 数据 → 渲染摘要
  panel.appendChild(summary);

  // alerts 列表 (F4.8 专属: 详细告警条 + 来源链路)
  const alertsBox = document.createElement('div');
  alertsBox.className = 'daemon-alerts-list';
  const alerts = Array.isArray(ds.alerts) ? ds.alerts : [];
  if (alerts.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'daemon-alerts-empty';
    empty.textContent = '✓ 7 规则联动无告警';
    alertsBox.appendChild(empty);
  } else {
    // 按 severity 倒序取 top 10
    const top = alerts.slice(0, 10);
    for (const a of top) {
      alertsBox.appendChild(_renderAlertRow(a));
    }
  }
  panel.appendChild(alertsBox);
}

// 单条告警行 (severity 着色 + linked_rules 溯源)
function _renderAlertRow(a) {
  const row = document.createElement('div');
  const sev = (a && a.severity) || 'info';
  row.className = `daemon-alert severity-${sev}`;
  const head = document.createElement('div');
  head.className = 'daemon-alert-head';
  const badge = document.createElement('span');
  badge.className = `daemon-alert-badge badge-${sev}`;
  badge.textContent = sev.toUpperCase();
  const code = document.createElement('span');
  code.className = 'daemon-alert-code';
  code.textContent = `${a.code || '*'} ${a.name || ''}`;
  const linked = document.createElement('span');
  linked.className = 'daemon-alert-linked';
  const lr = Array.isArray(a.linked_rules) ? a.linked_rules.join('·') : '';
  linked.textContent = lr ? `规则 ${lr}` : '';
  head.appendChild(badge);
  head.appendChild(code);
  head.appendChild(linked);
  const title = document.createElement('div');
  title.className = 'daemon-alert-title';
  title.textContent = a.title || '';
  const body = document.createElement('div');
  body.className = 'daemon-alert-body';
  body.textContent = a.body || '';
  row.appendChild(head);
  row.appendChild(title);
  row.appendChild(body);
  return row;
}

// P0 #157 placeholder — daemon 未启动 / 心跳缺失
function _renderPlaceholder() {
  const card = document.createElement('div');
  card.className = 'daemon-card daemon-card-offline';
  const head = document.createElement('div');
  head.className = 'daemon-head';
  const title = document.createElement('span');
  title.className = 'daemon-title';
  title.textContent = '🛰 daemon 未启动';
  const age = document.createElement('span');
  age.className = 'daemon-age danger';
  age.textContent = 'OFFLINE';
  head.appendChild(title);
  head.appendChild(age);
  card.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'daemon-grid';
  const cells = [
    ['regime', '—'],
    ['持仓', '—'],
    ['告警', '—'],
    ['启动方式', 'pm2 start ecosystem.config.cjs'],
    ['健康检查', 'http://127.0.0.1:8090/health'],
    ['状态文件', '_rw_daemon_state.json']
  ];
  cells.forEach(([label, value]) => {
    const c = document.createElement('div');
    c.className = 'cell';
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('div');
    v.textContent = value;
    c.appendChild(l);
    c.appendChild(v);
    grid.appendChild(c);
  });
  card.appendChild(grid);

  const hint = document.createElement('div');
  hint.className = 'daemon-offline-hint';
  hint.textContent = '⚠ 7 规则联动 / 飞书推送 / AutoTuner 全部停摆。daemon 启动后自动恢复。';
  card.appendChild(hint);

  return card;
}

// 跨 tab/刷新 hook: 让 app.js 在 loadDaemonState() 完成后重调此 mount
export function refreshDaemonStatusUI() { mountDaemonStatusUI(); }

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.DaemonStatusUI = { mount: mountDaemonStatusUI, refresh: refreshDaemonStatusUI };