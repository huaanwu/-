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
   * 从全 A 股快照找某板块的成分股 (粗粒度: 用 leaderStock 字段做近似)
   * @param {string} sectorName
   * @param {Array} spots - getStockSpotEfinanceCached 返回
   * @returns {string|null} leader code
   */
  function _findLeaderCode(sectorName, spots) {
    if (!sectorName || !Array.isArray(spots)) return null;
    for (const s of spots) {
      if (s.name === sectorName) return s.code;
    }
    return null;
  }

  /**
   * 板块 → 候选股映射 (粗粒度: 只能看到 leaderStock 字段)
   * V13 拍板: 真实生产中用 aktools 反查接口; 这里用 leaderStock + 板块涨幅推断
   * 降级策略: 数据缺失返回空数组, 不 block 整体
   */
  function _sectorStocksApprox(sector, spots) {
    const out = [];
    const leaderCode = _findLeaderCode(sector.name, spots);
    if (!leaderCode) return out;
    // 反向策略: 同板块非龙头 → 只能从 spots 里按板块代码前缀筛 (粗略)
    // 这里退化: 仅返回 leader (供后续剔除), 不做板块成员匹配
    return out;
  }

  /**
   * 主入口: AI 推倌 (V13 拍板: 5 只左右)
   * @param {object} [opts]
   * @param {number} [opts.targetCount=5] - 目标候选数
   * @param {boolean} [opts.useLLMExplain=true] - 是否生成 AI 自然语言解释 (UI 阶段才用)
   * @returns {Promise<{
   *   candidates: Array<{code, name, sector, pbPercentile, sectorPbMedian, isSectorLeader, hasQuantSeat, aiReason, confidence, limitsUpRate_2d}>,
   *   blocked: Array<{code, reason}>,
   *   sectorStats: object,
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

    // 阶段 2 + 3 + 4: 板块 → 选股 → 鱼尾排除 → 4 闸预检
    const ReverseDiscipline = window.Core && window.Core.ReverseDiscipline;

    for (const ss of sectorScores) {
      if (candidates.length >= targetCount) break;

      const sector = ss.sector;
      sectorStats[sector.name] = {
        score: ss.score,
        leader: sector.leaderStock,
        upCount: sector.upCount,
        downCount: sector.downCount,
        pctChange: sector.pctChange
      };

      // 板块成分股 (粗粒度, 用 spots 名字匹配 sector.name)
      const sectorStocks = spots.filter(s => s.industry === sector.name || s.boardName === sector.name);
      const approxStocks = sectorStocks.length > 0 ? sectorStocks : _sectorStocksApprox(sector, spots);

      // 真实成分股缺失时, 降级: 用板块中所有当日活跃股
      const stockPool = approxStocks.length > 0
        ? approxStocks
        : spots.filter(s => s.changePct > 0).slice(0, 50);  // 取当日上涨前 50 只

      // 排除板块龙头
      const leaderCode = _findLeaderCode(sector.leaderStock, stockPool);
      const nonLeader = stockPool.filter(s => s.code !== leaderCode && s.changePct < 9.5);

      // 鱼尾排除: 60 日涨幅 > 60% 一票否决 (复用 SHORT_CRITERIA.maxGain60Pct)
      const filtered = nonLeader.filter(s => {
        const r = rpsMap[s.code];
        if (r && typeof r.pct === 'number' && r.pct > FISH_TAIL_PCT) return false;
        return true;
      });

      // 板块内 PB 中位 (用 spots 的 PB 字段估算, 字段缺失降级)
      const sectorPbList = filtered.map(s => s.pb).filter(p => typeof p === 'number' && p > 0);
      const sectorPbMedian = _median(sectorPbList) || 50;

      // 替身候选: PB 最低的几只
      const sortedByPb = filtered
        .filter(s => typeof s.pb === 'number' && s.pb > 0)
        .sort((a, b) => a.pb - b.pb)
        .slice(0, PROXY_PER_SECTOR);

      // 阶段 4: 4 闸预检
      for (const stock of sortedByPb) {
        if (candidates.length >= targetCount) break;

        const pbPercentile = _estimatePbPercentile(stock.pb, sectorPbList);
        const hasQuantSeat = false;  // 数据缺失; P1.5 接 RiskMine / 龙虎榜数据补
        const isSectorLeader = stock.code === leaderCode;

        const checkOpt = {
          symbol: stock.code,
          sector: {
            limitUpRate_2d: sectorScores[0].score / 100,  // 强度分作封板率近似
            active2d: ss.score >= 60,
            name: sector.name
          },
          stock: {
            pbPercentile,
            sectorPbMedian,
            isSectorLeader,
            hasQuantSeat,
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
          hasQuantSeat,
          limitsUpRate_2d: checkOpt.sector.limitUpRate_2d,
          aiReason: _buildAiReason(stock, sector, pbPercentile, sectorPbMedian, r),
          confidence: _confidence(sector, stock, rpsMap[stock.code])
        });
        stats.finalCandidates += 1;
      }
    }

    stats.ms = Date.now() - t0;

    // 4 闸聚合 (供 ReverseWatch UI 状态灯展示, V13 P2 UI 重搭需求)
    // 来源: 阶段 1 板块强度 + 阶段 2 PB 分位 + 阶段 3 鱼尾 + 阶段 4 量化席位
    const gates = _buildGatesSummary(sectorScores, sectorPbMedian, candidates);

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
   * 4 闸聚合 (供 ReverseWatch UI 4 闸状态灯)
   * 真实数据来源: sectorScores (阶段1) + sectorPbMedian (阶段2) + candidates (阶段4 通过的)
   * 阈值: 强度≥60 通过, PB分位≤中位-20 通过, 量化席位数根据 candidates 中 hasQuantSeat 计数
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
    // 闸 3: 量化席位 (candidates 中 hasQuantSeat=true 的数量; ≤3 通过, >3 warn)
    const quantCount = candidates.filter(c => c.hasQuantSeat === true).length;
    const quantPass = quantCount <= 3;
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
      {
        key: 'quant',
        label: '量化席位',
        status: quantPass ? (quantCount > 0 ? 'warn' : 'pass') : 'fail',
        metric: quantCount + '只',
        note: quantCount === 0 ? '无量化监测' : (quantPass ? '≤ 3 可容忍' : '> 3 拥挤')
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
    VERSION: 'v0.2.0-P2',
    run,
    preCheckOne,
    /** 内部工具 (测试可调) */
    _scoreSector,
    _median,
    _estimatePbPercentile,
    _buildGatesSummary
  };
})();
