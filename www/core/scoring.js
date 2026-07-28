/**
 * Core.Scoring - 多因子打分排序 (Tier 6 预筛选核心)
 *
 * 替换 long-trader 旧的"涨跌幅降序"硬筛 — 涨跌幅是动量陷阱,
 * 候选池质量直接决定 LLM pick 的天花板。
 *
 * 设计:
 *   - 5 因子 MVP (本期): ROE 质量 + EP 低估值 + 换手反转 + 北向资金 + 行业中性化
 *   - 权重来源: Core.WeightAdvisor (LLM 周度动态) → fallback 静态 DEFAULT_WEIGHTS
 *   - 归一化: rank (截面百分位) — 抗极端值, 跨批次可比
 *   - 硬过滤: 新股 < 5 日 / ST / 一字板 (NEW_STOCK_RULE_DAYS 等常量)
 *   - 不调 LLM, 纯 JS 计算, 跑全市场 ~5000 只 < 200ms
 *
 * 用法:
 *   const top = await Core.Scoring.rankCandidates({ topN: 30 });
 *   // → [{ 代码, 名称, _score, _factors: {...} }, ...]
 *
 * 数据依赖 (复用 Core.Data 已有 fetcher, 不新增):
 *   - getStockSpot             (行情: 市值/换手率/涨跌幅/最新价)
 *   - getStockFinancialBatch   (财务: ROE/PE/毛利率)
 *   - getStockIndustryBatch    (行业归属)
 *   - getStockNorthFlowBatch   (北向资金, 已 Tier 2 注入)
 */
