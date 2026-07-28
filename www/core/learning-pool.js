/**
 * Core.LearningPool — 跨调用方共享学习池 (P3)
 *
 * 聚合 ShortTrader / LongTrader / IntradayTrader 已验证交易数据，
 * 按调用方类型输出摘要，注入到所有 AI 决策 prompt。
 *
 * 用法:
 *   const txt = await Core.LearningPool.format({ caller: 'intraday-trader' });
 *   // → 返回短文 "【全系统学习池】已验证 N 笔... 总命中率 X%..."
 *
 * 设计:
 *   - 只聚合机械 verify 过的交易 (verified=true / verifyOutcome 存在)
 *   - 不调 LLM，纯数据汇总
 *   - 样本不足时不渲染（不污染 prompt）
 */
(function() {
  'use strict';

  const MIN_SAMPLES = 3;

  /**
   * 从各个 kv / journal 源拉已验证交易
   * @returns {Promise<Array<{code, action, outcome, probability?, source}>>}
   */
  async function collect() {
    const out = [];
    // 1) ShortTrader: journals sleeve=short + verifyOutcome
    try {
      const journals = (await Core.Storage.all('journals')) || [];
      for (const j of journals) {
        if (j && j.verifyOutcome && (j.sleeve || '') === 'short' && j.auto) {
          out.push({
            code: j.code,
            action: 'short',
            outcome: j.verifyOutcome,
            probability: j.probability || null,
            source: 'short-trader',
            pnl: j.pnlPct || null
          });
        }
      }
    } catch (e) { console.warn('[LearningPool] ShortTrader 收集失败:', e); }

    // 2) LongTrader: journals sleeve=long + verifyOutcome
    try {
      const journals = (await Core.Storage.all('journals')) || [];
      for (const j of journals) {
        if (j && j.verifyOutcome && (j.sleeve || '') === 'long' && j.auto) {
          out.push({
            code: j.code,
            action: 'long',
            outcome: j.verifyOutcome,
            probability: null,
            source: 'long-trader',
            pnl: j.pnlPct || null
          });
        }
      }
    } catch (e) { console.warn('[LearningPool] LongTrader 收集失败:', e); }

    // 3) IntradayTrader: intraday log verified=true
    try {
      const log = (await Core.Storage.kvGet('paper_intraday_log')) || [];
      for (const e of log) {
        if (e && e.verified && e.verifyOutcome) {
          out.push({
            code: e.code,
            action: e.action,
            outcome: e.verifyOutcome,
            probability: e.probability || null,
            source: 'intraday-trader',
            pnl: null
          });
        }
      }
    } catch (e) { console.warn('[LearningPool] IntradayTrader 收集失败:', e); }

    return out;
  }

  /**
   * 格式化成 prompt 注入文本
   * @param {{ caller?: string }} opts - caller 标识（预留过滤）
   * @returns {Promise<string|null>} 样本不足返 null
   */
  async function format(opts = {}) {
    try {
      const all = await collect();
      if (all.length < MIN_SAMPLES) return null;

      const total = all.length;
      const correct = all.filter(t => t.outcome === 'correct').length;
      const partial = all.filter(t => t.outcome === 'partial').length;
      const wrong = all.filter(t => t.outcome === 'wrong').length;
      const hitRate = total ? (correct + partial * 0.5) / total : 0;

      // 按 source 分组
      const bySource = {};
      for (const t of all) {
        const s = t.source || 'unknown';
        if (!bySource[s]) bySource[s] = { total: 0, correct: 0, partial: 0, wrong: 0 };
        bySource[s].total++;
        if (t.outcome === 'correct') bySource[s].correct++;
        else if (t.outcome === 'partial') bySource[s].partial++;
        else if (t.outcome === 'wrong') bySource[s].wrong++;
      }

      const lines = [];
      lines.push(`【全系统学习池】已验证 ${total} 笔交易 | 综合命中率 ${(hitRate * 100).toFixed(0)}% (正确${correct} + 部分${partial} / 总${total})`);
      if (wrong > 0) lines.push(`错误模式: ${wrong} 笔亏损交易 — 全局校准偏${wrong / total > 0.4 ? '高' : '正常'}`);

      // 按源细分
      for (const [src, s] of Object.entries(bySource)) {
        const srcHit = s.total ? (s.correct + s.partial * 0.5) / s.total : 0;
        lines.push(`  ${src}: ${s.total}笔 命中率${(srcHit * 100).toFixed(0)}%`);
      }

      return lines.join('\n');
    } catch (e) {
      console.warn('[LearningPool] format 失败:', e);
      return null;
    }
  }

  window.Core = window.Core || {};
  window.Core.LearningPool = {
    collect,
    format
  };
})();
