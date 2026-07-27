/**
 * Core.Toast - 提示消息
 */
(function() {
  'use strict';

  function show(message, type = 'info', duration = 3000) {
    const root = document.getElementById('toastRoot');
    if (!root) {
      console.log(`[Toast:${type}] ${message}`);
      return;
    }

    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = message;
    root.appendChild(el);

    setTimeout(() => {
      el.style.opacity = '0';
      el.style.transition = 'opacity 0.3s';
      setTimeout(() => el.remove(), 300);
    }, duration);
  }

  const success = (msg, dur) => show(msg, 'success', dur);
  const error = (msg, dur) => show(msg, 'error', dur || 4000);
  const info = (msg, dur) => show(msg, 'info', dur);
  const warning = (msg, dur) => show(msg, 'warning', dur);

  window.Core = window.Core || {};
  window.Core.Toast = { show, success, error, info, warning };
})();
