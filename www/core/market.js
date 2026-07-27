/**
 * Core.Market - 行情看板数据层
 * 3 组: 宽基 / 风格 / 行业
 * 数据源: AKShare
 *   - stock_zh_index_spot(symbol="...")  宽基+风格
 *   - stock_board_industry_name_em       行业
 *
 * 缓存策略: 宽基/风格 1 分钟(交易时段实时性强) / 行业 5 分钟(31 个板块)
 * 失败降级: 拉取失败保留旧缓存(若存在) + errors 字段
 */
(function() {
  'use strict';

  // 宽基: 6 个, 看大势
  // 风格: 6 个, 看轮动
  // 名称 → 腾讯/东财代码 映射 (akshare 名称 → 6 位数)
  const INDEX_MAP = {
    // 宽基
    '上证指数':   'sh000001',
    '深证成指':   'sz399001',
    '创业板指':   'sz399006',
    '沪深300':    'sh000300',
    '中证500':    'sh000905',
    '中证1000':   'sh000852',
    // 风格
    '上证50':      'sh000016',
    '中证红利':    'sh000922',
    '红利低波100': 'sh512890',
    '中证红利低波': 'h30269',   // 腾讯/东财可能不支持, 会失败降级
    '国证成长':    'sz399370',
    '国证价值':    'sz399371'
  };
  const WIDE_SYMBOLS = ['上证指数', '深证成指', '创业板指', '沪深300', '中证500', '中证1000'];
  const STYLE_SYMBOLS = ['上证50', '中证红利', '红利低波100', '中证红利低波', '国证成长', '国证价值'];

  const TTL_WIDE = 60 * 1000;        // 1 分钟
  const TTL_STYLE = 60 * 1000;       // 1 分钟
  const TTL_INDUSTRY = 5 * 60 * 1000; // 5 分钟

  /**
   * 拉宽基 + 风格 (C: 优先腾讯, 失败的代码跳过)
   * @param {string[]} symbols 名称数组 (e.g. ['上证指数', '沪深300'])
   * @returns {Promise<Array>} 字段: {code, name, price, change, changeAmt}
   */
  async function _fetchIndices(symbols) {
    if (!window.Core || !Core.Data) throw new Error('Core.Data 不可用');
    // 名称 → 6 位腾讯代码
    const tencentCodes = symbols.map(n => INDEX_MAP[n]).filter(Boolean);
    if (tencentCodes.length === 0) return [];
    let tencentList = [];
    try {
      // 始终按 codes 批量拉, getIndexSpotTencent 是写死 4 个, 这里不行
      tencentList = await Core.Data.getStockSpotTencent(tencentCodes);
    } catch (e) {
      console.warn('[Market] 腾讯指数失败:', e.message);
    }
    // 反向映射: 6位代码 → 名称
    const codeToName = {};
    for (const [name, code] of Object.entries(INDEX_MAP)) {
      codeToName[code] = name;
    }
    // 拼回按用户传入顺序
    return tencentList.map(it => {
      const code = it.代码;
      return {
        code,
        name: codeToName[code] || it.名称 || code,
        price: parseFloat(it.最新价 || 0),
        change: parseFloat(it.涨跌幅 || 0),
        changeAmt: parseFloat(it.涨跌额 || 0)
      };
    }).filter(x => x.code && !isNaN(x.price));
  }

  /**
   * 拉行业板块 (东方财富申万一级)
   * 返回 top 5 涨 + bottom 5 跌
   * C: 替代 akshare stock_board_industry_em
   */
  async function _fetchIndustry() {
    if (!window.Core || !Core.Data) throw new Error('Core.Data 不可用');
    // 东方财富 clist: m:90+t:2 是申万一级行业
    const url = 'https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=100&po=1&fs=m:90+t:2&fields=f12,f14,f2,f3,f4,f8';
    let resp;
    try {
      resp = await fetch(url);
    } catch (e) {
      throw new Error('东方财富行业接口网络错误: ' + e.message);
    }
    if (!resp.ok) throw new Error('东方财富行业 HTTP ' + resp.status);
    const j = await resp.json();
    if (!j.data || !j.data.diff) throw new Error('东方财富行业返空');
    // 字段映射: f12 板块代码, f14 名称, f2 总成交额(万元), f3 涨跌幅(基点), f4 涨跌额(万元), f8 换手率(基点)
    const parsed = Object.values(j.data.diff).map(r => ({
      code: r.f12 || '',
      name: r.f14 || '',
      price: 0,  // 行业无价格, 用 totalAmount 顶替 (UI 不显示)
      amount: _num(r.f2),  // 总成交额 (万元)
      change: _num(r.f3) / 100,  // 基点 → %
      changeAmt: _num(r.f4) / 100,  // 万元
      turnover: _num(r.f8) / 100  // 基点 → %
    })).filter(x => x.name);
    // 排序
    parsed.sort((a, b) => b.change - a.change);
    return {
      top: parsed.slice(0, 5),
      bottom: parsed.slice(-5).reverse()
    };
  }
  function _num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }

  // 缓存 (内存, + storage 备份)
  const _memCache = { wide: null, style: null, industry: null };

  async function _cacheGet(group) {
    if (_memCache[group]) return _memCache[group];
    if (window.Core && Core.Storage) {
      try {
        const stored = await Core.Storage.cacheGet(`market_${group}`);
        if (stored) { _memCache[group] = stored; return stored; }
      } catch (e) { /* 缓存读失败不算错 */ }
    }
    return null;
  }

  async function _cacheSet(group, data, ttl) {
    _memCache[group] = data;
    if (window.Core && Core.Storage) {
      try {
        await Core.Storage.cacheSet(`market_${group}`, data, ttl);
      } catch (e) { /* ignore */ }
    }
  }

  const Market = {
    GROUPS: {
      wide: { label: '宽基', symbols: WIDE_SYMBOLS, ttl: TTL_WIDE },
      style: { label: '风格', symbols: STYLE_SYMBOLS, ttl: TTL_STYLE },
      industry: { label: '行业', ttl: TTL_INDUSTRY }
    },

    /**
     * 拉一组快照(带缓存,失败降级)
     * @returns {Promise<{group: string, items: any[], top?: any[], bottom?: any[], ts: number, stale: boolean, error?: string}>}
     */
    async get(group) {
      if (!this.GROUPS[group]) throw new Error('未知 group: ' + group);

      // 先查缓存
      const cached = await _cacheGet(group);
      if (cached && (Date.now() - cached.ts) < this.GROUPS[group].ttl) {
        return { ...cached, stale: false };
      }

      // 拉新
      try {
        let items, top, bottom;
        if (group === 'industry') {
          const r = await _fetchIndustry();
          top = r.top; bottom = r.bottom;
          items = [];
        } else {
          items = await _fetchIndices(this.GROUPS[group].symbols);
        }
        const snap = { group, items, top, bottom, ts: Date.now(), stale: false };
        await _cacheSet(group, snap, this.GROUPS[group].ttl);
        return snap;
      } catch (e) {
        console.warn('[Market] 拉取失败:', group, e);
        if (cached) {
          return { ...cached, stale: true, error: e.message };
        }
        return { group, items: [], top: [], bottom: [], ts: Date.now(), stale: true, error: e.message };
      }
    },

    /**
     * 强制刷新某组
     */
    async refresh(group) {
      _memCache[group] = null;
      if (window.Core && Core.Storage) {
        try { await Core.Storage.cacheSet(`market_${group}`, null, 0); } catch (e) { console.warn('[Market] 清缓存失败:', e); }
      }
      return this.get(group);
    },

    /**
     * 工具: 简单格式化(纯函数,可在 vm 测)
     */
    formatItem(it) {
      if (!it) return null;
      const sign = it.change > 0 ? '+' : '';
      return {
        code: it.code,
        name: it.name,
        price: typeof it.price === 'number' ? it.price.toFixed(2) : '-',
        change: typeof it.change === 'number' ? sign + it.change.toFixed(2) + '%' : '-',
        changeNum: it.change
      };
    }
  };

  window.Core = window.Core || {};
  window.Core.Market = Market;
})();
