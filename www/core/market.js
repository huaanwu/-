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
   * 拉行业板块
   * 主源: 东方财富 push2 clist (m:90+t:2 申万一级);失败时 fallback 到新浪 industry (84 板块)
   * 返回 top 5 涨 + bottom 5 跌
   */
  async function _fetchIndustry() {
    if (!window.Core || !Core.Data) throw new Error('Core.Data 不可用');

    // 尝试 1: 东方财富 clist (m:90+t:2 申万一级)
    try {
      return await _fetchIndustryEastmoney();
    } catch (e1) {
      console.warn('[Market] 东财行业失败, 尝试新浪 fallback:', e1.message);
    }
    // 尝试 2: 新浪行业 fallback (84 板块申万)
    try {
      return await _fetchIndustrySina();
    } catch (e2) {
      console.warn('[Market] 新浪行业 fallback 也失败:', e2.message);
      throw new Error('所有行业源都失败: 东财+新浪');
    }
  }

  async function _fetchIndustryEastmoney() {
    const q = 'pn=1&pz=100&po=1&fs=m:90+t:2&fields=f12,f14,f2,f3,f4,f8';
    // 多个候选端点: 1) dev-proxy 转发 (开发环境) 2) 东财实时直连 (webview 常 fail) 3) 东财延迟直连 (兜底)
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const candidates = [
      { url: _apiUrl(`/api/eastmoney/api/qt/clist/get?${q}`), label: 'eastmoney-proxy' },
      { url: `https://push2.eastmoney.com/api/qt/clist/get?${q}`, label: 'push2-direct' },
      { url: `https://push2delay.eastmoney.com/api/qt/clist/get?${q}`, label: 'push2delay-direct' }
    ];
    let resp, used = null, lastErr = null;
    for (const c of candidates) {
      try {
        resp = await fetch(c.url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://quote.eastmoney.com/' } });
        if (resp.ok) { used = c.label; break; }
        lastErr = new Error(`${c.label} HTTP ${resp.status}`);
      } catch (e) {
        lastErr = new Error(`${c.label} ${e.message}`);
      }
    }
    if (!resp || !resp.ok) throw lastErr || new Error('行业所有源失败');
    let j;
    try { j = await resp.json(); }
    catch (e) { throw new Error(`${used} JSON 解析失败: ${e.message}`); }
    if (!j.data || !j.data.diff) throw new Error(`东方财富行业返空 (源: ${used})`);
    // 字段映射: f12 板块代码, f14 名称, f2 总成交额(万元), f3 涨跌幅(基点), f4 涨跌额(万元), f8 换手率(基点)
    const parsed = Object.values(j.data.diff).map(r => ({
      code: r.f12 || '',
      name: r.f14 || '',
      price: 0,
      amount: _num(r.f2),
      change: _num(r.f3) / 100,
      changeAmt: _num(r.f4) / 100,
      turnover: _num(r.f8) / 100
    })).filter(x => x.name);
    if (parsed.length === 0) throw new Error('东方财富解析后为空');
    parsed.sort((a, b) => b.change - a.change);
    return {
      top: parsed.slice(0, 5),
      bottom: parsed.slice(-5).reverse(),
      source: used || 'eastmoney'
    };
  }

  /**
   * 新浪行业 fallback
   * 端点: /api/sina/q/view/newFLJK.php?param=industry  (84 板块, GBK 编码)
   * 数据格式: var S_Finance_bankuai_industry = {"板块代码":"code,名,家数,均价,涨跌额,涨跌幅%,成交量,成交额,领涨代码,领涨%,领涨价,领涨额,领涨名",...}
   * 注意: 新浪端点只支持 HTTP;https 会返 [];proxy 时强制 changeOrigin:true 让上游认 HTTP
   */
  async function _fetchIndustrySina() {
    // 多个候选: 1) dev-proxy 转发 (开发环境) 2) 新浪直接 (APK 兜底, 但 CORS 可能拒, 用 no-cors 不行; 用 origin 头)
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const candidates = [
      { url: _apiUrl('/api/sina/q/view/newFLJK.php?param=industry'), label: 'sina-proxy' },
      { url: 'http://vip.stock.finance.sina.com.cn/q/view/newFLJK.php?param=industry', label: 'sina-direct' }
    ];
    let resp, used = null, lastErr = null;
    for (const c of candidates) {
      try {
        resp = await fetch(c.url, { headers: { 'Referer': 'https://finance.sina.com.cn/' } });
        if (resp.ok) { used = c.label; break; }
        lastErr = new Error(`${c.label} HTTP ${resp.status}`);
      } catch (e) {
        lastErr = new Error(`${c.label} ${e.message}`);
      }
    }
    if (!resp || !resp.ok) throw lastErr || new Error('新浪行业所有源失败');
    // 上游返回 GBK 编码 (text/html; charset=gbk),浏览器 text() 不会自动转码,需要手动 GBK → UTF-8
    let text;
    try {
      const buf = await resp.arrayBuffer();
      text = new TextDecoder('gbk', { fatal: false }).decode(buf);
    } catch (e) {
      // 兜底: 浏览器不支持 GBK 时退回 text()
      console.warn('[Market] GBK 解码失败, 退回 text() 兜底:', e.message);
      text = await resp.text();
    }
    // 提取 JSON 对象 (格式: var xxx = {...}; 或直接 {...})
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < 0) throw new Error('新浪行业无 JSON');
    let json;
    try {
      json = JSON.parse(text.slice(start, end + 1));
    } catch (e) {
      throw new Error('新浪行业 JSON 解析失败: ' + e.message);
    }
    // 字段顺序: code, name, companyCount, avgPrice, changeAmt, change, volume, amount, leaderCode, leaderPct, leaderPrice, leaderChangeAmt, leaderName
    const parsed = Object.entries(json).map(([k, v]) => {
      const f = v.split(',');
      return {
        code: f[0] || '',
        name: (f[1] || '').replace(/\s+/g, '').trim(),
        companyCount: _num(f[2]),
        avgPrice: _num(f[3]),
        changeAmt: _num(f[4]),
        change: _num(f[5]),  // 已是百分比单位
        volume: _num(f[6]),
        amount: _num(f[7]),
        leaderCode: f[8] || '',
        leaderPct: _num(f[9]),
        leaderPrice: _num(f[10]),
        leaderChangeAmt: _num(f[11]),
        leaderName: (f[12] || '').trim()
      };
    }).filter(x => x.name && x.name.length > 0);
    if (parsed.length === 0) throw new Error('新浪解析后为空');
    parsed.sort((a, b) => b.change - a.change);
    // 兼容 market-bar.js 旧字段名 it.leader
    parsed.forEach(it => { it.leader = it.leaderName; });
    return {
      top: parsed.slice(0, 5),
      bottom: parsed.slice(-5).reverse(),
      source: 'sina'
    };
  }
  function _num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }

  // 缓存 (内存, + storage 备份)
  const _memCache = { wide: null, style: null, industry: null };

  async function _cacheGet(group, ttl) {
    // 内存 + IndexedDB 都查,但必须看 ttl,避免 fetch 失败时持久化的 stale 快照一直返 stale:false
    const checkTs = (entry) => entry && (Date.now() - entry.ts) < ttl;
    if (_memCache[group] && checkTs(_memCache[group])) return _memCache[group];
    _memCache[group] = null;  // 内存过期, 先清, 避免下面写入时混淆
    if (window.Core && Core.Storage) {
      try {
        const stored = await Core.Storage.cacheGet(`market_${group}`);
        if (checkTs(stored)) { _memCache[group] = stored; return stored; }
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

      // 先查缓存 (ttl 由 _cacheGet 内部检查)
      const cached = await _cacheGet(group, this.GROUPS[group].ttl);
      if (cached) {
        return { ...cached, stale: false };
      }

      // 拉新
      try {
        let items, top, bottom;
        if (group === 'industry') {
          let r;
          try { r = await _fetchIndustry(); } catch (e) { throw new Error('行业数据拉取失败: ' + e.message); }
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
     * 预热: 后台并行拉宽基 + 风格快照, fire-and-forget
     * - opts.force: 默认 false — 30s 内已有快照则跳过网络
     * - opts.delay: 默认 0 — 延迟 ms 后再触发 (用于 idle 调用)
     * 失败仅 console.warn, 不抛
     */
    warmup(opts) {
      opts = opts || {};
      const force = !!opts.force;
      const delay = Number(opts.delay) || 0;
      const SNAPSHOT_FRESH_MS = 30 * 1000;

      const start = async () => {
        try {
          // 30s 短路: 缓存新鲜则跳过网络
          if (!force && window.Core && Core.Storage && Core.Storage.cacheGet) {
            try {
              const cached = await Core.Storage.cacheGet('market_warmup');
              if (cached && (Date.now() - (cached.ts || 0)) < SNAPSHOT_FRESH_MS) {
                return cached;
              }
            } catch (e) { /* 缓存读失败不算错 */ }
          }

          // 并行拉 wide + style
          const [wideR, styleR] = await Promise.all([
            Promise.resolve().then(() => this.get('wide')).catch(e => { throw new Error('wide: ' + e.message); }),
            Promise.resolve().then(() => this.get('style')).catch(e => { throw new Error('style: ' + e.message); })
          ]);

          const snap = {
            wide: (wideR && Array.isArray(wideR.items)) ? wideR.items : [],
            style: (styleR && Array.isArray(styleR.items)) ? styleR.items : [],
            ts: Date.now()
          };

          if (window.Core && Core.Storage && Core.Storage.cacheSet) {
            try { await Core.Storage.cacheSet('market_warmup', snap, TTL_WIDE); } catch (e) { /* ignore */ }
          }
          return snap;
        } catch (e) {
          console.warn('[Market] warmup 失败:', e.message || e);
          return null;
        }
      };

      if (delay > 0) {
        setTimeout(start, delay);
        // 立即返一个占位 Promise, 让调用方 .catch() 不炸; 等到 setTimeout 真正触发时跑 start()
        // 注意: 调用方拿到的 Promise 与延迟执行的 start() 不是同一个 Promise — 这里只是兼容 .catch 句法
        return Promise.resolve();
      }
      return start();
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
    },

    // ========== 扩展 #2: 持仓 + 候选池 批量预下载 K 线 ==========
    // 走 market-warmup-pure.mjs 的 warmupHoldings (纯函数, 可测)
    // opts: { force, includeHoldings, includeCandidates, onProgress }
    async warmupHoldings(opts) {
      if (!window.Core || !Core.MarketWarmupPure || !Core.MarketWarmupPure.warmupHoldings) {
        console.warn('[Market] warmupHoldings 未加载 (market-warmup-pure.mjs)');
        return null;
      }
      const deps = {
        listHoldings: async () => {
          if (Core.Holdings && typeof Core.Holdings.list === 'function') {
            return await Core.Holdings.list();
          }
          return [];
        },
        listCandidates: async () => {
          // 候选池走 reverse-watch 的 REVERSE_POOL, 由 app 注入
          if (window.__REVERSE_POOL_CODES__ && Array.isArray(window.__REVERSE_POOL_CODES__)) {
            return window.__REVERSE_POOL_CODES__;
          }
          return [];
        },
        fetchKLine: async (code, start, end, adjust) => {
          if (Core.Data && typeof Core.Data.getStockKLine === 'function') {
            return await Core.Data.getStockKLine(code, 'daily', start, end, adjust);
          }
          return [];
        },
        cacheGet: async (key) => {
          if (Core.Storage && typeof Core.Storage.cacheGet === 'function') {
            return await Core.Storage.cacheGet(key);
          }
          return null;
        },
        cacheSet: async (key, val) => {
          if (Core.Storage && typeof Core.Storage.cacheSet === 'function') {
            return await Core.Storage.cacheSet(key, val);
          }
        }
      };
      return await Core.MarketWarmupPure.warmupHoldings({ deps, opts: opts || {} });
    },

    // 注册盘前/盘后自动预下载定时器
    // opts: { slots, runOnStart, now }
    // 返回: { timers, nextRun, nextMode, cancel }
    scheduleWarmup(opts) {
      if (!window.Core || !Core.MarketWarmupPure || !Core.MarketWarmupPure.scheduleWarmup) {
        console.warn('[Market] scheduleWarmup 未加载 (market-warmup-pure.mjs)');
        return { timers: [], nextRun: null, nextMode: null, cancel: () => {} };
      }
      const self = this;
      const deps = {
        // 拉 wide+style — 复用 Market 自身的 get (走 group='wide' / 'style')
        warmup: async (o) => self.warmup(o || {}),
        listHoldings: async () => {
          if (Core.Holdings && typeof Core.Holdings.list === 'function') {
            return await Core.Holdings.list();
          }
          return [];
        },
        listCandidates: async () => {
          if (window.__REVERSE_POOL_CODES__ && Array.isArray(window.__REVERSE_POOL_CODES__)) {
            return window.__REVERSE_POOL_CODES__;
          }
          return [];
        },
        fetchKLine: async (code, start, end, adjust) => {
          if (Core.Data && typeof Core.Data.getStockKLine === 'function') {
            return await Core.Data.getStockKLine(code, 'daily', start, end, adjust);
          }
          return [];
        },
        cacheGet: async (key) => {
          if (Core.Storage && typeof Core.Storage.cacheGet === 'function') {
            return await Core.Storage.cacheGet(key);
          }
          return null;
        },
        cacheSet: async (key, val) => {
          if (Core.Storage && typeof Core.Storage.cacheSet === 'function') {
            return await Core.Storage.cacheSet(key, val);
          }
        }
      };
      return Core.MarketWarmupPure.scheduleWarmup({ deps, opts: opts || {} });
    }
  };

  window.Core = window.Core || {};
  window.Core.Market = Market;
})();
