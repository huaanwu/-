/**
 * Core.StateMatrix — 二维状态机矩阵 (P3.2)
 *
 * 维度 1 (价): Regime.state = bull / range / bear
 * 维度 2 (宏): Cycle.threeStage = offensive / stalemate_bull / stalemate_bear / defensive
 *
 * 输出: positionScale (0-1), 即建议仓位比例
 * 设计原则:
 *   - 价 × 时 二维覆盖 12 格, 但实际上仅 6 格有真实意义 (其余 conflict 报警)
 *   - bull × offensive = 重仓 (0.9)
 *   - bull × defensive = 中等警惕 (0.5, 警惕泡沫)
 *   - range × stalemate_bull = 均衡 (0.5)
 *   - range × stalemate_bear = 谨慎 (0.3)
 *   - bear × stalemate = 轻仓 (0.2)
 *   - bear × defensive = 空仓 (0.1)
 *   - 冲突格 (bull × stalemate_bear 等) 走中间值 + warning
 *
 * 暴露:
 *   Core.StateMatrix.getPositionScale() → 同步拉 Regime + Cycle → 仓位 + 冲突报警
 *   Core.StateMatrix.MATRIX (调试)
 *   Core.StateMatrix.formatForPrompt() → LLM 注入文本
 *
 * 加载顺序: 必须在 Core.Regime + Core.Cycle + Core.Storage 之后
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  const MATRIX = {
    'bull|offensive':       { scale: 0.9, name: '趋势反攻', conflict: false, tactics: '重仓趋势股, 让利润奔跑' },
    'bull|stalemate_bull':  { scale: 0.7, name: '趋势相持偏多', conflict: false, tactics: '均衡配置, 偏多' },
    'bull|stalemate_bear':  { scale: 0.5, name: '价牛宏空', conflict: true, tactics: '警惕泡沫, 收紧到 50%' },
    'bull|defensive':       { scale: 0.5, name: '价牛宏防御', conflict: true, tactics: '警惕泡沫 + 流动性陷阱' },
    'range|offensive':      { scale: 0.6, name: '震荡反攻', conflict: false, tactics: '逢低吸纳, 板块轮动' },
    'range|stalemate_bull': { scale: 0.5, name: '震荡相持偏多', conflict: false, tactics: '均衡配置' },
    'range|stalemate_bear': { scale: 0.3, name: '震荡相持偏空', conflict: false, tactics: '观望为主, 试探建仓' },
    'range|defensive':      { scale: 0.25, name: '震荡防御', conflict: false, tactics: '防御为主, 等突破' },
    'bear|offensive':       { scale: 0.4, name: '熊市反攻', conflict: true, tactics: '反弹末期不追, 落袋为安' },
    'bear|stalemate_bull':  { scale: 0.3, name: '熊市相持偏多', conflict: true, tactics: '弱势反弹, 小仓位试探' },
    'bear|stalemate_bear':  { scale: 0.2, name: '熊市相持偏空', conflict: false, tactics: '轻仓观望' },
    'bear|defensive':       { scale: 0.1, name: '熊市防御', conflict: false, tactics: '空仓/现金为王' }
  };

  /** 把 Regime.state + Cycle.threeStage 合成 key */
  function _key(regime, cycle) {
    return `${regime || 'range'}|${cycle || 'stalemate_bear'}`;
  }

  /**
   * 主入口: 同步拉 Regime + Cycle → 仓位 + 冲突报警
   * @returns {Promise<{
   *   positionScale: number,
   *   name: string,
   *   tactics: string,
   *   conflict: boolean,
   *   warning: string|null,
   *   regime: string,
   *   cycleStage: string,
   *   _ok: boolean
   * }>}
   */
  async function getPositionScale() {
    let regime = 'range';
    let cycleStage = 'stalemate_bear';
    let cycleOk = false;

    try {
      const r = await Core.Regime.get();
      regime = r.state || 'range';
    } catch (e) {
      console.warn('[StateMatrix] Regime 拉取失败:', e.message || e);
    }

    try {
      const c = await Core.Cycle.getCyclePosition();
      cycleStage = c.threeStage || 'stalemate_bear';
      cycleOk = c._ok;
    } catch (e) {
      console.warn('[StateMatrix] Cycle 拉取失败:', e.message || e);
    }

    const k = _key(regime, cycleStage);
    const cell = MATRIX[k] || MATRIX['range|stalemate_bear'];  // 兜底

    const result = {
      positionScale: cell.scale,
      name: cell.name,
      tactics: cell.tactics,
      conflict: cell.conflict,
      warning: cell.conflict
        ? `⚠️ 价×时冲突: 价=${regime} 但宏观=${cycleStage}, 走中间值, 提高警觉`
        : null,
      regime,
      cycleStage,
      _ok: cycleOk,
      _generatedAt: Date.now()
    };

    return result;
  }

  /** LLM 注入文本 */
  function formatForPrompt(position) {
    if (!position) return '';
    const lines = [];
    lines.push('## 价×时状态矩阵');
    lines.push(`- **当前**: ${position.name}`);
    lines.push(`- **建议仓位**: ${(position.positionScale * 100).toFixed(0)}%`);
    lines.push(`- **战术**: ${position.tactics}`);
    lines.push(`- **价**: ${position.regime} | **时**: ${position.cycleStage}`);
    if (position.warning) lines.push(`- ${position.warning}`);
    return lines.join('\n');
  }

  window.Core.StateMatrix = {
    MATRIX,
    getPositionScale,
    formatForPrompt,
    _key
  };
})();