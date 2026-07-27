/**
 * Core.News - 财经新闻 (财新为主)
 * 24h 缓存, 按关键词过滤相关性
 *
 * 输出: {
 *   generated: ISO 时间,
 *   source: 'caixin',
 *   total: 100,
 *   relevant: [ { tag, summary, url, score, reason } ],
 *   all: [...] // 完整 100 篇 (供 UI 展示)
 * }
 */
(function() {
  'use strict';

  const TTL_6H = 6 * 60 * 60 * 1000;  // 新闻 6h 缓存 (财新日更)
  const CACHE_KEY = 'news_caixin_v1';

  // 相关性关键词 (含权重)
  const KEYWORDS = {
    high: ['央行', 'PBOC', '货币政策', '降息', '降准', '加息', 'LPR', 'MLF', '逆回购', '公开市场', '货币政策'],
    mid: ['利率', '债市', '债券', '国债', '城投', '信用', '基金', '公募', '理财', '债基', '纯债', '短债', '中短债'],
    low: ['通胀', 'CPI', '通缩', 'PMI', '经济', '房地产', '楼市', '稳增长', '政策', '监管', '财政']
  };

  function _score(text) {
    const t = text.toLowerCase();
    let s = 0, hits = [];
    for (const kw of KEYWORDS.high) {
      if (t.includes(kw)) { s += 3; hits.push(kw); }
    }
    for (const kw of KEYWORDS.mid) {
      if (t.includes(kw)) { s += 2; hits.push(kw); }
    }
    for (const kw of KEYWORDS.low) {
      if (t.includes(kw)) { s += 1; hits.push(kw); }
    }
    return { score: s, hits: [...new Set(hits)] };
  }

  /**
   * 财新新闻 (aktools, 限流时返空)
   */
  async function _fetchCaixin() {
    try {
      const data = await Core.Data.fetch('news_caixin', 'stock_news_main_cx', {}, TTL_6H);
      if (!Array.isArray(data)) return [];
      return data.map(d => ({
        tag: d.tag,
        summary: d.summary,
        url: d.url,
        source: 'caixin'
      }));
    } catch (e) {
      console.warn('[News] 财新拉取失败:', e.message);
      return [];
    }
  }

  /**
   * 东方财富公告 API (C 替代源, CORS 友好)
   * 拉公司公告, 关键词过滤出"央行/政策/利率/降息/降准"类, 当作政策新闻
   * URL: https://np-anotice-stock.eastmoney.com/api/security/ann
   */
  async function _fetchEastmoneyAnnouncements() {
    const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=50&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0';
    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://data.eastmoney.com/'
        }
      });
    } catch (e) {
      throw new Error('东财公告网络错误: ' + e.message);
    }
    if (!resp.ok) throw new Error('东财公告 HTTP ' + resp.status);
    const j = await resp.json();
    if (!j || !j.data || !Array.isArray(j.data.list)) {
      throw new Error('东财公告返空');
    }
    return j.data.list.map(d => {
      // 只取与债市/基金/宏观强相关的公告
      const code = (d.codes && d.codes[0] && d.codes[0].short_name) || '';
      const title = d.title || '';
      return {
        tag: '公告-' + code,
        summary: title,
        url: d.art_code ? `https://data.eastmoney.com/notices/detail/${d.art_code}.html` : '',
        source: 'eastmoney'
      };
    });
  }

  async function _fetch() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase')}`;
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    // 主源: 财新 (aktools)
    let items = await _fetchCaixin();

    // C 替代源: 东财公告 (aktools 限流时启用)
    if (items.length === 0) {
      console.log('[News] 财新无数据, 启用东财公告 fallback');
      try {
        const annItems = await _fetchEastmoneyAnnouncements();
        items = annItems;
      } catch (e) {
        console.warn('[News] 东财公告也失败:', e.message);
      }
    }

    if (items.length === 0) {
      // 两源都挂, 返空
      const empty = {
        generated: new Date().toISOString(),
        source: 'none',
        total: 0,
        relevant: [],
        all: []
      };
      // 短缓存, 避免反复拉挂源
      await Core.Storage.cacheSet(cacheKey, empty, 5 * 60 * 1000);
      return empty;
    }

    // 关键词打分
    const scored = items.map(d => {
      const text = (d.tag || '') + ' ' + (d.summary || '');
      const { score, hits } = _score(text);
      return {
        ...d,
        score,
        reason: hits.length > 0 ? '含关键词: ' + hits.slice(0, 3).join(', ') : ''
      };
    });
    // 排序
    scored.sort((a, b) => b.score - a.score);

    const result = {
      generated: new Date().toISOString(),
      source: scored[0]?.source || 'caixin',
      total: scored.length,
      relevant: scored.filter(i => i.score > 0),
      all: scored
    };

    await Core.Storage.cacheSet(cacheKey, result, TTL_6H);
    return result;
  }

  /**
   * 格式化为 prompt 友好的中文 (只取 top N, 限制 token)
   */
  function formatForPrompt(snap, maxItems = 10) {
    if (!snap || !snap.relevant) return '';
    const items = snap.relevant.slice(0, maxItems);
    const sourceLabel = snap.source === 'eastmoney' ? '东财公告' : (snap.source === 'caixin' ? '财新' : '综合');
    if (items.length === 0) return '⚠ 近期新闻中未找到与债市/基金/宏观强相关的内容';
    return '## 近期财经新闻 (' + sourceLabel + ', ' + snap.generated.slice(0, 10) + ', 取相关性 top ' + items.length + ')\n' +
      items.map((it, i) =>
        `[${i + 1}] [${it.tag}] ${it.summary}${it.reason ? '  (← ' + it.reason + ')' : ''}`
      ).join('\n');
  }

  /**
   * 清除缓存
   */
  async function refresh() {
    const cacheKey = `${CACHE_KEY}_${Core.State.get('proxyBase')}`;
    await Core.Storage.cacheSet(cacheKey, null, 1);
  }

  window.Core = window.Core || {};
  window.Core.News = {
    get: _fetch,
    formatForPrompt,
    refresh
  };
})();
