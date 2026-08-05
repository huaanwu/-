/**
 * Core.Screener — 选股规则引擎 (P3.1)
 *
 * 把全 A 股 (~5500) 砍到 50 只候选, 分长短线两个 sleeve。
 * 漏斗: 硬过滤 (→ ~2000) → 软打分 (top 50)。
 *
 * 长线 (long): 质量+估值驱动, 持有周期年-数年
 *   维度 1: ROE 3 年均值 >= 10%
 *   维度 2: 经营性现金流 3 年均为正
 *   维度 3: PE-TTM 自身历史分位 < 50% (近 3 年)
 *   维度 4: 营收增速 3 年均值 >= 0 (防衰退)
 *   维度 5: 申万行业前三龙头 (用 getConceptMembership 近似)
 *
 * 短线 (short): 动量+资金驱动, 持有周期天-周
 *   维度 1: 20/60 日均线多头排列 (站上 20 日 + 60 日)
 *   维度 2: 近 20 日主力资金净流入 > 0
 *   维度 3: 近 20 日 RPS >= 80 (强于市场 80% 股票)
 *   维度 4: 近 5 日换手率均值 1%-8% (活跃但不疯狂)
 *   维度 5: 所属申万行业近 5 日涨幅排名前 10
 *
 * 硬过滤 (任一不满足即砍):
 *   - 代码非 A 股 6 位数 (跳过 ETF/可转债/指数)
 *   - ST / *ST (名称含 ST)
 *   - 停牌 (成交量=0 或 涨跌幅=null)
 *   - 日均成交额 < 5000 万 (近 20 日)
 *   - 上市 < 1 年 (无足够历史)
 *
 * 降级契约 (照搬 Regime/Cycle 失灵熔断):
 *   - 5 维任一维度失败不阻塞整体
 *   - 全部维度失败 → 返 null, 不写候选
 *   - confidence: high(5 维) / medium(3-4) / low(1-2) / none(0)
 *
 * 暴露:
 *   Core.Screener.run(sleeve='long'|'short'|'both') → { long, short, _ok, stats }
 *   Core.Screener.HARD_FILTERS, LONG_CRITERIA, SHORT_CRITERIA (调试用)
 *
 * 加载顺序: 必须在 Core.Data + Core.ResearchPool + Core.Storage 之后
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  const HARD_FILTERS = {
    minAvgTurnover: 5000e4,    // 日均成交 5000 万
    minListYears: 1,             // 至少上市 1 年
    excludeST: true,
    excludeSuspended: true
  };

  const LONG_CRITERIA = {
    minROE3y: 10,                // ROE 3 年均值 ≥ 10%
    requirePositiveCashFlow: true,
    maxPEPercentile: 50,         // PE-TTM 自身分位 < 50%
    minRevGrowth3y: 0,           // 营收 3 年均值 ≥ 0
    requireIndustryLead: true    // 行业前三
  };

  const SHORT_CRITERIA = {
    requireBullishMA: false,   // MA 数据暂缺，跳过此维度（需逐只拉K线开销过大）
    requirePositiveNorthbound: false,  // 北向 24h 缓存可能过期，跳过
    minRPS20: 80,
    // 换手率用 spot 即时字段（不是5日均），今日换手率普遍 0.5~5%，放宽阈值
    minAvgTurnover5d: 0.5,      // 今日换手率 ≥ 0.5%（原 1% 太高）
    maxAvgTurnover5d: 15,       // 今日换手率 ≤ 15%（原 8% 太低）
    requireTopSector: false,     // 板块强度依赖 sectorPerf，降级时跳过
    // KIMI-2: 鱼尾排除 — 60 日累计涨幅超此值直接剔除 (对齐《短线手册》排雷第 6 条 "鱼尾刺多")
    //   数据源 getRpsSnapshot().pct (60日涨跌幅, 24h 缓存, 零额外 IO)
    maxGain60Pct: 60
  };

  /**
   * 硬过滤: 输入全 A 股行情, 输出通过过滤的子集
   * @param {Array} spots - getStockSpotEfinanceCached() 返回的 ~5500 行
   * @returns {Array} 过滤后 ~2000 行
   */
  function _hardFilter(spots) {
    if (!Array.isArray(spots)) return [];
    const now = Date.now();
    return spots.filter(s => {
      const code = String(s['代码'] || s.code || '');
      if (!/^\d{6}$/.test(code)) return false;
      const name = String(s['名称'] || s.name || '');
      if (HARD_FILTERS.excludeST && /ST/i.test(name)) return false;
      const turnover = parseFloat(s['成交额'] || s.amount || 0);
      // 成交额单位: 东方财富是元直给; 若无值, 跳过
      if (!turnover) return false;
      // 日均成交 5000 万 = 50000000 元; 但东方财富给的是「今日成交额」而非日均
      // 这里近似用「今日成交额 >= 5000 万」做粗过滤 (流动性最低要求)
      if (turnover < HARD_FILTERS.minAvgTurnover) return false;
      return true;
    });
  }

  /**
   * 长线打分 5 维, 每维 0-1
   * @returns {{ score: number, dims: object }}
   */
  function _scoreLong(stock, ctx) {
    const dims = {};
    const code = stock['代码'] || stock.code || '';
    const fin = (ctx.financials || {})[code];
    // 维度 1: ROE (从财报接口拿, ctx.financials[code])
    if (fin && typeof fin.roe3y === 'number') {
      dims.roe = Math.min(1, Math.max(0, (fin.roe3y - 5) / 20));  // 5%-25% 映射 0-1
    }
    // 维度 2: 现金流
    if (fin && typeof fin.cashFlowPositive === 'boolean') {
      dims.cashFlow = fin.cashFlowPositive ? 1 : 0;
    }
    // 维度 3: PE 分位 (从 ctx.pePercentiles[code])
    if (typeof (ctx.pePercentiles || {})[code] === 'number') {
      const p = ctx.pePercentiles[code];
      // 分位 0% (最便宜) → 1; 分位 50% → 0.5; 分位 100% (最贵) → 0
      dims.pe = 1 - Math.min(1, Math.max(0, p / 100));
    } else {
      // 降级: 从 spot 动态市盈率做粗估值 (低 PE → 高价值分)
      const pe = parseFloat(stock['市盈率-动态'] || stock.pe || 0);
      if (pe > 0 && pe < 200) {
        // 3~30 倍映射到 0.9~0.1, 线性衰减
        dims.pe = Math.max(0, Math.min(0.9, 1 - (pe - 3) / 27));
      } else if (pe > 0) {
        dims.pe = 0.05; // 极高 PE 给低分
      } else if (pe < 0) {
        dims.pe = 0;    // 亏损给 0
      }
    }
    // 维度 4: 总市值 (大市值有溢价)
    const mktCap = parseFloat(stock['总市值'] || stock.totalMarketCap || 0);
    if (mktCap > 0) {
      // 50亿~2000亿线性映射 0.2~1.0, 对数感觉
      dims.marketCap = Math.min(1, Math.max(0.2, Math.log10(mktCap / 1e8) / 3));
    }
    if (fin && typeof fin.revGrowth3y === 'number') {
      dims.revGrowth = Math.min(1, Math.max(0, (fin.revGrowth3y + 10) / 40));  // -10%~+30% → 0-1
    }
    // 维度 5: 行业地位 (布尔)
    if (fin && typeof fin.isIndustryLead === 'boolean') {
      dims.industry = fin.isIndustryLead ? 1 : 0;
    }
    // KIMI-4: 长线财务质量硬性排雷 (数据齐全才启用, 缺数据降级不否决)
    //   ROE 连续性: 均值 ≥15% 且最低年 ≥9% → 1; 均值 ≥10% → 0.5; 否则 0
    //   负债率 <60% → 0.5; 毛利率 ≥30% 且 5 年下滑 ≤5pp → 0.5
    //   质量分 < 0.35 (即多数财务指标不达标) → 硬性 score 0 (Kimi 排雷语义)
    if (fin) {
      let q = 0, parts = 0;
      if (Array.isArray(fin.roeSeries) && fin.roeSeries.length >= 2) {
        parts += 1;
        const mean = fin.roeSeries.reduce((s, v) => s + v, 0) / fin.roeSeries.length;
        const minV = Math.min.apply(null, fin.roeSeries);
        q += (mean >= 15 && minV >= 9) ? 1 : (mean >= 10 ? 0.5 : 0);
      }
      if (Number.isFinite(fin.debtRatio)) {
        parts += 1;
        q += (fin.debtRatio < 60) ? 0.5 : 0;
      }
      if (Array.isArray(fin.gmSeries) && fin.gmSeries.length >= 2) {
        parts += 1;
        const lastGm = fin.gmSeries[0], firstGm = fin.gmSeries[fin.gmSeries.length - 1];
        q += (lastGm >= 30 && (firstGm - lastGm) <= 5) ? 0.5 : 0;
      }
      if (parts > 0) {
        const quality = q / parts;
        if (quality < 0.35) return { score: 0, dims: { quality: 0 } };
      }
    }
    const arr = Object.values(dims);
    if (arr.length === 0) return { score: 0, dims };
    const score = arr.reduce((s, v) => s + v, 0) / 5;  // 除以满分维度数 5
    return { score, dims };
  }

  /**
   * 短线打分 5 维
   * @returns {{ score: number, dims: object }}
   */
  function _scoreShort(stock, ctx) {
    const dims = {};
    const code = stock['代码'] || stock.code || '';
    // KIMI-2: 鱼尾排除 (一票否决) — 60 日累计涨幅超上限 → 整只 score 0, _pickTop 的 >0 过滤自动剔除
    const gain = (ctx.rps || {})[code];
    if (gain && typeof gain.pct === 'number' && gain.pct > (SHORT_CRITERIA.maxGain60Pct || 0)) {
      return { score: 0, dims: { fishTail: 0 } };
    }
    // 维度 1: 20/60 日均线多头
    const ma = (ctx.maData || {})[code];
    if (ma) {
      dims.bullishMA = (ma.ma20Above && ma.ma60Above) ? 1 : 0;
    }
    // 维度 2: 北向 20 日净流入 (data.js 返回 {todayNet, net5d, holdingChange, pct, date})
    const nb = (ctx.northbound || {})[code];
    if (nb && typeof nb.net5d === 'number') {
      dims.northbound = nb.net5d > 0 ? 1 : 0;
    }
    // 维度 3: RPS (data.js 返回 {pct, rank, z, median, std})
    const rps = (ctx.rps || {})[code];
    if (rps && typeof rps.rank === 'number') {
      dims.rps = rps.rank >= SHORT_CRITERIA.minRPS20 ? 1 : 0;
    }
    // 维度 4: 换手率 (今价上的换手率字段)
    const turnover = parseFloat(stock['换手率'] || stock.turnover || 0);
    if (turnover > 0) {
      dims.turnover = (turnover >= SHORT_CRITERIA.minAvgTurnover5d && turnover <= SHORT_CRITERIA.maxAvgTurnover5d) ? 1 : 0;
    }
    // 维度 5: 板块强度 (top 10)
    const industry = stock['行业'] || stock.industry || '';
    if (industry && (ctx.sectorTop || {})[industry]) {
      dims.sector = 1;
    }
    const arr = Object.values(dims);
    if (arr.length === 0) return { score: 0, dims };
    const score = arr.reduce((s, v) => s + v, 0) / 5;
    return { score, dims };
  }

  function _confidence(dims) {
    const n = Object.keys(dims).length;
    if (n >= 4) return 'high';
    if (n >= 2) return 'medium';
    if (n >= 1) return 'low';
    return 'none';
  }

  function _pickTop(scored, k = 50) {
    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, k);
  }

  /**
   * 主入口
   * @param {'long'|'short'|'both'} sleeve
   * @param {{ onProgress?: (phase: string, detail: string) => void }} [opts]
   * @returns {Promise<{ long, short, _ok, stats }>}
   */
  async function run(sleeve = 'both', opts = {}) {
    const { onProgress } = opts;
    const prog = (phase, detail) => { if (onProgress) onProgress(phase, detail); };

    // 1) 拉全 A 股 (走现有 5min 缓存)
    prog('spots', '正在拉取全市场行情...');
    const spots = await Core.Data.getStockSpotEfinanceCached();
    prog('spots', '全市场 ' + spots.length + ' 只股票已就绪');
    const passed = _hardFilter(spots);
    const codes = passed.map(s => s['代码'] || s.code || '').filter(Boolean);
    prog('spots', '初筛后 ' + codes.length + ' 只, 正在拉取财务/板块/RPS...');

    // 2) 并行拉 ctx 数据 (5 路并发, 各自降级)
    const startTs = Date.now();
    const [rpsMap, sectorPerf, finMap] = await Promise.all([
      // RPS 全市场一次调用
      Core.Data.getRpsSnapshot().then(r => { prog('rps', 'RPS 数据就绪'); return r; }).catch(() => null),
      // 板块强度一次调用, 取涨幅前 10 行业
      Core.Data.getSectorPerformance().then(r => { prog('sector', '板块数据就绪'); return r; }).catch(() => null),
      // 财报批量 (内置 20 并发 + 7d 缓存)
      codes.length > 0 ? Core.Data.getStockFinancialBatch(codes).then(r => { prog('fin', '财报数据就绪'); return r; }).catch(() => null) : null
    ]);
    prog('north', '正在拉取北向持仓 (并发=8)...');
    // 北向: per-stock 调用 — 用有限并发 (8) 防止首轮缓存未命中时轰击 dev-proxy/aktools
    //   getNorthboundFlow 内部有 24h 缓存, 但首轮初筛会全量命中 → 不限流会瞬时打 5K+ 请求
    const NORTH_CONCURRENCY = 8;
    const northEntries = new Array(codes.length);
    let northIdx = 0;
    async function _northWorker() {
      while (northIdx < codes.length) {
        const i = northIdx++;
        try {
          northEntries[i] = await Core.Data.getNorthboundFlow(codes[i]).catch(() => null);
        } catch (_) {
          northEntries[i] = { status: 'rejected', value: null };
        }
      }
    }
    const northWorkers = Array.from({ length: Math.min(NORTH_CONCURRENCY, codes.length) }, () => _northWorker());
    await Promise.all(northWorkers);
    prog('scoring', '开始评分...');
    const northMap = {};
    codes.forEach((c, i) => {
      const v = northEntries[i];
      if (v && v.status === 'fulfilled' && v.value) northMap[c] = v.value;
    });
    // sectorTop: { industryName: true } 取涨幅前 10
    const sectorTopMap = {};
    if (Array.isArray(sectorPerf)) {
      sectorPerf
        .sort((a, b) => (b.pctChange || 0) - (a.pctChange || 0))
        .slice(0, 10)
        .forEach(s => { if (s && s.name) sectorTopMap[s.name] = true; });
    }
    // 提取财报关键字段: roe3y/revGrowth3y/cashFlowPositive/isIndustryLead
    // stock_financial_abstract 返 array [{代码, 日期, 净资产收益率, ...}], 取最新期
    // KIMI-4: 追加多期序列 roeSeries/debtRatio/grossMargin 用于长线五道筛子 (负债/毛利/连续性)
    const financials = {};
    if (finMap) {
      for (const [code, raw] of finMap) {
        if (!raw || !Array.isArray(raw) || raw.length === 0) continue;
        const latest = raw[0];
        const fe = { roe3y: null, revGrowth3y: null, cashFlowPositive: null, isIndustryLead: null };

        const roe = latest['净资产收益率'] || latest['ROE'] || latest['roe'];
        if (roe != null && !isNaN(parseFloat(roe))) fe.roe3y = parseFloat(roe);

        const rev = latest['营业总收入同比增长'] || latest['营收增速'];
        if (rev != null && !isNaN(parseFloat(rev))) fe.revGrowth3y = parseFloat(rev);

        const cashFlow = latest['经营活动现金流净额'] || latest['经营活动产生的现金流量净额'];
        if (cashFlow != null && !isNaN(parseFloat(cashFlow))) fe.cashFlowPositive = parseFloat(cashFlow) > 0;

        // KIMI-4: 多期序列 (最多 5 期, 由新到旧)
        const roeSeries = [], debtSeries = [], gmSeries = [];
        for (const r of raw.slice(0, 5)) {
          const v = (r['净资产收益率'] != null ? parseFloat(r['净资产收益率']) : NaN);
          if (Number.isFinite(v)) roeSeries.push(v);
          const d = (r['资产负债率'] != null ? parseFloat(r['资产负债率']) : NaN);
          if (Number.isFinite(d)) debtSeries.push(d);
          const g = (r['销售毛利率'] != null ? parseFloat(r['销售毛利率']) : NaN);
          if (Number.isFinite(g)) gmSeries.push(g);
        }
        if (roeSeries.length >= 2) fe.roeSeries = roeSeries;
        if (debtSeries.length >= 1) fe.debtRatio = debtSeries[0];
        if (gmSeries.length >= 2) fe.gmSeries = gmSeries;

        financials[code] = fe;
      }
    }
    const ctx = {
      financials,
      pePercentiles: {},      // 暂无现成函数, 依赖 _scoreLong spot PE 降级
      maData: {},             // 暂缺: 需逐只拉 K 线 + 算 MA20/MA60 (~5000× 调用, 太贵)
      northbound: northMap,
      rps: rpsMap instanceof Map ? Object.fromEntries(rpsMap) : (rpsMap || {}),
      sectorTop: sectorTopMap
    };
    const ctxLatency = Date.now() - startTs;

    const result = { long: [], short: [], _ok: true, stats: {} };

    if (sleeve === 'long' || sleeve === 'both') {
      const scored = passed.map(s => {
        const { score, dims } = _scoreLong(s, ctx);
        return {
          code: s.code || s['代码'],
          name: s.name || s['名称'],
          market: s.market,
          score,
          dims,
          confidence: _confidence(dims)
        };
      });
      prog('scoring', '长线评分 ' + passed.length + ' 只...');
      result.long = _pickTop(scored, 50);
      result.stats.long = { passed: passed.length, scored: scored.length, picked: result.long.length };
    }

    if (sleeve === 'short' || sleeve === 'both') {
      const scored = passed.map(s => {
        const { score, dims } = _scoreShort(s, ctx);
        return {
          code: s.code || s['代码'],
          name: s.name || s['名称'],
          market: s.market,
          score,
          dims,
          confidence: _confidence(dims)
        };
      });
      prog('scoring', '短线评分 ' + passed.length + ' 只...');
      result.short = _pickTop(scored, 50);
      result.stats.short = { passed: passed.length, scored: scored.length, picked: result.short.length };
    }

    prog('done', '完成, 长线 ' + result.long.length + ' 只, 短线 ' + result.short.length + ' 只');
    return result;
  }

  /**
   * 把候选批量加入 ResearchPool (带 sleeve 标签)
   * @param {string[]} codes
   * @param {'long'|'short'} sleeve
   */
  async function pushToPool(codes, sleeve) {
    if (!Array.isArray(codes)) return { imported: 0, skipped: 0, failed: 0 };
    let imported = 0, skipped = 0, failed = 0;
    for (const code of codes) {
      try {
        const r = await Core.ResearchPool.add(code, {
          tags: [sleeve === 'long' ? '长线' : '短线'],
          note: `规则引擎 ${sleeve === 'long' ? '长线' : '短线'} 候选`,
          addedBy: `screener-${sleeve}`
        });
        if (r.existed) skipped++;
        else imported++;
      } catch (e) {
        // 池满时跳过剩余
        if (/已满/.test(e.message)) { failed = codes.length - imported - skipped; break; }
        failed++;
      }
    }
    return { imported, skipped, failed };
  }

  window.Core.Screener = {
    HARD_FILTERS,
    LONG_CRITERIA,
    SHORT_CRITERIA,
    run,
    pushToPool,
    _hardFilter,
    _scoreLong,
    _scoreShort,
    _confidence,
    _pickTop
  };
})();
