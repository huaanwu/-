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
  // super: 国务院/财政部/发改委等纯政策源, 政策密度大加分
  // high:   央行/货币政策/降息/降准
  // mid:    利率/债市/债券/基金/理财
  // low:    通胀/CPI/PMI/经济
  const KEYWORDS = {
    super: ['国务院', '国常会', '国务院常务会议', '财政部', '发改委', '国家发改委',
            '中央政治局', '中央经济工作会议', '证监会', '银保监会', '金融委',
            '央行', '中国人民银行', 'PBOC', '公开市场操作', '逆回购', 'MLF', 'PSL', 'SLF'],
    high: ['降息', '降准', '加息', 'LPR', '货币政策', '财政政策', '结构性工具',
           '利率走廊', '汇率', '人民币汇率', '外汇储备'],
    mid: ['利率', '债市', '债券', '国债', '城投', '信用', '基金', '公募', '理财', '债基', '纯债', '短债', '中短债'],
    low: ['通胀', 'CPI', '通缩', 'PMI', '经济', '房地产', '楼市', '稳增长', '政策', '监管', '财政']
  };

  // 东财公告加权关键词 (公司公告中监管/决议类, 提权 +2)
  const EM_BOOST = ['公告', '决议', '通知', '决定', '管理办法', '指引', '批复', '意见', '公告书'];

  function _score(item) {
    const text = ((item.tag || '') + ' ' + (item.summary || '')).toLowerCase();
    let s = 0, hits = [];
    for (const kw of KEYWORDS.super) {
      if (text.includes(kw.toLowerCase())) { s += 5; hits.push(kw); }
    }
    for (const kw of KEYWORDS.high) {
      if (text.includes(kw.toLowerCase())) { s += 3; hits.push(kw); }
    }
    for (const kw of KEYWORDS.mid) {
      if (text.includes(kw.toLowerCase())) { s += 2; hits.push(kw); }
    }
    for (const kw of KEYWORDS.low) {
      if (text.includes(kw.toLowerCase())) { s += 1; hits.push(kw); }
    }
    // 东财公告中含监管/决议类关键词 → 额外 +2
    if (item.source === 'eastmoney') {
      let emHits = 0;
      for (const kw of EM_BOOST) {
        if (text.includes(kw)) { s += 2; emHits++; }
      }
      if (emHits > 0) hits.push('东财公告');
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

  /**
   * 东财公告列表按个股过滤 (纯函数, 测试钩子)
   * @param {Array} list 东财 API 返回的 data.list
   * @param {string} code 6 位股票代码
   * @param {number} limit 最多取几条
   */
  function _filterNoticesByCode(list, code, limit = 5) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(d => Array.isArray(d.codes) && d.codes.some(c => String(c.stock_code) === String(code)))
      .slice(0, limit)
      .map(d => ({
        code: String(code),
        title: d.title || '',
        date: (d.notice_date || '').slice(0, 10),
        url: d.art_code ? `https://data.eastmoney.com/notices/detail/${d.art_code}.html` : ''
      }));
  }

  /**
   * 拉单只股票近期公告 (Phase D1)
   * 主路径: 东财公告 API 支持 stock_list={code} 按个股查询 (已验证)
   * 兜底: stock_list 请求失败时拉全量 page_size=100 后按 codes[].stock_code 本地过滤
   * 缓存: 6h, 走 Core.Storage.cacheGet/cacheSet
   * @param {string} code 6 位股票代码
   * @param {number} [limit=5]
   * @returns {Array|null} 公告数组; null = 拉取失败 (调用方降级"公告数据不可用")
   */
  async function getStockNotices(code, limit = 5) {
    if (!code) return null;
    const cacheKey = `notices_${code}`;
    try {
      const cached = await Core.Storage.cacheGet(cacheKey);
      if (cached) return cached;
    } catch (e) { console.warn('[News] 公告缓存读取失败:', e); }

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': 'https://data.eastmoney.com/'
    };
    let notices = null;
    try {
      const url = `https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=${limit}&page_index=1&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}&f_node=0&s_node=0`;
      const resp = await fetch(url, { method: 'GET', headers });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const j = await resp.json();
      if (!j || !j.data || !Array.isArray(j.data.list)) throw new Error('返空');
      // stock_list 已按个股过滤, 再走一遍纯函数统一字段格式 (limit 已由接口保证)
      notices = _filterNoticesByCode(j.data.list, code, limit);
    } catch (e) {
      console.warn('[News] 个股公告 stock_list 拉取失败, 尝试全量过滤:', e.message);
      try {
        // 兜底: 全量拉 100 条, 本地按 codes[].stock_code 过滤 (接口不支持时的降级路径)
        const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=100&page_index=1&ann_type=A&client_source=web&f_node=0&s_node=0';
        const resp = await fetch(url, { method: 'GET', headers });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const j = await resp.json();
        if (!j || !j.data || !Array.isArray(j.data.list)) throw new Error('返空');
        notices = _filterNoticesByCode(j.data.list, code, limit);
      } catch (e2) {
        console.warn('[News] 个股公告全量兜底也失败:', e2.message);
        return null;
      }
    }

    try { await Core.Storage.cacheSet(cacheKey, notices, TTL_6H); } catch (e) { console.warn('[News] 公告缓存写入失败:', e); }
    return notices;
  }

  /**
   * 公告列表格式化为 prompt 文本 (纯函数)
   * @param {Array|null} notices null=拉取失败, []=无公告
   * @param {number} [maxItems=5]
   */
  function formatNoticesForPrompt(notices, maxItems = 5) {
    if (notices === null || notices === undefined) return '## 近期公告\n(公告数据不可用)';
    if (!Array.isArray(notices) || notices.length === 0) return '## 近期公告\n近期无公告';
    const items = notices.slice(0, maxItems);
    return '## 近期公告 (最近 ' + items.length + ' 条)\n' +
      items.map((n, i) => `[${i + 1}] ${n.date || '-'} ${n.title}`).join('\n');
  }

  /**
   * 百度经济新闻 (aktools) → 当作政策密度补充源
   * URL: stock_news_economic_baidu / news_economic_baidu
   * 字段 (akshare 0.10+): { title, url,ptime }
   */
  async function _fetchBaiduPolicy() {
    try {
      const data = await Core.Data.fetch('news_baidu_policy', 'news_economic_baidu', {}, TTL_6H);
      if (!Array.isArray(data) || data.length === 0) return [];
      return data.slice(0, 30).map(d => ({
        tag: '政策',
        summary: d.title || d.content || '',
        url: d.url || '',
        source: 'baidu-policy'
      }));
    } catch (e) {
      console.warn('[News] 百度经济新闻拉取失败:', e.message);
      return [];
    }
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

    // 政策密度补充源: 百度经济新闻 (政策类关键词扫描)
    // 即使主源有数据也合并进来, 由 super tier 关键词 (国务院/财政部/发改委 等) 提权
    try {
      const policyItems = await _fetchBaiduPolicy();
      if (policyItems.length > 0) {
        items = items.concat(policyItems);
        console.log(`[News] 百度政策源并入 ${policyItems.length} 条`);
      }
    } catch (e) {
      console.warn('[News] 百度政策源拉取失败:', e.message);
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

    // 关键词打分 (含政策密度加权 + 东财公告提权)
    const scored = items.map(d => {
      const { score, hits } = _score(d);
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
    refresh,
    getStockNotices,
    formatNoticesForPrompt,
    _filterNoticesByCode
  };
})();
