// ============== ai-push.js · 推送型提醒 ==============
// 持仓触发预警: MA20 跌破 / 板块 3 日 <50% / 鱼尾 5 日 +15% / 陷阱命中
// 双通道: Web Notification API + 站内 toast

async function requestNotifyPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const p = await Notification.requestPermission();
  return p === 'granted';
}

function webNotify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted') {
      // Notification.icon 不支持 emoji (会被拒或显示空白), 用 SVG data URL 兜底
      const ICON_SVG = 'data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><text y="20" font-size="20">🔔</text></svg>';
      new Notification(title, { body, icon: ICON_SVG });
      return true;
    }
  } catch (e) {
    console.warn('[ai-push] webNotify 失败:', e.message);
  }
  return false;
}

function checkTriggers(holdings, rules) {
  // holdings: [{code, name, change5d, sectorStrength, belowMA20, fishTail5d}]
  // rules: HOLDING_RULES 当前生效的 5 类规则
  const notifications = [];
  for (const h of holdings || []) {
    if (h.belowMA20) {
      notifications.push({ severity: 'warn', title: `${h.name} 跌破 MA20`, body: '触发中线止损复盘, 建议检查买入假设' });
    }
    if (h.fishTail5d && h.fishTail5d > (rules?.fishTailTrimPct || 0.15)) {
      notifications.push({ severity: 'warn', title: `${h.name} 鱼尾行情`, body: `5 日涨幅 ${(h.fishTail5d*100).toFixed(1)}% ≥ ${(rules.fishTailTrimPct*100).toFixed(0)}%, 强制减半` });
    }
    if (h.sectorStrength != null && h.sectorStrength < (rules?.sectorWeakPct || 0.50)) {
      notifications.push({ severity: 'info', title: `${h.name} 板块走弱`, body: `板块强度 ${(h.sectorStrength*100).toFixed(0)}% < ${(rules.sectorWeakPct*100).toFixed(0)}%, 该板块持仓减半` });
    }
  }
  return notifications;
}

async function dispatchNotifications(notifs) {
  if (!notifs.length) return;
  const granted = await requestNotifyPermission();
  for (const n of notifs) {
    webNotify(n.title, n.body);
    if (typeof toast === 'function') toast(`${n.title}: ${n.body}`, n.severity === 'warn' ? 'warn' : 'info');
  }
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AIPush = { checkTriggers, dispatchNotifications, requestNotifyPermission };