/**
 * Core.Cycle — 宏观周期定位 (P2)
 *
 * 职责:
 *   - 拉取宏观数据 (M1-M2/社融/PMI/国债) + 市场宽度 → 5 维信号分
 *   - 从 KB 取 cycle/macro_signal/history_analog 三个分类 (直接 KB.get, 不走 pickRelevant 避免 maxN:4 截断)
 *   - 输出 cyclePosition = {threeStage, confidence, macroScore, kbText}
 *
 * 降级契约 (照搬 Regime 失灵熔断):
 *   - 5 项宏观数据任一失败不整体失败
 *   - 5 项全失败 → stage='unknown' + 只输出 KB 静态定义段, 不输出仓位建议
 *   - prompt 中显式标注「宏观数据不可用, 本次不做周期择时」
 *
 * 暴露:
 *   Core.Cycle.getCyclePosition() → {kitchin, juglar, combined, threeStage, confidence,
 *                                    macroScore, reasoning, kbText, signals, _ok}
 *   Core.Cycle.formatForPrompt(position) → string (LLM 注入)
 *   Core.Cycle.refresh() → 清缓存 (供「刷新」按钮)
 *
 * 加载顺序: 必须在 Core.Macro + Core.KB + Core.MarketWidth + Core.Data 之后
 *   (index.html 已有 macro.js / kb.js / market-width.js / data.js)
 */
