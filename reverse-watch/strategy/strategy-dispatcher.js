// ============== StrategyDispatcher · 状态 → 策略路由 ==============
// 依 RegimeDetector 输出 + 冷却规则选定唯一 Strategy, 并记录切换日志。
// 第一阶段: 默认返回 RangeStrategy, 行为跟现有 reverse-watch 100% 一致。
// 持仓层 (HoldingRules) 不读 regime, 任何策略下止盈/止损照常生效 — 状态切换只影响新候选。

const STRATEGIES = {
  bull: () => window.ReverseWatch.StrategyBull,
  bear: () => window.ReverseWatch.StrategyBear,
  range: () => window.ReverseWatch.StrategyRange
};

function pickStrategy(regime) {
  if (!regime) return STRATEGIES.range();
  // range_weak / range_strong 都用 RangeStrategy (它在内部根据 subRange 调整)
  if (regime.startsWith('range')) return STRATEGIES.range();
  if (regime === 'bull') return STRATEGIES.bull();
  if (regime === 'bear') return STRATEGIES.bear();
  return STRATEGIES.range();
}

// 主入口: 给定池子 + 今日 regime, 返回统一格式的输出
async function runOnce(pool, regimeOpt) {
  const regime = regimeOpt || (window.ReverseWatch.RegimeDetector.getTodayRegime
    ? window.ReverseWatch.RegimeDetector.getTodayRegime()
    : null);
  const strategy = pickStrategy(regime?.regime);
  const result = await strategy.run(pool, regime);
  // 注入 regime 信息到结果顶层
  result.regime = regime;
  result.positionMultiplier = strategy.positionMult;
  result.strategyName = strategy.name;
  // 4 池快照: Range 复用现有 buildPools; Bull/Bear 返回各自语境下的池子
  const rw = window.ReverseWatch || {};
  // State #3 修: bear 下不跑 reverseScreener + buildPools, 真正空仓 (4 池为空)
  // 只读池子做诊断 (跟持仓相关的已有底仓), 但不生成新候选
  if (regime?.regime === 'bear') {
    result.pools = { base: [], dragon: [], proxy: [], trap: [] };
    result.candidates = [];
    result.gates = [];
    return result;
  }
  if (rw.buildPools && rw.runReverseScreener && rw.mulberry32) {
    const seed = (rw.dailySeed ? rw.dailySeed() : Date.now()) + 1;
    const rng = rw.mulberry32(seed);
    const screened = rw.runReverseScreener(pool, rng);
    const { passed, blocked } = screened || {};
    if (passed && blocked) {
      result.pools = rw.buildPools(passed, blocked);
    }
  }
  if (!result.pools) {
    // 兜底: app.js 还没暴露 buildPools 时, 给一个空骨架, 上层 renderPools 能容错
    result.pools = { base: [], dragon: [], proxy: [], trap: [] };
  }
  // 状态切换日志 (顶层调用方读 result.regimeHistory)
  result.regimeHistory = JSON.parse(localStorage.getItem('_rw_regime_history') || '[]');
  return result;
}

// 暴露给现有 app.js 的兼容入口: 第一阶段直接返回 Range 结果, 行为不变
function runLegacy(pool) {
  const result = runOnce(pool, { regime: 'range_weak', d1: 0, d2: 'weak', d3: 0, sum: 0, confidence: 0.5, hint: 'legacy default (range_weak)' });
  return result;
}

window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.Dispatcher = { runOnce, runLegacy, pickStrategy };