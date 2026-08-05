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
    // 本地时区 (避免 UTC 跨日错判: 中国 08:00 前 toISOString 会返前一天)
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function fmtDateTime(d) {
    if (!d) return '';
    const date = (d instanceof Date) ? d : new Date(d);
    if (isNaN(date.getTime())) return String(d);
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    const ss = String(date.getSeconds()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm}:${ss}`;
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
    stockCodePrefix, fmtDate, fmtDateTime, uuid,
    parseStockInput,
    renderWithSources
  };

  /**
   * renderWithSources (Phase P) - 把 AI 输出里的"数据源标记"渲染为可点击 chip
   * 识别模式:
   *   - KB-XXX-NNN  → 知识库条目 (例 KB-VAL-001, KB-POS-003)
   *   - data.<key> §N  → 数据源段落 (例 data.context §3, data.intl §1)
   * 其余文本经 escapeHtml 转义防 XSS
   * @param {string} text - AI 原始输出
   * @returns {string} safe HTML
   */
  function renderWithSources(text) {
    if (!text || typeof text !== 'string') return '';
    // 先按行 split, 行内先 escape 再替换
    const lines = text.split('\n');
    const kbRe = /\bKB-[A-Z]{2,5}-\d{3}\b/g;
    const dataRe = /\bdata\.[a-zA-Z_]+(?:\s*§\d+)?\b/g;
    const parts = lines.map(line => {
      let safe = escapeHtml(line);
      // 把 KB 编号包成 chip
      safe = safe.replace(kbRe, m => `<span class="src-chip" data-src="${m}" title="知识库条目 ${m}">📎 ${m}</span>`);
      // 把 data.* 包成 chip
      safe = safe.replace(dataRe, m => `<span class="src-chip" data-src="${m}" title="数据源 ${m}">📊 ${m}</span>`);
      return safe;
    });
    return parts.join('<br>');
  }
})();