(function() {
  'use strict';

  // 静态默认权重 (LLM 调不通时 fallback)
  const DEFAULT_WEIGHTS = {
    roe: 0.22,           // ROE/ROIC 质量
    ep: 0.20,            // EP (盈利收益率 = 1/PE)
    turnover: 0.16,      // 换手率反转 (低换手加分)
    north: 0.16,         // 20 日北向净流入
    industryPenalty: 0.26 // 行业集中度惩罚 (已持仓行业扣分)
  };

  // 硬过滤阈值
  const NEW_STOCK_RULE_DAYS = 5;   // 上市 < 5 日: 一字板流动性枯竭, 硬剔除
  const HARD_FILTERS = {
    newStock: true,
    st: true,
    oneWordLimitUp: true  // 一字板 (涨幅 ≥ 9.9% 且 成交额 < 1000 万)
  };

  const ONE_WORD_LIMITUP_THRESHOLD = {
    pctChange: 9.9,
    amountFloor: 1000 * 10000  // 1000 万
  };

  /**
   * 排名函数: 给定一组 stock + 因子数据, 输出排序结果 (内部纯函数, 可单测)
   * @param {Array} stocks - [{代码, 名称, 总市值, 换手率, 涨跌幅, 成交额, ...}]
   * @param {Map} finMap - code → stock_financial_abstract rawData
   * @param {Map} industryMap - code → industryName
   * @param {Map} northMap - code → 20 日北向净流入 (元)
   * @param {Object} heldByInd - {industryName: totalMktValue} 已持仓行业市值
   * @param {Object} weights - 权重表 (来自 WeightAdvisor 或 fallback)
   * @returns {Array} sorted by _score desc
   */
  function rank(stocks, finMap, industryMap, northMap, heldByInd, weights) {
    if (!Array.isArray(stocks) || stocks.length === 0) return [];
    const w = Object.assign({}, DEFAULT_WEIGHTS, weights || {});

    // 计算每只股票每维 raw 值
    const enriched = stocks.map(s => {
      const fe = _extractFundamentals(finMap ? finMap.get(s.代码) : null);
      const industry = industryMap ? industryMap.get(s.代码) : null;
      const north20d = northMap ? (northMap.get(s.代码) || 0) : 0;
      return { s, fe, industry, north20d };
    });

    // 归一化 (rank): 把每维 raw 值映射到 [0, 1] 百分位
    const roeVals = enriched.map(e => e.fe ? (e.fe.roe ?? 0) : null).filter(v => v != null);
    const epVals = enriched.map(e => e.fe ? (e.fe.ep ?? (e.fe.pe ? 1 / e.fe.pe : null)) : null).filter(v => v != null);
    const turnoverVals = enriched.map(e => parseFloat(e.s.换手率 || 0));
    const northVals = enriched.map(e => e.north20d);

    const roeRanks = rankNormalize(roeVals);
    const epRanks = rankNormalize(epVals);
    const turnoverRanks = rankNormalize(turnoverVals, true);  // true = 反转 (低换手加分)
    const northRanks = rankNormalize(northVals);

    // 行业惩罚: 同一行业已有持仓市值占比 → 惩罚分 (0-1, 1 = 完全打掉)
    const totalHeld = Object.values(heldByInd || {}).reduce((s, v) => s + v, 0);
    const indPenalty = (ind) => {
      if (!ind || totalHeld === 0) return 0;
      const cur = heldByInd[ind] || 0;
      return Math.min(1, cur / (totalHeld * 0.25));  // 25% 满 cap
    };

    // 打分
    return enriched
      .map((e, i) => {
        const factors = {
          roe: roeRanks[i] || 0,
          ep: epRanks[i] || 0,
          turnover: turnoverRanks[i] || 0,
          north: northRanks[i] || 0,
          industryPenalty: indPenalty(e.industry)
        };
        const score =
          w.roe * factors.roe +
          w.ep * factors.ep +
          w.turnover * factors.turnover +
          w.north * factors.north -
          w.industryPenalty * factors.industryPenalty;
        return Object.assign({}, e.s, { _score: score, _factors: factors });
      })
      .sort((a, b) => b._score - a._score);
  }

  /**
   * 完整流程: 拉数据 + 过滤 + 打分 + 截断
   * @param {{ topN?: number, includeFiltered?: boolean }} opts
   * @returns {Promise<Array>} topN 个候选 (按 _score desc)
   */
  async function rankCandidates(opts = {}) {
    const topN = opts.topN || 30;
    const includeFiltered = opts.includeFiltered || false;

    // 1. 拉全市场行情
    let all;
    try {
      all = await Core.Data.getStockSpot();
    } catch (e) {
      console.warn('[Scoring] getStockSpot 失败:', e);
      return [];
    }
    if (!Array.isArray(all) || all.length === 0) return [];

    // 2. 拉财务 + 行业 (并发)
    const codes = all.map(s => s.代码);
    let finMap = new Map(), industryMap = new Map(), northMap = new Map();
    try {
      finMap = await Core.Data.getStockFinancialBatch(codes);
    } catch (e) { console.warn('[Scoring] finMap 失败:', e); }
    try {
      industryMap = await Core.Data.getStockIndustryBatch(codes);
    } catch (e) { console.warn('[Scoring] indMap 失败:', e); }
    if (Core.Data.getStockNorthFlowBatch) {
      try {
        northMap = await Core.Data.getStockNorthFlowBatch(codes);
      } catch (e) { console.warn('[Scoring] northMap 失败:', e); }
    }

    // 3. 拉已持仓行业市值
    const heldByInd = opts.heldByInd || await _loadHeldByInd(industryMap);

    // 4. 拉动态权重 (LLM 周度) — 失败 fallback 默认
    let weights = DEFAULT_WEIGHTS;
    if (Core.WeightAdvisor && typeof Core.WeightAdvisor.getWeights === 'function') {
      try {
        weights = await Core.WeightAdvisor.getWeights();
      } catch (e) { console.warn('[Scoring] WeightAdvisor 失败, 用默认:', e); }
    }

    // 5. 硬过滤 + 打分
    const filtered = applyHardFilters(all, opts);
    const ranked = rank(filtered, finMap, industryMap, northMap, heldByInd, weights);

    return includeFiltered ? ranked : ranked.slice(0, topN);
  }

  /**
   * 硬过滤: 新股/ST/一字板
   */
  function applyHardFilters(stocks, opts = {}) {
    const filters = Object.assign({}, HARD_FILTERS, opts.filters || {});
    const today = Date.now();
    return stocks.filter(s => {
      // ST / *ST
      if (filters.st) {
        const name = s.名称 || '';
        if (/ST|\*ST|退市/.test(name)) return false;
      }
      // 新股 (< N 日)
      if (filters.newStock && s.上市日期) {
        const ipoTs = new Date(s.上市日期).getTime();
        if (!isNaN(ipoTs) && (today - ipoTs) / 86400000 < NEW_STOCK_RULE_DAYS) return false;
      }
      // 一字板 (涨幅 ≥ 9.9% 且 成交额 < 1000 万)
      if (filters.oneWordLimitUp) {
        const pct = parseFloat(s.涨跌幅 || 0);
        const amount = parseFloat(s.成交额 || 0);
        if (pct >= ONE_WORD_LIMITUP_THRESHOLD.pctChange && amount < ONE_WORD_LIMITUP_THRESHOLD.amountFloor) return false;
      }
      return true;
    });
  }

  /**
   * 从 Paper 拉已持仓行业市值
   */
  async function _loadHeldByInd(industryMap) {
    const byInd = {};
    try {
      const held = (window.Paper && await Paper._getPaperHoldings('long')) || [];
      for (const h of held) {
        const ind = industryMap.get(h.code);
        if (ind) byInd[ind] = (byInd[ind] || 0) + (h.mkt || 0);
      }
    } catch (e) { /* */ }
    return byInd;
  }

  /**
   * 截面 rank 归一化: 把数组映射到 [0, 1] 百分位
   * @param {Array} arr raw 值
   * @param {boolean} reverse true = 低值加分 (适合换手率反转)
   * @returns {Array<number|null>} 同长度, null 表示无数据
   */
  function rankNormalize(arr, reverse) {
    const indexed = arr.map((v, i) => ({ v, i })).filter(x => x.v != null && !isNaN(x.v));
    indexed.sort((a, b) => reverse ? b.v - a.v : a.v - b.v);  // reverse: 低换手排前
    const ranks = new Array(arr.length).fill(null);
    if (indexed.length === 0) return ranks;
    indexed.forEach((x, rank) => {
      ranks[x.i] = indexed.length > 1 ? rank / (indexed.length - 1) : 0.5;
    });
    return ranks;
  }

  /**
   * 提取财务核心字段 (同 long-trader / stock-advisor)
   */
  function _extractFundamentals(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    const keys = {
      pe: ['市盈率', 'PE', 'pe', 'pe_ttm'],
      pb: ['市净率', 'PB', 'pb'],
      roe: ['净资产收益率', 'ROE', 'roe', '加权平均净资产收益率']
    };
    for (const [k, names] of Object.entries(keys)) {
      for (const n of names) {
        if (raw[n] != null && !isNaN(parseFloat(raw[n]))) {
          out[k] = parseFloat(raw[n]);
          break;
        }
      }
    }
    if (out.pe && out.pe > 0) out.ep = 1 / out.pe;
    return Object.keys(out).length > 0 ? out : null;
  }

  window.Core = window.Core || {};
  window.Core.Scoring = {
    rankCandidates,
    rank,             // 暴露纯函数便于测试
    applyHardFilters,
    DEFAULT_WEIGHTS,
    NEW_STOCK_RULE_DAYS
  };
})();