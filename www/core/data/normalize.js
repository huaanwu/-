/**
 * Core.Data.Normalize - 提供方→统一 DTO 的纯函数映射 (Phase 1.2)
 *
 * 职责:
 *   - 每个 Provider 一份 normalize 函数: raw -> payload (符合 quote.v3 schema)
 *   - 字段映射在 Plan A.4 表里定好 (腾讯/新浪/AKTools -> 统一字段)
 *   - 停牌 / 缺失 / 字符串带 % 等异常情形由 normalize 函数自己处理, 不抛
 *
 * 设计:
 *   - 纯函数, 无 Core.* 依赖, 可在 Node vm sandbox 单测
 *   - 阶段 1 只实现 tengxun; 阶段 2 加 sina / aktools
 *   - 输入 raw 是 Core.Data._tencentFetch 返回的原始对象 (见 www/core/data.js:89-107)
 *
 * 关键边界 (你写 normalizeTengxun 时需要拍板):
 *   1. 腾讯的 涨跌幅 是字符串 "1.23%" — 必须 parseFloat + 除以 100
 *   2. 停牌时 最新价 / 涨跌额 为空字符串 — 用 null 表示缺失, 不是 0
 *   3. 成交量 字段是手 (×100 = 股); 成交额 字段是万元 (×10000 = 元)
 *   4. 时间 字段格式 "20260730103000" — 不强行 parse, 保留字符串
 *   5. 涨跌幅 / 涨跌额 仅当现价 + 昨收都有效时计算, 否则 null
 */
