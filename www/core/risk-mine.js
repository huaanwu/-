/**
 * Core.RiskMine - 排雷数据聚合 (Phase Y.1.2)
 *
 * 4 类排雷 fetcher 返回数据形态各异 (数组 / 记录), 本模块统一成
 *   Map<code, Set<reason>> 结构, 喂给 screener.js 软筛 + AI prompt
 *
 * 阈值 (顶部 const, 后续要 UI 调再外提):
 *   商誉占总资产比 > 30% → '商誉偏高'
 *   减持变动比例 > 1% → '股东减持'
 *   业绩预告类型含 '首亏|续亏|预减' → 对应 reason
 *   主力净流入净额 < -1000 万 → '主力净流出'
 *
 * 输入容错: 任意一个数组为 null/undefined/[] 不影响其他类
 * 输出容错: code 全部 padStart(6,'0') 对齐 6 位
 */
(function() {
  'use strict';

  const GOODWILL_RATIO_THRESHOLD = 0.30;   // 商誉占总资产比 > 30% 触发
  const DECREASE_PCT_THRESHOLD = 0.01;     // 减持变动比例 > 1% 触发
  const CAPITAL_FLOW_THRESHOLD = -1e7;     // 主力净流入净额 < -1000 万 (元) 触发

  const REASONS = {
    GOODWILL: '商誉偏高',
    DECREASE: '股东减持',
    LOSS_FIRST: '业绩首亏',
    LOSS_CONTINUE: '业绩续亏',
    LOSS_DECREASE: '业绩预减',
    CAPITAL_FLIGHT: '主力净流出',
    BLACKLIST: '用户黑名单'
  };

  function _pad(code) {
    const c = String(code || '').replace(/\D/g, '');
    return c ? c.padStart(6, '0').slice(-6) : '';
  }

  function _num(x) {
    if (x == null) return null;
    const n = parseFloat(x);
    return isNaN(n) ? null : n;
  }

  /**
   * (A) 商誉 — stock_sy_em 返回行字段 (按 explore 实测):
   *   { 代码, 名称, 最新商誉(元), 商誉占总资产比, 净利润, 总市值 }
   * 多字段名容错 (东财接口字段历史变动过)
   */
  function _markGoodwill(map, list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      const code = _pad(r['代码'] || r.code);
      if (!code) continue;
      const ratio = _num(r['商誉占总资产比'] != null ? r['商誉占总资产比']
        : r['商誉占比'] != null ? r['商誉占比']
        : r['goodwillRatio']);
      if (ratio == null) continue;
      if (ratio > GOODWILL_RATIO_THRESHOLD) {
        if (!map.has(code)) map.set(code, new Set());
        map.get(code).add(REASONS.GOODWILL);
      }
    }
  }

  /**
   * (B) 减持 — stock_ggcg_em(symbol='股东减持') 返回行字段:
   *   { 代码, 名称, 变动数量, 变动比例, 公告日期, 变动后持股比例 }
   * 字段名兜底: 变动比例 / 减持比例 / changeRatio
   */
  function _markDecrease(map, list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      const code = _pad(r['代码'] || r.code);
      if (!code) continue;
      // 减持接口变动比例通常为正数 (东财默认出减持列表已过滤方向)
      const ratio = Math.abs(_num(r['变动比例'] != null ? r['变动比例'] : r['减持比例'] != null ? r['减持比例'] : r.changeRatio) || 0);
      if (ratio > DECREASE_PCT_THRESHOLD) {
        if (!map.has(code)) map.set(code, new Set());
        map.get(code).add(REASONS.DECREASE);
      }
    }
  }

  /**
   * (C) 业绩亏损/预减 — getStockEarningsForecastFresh 已 normalize 成:
   *   { code, name, type, summary, reportDate }
   * type 字符串含: '首亏' / '续亏' / '预减' → 各自 reason
   */
  function _markLoss(map, list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      const code = _pad(r.code || r['代码']);
      if (!code) continue;
      const t = String(r.type || '');
      let reason = null;
      if (t.includes('首亏')) reason = REASONS.LOSS_FIRST;
      else if (t.includes('续亏')) reason = REASONS.LOSS_CONTINUE;
      else if (t.includes('预减') || t.includes('大幅下降') || t.includes('同比下降')) reason = REASONS.LOSS_DECREASE;
      if (reason) {
        if (!map.has(code)) map.set(code, new Set());
        map.get(code).add(reason);
      }
    }
  }

  /**
   * (D) 主力出逃 — stock_individual_fund_flow_rank 返回行字段:
   *   { 代码, 名称, 最新价, 涨跌幅, 主力净流入-净额, 主力净流入-净占比, ... }
   * 净流出 < -1000 万 即视为出逃, 字段名兜底 (akshare 内部列名常带连字符)
   */
  function _markCapital(map, list) {
    if (!Array.isArray(list)) return;
    for (const r of list) {
      const code = _pad(r['代码'] || r.code);
      if (!code) continue;
      // 多种字段名兜底
      const amt = _num(
        r['主力净流入-净额'] != null ? r['主力净流入-净额']
          : r['主力净流入净额'] != null ? r['主力净流入净额']
            : r['主力净流入'] != null ? r['主力净流入']
              : r.mainNetInflow
      );
      if (amt == null) continue;
      if (amt < CAPITAL_FLOW_THRESHOLD) {
        if (!map.has(code)) map.set(code, new Set());
        map.get(code).add(REASONS.CAPITAL_FLIGHT);
      }
    }
  }

  /**
   * 主入口: 把 4 类原始数据合成 Map<code, Set<reason>>
   * 任意输入为 null/undefined 返空 Map; 4 类互不影响
   * @returns {Map<string, Set<string>>}
   */
  function buildReasonSet(goodwillList, decreaseList, profitList, capitalList) {
    const map = new Map();
    _markGoodwill(map, goodwillList);
    _markDecrease(map, decreaseList);
    _markLoss(map, profitList);
    _markCapital(map, capitalList);
    return map;
  }

  /**
   * 把 Map<Set> 序列化成 '代码 → [reason1, reason2]' 字符串数组
   * 供 screener.js 直接 innerHTML / 喂 AI prompt 用
   * @returns {Array<{code, reasons: string[]}>}
   */
  function serialize(map) {
    if (!map || !(map instanceof Map)) return [];
    const out = [];
    for (const [code, reasons] of map.entries()) {
      out.push({ code, reasons: Array.from(reasons) });
    }
    return out;
  }

  window.Core = window.Core || {};
  window.Core.RiskMine = {
    buildReasonSet,
    serialize,
    REASONS
  };
})();
