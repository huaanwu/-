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
    _num,
    _pctFromTengxun,
    _marketOf
  });
})();