(function() {
  'use strict';

  const Schema = window.Core.Data.Schema;
  if (!Schema) {
    console.error('[DataNormalize] Schema 未加载, 请确认 schema.js 在 normalize.js 之前加载');
  }

  /**
   * 安全 parseFloat: 空字符串 / 非数字 -> null (区别于 0)
   */
  function _num(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }

  /**
   * 解析腾讯的 "涨跌幅" 字段 (字符串 "1.23%" -> 0.0123)
   * 边界: 空字符串 / "0.00%" / "停牌" 等异常情况
   */
  function _pctFromTengxun(s) {
    if (s == null || s === '') return null;
    const str = String(s).replace(/[%\s]/g, '');
    if (str === '' || str === '停牌' || str === '-') return null;
    const n = parseFloat(str);
    return isNaN(n) ? null : n / 100;  // 腾讯给的是 %, 我们存小数 (0.0123)
  }

  /**
   * 腾讯原始对象 -> quote.v3 payload
   *
   * 输入 (core/data.js _tencentFetch 返回结构):
   *   {
   *     '代码': '600519',
   *     '名称': '贵州茅台',
   *     '最新价': '1730.00' | '' (停牌),    // 字符串
   *     '昨收': '1720.00',
   *     '今开': '1725.00',
   *     '最高': '1735.00',
   *     '最低': '1718.00',
   *     '成交量': '12345',                  // 手
   *     '总成交量': '67890',                // 手
   *     '总成交额': '45678.90',             // 万元
   *     '换手率': '0.85',
   *     '市盈率': '28.5',
   *     '流通市值': '21730.50',             // 亿
   *     '总市值': '21730.50',               // 亿
   *     '涨跌额': '10.00',
   *     '涨跌幅': '0.58%',                  // 字符串带 %
   *     '时间': '20260730103000'
   *   }
   *
   * 输出 (quote.v3 payload, 全部为标准 JS 类型):
   *   {
   *     symbol, name, market (从 symbol 推),
   *     price, prevClose, open, high, low,
   *     change, changePercent,           // null 表示缺失
   *     volume (股), amount (元),
   *     turnoverRate, pe, circMarketCap, totalMarketCap, timestamp
   *   }
   */
  function normalizeTengxun(raw) {
    if (!raw || typeof raw !== 'object') return null;

    // ===== 实现: 腾讯 raw -> quote.v3 payload =====
    // 取数原则: 停牌/缺失返 null (不用 0 顶替, "未知" != "0")
    const symbol = raw['代码'] || raw.code || '';
    const name = raw['名称'] || raw.name || '';
    const price = _num(raw['最新价']);
    const prevClose = _num(raw['昨收']);
    const change = (price != null && prevClose != null) ? price - prevClose : null;
    const volume = (() => { const n = _num(raw['成交量']); return n != null ? n * 100 : null; })();   // 手 -> 股
    const amount = (() => { const n = _num(raw['总成交额']); return n != null ? n * 10000 : null; })(); // 万 -> 元
    const payload = {
      symbol, name,
      market: _marketOf(symbol),
      price, prevClose,
      open: _num(raw['今开']),
      high: _num(raw['最高']),
      low: _num(raw['最低']),
      change,
      changePercent: _pctFromTengxun(raw['涨跌幅']),
      volume, amount,
      turnoverRate: _num(raw['换手率']),
      pe: _num(raw['市盈率']),
      circMarketCap: (() => { const n = _num(raw['流通市值']); return n != null ? n * 1e8 : null; })(),  // 亿 -> 元
      totalMarketCap: (() => { const n = _num(raw['总市值']); return n != null ? n * 1e8 : null; })(),
      timestamp: raw['时间'] || ''
    };

    return payload;
  }

  /**
   * 新浪原始对象 -> quote.v3 payload
   *
   * 输入 (core/data.js _sinaParse 返回结构):
   *   {
   *     代码: '600519', 名称: '贵州茅台',
   *     最新价: 1730.00, 昨收: 1720.00,    // 数字, 已 parseFloat
   *     今开: 1725.00, 最高: 1735.00, 最低: 1718.00,
   *     成交量: 1234500,                    // **股** (新浪直给, 不是手)
   *     成交额: 456789000,                  // **元** (新浪直给, 不是万)
   *     涨跌额: 10.00,                      // 已算
   *     涨跌幅: 0.58,                       // **已是百分数** (新浪客户端算的, 与腾讯字符串不同)
   *     时间: '2026-07-30 10:30:00',
   *     换手率: null, 市盈率: null,         // 新浪免费接口不返
   *     流通市值: null, 总市值: null
   *   }
   *
   * 输出: 与 normalizeTengxun 同形 (quote.v3 payload, 全部为标准 JS 类型)
   */
  function normalizeSina(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const symbol = raw['代码'] || raw.code || '';
    const name = raw['名称'] || raw.name || '';
    const price = _num(raw['最新价']);
    const prevClose = _num(raw['昨收']);
    const change = (() => {
      const c = _num(raw['涨跌额']);
      if (c != null) return c;
      return (price != null && prevClose != null) ? price - prevClose : null;
    })();
    const volume = _num(raw['成交量']);     // 股 — 直给, 不 ×100
    const amount = _num(raw['成交额']);     // 元 — 直给, 不 ×10000
    return {
      symbol, name,
      market: _marketOf(symbol),
      price, prevClose,
      open: _num(raw['今开']),
      high: _num(raw['最高']),
      low: _num(raw['最低']),
      change,
      changePercent: _pctFromSina(raw['涨跌幅']),    // 数字 → 小数
      volume, amount,
      turnoverRate: _num(raw['换手率']),
      pe: _num(raw['市盈率']),
      circMarketCap: _num(raw['流通市值']),
      totalMarketCap: _num(raw['总市值']),
      timestamp: raw['时间'] || ''
    };
  }

  /**
   * AKTools 原始对象 -> quote.v3 payload
   *
   * 输入 (aktools stock_zh_a_spot_em 接口, 返回字段名 snake_case):
   *   {
   *     ts_code: '600519.SH', name: '贵州茅台',
   *     trade_date: '20260730',
   *     open: 1725.0, high: 1735.0, low: 1718.0, close: 1730.0,
   *     vol: 12345.0,          // **手** (aktools stock_zh_a_spot_em vol 字段, ×100 = 股)
   *     amount: 45678.9,       // **千元** (aktools amount 字段, ×1000 = 元)  // 待核实
   *     change: 10.0,          // 元
   *     pct_chg: 0.58,         // **百分数** (aktools 客户端算的, 与腾讯字符串不同)
   *     turnover_rate: 0.85,   // % 数字
   *     pe: 28.5,              // 倍
   *     total_mv: 21730.5,     // **亿元** (aktools total_mv, ×1e8 = 元)
   *     circ_mv: 21730.5       // **亿元**
   *   }
   *
   * 注意: aktools vol 是手(×100 股),amount 是千(×1000 元),
   *   total_mv/circ_mv 是万元(×1e4 元)。normalize.aktools 自己消化这些差异。
   *
   * 输出: quote.v3 payload
   */
  function normalizeAktools(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const symbolRaw = raw['ts_code'] || raw.code || raw['代码'] || '';
    // ts_code 格式 '600519.SH' → '600519'
    const symbol = symbolRaw.includes('.') ? symbolRaw.split('.')[0] : symbolRaw;
    const name = raw['name'] || raw['名称'] || '';
    const price = _num(raw['close'] != null ? raw['close'] : raw['最新价']);
    const prevClose = _num(raw['prev_close'] != null ? raw['prev_close'] : raw['昨收']);
    // aktools 不一定返 prev_close, 但 change + pct_chg 一定有, 反推 prevClose
    const change = (() => {
      const c = _num(raw['change'] != null ? raw['change'] : raw['涨跌额']);
      if (c != null) return c;
      return (price != null && prevClose != null) ? price - prevClose : null;
    })();
    const volRaw = _num(raw['vol'] != null ? raw['vol'] : raw['成交量']);
    const volume = volRaw != null ? volRaw * 100 : null;     // 手 → 股
    const amountRaw = _num(raw['amount'] != null ? raw['amount'] : raw['成交额']);
    const amount = amountRaw != null ? amountRaw * 1000 : null;  // 千 → 元(待核实)
    const tmvRaw = _num(raw['total_mv'] != null ? raw['total_mv'] : raw['总市值']);
    const cmvRaw = _num(raw['circ_mv'] != null ? raw['circ_mv'] : raw['流通市值']);
    return {
      symbol, name,
      market: _marketOf(symbol),
      price, prevClose,
      open: _num(raw['open'] != null ? raw['open'] : raw['今开']),
      high: _num(raw['high'] != null ? raw['high'] : raw['最高']),
      low: _num(raw['low'] != null ? raw['low'] : raw['最低']),
      change,
      changePercent: _pctFromAktools(raw['pct_chg'] != null ? raw['pct_chg'] : raw['涨跌幅']),
      volume, amount,
      turnoverRate: _num(raw['turnover_rate'] != null ? raw['turnover_rate'] : raw['换手率']),
      pe: _num(raw['pe'] != null ? raw['pe'] : raw['市盈率']),
      circMarketCap: cmvRaw != null ? cmvRaw * 1e8 : null,    // 亿元 → 元
      totalMarketCap: tmvRaw != null ? tmvRaw * 1e8 : null,
      timestamp: raw['trade_date'] || raw['时间'] || ''
    };
  }

  /**
   * 解析新浪的 "涨跌幅" 字段 — 已是百分数数字(1.23 表示 +1.23%)
   * 边界: null / null-ish / 字符串带 % 都安全处理
   */
  function _pctFromSina(v) {
    if (v == null || v === '') return null;
    const n = parseFloat(String(v).replace(/[%\s]/g, ''));
    return isNaN(n) ? null : n / 100;   // 1.23 → 0.0123 (与 _pctFromTengxun 同语义, 都是小数)
  }

  /**
   * 解析 aktools pct_chg — 已是百分数数字
   */
  function _pctFromAktools(v) {
    return _pctFromSina(v);
  }

  // 简易 _marketOf 内联实现 (避免 normalize 依赖 facade)
  function _marketOf(symbol) {
    const s = String(symbol || '');
    if (s.startsWith('6')) return Schema.MARKETS.SH;
    if (s.startsWith('0') || s.startsWith('3')) return Schema.MARKETS.SZ;
    if (s.startsWith('5')) return Schema.MARKETS.SH;
    if (s.startsWith('1') || s.startsWith('2')) return Schema.MARKETS.SZ;
    return Schema.MARKETS.SH;
  }

  window.Core = window.Core || {};
  window.Core.Data = window.Core.Data || {};
  window.Core.Data.Normalize = Object.freeze({
    normalizeTengxun,
    normalizeSina,
    normalizeAktools,
    _num,
    _pctFromTengxun,
    _pctFromSina,
    _pctFromAktools,
    _marketOf
  });
})();