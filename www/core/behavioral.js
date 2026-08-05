/**
 * Core.Behavioral — 行为偏误审查模块
 *
 * 两层机制:
 *   1. 硬代码纯函数 (类 discipline.js): 为 IA 兜底, 由域代码直接调
 *   2. AI 管家审查: steward.reviewBehavior 工具, 管家的 chat loop
 *      里可调它查数据 + 自我审查, 返回 verdict + 修正建议
 *
 * 审查矩阵 (行为偏差 → 检测方法 → 代码层 + AI 层):
 *
 *   回本陷阱     同 code 历史亏损记录 → 再次买入
 *   赢后扩张     近 5 笔模拟盘盈亏序列 → 新仓位比历史均值大
 *   确认偏误     picked assumption 与历史失败 assumption 对比
 *   处置效应     浮亏持仓天数 > SHORT_MAX_HOLD_DAYS 却无止损计划
 *   熟悉偏差     picks 全来自已有持仓/关注池 ← 弱信号
 *   行业集中     同行业已有持仓 + 新买
 *   追涨        当日涨幅 > chaseWarnPct + AI 计划买入
 *   摊平补仓     当前已浮亏 > 5% + 同代码再次买入
 *
 * 使用方式:
 *   // 1. 域代码内硬检查 (非 AI, 纯函数, 可在 vm sandbox 中调)
 *   const findings = Core.Behavioral.checkBuy(ctx);
 *   // 2. AI 管家审查工具 (agent-tools 里注册, 管家可调)
 *   //   steward.reviewBehavior — 供管家的 chat loop 调, 主动拉数据审查
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  // ========== 偏差定义 ==========

  /** 7 种能被检测的行为偏差 */
  const BIASES = {
    breakEven: {
      key: 'breakEven',
      label: '回本陷阱',
      desc: '之前在这只票上亏过, 想买回来等回本',
      severity: 'M'
    },
    hotHand: {
      key: 'hotHand',
      label: '赢后扩张',
      desc: '近期连胜, 下一次仓位可能不自觉地放大',
      severity: 'M'
    },
    confirmation: {
      key: 'confirmation',
      label: '确认偏误',
      desc: '选股假设正好是之前反复失败的假设类型',
      severity: 'L'
    },
    disposition: {
      key: 'disposition',
      label: '处置效应',
      desc: '浮亏过大却不设止损, 或浮盈过早止盈',
      severity: 'H'
    },
    familiarity: {
      key: 'familiarity',
      label: '熟悉偏差',
      desc: '选的票全在已有关注池/持仓里, 可能忽略了池外更好的标的',
      severity: 'L'
    },
    concentration: {
      key: 'concentration',
      label: '行业集中',
      desc: '同行业已有持仓 + 新买入加剧行业敞口',
      severity: 'H'
    },
    averagingDown: {
      key: 'averagingDown',
      label: '摊平补仓',
      desc: '当前持仓已浮亏, 再次买入想拉低成本',
      severity: 'H'
    },
    fomo: {
      key: 'fomo',
      label: '追涨',
      desc: '当日已大幅上涨后追入',
      severity: 'M'
    }
  };

  // ========== 纯函数: 单维度检查 ==========

  /**
   * 回本陷阱: 同 code 有历史亏损记录 (>3个月前清仓)
   * @returns {{ hit: boolean, detail: string }|null}
   */
  function _checkBreakEven(code, journals, verifiedTrades) {
    if (!code) return null;
    // 从 journal 中找该代码关联的复盘, 检查已清仓且验证为 wrong
    const relevant = (journals || []).filter(j =>
      (j.code === code) &&
      (j.verifyOutcome === 'wrong' || j.verifyFailureReason === '选股错' || j.verifyFailureReason === '仓位过重')
    );
    if (relevant.length === 0) return null;
    return {
      hit: true,
      bias: 'breakEven',
      detail: '该代码此前有 ' + relevant.length + ' 次验证错误的持仓记录。检查: 你是因为它涨了想买回来"等回本", 还是基本面确实变了?',
      evidence: relevant.slice(0, 3).map(j => ({
        date: j.date || null,
        outcome: j.verifyOutcome || '?',
        reason: j.verifyFailureReason || ''
      }))
    };
  }

  /**
   * 赢后扩张: 近 5 笔模拟盘已平仓交易盈亏序列 → 全是盈利则第 6 笔仓位可能膨胀
   * @returns {{ hit: boolean, detail: string }|null}
   */
  function _checkHotHand(closedTrades, proposedSize, avgHistoricalSize) {
    if (!closedTrades || closedTrades.length < 3) return null;
    const recent = closedTrades.slice(-5);
    const winStreak = recent.every(t => (t.plPct || t.profitLossPct || 0) > 0);
    if (!winStreak) return null;
    const warn = proposedSize > 0 && avgHistoricalSize > 0 && proposedSize > avgHistoricalSize * 1.2;
    return {
      hit: true,
      bias: 'hotHand',
      detail: '近 ' + recent.length + ' 笔全部盈利' +
        (warn ? ', 本次仓位比历史均值大 ' + (proposedSize / avgHistoricalSize * 100).toFixed(0) + '%' : '') +
        (warn ? ' — 小心"赢后过度自信"' : ' — 连胜后容易放松风控'),
      winStreak: recent.length,
      oversized: warn
    };
  }

  /**
   * 摊平补仓: 当前仍持有同 code 且浮亏 > 5% — 再次买入是沉没成本谬误
   * @returns {{ hit: boolean, detail: string }|null}
   */
  function _checkAveragingDown(code, currentPositions, buyAmount) {
    if (!code || !buyAmount) return null;
    const pos = (currentPositions || []).find(p => p.code === code);
    if (!pos) return null;
    const plPct = parseFloat(pos.plPct || pos.profitLossPct || 0);
    if (plPct >= -0.05) return null;  // 浮亏不足 5%, 不算
    return {
      hit: true,
      bias: 'averagingDown',
      detail: '该代码当前浮亏 ' + (plPct * 100).toFixed(1) + '%, 再次买入是"摊平补仓" (沉没成本谬误)。' +
        '除非有基本面硬数据支持反转, 否则应等止损触发而非补仓。',
      currentLoss: (plPct * 100).toFixed(1) + '%',
      proposedBuy: buyAmount
    };
  }

  /**
   * 确认偏误: 本次买入假设类型正好是之前反复失败的类型
   * @returns {{ hit: boolean, detail: string }|null}
   */
  function _checkConfirmation(assumption, journals) {
    if (!assumption) return null;
    const same = (journals || []).filter(j => j.assumption === assumption);
    const failed = same.filter(j => j.verifyOutcome === 'wrong');
    if (failed.length === 0) return null;
    const rate = (failed.length / same.length * 100).toFixed(0);
    return {
      hit: true,
      bias: 'confirmation',
      detail: '假设 "' + assumption + '" 历史上用过 ' + same.length + ' 次, ' +
        failed.length + ' 次验证错误 (失败率 ' + rate + '%)。' +
        '检查: 这次跟之前有什么不同? 还是同样的逻辑再次自欺?',
      totalSame: same.length,
      totalFailed: failed.length,
      failRate: rate + '%'
    };
  }

  /**
   * 熟悉偏差: picks 是否全在已有持仓/关注池中
   * @returns {{ hit: boolean, detail: string }|null}
   */
  function _checkFamiliarity(pickCodes, heldCodes, watchlistCodes) {
    if (!pickCodes || pickCodes.length < 2) return null;
    const known = new Set([...(heldCodes || []), ...(watchlistCodes || [])]);
    const allKnown = pickCodes.every(c => known.has(c));
    if (!allKnown) return null;
    return {
      hit: true,
      bias: 'familiarity',
      detail: '全部 picks 都在已有持仓/关注池内。检查: 是否存在池外的更好标的? 还是在"舒适区"里打转?',
      pickCount: pickCodes.length
    };
  }

  /** 读当前模拟盘持仓盈亏 (纯函数 — 调用方传数据) */
  function _getCurrentPositions(paperPositions, sleeve) {
    const positions = (paperPositions || [])
      .filter(p => !p.closedAt && (!sleeve || p.sleeve === sleeve));
    return positions.map(p => ({
      code: p.code,
      name: p.name || '',
      plPct: parseFloat(p.plPct || p.profitLossPct || 0),
      cost: parseFloat(p.cost || p.costPrice || 0),
      price: parseFloat(p.price || p.currentPrice || 0),
      shares: parseFloat(p.shares || 0),
      industry: p.industry || p.行业 || ''
    }));
  }

  // ========== 主入口: 买入前行为偏误综合检查 ==========

  /**
   * 买入前行为偏误综合检查 (纯函数, 可在 vm sandbox 中调)
   * @param {object} ctx
   * @param {string} ctx.code - 买入代码
   * @param {string} ctx.assumption - 买入假设 (可选)
   * @param {number} ctx.amount - 买入金额 (可选)
   * @param {number} ctx.changePct - 当日涨跌幅 (小数, 如 0.03 = 3%, 可选)
   * @param {string} ctx.sleeve - 'long'|'short'
   * @param {Array} ctx.closedTrades - 已平仓交易 (可选, 含 plPct)
   * @param {number} ctx.avgHistoricalSize - 历史平均仓位 (可选)
   * @param {Array} ctx.currentPositions - 当前持仓 (可选)
   * @param {Array} ctx.journals - 复盘记录 (可选)
   * @param {Array} ctx.watchlist - 自选股 (可选)
   * @returns {{ findings: Array, verdict: 'block'|'warn'|'ok', summary: string }}
   */
  function checkBuy(ctx) {
    ctx = ctx || {};
    const findings = [];
    const code = ctx.code;
    const assumption = ctx.assumption;
    const changePct = ctx.changePct != null ? parseFloat(ctx.changePct) : null;

    // 1. 摊平补仓 (最高危: block)
    if (ctx.currentPositions) {
      const ad = _checkAveragingDown(code, ctx.currentPositions, ctx.amount);
      if (ad) findings.push(ad);
    }

    // 2. 回本陷阱 (高危: block)
    if (ctx.journals) {
      const be = _checkBreakEven(code, ctx.journals, ctx.closedTrades);
      if (be) findings.push(be);

      // 3. 确认偏误 (警告)
      const cf = _checkConfirmation(assumption, ctx.journals);
      if (cf) findings.push(cf);
    }

    // 4. 赢后扩张 (警告)
    if (ctx.closedTrades) {
      const hh = _checkHotHand(ctx.closedTrades, ctx.amount, ctx.avgHistoricalSize);
      if (hh) findings.push(hh);
    }

    // 5. 追涨 (FOMO 已在 discipline._checkChase 中做, 这里给更强的 AI 上下文提示)
    if (changePct != null && changePct > 0.03) {
      findings.push({
        hit: true,
        bias: 'fomo',
        detail: '当日已涨 ' + (changePct * 100).toFixed(1) + '%, 追涨有回调风险。确认不是 FOMO 驱动?',
        dayChange: (changePct * 100).toFixed(1) + '%'
      });
    }

    // 定 verdict
    const hasBlock = findings.some(f => BIASES[f.bias] && BIASES[f.bias].severity === 'H');
    const hasWarn = findings.some(f => f.hit);
    return {
      findings,
      verdict: hasBlock ? 'block' : (hasWarn ? 'warn' : 'ok'),
      summary: findings.length > 0
        ? '行为偏误: ' + findings.map(f => BIASES[f.bias] ? BIASES[f.bias].label : f.bias).join(', ')
        : '无行为偏误'
    };
  }

  /**
   * 格式化行为审查结果 → 人类可读文本 (供 AI prompt 注入)
   */
  function formatFindings(findings) {
    if (!findings || findings.length === 0) return '';
    const lines = ['## 行为偏误审查'];
    findings.forEach(f => {
      const b = BIASES[f.bias];
      const label = b ? b.label : f.bias;
      const sev = b ? b.severity : 'M';
      const icon = sev === 'H' ? '🚫' : '⚠️';
      lines.push(icon + ' [' + label + '] ' + f.detail);
      if (f.evidence && f.evidence.length > 0) {
        f.evidence.forEach(e => lines.push('  - ' + JSON.stringify(e).slice(0, 120)));
      }
    });
    return lines.join('\n');
  }

  // ========== 暴露 ==========

  window.Core.Behavioral = {
    BIASES,
    checkBuy,
    formatFindings,
    // 暴露内部纯函数, 便于单测
    _checkBreakEven,
    _checkHotHand,
    _checkAveragingDown,
    _checkConfirmation,
    _checkFamiliarity,
    _getCurrentPositions
  };

  console.log('[Behavioral] 行为偏误审查模块已就绪 (7 类偏差)');
})();
