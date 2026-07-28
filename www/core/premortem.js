/**
 * Core.Premortem - AI 建议 pre-mortem (事前验尸) 字段工具 (Phase D1)
 *
 * 对 AI 选股/选基 picks 强制四个字段:
 *   bullCase         看多理由 (≤2 条)
 *   bearCase         看空理由 (≤2 条, 必填, 禁止"无明显风险"空话)
 *   falsifyCondition 证伪条件 ("出现什么情况说明我错了", 具体可观测)
 *   invalidation     失效条件/时间 (多久没兑现就该放弃)
 *
 * 用法:
 *   - prompt: 把 Core.Premortem.PROMPT_SPEC 拼进 systemPrompt 的 JSON schema 说明
 *   - 校验: parseJsonOutput 通过后, 再跑 Core.Premortem.checkPicks(picks),
 *           有错误则沿用 Phase T 降级模式 (警告 + 原始输出)
 *   - 渲染: Core.Premortem.renderBlock(pick) → 四象限小区块 HTML (全部转义)
 */
(function() {
  'use strict';

  const FIELDS = ['bullCase', 'bearCase', 'falsifyCondition', 'invalidation'];
  const FIELD_LABELS = {
    bullCase: '看多理由',
    bearCase: '看空理由',
    falsifyCondition: '证伪条件',
    invalidation: '失效条件'
  };

  // bearCase 空话黑名单 (prompt 里也明确禁止, 这里兜底校验)
  const EMPTY_TALK_RE = /无明显风险|暂无(明显)?风险|没有(明显)?风险|无风险|风险不大/;

  // 拼进 systemPrompt 的字段说明 (screener / ai-advisor 共用, 保持口径一致)
  const PROMPT_SPEC = [
    '"bullCase": ["看多理由 1 (≤2 条, 引用具体数据)"],',
    '"bearCase": ["看空理由 1 (≤2 条, 必填! 禁止"无明显风险/暂无风险"这类空话, 必须写具体风险)"],',
    '"falsifyCondition": "证伪条件: 出现什么情况说明这个判断错了 (具体可观测, 如"跌破 20 日线且放量"/"季报净利润增速 <10%")",',
    '"invalidation": "失效条件/时间: 多久没兑现就该放弃 (如"2 周内未突破 X 元")"'
  ].join('\n      ');

  // escapeHtml 兜底: 优先 Core.Util.escapeHtml (浏览器已加载), 否则内置最简转义 (测试沙箱用)
  function _esc(s) {
    if (window.Core && window.Core.Util && typeof window.Core.Util.escapeHtml === 'function') {
      return window.Core.Util.escapeHtml(s);
    }
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // 字段归一化成字符串数组 (LLM 可能给字符串或数组)
  function _asList(v) {
    if (Array.isArray(v)) return v.map(x => String(x == null ? '' : x).trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return [v.trim()];
    return [];
  }

  /**
   * 校验单个 pick 的 pre-mortem 字段
   * @param {object} pick AI 返回的单条建议
   * @param {number} [idx] 在 picks 数组里的下标 (错误信息用)
   * @returns {string[]} 错误列表, 空数组 = 通过
   */
  function checkPick(pick, idx) {
    const errs = [];
    const tag = (idx != null ? `picks[${idx}]` : 'pick') + (pick && pick.code ? `(${pick.code})` : '');
    if (!pick || typeof pick !== 'object') return [`${tag}: 不是对象`];
    if (_asList(pick.bullCase).length === 0) errs.push(`${tag} 缺 bullCase (看多理由)`);
    const bears = _asList(pick.bearCase);
    if (bears.length === 0) {
      errs.push(`${tag} 缺 bearCase (看空理由, 必填)`);
    } else if (bears.some(b => EMPTY_TALK_RE.test(b))) {
      errs.push(`${tag} bearCase 含空话 ("无明显风险"类表述不允许)`);
    }
    if (typeof pick.falsifyCondition !== 'string' || !pick.falsifyCondition.trim()) {
      errs.push(`${tag} 缺 falsifyCondition (证伪条件)`);
    }
    if (typeof pick.invalidation !== 'string' || !pick.invalidation.trim()) {
      errs.push(`${tag} 缺 invalidation (失效条件)`);
    }
    return errs;
  }

  /**
   * 校验 picks 数组, 聚合全部错误
   * @param {Array} picks
   * @returns {string[]} 空数组 = 全部通过
   */
  function checkPicks(picks) {
    if (!Array.isArray(picks)) return ['picks 不是数组'];
    const errs = [];
    picks.forEach((p, i) => errs.push(...checkPick(p, i)));
    return errs;
  }

  /**
   * 渲染四象限小区块 HTML (全部 escapeHtml; 无字段时返空串)
   * 风格对齐 .ai-pick 卡片: var(--bg-base) 底 + 小字
   */
  function renderBlock(pick) {
    if (!pick || typeof pick !== 'object') return '';
    const bulls = _asList(pick.bullCase).slice(0, 2);
    const bears = _asList(pick.bearCase).slice(0, 2);
    const falsify = typeof pick.falsifyCondition === 'string' ? pick.falsifyCondition.trim() : '';
    const invalidation = typeof pick.invalidation === 'string' ? pick.invalidation.trim() : '';
    if (bulls.length === 0 && bears.length === 0 && !falsify && !invalidation) return '';

    const cell = (icon, label, color, inner) =>
      `<div style="flex:1 1 45%;min-width:140px;background:var(--bg-base);border-radius:4px;padding:6px 8px;">` +
      `<div style="font-size:11px;color:${color};margin-bottom:2px;">${icon} ${label}</div>` +
      `<div style="font-size:12px;line-height:1.5;">${inner}</div></div>`;
    const listHtml = (arr) => '<ul style="margin:0;padding-left:16px;">' +
      arr.map(x => `<li>${_esc(x)}</li>`).join('') + '</ul>';

    return `<div class="ai-premortem" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">` +
      cell('📈', '看多', 'var(--up)', bulls.length ? listHtml(bulls) : '-') +
      cell('📉', '看空', 'var(--down)', bears.length ? listHtml(bears) : '-') +
      cell('🔬', '证伪条件', 'var(--text-muted)', falsify ? _esc(falsify) : '-') +
      cell('⏳', '失效条件', 'var(--text-muted)', invalidation ? _esc(invalidation) : '-') +
      `</div>`;
  }

  // ============== P1: Pre-mortem 事后验证 ==============

  /**
   * 用 K 线数据机械验证 falsifyCondition (纯函数)
   * 支持模式:
   *   "跌破 X 元" → 观察窗内最低价 ≤ X
   *   "跌超 X%"  → 从入场到观察窗结束浮亏 ≥ X%
   *   其他文本 → 用实际 PnL 兜底 (正→correct, 负→wrong)
   *
   * @param {string} falsifyCondition LLM 填的证伪条件文本
   * @param {number} entryPrice 入场价
   * @param {Array<{low:number,high:number,close:number}>} windowKlines 观察窗 K 线 (至少含入场后 1 根)
   * @returns {{ triggered: boolean, confidence: 'high'|'low', detail: string }}
   *   triggered=true → 证伪条件触发 (判断错误); false → 条件未触发 (判断正确或待观察)
   *   confidence=high → 精确匹配; low → PnL 兜底
   */
  function verifyFalsifyCondition(falsifyCondition, entryPrice, windowKlines) {
    if (!falsifyCondition || !entryPrice || !Array.isArray(windowKlines) || windowKlines.length < 1) {
      return { triggered: false, confidence: 'low', detail: '数据不足, 跳过验证' };
    }
    const text = String(falsifyCondition).trim();
    // 1) 精确模式: "跌破 X 元" (含 X 的数值)
    const priceMatch = text.match(/(?:跌破|低于|下破|击穿)\s*(\d+\.?\d*)/);
    if (priceMatch) {
      const threshold = parseFloat(priceMatch[1]);
      const lows = windowKlines.map(k => k.low).filter(l => l > 0);
      if (lows.length && threshold > 0) {
        const minLow = Math.min(...lows);
        if (minLow <= threshold) {
          return { triggered: true, confidence: 'high', detail: `精准: 最低 ${minLow} ≤ 阈值 ${threshold} (${priceMatch[1]})` };
        }
        return { triggered: false, confidence: 'high', detail: `精准: 最低 ${minLow} > 阈值 ${threshold}, 条件未触发` };
      }
    }
    // 2) 百分比模式: "跌超 X%"
    const pctMatch = text.match(/(?:跌|回撤|下跌)[超幅约]?\s*(\d+\.?\d*)\s*%/);
    if (pctMatch) {
      const thrPct = parseFloat(pctMatch[1]) / 100;
      const closes = windowKlines.map(k => k.close).filter(c => c > 0);
      if (closes.length) {
        const maxDrawdown = Math.min(...closes);
        const ddPct = (maxDrawdown - entryPrice) / entryPrice;
        if (ddPct <= -thrPct) {
          return { triggered: true, confidence: 'high', detail: `精准: 最大回撤 ${(ddPct*100).toFixed(1)}% ≤ -${(thrPct*100).toFixed(0)}%, 条件触发` };
        }
        return { triggered: false, confidence: 'high', detail: `精准: 最大回撤 ${(ddPct*100).toFixed(1)}% > -${(thrPct*100).toFixed(0)}%, 条件未触发` };
      }
    }
    // 3) 含"放量"关键词 → 验证成交量 (需有 volume 数据)
    //    暂朴素: 有量增就算触发 (P1 不做复杂量比, 后续可细化)
    if (text.includes('放量') || text.includes('量增')) {
      const vols = windowKlines.map(k => k.volume).filter(v => v > 0);
      if (vols.length >= 2) {
        const halfIdx = Math.floor(vols.length / 2);
        const avgFirst = vols.slice(0, halfIdx).reduce((s, v) => s + v, 0) / halfIdx;
        const avgLast = vols.slice(halfIdx).reduce((s, v) => s + v, 0) / (vols.length - halfIdx);
        if (avgLast > avgFirst * 1.3) {
          return { triggered: true, confidence: 'high', detail: `量增: 后半段均量 ${avgLast.toFixed(0)} vs 前半 ${avgFirst.toFixed(0)}, 放量 30%+` };
        }
        return { triggered: false, confidence: 'high', detail: `量未增: 后半段均量 ${avgLast.toFixed(0)} ≤ 前半 ${avgFirst.toFixed(0)}, 量未放大` };
      }
    }
    // 4) 兜底: 用实际 PnL 做朴素判断
    const lastClose = windowKlines[windowKlines.length - 1].close;
    const pnlPct = (lastClose - entryPrice) / entryPrice;
    if (pnlPct <= -0.05) {
      return { triggered: true, confidence: 'low', detail: `PnL 兜底: 浮亏 ${(pnlPct*100).toFixed(1)}%, 证伪可能成立` };
    }
    return { triggered: false, confidence: 'low', detail: `PnL 兜底: 浮盈 ${(pnlPct*100).toFixed(1)}%, 证伪未触发` };
  }

  /**
   * 解析 invalidation 失效条件的剩余天数 (纯函数)
   * 支持: "N 天","N 周","N 个交易日"
   * @param {string} invalidation
   * @param {number} elapsedDays 从建仓起已过自然日
   * @returns {{ expired: boolean, detail: string }}
   */
  function verifyInvalidation(invalidation, elapsedDays) {
    if (!invalidation) return { expired: false, detail: '无失效条件' };
    const text = String(invalidation).trim();
    const dayMatch = text.match(/(\d+)\s*[天日个]/);
    const weekMatch = text.match(/(\d+)\s*[周个]/);
    const tradeDayMatch = text.match(/(\d+)\s*个?交易/);
    let limitDays = null;
    let unit = '';
    if (tradeDayMatch) { limitDays = parseInt(tradeDayMatch[1]); unit = '交易日'; }
    else if (weekMatch) { limitDays = parseInt(weekMatch[1]) * 7; unit = '周'; }
    else if (dayMatch) { limitDays = parseInt(dayMatch[1]); unit = '天'; }
    if (limitDays !== null) {
      return {
        expired: elapsedDays >= limitDays,
        detail: `${limitDays}${unit}限制 ${elapsedDays}${unit}已过, ${elapsedDays >= limitDays ? '已过期' : '未过期'}`
      };
    }
    return { expired: false, detail: `不可解析: "${text.slice(0, 30)}", 跳过` };
  }

  /**
   * 事后验证单个 pick (纯函数)
   * 综合 falsifyCondition + invalidation, 对 K 线数据做机械判断
   *
   * @param {object} pick - { code, falsifyCondition, invalidation }
   * @param {object} ctx - { entryPrice, windowKlines, elapsedDays }
   *   windowKlines: [{ date, open, close, high, low, volume }] (含入场后 K 线)
   * @returns {{ premortemOutcome: 'correct'|'wrong'|'partial'|null,
   *             premortemReason: string,
   *             falsifyResult: object|null,
   *             invalidationResult: object|null }}
   */
  function verifyPick(pick, ctx) {
    if (!pick || !ctx || !ctx.entryPrice || !Array.isArray(ctx.windowKlines) || ctx.windowKlines.length < 1) {
      return { premortemOutcome: null, premortemReason: '数据不足', falsifyResult: null, invalidationResult: null };
    }
    const falsifyResult = verifyFalsifyCondition(pick.falsifyCondition, ctx.entryPrice, ctx.windowKlines);
    const invResult = verifyInvalidation(pick.invalidation, ctx.elapsedDays || 0);

    // 综合判定:
    //   falsify triggered + (expired 或 high confidence) → wrong (预测被证伪)
    //   expired + falsify NOT triggered → partial (超期未兑现)
    //   NOT triggered + NOT expired → correct (条件未触发, 判断有效)
    const falsifyTriggered = falsifyResult.triggered;
    const expired = invResult.expired;
    const falsifyHighConf = falsifyResult.confidence === 'high';

    if (falsifyTriggered && (expired || falsifyHighConf)) {
      return { premortemOutcome: 'wrong', premortemReason: `证伪触发: ${falsifyResult.detail}`, falsifyResult, invalidationResult: invResult };
    }
    if (expired) {
      return { premortemOutcome: 'partial', premortemReason: `超期未兑现: ${invResult.detail}`, falsifyResult, invalidationResult: invResult };
    }
    if (falsifyTriggered) {
      return { premortemOutcome: 'partial', premortemReason: `证伪可能触发(低置信): ${falsifyResult.detail}`, falsifyResult, invalidationResult: invResult };
    }
    return { premortemOutcome: 'correct', premortemReason: `证伪未触发: ${falsifyResult.detail}`, falsifyResult, invalidationResult: invResult };
  }

  /**
   * 批量验证 journal 表里的 pre-mortem 行 (有 falsifyCondition 且无 premortemOutcome)
   * @param {Array} journals - journals 表行 (已含 falsifyCondition/invalidation 字段)
   * @param {function} getKline - async (code) => [{date, open, close, high, low, volume}]
   * @param {Date} now
   * @returns {Promise<{scanned:number, verified:number, skipped:number}>}
   */
  async function verifyPendingJournals(journals, getKline, now) {
    if (typeof getKline !== 'function') return { scanned: 0, verified: 0, skipped: 0 };
    const today = (d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`)(now || new Date());
    let scanned = 0, verified = 0, skipped = 0;
    const targets = (Array.isArray(journals) ? journals : []).filter(j =>
      j && j.falsifyCondition && !j.premortemOutcome && j.code && j.entryDate && j.entryDate < today
    );
    for (const j of targets) {
      scanned++;
      try {
        const bars = await getKline(j.code);
        if (!Array.isArray(bars) || bars.length < 2) { skipped++; continue; }
        const kline = bars.map(b => ({
          date: String(b.日期 || b.date || '').slice(0, 10),
          open: parseFloat(b.开盘 || b.open),
          close: parseFloat(b.收盘 || b.close),
          high: parseFloat(b.最高 || b.high),
          low: parseFloat(b.最低 || b.low),
          volume: parseFloat(b.成交量 || b.volume) || 0
        })).filter(b => b.close > 0);
        if (kline.length < 2) { skipped++; continue; }
        // 找到 entryDate 后的 K 线
        const entryIdx = kline.findIndex(k => k.date >= j.entryDate);
        if (entryIdx < 0) { skipped++; continue; }
        const windowKlines = kline.slice(entryIdx);
        if (windowKlines.length < 1) { skipped++; continue; }
        const elapsedDays = Math.round((new Date(today).getTime() - new Date(j.entryDate).getTime()) / 86400000);
        const ctx = {
          entryPrice: parseFloat(j.costPrice) || windowKlines[0].open,
          windowKlines,
          elapsedDays: Math.max(elapsedDays, 0)
        };
        const result = verifyPick(j, ctx);
        if (!result.premortemOutcome) { skipped++; continue; }
        j.premortemOutcome = result.premortemOutcome;
        j.premortemReason = result.premortemReason;
        j.premortemVerifiedAt = Date.now();
        await Core.Storage.put('journals', j);
        verified++;
      } catch (e) {
        console.warn(`[Premortem] verify ${j.code} ${j.entryDate} 失败:`, e.message || e);
        skipped++;
      }
    }
    return { scanned, verified, skipped };
  }

  window.Core = window.Core || {};
  window.Core.Premortem = {
    FIELDS,
    FIELD_LABELS,
    PROMPT_SPEC,
    checkPick,
    checkPicks,
    renderBlock,
    // P1 事后验证
    verifyFalsifyCondition,
    verifyInvalidation,
    verifyPick,
    verifyPendingJournals
  };
})();
