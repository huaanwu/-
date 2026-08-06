// ============== ai-butler.js · F4.7 全页 AI 管家面板 ==============
// 4 段报告: 今日机会 / 今日陷阱 / 仓位建议 / 风险提示。LLM 失败回退到规则版 4 段。

function ruleFallbackBrief(snapshot) {
  const cands = snapshot?.candidates || [];
  const top3 = cands.slice(0, 3).map(c => `${c.code} ${c.name}`).join(' / ');
  return {
    opportunity: top3 ? `重点关注 ${top3}, 符合反向 4 闸` : '今日暂无符合 4 闸候选, 建议空仓',
    trap: snapshot?.regime?.regime === 'bear' ? '熊市确认, 避免抄底' : '警惕板块封板率回落, 留意量化席位拥挤',
    position: `三态仓位倍数: ${snapshot?.positionMultiplier ?? 0.5}, 单票 ≤10%`,
    risk: '已持仓标的跌破 MA20 即触发复盘, 月度回撤 ≥8% 熔断'
  };
}

function renderButlerPanel(snapshot, container, opts = {}) {
  if (!container) return;
  container.replaceChildren();
  const card = document.createElement('div');
  card.className = 'butler-card';

  const head = document.createElement('div');
  head.className = 'butler-head';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = '🧠 今日 AI 观点';
  // 学习闭环 ① 反馈: 头部 metadata 加反馈计数
  const fbCount = (() => {
    try {
      const rw = window.ReverseWatch || {};
      const fb = (rw.loadFeedback && rw.loadFeedback()) || {};
      const downs = Object.values(fb).filter(v => v && v.verdict === 'down').length;
      return downs > 0 ? `${downs} 否定` : '';
    } catch (e) { console.warn('[ai-butler] holdingFbMeta 解析失败:', e.message); return ''; }
  })();
  // 修复 P0-5: 头部加 daemon 心跳 + regime 状态
  const daemonMeta = (() => {
    try {
      const ds = window._daemonState || null;
      if (!ds || !ds.heartbeatAt) return '';
      const age = Math.round((Date.now() - new Date(ds.heartbeatAt).getTime()) / 1000);
      const regime = (ds.regime && ds.regime.current) || '?';
      const mult = (ds.regime && ds.regime.positionMultiplier);
      const multStr = (typeof mult === 'number') ? ` · ×${mult.toFixed(1)}` : '';
      return `🛰 ${age}s · ${regime}${multStr}`;
    } catch (e) { console.warn('[ai-butler] daemon meta 解析失败:', e.message); return ''; }
  })();
  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.textContent = '⏳ 加载中…' + (fbCount ? ` · ${fbCount}` : '') + (daemonMeta ? ` · ${daemonMeta}` : '');
  head.appendChild(title);
  head.appendChild(meta);
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'butler-body';
  card.appendChild(head);

  // 修复 P0-5: 顶部加 daemon 上次巡检摘要卡片
  const daemonSummary = renderDaemonSummary();
  if (daemonSummary) card.appendChild(daemonSummary);

  card.appendChild(body);

  // #12: 用 _userCollapsed 记住用户折叠意图, 异步设 display=grid 不覆盖
  let _userCollapsed = false;
  head.onclick = () => {
    _userCollapsed = !_userCollapsed;
    body.style.display = _userCollapsed ? 'none' : 'grid';
  };
  container.appendChild(card);

  // 异步拉取
  (async () => {
    try {
      const cfg = window.ReverseWatch.AIAdapter.getAIConfig();
      const pd = (window.ReverseWatch.AIAdapter.PROVIDER_DEFAULTS || {})[cfg.provider] || {};
      // local / noAuth provider 不需要 apiKey; 有 model 即视为可调用
      const ready = pd.noAuth ? !!cfg.model : !!cfg.apiKey;
      if (!ready) {
        meta.textContent = pd.noAuth
          ? '⚠ 本地 LLM 未配置模型 · 显示规则版'
          : '⚠ 未配置 API key · 显示规则版';
        renderBrief(body, ruleFallbackBrief(snapshot));
        body.style.display = _userCollapsed ? 'none' : 'grid';
        // 通知失败回调, 让 wrapper 跳过 cache 写入
        if (typeof opts.onSuccess === 'function') opts.onSuccess(null, cfg.provider);
        return;
      }
      const report = await window.ReverseWatch.AIAdapter.butlerReport(snapshot);
      meta.textContent = `🟢 ${cfg.provider} · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
      renderBrief(body, report);
      body.style.display = _userCollapsed ? 'none' : 'grid';
      // LLM 成功回调 — 拿 brief + provider 给 wrapper 写缓存
      if (typeof opts.onSuccess === 'function') opts.onSuccess(report, cfg.provider);
    } catch (e) {
      console.warn('[ai-butler] LLM 调用失败, 走规则版:', e.message);
      meta.textContent = '⚠ LLM 不可用 · 规则版';
      renderBrief(body, ruleFallbackBrief(snapshot));
      body.style.display = _userCollapsed ? 'none' : 'grid';
      // ?v=butler-cache4: 失败回调 (不算 cache hit, 不写)
      if (typeof opts.onError === 'function') opts.onError(e);
    }
  })();
}

// ?v=daemon2 修复 P0-5: 浏览器消费 daemon 7 规则状态
// daemon 上次巡检摘要 → 卡片注入 F4.7 顶部
function renderDaemonSummary() {
  try {
    const ds = window._daemonState || null;
    if (!ds || !ds.heartbeatAt) return null;
    const wrap = document.createElement('div');
    wrap.className = 'daemon-summary';
    const age = Math.round((Date.now() - new Date(ds.heartbeatAt).getTime()) / 1000);
    // ?v=daemon4-logic2 P1 #13: 阈值 90/240 (daemon heartbeat 周期 60s, 90s 算正常, 240s 才算 stale)
    const ageCls = age > 240 ? 'danger' : (age > 90 ? 'warn' : 'pass');
    const regime = (ds.regime && ds.regime.current) || '?';
    const mult = (ds.regime && ds.regime.positionMultiplier);
    const multStr = (typeof mult === 'number') ? `×${mult.toFixed(1)}` : '?';
    const portfolio = ds.portfolio || {};
    const alerts = Array.isArray(ds.alerts) ? ds.alerts : [];
    const highAlerts = alerts.filter(a => a.severity === 'high').length;
    const warnAlerts = alerts.filter(a => a.severity === 'warn').length;
    const tasks = ds.tasks || {};
    const autoTuner = tasks.autoTuner || {};
    const screener = tasks.screener || {};
    const card = document.createElement('div');
    card.className = 'daemon-card';

    const headEl = document.createElement('div');
    headEl.className = 'daemon-head';
    const titleEl = document.createElement('span');
    titleEl.className = 'daemon-title';
    titleEl.textContent = '🛰 daemon 操盘大脑';
    const ageEl = document.createElement('span');
    ageEl.className = 'daemon-age ' + ageCls;
    ageEl.textContent = `心跳 ${age}s 前`;
    headEl.appendChild(titleEl);
    headEl.appendChild(ageEl);
    card.appendChild(headEl);

    const grid = document.createElement('div');
    grid.className = 'daemon-grid';
    const cells = [
      ['regime', `${regime} · ${multStr}`],
      ['总资产', `${(portfolio.total || 0).toLocaleString('zh-CN')} (${((portfolio.stockPct || 0)*100).toFixed(0)}% 股票)`],
      ['持仓', `${portfolio.holdings || 0} 只 · 现金 ${(portfolio.cash || 0).toLocaleString('zh-CN')}`],
      ['告警', `🚨${highAlerts} ⚠${warnAlerts} · 共 ${alerts.length}`],
      ['选股', `${screener.status || '?'}${screener.summary && screener.summary.passed != null ? ` · passed ${screener.summary.passed}` : ''}`],
      ['AutoTuner', `${autoTuner.status || '?'}${autoTuner.pending ? ` · 待审 ${autoTuner.pending.length}` : ''}`]
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

    wrap.appendChild(card);
    return wrap;
  } catch (e) { console.warn('[ai-butler] daemon summary 渲染失败:', e.message); return null; }
}

function renderBrief(body, brief) {
  body.replaceChildren();
  ['opportunity', 'trap', 'position', 'risk'].forEach(key => {
    const cell = document.createElement('div');
    cell.className = 'cell';
    const labels = { opportunity: '🎯 今日机会', trap: '⚠️ 今日陷阱', position: '📊 仓位建议', risk: '🛡️ 风险提示' };
    const lbl = document.createElement('div');
    lbl.className = 'label';
    lbl.textContent = labels[key];
    cell.appendChild(lbl);
    const txt = document.createElement('div');
    txt.textContent = brief[key] || '—';
    cell.appendChild(txt);
    body.appendChild(cell);
  });
}

// ?v=butler-cache4: 管家报告轻量缓存层 (5min TTL + 失效事件)
// 解决两个真问题: (a) refreshBtn 每次都打 LLM 烧 token + 慢, (b) daemon 高优 alert /
// regime 切换 / 持仓变更不触发管家重跑, 旧观点误导决策。
// 缓存 key = snapshot 的"内容指纹" (候选股 codes + regime + holdings 数量),
//   同样条件下命中缓存; 任何关键字段变 → miss。
const _BUTLER_TTL_MS = 5 * 60 * 1000;       // 5 分钟默认 TTL
const _BUTLER_HIGH_ALERT_TTL_MS = 60 * 1000; // daemon 高优 alert 后降到 60s 强制重跑
const _butlerCache = { key: null, ts: 0, ttlMs: _BUTLER_TTL_MS, brief: null, meta: null };
// ?v=butler-cache5 P4: in-flight 守卫, 按 fingerprint 锁 — 同一 fingerprint 在 LLM 请求中时
// 第二次 renderButlerPanelCached 直接 return, 不发第二次 LLM, 不触发第二次 onSuccess
const _butlerInFlight = { key: null };
let _butlerFilling = false; // ?v=butler-cache4 P1: 防并发 fill 守卫

function _snapshotFingerprint(snapshot) {
  try {
    const codes = (snapshot.candidates || []).map(c => c.code).sort().join(',');
    const regime = (snapshot.regime && snapshot.regime.regime) || '?';
    const mult = (snapshot.regime && snapshot.regime.positionMultiplier);
    const hCnt = Array.isArray(snapshot.holdings) ? snapshot.holdings.length
      : (snapshot.portfolio && snapshot.portfolio.holdings) || 0;
    return `${codes}|${regime}|${mult}|${hCnt}`;
  } catch (e) { console.warn('[ai-butler] fingerprint 失败:', e.message); return String(Date.now()); }
}

// 失效触发器:
//   (1) daemon 高优 alert (severity=high) → 强制 60s 内重跑
//   (2) regime 切换 (跟 snapshotFingerprint 配合, 内容变自然失效)
//   (3) holdings / account / AI-config 变更 → 立即失效
function _invalidateButlerCache(reason) {
  if (_butlerCache.brief) {
    _butlerCache.brief = null;
    _butlerCache.key = null;
    console.warn(`[ai-butler] cache invalidated: ${reason}`);
  }
}

function _butlerCacheIsValid(snapshot) {
  if (!_butlerCache.brief) return false;
  if (Date.now() - _butlerCache.ts > _butlerCache.ttlMs) return false;
  return _butlerCache.key === _snapshotFingerprint(snapshot);
}

// 注册失效监听 (与现有 dispatch 体系一致走 document)
function _setupButlerInvalidators() {
  document.addEventListener('rw:holdings-changed', () => _invalidateButlerCache('holdings-changed'));
  document.addEventListener('rw:account-changed',  () => _invalidateButlerCache('account-changed'));
  document.addEventListener('rw:ai-config-changed', () => _invalidateButlerCache('ai-config-changed'));
  document.addEventListener('rw:pool-exclude-changed', () => _invalidateButlerCache('pool-exclude-changed'));
  document.addEventListener('rw:ai-adjustments-applied', () => _invalidateButlerCache('ai-adjustments-applied'));
  document.addEventListener('rw:auto-tuning-applied', () => _invalidateButlerCache('auto-tuning-applied'));

  // daemon alerts 用自定义事件 rw:daemon-alerts (高优级降 TTL)
  document.addEventListener('rw:daemon-alerts', (e) => {
    const alerts = (e && e.detail && Array.isArray(e.detail.alerts)) ? e.detail.alerts : [];
    const hasHigh = alerts.some(a => a && a.severity === 'high');
    if (hasHigh) {
      _invalidateButlerCache('daemon-high-alert');
      _butlerCache.ttlMs = _BUTLER_HIGH_ALERT_TTL_MS;
    } else {
      _butlerCache.ttlMs = _BUTLER_TTL_MS;
    }
  });

  // regime 切换: 监听 _daemonState 轮询的 regime 变化
  let _lastRegime = null;
  setInterval(() => {
    const cur = (window._daemonState && window._daemonState.regime && window._daemonState.regime.current) || null;
    if (_lastRegime && cur && _lastRegime !== cur) {
      _invalidateButlerCache(`regime-changed:${_lastRegime}->${cur}`);
    }
    _lastRegime = cur;
  }, 5000);
}

// ?v=butler-cache5 P4: 缓存包装层 — 替 renderButlerPanel 直接调 LLM 的路径
//   关键修复: 按 fingerprint 加 in-flight 锁, 同一 key 在 LLM 请求中时
//   第二次 renderButlerPanelCached 直接 return, 不发第二次 LLM, 不触发第二次 onSuccess
//   解决 holdings-bridge bootstrap 后续 race 触发的"cache filled 2 次"问题
async function renderButlerPanelCached(snapshot, container) {
  if (!container) return;
  const fp = _snapshotFingerprint(snapshot);
  // 缓存命中 → 直接渲染
  if (_butlerCacheIsValid(snapshot)) {
    // 复用 renderButlerPanel 的 DOM 构造 + meta 显示, 但跳过 LLM 调
    const card = document.createElement('div');
    card.className = 'butler-card';
    const head = document.createElement('div');
    head.className = 'butler-head';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = '🧠 今日 AI 观点';
    const meta = document.createElement('div');
    meta.className = 'meta';
    const age = Math.round((Date.now() - _butlerCache.ts) / 1000);
    meta.textContent = `🟢 ${_butlerCache.meta.provider} · 缓存 ${age}s 前`;
    head.appendChild(title);
    head.appendChild(meta);
    const body = document.createElement('div');
    body.className = 'butler-body';
    const daemonSummary = renderDaemonSummary();
    if (daemonSummary) card.appendChild(daemonSummary);
    card.appendChild(head);
    card.appendChild(body);
    renderBrief(body, _butlerCache.brief);
    let _userCollapsed = false;
    head.onclick = () => {
      _userCollapsed = !_userCollapsed;
      body.style.display = _userCollapsed ? 'none' : 'grid';
    };
    container.replaceChildren(card);
    return;
  }
  // P4: 同 fingerprint 已在请求中, 直接 return, 不发第二次 LLM
  if (_butlerInFlight.key === fp) return;
  if (_butlerFilling) return; // 并发守卫
  _butlerFilling = true;
  _butlerInFlight.key = fp; // 锁住 in-flight key
  renderButlerPanel(snapshot, container, {
    onSuccess: (brief, provider) => {
      // P4: 必须 fingerprint 没变 + cache 没被外部 invalidate, 才写
      // ?v=butler-cache6: 写入时同步锁当时 ttlMs — 防止高优 alert 期间 fill 后 alert 解除,
      // listener 把 ttlMs 跳到 5min, 但 brief 仍按 60s 旧规则活 5min 持续 stale hit
      if (brief && provider && _butlerInFlight.key === fp && !_butlerCache.brief) {
        _butlerCache.brief = brief;
        _butlerCache.key = fp;
        _butlerCache.ts = Date.now();
        _butlerCache.meta = { provider };
        // 写时把 ttlMs 跟 _daemonState 告警情况走, 跟 _setupButlerInvalidators 行为保持一致
        const hasHigh = (() => {
          try {
            const alerts = (window._daemonState && Array.isArray(window._daemonState.alerts)) ? window._daemonState.alerts : [];
            return alerts.some(a => a && a.severity === 'high');
          } catch (e) { console.warn('[ai-butler] ttlMs 写入时告警判定失败:', e.message); return false; }
        })();
        _butlerCache.ttlMs = hasHigh ? _BUTLER_HIGH_ALERT_TTL_MS : _BUTLER_TTL_MS;
        console.warn(`[ai-butler] cache filled: ${_butlerCache.key} (provider=${provider}, ttlMs=${_butlerCache.ttlMs})`);
      }
      _butlerInFlight.key = null;
      _butlerFilling = false;
    },
    onError: () => {
      _butlerInFlight.key = null;
      _butlerFilling = false;
    }
  });
}

_setupButlerInvalidators();

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AIButler = { renderButlerPanel, renderButlerPanelCached, ruleFallbackBrief, _butlerCache };



