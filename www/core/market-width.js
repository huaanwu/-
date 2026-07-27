/**
 * Core.MarketWidth - 市场宽度信号 (AI 升级 #1b)
 * 依赖: Core.Data.getStockSpotEfinanceCached (全市场)
 *       Core.Storage (缓存 + kv)
 *
 * 用途: 给 AI prompt 提供"市场宽度"维度, 跟 Kimi 的 Core.Regime (HS300 + MA60 斜率)
 *   互补. Kimi 的 gate 决定仓位/阈值, 我给 AI 一个 cross-check 信号:
 *     - 上涨占比 < 35%  → "弱势确认" (即使 Kimi 说 bull, AI 也应警惕)
 *     - 上涨占比 > 65%  → "强势确认"
 *     - 40-60%          → "中性"
 *
 * 不与 Core.Regime 重复判定市况, 只做宽度信号采集 + AI prompt 渲染.
 *
 * 存储: 缓存 5 分钟 (与 Kimi 的 daily refresh 不同, 我 5 分钟一刷更灵敏).
 *   拉全市场 5000+ 只, 一次 ~2MB JSON, 走 getStockSpotEfinanceCached (内部 60s 缓存).
 */
(function() {
  'use strict';

  const CACHE_KEY = 'market_width_v1';
  const CACHE_TTL = 5 * 60 * 1000;

  /**
   * 纯函数: 拉来的全市场数组 → 宽度信号
   * @param {Array} all - getStockSpotEfinanceCached() 返回
   * @returns {{ advance, decline, flat, total, advancePct, status, partial }}
   */
  function _classifyWidth(all) {
    if (!Array.isArray(all) || all.length < 100) {
      return {
        advance: 0, decline: 0, flat: 0, total: all?.length || 0,
        advancePct: null, status: 'unknown', partial: '全市场数据不足'
      };
    }
    let advance = 0, decline = 0, flat = 0;
    for (const s of all) {
      const pct = s.涨跌幅;
      if (pct == null) flat++;
      else if (pct > 0.01) advance++;
      else if (pct < -0.01) decline++;
      else flat++;
    }
    const total = all.length;
    const advancePct = +(advance / total * 100).toFixed(1);
    let status;
    if (advancePct < 35) status = 'weak';      // 弱势确认
    else if (advancePct > 65) status = 'strong'; // 强势确认
    else status = 'neutral';
    return { advance, decline, flat, total, advancePct, status, partial: '' };
  }

  /**
   * 拉全市场 (5 分钟缓存) → 宽度信号
   */
  async function getMarketWidth() {
    const cached = await Core.Storage.cacheGet(CACHE_KEY);
    if (cached) return cached;
    try {
      const all = await Core.Data.getStockSpotEfinanceCached();
      const sig = _classifyWidth(all);
      const result = { ...sig, ts: new Date().toISOString() };
      try { await Core.Storage.cacheSet(CACHE_KEY, result, CACHE_TTL); } catch (e) { /* 忽略 */ }
      return result;
    } catch (e) {
      console.warn('[MarketWidth] 全市场拉取失败:', e.message || e);
      return {
        advance: 0, decline: 0, flat: 0, total: 0,
        advancePct: null, status: 'unknown', partial: e.message || '拉取失败',
        ts: new Date().toISOString()
      };
    }
  }

  /**
   * 渲染为 AI prompt 友好中文 (给 ai-service.js 注入用)
   * @param {Object} sig - getMarketWidth() 返回
   * @returns {string} 多行中文描述
   */
  function formatWidthForPrompt(sig) {
    if (!sig || sig.status === 'unknown' || sig.advancePct == null) {
      return '⚠ 市场宽度数据缺失 (全市场涨跌家数不可用)';
    }
    const statusCN = {
      weak: '弱势确认 (下跌家数显著多于上涨)',
      neutral: '中性 (涨跌家数较均衡)',
      strong: '强势确认 (上涨家数显著多于下跌)'
    }[sig.status] || sig.status;
    return [
      `- **市场宽度**: ${sig.advance} 涨 / ${sig.decline} 跌 / ${sig.flat} 平 (共 ${sig.total} 只, 上涨占比 ${sig.advancePct}%)`,
      `- **宽度判定**: ${statusCN}`
    ].join('\n');
  }

  window.Core = window.Core || {};
  window.Core.MarketWidth = {
    getMarketWidth,
    formatWidthForPrompt,
    _classifyWidth  // 暴露供测试
  };
})();
