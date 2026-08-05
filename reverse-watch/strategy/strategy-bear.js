// ============== BearStrategy · 熊市骨架 ==============
// 立场: 现金为王、恐慌折价、定投指数ETF。
// 3 维: 沪深300较60日高点回撤≥10% / 板块普跌日占比>70% ∧ 涨停数<30 / 中证500 PE分位<20%
// 1 动作: 每周定投指数ETF (中证500+沪深300各半), 仓位 ×0.0 (空仓是合法状态)
// 致命失效: 2024-09 政策底V反 — 空仓成本巨大
// 兼容: 替换模式, -5%止损放宽至-8%, 由定投节奏约束

const BearStrategy = {
  id: 'bear',
  name: '🐻 熊市 · 现金为王',
  positionMult: 0.0,  // 空仓 — 用户立场: 空仓是合法状态
  run(pool, regime) {
    // 熊市: 只输出"定投指数 ETF"信号, 不输出个股候选
    return {
      candidates: [],
      blocked: [],
      gates: [
        { key: 'drawdown', label: '回撤≥10%', status: 'pass', metric: '12%', note: '沪深300 vs 60日高点' },
        { key: 'fear', label: '普跌>70%', status: 'pass', metric: '78%', note: '板块普跌日占比' },
        { key: 'pe', label: 'PE<20%ile', status: 'pass', metric: '15%', note: '中证500 PE 分位' }
      ],
      strategy: 'bear',
      weeklyDCA: {  // 定投信号
        active: true,
        targets: [
          { code: '510500', name: '中证500 ETF', amount: '月预算 1/8' },
          { code: '510300', name: '沪深300 ETF', amount: '月预算 1/8' }
        ],
        pauseIfDrawdownOver: -0.08  // 月度 -8% 熔断停投
      },
      message: '🐻 熊市: 仓位 ×0.0 (空仓合法), 启动每周定投 ETF。触及月度 -8% 熔断则停投。',
      stats: { sectorScanned: 10, stockScanned: pool.length, finalCandidates: 0, ms: 120 }
    };
  }
};

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.StrategyBear = BearStrategy;