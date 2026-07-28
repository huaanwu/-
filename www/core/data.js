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
    // 注意: 2026-07-28 实测 fqkline 端点对 start/end 非空参数返 code=0 param error
    // 必须 start/end 留空 (拿最近 count 根, 默认 240 ≈ 1 年日 K)
    const params = [`${symbol}`, `${p}`, '', '', `${count}`, `${adjust || ''}`];
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
    // 2026-07-28 实测: 腾讯 fqkline 端点实际只返 6 列 [日期, 开盘, 收盘, 最高, 最低, 成交量]
    // 7-11 列 (成交额/振幅/涨跌幅/涨跌额/换手率) 已被该端点移除, 客户端算
    return rows.map(row => {
      const open = _num(row[1]);
      const close = _num(row[2]);
      const pct = open > 0 ? ((close - open) / open * 100) : null;
      return {
        日期: row[0],
        开盘: open,
        收盘: close,
        最高: _num(row[3]),
        最低: _num(row[4]),
        成交量: _num(row[5]) * 100,           // 手 → 股
        成交额: null,                          // 端点不再返
        振幅: null,
        涨跌幅: pct != null ? +pct.toFixed(2) : null,
        涨跌额: open > 0 ? +(close - open).toFixed(2) : null,
        换手率: null
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
  // 端点 1 (主): push2.eastmoney.com (实时) — WebView 里 ERR_EMPTY_RESPONSE (Node/Chromium push2 ban)
  // 端点 2 (兜底): push2delay.eastmoney.com (延迟 15min) — 限 100/页, 分页拉
  // 端点 3 (兜底): aktools /stock_zh_a_spot_em (历史端点) — 但需要 dev-proxy
  // URL: ?pn=1&pz=100&po=1&fs=m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23
  //   fields=f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f20,f23
  // 字段(注意: f3/f8/f10/f20 是基点 0.01% 精度, f9 是市盈率 * 100):
  //   f12=代码 f14=名称 f2=最新价
  //   f3=涨跌幅(基点) f4=涨跌额 f5=成交量(手) f6=成交额(元)
  //   f8=换手率(基点) f9=市盈率(动, *100) f10=量比(基点)
  //   f20=流通市值(元) f23=市净率(*100)
  const EM_URLS = [
    'https://push2.eastmoney.com/api/qt/clist/get',         // 实时, 大多 fail
    'https://push2delay.eastmoney.com/api/qt/clist/get'    // 延迟 15min, 限制 100/页但稳
  ];
  const EM_FS = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';  // 沪主+科创+深主+创业
  const EM_FIELDS = 'f12,f14,f2,f3,f4,f5,f6,f8,f9,f10,f20,f23';
  const EM_PAGE_SIZE = 100;  // push2delay 限 100/页, push2 5000
  const EM_MAX_PAGES = 5;     // 最多 5 页 = 500 只 (避免被 ban)

  async function _efinanceFetch() {
    // 限流检查 (跟 _fetch 一致: 限流期内不发起请求)
    const s = getLimitStatus('efinance_full');
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${s.lastError.slice(0, 100)})`);
    }
    // 逐端点尝试: push2 (实时) → push2delay (延迟 15min, 限 100/页但稳)
    let lastErr = null;
    for (const baseUrl of EM_URLS) {
      try {
        const out = await _efinanceFetchOne(baseUrl, EM_MAX_PAGES);
        if (!_limitByPath['efinance_full']) _limitByPath['efinance_full'] = { blocked: false, until: 0, lastError: '', lastSuccess: 0 };
        _limitByPath['efinance_full'].lastSuccess = Date.now();
        return out;
      } catch (e) {
        console.warn(`[Data] 东财 ${baseUrl} 失败:`, e.message);
        lastErr = e;
        // 继续试下一个端点
      }
    }
    throw lastErr || new Error('所有东财端点都失败');
  }

  /**
   * 单端点拉取, 支持分页
   * @param {string} baseUrl - push2 或 push2delay
   * @param {number} maxPages - 最多拉几页
   */
  async function _efinanceFetchOne(baseUrl, maxPages = 1) {
    const isDelay = baseUrl.includes('push2delay');
    const pageSize = isDelay ? Math.min(EM_PAGE_SIZE, 100) : 5000;
    // 延迟端点限 100/页, 必须分页; 实时端点 pz=5000 一次就行
    const pages = isDelay ? Math.min(maxPages, 5) : 1;
    const all = [];
    for (let pn = 1; pn <= pages; pn++) {
      const url = `${baseUrl}?pn=${pn}&pz=${pageSize}&po=1&fs=${EM_FS}&fields=${EM_FIELDS}`;
      let resp;
      try {
        resp = await fetch(url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Referer': 'https://quote.eastmoney.com/'
          }
        });
      } catch (e) {
        if (pn === 1) throw new Error(`东财网络错误: ${e.message}`);
        // 后续页失败就 break, 已拉的够用
        console.warn(`[Data] 东财分页 ${pn} 失败:`, e.message);
        break;
      }
      if (!resp.ok) {
        if (resp.status === 429) _setLimit('efinance_full', 60 * 1000, `HTTP ${resp.status}`);
        if (pn === 1) throw new Error(`东财 HTTP ${resp.status}`);
        break;
      }
      let j;
      try { j = await resp.json(); } catch (e) {
        if (pn === 1) throw new Error('东财返非 JSON: ' + e.message);
        break;
      }
      if (!j.data || !j.data.diff || Object.keys(j.data.diff).length === 0) {
        if (pn === 1) throw new Error(`东财返空 (rc=${j.rc}, rt=${j.rt})`);
        // 后续页空就 break
        break;
      }
      // 字段映射成 aktools 风格
      for (const k of Object.keys(j.data.diff)) {
        const r = j.data.diff[k];
        all.push({
          '代码': r.f12 || '',
          '名称': r.f14 || '',
          '最新价': _num(r.f2) / 100,
          '涨跌幅': _num(r.f3) / 100,
          '涨跌额': _num(r.f4) / 100,
          '成交量': _num(r.f5),
          '成交额': _num(r.f6),
          '换手率': _num(r.f8) / 100,
          '市盈率': _num(r.f9) / 100,
          '量比': _num(r.f10) / 100,
          '流通市值': _num(r.f20),
          '市净率': _num(r.f23) / 100
        });
      }
      if (isDelay && pn < pages) {
        // 分页间隔 200ms, 避免被 ban
        await new Promise(r => setTimeout(r, 200));
      }
    }
    if (all.length === 0) throw new Error('东财解析后为空');
    return all;
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

  // c (aktools 限流修复): 按端点独立限流状态
  // 触发: HTTP 429 / 文本含限流关键字 (500 单独重试, 不当限流, 因为 aktools 端点本身偶发 500)
  // 期间内该端点 fetch 直接抛 "数据源限流, Ns 后可重试", 避免雪崩
  // key 形如 "stock_zh_a_hist" / "stock_zh_a_spot" / "_tencentKLine:000001"
  const _limitByPath = {};

  function _setLimit(path, durationMs, err) {
    if (!_limitByPath[path]) _limitByPath[path] = { blocked: false, until: 0, lastError: '', lastSuccess: 0 };
    _limitByPath[path].blocked = true;
    _limitByPath[path].until = Date.now() + durationMs;
    _limitByPath[path].lastError = err;
    console.warn(`[Data] ${path} 限流 ${Math.round(durationMs/1000)}s:`, err);
  }
  function _clearLimit(path) {
    const s = _limitByPath[path];
    if (s && s.blocked) {
      console.log(`[Data] ${path} 恢复, 距上次成功`, Date.now() - (s.lastSuccess || Date.now()), 'ms');
    }
    if (s) { s.blocked = false; s.until = 0; }
  }
  function _clearAllLimit() {
    for (const k of Object.keys(_limitByPath)) {
      const s = _limitByPath[k];
      if (s && s.blocked) {
        console.log(`[Data] ${k} 恢复, 距上次成功`, Date.now() - (s.lastSuccess || Date.now()), 'ms');
      }
      if (s) { s.blocked = false; s.until = 0; }
    }
  }
  /**
   * UI 读这个判断某 path: { blocked, until, lastError, lastSuccess, retryIn }
   * retryIn = blocked ? max(0, until - now) : 0
   * 不传 path 返全量限流快照 (兼容老 API)
   */
  function getLimitStatus(path) {
    const now = Date.now();
    if (path) {
      const s = _limitByPath[path];
      if (!s) return { blocked: false, retryIn: 0, until: 0, lastError: '', lastSuccess: 0 };
      return {
        blocked: s.blocked && now < s.until,
        until: s.until,
        lastError: s.lastError,
        lastSuccess: s.lastSuccess,
        retryIn: s.blocked ? Math.max(0, s.until - now) : 0
      };
    }
    // 不传 path: 返全量, 取最坏的一个
    let worst = null;
    for (const k of Object.keys(_limitByPath)) {
      const s = _limitByPath[k];
      if (s && s.blocked && now < s.until) {
        if (!worst || s.until > worst.until) worst = { ...s, path: k };
      }
    }
    if (worst) return { blocked: true, until: worst.until, lastError: worst.lastError, lastSuccess: worst.lastSuccess, retryIn: Math.max(0, worst.until - now), path: worst.path };
    return { blocked: false, retryIn: 0, until: 0, lastError: '', lastSuccess: 0 };
  }

  /**
   * 统一拼 API URL — 浏览器 dev 环境返相对路径, APK 环境基于 proxyBase 拼绝对路径
   *
   * 背景: APK 里 webview 启动 URL 是 http://localhost (手机自己),
   * 任何相对路径 '/api/xxx' 都会打到手机自己, 不通.
   * 必须基于 proxyBase (用户设置 http://192.168.x.x:8089/api/akshare)
   * 抽 origin 部分 + 目标 path 拼绝对 URL.
   *
   * @param {string} path - 形如 '/api/eastmoney/...' / '/api/llm/...' / '/api/local/...'
   * @returns {string} - 浏览器 dev: path 原样返回; APK: 'http://192.168.x.x:8089' + path
   */
  function apiUrl(path) {
    if (!path || typeof path !== 'string') return path;
    // 绝对 URL 直接返
    if (/^https?:\/\//i.test(path)) return path;
    const base = (window.Core && Core.State && Core.State.get('proxyBase')) || DEFAULT_PROXY;
    // proxyBase 是相对路径 (浏览器 dev) → 直接返原 path (走 vite proxy)
    if (!/^https?:\/\//i.test(base)) return path;
    // proxyBase 是绝对 URL (APK) → 抽 origin 拼 path
    try {
      const u = new URL(base);
      return `${u.origin}${path.startsWith('/') ? path : '/' + path}`;
    } catch (e) {
      console.warn('[Data] proxyBase 解析失败, 退到相对路径:', e.message);
      return path;
    }
  }

  // 通用 fetch + JSON + 错误处理 + retry
  // 不在顶部检查限流 (留给 fetchWithCache 决定: 缓存命中不限流, 没缓存才限流)
  // 限流按 path 独立: 同一时间 stock_zh_a_hist 限流不影响 stock_zh_a_spot
  async function _fetch(path, params = {}, opts = {}) {
    const { retries = 2, baseDelay = 1500 } = opts;  // 第一次失败等 1.5s, 第二次 3s
    const base = (window.Core && Core.State && Core.State.get('proxyBase')) || DEFAULT_PROXY;
    const qs = new URLSearchParams(params).toString();
    // base 已是绝对 URL (APK) 直接用; 是相对路径 (浏览器 dev) 也直接用, 走 vite proxy
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
        _clearLimit(path);
        if (!_limitByPath[path]) _limitByPath[path] = { blocked: false, until: 0, lastError: '', lastSuccess: 0 };
        _limitByPath[path].lastSuccess = Date.now();
        return await resp.json();
      }

      const text = await resp.text();
      // 限流信号: 仅 429 / 文本含限流关键字 (裸 5xx 不当限流, aktools 端点本身会偶发 500)
      const isLimit = resp.status === 429
        || /limit|rate|频|限|too many|频繁/i.test(text.slice(0, 500));
      if (isLimit) {
        // 限流: 60s 退避, 不重试
        const dur = 60 * 1000;
        _setLimit(path, dur, `HTTP ${resp.status}: ${text.slice(0, 100)}`);
        throw new Error(`${path} 数据源限流 (HTTP ${resp.status}), 60s 后可重试`);
      }

      // 5xx / 其他错误: 重试
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

    // 2) 没缓存: 限流期直接抛 (避免雪崩) — 限流按 path 独立
    const s = getLimitStatus(path);
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${s.lastError.slice(0, 100)})`);
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
    // 不传 codes: 优先 aktools stock_zh_a_spot (5532 条全市场, 浏览器可直连 dev-proxy)
    // efinance 直连 push2.eastmoney.com 当前对裸请求 ECONNRESET, 仅作为 fallback
    try {
      return await fetchWithCache(
        'stock_spot_all',
        'stock_zh_a_spot',
        {},
        60 * 1000
      );
    } catch (e1) {
      console.warn('[Data] aktools 全市场失败, 降级 efinance:', e1.message);
    }
    try {
      return await getStockSpotEfinanceCached();
    } catch (e2) {
      console.warn('[Data] efinance 也失败, 返回空:', e2.message);
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

    // 2) 限流期直接抛 (按 path 独立: stock_zh_a_hist 限流不影响别的)
    const s = getLimitStatus('stock_zh_a_hist');
    if (s.blocked) {
      throw new Error(`数据源限流, ${Math.ceil(s.retryIn/1000)}s 后可重试 (上次: ${s.lastError.slice(0, 100)})`);
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
   * 指数 K 线 (H3: 多指数 regime 状态机, 取 HS300 / CSI1000 / CSI2000 周线)
   * 数据源: 优先腾讯 (复用 _tencentKLine, 符号 sh000300 / sz399303 等), 失败降级 aktools stock_zh_index_daily
   * 缓存: 24h (指数 K 线每日更新 ~16:00, 24h TTL 安全)
   * @param {string} code - 必须带 sh/sz 前缀 (e.g. sh000300 / sh000852 / sz399303)
   * @param {string} [period='daily'] - daily/weekly/monthly
   * @param {string} [start] - YYYYMMDD (可省)
   * @param {string} [end] - YYYYMMDD (可省)
   * @param {string} [adjust='qfq'] - 指数通常无复权, 传空串或忽略
   * @returns {Promise<Array>} 数组元素: {日期, 开盘, 收盘, 最高, 最低, 成交量, 涨跌幅, ...}
   */
  async function getIndexKLine(code, period = 'daily', start, end, adjust = 'qfq') {
    const cacheKey = `idx_kline_${code}_${period}_${start || ''}_${end || ''}_${adjust}`;
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    // 1) 优先腾讯 (复用 _tencentKLine; 指数符号 sh/sz + 6 位数字匹配 _tencentSymbol)
    try {
      const data = await _tencentKLine(code, period, start, end, 240, adjust);
      await Core.Storage.cacheSet(cacheKey, data, 24 * 60 * 60 * 1000);
      return data;
    } catch (e) {
      console.warn('[Data] 腾讯指数 K 线失败, 降级 aktools:', e.message);
    }
    // 2) 降级 aktools
    return await fetchWithCache(
      cacheKey,
      'stock_zh_index_daily',
      { symbol: code, period, start_date: start, end_date: end },
      24 * 60 * 60 * 1000
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
   * 批量财务摘要 (Phase 5 long-trader)
   * 并发 5 逐批拉, 返回 Map<code, rawData>
   * Bug #8 修复: 加 7 天 in-memory 缓存, 跨 runNow / reviewHoldings 调用复用
   * (财报季度才更新, 同 code 短期重复请求走 cache)
   */
  const _finBatchCache = new Map();   // code -> { value, ts }
  const _FIN_BATCH_TTL = 7 * 24 * 60 * 60 * 1000;
  async function getStockFinancialBatch(codes) {
    const results = new Map();
    const toFetch = [];
    for (const c of codes) {
      const hit = _finBatchCache.get(c);
      if (hit && Date.now() - hit.ts < _FIN_BATCH_TTL) {
        results.set(c, hit.value);
      } else {
        toFetch.push(c);
      }
    }
    if (toFetch.length === 0) return results;
    const chunked = [];
    for (let i = 0; i < toFetch.length; i += 5) chunked.push(toFetch.slice(i, i + 5));
    for (const chunk of chunked) {
      const batch = await Promise.allSettled(
        chunk.map(c => getStockFinancial(c).catch(() => null))
      );
      chunk.forEach((c, i) => {
        if (batch[i]?.status === 'fulfilled' && batch[i].value) {
          results.set(c, batch[i].value);
          _finBatchCache.set(c, { value: batch[i].value, ts: Date.now() });
        }
      });
    }
    return results;
  }

  /**
   * 业绩预告 (V2 P2: long-trader earnings forecast factor)
   * 数据源: stock_yjyg_em (东方财富, 季度预告)
   *   - date 必填 YYYYMMDD, 必须季度末 (0331/0630/0930/1231), 季度内不变 → TTL 7d
   *   - 不支持 stock_code 单股, 必须按季度整期拉一次, 客户端按"股票代码"过滤
   *   - 字段: 股票代码 / 股票简称 / 预测指标 / 业绩变动幅度 / 预告类型
   *   - ⚠️ "业绩变动幅度" 仅 "归属于上市公司股东的净利润" 或 "扣非净利润" 行有值, 其他行可能 null
   *     → 前端 filter 预测指标∈{归属上市公司股东净利润, 扣非净利润} 再读幅度
   */
  async function getStockEarningForecast(quarter) {
    if (!/^\d{8}$/.test(quarter)) throw new Error('quarter 必须是 YYYYMMDD 格式');
    return await fetchWithCache(
      `yjyg_${quarter}`,
      'stock_yjyg_em',
      { date: quarter },
      7 * 24 * 60 * 60 * 1000  // 7 天 (季度内不变)
    );
  }

  /**
   * 批量: 给定 code 列表 + 当前季度 → Map<code, { 业绩变动幅度, 预告类型, 预测指标 }>
   * @param {string[]} codes - 股票代码数组
   * @param {string} [quarter] - YYYYMMDD, 缺省用最近一个季度末日
   * @returns {Promise<Map<string, {pct:number, type:string, indicator:string}>>}
   */
  async function getStockEarningForecastBatch(codes, quarter) {
    const results = new Map();
    const q = quarter || _latestQuarterEnd();
    let raw;
    try {
      raw = await getStockEarningForecast(q);
    } catch (e) { console.warn('[Data] yjyg 拉取失败:', e.message); return results; }
    if (!Array.isArray(raw) || raw.length === 0) return results;

    const codeSet = new Set(codes);
    // 只保留 "归属于上市公司股东的净利润" / "扣非净利润" 行 (peer 实测: 其他指标幅度可能 null)
    const PROFIT_INDICATORS = ['归属于上市公司股东的净利润', '扣除非经常性损益后的净利润'];
    for (const row of raw) {
      const c = row['股票代码'] || row.股票代码;
      if (!c || !codeSet.has(c)) continue;
      const indicator = row['预测指标'] || row.预测指标;
      if (!PROFIT_INDICATORS.includes(indicator)) continue;
      const pct = row['业绩变动幅度'] != null ? parseFloat(row['业绩变动幅度']) : null;
      const type = row['预告类型'] || row.预告类型 || '';
      // 取同一 code 多个指标中幅度最大的 (扣非更直接, 但归母覆盖更广, 用 max)
      const prev = results.get(c);
      if (!prev || (pct != null && (prev.pct == null || pct > prev.pct))) {
        results.set(c, { pct, type, indicator });
      }
    }
    return results;
  }

  function _latestQuarterEnd() {
    const d = new Date();
    const m = d.getMonth() + 1;  // 1-12
    const y = d.getFullYear();
    if (m >= 1 && m <= 4) return `${y}0331`;
    if (m >= 5 && m <= 8) return `${y}0630`;
    if (m >= 9 && m <= 10) return `${y}0930`;
    return `${y}1231`;
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
   * 按 code 反查所属行业 (申万一级)
   * 数据源 stock_board_industry_cons_em 全市场一次, 24h 缓存命中, 后续调用 0 成本
   * @param {string} code 6 位代码
   * @returns {Promise<string|null>} 行业名称, 未匹配/失败返 null
   */
  async function getStockIndustryByCode(code) {
    const c = String(code || '').padStart(6, '0');
    if (!/^\d{6}$/.test(c)) return null;
    const cacheKey = 'industry_by_code_v1';
    try {
      let idx = await Core.Storage.cacheGet(cacheKey);
      if (!idx || typeof idx !== 'object') {
        const rows = await fetchWithCache(
          cacheKey,
          'stock_board_industry_cons_em',
          { symbol: '申万一级' },
          24 * 60 * 60 * 1000
        ).catch(() => null);
        if (!Array.isArray(rows)) return null;
        idx = {};
        for (const r of rows) {
          const ind = r['板块名称'] || r.name || '';
          const members = r['成分股代码'] || r['成分股'] || r.members;
          const mArr = Array.isArray(members) ? members
            : (typeof members === 'string' ? members.split(',') : []);
          for (const m of mArr) {
            const cc = String(m).padStart(6, '0');
            if (!idx[cc]) idx[cc] = ind;
          }
        }
        await Core.Storage.cacheSet(cacheKey, idx, 24 * 60 * 60 * 1000);
      }
      return idx[c] || null;
    } catch (e) {
      console.warn('[Data] getStockIndustryByCode 失败:', e.message);
      return null;
    }
  }

  /**
   * 批量行业归属查询 (Phase 5 long-trader)
   * 并发 5 逐批拉, 返回 Map<code, industryName>
   * Bug #8 修复: 行业归属基本不变, 24h 内存缓存
   */
  const _indBatchCache = new Map();
  const _IND_BATCH_TTL = 24 * 60 * 60 * 1000;
  async function getStockIndustryBatch(codes) {
    const results = new Map();
    const toFetch = [];
    for (const c of codes) {
      const hit = _indBatchCache.get(c);
      if (hit && Date.now() - hit.ts < _IND_BATCH_TTL) {
        results.set(c, hit.value);
      } else {
        toFetch.push(c);
      }
    }
    if (toFetch.length === 0) return results;
    const chunked = [];
    for (let i = 0; i < toFetch.length; i += 5) chunked.push(toFetch.slice(i, i + 5));
    for (const chunk of chunked) {
      const batch = await Promise.allSettled(
        chunk.map(c => getStockIndustryByCode(c).catch(() => null))
      );
      chunk.forEach((c, i) => {
        if (batch[i]?.status === 'fulfilled' && batch[i].value) {
          results.set(c, batch[i].value);
          _indBatchCache.set(c, { value: batch[i].value, ts: Date.now() });
        }
      });
    }
    return results;
  }

  /**
   * 板块实时涨幅 (Tier 6 hot theme 因子)
   * 数据源 stock_board_industry_index_em (东方财富, 申万一级实时)
   * 缓存 15min — 板块涨幅日内变化频繁但不需要 tick 级
   * 输出标准化: [{ name, code, pctChange, leaderStock, leaderPct }]
   */
  async function getSectorPerformance() {
    const raw = await fetchWithCache(
      'sector_perf_v1',
      'stock_board_industry_index_em',
      {},
      15 * 60 * 1000
    );
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({
      name: r['板块名称'] || r.name || '',
      code: r['板块代码'] || r.code || '',
      pctChange: parseFloat(r['涨跌幅'] || r.pctChange || 0),
      leaderStock: r['领涨股票'] || '',
      leaderPct: parseFloat(r['领涨股票-涨跌幅'] || 0),
      upCount: parseInt(r['上涨家数'] || 0, 10),
      downCount: parseInt(r['下跌家数'] || 0, 10)
    })).filter(s => s.name);
  }

  /**
   * 概念板块实时涨幅 (Tier 6+ 概念热点因子, 与行业板块并行)
   * 数据源 stock_board_concept_index_em (东方财富, 概念板块实时, 数量远大于行业)
   * 缓存 1h — 概念板块数量大, 日内变化频繁但热点切换有惯性
   * 输出标准化: [{ name, code, pctChange, leaderStock, leaderPct, upCount, downCount }]
   */
  async function getConceptBoardPerformance() {
    const raw = await fetchWithCache(
      'concept_perf_v1',
      'stock_board_concept_index_em',
      {},
      60 * 60 * 1000
    );
    if (!Array.isArray(raw)) return [];
    return raw.map(r => ({
      name: r['板块名称'] || r.name || '',
      code: r['板块代码'] || r.code || '',
      pctChange: parseFloat(r['涨跌幅'] || r.pctChange || 0),
      leaderStock: r['领涨股票'] || '',
      leaderPct: parseFloat(r['领涨股票-涨跌幅'] || 0),
      upCount: parseInt(r['上涨家数'] || 0, 10),
      downCount: parseInt(r['下跌家数'] || 0, 10)
    })).filter(s => s.name);
  }

  /**
   * 反查 code → 该股所属的所有概念板块名 (用于 scoring 概念热点补强)
   * 数据源 stock_board_concept_cons_em (东方财富, 单概念成分股; 必须带 symbol 参数 = 概念名)
   * 实际用法: 不能反向传 code 查列表 (aktools 无此端点); 改成"全市场一次, 建反向索引"
   * aktools 有 stock_board_concept_cons_ths / stock_board_concept_cons_em 但都需要 symbol=概念名
   * 改用东财 Web 端 dump 不现实 — 退到实用方案: 不做精确反查, 用 getConceptBoardPerformance 的 leaderStock 字段
   * 提一个粗粒度近似: 返回该股是否曾在某概念板块的 leaderStock 名单里出现 (15min 缓存内有效)
   * 业务定位: 概念热度粗筛, 非精确; 长线/盘中筛选都能用
   *
   * 实现: 复用 _conceptLeaderCache 内存缓存 (避免每次重算)
   * @param {string} code 6 位代码
   * @returns {Promise<string[]>} 该股相关的概念板块名数组 (0..3 个, 来自 leaderStock 命中)
   */
  const _conceptLeaderCache = { at: 0, map: new Map() };  // code → [conceptName, ...]
  const _CONCEPT_LEADER_TTL = 15 * 60 * 1000;
  async function getConceptMembership(code) {
    const c = String(code || '').padStart(6, '0');
    if (!/^\d{6}$/.test(c)) return [];
    const now = Date.now();
    if (now - _conceptLeaderCache.at < _CONCEPT_LEADER_TTL && _conceptLeaderCache.map.has(c)) {
      return _conceptLeaderCache.map.get(c);
    }
    // 缓存过期: 重建索引 (leaderStock → conceptName)
    try {
      const boards = await getConceptBoardPerformance();
      const newMap = new Map();
      for (const b of boards) {
        if (!b.leaderStock) continue;
        // leaderStock 形如 "600519" 或 "贵州茅台" — 兼容两种
        const leaderCode = String(b.leaderStock).padStart(6, '0');
        if (!/^\d{6}$/.test(leaderCode)) continue;
        if (!newMap.has(leaderCode)) newMap.set(leaderCode, []);
        newMap.get(leaderCode).push(b.name);
      }
      _conceptLeaderCache.at = now;
      _conceptLeaderCache.map = newMap;
      return newMap.get(c) || [];
    } catch (e) {
      console.warn('[Data] getConceptMembership 失败:', e.message);
      return [];
    }
  }

  /**
   * 全市场公告 (stock_announcement_em), 6h 缓存
   * 输出标准化: [{code, title, date}]
   */
  async function getStockAllAnnouncements() {
    try {
      const raw = await fetchWithCache(
        'stock_announcement_em_v1',
        'stock_announcement_em',
        {},
        6 * 60 * 60 * 1000
      );
      if (!Array.isArray(raw)) return [];
      return raw.map(r => ({
        code: String(r['股票代码'] || r.code || '').padStart(6, '0'),
        title: r['公告标题'] || r.title || r['标题'] || '',
        date: r['公告日期'] || r.date || r['发布日期'] || ''
      })).filter(x => /^\d{6}$/.test(x.code));
    } catch (e) {
      console.warn('[Data] getStockAllAnnouncements 失败:', e.message);
      return [];
    }
  }

  /**
   * 按 code 查近 N 天公告 (业绩预告 + 股东减持 + 全市场公告 三类合并)
   * 复用 getStockEarningsForecastFresh / getStockHolderDecreases / getStockAllAnnouncements
   * 三 fetcher 各自 6h 缓存, 单只成本几乎为 0
   * @param {string} code 6 位
   * @param {number} days 默认 7
   * @returns {Promise<Array<{type,text,date}>>} 单只最多 5 条
   */
  async function getStockNoticesByCode(code, days = 7) {
    const c = String(code || '').padStart(6, '0');
    if (!/^\d{6}$/.test(c)) return [];
    const out = [];
    const cutoff = Date.now() - days * 24 * 3600 * 1000;
    // 1) 业绩预告 (标准化格式 {code, type, summary, reportDate})
    try {
      const yj = await getStockEarningsForecastFresh();
      for (const r of (yj || [])) {
        if (r.code !== c) continue;
        const t = Date.parse(r.reportDate || '');
        if (isNaN(t) || t < cutoff) continue;
        out.push({ type: '业绩预告', text: `${r.type} ${r.summary || ''}`.trim(), date: r.reportDate });
      }
    } catch (e) { console.warn('[Data] 业绩预告过滤失败:', e.message); }
    // 2) 股东减持 (raw 字段, 容错)
    try {
      const dec = await getStockHolderDecreases();
      const list = Array.isArray(dec) ? dec : [];
      for (const r of list) {
        const dcode = String(r['股票代码'] || r.code || '').padStart(6, '0');
        if (dcode !== c) continue;
        const d = r['公告日期'] || r['减持日期'] || r.date || '';
        const t = d ? Date.parse(d) : NaN;
        if (!isNaN(t) && t < cutoff) continue;
        const text = `${r['股东名称'] || r['名称'] || ''} ${r['减持股数'] || r['减持数量'] || r['数量'] || ''}`.trim();
        out.push({ type: '股东减持', text, date: d });
      }
    } catch (e) { console.warn('[Data] 减持过滤失败:', e.message); }
    // 3) 全市场公告
    try {
      const all = await getStockAllAnnouncements();
      for (const r of (all || [])) {
        if (r.code !== c) continue;
        const t = Date.parse(r.date || '');
        if (!isNaN(t) && t < cutoff) continue;
        out.push({ type: '公告', text: r.title || '', date: r.date });
      }
    } catch (e) { console.warn('[Data] 全市场公告过滤失败:', e.message); }
    return out.slice(0, 5);
  }

  /**
   * 量能异动: 今日成交量 / 20 日均量
   * 复用 getStockKLine (24h 缓存命中), 不新增端点
   * @param {string} code 6 位
   * @returns {Promise<{volRatio, todayVol, avg20Vol}|null>}
   */
  async function getStockVolumeAnomaly(code) {
    try {
      const bars = await getStockKLine(code, 'daily', '', '', 'qfq');
      if (!Array.isArray(bars) || bars.length < 21) return null;
      const last = bars[bars.length - 1];
      const todayVol = parseFloat(last['成交量'] || last.volume || 0) || 0;
      const n = Math.min(20, bars.length - 1);
      const avg20Vol = bars.slice(-n - 1, -1)
        .reduce((s, b) => s + (parseFloat(b['成交量'] || b.volume || 0) || 0), 0) / n;
      if (!(avg20Vol > 0)) return null;
      return {
        volRatio: +(todayVol / avg20Vol).toFixed(2),
        todayVol: Math.round(todayVol),
        avg20Vol: Math.round(avg20Vol)
      };
    } catch (e) {
      console.warn('[Data] getStockVolumeAnomaly 失败:', e.message);
      return null;
    }
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
   * 降级链: aktools fund_open_fund_info_em → 天天基金 fund.eastmoney.com/pingzhongdata
   * 端点 2 字段: Data_fundHistoryNetValue (历史日净值数组)
   * 端点 2 注意: 含大量其他 JS 变量 (Data_*: 持仓/分红/业绩), 只解析所需
   */
  async function getFundHistory(code, start, end) {
    const cacheKey = `fund_hist_${code}_${start}_${end}`;
    // 1) 缓存
    const cached = await Core.Storage.cacheGet(cacheKey);
    if (cached) return cached;

    // 2) 限流 (按 path 独立) — 主源被限流时跳过, 直接走天天基金 fallback
    const s = getLimitStatus('fund_open_fund_info_em');
    if (!s.blocked) {
      try {
        const data = await fetchWithCache(
          cacheKey,
          'fund_open_fund_info_em',
          { fund: code, indicator: '单位净值走势', start_date: start, end_date: end },
          24 * 60 * 60 * 1000
        );
        return data;
      } catch (e1) {
        console.warn('[Data] aktools 基金净值失败, 降级天天基金:', e1.message);
      }
    } else {
      console.warn('[Data] aktools 基金净值限流中, 直接走天天基金 fallback');
    }
    // 3) 降级: 天天基金 (跳过限流的主源)
    try {
      const rows = await _fetchTiantianFundHistory(code);
      // 过滤日期
      const startN = parseInt(start, 10);
      const endN = parseInt(end, 10);
      const out = rows.filter(r => {
        const d = r.日期 && r.日期.replace(/-/g, '');
        const dn = parseInt(d, 10);
        return (!startN || dn >= startN) && (!endN || dn <= endN);
      });
      if (out.length > 0) {
        await Core.Storage.cacheSet(cacheKey, out, 24 * 60 * 60 * 1000);
      }
      return out;
    } catch (e2) {
      throw new Error('基金净值源都失败: aktools+天天基金 (' + e2.message + ')');
    }
  }

  /**
   * 天天基金历史净值 fetcher
   * 端点: /api/fund/eastmoney/pingzhongdata/{code}.js
   * 返 JS 文本, 含 Data_netWorthTrend = [{x: ms, y: 单位净值, equityReturn: 日增长率%, unitMoney: ''}, ...]
   * 归一化到 aktools 风格: [{日期, 单位净值, 日增长率, 累计净值(null 该端点不返)}]
   */
  async function _fetchTiantianFundHistory(code) {
    const url = apiUrl(`/api/fund/eastmoney/pingzhongdata/${code}.js`);
    // cache: 'no-store' 强制不走 HTTP cache: 浏览器曾因 301/302 链缓存 opaqueredirect,
    // 后续不带 query string 的同 URL 默认 fetch 永久返 "TypeError: Failed to fetch"。
    // 历史数据走 IndexedDB 缓存(fetchWithCache), 此处不需要 HTTP 缓存。
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok) throw new Error('天天基金 HTTP ' + resp.status);
    const text = await resp.text();
    // 找 Data_netWorthTrend 数组 (obj 数组, 不是 [date,nav,...] 数组)
    const m = text.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('天天基金无 Data_netWorthTrend 字段');
    let arr;
    try { arr = JSON.parse(m[1]); }
    catch (e) { throw new Error('天天基金 JSON 解析失败: ' + e.message); }
    if (!Array.isArray(arr) || arr.length === 0) return [];
    return arr.map(r => {
      // x 是 ms 时间戳
      const d = new Date(parseInt(r.x, 10));
      const date = d.toISOString().slice(0, 10);
      return {
        日期: date,
        单位净值: parseFloat(r.y) || 0,
        累计净值: null,  // 该端点不返累计净值
        日增长率: parseFloat(r.equityReturn) || 0
      };
    });
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
   * Tier 2: 个股北向持股变化 (近 5 日) — 24h 缓存
   * aktools: stock_hsgt_individual_em + 参数 symbol={code}
   * 实际字段(curl 验证 2026-07): 持股日期, 持股数量, 持股市值, 持股数量占A股百分比,
   *   当日增持股数(万股), 当日增持资金(元, 不是亿), 当日持股市值变化(元)
   * 数据 T+1 滞后 (持仓日是上一交易日)
   * @param {string} code 6 位代码
   * @returns {Promise<{todayNet:number, net5d:number, holdingChange:number, pct:number, date:string}|null>}
   *   todayNet 单位:亿; net5d / holdingChange 单位:万股; pct = 持股占 A 股 %
   */
  async function getNorthboundFlow(code) {
    const c = String(code || '').padStart(6, '0');
    if (!/^\d{6}$/.test(c)) return null;
    const cacheKey = `hsgt_individual_${c}_v1`;
    try {
      const raw = await fetchWithCache(
        cacheKey,
        'stock_hsgt_individual_em',
        { symbol: c },
        24 * 60 * 60 * 1000
      );
      if (!Array.isArray(raw) || raw.length === 0) return null;
      // 仅取最近 5 个交易日
      const tail = raw.slice(-5);
      // 今日增持资金(元) → 亿
      const todayDeltaYuan = tail.reduce((s, r) => s + parseFloat(r['今日增持资金'] || 0), 0);
      const lastRow = tail[tail.length - 1];
      const todayNetYuan = parseFloat(lastRow['今日增持资金'] || 0);
      // 5 日持股变化 = 最新持股数 - 5 日前持股数 (万股 → 万股)
      const holdingNow = parseFloat(lastRow['持股数量'] || 0);
      const holding5dAgo = parseFloat(tail[0]['持股数量'] || 0);
      const net5dShares = (holdingNow - holding5dAgo) / 10000;  // 股 → 万股
      return {
        todayNet: +(todayNetYuan / 1e8).toFixed(2),     // 亿
        net5d: +net5dShares.toFixed(2),                 // 万股
        holdingChange: +(parseFloat(lastRow['当日增持股数'] || 0)).toFixed(0),
        pct: +parseFloat(lastRow['持股数量占A股百分比'] || 0).toFixed(2),
        date: lastRow['持股日期'] || ''
      };
    } catch (e) {
      console.warn('[Data] getNorthboundFlow 失败:', e.message);
      return null;
    }
  }

  /**
   * Tier 3A: 龙虎榜 reason 文本 → 6 类结构化标签 (LLM 用得上的离散信号)
   *   'surge' 涨幅异动 (日涨幅偏离 7% / 涨幅 15% / 连续累计涨幅 20% 30%)
   *   'plunge' 跌幅异动 (日跌幅偏离 7% / ST 连续累计跌幅 12%)
   *   'turnover' 换手异动 (日换手率 20% 30%)
   *   'amplitude' 振幅异动 (日振幅 15%)
   *   'st_risk' ST 类风险
   *   'normal' 其它/普通上榜
   * @param {string} reason 上榜原因原文
   * @returns {string} 6 类标签之一
   */
  function _classifyLhbReason(reason) {
    const r = String(reason || '');
    if (/ST|\*ST|股改/.test(r)) return 'st_risk';
    if (/涨幅|上涨/.test(r)) return 'surge';
    if (/跌幅|下跌|偏离/.test(r) && !/涨幅/.test(r)) return 'plunge';
    if (/换手率/.test(r)) return 'turnover';
    if (/振幅/.test(r)) return 'amplitude';
    return 'normal';
  }

  /**
   * Tier 3A: 全市场龙虎榜个股 Map (近 5 日, 含机构席位 + 上榜原因分类)
   * aktools: stock_lhb_jgmmtj_em (无参, 全市场)
   *   字段: 代码/名称/收盘价/涨跌幅/买方机构数/卖方机构数/机构买入净额/机构净买额占总成交额比
   *         /换手率/流通市值/上榜原因/上榜日期
   * 数据 T+1 (今日收盘后公布); 24h 缓存
   * 端点选型说明:
   *   原 stock_lhb_stock_statistic_em 返 994 条但 reason 字段全空, 无机构数据
   *   stock_lhb_jgmmtj_em 返 382 条但有 reason + 机构净额 (Tier 3A 升级)
   * @returns {Promise<Map<string, LhbEntry> | null>} code → {name, lastDate, count, net, reasonTag, institutionNet, institutionRatio}
   */
  async function getLhbSnapshotMap() {
    const cacheKey = 'lhb_jgmmtj_v1';
    try {
      const raw = await fetchWithCache(
        cacheKey,
        'stock_lhb_jgmmtj_em',
        {},
        24 * 60 * 60 * 1000
      );
      if (!Array.isArray(raw) || raw.length === 0) return null;
      const m = new Map();
      for (const r of raw) {
        const code = String(r['代码'] || r.code || '').padStart(6, '0');
        if (!/^\d{6}$/.test(code)) continue;
        const instNetYuan = parseFloat(r['机构买入净额'] || r['机构买入总额'] || r.net_amount || 0);
        if (isNaN(instNetYuan)) continue;
        const ratioPct = parseFloat(r['机构净买额占总成交额比'] || r['机构净买额占总成交额比'] || 0);
        const instBuy = parseInt(r['买方机构数'] || 0, 10) || 0;
        const instSell = parseInt(r['卖方机构数'] || 0, 10) || 0;
        const reasonRaw = r['上榜原因'] || r.reason || '';
        m.set(code, {
          name: r['名称'] || r.name || '',
          lastDate: (r['上榜日期'] || r.last_date || '').slice(0, 10),
          count: 1,                                  // jgmmtj 端点每次只返一条 (单日上榜), count 语义不同
          net: +(instNetYuan / 1e8).toFixed(2),      // 亿 (机构净额, 不是全市场净买)
          reasonTag: _classifyLhbReason(reasonRaw),  // 6 类标签
          reasonText: reasonRaw.slice(0, 20),        // 原文截断 (调试/UI 可读)
          institutionNet: +(instNetYuan / 1e8).toFixed(2),
          institutionRatio: isNaN(ratioPct) ? 0 : +ratioPct.toFixed(2),  // %
          institutionBuy: instBuy,
          institutionSell: instSell
        });
      }
      return m.size > 0 ? m : null;
    } catch (e) {
      console.warn('[Data] getLhbSnapshotMap 失败:', e.message);
      return null;
    }
  }

  /**
   * Tier 2: 格式化北向 Map → 短文本(注入 LLM prompt)
   * @param {Map<string, {todayNet, net5d, pct, date}>} flowMap
   * @param {number} topN 默认 10
   */
  function formatNorthboundForPrompt(flowMap, topN = 10) {
    if (!(flowMap instanceof Map) || flowMap.size === 0) return '';
    const rows = [...flowMap.entries()]
      .filter(([, v]) => v && (v.todayNet !== 0 || v.net5d !== 0))
      .sort((a, b) => Math.abs(b[1].todayNet) - Math.abs(a[1].todayNet))
      .slice(0, topN);
    if (!rows.length) return '';
    const lines = rows.map(([code, v]) => {
      const sign = v.todayNet >= 0 ? '+' : '';
      const sign5 = v.net5d >= 0 ? '+' : '';
      return `- ${code} 今日${sign}${v.todayNet}亿 | 5日${sign5}${v.net5d}万股 | 占A股${v.pct}%`;
    });
    return '【北向资金 (近 5 日, T+1)】\n' + lines.join('\n');
  }

  /**
   * Tier 3A: 格式化龙虎榜 Map → 短文本(注入 LLM prompt)
   * 排序: 机构净额绝对值降序 (机构主导 > 游资主导, 反映"知情资金"强度)
   * 输出: reason 标签 + 机构净额 + 占比
   * @param {Map<string, {name, lastDate, count, net, reasonTag, reasonText, institutionNet, institutionRatio}>} lhbMap
   * @param {number} topN 默认 10
   */
  function formatLhbForPrompt(lhbMap, topN = 10) {
    if (!(lhbMap instanceof Map) || lhbMap.size === 0) return '';
    // 6 类 reason 标签 → 短中文标签 (LLM 看得懂)
    const TAG_LABEL = {
      surge: '涨幅异动',
      plunge: '跌幅异动',
      turnover: '换手异动',
      amplitude: '振幅异动',
      st_risk: 'ST风险',
      normal: '其它上榜'
    };
    const rows = [...lhbMap.entries()]
      .filter(([, v]) => v && (v.institutionNet !== 0 || v.institutionRatio !== 0))
      .sort((a, b) => Math.abs(b[1].institutionNet) - Math.abs(a[1].institutionNet))
      .slice(0, topN);
    if (!rows.length) return '';
    const lines = rows.map(([code, v]) => {
      const sign = v.institutionNet >= 0 ? '+' : '';
      const tag = TAG_LABEL[v.reasonTag] || '其它上榜';
      const ratio = v.institutionRatio ? ` | 机构占成交${v.institutionRatio.toFixed(1)}%` : '';
      return `- ${code} ${v.name} [${tag}] 机构${sign}${v.institutionNet}亿${ratio}`;
    });
    return '【龙虎榜 (近 5 日, T+1, 机构主导)】\n' + lines.join('\n');
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
   * aktools: stock_lhb_stock_statistic_em (无参, 全市场近 5 日上榜统计)
   *   字段: 代码/名称/最近上榜日/上榜次数/龙虎榜净买额/上榜后1日涨跌幅
   * 注: 原 stock_lhb_ggtj_em 端点 HTTP 404,改用 stock_statistic (Tier 2 修复)
   */
  async function _fetchLonghubang() {
    const data = await Core.Data.fetch('ai_ctx_lhb', 'stock_lhb_stock_statistic_em', {}, _CTX_TTL);
    if (!Array.isArray(data) || data.length === 0) return null;
    const rows = data.map(r => ({
      code: r['代码'] || r.code,
      name: r['名称'] || r.name,
      net: parseFloat(r['龙虎榜净买额'] || r['净额'] || r.net_amount || 0),
      count: parseInt(r['上榜次数'] || r.count || 0, 10) || 0,
      post1d: parseFloat(r['上榜后1日涨跌幅'] || 0),
      reason: r['上榜原因'] || r.reason || (r['最近上榜日'] ? `最近上榜${(r['最近上榜日'] || '').slice(0,10)}` : '')
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
    apiUrl,  // 统一拼 API URL (APK 内基于 proxyBase origin 拼绝对路径)
    health,
    getLimitStatus,  // c: UI 读这个显示限流状态
    resetLimit: _clearAllLimit,  // 测试/手动重置 (全部端点; _clearLimit 需带 path)
    // 股票
    getStockSpot, getStockQuote, getStockKLine, getStockFinancial, getStockFinancialBatch, getStockList,
    getStockSpotTencent,    // C: 腾讯 fetcher (codes 参数, 实时)
    _sinaFetch, _sinaParse,  // Z13: 新浪 fetcher + 解析 (腾讯失败兜底, 测试用)
    _tencentKLine,          // Y12: 腾讯 K 线 fetcher (内部)
    getStockSpotEfinance,  // C: 东方财富 fetcher (全市场, screener 用)
    getStockFinancialHistory,  // Phase R: 近 N 期财报对比
    getFinancialCalendar, getStockNextDisclosure,  // Phase U: 财报披露日历
    // 排雷 (Phase Y.1)
    getStockGoodwillRanks, getStockHolderDecreases,  // 商誉 / 减持
    getStockEarningsForecastFresh, getStockCapitalFlight,  // 业绩亏损 / 主力出逃
    // 短线两阶段选品资料 (阶段 1: 行业映射 + 公告 + 量比)
    getStockIndustryByCode, getStockNoticesByCode, getStockAllAnnouncements,
    getStockIndustryBatch,
    getSectorPerformance,
    getConceptBoardPerformance, getConceptMembership,  // Tier 6+: 概念板块涨幅 + 反查
    getStockEarningForecast, getStockEarningForecastBatch,  // V2 P2: 业绩预告
    getStockVolumeAnomaly,
    // 基金
    getFundSpot, getFundHistory, getFundPortfolio,
    // 指数
    getIndexSpot, getIndexSpotTencent,
    // 指数 K 线 (H3 多指数 regime)
    getIndexKLine,
    // 黄金 (Phase J)
    getGoldAu9999,
    formatGoldForPrompt,
    // 国际形势 (Phase L)
    getIntlSnapshot,
    formatIntlForPrompt,
    // AI 上下文快照 (Phase M Tier 1: 估值/财报/北向/M2/板块)
    getAiContextSnapshot,
    formatAiContextForPrompt,
    // Tier 2: 北向个股 + 龙虎榜全市场 (注入 LLM 短线信号)
    getNorthboundFlow, formatNorthboundForPrompt,
    getLhbSnapshotMap, formatLhbForPrompt
  };
})();
