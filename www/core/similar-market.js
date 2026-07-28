/**
 * Core.SimilarMarket - 历史相似行情 RAG (Phase P1-4)
 *
 * 用途: 给 LLM 注入"当前 X 天的行情形态, 在历史上 X 次出现过, 后续 5 日平均涨 Y%"
 *   - 帮助 LLM 看长尾情境 (类似回测前置, 但轻量级: 无需启 worker, 仅 Pearson 算相似)
 *   - 给 AI 短线操盘手 / 选股 / 单股简评 提供"经验先验"
 *
 * 设计:
 *   - 输入: code + options ({ days=20, lookAhead=5, topK=3, histWindow=240 })
 *   - 拉近 histWindow+days 根日 K (Core.Data.getStockKLine)
 *   - 特征: 5日% + 量比(5/20) + RSI14 + 20日波动率 (4 维, 标准化)
 *   - 候选: 历史每 (histWindow - days) 个滑窗
 *   - Pearson 算 query vs candidate 相似度 (向量化 + 跳过 NaN)
 *   - topK 段后续 lookAhead 日平均收益
 *   - 返 { available, querySig, topSegments, summary } 或 null (数据不足)
 *
 * 降级:
 *   - K线拉不到 / < 30 根 → null (不阻塞主流程, 调用方空 prompt 段即可)
 *   - 单点 NaN → 该维度跳过
 */
