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

  window.Core = window.Core || {};
  window.Core.Premortem = {
    FIELDS,
    FIELD_LABELS,
    PROMPT_SPEC,
    checkPick,
    checkPicks,
    renderBlock
  };
})();
