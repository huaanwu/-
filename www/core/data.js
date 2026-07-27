/**
 * Core.Data - 数据获取层 (AKShare 代理 + 缓存)
 * 依赖: Core.Storage
 *
 * 设计:
 *   - 所有外部数据 fetch 走这个模块,自动过 IndexedDB 缓存
 *   - 开发环境:Vite proxy 转发到 dev-proxy.mjs → AKShare HTTP 服务
 *   - 生产环境(APK):用户需要在本地跑 dev-proxy,APK 访问局域网 IP
 *   - 配置项:Core.State 里存 proxyBase(默认 /api/akshare)
 */
(function() {
  'use strict';

  const DEFAULT_PROXY = '/api/akshare';
  const TENCENT_QUOTE = 'https://qt.gtimg.cn/q=';  // 腾讯财经行情, CORS 友好, GBK 编码

  // ===== 腾讯财经 fetcher (C 替代源) =====
  // 单只:  https://qt.gtimg.cn/q=sh600519     → v_sh600519="1~贵州茅台~...";
  // 多只:  https://qt.gtimg.cn/q=sh600519,sz000001
  // 编码:  GBK → 需要 TextDecoder('gb18030')
  // CORS:  Access-Control-Allow-Origin: * (浏览器直连 OK)
  // 字段(按 ~ 分隔):
  //   [1]=名称 [2]=代码 [3]=现价 [4]=昨收 [5]=今开
  //   [6]=成交量(手) [30]=时间 [31]=涨跌额 [32]=涨跌幅%
  //   [33]=最高 [34]=最低 [36]=总成交量(手) [37]=总成交额(万)
  //   [38]=换手率% [39]=市盈率 [43]=流通市值 [44]=总市值

  /**
   * 把 6 位代码转成腾讯前缀
   * 6: sh, 0/3: sz, 5: sh(基金)
   */
  function _tencentSymbol(code) {
    // 已有 sh/sz 前缀, 直接返
    if (/^(sh|sz)\d{6}$/i.test(code)) return code.toLowerCase();
    code = String(code).padStart(6, '0');
    if (code.startsWith('6')) return 'sh' + code;
    if (code.startsWith('0') || code.startsWith('3')) return 'sz' + code;
    if (code.startsWith('5')) return 'sh' + code;  // 沪市基金
    if (code.startsWith('1') || code.startsWith('2')) return 'sz' + code;  // 深市基金
    return 'sh' + code;
  }

  /**
   * 腾讯 fetcher, 直接调, 不走 dev-proxy
   * @param {string[]} codes 6 位代码数组 (可含 sh/sz 前缀, 自动识别)
   * @returns {Promise<Array>} aktools 风格的字段 (代码/名称/最新价/涨跌幅/...)
   */
  async function _tencentFetch(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    const symbols = codes.map(_tencentSymbol).join(',');
    const url = TENCENT_QUOTE + symbols;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    } catch (e) {
      throw new Error(`腾讯财经网络错误: ${e.message}`);
    }
    if (!resp.ok) throw new Error(`腾讯财经 HTTP ${resp.status}`);
    // GBK 解码
    const buf = await resp.arrayBuffer();
    const text = new TextDecoder('gb18030').decode(new Uint8Array(buf));
    return _tencentParse(text);
  }

  /**
   * 解析腾讯响应 (一行 v_sh600519="1~贵州茅台~...";)
   */
  function _tencentParse(text) {
    const lines = text.split(/;\s*/).filter(Boolean);
    const out = [];
    for (const line of lines) {
      const m = line.match(/^v_([a-z]{2}\d+)="(.+)"$/);
      if (!m) continue;
      const sym = m[1];
      const code = sym.slice(2);  // 去掉 sh/sz 前缀
      const fields = m[2].split('~');
      // 字段映射成 aktools 风格
      out.push({
        '代码': code,
        '名称': fields[1] || '',
        '最新价': _num(fields[3]),
        '昨收': _num(fields[4]),
        '今开': _num(fields[5]),
        '成交量': _num(fields[6]),  // 手
        '时间': fields[30] || '',
        '涨跌额': _num(fields[31]),
        '涨跌幅': _num(fields[32]),
        '最高': _num(fields[33]),
        '最低': _num(fields[34]),
        '总成交量': _num(fields[36]),
        '总成交额': _num(fields[37]),  // 万元
        '换手率': _num(fields[38]),
        '市盈率': _num(fields[39]),
        '流通市值': _num(fields[43]),
        '总市值': _num(fields[44])
      });
    }
    return out;
  }
  function _num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }

  /**
   * 腾讯 fetcher 的便捷接口:
   *   getStockSpotTencent()  - 拉自选股 + 持仓的代码, 一次性取
   *   getIndexSpotTencent()  - 拉 4 个主要指数
   */
  async function getStockSpotTencent(codes) {
    if (!codes || codes.length === 0) return [];
    return await _tencentFetch(codes);
  }
  async function getIndexSpotTencent() {
    // 4 个主要指数: 上证指数 sh000001, 深证成指 sz399001, 创业板指 sz399006, 沪深300 sh000300
    return await _tencentFetch(['sh000001', 'sz399001', 'sz399006', 'sh000300']);
  }

  // ===== 东方财富 fetcher (C 全市场 screener 用) =====
  // clist/get 一次拉所有 A股 (5000+), CORS 友好
  // URL: https://push2.eastmoney.com/api/qt/clist/get
  //   pn=1&pz=5000&po=1&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23
  //   fields=f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f20,f23
  // 字段(注意: f3/f8/f10/f20 是基点 0.01% 精度, f9 是市盈率 * 100):
  //   f12=代码 f14=名称 f2=最新价
  //   f3=涨跌幅(基点) f4=涨跌额 f5=成交量(手) f6=成交额(元)
  //   f8=换手率(基点) f9=市盈率(动, *100) f10=量比(基点)
  //   f20=流通市值(元) f23=市净率(*100)
  const EM_URL = 'https://push2.eastmoney.com/api/qt/clist/get';
  const EM_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';  // 沪主+科创+深主+创业
  const EM_FIELDS = 'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f20,f23';

  async function _efinanceFetch() {
    // 限流检查 (跟 _fetch 一致: 限流期内不发起请求)
    const s = getLimitStatus();
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${_limitState.lastError.slice(0, 100)})`);
    }
    const url = `${EM_URL}?pn=1&pz=5000&po=1&fs=${EM_FS}&fields=${EM_FIELDS}`;
    let resp;
    try {
      // 加 Referer + UA: 东方财富 ban Node 默认 UA
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://quote.eastmoney.com/'
        }
      });
    } catch (e) {
      throw new Error(`东方财富网络错误: ${e.message}`);
    }
    if (!resp.ok) {
      // 5xx 触发限流 (东财不返 429)
      if (resp.status >= 500) {
        _setLimit(60 * 1000, `HTTP ${resp.status}`);
      }
      throw new Error(`东方财富 HTTP ${resp.status}`);
    }
    let j;
    try { j = await resp.json(); } catch (e) {
      throw new Error('东方财富返非 JSON: ' + e.message);
    }
    if (!j.data || !j.data.diff) {
      throw new Error(`东方财富返空 (rc=${j.rc}, rt=${j.rt})`);
    }
    _limitState.lastSuccess = Date.now();
    // 字段映射成 aktools 风格
    const out = [];
    for (const k of Object.keys(j.data.diff)) {
      const r = j.data.diff[k];
      out.push({
        '代码': r.f12 || '',
        '名称': r.f14 || '',
        '最新价': _num(r.f2) / 100,           // 实际是元 * 100
        '涨跌幅': _num(r.f3) / 100,           // 基点 → %
        '涨跌额': _num(r.f4) / 100,           // 元 * 100
        '成交量': _num(r.f5),                  // 手 (实际数据是手, 但东方财富单位是"手"? 让我看)
        '成交额': _num(r.f6),                  // 元
        '换手率': _num(r.f8) / 100,           // 基点 → %
        '市盈率': _num(r.f9) / 100,           // *100 → 倍
        '量比': _num(r.f10) / 100,
        '流通市值': _num(r.f20),               // 元
        '市净率': _num(r.f23) / 100           // *100 → 倍
      });
    }
    return out;
  }

  /**
   * 东方财富全市场 fetcher, 直接调, 不走 dev-proxy
   */
  async function getStockSpotEfinance() {
    return await _efinanceFetch();
  }

  /**
   * 带缓存的东方财富 fetcher (60s TTL)
   */
  async function getStockSpotEfinanceCached() {
    const cached = await Core.Storage.cacheGet('stock_spot_all_efinance');
    if (cached) return cached;
    const data = await _efinanceFetch();
    await Core.Storage.cacheSet('stock_spot_all_efinance', data, 60 * 1000);
    return data;
  }

  // c (aktools 限流修复): 全局限流状态
  // 触发: HTTP 429 / 5xx 且 body 含限流关键字
  // 期间内 fetch 直接抛 "数据源限流, Ns 后可重试", 避免雪崩
  const _limitState = {
    blocked: false,
    until: 0,         // ms 时间戳
    lastError: '',    // 上次错误
    lastSuccess: 0    // 上次成功
  };

  function _setLimit(durationMs, err) {
    _limitState.blocked = true;
    _limitState.until = Date.now() + durationMs;
    _limitState.lastError = err;
    console.warn(`[Data] 数据源限流 ${Math.round(durationMs/1000)}s:`, err);
  }
  function _clearLimit() {
    if (_limitState.blocked) {
      console.log('[Data] 数据源恢复, 距上次成功', Date.now() - (_limitState.lastSuccess || Date.now()), 'ms');
    }
    _limitState.blocked = false;
    _limitState.until = 0;
  }
  /**
   * UI 读这个判断: { blocked, until, lastError, lastSuccess, retryIn }
   * retryIn = blocked ? max(0, until - now) : 0
   */
  function getLimitStatus() {
    const now = Date.now();
    return {
      blocked: _limitState.blocked && now < _limitState.until,
      until: _limitState.until,
      lastError: _limitState.lastError,
      lastSuccess: _limitState.lastSuccess,
      retryIn: _limitState.blocked ? Math.max(0, _limitState.until - now) : 0
    };
  }

  // 通用 fetch + JSON + 错误处理 + retry
  // 不在顶部检查限流 (留给 fetchWithCache 决定: 缓存命中不限流, 没缓存才限流)
  async function _fetch(path, params = {}, opts = {}) {
    const { retries = 2, baseDelay = 1500 } = opts;  // 第一次失败等 1.5s, 第二次 3s
    const base = (window.Core && Core.State && Core.State.get('proxyBase')) || DEFAULT_PROXY;
    const qs = new URLSearchParams(params).toString();
    const url = qs ? `${base}/${path}?${qs}` : `${base}/${path}`;

    let lastErr = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' }
        });
      } catch (e) {
        lastErr = new Error(`网络错误: ${e.message}。检查 AKShare 代理是否运行`);
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
          continue;
        }
        break;
      }

      if (resp.ok) {
        _clearLimit();
        _limitState.lastSuccess = Date.now();
        return await resp.json();
      }

      const text = await resp.text();
      // 限流信号: 429 / 5xx / 文本含限流关键字
      const isLimit = resp.status === 429
        || (resp.status >= 500 && resp.status < 600)
        || /limit|rate|频|限|too many|频繁/i.test(text.slice(0, 500));
      if (isLimit) {
        // 限流: 60s 退避, 不重试
        const dur = 60 * 1000;
        _setLimit(dur, `HTTP ${resp.status}: ${text.slice(0, 100)}`);
        throw new Error(`数据源限流 (HTTP ${resp.status}), 60s 后可重试`);
      }

      // 其他错误 (4xx 业务错误): 重试 1 次
      lastErr = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      if (attempt < retries) {
        await new Promise(r => setTimeout(r, baseDelay * (attempt + 1)));
        continue;
      }
    }
    throw lastErr;
  }

  /**
   * 带缓存的 fetch
   * @param {string} cacheKey - 缓存 key
   * @param {string} path - API path(不含 /api/akshare 前缀)
   * @param {object} params - 查询参数
   * @param {number} ttl - 缓存时间(ms),默认 5 分钟
   */
  async function fetchWithCache(cacheKey, path, params = {}, ttl = 5 * 60 * 1000) {
    // 1) 查缓存 (限流期也用缓存, 不发请求)
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    // 2) 没缓存: 限流期直接抛 (避免雪崩)
    const s = getLimitStatus();
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${_limitState.lastError.slice(0, 100)})`);
    }

    // 3) 拉新数据
    const data = await _fetch(path, params);

    // 4) 写缓存
    await Core.Storage.cacheSet(cacheKey, data, ttl);

    return data;
  }

  // ==================== 股票 ====================

  /**
   * 实时行情 (C: 优先腾讯, 失败时降级 aktools)
   * @param {string[]} [codes] 可选, 指定代码数组; 不传时用自选股+持仓 (但需要 Storage, 在调用方传)
   * 数据源 1 (默认): 腾讯财经 (qt.gtimg.cn) CORS 友好 + GBK → UTF8
   * 数据源 2 (降级): aktools stock_zh_a_spot
   */
  async function getStockSpot(codes) {
    if (Array.isArray(codes) && codes.length > 0) {
      // 优先腾讯
      try {
        return await getStockSpotTencent(codes);
      } catch (e) {
        console.warn('[Data] 腾讯失败, 降级 aktools:', e.message);
        // 降级: aktools 全市场, 然后过滤
        const all = await fetchWithCache(
          'stock_spot_all',
          'stock_zh_a_spot',
          {},
          60 * 1000
        );
        return all.filter(s => codes.includes(s.代码) || codes.includes(s.code));
      }
    }
    // 不传 codes: 优先东方财富全市场 (C 替代), 失败时降级 aktools
    try {
      return await getStockSpotEfinanceCached();
    } catch (e) {
      console.warn('[Data] 东方财富失败, 降级 aktools:', e.message);
      return await fetchWithCache(
        'stock_spot_all',
        'stock_zh_a_spot',
        {},
        60 * 1000
      );
    }
  }

  /**
   * 单只股票实时行情 (C: 优先腾讯)
   */
  async function getStockQuote(code) {
    try {
      const list = await getStockSpotTencent([code]);
      return list[0] || null;
    } catch (e) {
      console.warn('[Data] 腾讯 getStockQuote 失败, 降级 aktools:', e.message);
      const all = await getStockSpot();
      return all.find(s => s.代码 === code || s.code === code) || null;
    }
  }

  /**
   * 历史 K 线
   * @param {string} code - 6 位代码
   * @param {string} period - daily/weekly/monthly
   * @param {string} start - YYYYMMDD
   * @param {string} end - YYYYMMDD
   * @param {string} adjust - qfq/hfq(前/后复权)/空(不复权)
   */
  async function getStockKLine(code, period = 'daily', start, end, adjust = 'qfq') {
    return await fetchWithCache(
      `kline_${code}_${period}_${start}_${end}_${adjust}`,
      'stock_zh_a_hist',
      { symbol: code, period, start_date: start, end_date: end, adjust },
      24 * 60 * 60 * 1000  // 1 天
    );
  }

  /**
   * 个股财务摘要
   * 数据源: stock_zh_a_indicator 或 stock_financial_abstract
   */
  async function getStockFinancial(code) {
    return await fetchWithCache(
      `financial_${code}`,
      'stock_financial_abstract',
      { symbol: code },
      7 * 24 * 60 * 60 * 1000  // 7 天
    );
  }

  /**
   * A股全市场列表(用于选股筛选)
   */
  async function getStockList() {
    return await fetchWithCache(
      'stock_list_all',
      'stock_info_a_code_name',
      {},
      24 * 60 * 60 * 1000
    );
  }

  // ==================== 基金 ====================

  /**
   * 基金实时净值
   */
  async function getFundSpot(code) {
    return await fetchWithCache(
      `fund_spot_${code}`,
      'fund_open_fund_info_em',
      { fund: code, indicator: '单位净值走势' },
      60 * 60 * 1000  // 1 小时
    );
  }

  /**
   * 基金历史净值
   */
  async function getFundHistory(code, start, end) {
    return await fetchWithCache(
      `fund_hist_${code}_${start}_${end}`,
      'fund_open_fund_info_em',
      { fund: code, indicator: '单位净值走势', start_date: start, end_date: end },
      24 * 60 * 60 * 1000
    );
  }

  /**
   * 基金持仓(季度)
   */
  async function getFundPortfolio(code) {
    return await fetchWithCache(
      `fund_portfolio_${code}`,
      'fund_portfolio_hold_em',
      { fund: code },
      30 * 24 * 60 * 60 * 1000  // 30 天
    );
  }

  // ==================== 指数 ====================

  /**
   * 主要指数实时 (C: 优先腾讯, 失败时降级 aktools)
   */
  async function getIndexSpot() {
    try {
      return await getIndexSpotTencent();
    } catch (e) {
      console.warn('[Data] 腾讯指数失败, 降级 aktools:', e.message);
      return await fetchWithCache(
        'index_spot_main',
        'stock_zh_index_spot',
        { symbol: '上证指数,深证成指,创业板指,沪深300,中证500' },
        60 * 1000
      );
    }
  }

  // ==================== 自检 ====================

  /**
   * 健康检查(代理是否通)
   */
  async function health() {
    const base = (window.Core && Core.State && Core.State.get('proxyBase')) || DEFAULT_PROXY;
    try {
      const resp = await fetch(`${base}/health`);
      if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
      return await resp.json();
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.Data = {
    fetch: fetchWithCache,
    health,
    getLimitStatus,  // c: UI 读这个显示限流状态
    resetLimit: _clearLimit,  // 测试/手动重置
    // 股票
    getStockSpot, getStockQuote, getStockKLine, getStockFinancial, getStockList,
    getStockSpotTencent,    // C: 腾讯 fetcher (codes 参数, 实时)
    getStockSpotEfinance,  // C: 东方财富 fetcher (全市场, screener 用)
    // 基金
    getFundSpot, getFundHistory, getFundPortfolio,
    // 指数
    getIndexSpot, getIndexSpotTencent
  };
})();
