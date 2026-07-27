/**
 * Core.KB - 投资百科知识库 (Phase N)
 *
 * 静态 JSON 知识库 (~36 条, ~10KB), 按主题分类:
 *   valuation / risk / cycle / position / policy / behavior / case
 *
 * 设计:
 *   - 启动时 fetch /kb_data/investment_kb.json 缓存到内存
 *   - pickRelevant() 根据 holdings + context 关键词挑最相关的 N 条
 *   - formatForPrompt() 把挑中的条目拼成 prompt 片段
 *   - AI 在回答时引用条目号 (例如 KB-VAL-001), 用户可点看
 */
(function() {
  'use strict';

  const KB_URL = '/kb_data/investment_kb.json';
  const KB_CACHE_KEY = 'kb_investment_v1';
  const KB_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 天 (知识库基本不变)

  let _kb = null;  // 内存缓存
  let _loadPromise = null;

  /**
   * 加载 KB (内存 + Dexie 双缓存)
   * 多次并发调用复用同一个 Promise
   */
  async function _load() {
    if (_kb) return _kb;
    if (_loadPromise) return _loadPromise;

    _loadPromise = (async () => {
      // 先看内存
      if (_kb) return _kb;
      // 再看 Dexie
      try {
        const cached = await Core.Storage.cacheGet(KB_CACHE_KEY);
        if (cached && Array.isArray(cached.entries)) {
          _kb = cached;
          return _kb;
        }
      } catch (e) { console.warn('[KB] Dexie 读失败:', e.message); }

      // 最后 fetch
      try {
        const resp = await fetch(KB_URL, { cache: 'force-cache' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const data = await resp.json();
        if (!data || !Array.isArray(data.entries)) throw new Error('KB 格式错误');
        _kb = data;
        try {
          await Core.Storage.cacheSet(KB_CACHE_KEY, data, KB_TTL);
        } catch (e) { console.warn('[KB] Dexie 写失败:', e.message); }
        return _kb;
      } catch (e) {
        console.warn('[KB] fetch 失败, 用空知识库:', e.message);
        _kb = { _meta: {}, entries: [] };
        return _kb;
      }
    })();

    return _loadPromise;
  }

  /**
   * 按主题返回条目
   * @param {string} category - valuation/risk/cycle/position/policy/behavior/case
   */
  async function get(category) {
    const kb = await _load();
    if (!kb || !Array.isArray(kb.entries)) return [];
    if (!category) return kb.entries;
    return kb.entries.filter(e => e.category === category);
  }

  /**
   * 根据 holdings + context 关键词匹配, 返回最相关的 N 条
   * @param {object} opts - { holdings:[{name, type}], context:{valuation, earnings, ...}, maxN:3 }
   * @returns {Array<entry>}
   */
  async function pickRelevant(opts = {}) {
    const { holdings = [], context = {}, maxN = 3 } = opts;
    const kb = await _load();
    if (!kb || !Array.isArray(kb.entries) || kb.entries.length === 0) return [];

    // 构造查询关键词
    const queries = [];
    // 来自持仓名称
    for (const h of holdings) {
      if (h.name) queries.push(h.name);
      if (h.type) queries.push(h.type);
    }
    // 来自 context (数据可用时)
    if (context.valuation && context.valuation.length > 0) queries.push('估值', 'PE', '分位');
    if (context.north) queries.push('北向', '外资');
    if (context.money) queries.push('货币', 'M2', '流动性');
    if (context.sectors) queries.push('板块', '风格轮动');
    if (context.earnings && context.earnings.surprise && context.earnings.surprise.length > 0) {
      queries.push('业绩预告', '拐点');
    }
    if (context.calendar && context.calendar.next_14d && context.calendar.next_14d.length > 0) {
      queries.push('政策', '央行', '国常会', 'LPR', '降准');
    }
    if (context.lhb) queries.push('龙虎榜', '游资');
    if (context.margin) queries.push('两融', '杠杆');
    if (context.futures) queries.push('期货', '基差', '升水');
    // 通用兜底
    if (queries.length === 0) queries.push('基金', '估值', '风险', '分散');

    const queryStr = queries.join(' ').toLowerCase();

    // 评分: 每条 entry 的 keywords + title + tags 与 queryStr 命中数
    const scored = kb.entries.map(e => {
      const hay = ((e.title || '') + ' ' + (e.keywords || []).join(' ') + ' ' + (e.category || '') + ' ' + (e.tags || []).join(' ')).toLowerCase();
      let score = 0;
      for (const q of queries) {
        const ql = q.toLowerCase();
        if (hay.includes(ql)) score += 1;
        // 部分匹配 (2 字以上)
        if (ql.length >= 2 && hay.includes(ql.slice(0, 2))) score += 0.3;
      }
      // Bug J 修复: keywords 无命中时, 尝试 tags 兜底 (type-level 标签)
      // 例: entry.keywords=["华富吉富30天..."], entry.tags=["short_bond", "纯债"]
      //     query="短债" → keywords 不命中, tags 命中 → 仍能拉出该条目
      if (score === 0 && Array.isArray(e.tags)) {
        for (const t of e.tags) {
          const tl = (t || '').toLowerCase();
          if (tl && queries.some(q => (q || '').toLowerCase().includes(tl) || tl.includes((q || '').toLowerCase()))) {
            score += 0.5;  // tags 命中得分打 0.5 (弱匹配)
          }
        }
      }
      return { entry: e, score };
    });

    scored.sort((a, b) => b.score - a.score);
    // 过滤 score > 0, 取前 maxN
    return scored.filter(s => s.score > 0).slice(0, maxN).map(s => s.entry);
  }

  /**
   * 把条目格式化为 prompt 片段
   * @param {Array<entry>} entries
   * @returns {string} - markdown 块
   */
  function formatForPrompt(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const lines = ['## 投资百科参考 (Phase N, 引用条目号)'];
    for (const e of entries) {
      lines.push(`- **${e.id}** (${e.title}): ${e.summary}`);
    }
    lines.push('\n> 引用建议: 回答时如有相关条目, 在句末标注 (例如 "..., 符合 KB-VAL-001 PE 估值原则")');
    return lines.join('\n');
  }

  /**
   * 给 UI 用的格式化 (查看单条详情)
   */
  function formatOne(entry) {
    if (!entry) return '';
    return `### ${entry.id} ${entry.title}\n*分类: ${entry.category}*\n\n${entry.summary}\n\n**关键词**: ${(entry.keywords || []).join(', ')}`;
  }

  /**
   * 列出所有分类
   */
  function categories() {
    return ['valuation', 'risk', 'cycle', 'position', 'policy', 'behavior', 'case'];
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.KB = {
    load: _load,
    get,
    pickRelevant,
    formatForPrompt,
    formatOne,
    categories
  };
})();