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
  const SINA_QUOTE = 'https://hq.sinajs.cn/list='; // 新浪兜底 (腾讯失败时降级), GBK, 需 Referer

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
    let buf;
    try {
      buf = await resp.arrayBuffer();
    } catch (e) {
      throw new Error(`响应解码失败 (resp.arrayBuffer 不可用): ${e.message || e}`);
    }
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

  /**
   * 新浪行情 fetcher (Z13: 腾讯失败兜底). 单只/批量 codes 都支持.
   *   URL: hq.sinajs.cn/list=sh600519,sz000001
   *   强制 Referer: https://finance.sina.com.cn/ (否则 403)
   *   GBK 编码
   * 字段:
   *   0 名称  1 今开  2 昨收  3 当前价  4 今日最高  5 今日最低
   *   6 买一价 7 卖一价  8 成交量(股)  9 成交金额(元)  ...
   *   30 日期  31 时间
   * 涨跌幅 / 涨跌额 不直给, 用 (现价 - 昨收) 推算.
   * 换手率 / 市盈率 / 流通市值 不在免费接口 — 留 null.
   */
  async function _sinaFetch(codes) {
    if (!Array.isArray(codes) || codes.length === 0) return [];
    const symbols = codes.map(_tencentSymbol).join(',');
    const url = SINA_QUOTE + symbols;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'Referer': 'https://finance.sina.com.cn/',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    } catch (e) {
      throw new Error(`新浪财经网络错误: ${e.message}`);
    }
    if (!resp.ok) throw new Error(`新浪财经 HTTP ${resp.status}`);
    // GBK 解码 (跟 _tencentFetch 一致)
    let buf;
    try {
      buf = await resp.arrayBuffer();
    } catch (e) {
      throw new Error(`响应解码失败 (resp.arrayBuffer 不可用): ${e.message || e}`);
    }
    const text = new TextDecoder('gb18030').decode(new Uint8Array(buf));
    return _sinaParse(text, codes);
  }

  /**
   * 解析新浪响应.
   *   每行格式: var hq_str_sh600519="贵州茅台,1308.00,...,日期,时间";
   *   字段有 null (港股休市) — 涨跌幅 = null, 不要硬算 0
   */
  function _sinaParse(text, codes) {
    const out = [];
    const lines = text.split(/;\s*/).filter(Boolean);
    // codeByIndex: 新浪响应顺序按请求顺序排, 但保险起见再从 var 名解析
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const m = line.match(/^var hq_str_([a-z]{2}\d+)="(.+)"$/);
      if (!m) continue;
      const sym = m[1];
      const code = sym.slice(2);
      const fields = m[2].split(',');
      // 字段可能在收盘后或港股时为空字符串 — 安全 parseFloat
      const safe = (idx) => {
        const v = fields[idx];
        if (v == null || v === '') return null;
        const n = parseFloat(v);
        return isNaN(n) ? null : n;
      };
      const latest = safe(3);   // 当前价 (核心)
      const prevClose = safe(2);  // 昨收
      // 涨跌幅 / 涨跌额: 仅当两者都有效才计算
      const change = (latest != null && prevClose != null && prevClose !== 0)
        ? latest - prevClose : null;
      const changePct = (change != null && prevClose != null && prevClose !== 0)
        ? (change / prevClose) * 100 : null;
      out.push({
        代码: code,
        名称: fields[0] || '',
        最新价: latest,
        昨收: prevClose,
        今开: safe(1),
        最高: safe(4),
        最低: safe(5),
        成交量: safe(8),         // 股 (新浪直给股数, 不用 ×100)
        成交额: safe(9),         // 元
        时间: fields[31] ? `${fields[30] || ''} ${fields[31]}` : '',
        涨跌额: change,
        涨跌幅: changePct,
        // 换手率 / 市盈率 / 流通市值不在免费接口 — null (UI 显示 '-')
        换手率: null,
        市盈率: null,
        流通市值: null,
        总市值: null
      });
    }
    // 用请求 codes 顺序排序 (新浪按请求顺序响应, 但保险)
    const codeMap = {};
    out.forEach(r => { codeMap[r.代码] = r; });
    return codes.map(c => codeMap[c] || codeMap[_tencentSymbol(c).slice(2)]).filter(Boolean);
  }

  function _num(s) { const n = parseFloat(s); return isNaN(n) ? 0 : n; }
  // Y12 修复: 字段缺位 (腾讯 K 线只返 6 列, aktools 返 12) 时返 null, 不要变 0
  function _numOrNull(s) {
    if (s == null || s === '') return null;
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // ===== 腾讯财经 K 线 fetcher (Y12: 备用源) =====
  // URL: https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param={symbol},{period},{start},{end},{count},{adjust}
  //   symbol: sh600519 / sz000001
  //   period: day / week / month / m5/m15/m30/m60 (分钟)
  //   start/end: YYYY-MM-DD (或不传, 用 count)
  //   count: 返回根数
  //   adjust: qfq (前复权) / hfq (后复权) / 空 (不复权)
  // 编码: UTF-8 (JSON)
  // CORS: Access-Control-Allow-Origin: * (浏览器直连 OK)
  // 返回 JSON 结构:
  //   { code: 0, msg: '', data: { sh600519: { qfqday: [[date, open, close, high, low, vol, ...], ...],
  //                                            qfq: [...], qfqweek: [...], qfqmonth: [...] } } }
  const TENCENT_KLINE = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get';

  /**
   * 拉腾讯 K 线, 字段归一化到 aktools 风格 (中文键)
   * @param {string} code 6 位代码 (可含 sh/sz 前缀)
   * @param {string} period day/week/month
   * @param {string} [start] YYYYMMDD (可省, 用 count)
   * @param {string} [end] YYYYMMDD (可省)
   * @param {number} [count] 根数 (默认 240, ≈ 一年日 K)
   * @param {string} [adjust] qfq/hfq/空 (默认 qfq)
   * @returns {Promise<Array>} 数组元素: {日期, 开盘, 收盘, 最高, 最低, 成交量, 成交额, 振幅, 涨跌幅, 涨跌额, 换手率}
   */
  async function _tencentKLine(code, period = 'day', start, end, count = 240, adjust = 'qfq') {
    const symbol = _tencentSymbol(code);
    const p = period === 'daily' ? 'day' : (period === 'weekly' ? 'week' : (period === 'monthly' ? 'month' : period));
    // Tencent 调整字段名: qfq/hfq day / qfq/hfq week / qfq/hfq month
    const adjKey = adjust === 'hfq' ? `hfq${p}` : (adjust === '' ? p : `qfq${p}`);
    const params = [`${symbol}`, `${p}`, start || '', end || '', `${count}`, `${adjust}`];
    const url = `${TENCENT_KLINE}?param=${params.join(',')}`;

    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      });
    } catch (e) {
      throw new Error(`腾讯 K 线网络错误: ${e.message}`);
    }
    if (!resp.ok) throw new Error(`腾讯 K 线 HTTP ${resp.status}`);

    const text = await resp.text();
    let j;
    try { j = JSON.parse(text); }
    catch (e) { throw new Error(`腾讯 K 线 JSON 解析失败: ${e.message}`); }

    if (j.code !== 0) throw new Error(`腾讯 K 线 code=${j.code} ${j.msg || ''}`);
    const stock = j.data?.[symbol];
    if (!stock) throw new Error(`腾讯 K 线无 ${symbol} 数据`);
    const rows = stock[adjKey] || stock[p] || [];
    if (!Array.isArray(rows) || rows.length === 0) return [];

    // 归一化到 aktools 风格
    return rows.map(row => {
      // 腾讯字段: [日期, 开盘, 收盘, 最高, 最低, 成交量(手), 信息, 成交额, 振幅%, 涨跌幅%, 涨跌额, 换手率%]
      // 实际只返 6 列 (0-5), 7-11 是 undefined → 用 _numOrNull 区别"无"和 0
      return {
        日期: row[0],
        开盘: _num(row[1]),
        收盘: _num(row[2]),
        最高: _num(row[3]),
        最低: _num(row[4]),
        成交量: _num(row[5]) * 100,           // 手 → 股
        成交额: _numOrNull(row[7]),            // 多数情况缺位
        振幅: _numOrNull(row[8]),
        涨跌幅: _numOrNull(row[9]),
        涨跌额: _numOrNull(row[10]),
        换手率: _numOrNull(row[11])
      };
    });
  }

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
      // 降级链: 腾讯 → 新浪 → aktools
      // 1) 腾讯 (主, 最快)
      try {
        return await getStockSpotTencent(codes);
      } catch (e) {
        console.warn('[Data] 腾讯失败, 降级新浪:', e.message);
      }
      // 2) 新浪 (兜底, GBK, 需 Referer)
      try {
        return await _sinaFetch(codes);
      } catch (e) {
        console.warn('[Data] 新浪失败, 降级 aktools:', e.message);
      }
      // 3) aktools (终极, 但如果不通会自动 throw 让 UI 显示)
      const all = await fetchWithCache(
        'stock_spot_all',
        'stock_zh_a_spot',
        {},
        60 * 1000
      );
      return all.filter(s => codes.includes(s.代码) || codes.includes(s.code));
    }
    // 不传 codes: 优先东方财富全市场 (C 替代), 失败时不依赖 aktools (免等后端)
    try {
      return await getStockSpotEfinanceCached();
    } catch (e) {
      console.warn('[Data] 东方财富失败, 返回空 (不依赖 aktools):', e.message);
      return [];
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
   * 历史 K 线 (Y12: 优先 Tencent, 失败降级 aktools)
   * @param {string} code - 6 位代码
   * @param {string} period - daily/weekly/monthly
   * @param {string} start - YYYYMMDD
   * @param {string} end - YYYYMMDD
   * @param {string} adjust - qfq/hfq(前/后复权)/空(不复权)
   */
  async function getStockKLine(code, period = 'daily', start, end, adjust = 'qfq') {
    const cacheKey = `kline_${code}_${period}_${start}_${end}_${adjust}`;
    // 1) 缓存优先
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    // 2) 限流期直接抛 (同 fetchWithCache 行为)
    const s = getLimitStatus();
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${_limitState.lastError.slice(0, 100)})`);
    }

    // 3) 优先腾讯 (Y12)
    try {
      const data = await _tencentKLine(code, period, start, end, 240, adjust);
      await Core.Storage.cacheSet(cacheKey, data, 24 * 60 * 60 * 1000);
      return data;
    } catch (e) {
      console.warn('[Data] 腾讯 K 线失败, 降级 aktools:', e.message);
      // 4) 降级 aktools
      return await fetchWithCache(
        cacheKey,
        'stock_zh_a_hist',
        { symbol: code, period, start_date: start, end_date: end, adjust },
        24 * 60 * 60 * 1000
      );
    }
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
   * 个股近 N 期财务指标对比 (Phase R)
   * 数据源: stock_financial_analysis_indicator_em (东方财富, AKShare 1.13+ 替换 stock_zh_a_financial_indicator)
   *   - symbol 必须带市场后缀: '600519.SH' / '301389.SZ'
   *   - 返回结构: {result: {data: [...]}}, 数组按 REPORT_DATE DESC
   *   - 字段名: 大写英文缩写 (TOTALOPERATEREVE 营收 / PARENTNETPROFIT 净利 / XSMLL 毛利率 ...)
   * 用途: stock-advisor.js 的"📊 财报深度读"tab
   * 缓存: 7 天 (财报季才会更新, 缓存长一些省 IO)
   */
  async function getStockFinancialHistory(code) {
    const symbolWithSuffix = _addExchangeSuffix(code);
    const raw = await fetchWithCache(
      `financial_hist_${symbolWithSuffix}`,
      'stock_financial_analysis_indicator_em',
      { symbol: symbolWithSuffix, indicator: '按报告期' },
      7 * 24 * 60 * 60 * 1000  // 7 天
    );
    // 解开 {result: {data: [...]}}, 返回数组
    if (raw && raw.result && Array.isArray(raw.result.data)) return raw.result.data;
    return Array.isArray(raw) ? raw : [];
  }

  // ============ 财报披露日历 (Phase U) ============
  // 缓存: 本季度日历 (key = year-Qx), 1 天 (季度披露计划基本不变, 但临近披露日时可能有更新)
  const _calCache = new Map();
  const _CAL_TTL = 24 * 60 * 60 * 1000;

  /**
   * 拉某个季度的全市场财报披露日历 (东方财富)
   * @param {number} year
   * @param {number} quarter 1-4
   * @returns {Promise<Array<{code, name, noticeDate, reportPeriod}>>}
   */
  async function getFinancialCalendar(year, quarter) {
    const key = `${year}-Q${quarter}`;
    const now = Date.now();
    const cached = _calCache.get(key);
    if (cached && now - cached.at < _CAL_TTL) return cached.list;
    const raw = await fetchWithCache(
      `fin_calendar_${key}`,
      'stock_financial_calendar_em',
      { year, quarter },
      _CAL_TTL
    );
    const list = _normalizeCalendar(Array.isArray(raw) ? raw : []);
    _calCache.set(key, { at: now, list });
    return list;
  }

  /**
   * 容错多种 AKShare 字段名 (agent 回报字段可能是 stock_code / 股票代码 等)
   */
  function _normalizeCalendar(rows) {
    const out = [];
    for (const row of rows) {
      const code = row.stock_code || row['股票代码'] || row.code;
      const name = row.stock_name || row['股票简称'] || row.name || '';
      const noticeDate = row.notice_date || row['财报披露日期'] || row['披露日期'] || row.date || row['公告日期'];
      const reportPeriod = row.report_period || row['报告期'] || '';
      if (code && noticeDate) {
        out.push({ code: String(code).padStart(6, '0'), name: String(name), noticeDate: String(noticeDate).slice(0, 10), reportPeriod: String(reportPeriod) });
      }
    }
    return out;
  }

  /**
   * 当前季度 (基于当前日期)
   */
  function _currentQuarter(d = new Date()) {
    const m = d.getMonth() + 1;
    return { year: d.getFullYear(), quarter: m <= 3 ? 1 : (m <= 6 ? 2 : (m <= 9 ? 3 : 4)) };
  }

  /**
   * 个股的下次财报披露日期 (Phase U 给 alerts.js 用)
   * 在当季日历里查 code, 没找到返回 null
   * @param {string} code 6 位
   * @returns {Promise<{noticeDate, reportPeriod}|null>}
   */
  async function getStockNextDisclosure(code) {
    const c = String(code || '').padStart(6, '0');
    const q = _currentQuarter();
    const list = await getFinancialCalendar(q.year, q.quarter);
    const hit = list.find(r => r.code === c);
    return hit ? { noticeDate: hit.noticeDate, reportPeriod: hit.reportPeriod } : null;
  }

  // ============ 排雷数据 (Phase Y.1) ============
  // 4 类 fetcher 全部走标准 fetchWithCache 模板, 调用方独立 try/catch
  // 失败策略: 每个 fetcher 内部不抛, 客户端 .catch 兜底

  /** (A) 全市场商誉明细 (东方财富 /sy/list.html) — date 仅半年末/年末有效 */
  async function getStockGoodwillRanks() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const date = m >= 7 ? `${y}0630` : `${y - 1}1231`;
    return await fetchWithCache(
      `risk_goodwill_${date}`,
      'stock_sy_em',
      { date },
      7 * 24 * 60 * 60 * 1000  // 7 天 (半年报周期)
    );
  }

  /** (B) 东财高管/股东减持公告 (symbol='股东减持' 取减持明细) */
  async function getStockHolderDecreases() {
    return await fetchWithCache(
      'risk_decrease_em',
      'stock_ggcg_em',
      { symbol: '股东减持' },
      6 * 60 * 60 * 1000  // 6 小时 (公告是滚动数据)
    );
  }

  /** (C) 业绩预告 (最近一期, 半年内过滤, 含首亏/续亏/预减)
   *    复用 _fetchEarningsCalendar 已验证的字段容错模板 */
  async function getStockEarningsForecastFresh() {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const today2 = today.replace(/-/g, '');
    const raw = await fetchWithCache(
      `risk_yjyg_${today2}`,
      'stock_yjyg_em',
      {},
      6 * 60 * 60 * 1000  // 6 小时
    );
    if (!Array.isArray(raw)) return [];
    const halfYearAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
    return raw.filter(r => {
      const t = (r['业绩预告类型'] || r['预告类型'] || '').toString();
      if (!/增|减|扭亏|首亏|续亏|续盈/.test(t)) return false;
      const dStr = r['公告日期'] || r['最新公告日期'] || r['报告日期'] || r['发布日期'];
      if (dStr) {
        const ts = Date.parse(dStr);
        if (!isNaN(ts) && ts < halfYearAgo) return false;
      }
      return true;
    }).map(r => ({
      code: String(r['股票代码'] || r.code || '').padStart(6, '0'),
      name: r['股票简称'] || r.name || '',
      type: r['业绩预告类型'] || r['预告类型'] || '',
      summary: r['业绩预告摘要'] || r.summary || '',
      reportDate: r['公告日期'] || r['最新公告日期'] || r['报告日期'] || r['发布日期'] || ''
    }));
  }

  /** (D) 个股资金流排行 (今日, 个股主力净流入净流出) */
  async function getStockCapitalFlight() {
    return await fetchWithCache(
      'risk_capital_flight_today',
      'stock_individual_fund_flow_rank',
      { indicator: '今日' },
      5 * 60 * 1000  // 5 分钟 (日内高频)
    );
  }

  /**
   * 给 6 位代码补市场后缀 (Phase R)
   * 6/9: SH (沪市主板 + B 股)
   * 0/3: SZ (深市主板 + 创业板)
   * 4/8: BJ (北交所)
   */
  function _addExchangeSuffix(code) {
    const c = String(code || '').padStart(6, '0');
    if (/\.(SH|SZ|BJ)$/i.test(c)) return c.toUpperCase();
    if (c.startsWith('6') || c.startsWith('9')) return c + '.SH';
    if (c.startsWith('0') || c.startsWith('3')) return c + '.SZ';
    if (c.startsWith('4') || c.startsWith('8')) return c + '.BJ';
    return c + '.SH';
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

  /**
   * 上海黄金交易所 Au9999 基准价 (Phase J)
   * 走标准 aktools 通道 (dev-proxy 转发 → akshare Python → spot_golden_benchmark_sge),
   * 24h 缓存。如果 aktools 离线 → fail-safe 返 null (调用方降级为不接黄金段)。
   */
  const _GOLD_CACHE = 'gold_au9999_v1';
  const _GOLD_TTL = 24 * 60 * 60 * 1000;

  async function _fetchSgeAu9999() {
    // 走标准 aktools 通道
    const data = await Core.Data.fetch('ak_gold_benchmark', 'spot_golden_benchmark_sge', {}, _GOLD_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    // Y4: 先按字段名取 (date/open/close/latest/price), 找不到再按位置 fallback
    const pickField = (obj, names) => {
      for (const n of names) {
        for (const k of Object.keys(obj || {})) {
          if (k && k.toLowerCase().includes(n.toLowerCase())) return obj[k];
        }
      }
      return undefined;
    };
    const rows = data.slice(-90).map((r, i) => {
      if (!r || typeof r !== 'object') return null;
      // 字段名优先
      let dateRaw = pickField(r, ['date', '日期', '统计日期']);
      let openRaw = pickField(r, ['open', '开盘', '开盘价']);
      let closeRaw = pickField(r, ['close', 'latest', '最新', '收盘', '收盘价', 'price', '现价']);
      // 位置 fallback (aktools 中文乱码常见)
      if (closeRaw == null) {
        const vals = Object.values(r);
        if (vals.length < 3) return null;
        dateRaw = dateRaw != null ? dateRaw : vals[0];
        openRaw = openRaw != null ? openRaw : vals[1];
        closeRaw = vals[2];
      }
      const close = parseFloat(closeRaw);
      const open = parseFloat(openRaw);
      if (isNaN(close)) return null;
      let dateStr;
      if (typeof dateRaw === 'string') {
        dateStr = dateRaw.replace(/-/g, '').slice(0, 8);
        if (dateStr.length === 8) dateStr = dateStr.slice(0, 4) + '-' + dateStr.slice(4, 6) + '-' + dateStr.slice(6, 8);
      } else if (dateRaw && dateRaw.toISOString) {
        dateStr = dateRaw.toISOString().slice(0, 10);
      } else {
        dateStr = String(dateRaw || '');
      }
      return { date: dateStr, open: isNaN(open) ? null : open, close };
    }).filter(Boolean);
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    return {
      generated: new Date().toISOString(),
      unit: '元/克',
      current: { date: last.date, open: last.open, close: last.close },
      history: rows
    };
  }

  async function getGoldAu9999() {
    const cached = await Core.Storage.cacheGet(_GOLD_CACHE);
    if (cached) return cached;
    try {
      const snap = await _fetchSgeAu9999();
      if (!snap) return null;
      await Core.Storage.cacheSet(_GOLD_CACHE, snap, _GOLD_TTL);
      return snap;
    } catch (e) {
      console.warn('[Gold] aktools SGE 拉取失败:', e.message || e);
      return null;
    }
  }

  /**
   * 格式化黄金快照为 prompt 友好的中文
   * 输入: getGoldAu9999() 的返回值 (可能为 null → 返 '⚠ 黄金数据拉取失败')
   */
  function formatGoldForPrompt(snap, historyDays = 30) {
    if (!snap || !snap.current) {
      return '⚠ 黄金 Au9999 数据拉取失败 (SGE 公开接口不可达或离线)';
    }
    const cur = snap.current;
    const hist = (snap.history || []).slice(-historyDays);
    let changeInfo = '';
    if (hist.length >= 2) {
      const first = hist[0].close;
      const chg = ((cur.close - first) / first) * 100;
      changeInfo = `, 近 ${historyDays} 日 ${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%`;
    }
    let lines = [];
    lines.push(`## 黄金 Au9999 基准价 (生成于 ${snap.generated.slice(0, 16).replace('T', ' ')})`);
    lines.push(`- **当前**: ${cur.close} 元/克 (开盘 ${cur.open !== null ? cur.open : '-'} 元/克, 数据日 ${cur.date})${changeInfo}`);
    if (hist.length >= 5) {
      const high = Math.max(...hist.map(h => h.close));
      const low = Math.min(...hist.map(h => h.close));
      lines.push(`- **区间**: 近 ${historyDays} 日最高 ${high.toFixed(2)} 元/克, 最低 ${low.toFixed(2)} 元/克`);
    }
    return lines.join('\n');
  }

  // ===== Phase L: 国际形势 4 维 =====
  // 1) 美股 3 大指数 (道指/纳指/标普), 2) 美元指数 (DXY), 3) 离岸人民币/美元, 4) 原油 WTI
  // 全部走 aktools (dev-proxy → :8088), 24h 缓存, fail-safe 返 null

  const _INTL_CACHE = 'intl_snapshot_v1';
  const _INTL_TTL = 24 * 60 * 60 * 1000;

  async function _safeIntlFetch(name, fetcher) {
    try {
      const data = await fetcher();
      return data || null;
    } catch (e) {
      console.warn(`[Intl] ${name} 失败:`, e.message || e);
      return null;
    }
  }

  /**
   * 美股 3 大指数 (道指/纳指/标普 500)
   * aktools: index_us_stock_sina  → 字段 (代码/名称/最新价/涨跌额/涨跌幅)
   */
  async function _fetchUsIndices() {
    const data = await Core.Data.fetch('intl_us_idx', 'index_us_stock_sina', {}, _INTL_TTL);
    if (!Array.isArray(data)) return null;
    const wanted = ['道琼斯', '纳斯达克', '标普500'];
    const out = {};
    for (const row of data) {
      const name = (row.名称 || row.name || '').trim();
      for (const w of wanted) {
        if (name.includes(w)) {
          out[w] = {
            name,
            price: parseFloat(row.最新价 ?? row.price),
            changePct: parseFloat(row.涨跌幅 ?? row.change_pct),
            date: row.日期 || row.date || ''
          };
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * 美元指数 / 人民币参考价 (中行外汇牌价)
   * aktools: macro_china_fx_gold → 字段 (货币名称/现汇买入价/现汇卖出价/中行折算价/发布时间)
   */
  async function _fetchUsdIndex() {
    const data = await Core.Data.fetch('intl_usd_cny', 'macro_china_fx_gold', {}, _INTL_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const row = data.find(r => {
      const n = (r.货币名称 || r['货币名称'] || r.name || '').toString();
      return n.includes('美元');
    }) || data[0];
    const out = {
      name: row['货币名称'] || row.货币名称 || '美元/人民币',
      buy: parseFloat(row['现汇买入价'] || row.现汇买入价),
      sell: parseFloat(row['现汇卖出价'] || row.现汇卖出价),
      mid: parseFloat(row['中行折算价'] || row.中行折算价),
      date: row['发布时间'] || row.发布时间 || ''
    };
    // Y3: 任一关键字段 NaN 时整段返回 null, 避免 NaN 进 prompt 污染 AI 输出
    if (isNaN(out.mid) || isNaN(out.buy) || isNaN(out.sell)) return null;
    return out;
  }

  /**
   * 离岸人民币 (USD/CNH 在岸价近似)
   */
  async function _fetchCnh() {
    const usd = await _fetchUsdIndex();
    if (!usd) return null;
    return {
      usd_cny_mid: usd.mid,
      date: usd.date,
      source: 'boc_inland_approx'
    };
  }

  /**
   * 原油主力合约 - aktools: energy_oil_hist → 列表
   * Y5: 默认 symbol='SC' (上海原油主连), aktools 实际不接受 WTI/Brent 等 CME 代码
   */
  async function _fetchCrudeOil() {
    const data = await Core.Data.fetch('intl_oil_sc', 'energy_oil_hist', { symbol: 'SC' }, _INTL_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const tail = data.slice(-30);
    const last = tail[tail.length - 1];
    const prev = tail.length >= 2 ? tail[tail.length - 2] : null;
    const lastClose = parseFloat((last && (last['收盘价'] || last.收盘价 || last.close)) || NaN);
    const prevClose = parseFloat((prev && (prev['收盘价'] || prev.收盘价 || prev.close)) || NaN);
    if (isNaN(lastClose)) return null;
    const changePct = isNaN(prevClose) ? null : ((lastClose - prevClose) / prevClose) * 100;
    return {
      name: '上海原油 (SC 主连)',
      last: lastClose,
      changePct,
      date: (last && (last['日期'] || last.日期 || last.date)) || '',
      history: tail.map(r => parseFloat(r['收盘价'] || r.收盘价 || r.close)).filter(v => !isNaN(v))
    };
  }

  /**
   * 整合 4 维国际形势, 1 次调用拿到整快照
   * 返回 { generated, us, usdIndex, cnh, oil } 都可能为 null (fail-safe)
   */
  async function getIntlSnapshot() {
    const cached = await Core.Storage.cacheGet(_INTL_CACHE);
    if (cached) return cached;
    const [us, usd, cnh, oil] = await Promise.all([
      _safeIntlFetch('usIndices', _fetchUsIndices),
      _safeIntlFetch('usdIndex', _fetchUsdIndex),
      _safeIntlFetch('cnh', _fetchCnh),
      _safeIntlFetch('crude', _fetchCrudeOil)
    ]);
    const snap = {
      generated: new Date().toISOString(),
      us,
      usdIndex: usd,
      cnh,
      oil
    };
    await Core.Storage.cacheSet(_INTL_CACHE, snap, _INTL_TTL);
    return snap;
  }

  /**
   * 格式化国际形势快照为 prompt 友好的中文
   */
  function formatIntlForPrompt(snap) {
    if (!snap) return '⚠ 国际形势数据不可用';
    const lines = [];
    lines.push('## 国际形势 (生成于 ' + snap.generated.slice(0, 16).replace('T', ' ') + ')');

    if (snap.us && typeof snap.us === 'object') {
      const items = Object.keys(snap.us).map(k => {
        const v = snap.us[k];
        const sign = v.changePct > 0 ? '+' : '';
        return `${k}: ${v.price} (${sign}${v.changePct.toFixed(2)}%)`;
      });
      lines.push(`- **美股**: ${items.join(' / ')}`);
    } else {
      lines.push('- **美股**: 数据拉取失败');
    }

    if (snap.usdIndex && typeof snap.usdIndex.mid === 'number') {
      lines.push(`- **美元/人民币 (中行参考)**: 中间价 ${snap.usdIndex.mid.toFixed(4)} (买 ${snap.usdIndex.buy.toFixed(4)} / 卖 ${snap.usdIndex.sell.toFixed(4)}, ${snap.usdIndex.date})`);
    }

    if (snap.cnh && typeof snap.cnh.usd_cny_mid === 'number') {
      lines.push(`- **人民币参考价**: ${snap.cnh.usd_cny_mid.toFixed(4)} (基于在岸价, 非离岸 CNH 实时)`);
    }

    if (snap.oil && typeof snap.oil.last === 'number') {
      const sign = snap.oil.changePct !== null ? (snap.oil.changePct > 0 ? '+' : '') : '-';
      const pct = snap.oil.changePct !== null ? `${sign}${snap.oil.changePct.toFixed(2)}%` : 'N/A';
      const hist = snap.oil.history || [];
      let range = '';
      if (hist.length >= 5) {
        const hi = Math.max(...hist);
        const lo = Math.min(...hist);
        range = `, 近 30 日区间 ${hi.toFixed(2)} - ${lo.toFixed(2)}`;
      }
      lines.push(`- **上海原油 (SC 主连)**: ${snap.oil.last.toFixed(2)} 元/桶 (${pct}${range})`);
    }

    return lines.join('\n');
  }

  // ===== Phase M (Tier 1): AI 上下文 6 维数据 =====
  // 1) 大盘 PE-TTM + 5 年分位 (估值温度计)
  // 2) 业绩预告 + 财报披露日历 (拐点信号)
  // 3) 北向资金 (外资风向)
  // 4) 货币供应量 M2/M1/M0 (流动性)
  // 5) 板块涨跌幅排名 (风格轮动)
  // 6) 整体快照 getAiContextSnapshot + formatAiContextForPrompt

  const _CTX_CACHE = 'ai_ctx_v1';
  const _CTX_TTL = 6 * 60 * 60 * 1000;  // 6h

  /**
   * 1) 大盘估值温度计 - 上证 / 深证 / 创业板 / 科创 50 PE-TTM + 5 年分位
   * aktools: stock_market_pe_lg  → 字段 (index_name, pe_ttm, pb, pe_percentile_5y)
   */
  async function _fetchMarketValuation() {
    const data = await Core.Data.fetch('ai_ctx_pe', 'stock_market_pe_lg', {}, _CTX_TTL);
    if (!Array.isArray(data)) return null;
    const wanted = ['上证', '深证', '创业板', '科创50'];
    const out = [];
    for (const row of data) {
      const name = (row.index_name || row.name || '').trim();
      if (!wanted.some(w => name.includes(w))) continue;
      const pe = parseFloat(row.pe_ttm || row.pe);
      const pb = parseFloat(row.pb);
      const pct = parseFloat(row.pe_percentile_5y || row.percentile);
      if (isNaN(pe)) continue;
      out.push({
        name,
        pe_ttm: pe,
        pb: isNaN(pb) ? null : pb,
        percentile_5y: isNaN(pct) ? null : pct
      });
    }
    return out.length > 0 ? out : null;
  }

  /**
   * 2) 业绩预告 + 财报披露日历 (Phase X.Y1: 带日期过滤, 防止陈旧数据)
   * aktools: stock_yjyg_em (业绩预告, date 参数 = 报告期截止日, 传最近一期)
   *         stock_report_disclosure (披露日历, 不带日期)
   *
   * 数据陈旧风险:
   *   - aktools 默认 date 是最近一期, 但若本地缓存了 1 周前的响应, AI 上下文里就出现过时预告
   *   - 防御: 缓存 key 加日期后缀 (每天自动失效), 客户端再过滤一次半年内的数据
   */
  async function _fetchEarningsCalendar() {
    let upcoming = [], surprise = [];
    try {
      const cal = await Core.Data.fetch('ai_ctx_disc', 'stock_report_disclosure', {}, _CTX_TTL);
      if (Array.isArray(cal)) {
        upcoming = cal.slice(0, 30).map(r => ({
          code: r['股票代码'] || r.code,
          name: r['股票简称'] || r.name,
          date: r['披露日期'] || r.date,
          type: r['报告类型'] || r.type || ''
        })).filter(x => x.code && x.date);
      }
    } catch (e) { console.warn('[Ctx] 财报披露日历失败:', e.message); }

    try {
      // Y1: 缓存 key 加日期, 强制每日失效 (避免 1 周前的陈旧预告喂给 AI)
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      const yjyg = await Core.Data.fetch(`ai_ctx_yjyg_${today}`, 'stock_yjyg_em', {}, _CTX_TTL);
      if (Array.isArray(yjyg)) {
        // Y1: 客户端再加一道半年内过滤 (aktools 可能返历史回填数据)
        const halfYearAgo = Date.now() - 180 * 24 * 60 * 60 * 1000;
        surprise = yjyg.slice(0, 50).filter(r => {
          const t = (r['业绩预告类型'] || r['预告类型'] || '').toString();
          if (!/增|减|扭亏|首亏|续亏|续盈/.test(t)) return false;
          // 提取公告日期 (多种字段名容错)
          const dStr = r['公告日期'] || r['最新公告日期'] || r['报告日期'] || r['发布日期'];
          if (dStr) {
            const ts = Date.parse(dStr);
            if (!isNaN(ts) && ts < halfYearAgo) return false;  // 半年外丢弃
          }
          return true;
        }).slice(0, 10).map(r => ({
          code: r['股票代码'] || r.code,
          name: r['股票简称'] || r.name,
          type: r['业绩预告类型'] || r['预告类型'],
          summary: r['业绩预告摘要'] || r.summary || '',
          reportDate: r['公告日期'] || r['最新公告日期'] || r['报告日期'] || r['发布日期'] || ''
        }));
      }
    } catch (e) { console.warn('[Ctx] 业绩预告失败:', e.message); }

    return (upcoming.length > 0 || surprise.length > 0)
      ? { upcoming, surprise }
      : null;
  }

  /**
   * 3) 北向资金 (今日 + 近 5 日)
   * aktools: stock_hsgt_north_net_flow_in_em → 字段 (date, value)
   */
  async function _fetchNorthFlow() {
    const data = await Core.Data.fetch('ai_ctx_north', 'stock_hsgt_north_net_flow_in_em', {}, _CTX_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const last = data[data.length - 1];
    const todayVal = parseFloat(last.value || last['当日成交净买额'] || last['value']);
    if (isNaN(todayVal)) return null;
    const tail = data.slice(-5).map(r => parseFloat(r.value || r['当日成交净买额'])).filter(v => !isNaN(v));
    return {
      today: todayVal,
      history_5d: tail,
      date: last.date || last['日期'] || ''
    };
  }

  /**
   * 4) 货币供应量 M2/M1/M0 同比
   * aktools: macro_china_money_supply
   */
  async function _fetchMoneySupply() {
    const data = await Core.Data.fetch('ai_ctx_m2', 'macro_china_money_supply', {}, _CTX_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const last = data[data.length - 1];
    const m2 = parseFloat(last['货币和准货币'] || last['M2'] || last.value);
    const m1 = parseFloat(last['货币'] || last['M1']);
    const m0 = parseFloat(last['流通中现金'] || last['M0']);
    if (isNaN(m2)) return null;
    return {
      date: last['月份'] || last.date || '',
      m2_yoy: m2,
      m1_yoy: isNaN(m1) ? null : m1,
      m0_yoy: isNaN(m0) ? null : m0
    };
  }

  /**
   * 5) 申万行业板块涨跌幅 Top 5 涨/跌
   * aktools: stock_board_industry_name_em → 字段 (板块名称, 涨跌幅)
   */
  async function _fetchSectorRotation() {
    const data = await Core.Data.fetch('ai_ctx_sector', 'stock_board_industry_name_em', {}, _CTX_TTL);
    if (!Array.isArray(data)) return null;
    const rows = data.map(r => ({
      name: r['板块名称'] || r.name,
      changePct: parseFloat(r['涨跌幅'] || r.change_pct)
    })).filter(r => r.name && !isNaN(r.changePct));
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => b.changePct - a.changePct);
    return {
      top5_gain: sorted.slice(0, 5).map(s => ({ name: s.name, changePct: s.changePct })),
      top5_loss: sorted.slice(-5).reverse().map(s => ({ name: s.name, changePct: s.changePct })),
      total: rows.length
    };
  }

  // ===== Phase M Tier 2: AI 上下文 4 维数据 =====
  // 6) 股指期货基差 (升水/贴水)
  // 7) 龙虎榜 Top 5 (游资动向)
  // 8) 两融余额 (杠杆情绪)
  // 9) 财经日历 (本地静态, 国常会/LPR/PMI/CPI 等)

  /**
   * 6) 股指期货基差 - IF/IC/IM/IH 主力合约 vs 现货指数
   * aktools: futures_main_sina → 字段 (symbol, name, current, bid, ask, ...)
   * 简化: 返回 4 大合约的"近月主力基差率"
   */
  async function _fetchFuturesBasis() {
    const data = await Core.Data.fetch('ai_ctx_futures', 'futures_main_sina', {}, _CTX_TTL);
    if (!Array.isArray(data)) return null;
    // 主力合约: IF (沪深300), IC (中证500), IM (中证1000), IH (上证50)
    const wanted = ['IF', 'IC', 'IM', 'IH'];
    const out = {};
    for (const row of data) {
      const sym = (row.symbol || row['symbol'] || '').toString();
      const prefix = sym.replace(/\d.*$/, '');  // IF2406 -> IF
      if (!wanted.includes(prefix)) continue;
      // 现货近似用昨收
      const last = parseFloat(row.current || row['当前价'] || row.current_price);
      if (isNaN(last)) continue;
      // 基差近似 = (现货 - 期货) / 现货, 但我们拿不到现货, 只返回合约价
      if (!out[prefix]) out[prefix] = { price: last, name: row.name || row['名称'] };
    }
    return Object.keys(out).length > 0 ? out : null;
  }

  /**
   * 7) 龙虎榜 - 今日 Top 5 净买入 / 净卖出个股 (游资动向)
   * aktools: stock_lhb_ggtj_em → 字段 (代码, 名称, 净额, ...)
   */
  async function _fetchLonghubang() {
    const data = await Core.Data.fetch('ai_ctx_lhb', 'stock_lhb_ggtj_em', {}, _CTX_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const rows = data.map(r => ({
      code: r['代码'] || r.code,
      name: r['名称'] || r.name,
      net: parseFloat(r['净额'] || r['龙虎榜净额'] || r.net_amount),
      reason: r['上榜原因'] || r.reason || ''
    })).filter(r => r.code && !isNaN(r.net));
    if (rows.length === 0) return null;
    const sorted = [...rows].sort((a, b) => b.net - a.net);
    return {
      top5_buy: sorted.slice(0, 5).map(r => ({ code: r.code, name: r.name, net: r.net, reason: r.reason })),
      top5_sell: sorted.slice(-5).reverse().map(r => ({ code: r.code, name: r.name, net: r.net, reason: r.reason }))
    };
  }

  /**
   * 8) 两融余额 (沪 + 深)
   * aktools: stock_margin_sse + stock_margin_szse
   */
  async function _fetchMargin() {
    let total = 0, date = '', count = 0;
    try {
      const sse = await Core.Data.fetch('ai_ctx_margin_sse', 'stock_margin_sse', {}, _CTX_TTL);
      if (Array.isArray(sse) && sse.length > 0) {
        const last = sse[sse.length - 1];
        const bal = parseFloat(last['融资余额'] || last['融资余额(元)'] || last.rzye);
        if (!isNaN(bal)) { total += bal; count++; date = last['日期'] || last.date; }
      }
    } catch (e) { console.warn('[Ctx] 沪市两融失败:', e.message); }
    try {
      const szse = await Core.Data.fetch('ai_ctx_margin_szse', 'stock_margin_szse', {}, _CTX_TTL);
      if (Array.isArray(szse) && szse.length > 0) {
        const last = szse[szse.length - 1];
        const bal = parseFloat(last['融资余额'] || last['融资余额(元)'] || last.rzye);
        if (!isNaN(bal)) { total += bal; count++; date = date || last['日期'] || last.date; }
      }
    } catch (e) { console.warn('[Ctx] 深市两融失败:', e.message); }
    // Y2: 日期容错 — aktools 字段名若是 'trade_date'/'统计日期'/'数据日期' 等都接不住时, 用今天兜底
    if (!date) date = new Date().toISOString().slice(0, 10);
    return count > 0 ? { total_yi: total / 1e8, date } : null;  // 元 → 亿
  }

  /**
   * 财经日历 (本地静态规则) - 基于公开统计规律, 不预测实际事件
   * Y6: 删除"周二/周五国常会"硬编码 (国常会无公开日程, 编造会误导 AI)
   * 保留有公开日期规则的:
   *   - LPR 报价: 每月 20 号 (央行公开)
   *   - MLF 续作/到期: 每月 15 号左右 (央行公开)
   *   - PMI: 每月最后一天 (统计局公开)
   *   - CPI/PPI: 每月 10-12 号 (统计局公开)
   *   - 季报披露密集期: 1/4/7/10 月下旬 (交易所规则)
   */
  function _fetchEconomicCalendar() {
    const now = new Date();
    const events = [];
    for (let i = 0; i < 14; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i);
      const day = d.getDate();
      const month = d.getMonth() + 1;
      const md = month + '-' + day;

      // LPR 报价: 每月 20 号
      if (day === 20) events.push(`${md} LPR 报价 (1Y/5Y)`);
      // MLF 中期借贷便利: 每月 15 号
      if (day === 15) events.push(`${md} MLF 续作/到期`);
      // PMI: 每月最后一天
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
      if (day === lastDay) events.push(`${md} 官方 PMI 公布`);
      // CPI / PPI: 每月 10-12 号
      if (day >= 10 && day <= 12) events.push(`${md} CPI / PPI 同比 (估计)`);
      // 季报披露密集期 (1/4/7/10 月下旬)
      if ([1, 4, 7, 10].includes(month) && day >= 20 && day <= 30) {
        events.push(`${md} 季报披露密集期 (年报/一季报/中报/三季报)`);
      }
    }
    // 去重 + 取前 8
    return events.length > 0 ? { next_14d: [...new Set(events)].slice(0, 8) } : null;
  }

  /**
   * 聚合: 1 次调用拿到 AI 上下文快照 (Tier 1 + Tier 2)
   */
  async function getAiContextSnapshot() {
    const cached = await Core.Storage.cacheGet(_CTX_CACHE);
    if (cached) return cached;
    const [valuation, earnings, north, money, sectors, futures, lhb, margin] = await Promise.all([
      _safeIntlFetch('valuation', _fetchMarketValuation),
      _safeIntlFetch('earnings', _fetchEarningsCalendar),
      _safeIntlFetch('north', _fetchNorthFlow),
      _safeIntlFetch('money', _fetchMoneySupply),
      _safeIntlFetch('sectors', _fetchSectorRotation),
      _safeIntlFetch('futures', _fetchFuturesBasis),
      _safeIntlFetch('lhb', _fetchLonghubang),
      _safeIntlFetch('margin', _fetchMargin)
    ]);
    // 财经日历是本地静态, 不走 fetch 但仍可能为 null
    const calendar = _fetchEconomicCalendar();
    const snap = {
      generated: new Date().toISOString(),
      valuation, earnings, north, money, sectors,
      futures, lhb, margin, calendar
    };
    await Core.Storage.cacheSet(_CTX_CACHE, snap, _CTX_TTL);
    return snap;
  }

  /**
   * 格式化为 prompt 友好的中文 (拼接到 weekly report 等 AI 上下文)
   */
  function formatAiContextForPrompt(snap) {
    if (!snap) return '⚠ 市场上下文数据不可用';
    const lines = [];
    lines.push('## 市场上下文 (生成于 ' + snap.generated.slice(0, 16).replace('T', ' ') + ')');

    if (Array.isArray(snap.valuation) && snap.valuation.length > 0) {
      const items = snap.valuation.map(v => {
        const pct = v.percentile_5y !== null ? `, 5 年分位 ${v.percentile_5y.toFixed(0)}%` : '';
        const pb = v.pb !== null ? `, PB ${v.pb.toFixed(2)}` : '';
        return `${v.name} PE-TTM ${v.pe_ttm.toFixed(1)}${pct}${pb}`;
      });
      lines.push(`- **大盘估值**: ${items.join(' / ')}`);
    } else {
      lines.push('- **大盘估值**: 数据拉取失败');
    }

    if (snap.earnings) {
      const up = (snap.earnings.upcoming || []).slice(0, 3)
        .map(e => `${e.name}(${(e.date || '').slice(0, 10)})`).join('、');
      // Y1: 业绩预告拐点带 reportDate 前缀 (YYYY-MM-DD), AI 知道是哪一期
      const sg = (snap.earnings.surprise || []).slice(0, 3)
        .map(e => `${e.name}${e.reportDate ? ' [' + e.reportDate.slice(0, 10) + ']' : ''} ${e.type}`).join('、');
      if (up) lines.push(`- **近期财报披露**: ${up}`);
      if (sg) lines.push(`- **业绩预告拐点**: ${sg}`);
    }

    if (snap.north && typeof snap.north.today === 'number') {
      const sign = snap.north.today > 0 ? '+' : '';
      lines.push(`- **北向资金**: 今日净买入 ${sign}${snap.north.today.toFixed(2)} 亿`);
    } else {
      lines.push('- **北向资金**: 数据拉取失败');
    }

    if (snap.money && !isNaN(snap.money.m2_yoy)) {
      const m1 = snap.money.m1_yoy !== null ? snap.money.m1_yoy.toFixed(2) : 'N/A';
      lines.push(`- **货币供应量**: M2 同比 ${snap.money.m2_yoy.toFixed(2)}%, M1 同比 ${m1}%`);
    } else {
      lines.push('- **货币供应量**: 数据拉取失败');
    }

    if (snap.sectors && Array.isArray(snap.sectors.top5_gain)) {
      const fmt = arr => arr.map(s =>
        `${s.name}(${s.changePct > 0 ? '+' : ''}${s.changePct.toFixed(2)}%)`
      ).join('、');
      lines.push(`- **板块涨跌 (申万)**: 领涨 ${fmt(snap.sectors.top5_gain)}; 领跌 ${fmt(snap.sectors.top5_loss)}`);
    }

    if (snap.futures && typeof snap.futures === 'object') {
      const items = Object.keys(snap.futures).map(k => {
        const v = snap.futures[k];
        return `${k} ${v.price.toFixed(2)}`;
      });
      lines.push(`- **股指期货主力**: ${items.join(' / ')} (基差需对照现货指数)`);
    }

    if (snap.lhb && Array.isArray(snap.lhb.top5_buy) && snap.lhb.top5_buy.length > 0) {
      const fmt = arr => arr.map(r =>
        `${r.name}(净额${r.net > 0 ? '+' : ''}${(r.net / 1e8).toFixed(2)}亿${r.reason ? '·' + r.reason.slice(0, 8) : ''})`
      ).join('、');
      lines.push(`- **龙虎榜**: 净买 ${fmt(snap.lhb.top5_buy)}; 净卖 ${fmt(snap.lhb.top5_sell)}`);
    }

    if (snap.margin && typeof snap.margin.total_yi === 'number') {
      lines.push(`- **两融余额**: ${snap.margin.total_yi.toFixed(0)} 亿 (${snap.margin.date})`);
    }

    if (snap.calendar && Array.isArray(snap.calendar.next_14d) && snap.calendar.next_14d.length > 0) {
      lines.push(`- **财经日历 (14 天内)**: ${snap.calendar.next_14d.join(' / ')}`);
    }

    return lines.join('\n');
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
    _sinaFetch, _sinaParse,  // Z13: 新浪 fetcher + 解析 (腾讯失败兜底, 测试用)
    _tencentKLine,          // Y12: 腾讯 K 线 fetcher (内部)
    getStockSpotEfinance,  // C: 东方财富 fetcher (全市场, screener 用)
    getStockFinancialHistory,  // Phase R: 近 N 期财报对比
    getFinancialCalendar, getStockNextDisclosure,  // Phase U: 财报披露日历
    // 排雷 (Phase Y.1)
    getStockGoodwillRanks, getStockHolderDecreases,  // 商誉 / 减持
    getStockEarningsForecastFresh, getStockCapitalFlight,  // 业绩亏损 / 主力出逃
    // 基金
    getFundSpot, getFundHistory, getFundPortfolio,
    // 指数
    getIndexSpot, getIndexSpotTencent,
    // 黄金 (Phase J)
    getGoldAu9999,
    formatGoldForPrompt,
    // 国际形势 (Phase L)
    getIntlSnapshot,
    formatIntlForPrompt,
    // AI 上下文快照 (Phase M Tier 1: 估值/财报/北向/M2/板块)
    getAiContextSnapshot,
    formatAiContextForPrompt
  };
})();