(function() {
  'use strict';

  const DEFAULT_DAYS = 20;        // query 段长度
  const DEFAULT_LOOKAHEAD = 5;    // 相似段后看 N 日
  const DEFAULT_TOPK = 3;         // 取 top N
  const DEFAULT_HIST_WINDOW = 240;// 历史回看窗口 (近 N 根 K)
  const MIN_BARS = 30;            // 最少需要多少根 K 才能算

  /**
   * 计算 RSI14 (纯函数): 14 日相对强弱指标
   * @param {number[]} closes 升序
   * @returns {number|null} 数据不足返 null
   */
  function _rsi14(closes) {
    if (!Array.isArray(closes) || closes.length < 15) return null;
    let gain = 0, loss = 0;
    // 前 14 个 gain/loss 均值
    for (let i = 1; i <= 14; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gain += diff; else loss -= diff;
    }
    let avgGain = gain / 14;
    let avgLoss = loss / 14;
    // 后续 Wilder 平滑 (调用方用末值, 这里只算尾部一根)
    for (let i = 15; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      const g = diff > 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      avgGain = (avgGain * 13 + g) / 14;
      avgLoss = (avgLoss * 13 + l) / 14;
    }
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - 100 / (1 + rs);
  }

  /**
   * 取某段 K 线的 4 维特征 (纯函数, 任何维度失败该维度 NaN)
   * @param {Array<{close: number, volume: number}>} bars  - 升序
   * @returns {{ret5: number, volRatio: number, rsi14: number, vol20: number}}
   */
  function _featuresOf(bars) {
    if (!Array.isArray(bars) || bars.length < 20) {
      return { ret5: NaN, volRatio: NaN, rsi14: NaN, vol20: NaN };
    }
    const closes = bars.map(b => b.close);
    const volumes = bars.map(b => b.volume || 0);
    const n = closes.length;
    // 5 日 % (末值/5 日前 - 1)
    const ret5 = (n >= 6 && closes[n - 6] > 0)
      ? (closes[n - 1] - closes[n - 6]) / closes[n - 6] : NaN;
    // 量比 = 5 日均量 / 20 日均量
    const last5 = volumes.slice(-5);
    const last20 = volumes.slice(-20);
    const avg5 = last5.reduce((s, v) => s + v, 0) / 5;
    const avg20 = last20.reduce((s, v) => s + v, 0) / 20;
    const volRatio = avg20 > 0 ? avg5 / avg20 : NaN;
    // RSI14
    const rsi = _rsi14(closes);
    // 20 日波动率 = 20 日 returns 标准差
    const rets = [];
    for (let i = 1; i < n; i++) {
      if (closes[i - 1] > 0) rets.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    }
    const tail20 = rets.slice(-20);
    const mean = tail20.reduce((s, v) => s + v, 0) / tail20.length;
    const variance = tail20.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / tail20.length;
    const vol20 = Math.sqrt(variance);
    return {
      ret5: isFinite(ret5) ? ret5 : NaN,
      volRatio: isFinite(volRatio) ? volRatio : NaN,
      rsi14: rsi != null ? rsi : NaN,
      vol20: isFinite(vol20) ? vol20 : NaN
    };
  }

  /**
   * Pearson 相关系数 (纯函数, 跳过 NaN 维度)
   * @param {number[]} a
   * @param {number[]} b
   * @returns {number|null} 任一向量无有效维度 → null
   */
  function _pearson(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return null;
    const pairs = [];
    for (let i = 0; i < a.length; i++) {
      if (isFinite(a[i]) && isFinite(b[i])) pairs.push([a[i], b[i]]);
    }
    if (pairs.length < 2) return null;
    const n = pairs.length;
    const sumA = pairs.reduce((s, p) => s + p[0], 0);
    const sumB = pairs.reduce((s, p) => s + p[1], 0);
    const meanA = sumA / n;
    const meanB = sumB / n;
    let num = 0, denA = 0, denB = 0;
    for (const [x, y] of pairs) {
      const da = x - meanA, db = y - meanB;
      num += da * db;
      denA += da * da;
      denB += db * db;
    }
    const den = Math.sqrt(denA * denB);
    if (den === 0) return null;
    return num / den;
  }

  /**
   * 计算某段后续 lookAhead 日平均收益率 (纯函数, 跳空按开盘)
   * @param {Array<{open, close}>} bars 升序
   * @param {number} endIdx  段末尾下标 (从这段后 lookAhead 日收益)
   * @param {number} lookahead
   * @returns {number|null} 数据不足返 null
   */
  function _forwardReturn(bars, endIdx, lookahead) {
    if (endIdx + lookahead >= bars.length) return null;
    const start = bars[endIdx].close;
    if (start <= 0) return null;
    const end = bars[endIdx + lookahead].close;
    return (end - start) / start;
  }

  /**
   * 主入口: 找历史相似行情
   * @param {string} code 6 位股票代码
   * @param {{ days?: number, lookahead?: number, topK?: number, histWindow?: number,
   *           fetcher?: function }} [opts]
   *   fetcher 默认 = window.Core.Data.getStockKLine (供测试 mock)
   * @returns {Promise<null|{ code, days, lookahead, topK, querySig, topSegments: Array,
   *                          summary: { avgForwardReturn, sampleSize, maxCorr, minCorr },
   *                          generatedAt: string }>}
   */
  async function find(code, opts = {}) {
    if (!code || typeof code !== 'string') return null;
    const days = Math.max(10, parseInt(opts.days) || DEFAULT_DAYS);
    const lookahead = Math.max(1, parseInt(opts.lookahead) || DEFAULT_LOOKAHEAD);
    const topK = Math.max(1, parseInt(opts.topK) || DEFAULT_TOPK);
    const histWindow = Math.max(days + 30, parseInt(opts.histWindow) || DEFAULT_HIST_WINDOW);
    const fetcher = opts.fetcher || (window.Core && window.Core.Data && window.Core.Data.getStockKLine);

    if (typeof fetcher !== 'function') return null;
    let raw;
    try {
      raw = await fetcher(code, 'daily', '', '', 'qfq');
    } catch (e) {
      console.warn('[SimilarMarket] 拉 K 线失败, 降级 null:', e && e.message);
      return null;
    }
    const bars = (Array.isArray(raw) ? raw : [])
      .map(d => ({
        date: d.日期 || d.date,
        open: parseFloat(d.开盘 || d.open),
        close: parseFloat(d.收盘 || d.close),
        volume: parseFloat(d.成交量 || d.volume || 0)
      }))
      .filter(b => isFinite(b.close) && b.close > 0);
    if (bars.length < MIN_BARS) return null;

    // query 段 = 末 days 根
    const queryBars = bars.slice(-days);
    const querySig = _featuresOf(queryBars);
    const queryVec = [querySig.ret5, querySig.volRatio, querySig.rsi14, querySig.vol20];

    // 候选 = histWindow 范围内每个 days 滑窗 (前 histWindow-days 根)
    const candidates = [];
    const startBound = Math.max(0, bars.length - histWindow);  // 历史窗口起点
    const endBound = bars.length - days - lookahead;            // 留 lookAhead 给后续测
    for (let i = startBound; i <= endBound; i++) {
      const segBars = bars.slice(i, i + days);
      const segSig = _featuresOf(segBars);
      const segVec = [segSig.ret5, segSig.volRatio, segSig.rsi14, segSig.vol20];
      const corr = _pearson(queryVec, segVec);
      if (corr == null || !isFinite(corr)) continue;
      const fwd = _forwardReturn(bars, i + days - 1, lookahead);
      candidates.push({
        endIdx: i + days - 1,
        endDate: bars[i + days - 1].date,
        corr: +corr.toFixed(4),
        fwdReturn: fwd != null ? +fwd.toFixed(4) : null
      });
    }
    if (!candidates.length) return null;

    // 按 corr 降序
    candidates.sort((a, b) => b.corr - a.corr);
    const top = candidates.slice(0, topK);
    const withFwd = top.filter(c => c.fwdReturn != null);
    const avgFwd = withFwd.length
      ? +(withFwd.reduce((s, c) => s + c.fwdReturn, 0) / withFwd.length).toFixed(4)
      : null;
    const summary = {
      avgForwardReturn: avgFwd,
      sampleSize: candidates.length,
      usedSize: withFwd.length,
      maxCorr: top.length ? top[0].corr : null,
      minCorr: top.length ? top[top.length - 1].corr : null
    };
    const today = new Date();
    const pad = n => String(n).padStart(2, '0');
    const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    return {
      code, days, lookahead, topK,
      querySig,
      topSegments: top,
      summary,
      generatedAt: todayStr
    };
  }

  /** 格式化 → 注入 prompt 的中文短文 (≤ 200 字), null → 返空串 */
  function formatForPrompt(rec) {
    if (!rec) return '';
    const parts = [];
    const s = rec.summary || {};
    const fwdText = s.avgForwardReturn != null
      ? `后续 ${rec.lookahead} 日平均 ${(s.avgForwardReturn * 100).toFixed(2)}%`
      : '后续收益样本不足';
    parts.push(`【历史相似】${rec.code} 近 ${rec.days} 日形态在近 ${s.sampleSize} 段历史中匹配, ${fwdText} (top${rec.topK} 相似度 ${s.minCorr} ~ ${s.maxCorr})`);
    if (rec.topSegments && rec.topSegments.length) {
      const dates = rec.topSegments.map(t => t.endDate).filter(Boolean);
      if (dates.length) parts.push('相似段: ' + dates.join(' / '));
    }
    return parts.join('\n');
  }

  window.Core = window.Core || {};
  window.Core.SimilarMarket = {
    find,
    formatForPrompt,
    _featuresOf,
    _pearson,
    _rsi14,
    _forwardReturn
  };
})();
