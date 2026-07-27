/**
 * Core.SelfConsistency — 自一致性多采样 (替代多空辩论)
 *
 * 背景: arxiv 2408.09999 指出多 agent 辩论若共用同一 LLM backbone 易出现 herding (从众偏差),
 *   即使 prompt 故意对立也常收敛到同答案. Self-consistency (Wang et al. 2022) 更稳:
 *   同 prompt 跑 N 次, 取众数 / 共识率, 不引入 "对手" 角色.
 *
 * 三种聚合策略:
 *   - 'json-verdict': 对结构化 JSON 输出, 提取 verdict 字段取众数 (推荐)
 *   - 'text-prefix': 对自由文本, 取前 normalizeLen 字符 hash 后的众数 (粗匹配)
 *   - 'parse-json': 同 json-verdict 但同时返回所有 parse 结果
 *
 * 用法:
 *   const r = await Core.SelfConsistency.run({
 *     systemPrompt, prompt, n: 3, mode: 'json-verdict',
 *     callOpts: { maxTokens: 200, jsonMode: true }  // 透传给 Core.AI.call
 *   });
 *   // r = { votes: [...], majority, consensusRate, lowConsensus, allParsed }
 *
 * 设计:
 *   - 纯函数 + 异步, 每次 run 都新跑 N 次 (不走 cachedCall, 否则 self-consistency 退化成单次)
 *   - 失败 graceful: 单次失败不阻塞, 计入 votes[].error
 *   - 共识率 < threshold 时设 lowConsensus=true, 上层可二次验证或提示
 */
(function() {
  'use strict';

  const DEFAULT_N = 3;
  const DEFAULT_THRESHOLD = 0.5;

  /**
   * @param {object} opts
   *   - systemPrompt, prompt, n, threshold, mode, normalizeLen, callOpts
   *   - onProgress?: (done, total) => void  // 进度回调 (可选)
   * @returns {Promise<{votes, majority, consensusRate, lowConsensus, mode, allParsed}>}
   */
  async function run(opts) {
    const systemPrompt = opts.systemPrompt || '';
    const prompt = opts.prompt || '';
    const n = Math.max(1, opts.n || DEFAULT_N);
    const threshold = (opts.threshold != null) ? opts.threshold : DEFAULT_THRESHOLD;
    const mode = opts.mode || 'json-verdict';
    const normalizeLen = opts.normalizeLen || 30;
    const callOpts = opts.callOpts || {};

    // 并行跑 N 次 (不串行, LLM 调用独立)
    const tasks = [];
    for (let i = 0; i < n; i++) {
      tasks.push(_one(systemPrompt, prompt, callOpts, mode));
    }
    const settled = await Promise.allSettled(tasks);

    const votes = settled.map((s, idx) => {
      if (s.status === 'fulfilled') return s.value;
      return { idx, error: (s.reason && s.reason.message) || String(s.reason), text: null };
    });

    // 聚合
    const { majority, consensusRate, allParsed } = _aggregate(votes, mode, normalizeLen);
    const lowConsensus = consensusRate < threshold;

    if (opts.onProgress) opts.onProgress(n, n);
    return { votes, majority, consensusRate, lowConsensus, mode, allParsed, n };
  }

  async function _one(systemPrompt, prompt, callOpts, mode) {
    try {
      // 强制非流式, 单次响应即可
      const text = await Core.AI.call({
        systemPrompt,
        prompt,
        stream: false,
        ...callOpts
      });
      const parsed = _tryParse(text, mode);
      return { idx: null, text, parsed, error: null };
    } catch (e) {
      console.warn('[SelfConsistency] 单次调用失败:', e.message);
      return { idx: null, text: null, parsed: null, error: e.message };
    }
  }

  function _tryParse(text, mode) {
    if (!text) return null;
    if (mode === 'text-prefix') return null;  // 不解析, 由 _aggregate 处理
    // 抽 JSON (复用 AI service 的容错: 围栏 + 裸对象)
    let jsonText = null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) jsonText = fence[1].trim();
    if (!jsonText) {
      const s = text.indexOf('{'), e = text.lastIndexOf('}');
      if (s >= 0 && e > s) jsonText = text.slice(s, e + 1);
    }
    if (!jsonText) return null;
    try { return JSON.parse(jsonText); } catch (e) { return null; }
  }

  function _aggregate(votes, mode, normalizeLen) {
    const valid = votes.filter(v => !v.error);
    const allParsed = valid.map(v => v.parsed).filter(p => p != null);
    if (valid.length === 0) {
      return { majority: null, consensusRate: 0, allParsed };
    }
    if (mode === 'json-verdict' || mode === 'parse-json') {
      // 抽 verdict 字段
      const verdicts = allParsed.map(p => p.verdict).filter(v => v != null);
      if (verdicts.length === 0) {
        // 兜底: 走 text-prefix
        return _textPrefixAggregate(valid, normalizeLen);
      }
      const counts = {};
      for (const v of verdicts) counts[v] = (counts[v] || 0) + 1;
      let majority = null, maxN = 0;
      for (const k of Object.keys(counts)) {
        if (counts[k] > maxN) { majority = k; maxN = counts[k]; }
      }
      return {
        majority,
        consensusRate: maxN / verdicts.length,
        allParsed
      };
    }
    // text-prefix: 前 N 字 hash 后的众数
    return _textPrefixAggregate(valid, normalizeLen);
  }

  function _textPrefixAggregate(valid, normalizeLen) {
    const counts = new Map();
    for (const v of valid) {
      const key = (v.text || '').slice(0, normalizeLen).trim();
      const cur = counts.get(key) || { count: 0, sample: v.text };
      cur.count++;
      counts.set(key, cur);
    }
    let majority = null, maxN = 0, consensusRate = 0;
    for (const cur of counts.values()) {
      if (cur.count > maxN) {
        maxN = cur.count;
        majority = cur.sample;
        consensusRate = cur.count / valid.length;
      }
    }
    return { majority, consensusRate, allParsed: [] };
  }

  window.Core = window.Core || {};
  window.Core.SelfConsistency = { run };
})();