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
  const FACTOR_KEYS = ['roe', 'ep', 'hot', 'turnover', 'north', 'industryPenalty', 'forecast', 'rps'];
  const DEFAULT_WEIGHTS = {
    roe: 0.16,           // ROE/ROIC 质量
    ep: 0.14,            // EP (盈利收益率)
    hot: 0.12,           // 板块动量 (热点因子, Tier 6+)
    turnover: 0.12,      // 换手率反转
    north: 0.12,         // 20 日北向净流入
    industryPenalty: 0.14, // 行业集中度惩罚
    forecast: 0.10,      // V2 P2: 业绩预告 (利润断层/拐点信号)
    rps: 0.10            // V2 P4: RPS 快照 (60 日涨幅 vs 中位数, 选强势股)
  };

  // 板块涨幅 → 热度分 (反向打分 — A 股热点大多是接盘陷阱)
  //   长线 sleeve 应该避开主升浪追高, 等情绪降温后再进
  //   涨幅越大 → 负权重越大 (追涨陷阱)
  //   < -5%  → +0.10  错杀 (基本面好但被错杀, 可能是机会)
  //   -5~0%  → +0.05  情绪低点
  //   0~3%   → +0.10  平稳期 (主力建仓期)
  //   3~5%   → -0.05  萌芽末期 (即将调整)
  //   5~10%  → -0.15  主升浪 (接盘区, 必须避开)
  //   > 10%  → -0.25  顶部区 (强接盘陷阱)
  // Tier 6+: 同时看 行业(industryPct) + 概念(conceptPcts[]), 取较低者
  //   (取较低者 = 只要任一维度进入接盘区就给负分, 更保守)
  function _hotScore(industryPct, conceptPcts) {
    // 缺数据 → 中性 0 (修复: 之前 parseFloat(undefined || 0) = 0 → _hotOne(0) = +0.10 偏向稀疏数据)
    let ind = 0;
    if (industryPct != null && !isNaN(parseFloat(industryPct))) {
      ind = _hotOne(parseFloat(industryPct));
    }
    let cptMin = 0;  // 初始化 = 0 (无概念数据时不影响)
    if (Array.isArray(conceptPcts) && conceptPcts.length > 0) {
      cptMin = Infinity;
      let anyValid = false;
      for (const cp of conceptPcts) {
        if (cp == null || isNaN(parseFloat(cp))) continue;
        const s = _hotOne(parseFloat(cp));
        anyValid = true;
        if (s < cptMin) cptMin = s;
      }
      if (!anyValid) cptMin = 0;  // 数组但全无效 → 中性
    }
    return Math.min(ind, cptMin);
  }

  function _hotOne(p) {
    if (p < -5) return 0.10;
    if (p < 0) return 0.05;
    if (p < 3) return 0.10;
    if (p < 5) return -0.05;
    if (p < 10) return -0.15;
    return -0.25;
  }

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
  function rank(stocks, finMap, industryMap, northMap, heldByInd, weights, conceptMap, conceptPerf, sectorPerf, forecastMap, rpsMap) {
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
    // 关键: 无数据股票保留为 null (避免 ?? 0 污染排名), rankNormalize 会跳过 null
    const roeVals = enriched.map(e => e.fe ? (e.fe.roe ?? null) : null);
    const epVals = enriched.map(e => e.fe ? (e.fe.ep ?? (e.fe.pe ? 1 / e.fe.pe : null)) : null);
    const turnoverVals = enriched.map(e => parseFloat(e.s.换手率 || 0));
    const northVals = enriched.map(e => e.north20d);

    const roeRanks = rankNormalize(roeVals);
    const epRanks = rankNormalize(epVals);
    const turnoverRanks = rankNormalize(turnoverVals, true);
    const northRanks = rankNormalize(northVals);

    // V2 P2: 业绩预告百分位 (高预增 = 高分, 预亏 = 0)
    // 关键: 单次循环同时计算 forecastVal (用作 null 排除) + forecastRanks (并行), 不再用 indexOf 反查
    const forecastPerStock = enriched.map(e => {
      const f = forecastMap ? forecastMap.get(e.s.代码) : null;
      if (!f || f.pct == null) return null;
      if (/亏|不确定|减亏|续亏/.test(f.type || '')) return null;
      return f.pct;
    });
    const forecastForRank = forecastPerStock.filter(v => v != null);
    const forecastRanks = rankNormalize(forecastForRank);
    const forecastFullRanks = forecastPerStock.map(v => {
      if (v == null) return 0;
      const idx = forecastForRank.indexOf(v);
      return idx >= 0 ? (forecastRanks[idx] || 0) : 0;
    });

    // V2 P4: RPS 百分位 (rpsMap 直接给 rank 0-100, 归一化到 0-1)
    const rpsFullRanks = enriched.map(e => {
      const r = rpsMap ? rpsMap.get(e.s.代码) : null;
      if (!r || r.rank == null) return 0;
      return r.rank / 100;
    });

    // 行业板块涨幅 → Map (industryName → pctChange)
    const sectorMap = new Map();
    if (Array.isArray(sectorPerf)) {
      for (const sec of sectorPerf) {
        if (sec && sec.name) sectorMap.set(sec.name, parseFloat(sec.pctChange || 0));
      }
    }
    // 概念板块涨幅 → Map (conceptName → pctChange)
    const conceptBoardMap = new Map();
    if (Array.isArray(conceptPerf)) {
      for (const c of conceptPerf) {
        if (c && c.name) conceptBoardMap.set(c.name, parseFloat(c.pctChange || 0));
      }
    }
    // code → 该股所属概念板块名数组 (Tier 6+ 概念反查)
    const conceptNameMap = conceptMap instanceof Map ? conceptMap : new Map();
    const hotRanks = enriched.map(e => {
      const industryPct = sectorMap.get(e.industry);
      const conceptNames = conceptNameMap.get(e.s.代码) || [];
      const conceptPcts = conceptNames.map(n => conceptBoardMap.get(n) || 0);
      return _hotScore(industryPct, conceptPcts);
    });

    // 行业惩罚
    const totalHeld = Object.values(heldByInd || {}).reduce((s, v) => s + v, 0);
    const indPenalty = (ind) => {
      if (!ind || totalHeld === 0) return 0;
      const cur = heldByInd[ind] || 0;
      return Math.min(1, cur / (totalHeld * 0.25));
    };

    // 打分 (8 因子)
    return enriched
      .map((e, i) => {
        const factors = {
          roe: roeRanks[i] || 0,
          ep: epRanks[i] || 0,
          hot: hotRanks[i] || 0,
          turnover: turnoverRanks[i] || 0,
          north: northRanks[i] || 0,
          industryPenalty: indPenalty(e.industry),
          forecast: forecastFullRanks[i] || 0,
          rps: rpsFullRanks[i] || 0
        };
        const score =
          w.roe * factors.roe +
          w.ep * factors.ep +
          w.hot * factors.hot +
          w.turnover * factors.turnover +
          w.north * factors.north -
          w.industryPenalty * factors.industryPenalty +
          w.forecast * factors.forecast +
          w.rps * factors.rps;
        // V4: 把原始 _fe (ROE/PE/PB/毛利率) + industryName 一并挂上,
        //     下游 long-trader 不必再二次 getStockFinancialBatch / getStockIndustryBatch
        return Object.assign({}, e.s, {
          _score: score,
          _factors: factors,
          _fe: e.fe,
          _industry: e.industry
        });
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

    // 3.5 拉板块涨幅 (Tier 6+ hot theme), 15min 缓存, 失败降级 0 分
    let sectorPerf = [];
    if (Core.Data.getSectorPerformance) {
      try {
        sectorPerf = await Core.Data.getSectorPerformance();
      } catch (e) { console.warn('[Scoring] 板块涨幅拉取失败:', e); }
    }

    // 3.6 拉概念板块涨幅 + 建 code → [概念名...] 反向索引 (Tier 6+ 概念热点)
    let conceptPerf = [];
    let conceptMap = new Map();
    if (Core.Data.getConceptBoardPerformance && Core.Data.getConceptMembership) {
      try {
        conceptPerf = await Core.Data.getConceptBoardPerformance();
      } catch (e) { console.warn('[Scoring] 概念板块涨幅拉取失败:', e); }
    }

    // 4. 拉动态权重 (LLM 周度) — 失败 fallback 默认
    let weights = DEFAULT_WEIGHTS;
    if (Core.WeightAdvisor && typeof Core.WeightAdvisor.getWeights === 'function') {
      try {
        weights = await Core.WeightAdvisor.getWeights();
      } catch (e) { console.warn('[Scoring] WeightAdvisor 失败, 用默认:', e); }
    }

    // V2 P2: 拉业绩预告 (季度 batch, 7d TTL, 失败降级)
    // 注意: stock_yjyg_em 不支持单股, 必须按季度 batch 拉整期 (5500 行), 没法限定候选集
    let forecastMap = new Map();
    if (Core.Data.getStockEarningForecastBatch) {
      try {
        forecastMap = await Core.Data.getStockEarningForecastBatch(codes);
      } catch (e) { console.warn('[Scoring] 业绩预告拉取失败:', e); }
    }

    // V2 P4: RPS 快照 (60 日涨幅 vs 中位数, 24h TTL, 失败降级)
    // RPS 是全市场单端点, 没法限定候选集; 走 24h 缓存
    let rpsMap = new Map();
    if (Core.Data.getRpsSnapshot) {
      try {
        rpsMap = await Core.Data.getRpsSnapshot({ days: 60 });
      } catch (e) { console.warn('[Scoring] RPS 快照拉取失败:', e); }
    }

    // 5. 硬过滤 + 打分
    const filtered = applyHardFilters(all, opts, forecastMap);
    const ranked = rank(filtered, finMap, industryMap, northMap, heldByInd, weights, conceptMap, conceptPerf, sectorPerf, forecastMap, rpsMap);

    // V2 P3 / V2+concept: chokepoint + 概念板块只对 top 候选调, 避免全市场 IO
    // 性能修复: zygc 单股接口 5 并发, 全市场 5500 只 ≈ 220s (阻塞); concept 10 并发全市场 ≈ 5500 个 leaderStock refetch
    // 改为: rank 后取 topN*2 候选, 再调这两个 fetcher
    const candidateTopN = ranked.slice(0, Math.min(ranked.length, topN * 2));
    const candidateCodes = candidateTopN.map(s => s.代码).filter(Boolean);

    let zygcMap = new Map();
    if (Core.Data.getStockBusinessCompositionBatch && candidateCodes.length > 0) {
      try {
        zygcMap = await Core.Data.getStockBusinessCompositionBatch(candidateCodes);
      } catch (e) { console.warn('[Scoring] 主营构成拉取失败:', e); }
    }

    if (Core.Data.getConceptMembership && candidateCodes.length > 0) {
      try {
        const chunkSize = 10;
        for (let i = 0; i < candidateCodes.length; i += chunkSize) {
          const chunk = candidateCodes.slice(i, i + chunkSize);
          const results = await Promise.all(
            chunk.map(c => Core.Data.getConceptMembership(c).catch(() => []))
          );
          chunk.forEach((c, idx) => {
            const names = results[idx] || [];
            if (names.length > 0) conceptMap.set(c, names);
          });
        }
      } catch (e) { console.warn('[Scoring] 概念 membership 拉取失败:', e); }
    }

    // 用 topN 候选的 chokepoint / concept 信息重新打分 (前次 hot 用了空 conceptMap 是中性)
    const finalRanked = rank(candidateTopN, finMap, industryMap, northMap, heldByInd, weights, conceptMap, conceptPerf, sectorPerf, forecastMap, rpsMap);

    // V2 P3: 把 chokepoint 标签附加到最终 ranked 候选上 (供 long-trader LLM 决策)
    if (zygcMap && zygcMap.size > 0) {
      for (const r of finalRanked) {
        const z = zygcMap.get(r.代码);
        if (z) {
          r._chokepoint = z.chokepoint;
          r._topProduct = z.topProduct;
          r._topProductPct = z.topProductPct;
        }
      }
    }

    // V2 P4: 把 RPS 信息附加到最终 ranked 候选上
    if (rpsMap && rpsMap.size > 0) {
      for (const r of finalRanked) {
        const rs = rpsMap.get(r.代码);
        if (rs) r._rps = rs;
      }
    }

    return includeFiltered ? finalRanked : finalRanked.slice(0, topN);
  }

  /**
   * 硬过滤: 新股/ST/一字板
   * V2 P2: + 业绩预告"首亏/续亏"硬剔除
   * V4:   + 基本面 ROE/毛利率门槛 (从 long-trader 抽出, 避免重复拉 finMap)
   *
   * 调用方须保证 stocks 已被 rankCandidates 富化过 (带 _fe/_industry 字段) —
   * 直接调用 applyHardFilters 时若 _fe 缺失, ROE/毛利率门槛会静默跳过 (降级)
   */
  const FUNDAMENTAL_FILTERS = {
    roeMin: 5,           // ROE < 5% 视为低质量盈利
    grossMarginMin: 10   // 毛利率 < 10% 视为无定价能力
  };

  function applyHardFilters(stocks, opts = {}, forecastMap) {
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
      // V2 P2: 业绩预告首亏/续亏 → 硬剔除
      if (forecastMap && forecastMap instanceof Map) {
        const f = forecastMap.get(s.代码);
        if (f && /首亏|续亏/.test(f.type || '')) return false;
      }
      // V4: 基本面 ROE/毛利率门槛 — rankCandidates 内已附 _fe (原始 _extractFundamentals 结果)
      if (s._fe) {
        if (s._fe.roe != null && s._fe.roe < FUNDAMENTAL_FILTERS.roeMin) return false;
        if (s._fe.grossProfitMargin != null && s._fe.grossProfitMargin < FUNDAMENTAL_FILTERS.grossMarginMin) return false;
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
    } catch (e) { console.warn('[Scoring] 拉已持仓行业失败, 跳过行业集中度:', e); }
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
    // V5 修复: 补 毛利率 字段 (applyHardFilters + reviewHoldings 都靠 fe.grossProfitMargin 判断)
    // 之前 _extractFundamentals 只读 pe/pb/roe, 导致毛利率门槛静默不生效 (s._fe 存在但 grossProfitMargin=undefined)
    const keys = {
      pe: ['市盈率', 'PE', 'pe', 'pe_ttm'],
      pb: ['市净率', 'PB', 'pb'],
      roe: ['净资产收益率', 'ROE', 'roe', '加权平均净资产收益率'],
      grossProfitMargin: ['毛利率', '销售毛利率', 'grossProfitMargin', 'gp_margin']
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
    FACTOR_KEYS,      // 单点 source-of-truth, 供 weight-advisor / test 引用
    NEW_STOCK_RULE_DAYS
  };
})();