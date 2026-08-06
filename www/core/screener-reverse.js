/**
 * Core.ScreenerReverse — 反向策略选股器 (V13 拍板 / P1.0)
 *
 * 数据流:
 *   阶段 1 (板块强度):  getSectorPerformance → 上涨家数比 / 涨停家数 → 过滤 top 5
 *   阶段 2 (替身过滤): getStockSpotEfinanceCached → 板块内 PB 分位低、非龙头、非涨停
 *   阶段 3 (鱼尾排除): getRpsSnapshot → 60 日涨幅 ≤ 60% 一票否决
 *   阶段 4 (4 闸预检): ReverseDiscipline.preBuyCheck → 通过的进入 candidates
 *
 * 与 V13 数据契约层 对齐:
 *   - 全部走 Core.Data.fetchWithCache (无直 fetch)
 *   - 字段降级: 数据缺失 → 不阻塞, 但 candidates 标记 confidence=low
 *   - 零额外 IO: 复用已有缓存层
 *
 * 反向策略语义 (V13 拍板的反向):
 *   - 不接龙头, 接龙头带起的同板块替身
 *   - 不追高位, 接 PB 分位比板块中位低 20 个百分点的低估值替身
 *   - 不进量化主战场, 用 hasQuantSeat (来自龙虎榜 top5) 过滤
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  const SECTOR_TOP_N = 5;                // 取板块强度 top 5
  const PROXY_PER_SECTOR = 2;            // 每板块最多替身候选
  const TARGET_CANDIDATES = 5;           // 目标推倌 5 只左右 (V13 拍板 / 小白起步)
  const MAX_AWAIT_MS = 8000;             // 单阶段超时 8s
  const FISH_TAIL_PCT = 60;              // 60 日涨幅上限 (复用 SHORT_CRITERIA.maxGain60Pct)
  // P1-1: sector 成分股真映射 — 用 Core.Data 缓存的 industry_by_code_index 倒排
  // 之前 _sectorStocksApprox 永远返 [], fallback 用"全市场涨幅前 50", 5 个 sector 抢同一份池
  // 现在按真实申万一级成员筛
  let _sectorMembersCache = null;        // Map<industryName, [code, ...]>

  async function _getIndustryIndex() {
    if (_sectorMembersCache) return _sectorMembersCache;
    let idx = null;
    try {
      if (Core.Storage && typeof Core.Storage.cacheGet === 'function') {
        idx = await Core.Storage.cacheGet('industry_by_code_index');
      }
    } catch (_) {}
    if (!idx || typeof idx !== 'object') {
      // 缓存未命中 → 触发 getStockIndustryByCode 走其 in-flight + 重建路径 (24h TTL)
      if (Core.Data && typeof Core.Data.getStockIndustryByCode === 'function') {
        await Core.Data.getStockIndustryByCode('000000').catch(() => null);
        try { idx = await Core.Storage.cacheGet('industry_by_code_index'); } catch (_) {}
      }
    }
    if (!idx || typeof idx !== 'object') return null;
    // 倒排: code→industry → industry→[codes]
    const byInd = {};
    for (const code in idx) {
      const ind = idx[code];
      if (!ind || typeof ind !== 'string') continue;
      if (!byInd[ind]) byInd[ind] = [];
      byInd[ind].push(code);
    }
    _sectorMembersCache = byInd;
    return byInd;
  }

  // P1-3: 龙头真识别 — sector.leaderStock 是 NAME (例"贵州茅台"), 需 name→code 查表
  function _buildNameToCodeMap(spots) {
    const m = {};
    for (const s of spots || []) {
      if (s && s.name && s.code) m[s.name] = s.code;
    }
    return m;
  }

  // P1-2: 真 sector 成分股 — 用 industry_by_code_index 倒排 + spot 合并 PB/价
  function _sectorStocksReal(sector, spots, industryIndex) {
    if (!industryIndex || !sector || !sector.name) return [];
    const codes = industryIndex[sector.name];
    if (!Array.isArray(codes) || codes.length === 0) return [];
    const codeSet = new Set(codes);
    return (spots || []).filter(s => s && s.code && codeSet.has(s.code));
  }

  /**
   * 板块强度评分 (无封板率数据时的降级近似)
   * 综合: 上涨家数比 + 板块涨幅 + 涨停龙头涨幅
   * @param {object} sector getSectorPerformance 一行
   * @returns {number} 0-100 强度分
   */
  function _scoreSector(s) {
    const total = (s.upCount || 0) + (s.downCount || 0);
    if (total === 0) return 0;
    const ratio = s.upCount / total;
    const pctScore = Math.min(100, Math.max(0, (s.pctChange || 0) * 10 + 50));  // pct 0% → 50分, +5% → 100分
    const leaderScore = Math.min(100, Math.max(0, ((s.leaderPct || 0) + 5) * 10));  // leader -5% → 0, +5% → 100
    return Math.round(ratio * 50 + pctScore * 0.3 + leaderScore * 0.2);
  }

  /**
   * 主入口: AI 推倌 (V13 拍板: 5 只左右)
   * @param {object} [opts]
   * @param {number} [opts.targetCount=5] - 目标候选数
   * @param {boolean} [opts.useLLMExplain=true] - 是否生成 AI 自然语言解释 (UI 阶段才用)
   * @returns {Promise<{
   *   candidates: Array<{code, name, sector, pbPercentile, sectorPbMedian, isSectorLeader, aiReason, confidence, limitUpRate_2d}>,
   *   blocked: Array<{code, reason}>,
   *   sectorStats: object,
   *   gates: Array<{key,label,status,metric,note}>,
   *   _ok: boolean,
   *   stats: object
   * }>}
   */
  async function run(opts) {
    const o = opts || {};
    const targetCount = o.targetCount || TARGET_CANDIDATES;

    const stats = {
      sectorScanned: 0,
      sectorSelected: 0,
      stockScanned: 0,
      stockPassed: 0,
      finalCandidates: 0,
      ms: 0,
      note: ''
    };

    const t0 = Date.now();

    // 数据获取 (带超时保护)
    let sectors = [];
    let spots = [];
    let rps = { items: [] };

    try {
      const data = window.Core && window.Core.Data;
      if (!data) {
        return { candidates: [], blocked: [], sectorStats: {}, _ok: false, stats: { ...stats, note: 'Core.Data 不可用' } };
      }

      [sectors, spots, rps] = await Promise.all([
        _withTimeout(data.getSectorPerformance(), MAX_AWAIT_MS, []),
        _withTimeout(data.getStockSpotEfinanceCached(), MAX_AWAIT_MS, []),
        _withTimeout(Promise.resolve(data.getRpsSnapshot ? data.getRpsSnapshot({ days: 60 }) : { items: [] }), MAX_AWAIT_MS, { items: [] })
      ]);
    } catch (e) {
      return { candidates: [], blocked: [], sectorStats: {}, _ok: false, stats: { ...stats, note: '数据获取失败: ' + (e && e.message || e) } };
    }

    sectors = Array.isArray(sectors) ? sectors : [];
    spots = Array.isArray(spots) ? spots : [];
    const rpsMap = {};
    if (rps && Array.isArray(rps.items)) {
      for (const item of rps.items) {
        rpsMap[item.code] = item;
      }
    }

    stats.sectorScanned = sectors.length;
    stats.stockScanned = spots.length;

    // 阶段 1: 板块强度 → 排序取 top 5
    const sectorScores = sectors
      .map(s => ({ sector: s, score: _scoreSector(s) }))
      .filter(x => x.score >= 50)  // 强度分 ≥ 50 才用
      .sort((a, b) => b.score - a.score)
      .slice(0, SECTOR_TOP_N);

    stats.sectorSelected = sectorScores.length;

    const sectorStats = {};
    const candidates = [];
    const blocked = [];
    // P1-2: 跟踪最后一个有效 sector 的 PB 中位, 给 _buildGatesSummary 用 (原本是闭包泄漏变量, line 292 引用不到)
    let _lastSectorPbMedian = 50;

    // 阶段 2 + 3 + 4: 板块 → 选股 → 鱼尾排除 → 4 闸预检
    const ReverseDiscipline = window.Core && window.Core.ReverseDiscipline;

    // P1-1: 预加载 industry_by_code_index 倒排 + name→code 龙头表 (一次性, 后续 sector 复用)
    let industryIndex = null;
    try {
      industryIndex = await _withTimeout(_getIndustryIndex(), MAX_AWAIT_MS, null);
    } catch (_) { industryIndex = null; }
    const nameToCode = _buildNameToCodeMap(spots);

    for (const ss of sectorScores) {
      if (candidates.length >= targetCount) break;

      const sector = ss.sector;


      // P1-1: 板块成分股 — 用 industry_by_code_index 真映射, 没数据就跳过本板块 (不再退到"全市场涨幅前 50")
      const sectorStocks = _sectorStocksReal(sector, spots, industryIndex);
      if (sectorStocks.length === 0) {
        stats.note = (stats.note ? stats.note + '; ' : '') + 'sector=' + sector.name + ' 缺成分股映射, 跳过';
        continue;
      }
      const stockPool = sectorStocks;
      // P3: 真封板率 — 用 sectorStocks 里 changePct >= 9.5 的占比 (不新加 aktools 接口, 数据已在手)
      //   A股 sector 50 只左右, 1-2 只涨停 ≈ 2-4%, 3% 算活跃
      //   sectorUpCount 是板块整体涨跌家数(可能含新股/科创板门槛不同的), 不准
      const sectorLimitUpCount = sectorStocks.filter(s => typeof s.changePct === 'number' && s.changePct >= 9.5).length;
      const sectorLimitUpRate = sectorStocks.length > 0 ? +(sectorLimitUpCount / sectorStocks.length).toFixed(4) : 0;
      sectorStats[sector.name] = {
        score: ss.score,
        leader: sector.leaderStock,
        upCount: sector.upCount,
        downCount: sector.downCount,
        limitUpRate: sectorLimitUpRate,
        limitUpCount: sectorLimitUpCount,
        memberCount: sectorStocks.length,
        pctChange: sector.pctChange
      };

      // P1-3: 真龙头 — sector.leaderStock 是 name, 用 nameToCode 表查 code (查不到就 null, 不剔除)
      const leaderCode = (sector.leaderStock && nameToCode[sector.leaderStock]) || null;
      const nonLeader = stockPool.filter(s => s.code !== leaderCode && s.changePct < 9.5);
      // leaderCode 缺失时不剔除 (板块名跟 stocks.industry 对不上时常见, 别误伤)

      // 鱼尾排除: 60 日涨幅 > 60% 一票否决 (复用 SHORT_CRITERIA.maxGain60Pct)
      const filtered = nonLeader.filter(s => {
        const r = rpsMap[s.code];
        if (r && typeof r.pct === 'number' && r.pct > FISH_TAIL_PCT) return false;
        return true;
      });

      // 板块内 PB 中位 (用 spots 的 PB 字段估算, 字段缺失降级)
      const sectorPbList = filtered.map(s => s.pb).filter(p => typeof p === 'number' && p > 0);
      const sectorPbMedian = _median(sectorPbList) || 50;
      _lastSectorPbMedian = sectorPbMedian;  // 给 _buildGatesSummary 用

      // P1-2: 替身候选 — 按 PB 分位 (vs 板块中位) 排序, 选最低的 PROXY_PER_SECTOR
      // 之前按原始 PB 排序, 银行股 (PB~0.5) 会霸榜; 按分位后才真是"板块内低估"
      // 每只都算分位 + 中位 (用板块真实成员, 不是 filtered 之后的子集)
      const sortedByPbPercentile = filtered
        .filter(s => typeof s.pb === 'number' && s.pb > 0)
        .map(s => ({ stock: s, pbPercentile: _estimatePbPercentile(s.pb, sectorPbList) }))
        .sort((a, b) => a.pbPercentile - b.pbPercentile)   // 分位低 = 在板块内相对低估
        .slice(0, PROXY_PER_SECTOR);

      // 阶段 4: 4 闸预检
      for (const cand of sortedByPbPercentile) {
        if (candidates.length >= targetCount) break;

        const stock = cand.stock;
        const pbPercentile = cand.pbPercentile;
        // P1-4: hasQuantSeat 真没数据 (P1.5 才接 RiskMine / 龙虎榜), 不传该字段, preBuyCheck 看到 undefined 不 block
        const isSectorLeader = stock.code === leaderCode;

        const checkOpt = {
          symbol: stock.code,
          // P3: 真封板率 — 从 sectorStocks 实算 (changePct >= 9.5 / 总数)
          //   之前用 sectorScores[0].score/100 (首个板块的强度分, 跟本板块无关)
          //   再之前用 upCount/(upCount+downCount) (上涨率, 跟涨停率是两个量)
          sector: {
            limitUpRate_2d: sectorLimitUpRate,
            active2d: ss.score >= 60,
            name: sector.name
          },
          stock: {
            pbPercentile,
            sectorPbMedian,
            isSectorLeader,
            name: stock.name || stock.code
          }
        };

        if (!ReverseDiscipline) {
          stats.note = 'ReverseDiscipline 不可用, 跳过预检';
          break;
        }

        const r = ReverseDiscipline.preBuyCheck(checkOpt);
        stats.stockPassed += 1;

        if (!r.ok) {
          blocked.push({ code: stock.code, reason: r.reason });
          continue;
        }

        candidates.push({
          code: stock.code,
          name: stock.name || stock.code,
          sector: sector.name,
          pbPercentile,
          sectorPbMedian,
          isSectorLeader,
          limitUpRate_2d: checkOpt.sector.limitUpRate_2d,
          aiReason: _buildAiReason(stock, sector, pbPercentile, sectorPbMedian, r),
          confidence: _confidence(sector, stock, rpsMap[stock.code])
        });
        stats.finalCandidates += 1;
      }
    }

    stats.ms = Date.now() - t0;

    // 4 闸聚合 (供 ReverseWatch UI 状态灯展示, V13 P2 UI 重搭需求)
    // 来源: 阶段 1 板块强度 + 阶段 2 PB 分位 + 阶段 3 鱼尾 + 阶段 4 量化席位
    const gates = _buildGatesSummary(sectorScores, _lastSectorPbMedian, candidates);

    return {
      candidates,
      blocked,
      sectorStats,
      gates,
      _ok: candidates.length > 0,
      stats
    };
  }

  // ============== 工具函数 ==============

  function _withTimeout(promise, ms, fallback) {
    return Promise.race([
      promise,
      new Promise(resolve => setTimeout(() => resolve(fallback), ms))
    ]);
  }

  function _median(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const sorted = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function _estimatePbPercentile(pb, allPbList) {
    if (!Array.isArray(allPbList) || allPbList.length === 0) return 50;
    const below = allPbList.filter(p => p < pb).length;
    return Math.round((below / allPbList.length) * 100);
  }

  function _buildAiReason(stock, sector, pbPercentile, sectorPbMedian, checkResult) {
    const sectorDesc = sector.name + (sector.leaderStock ? ' (龙头: ' + sector.leaderStock + ')' : '');
    const pbGap = (sectorPbMedian - pbPercentile).toFixed(0);
    const warns = checkResult.warns.length ? ' [警告: ' + checkResult.warns.map(w => Core.ReverseDiscipline.describe(w)).join('; ') + ']' : '';
    return '板块 ' + sectorDesc + ' 今日强度可, 选替身 "' + (stock.name || stock.code) + '" —— 在板块 PB 分位 ' + pbPercentile + ', 低板块中位 ' + pbGap + ' 百分点 (≥20 满足反向 7 铁律规则 2)。' + warns;
  }

  function _confidence(sector, stock, rpsItem) {
    let c = 0;
    if (sector.upCount > sector.downCount) c++;
    if (typeof stock.pb === 'number') c++;
    if (rpsItem) c++;
    if (c >= 3) return 'high';
    if (c >= 1) return 'medium';
    return 'low';
  }

  /**
   * 闸状态聚合 (供 ReverseWatch UI 状态灯)
   * v0.2.1-P2: 量化席位闸暂时 skipped (P1.5 接 RiskMine / 龙虎榜数据, 这之前一直是 false), 实际只 3 闸有效
   * 真实数据来源: sectorScores (阶段1) + sectorPbMedian (阶段2) + candidates (阶段4 通过的)
   * 阈值: 强度≥60 通过, PB分位≤中位-20 通过, 龙头剔除
   * @returns {Array<{key, label, status, metric, note}>}
   */
  function _buildGatesSummary(sectorScores, lastPbMedian, candidates) {
    // 闸 1: 板块强度 (取 sectorScores 平均分)
    const avgSectorScore = sectorScores.length === 0
      ? 0
      : Math.round(sectorScores.reduce((s, x) => s + x.score, 0) / sectorScores.length);
    const sectorPass = avgSectorScore >= 60;
    // 闸 2: PB 分位 (用最后一块板块的中位数; 通过条件是已通过的 candidates 都满足)
    const pbPass = candidates.length > 0
      && candidates.every(c => (c.sectorPbMedian - c.pbPercentile) >= 20);
    const pbSample = candidates.length > 0
      ? candidates[0]
      : null;
    // 闸 4: 非龙头 (candidates 中无 isSectorLeader=true)
    const leaderCount = candidates.filter(c => c.isSectorLeader === true).length;
    const noLeader = leaderCount === 0;

    return [
      {
        key: 'sector',
        label: '板块强度',
        status: sectorPass ? 'pass' : 'fail',
        metric: avgSectorScore + '%',
        note: sectorPass ? '≥ 60 满足' : '< 60, 板块弱'
      },
      {
        key: 'pb',
        label: 'PB 分位',
        status: pbPass ? 'pass' : 'fail',
        metric: pbSample ? pbSample.pbPercentile + '%ile' : '—',
        note: pbPass ? '≤ 中位 - 20pp' : 'PB 不够低'
      },
      // v0.2.1-P2: 量化席位闸暂未接数据, UI 上显示"待接"
      {
        key: 'quant',
        label: '量化席位',
        status: 'skipped',
        metric: '—',
        note: 'P1.5 待接 RiskMine / 龙虎榜'
      },
      {
        key: 'dragon',
        label: '非龙头',
        status: noLeader ? 'pass' : 'fail',
        metric: noLeader ? '0 龙头' : leaderCount + ' 龙头',
        note: noLeader ? '全部替身' : '发现龙头, 已剔除'
      }
    ];
  }

  /**
   * 单票预检入口 (供 UI 上"自选下单"按钮直接调)
   * @param {object} opt 同 ReverseDiscipline.preBuyCheck
   */
  function preCheckOne(opt) {
    const rd = window.Core && window.Core.ReverseDiscipline;
    if (!rd) {
      return { blocks: ['reverse-discipline-not-ready'], warns: [], reason: 'ReverseDiscipline 未加载', ok: false };
    }
    return rd.preBuyCheck(opt);
  }

  window.Core.ScreenerReverse = {
    VERSION: 'v0.2.1-P2',
    run,
    preCheckOne,
    /** 内部工具 (测试可调) */
    _scoreSector,
    _median,
    _estimatePbPercentile,
    _buildGatesSummary
  };
})();
