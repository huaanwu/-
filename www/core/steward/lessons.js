/**
 * Core.Steward.Lessons — 学习闭环 (S5 闭环 + 规则候选)
 *
 * 设计:
 *   - recordLesson(): 每笔决策落库后写一条 steward_lessons 原子记录
 *     阈值检查: 同 (code, sleeve, pattern) 累计 ≥3 次且胜率偏差 ≥15pp
 *               → 生成 rule_candidates(status=pending) (不直接改 KB)
 *   - distill(lessons): 纯函数, 给 lessons 数组算 rule_candidates 候选
 *   - listCandidates({status}): 查候选
 *   - applyCandidate(candId, decision, opts): 用户拍板 (只改 status, 不动 KB JSON)
 *   - listLessons({code, sleeve, limit}): 查 lessons
 *
 * 设计原则 (S5 闭环核心):
 *   - KB JSON (investment_kb.json) 是只读的 source of truth, 永不被直接改
 *   - 任何 KB 调整必须经过: 候选生成 → 用户拍板 → applyCandidate (state machine)
 *   - recordLesson / applyCandidate 是唯一 IO 入口, distill 是纯函数
 *   - 阈值可调 (LESSON_THRESHOLD = 3, MIN_PNL_DEVIATION_PP = 15)
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;
  const Steward = window.Core.Steward = window.Core.Steward || {};

  const LESSON_THRESHOLD = 3;           // 同 pattern 累计次数触发候选
  const MIN_PNL_DEVIATION_PP = 0.15;    // 胜率偏差 ≥ 15pp 才算显著
  const OVERALL_WIN_RATE = 0.5;         // 全局基准胜率 (没有数据时用)

  /**
   * 记一条学习原子 (写 steward_lessons 表)
   * @param {object} args
   * @param {object} args.decision  - { code, sleeve, pattern, ... }
   * @param {object} args.outcome   - { pnl, winRate } (相对全局的偏差)
   * @param {object} [args.postMortem] - AI 复盘摘要 (可空)
   * @returns {Promise<{lessonId: number, candidateId: string|null}>}
   */
  async function recordLesson({ decision, outcome, postMortem }) {
    if (!decision || !decision.code) throw new Error('recordLesson: 缺 decision.code');
    if (!outcome) throw new Error('recordLesson: 缺 outcome');

    const row = {
      code: String(decision.code),
      sleeve: String(decision.sleeve || 'unknown'),
      pattern: String(decision.pattern || 'default'),
      strategy: String(decision.strategy || 'default'),
      decision: String(decision.action || decision.decision || 'unknown'),
      factor: Number.isFinite(decision.factor) ? decision.factor : null,
      regime: decision.regime || null,
      pnl: Number.isFinite(outcome.pnl) ? outcome.pnl : 0,
      winRate: Number.isFinite(outcome.winRate) ? outcome.winRate : OVERALL_WIN_RATE,
      postMortem: postMortem ? String(postMortem).slice(0, 500) : '',
      ts: Date.now()
    };
    const lessonId = await Core.Storage.add('steward_lessons', row);

    // 阈值检查: 同 (code, sleeve, pattern) 累计 ≥3 次 且胜率偏差 ≥15pp
    let candidateId = null;
    try {
      const all = (await Core.Storage.where('steward_lessons', 'code', row.code)) || [];
      const same = all.filter(l => l.sleeve === row.sleeve && l.pattern === row.pattern);
      if (same.length >= LESSON_THRESHOLD) {
        const wins = same.filter(l => (l.pnl || 0) > 0).length;
        const sampleWinRate = wins / same.length;
        const deviation = Math.abs(sampleWinRate - OVERALL_WIN_RATE);
        if (deviation >= MIN_PNL_DEVIATION_PP) {
          // 检查是否已有同 source 的 pending 候选 (幂等)
          const existing = (await Core.Storage.where('rule_candidates', 'source', _candidateSource(row))).find(c => c.status === 'pending');
          if (!existing) {
            const candId = _uuid();
            const sample = same.slice(0, 5).map(l => ({
              ts: l.ts, pnl: l.pnl, decision: l.decision
            }));
            const direction = sampleWinRate > OVERALL_WIN_RATE ? 'reinforce' : 'caution';
            await Core.Storage.add('rule_candidates', {
              candId,
              status: 'pending',
              source: _candidateSource(row),
              pattern: row.pattern,
              code: row.code,
              sleeve: row.sleeve,
              sampleWinRate: +sampleWinRate.toFixed(4),
              deviation: +deviation.toFixed(4),
              sampleSize: same.length,
              direction,
              evidence: sample,
              suggestedAction: direction === 'reinforce'
                ? `倾向在 ${row.pattern} 时增仓`
                : `倾向在 ${row.pattern} 时减仓`,
              ts: Date.now(),
              lessonId
            });
            candidateId = candId;
          } else {
            candidateId = existing.candId;
          }
        }
      }
    } catch (e) {
      console.warn('[Steward/Lessons] 阈值检查失败:', e && e.message || e);
    }

    return { lessonId, candidateId };
  }

  /**
   * 蒸馏 lessons 数组 → rule_candidates 候选 (纯函数, 不写库)
   * @param {Array} lessons - steward_lessons 数组
   * @returns {Array} - 候选数组 [{pattern, code, sleeve, sampleWinRate, deviation, ...}]
   */
  function distill(lessons) {
    if (!Array.isArray(lessons) || lessons.length === 0) return [];
    // 按 (code, sleeve, pattern) 分组
    const groups = {};
    for (const l of lessons) {
      const k = `${l.code}|${l.sleeve}|${l.pattern}`;
      if (!groups[k]) groups[k] = { code: l.code, sleeve: l.sleeve, pattern: l.pattern, items: [] };
      groups[k].items.push(l);
    }
    const candidates = [];
    for (const k of Object.keys(groups)) {
      const g = groups[k];
      if (g.items.length < LESSON_THRESHOLD) continue;
      const wins = g.items.filter(l => (l.pnl || 0) > 0).length;
      const wr = wins / g.items.length;
      const dev = Math.abs(wr - OVERALL_WIN_RATE);
      if (dev < MIN_PNL_DEVIATION_PP) continue;
      const direction = wr > OVERALL_WIN_RATE ? 'reinforce' : 'caution';
      candidates.push({
        code: g.code,
        sleeve: g.sleeve,
        pattern: g.pattern,
        sampleSize: g.items.length,
        sampleWinRate: +wr.toFixed(4),
        deviation: +dev.toFixed(4),
        direction,
        suggestedAction: direction === 'reinforce'
          ? `倾向在 ${g.pattern} 时增仓`
          : `倾向在 ${g.pattern} 时减仓`
      });
    }
    return candidates;
  }

  /**
   * 列 rule_candidates (按 status 过滤)
   * @param {{status?: string, limit?: number}} [opts]
   * @returns {Promise<Array>}
   */
  async function listCandidates(opts = {}) {
    const status = opts.status || null;
    if (!Core.Storage || typeof Core.Storage.listRuleCandidates !== 'function') return [];
    const rows = await Core.Storage.listRuleCandidates(status, opts.limit || 50);
    return rows;
  }

  /**
   * 用户拍板 (只改 status, 不动 KB JSON)
   * @param {string} candId
   * @param {'accepted'|'rejected'} decision
   * @param {{approvedBy?: string, note?: string, ts?: number}} [opts]
   * @returns {Promise<object>}
   */
  async function applyCandidate(candId, decision, opts = {}) {
    if (!candId) throw new Error('applyCandidate: 缺 candId');
    if (decision !== 'accepted' && decision !== 'rejected') {
      throw new Error('applyCandidate: decision 必须 accepted/rejected');
    }
    if (!Core.Storage || typeof Core.Storage.decideRuleCandidate !== 'function') {
      throw new Error('Core.Storage.decideRuleCandidate 不可用');
    }
    const out = await Core.Storage.decideRuleCandidate(candId, decision, {
      approvedBy: opts.approvedBy || 'user',
      note: opts.note || ''
    });
    return out;
  }

  /**
   * 列 lessons (按 code/sleeve/limit 过滤)
   * @param {{code?: string, sleeve?: string, limit?: number}} [opts]
   * @returns {Promise<Array>}
   */
  async function listLessons(opts = {}) {
    if (!Core.Storage || typeof Core.Storage.listStewardLessons !== 'function') return [];
    return await Core.Storage.listStewardLessons({
      code: opts.code,
      sleeve: opts.sleeve,
      limit: opts.limit || 50
    });
  }

  // ====================== 内部 helpers ======================
  function _uuid() {
    if (Core.Util && typeof Core.Util.uuid === 'function') return Core.Util.uuid();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function _candidateSource(row) {
    return `steward.distill.${row.code}.${row.sleeve}.${row.pattern}`;
  }

  // 暴露
  window.Core.Steward.Lessons = {
    recordLesson,
    distill,
    listCandidates,
    applyCandidate,
    listLessons,
    // 常量 (测试可访问)
    LESSON_THRESHOLD,
    MIN_PNL_DEVIATION_PP,
    OVERALL_WIN_RATE,
    TABLE_LESSONS: 'steward_lessons',
    TABLE_CANDIDATES: 'rule_candidates'
  };

  console.log('[Steward/Lessons] 学习闭环模块已就绪 (Dexie steward_lessons + rule_candidates)');
})();