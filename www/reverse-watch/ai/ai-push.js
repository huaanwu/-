/**
 * ReverseWatch.AI.Push — 推送型提醒 (Web Notification + 本地 toast 双通道)
 *
 * 设计: checkTriggers(holdings, rules) 拿当前持仓 + 持仓规则, 命中后生成 notification[],
 *       再走 _dispatch() 推 Web Notification 和 Core.toast 双通道, 用户在 SETTINGS 控通道开关。
 *
 * 读 SETTINGS: configLLM().notifyChannel / autoPush (ai-adapter.js)
 * 调 callLLM: 否 (纯本地规则匹配, 不烧 token)
 */
(function () {
  'use strict';

  window.ReverseWatch = window.ReverseWatch || {};
  const P = window.ReverseWatch.AI = window.ReverseWatch.AI || {};

  /**
   * checkTriggers — 命中持仓规则则生成推送项
   * @param {Array<{code:string, name:string, pct?:number}>} holdings 当前持仓
   * @param {Array<{id:string, type:string, threshold:number, severity?:'info'|'warn'|'critical'}>} rules 持仓规则
   * @returns {Array<{code:string, name:string, rule:string, severity:string, msg:string}>}
   */
  function checkTriggers(holdings, rules) {
    try {
      const out = [];
      const list = Array.isArray(holdings) ? holdings : [];
      const rs = Array.isArray(rules) ? rules : [];
      for (const h of list) {
        for (const r of rs) {
          if (_match(h, r)) {
            out.push({
              code: h.code, name: h.name,
              rule: r.id || r.type || 'rule',
              severity: r.severity || 'info',
              msg: _format(h, r)
            });
          }
        }
      }
      _dispatch(out);
      return out;
    } catch (e) {
      console.warn('[ReverseWatch.AI.Push] checkTriggers 失败:', e && e.message);
      return [];
    }
  }

  function _match(h, r) {
    if (!h || !r) return false;
    if (r.type === 'pct_above') return typeof h.pct === 'number' && h.pct >= r.threshold;
    if (r.type === 'pct_below') return typeof h.pct === 'number' && h.pct <= r.threshold;
    return false;
  }

  function _format(h, r) {
    const pct = (typeof h.pct === 'number') ? h.pct.toFixed(1) + '%' : '?';
    return `${h.name}(${h.code}) 触发规则 ${r.id || r.type}: 当前 ${pct}, 阈值 ${r.threshold}%`;
  }

  /** 派发: Web Notification + 本地 toast (SETTINGS.notifyChannel 控制) */
  function _dispatch(notifs) {
    if (!Array.isArray(notifs) || notifs.length === 0) return;
    let ch = 'toast+web';
    try {
      const cfg = window.ReverseWatch.AI.configLLM ? window.ReverseWatch.AI.configLLM() : {};
      ch = cfg.notifyChannel || 'toast+web';
      if (!cfg.autoPush) return;  // 关了定时推送, 不打
    } catch (e) { console.warn('[ReverseWatch.AI.Push] 读通道失败, 用默认:', e && e.message); }
    const wantWeb = ch === 'web' || ch === 'toast+web';
    const wantToast = ch === 'toast' || ch === 'toast+web';
    if (wantToast && window.Core && Core.toast) {
      notifs.slice(0, 5).forEach(n => {
        try { Core.toast(n.msg, n.severity === 'critical' ? 'error' : 'info'); }
        catch (e) { console.warn('[ReverseWatch.AI.Push] toast 失败:', e && e.message); }
      });
    }
    if (wantWeb && typeof window.Notification !== 'undefined') {
      try {
        if (Notification.permission === 'granted') {
          notifs.slice(0, 3).forEach(n => new Notification(n.msg));
        } else if (Notification.permission !== 'denied') {
          Notification.requestPermission().then(p => {
            if (p === 'granted') notifs.slice(0, 3).forEach(n => new Notification(n.msg));
          });
        }
      } catch (e) { console.warn('[ReverseWatch.AI.Push] Web Notification 失败:', e && e.message); }
    }
  }

  P.checkTriggers = checkTriggers;
})();