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

  // V6: 记录最近一次 rankCandidates 的 fetch 失败, 供 long-trader 等调用方提示用户
  //   模块级 var 避免每次改签名; 调用方用 Core.Scoring.getLastDegraded() 读
  let _lastDegraded = [];

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
   * @param {{ topN?: number, includeFiltered?: boolean, skipPrefilter?: boolean }} opts
   *   - skipPrefilter: 测试/调用方确认数据已预筛过, 跳过第一层
   * @returns {Promise<Array>} topN 个候选 (按 _score desc)
   */
  async function rankCandidates(opts = {}) {
    const topN = opts.topN || 30;
    const includeFiltered = opts.includeFiltered || false;
    const skipPrefilter = opts.skipPrefilter || false;
    _lastDegraded = [];  // V6: 重置, 重新记录本轮的 fetch 失败

    // 1. 拉全市场行情
    let all;
    try {
      all = await Core.Data.getStockSpot();
    } catch (e) {
      console.warn('[Scoring] getStockSpot 失败:', e);
      return [];
    }
    if (!Array.isArray(all) || all.length === 0) return [];

    // 1.5 第一层硬筛: 5000 → ~2000 (中庸阈值, 0 IO)
    //    避免对烂股拉基本面/行业/北向这些重 IO batch (单只 batch 200ms × 5000 = 1000s)
    let prefilted;
    if (skipPrefilter) {
      prefilted = all;
    } else {
      const r = prefilter(all, opts.prefilter);
      prefilted = r.passed;
      console.log(`[Scoring] rankCandidates 预筛: ${all.length} → ${prefilted.length} (砍 ${r.dropped.length})`);
    }
    if (prefilted.length === 0) return [];

    // 2. 拉财务 + 行业 (并发) — 只对预筛后的 ~2000 只拉
    const codes = prefilted.map(s => s.代码);
    let finMap = new Map(), industryMap = new Map(), northMap = new Map();
    try {
      finMap = await Core.Data.getStockFinancialBatch(codes);
    } catch (e) { _lastDegraded.push('finMap'); console.warn('[Scoring] finMap 失败:', e); }
    try {
      industryMap = await Core.Data.getStockIndustryBatch(codes);
    } catch (e) { _lastDegraded.push('industryMap'); console.warn('[Scoring] indMap 失败:', e); }
    if (Core.Data.getStockNorthFlowBatch) {
      try {
        northMap = await Core.Data.getStockNorthFlowBatch(codes);
      } catch (e) { _lastDegraded.push('northMap'); console.warn('[Scoring] northMap 失败:', e); }
    }

    // 3. 拉已持仓行业市值
    const heldByInd = opts.heldByInd || await _loadHeldByInd(industryMap);

    // 3.5 拉板块涨幅 (Tier 6+ hot theme), 15min 缓存, 失败降级 0 分
    let sectorPerf = [];
    if (Core.Data.getSectorPerformance) {
      try {
        sectorPerf = await Core.Data.getSectorPerformance();
      } catch (e) { _lastDegraded.push('sectorPerf'); console.warn('[Scoring] 板块涨幅拉取失败:', e); }
    }

    // 3.6 拉概念板块涨幅 + 建 code → [概念名...] 反向索引 (Tier 6+ 概念热点)
    let conceptPerf = [];
    let conceptMap = new Map();
    if (Core.Data.getConceptBoardPerformance && Core.Data.getConceptMembership) {
      try {
        conceptPerf = await Core.Data.getConceptBoardPerformance();
      } catch (e) { _lastDegraded.push('conceptPerf'); console.warn('[Scoring] 概念板块涨幅拉取失败:', e); }
    }

    // 4. 拉动态权重 (LLM 周度) — 失败 fallback 默认
    let weights = DEFAULT_WEIGHTS;
    if (Core.WeightAdvisor && typeof Core.WeightAdvisor.getWeights === 'function') {
      try {
        weights = await Core.WeightAdvisor.getWeights();
      } catch (e) { _lastDegraded.push('weightAdvisor'); console.warn('[Scoring] WeightAdvisor 失败, 用默认:', e); }
    }

    // V2 P2: 拉业绩预告 (季度 batch, 7d TTL, 失败降级)
    // 注意: stock_yjyg_em 不支持单股, 必须按季度 batch 拉整期 (5500 行), 没法限定候选集
    let forecastMap = new Map();
    if (Core.Data.getStockEarningForecastBatch) {
      try {
        forecastMap = await Core.Data.getStockEarningForecastBatch(codes);
      } catch (e) { _lastDegraded.push('forecast'); console.warn('[Scoring] 业绩预告拉取失败:', e); }
    }

    // V2 P4: RPS 快照 (60 日涨幅 vs 中位数, 24h TTL, 失败降级)
    // RPS 是全市场单端点, 没法限定候选集; 走 24h 缓存
    let rpsMap = new Map();
    if (Core.Data.getRpsSnapshot) {
      try {
        rpsMap = await Core.Data.getRpsSnapshot({ days: 60 });
      } catch (e) { _lastDegraded.push('rps'); console.warn('[Scoring] RPS 快照拉取失败:', e); }
    }

    // 5. 硬过滤 + 打分
    const filtered = applyHardFilters(prefilted, opts, forecastMap);
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

  // ============ 后台预热: app init 时异步拉基本面 + 业绩预告, 用户点 AI 选股时秒开 ============
  /**
   * warmupFinMap: 启动期后台预热, 让"基本面 batch"在用户主动跑评分时已经准备好 (7d 缓存命中)
   *
   * 流程:
   *   1) getStockSpot 拿全市场 (60s 缓存, 已有就直接读)
   *   2) prefilter 砍到 ~2000 只
   *   3) 后台异步拉 getStockFinancialBatch(2000) — 第一次 ~60s, 之后 0s
   *   4) 并行拉 getStockEarningForecastBatch(2000) — 单端点批量
   *
   * 设计原则:
   *   - 不阻塞 init (Promise 不 await, 只 fire-and-forget)
   *   - 失败不抛, 只 console.warn, 跑不出来用户用评分时自然降级
   *   - 多次调用幂等: in-flight Promise 复用, 不会并发拉 N 次
   *   - ensureFinMap(opts) 公开给 long-trader, 让评分前等 0-3s (用户感知不到) 拿到更好的数据
   */
  let _warmupPromise = null;       // in-flight 复用
  let _warmupStatus = 'idle';      // 'idle' | 'running' | 'done' | 'failed'
  let _warmupAt = 0;               // 上次完成时间戳
  const _WARMUP_TTL_MS = 30 * 60 * 1000;  // 30 分钟内不重复预热
  let _warmupPrefilteredCodes = null;       // 最近一次预热后保留下来的 codes (ensureFinMap 用)

  function getWarmupStatus() {
    return {
      status: _warmupStatus,
      at: _warmupAt,
      codeCount: _warmupPrefilteredCodes ? _warmupPrefilteredCodes.length : 0
    };
  }

  async function warmupFinMap(opts = {}) {
    // 1) 幂等: 30 分钟内已成功完成过 → 直接返
    if (_warmupStatus === 'done' && Date.now() - _warmupAt < _WARMUP_TTL_MS) {
      return { skipped: true, reason: 'recently_warmed', at: _warmupAt };
    }
    // 2) 幂等: in-flight → 复用同一个 Promise
    if (_warmupPromise) return _warmupPromise;

    _warmupStatus = 'running';
    _warmupPromise = (async () => {
      try {
        // 1. 拉全市场 (60s cache, 已有秒回)
        const all = await Core.Data.getStockSpot();
        if (!Array.isArray(all) || all.length === 0) {
          throw new Error('getStockSpot 返回空');
        }
        // 2. 硬筛 5000 → 2000
        const { passed, dropped } = prefilter(all, opts);
        const codes = passed.map(s => s.代码).filter(Boolean);
        _warmupPrefilteredCodes = codes;
        console.log(`[Scoring] warmup 预筛: ${all.length} → ${codes.length} (砍 ${dropped.length}, 占比 ${(dropped.length / all.length * 100).toFixed(1)}%)`);
        if (codes.length === 0) {
          throw new Error('预筛后 0 只, 不拉基本面');
        }
        // 3. 后台拉基本面 + 业绩预告 (fire-and-forget, 不 await 阻断 init)
        //    这两个 batch 内部本身有 cache, 第一次跑耗时, 之后秒开
        const t0 = Date.now();
        try {
          await Core.Data.getStockFinancialBatch(codes);
          console.log(`[Scoring] warmup finMap ${codes.length} 只, 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        } catch (e) {
          console.warn('[Scoring] warmup finMap 失败 (不致命, 用户跑时降级):', e.message);
        }
        try {
          if (Core.Data.getStockEarningForecastBatch) {
            await Core.Data.getStockEarningForecastBatch(codes);
          }
        } catch (e) {
          console.warn('[Scoring] warmup forecast 失败 (不致命):', e.message);
        }
        _warmupStatus = 'done';
        _warmupAt = Date.now();
        return { skipped: false, prefiltedCount: codes.length, ms: Date.now() - t0 };
      } catch (e) {
        _warmupStatus = 'failed';
        console.warn('[Scoring] warmup 整体失败 (不致命, 用户跑时自然降级):', e.message);
        throw e;
      } finally {
        _warmupPromise = null;  // 释放 in-flight, 允许重试
      }
    })();
    return _warmupPromise;
  }

  /**
   * ensureFinMap: 给 long-trader / screener 在评分前用
   *   - 如果 warmup 在跑 → 等它完成 (最多 3s, 超时不等)
   *   - 如果 warmup 30 分钟内已完成 → 直接返 (秒开)
   *   - 如果 warmup 失败/没跑过 → 启动一次 + 立刻返 (不等)
   * @returns {Promise<{ready: boolean, source: 'warmed'|'fresh'|'timeout'|'failed'}>}
   */
  async function ensureFinMap(opts = {}) {
    const WAIT_MS = 3000;
    // 1) 已完成且新鲜
    if (_warmupStatus === 'done' && Date.now() - _warmupAt < _WARMUP_TTL_MS) {
      return { ready: true, source: 'warmed' };
    }
    // 2) in-flight → 等最多 3s
    if (_warmupPromise) {
      const t0 = Date.now();
      try {
        await Promise.race([
          _warmupPromise,
          new Promise(resolve => setTimeout(resolve, WAIT_MS))
        ]);
        if (_warmupStatus === 'done') {
          return { ready: true, source: 'warmed', waitedMs: Date.now() - t0 };
        }
        return { ready: false, source: 'timeout', waitedMs: Date.now() - t0 };
      } catch (_) {
        return { ready: false, source: 'failed' };
      }
    }
    // 3) 没启动过 → fire and don't wait
    warmupFinMap(opts).catch(() => {});  // 失败不抛
    return { ready: false, source: 'fresh' };
  }

  /**
   * 初选硬筛: 5000 全市场 → ~2000 (中庸阈值, 0 网络 IO, < 10ms)
   *
   * 用行情基础字段 (现价/总市值/换手率/涨跌幅/成交额/名称/市净率) 砍掉明显的烂股,
   * 把下游 Scoring 精细评分 + long-trader / screener LLM 解读 的输入缩小到可控规模。
   *
   * 跟 applyHardFilters 的区别:
   *   - applyHardFilters: 在已富化的 stocks 上做"硬过滤", 依赖 _fe / forecastMap,
   *     跑在 Scoring.rank 之后, 用于"低质但过了硬筛的再砍一次"
   *   - prefilter: 跑在 getStockSpot 之后立刻做, 0 依赖, 5000 → 2000 立刻砍掉,
   *     避免对烂股拉基本面/行业/北向这些重 IO fetcher
   *
   * 阈值从 Constants.PREFILTER_DEFAULTS 拿, 调用方可覆盖 opts
   *
   * @param {Array} all - getStockSpot() 返回的 stocks
   * @param {Object} [opts] - 覆盖默认阈值 { minMktCap?, minTurnover?, ... }
   * @returns {{ passed: Array, dropped: Array }}
   *   - passed: 通过硬筛的 (~2000)
   *   - dropped: 被砍的 + 原因 [{ code, name, reason }]
   */
  function prefilter(all, opts = {}) {
    if (!Array.isArray(all) || all.length === 0) {
      return { passed: [], dropped: [] };
    }
    // 合并默认阈值 + 调用方覆盖
    const defaults = (window.Core && Core.Constants && Core.Constants.PREFILTER_DEFAULTS) || {
      minMktCap: 20e8, minTurnover: 0.5, excludeSt: true, excludeOneWord: true,
      excludeSuspended: true, excludePbZero: true, pctChangeLimit: 9.5,
      oneWordPctChange: 9.9, oneWordAmountFloor: 1000 * 10000
    };
    const cfg = Object.assign({}, defaults, opts || {});

    const passed = [];
    const dropped = [];
    for (const s of all) {
      if (!s || !s.代码) { dropped.push({ code: '?', name: '', reason: '无代码' }); continue; }
      const code = s.代码;
      const name = s.名称 || '';

      // 1. ST / *ST / 退市
      if (cfg.excludeSt && /ST|退|暂停/.test(name)) {
        dropped.push({ code, name, reason: 'ST/退市' }); continue;
      }

      // 2. 停牌 (成交额 = 0 / 缺失)
      if (cfg.excludeSuspended) {
        const amt = parseFloat(s.成交额 || s.成交额 || 0);
        if (isNaN(amt) || amt <= 0) {
          dropped.push({ code, name, reason: '停牌(成交额=0)' }); continue;
        }
      }

      // 3. 一字板 (涨幅 ≥ 9.9% 且 成交额 < 1000 万 — 流动性枯竭)
      if (cfg.excludeOneWord) {
        const pct = parseFloat(s.涨跌幅);
        const amt = parseFloat(s.成交额 || 0);
        if (!isNaN(pct) && !isNaN(amt) && pct >= cfg.oneWordPctChange && amt < cfg.oneWordAmountFloor) {
          dropped.push({ code, name, reason: '一字板' }); continue;
        }
      }

      // 4. 总市值 ≥ 20 亿 (小盘流动性差)
      const mc = parseFloat(s.总市值);
      if (isNaN(mc) || mc < cfg.minMktCap) {
        dropped.push({ code, name, reason: '小市值<' + (cfg.minMktCap / 1e8) + '亿' }); continue;
      }

      // 5. 市净率 > 0 (资不抵债)
      if (cfg.excludePbZero) {
        const pb = parseFloat(s.市净率);
        if (!isNaN(pb) && pb <= 0) {
          dropped.push({ code, name, reason: '市净率≤0' }); continue;
        }
      }

      // 6. 换手率 ≥ 0.5% (无交易量 = 僵尸股)
      const to = parseFloat(s.换手率);
      if (isNaN(to) || to < cfg.minTurnover) {
        dropped.push({ code, name, reason: '低换手<' + cfg.minTurnover + '%' }); continue;
      }

      // 7. 涨跌幅 ±9.5% 异常 (一字板/跌停板流动性枯竭, 即便不是一字板判定)
      const ch = parseFloat(s.涨跌幅);
      if (!isNaN(ch) && Math.abs(ch) >= cfg.pctChangeLimit) {
        dropped.push({ code, name, reason: '涨跌±' + cfg.pctChangeLimit + '%+' }); continue;
      }

      // 全部通过
      passed.push(s);
    }
    return { passed, dropped };
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
    prefilter,        // 初选硬筛 (0 IO, 5000 → ~2000)
    warmupFinMap,     // 后台预热基本面
    ensureFinMap,     // long-trader / screener 评分前等 0-3s
    getWarmupStatus,  // UI 读 warmup 状态
    DEFAULT_WEIGHTS,
    FACTOR_KEYS,      // 单点 source-of-truth, 供 weight-advisor / test 引用
    NEW_STOCK_RULE_DAYS,
    getLastDegraded: () => _lastDegraded.slice()  // V6: 返回最近一次 rankCandidates 失败维度
  };
})();