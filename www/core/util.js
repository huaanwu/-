/**
 * Core.Util - 通用工具函数
 * 依赖: 无
 */
(function() {
  'use strict';

  /**
   * HTML 转义(XSS 防护)
   * 所有用户/外部数据进 innerHTML 之前必须走这个
   */
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 安全 HTML(已 escape 后可直接 innerHTML)
   * @param {string} str
   */
  function safeHTML(str) {
    return escapeHtml(str);
  }

  /**
   * 格式化数字: 1234.5 → "1,234.50"
   */
  function fmtNum(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return Number(n).toLocaleString('zh-CN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    });
  }

  /**
   * 格式化百分比: 0.0256 → "+2.56%"
   */
  function fmtPct(p, decimals = 2) {
    if (p === null || p === undefined || isNaN(p)) return '-';
    const v = Number(p) * 100;
    const sign = v >= 0 ? '+' : '';
    return `${sign}${v.toFixed(decimals)}%`;
  }

  /**
   * 格式化金额: 12345 → "¥12,345.00"
   */
  function fmtMoney(n, decimals = 2) {
    if (n === null || n === undefined || isNaN(n)) return '-';
    return '¥' + fmtNum(n, decimals);
  }

  /**
   * 涨跌色 class
   */
  function pctClass(p) {
    if (p === null || p === undefined || isNaN(p)) return 'flat';
    if (p > 0) return 'up';
    if (p < 0) return 'down';
    return 'flat';
  }

  /**
   * A股代码 → 名称(简单映射,后端返回的不需要这个)
   */
  function stockCodePrefix(code) {
    if (!code) return '';
    if (/^(60|68)/.test(code)) return 'sh';
    if (/^(00|30)/.test(code)) return 'sz';
    if (/^(8|43)/.test(code)) return 'bj';
    return '';
  }

  /**
   * 日期格式化
   */
  function fmtDate(d) {
    if (!d) return '';
    const date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return String(d);
    return date.toISOString().slice(0, 10);
  }

  function fmtDateTime(d) {
    if (!d) return '';
    const date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return String(d);
    return date.toISOString().slice(0, 19).replace('T', ' ');
  }

  /**
   * 深拷贝(JSON 安全)
   */
  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * debounce
   */
  function debounce(fn, delay = 300) {
    let t = null;
    return function(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  /**
   * 生成 UUID
   */
  function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  /**
   * 解析股票代码 + 名称(支持 "600519 贵州茅台" / "600519,贵州茅台" / "600519" 三种格式)
   */
  function parseStockInput(text) {
    if (!text) return null;
    text = text.trim();
    // 优先匹配 6 位数字
    const m = text.match(/^(\d{6})/);
    if (m) {
      const code = m[1];
      const rest = text.slice(6).replace(/[\s,，]+/g, '');
      return { code, name: rest || '' };
    }
    return null;
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.Util = {
    escapeHtml, safeHTML, fmtNum, fmtPct, fmtMoney, pctClass,
    stockCodePrefix, fmtDate, fmtDateTime, clone, debounce, uuid,
    parseStockInput
  };
})();
