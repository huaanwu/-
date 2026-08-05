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

      // 最后 fetch: cache:'no-store' 强制绕开 HTTP cache + Service Worker
      // Tier 3B 教训: 'force-cache' 会让 SW 永久缓存旧 JSON, KB 升级后用户拿不到新版
      // Dexie 的 7 天 TTL (KB_TTL) 才是真正的缓存控制点
      try {
        const resp = await fetch(KB_URL, { cache: 'no-store' });
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
    if (context.north) queries.push('北向', '外资', 'T+1', '聪明钱');
    if (context.money) queries.push('货币', 'M2', '流动性');
    if (context.sectors) queries.push('板块', '风格轮动');
    if (context.earnings && context.earnings.surprise && context.earnings.surprise.length > 0) {
      queries.push('业绩预告', '拐点');
    }
    if (context.calendar && context.calendar.next_14d && context.calendar.next_14d.length > 0) {
      queries.push('政策', '央行', '国常会', 'LPR', '降准');
    }
    if (context.lhb) queries.push('龙虎榜', '游资', '异动', '机构', '席位');
    if (context.margin) queries.push('两融', '杠杆');
    if (context.futures) queries.push('期货', '基差', '升水');
    // Tier 3B: reasonTag 6 类直接 trigger (screener/short-trader 注入 prompt 时附带)
    // Phase 5: volume_price 量价触发器
    if (context.volume_price) queries.push('量价', '放量', '缩量', '量比', '成交量');
    // SKL v1.4: 长线 sleeve 选股方法论 trigger (白毛股神 + Stock-Analysis-Skill)
    //   context.skill = ['chokepoint','nav_discount','contrarian'] 任一
    //   → 触发对应 SKL-001~004 关键词进 queries
    if (context.skill && Array.isArray(context.skill)) {
      const SKILL_QUERY = {
        chokepoint: ['chokepoint', '瓶颈', '不可替代', '产业链', '上游', '供应商', 'BOM', '紫苏叶'],
        nav_discount: ['NAV', '折价', '母子', '子公司', '分拆', '维权', '激进投资者', '回购', '价值陷阱', '安全边际'],
        contrarian: ['反共识', '坚守', '换供应商', '替换', '周期', '大客户', '传闻', '利空'],
        nav_trap: ['NAV', '折价', '价值陷阱', '成长', '无成长', '治理']
      };
      for (const sk of context.skill) {
        const qs = SKILL_QUERY[sk];
        if (qs) queries.push(...qs);
      }
    }
    if (context.reasonTags && Array.isArray(context.reasonTags)) {
      const TAG_QUERY = {
        surge: ['涨幅异动', '涨停', '强势'],
        plunge: ['跌幅异动', '下跌', '回撤'],
        turnover: ['换手异动', '高换手', '流动性'],
        amplitude: ['振幅异动', '波动'],
        st_risk: ['ST风险', '退市', '风险'],
        normal: ['龙虎榜', '上榜']
      };
      for (const tag of context.reasonTags) {
        const qs = TAG_QUERY[tag];
        if (qs) queries.push(...qs);
      }
    }
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
   * Tier 3B: 每条带 category 标签 (LLM 引用时知道来源类型)
   * @param {Array<entry>} entries
   * @returns {string} - markdown 块
   */
  function formatForPrompt(entries) {
    if (!Array.isArray(entries) || entries.length === 0) return '';
    const CATEGORY_ICON = {
      valuation: '估值', risk: '风险', cycle: '周期', position: '仓位',
      policy: '政策', behavior: '行为', case: '案例', fixed_income: '固收',
      fund: '基金', rule: '规则', discipline: '纪律'
    };
    const lines = ['## 投资百科参考 (Phase N, 引用条目号)'];
    for (const e of entries) {
      const cat = CATEGORY_ICON[e.category] || e.category || '其它';
      lines.push(`- **${e.id}** [${cat}] ${e.title}: ${e.summary}`);
    }
    lines.push('\n> 引用建议: 回答时如有相关条目, 在句末标注 (例如 "..., 符合 KB-VAL-001 PE 估值原则")');
    return lines.join('\n');
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.KB = {
    load: _load,
    get,
    pickRelevant,
    formatForPrompt
  };
})();