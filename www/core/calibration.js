/**
 * Core.Calibration - 概率校准反向注入 (H2)
 *
 * 把历史的 (LLM 自评胜率 → 实际结果) 对照渲染成 prompt 段,
 * 让 LLM 下次报 probability 时能看到自己的偏差。
 *
 * 数据源: short-trader._calibrationBuckets(pairs) → Array<{label, n, predMean, hitRate}>
 *   - label: '0-40%' / '40-60%' / '60-80%' / '80-100%'
 *   - n: 样本数
 *   - predMean: 该桶 LLM 自评胜率均值
 *   - hitRate: 该桶实际命中率 (0-1)
 *
 * 渲染规则:
 *   - 总样本 < minSamples (默认 5) → 返 null (不渲染, 避免误导)
 *   - 偏差 |predMean - hitRate| ≥ 10pp → 标"系统性高估"/"系统性低估"
 *   - 偏差 < 10pp → 标"基本校准"
 *
 * 设计原则:
 *   - 纯函数 (Node 可测)
 *   - 样本不足时不渲染 (用户决策: 不要让 LLM 看 3 笔的结论)
 *   - 失败兜底返 null (不影响主流程)
 */
(function() {
  'use strict';
  window.Core = window.Core || {};

  // 系统性偏差阈值: 偏差 ≥ 10pp 标 "高估/低估"
  const BIAS_THRESHOLD_PP = 10;

  /**
   * 渲染校准偏差段 (纯函数)
   * @param {Array<{label: string, n: number, predMean: number, hitRate: number}>} buckets
   *   - buckets 来自 short-trader._calibrationBuckets(pairs)
   * @param {number} [minSamples=5] - 最少样本数门槛
   * @returns {string|null} 渲染好的 prompt 段; 样本不足返 null
   */
  function _formatCalibrationPrompt(buckets, minSamples = 5) {
    if (!Array.isArray(buckets) || buckets.length === 0) return null;
    const totalN = buckets.reduce((s, b) => s + (Number(b.n) || 0), 0);
    if (totalN < minSamples) return null;

    const lines = [];
    lines.push(`【你的概率校准偏差】(基于 ${totalN} 笔已验证交易, ${minSamples}+ 样本才显示)`);
    lines.push('| 自评区间 | 样本 | 自评均值 | 实际命中 | 偏差 |');
    lines.push('|---|---|---|---|---|');
    let overCount = 0, underCount = 0, calCount = 0;
    for (const b of buckets) {
      const n = Number(b.n) || 0;
      if (n <= 0) continue;
      const predMean = Number(b.predMean) || 0;
      const hitRate = (Number(b.hitRate) || 0) * 100;
      const bias = hitRate - predMean;
      const biasStr = (bias >= 0 ? '+' : '') + bias.toFixed(1) + 'pp';
      lines.push(`| ${b.label} | ${n} | ${predMean.toFixed(0)}% | ${hitRate.toFixed(0)}% | ${biasStr} |`);
      if (Math.abs(bias) >= BIAS_THRESHOLD_PP) {
        if (bias < 0) overCount++; else underCount++;
      } else {
        calCount++;
      }
    }
    lines.push('');
    // 总体偏差结论
    if (overCount > underCount && overCount > calCount) {
      lines.push('⚠ **你系统性高估胜率**: 报 X% 实际只中 < X%。下次报 probability 时按实际命中率下调一档。');
    } else if (underCount > overCount && underCount > calCount) {
      lines.push('⚠ **你系统性低估胜率**: 报 X% 实际能中 > X%。下次报 probability 时可上调一档。');
    } else if (calCount >= overCount && calCount >= underCount) {
      lines.push('✓ 你的胜率自评基本校准, 偏差均在 ±' + BIAS_THRESHOLD_PP + 'pp 内, 按真实信心报即可。');
    } else {
      lines.push('样本分布不均, 建议保守报 probability, 不要激进给 80% 以上。');
    }
    return lines.join('\n');
  }

  window.Core.Calibration = {
    BIAS_THRESHOLD_PP,
    _formatCalibrationPrompt
  };
})();