(function () {
  'use strict';

  const TTL_24H = 24 * 60 * 60 * 1000;
  const CACHE_KEY = 'cycle_position_v1';
  const STAGE_DEFS = {
    defensive: { name: '战略防御', position: '≤30%', tactics: '高股息/低估值, 不抢反弹' },
    stalemate_bear: { name: '战略相持偏空', position: '30-50%', tactics: '观望为主, 试探建仓' },
    stalemate_bull: { name: '战略相持偏多', position: '50-70%', tactics: '板块轮动, 灵活仓位' },
    offensive: { name: '战略反攻', position: '70-90%', tactics: '重仓趋势股, 让利润奔跑' }
  };

  /**
   * 5 维宏观信号打 ±1 分
   * score ∈ {-5, +5}
   */
  function _scoreSignals(signals) {
    const { m1m2, shrz, pmi, yieldVal, width } = signals;
    let score = 0, n = 0;

    if (typeof m1m2 === 'number') {
      n++;
      score += m1m2 > 0 ? 1 : (m1m2 < -2 ? -1 : 0);
    }
    if (typeof shrz === 'number') {
      n++;
      score += shrz > 12 ? 1 : (shrz < 8 ? -1 : 0);
    }
    if (typeof pmi === 'number') {
      n++;
      score += pmi > 52 ? 1 : (pmi < 48 ? -1 : 0);
    }
    if (typeof yieldVal === 'number') {
      n++;
      score += yieldVal < 2.5 ? 1 : (yieldVal > 3.5 ? -1 : 0);
    }
    if (typeof width === 'number') {
      n++;
      score += width > 70 ? 1 : (width < 30 ? -1 : 0);
    }

    return { score, n };
  }

  function _stageFromScore(score) {
    if (score >= 3) return 'offensive';
    if (score >= 1) return 'stalemate_bull';
    if (score >= -1) return 'stalemate_bear';
    return 'defensive';
  }

  function _confidence(n, ok) {
    if (!ok) return 'none';
    if (n >= 4) return 'high';
    if (n >= 2) return 'medium';
    return 'low';
  }

  /** 拉取 M1-M2 剪刀差 (P0 修复后能正常拿到) */
  async function _signalM1M2() {
    try {
      const data = await Core.Data.fetch('cycle_m2', 'macro_china_money_supply', {}, TTL_24H);
      const r = Core.Data.Normalize.parseMoneySupply(data);
      if (!r || r.m1_yoy === null) return null;
      return { m1m2: +(r.m1_yoy - r.m2_yoy).toFixed(1), date: r.date };
    } catch (e) {
      console.warn('[Cycle] M1-M2 拉取失败:', e.message || e);
      return null;
    }
  }

  /** 社融存量同比 (最新一条, 升序取 [-1]) */
  async function _signalShrz() {
    try {
      const data = await Core.Data.fetch('cycle_shrz', 'macro_china_shrzgm', {}, TTL_24H);
      if (!Array.isArray(data) || data.length === 0) return null;
      // shrzgm 是升序, 末条最新
      const last = data[data.length - 1];
      const v = parseFloat(last['社会融资规模增量']);
      if (isNaN(v)) return null;
      return { shrz: v, date: String(last['月份'] || '') };
    } catch (e) {
      console.warn('[Cycle] 社融拉取失败:', e.message || e);
      return null;
    }
  }

  /** 制造业 PMI */
  async function _signalPmi() {
    try {
      const data = await Core.Data.fetch('cycle_pmi', 'macro_china_pmi_yearly', {}, TTL_24H);
      if (!Array.isArray(data) || data.length === 0) return null;
      // pmi_yearly 降序, 首条最新, 但末尾可能有 null 占位行
      for (const r of data) {
        const v = parseFloat(r['今值']);
        if (!isNaN(v)) return { pmi: v, date: String(r['日期'] || '').slice(0, 10) };
      }
      return null;
    } catch (e) {
      console.warn('[Cycle] PMI 拉取失败:', e.message || e);
      return null;
    }
  }

  /** 十年期国债收益率 (用现有 FDR007 + 1Y Shibor 近似, 避免额外接口) */
  async function _signalYield() {
    try {
      const data = await Core.Data.fetch('cycle_shibor', 'macro_china_shibor_all', {}, TTL_24H);
      if (!Array.isArray(data) || data.length === 0) return null;
      const last = data[0];  // 降序, 首条最新
      const v = parseFloat(last['1Y-定价']);
      if (isNaN(v)) return null;
      // Shibor 1Y 与十年期国债同向, 绝对值差 ~0.5-1pct, 这里用 1Y 代理
      return { yieldVal: v, date: String(last['日期'] || '').slice(0, 10), _proxy: 'Shibor 1Y 代理' };
    } catch (e) {
      console.warn('[Cycle] 国债收益率拉取失败:', e.message || e);
      return null;
    }
  }

  /** 市场宽度 (已有 Core.MarketWidth, 同步) */
  async function _signalWidth() {
    try {
      if (!Core.MarketWidth || typeof Core.MarketWidth.get !== 'function') return null;
      const data = await Core.MarketWidth.get();
      if (!data || typeof data.breadth !== 'number') return null;
      return { width: data.breadth };
    } catch (e) {
      console.warn('[Cycle] MarketWidth 拉取失败:', e.message || e);
      return null;
    }
  }

  /**
   * 主入口: 拉 5 维宏观信号 + KB 文本 → 输出 cyclePosition
   * @returns {Promise<{
   *   threeStage: 'defensive'|'stalemate_bear'|'stalemate_bull'|'offensive'|'unknown',
   *   confidence: 'none'|'low'|'medium'|'high',
   *   macroScore: number,
   *   signals: object,
   *   reasoning: string,
   *   kbText: string,
   *   _ok: boolean
   * }>}
   */
  async function getCyclePosition() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase') || 'default'}`;
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    const [r1, r2, r3, r4, r5] = await Promise.all([
      _signalM1M2(), _signalShrz(), _signalPmi(), _signalYield(), _signalWidth()
    ]);

    const signals = {
      m1m2: r1?.m1m2,
      shrz: r2?.shrz,
      pmi: r3?.pmi,
      yieldVal: r4?.yieldVal,
      width: r5?.width
    };
    const dates = {
      m1m2: r1?.date, shrz: r2?.date, pmi: r3?.date, yield: r4?.date
    };

    const { score, n } = _scoreSignals(signals);
    const ok = n > 0;
    const stage = ok ? _stageFromScore(score) : 'unknown';
    const confidence = _confidence(n, ok);

    // KB 文本 (直接取 3 类, 绕过 pickRelevant 截断)
    const kbs = await Core.KB.get();
    const cycleKb = (kbs || []).filter(e => e.category === 'cycle');
    const macroKb = (kbs || []).filter(e => e.category === 'macro_signal');
    const hisKb = (kbs || []).filter(e => e.category === 'history_analog');
    const kbText = [
      '### 周期定位知识库',
      ...cycleKb.map(e => `#### ${e.id} ${e.title}\n${e.summary}`),
      '### 宏观信号解读',
      ...macroKb.map(e => `#### ${e.id} ${e.title}\n${e.summary}`),
      '### 历史剧本',
      ...hisKb.map(e => `#### ${e.id} ${e.title}\n${e.summary}`)
    ].join('\n\n');

    const stageDef = STAGE_DEFS[stage];
    const reasoning = ok
      ? `5 维宏观信号 (${n} 项可用) 总分 = ${score} → ${stageDef ? stageDef.name : '未知'}`
      : '宏观数据全部不可用, 不做周期择时, 仅供 KB 静态定义参考';

    const result = {
      threeStage: stage,
      confidence,
      macroScore: score,
      signals,
      dates,
      reasoning,
      kbText,
      _ok: ok,
      _generatedAt: Date.now()
    };

    await Core.Storage.cacheSet(cacheKey, result, TTL_24H);
    return result;
  }

  /** 把 position 格式化为 prompt 友好的中文文本 */
  function formatForPrompt(position) {
    if (!position) return '';
    const lines = [];
    lines.push('## 宏观周期定位 (生成于 ' + new Date(position._generatedAt || Date.now()).toISOString().slice(0, 16).replace('T', ' ') + ')');
    if (position.threeStage === 'unknown') {
      lines.push('⚠️ **宏观数据全部不可用, 本次不做周期择时** (按 KB 静态定义执行)');
    } else {
      const def = STAGE_DEFS[position.threeStage];
      lines.push(`- **当前阶段**: ${def.name}`);
      lines.push(`- **建议仓位**: ${def.position}`);
      lines.push(`- **战术要点**: ${def.tactics}`);
      lines.push(`- **置信度**: ${position.confidence} (5 维中可用 ${Object.values(position.signals).filter(v => typeof v === 'number').length} 项, 分数 ${position.macroScore > 0 ? '+' : ''}${position.macroScore})`);
      const sigLines = [];
      if (typeof position.signals.m1m2 === 'number') sigLines.push(`M1-M2 剪刀差 = ${position.signals.m1m2} pct (${position.dates.m1m2 || '?'})`);
      if (typeof position.signals.shrz === 'number') sigLines.push(`社融增量 = ${position.signals.shrz} 亿 (${position.dates.shrz || '?'})`);
      if (typeof position.signals.pmi === 'number') sigLines.push(`PMI = ${position.signals.pmi} (${position.dates.pmi || '?'})`);
      if (typeof position.signals.yieldVal === 'number') sigLines.push(`Shibor 1Y = ${position.signals.yieldVal}% (${position.dates.yield || '?'})`);
      if (typeof position.signals.width === 'number') sigLines.push(`市场宽度 = ${position.signals.width}%`);
      if (sigLines.length) lines.push('- **信号明细**: ' + sigLines.join(' | '));
    }
    lines.push('');
    lines.push(position.kbText || '');
    return lines.join('\n');
  }

  /** 手动刷新 (供「刷新宏观」按钮) */
  async function refresh() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase') || 'default'}`;
    await Core.Storage.cacheSet(cacheKey, null, 1);
  }

  window.Core = window.Core || {};
  window.Core.Cycle = {
    STAGE_DEFS,
    getCyclePosition,
    formatForPrompt,
    refresh,
    _scoreSignals,
    _stageFromScore
  };
})();