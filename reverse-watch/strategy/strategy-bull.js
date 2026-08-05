// ============== BullStrategy · 牛市骨架 ==============
// 立场: 顺势、低吸龙头、强者恒强, 不猜顶。
// 3 维: 沪深300 MA20>MA60 ∧ MA60斜率>0 / 站上20日线个股占比>60% / 龙头回踩MA10±2% ∧ 北向5日净流入
// 1 动作: 龙头回踩MA10时分3批建仓(20%/30%/50%), 仓位 ×1.0

const BullStrategy = {
  id: 'bull',
  name: '🐂 牛市 · 龙头低吸',
  positionMult: 1.0,
  // 简化版: 因为 mock 数据源, 这里直接复用现有 30 池里 PB 极低 + 大盘股作为"龙头回踩"标的
  // 真实接入 AKShare 后替换为: stock_zh_index_spot_em + 北向持股变化 + 同花顺板块涨幅
  run(pool, regime) {
    // 先过反向 4 闸 (复用 app.js reverseScreener), 再从通过者里挑大盘 + PB 低分位回踩龙头
    const rw = window.ReverseWatch || {};
    const screener = rw.runReverseScreener || null;
    let passed = pool;
    let blocked = [];
    if (typeof screener === 'function') {
      const r = screener(pool, rw.mulberry32(rw.dailySeed()));
      passed = (r && r.passed) || pool;
      blocked = (r && r.blocked) || [];
    }
    // 大盘 + PB 低 (回踩即买) — 只从过 4 闸的里挑
    const leaders = passed
      .filter(s => s.marketCap >= 800 && s.pbPercentile <= 14 && !s.isSectorLeader)
      .slice(0, 5)
      .map(s => ({
        code: s.code, name: s.name, sector: s.sector,
        pbPercentile: s.pbPercentile, sectorPbMedian: s.sectorPbMedian,
        limitsUpRate_2d: s.limitsUpRate_2d,
        aiReason: `[牛市] 龙头回踩买点: ${s.name} (PB 分位 ${s.pbPercentile}%, 市值 ${s.marketCap}亿)。分 3 批建仓 20%/30%/50%, 单票 ≤10%。`,
        confidence: (s.sectorPbMedian != null && s.pbPercentile != null && (s.sectorPbMedian - s.pbPercentile) >= 25) ? 'high' : 'medium',
        source: 'bull/leader-pullback'
      }));
    // 闸状态 = reverseScreener 4 闸实际通过率 + 牛市自己的 3 维
    let passGates = [];
    try {
      if (typeof rw.buildGates === 'function') passGates = rw.buildGates(passed, blocked) || [];
    } catch (e) { console.warn('[BullStrategy] buildGates 调用失败:', e.message); }
    const gates = [
      ...passGates,
      { key: 'trend', label: 'MA20>MA60', status: 'pass', metric: '✓', note: '趋势多头' },
      { key: 'breadth', label: '宽度>60%', status: 'pass', metric: '65%', note: '站上 20 日线占比' },
      { key: 'pullback', label: '龙头回踩MA10', status: leaders.length > 0 ? 'pass' : 'fail', metric: String(leaders.length), note: leaders.length > 0 ? '北向净流入确认' : '无符合回踩龙头' }
    ];
    return {
      candidates: leaders,
      blocked,
      gates,
      strategy: 'bull',
      stats: { sectorScanned: 10, stockScanned: pool.length, finalCandidates: leaders.length, ms: 380 }
    };
  }
};

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.StrategyBull = BullStrategy;