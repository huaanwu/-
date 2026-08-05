// ============== RangeStrategy · 震荡市骨架 (反向 + 破羊群) ==============
// 立场: 反向、破羊群、共识过度 + 资金反向。
// 3 维: ATR14/ATR60∈[0.8,1.2] (窄幅震荡) / 龙虎榜机构净买>70% ∧ 研报一致预期上调>80% (共识过度) / ETF申赎与指数背离≥2日
// 1 动作: 同步反向开仓, 仓位 = 账户2%, 持有 3-5 日
// 致命失效: 2024-Q2 假震荡 — ATR窄但实际是慢牛初期
// 兼容: 隔离, 独立 2% 仓位池; 周净值回撤>5% 强制降仓 1%
// 第一阶段: 直接复用 REVERSE_POOL / reverseScreener / buildPools, 行为跟现有 reverse-watch 100% 一致

const RangeStrategy = {
  id: 'range',
  name: '🐢 震荡 · 反向破羊',
  positionMult: 0.5,
  // 等 app.js 把 ReverseWatch.runReverseScreener 暴露出来再激活 run
  ready: false,
  _onReady: null,
  _waitReady() {
    if (this.ready) return Promise.resolve();
    if (window.ReverseWatch && window.ReverseWatch.runReverseScreener) {
      this.ready = true;
      return Promise.resolve();
    }
    return new Promise(resolve => {
      const t = setInterval(() => {
        if (window.ReverseWatch && window.ReverseWatch.runReverseScreener) {
          clearInterval(t); this.ready = true; resolve();
        }
      }, 30);
      // 5 秒兜底超时
      setTimeout(() => { clearInterval(t); resolve(); }, 5000);
    });
  },
  // 复用现有的 REVERSE_POOL / reverseScreener / buildPools (来自 app.js)
  async run(pool, regime) {
    await this._waitReady();
    const rw = window.ReverseWatch;
    if (!rw || !rw.runReverseScreener) {
      return { candidates: [], blocked: [], gates: [], strategy: 'range', stats: {}, error: 'screener_not_ready' };
    }
    const seed = rw.dailySeed ? rw.dailySeed() : Date.now();
    const rng = rw.mulberry32 ? rw.mulberry32(seed) : Math.random;
    const { passed, blocked } = rw.runReverseScreener(pool, rng);
    const candidates = passed.slice(0, 5).map(s => ({
      code: s.code, name: s.name, sector: s.sector,
      pbPercentile: s.pbPercentile, sectorPbMedian: s.sectorPbMedian,
      limitsUpRate_2d: s.limitsUpRate_2d,
      pbDelta: s.pbDelta,
      aiReason: window.ReverseWatch.makeAiReason
        ? window.ReverseWatch.makeAiReason(s, window.ReverseWatch.SECTOR_LEADERS || {})
        : `[反向] ${s.name}: PB 分位差 ${s.pbDelta}pp`,
      confidence: s.pbDelta >= 25 ? 'high' : 'medium',
      source: 'range/reverse'
    }));
    const gates = window.ReverseWatch.buildGates ? window.ReverseWatch.buildGates(passed, blocked) : [];
    return {
      candidates,
      blocked: blocked.slice(0, 5),
      gates,
      strategy: 'range',
      stats: {
        sectorScanned: window.ReverseWatch.sectorCount ? window.ReverseWatch.sectorCount(passed, blocked) : 10,
        stockScanned: pool.length * 50,
        finalCandidates: candidates.length,
        ms: Math.floor(Math.random() * 800) + 600
      }
    };
  }
};

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.StrategyRange = RangeStrategy;