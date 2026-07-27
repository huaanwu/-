/**
 * Core.Pending - 实盘"待确认交易" (Phase E: 半自动执行)
 * 依赖: Core.Storage / Core.Util
 *
 * 设计原则: AI 提建议, 模拟盘自动跑, 实盘必须人确认。
 * 本模块只负责"建议卡片"的存取与状态机, 确认后走 holdings.js 原有买入流程
 * (含 Core.Discipline.preBuyCheck 纪律检查), 本模块绝不直接成交。
 *
 * 存储: kv 'pending_trades', 数组, 上限 MAX_ITEMS 条, 元素结构:
 *   { id, code, name, market, action: 'buy',
 *     suggestedShares, suggestedAmount, reason, assumption, stopLoss,
 *     falsifyCondition, invalidation, regime,
 *     source: 'screener', createdAt, expireAt,
 *     status: 'pending' | 'confirmed' | 'ignored' }
 */
(function() {
  'use strict';

  window.Core = window.Core || {};

  const KV_KEY = 'pending_trades';
  const MAX_ITEMS = 50;               // kv 数组上限, 防爆
  const EXPIRE_DAYS = 7;              // 建议有效期: 创建后 7 天, 过期惰性转 ignored
  const SUGGEST_PCT = Core.Constants.SUGGEST_PCT_PENDING;  // 建议仓位 (常量从 Core.Constants 取, 见 constants.js)
  const LOT = Core.Constants.LOT_SIZE;
  const DAY_MS = 86400000;

  window.Core.Pending = {
    KV_KEY, MAX_ITEMS, EXPIRE_DAYS, SUGGEST_PCT, LOT,

    /** 读 kv 数组 (读取失败降级空数组, 不抛) */
    async _load() {
      try {
        const list = await window.Core.Storage.kvGet(KV_KEY);
        return Array.isArray(list) ? list : [];
      } catch (e) {
        console.warn('[Pending] 读取失败, 降级空数组:', e);
        return [];
      }
    },

    async _save(list) {
      await window.Core.Storage.kvSet(KV_KEY, list);
    },

    /**
     * 建议仓位计算 (纯函数, Node 沙箱可测)
     * 金额 = 总资产 × SUGGEST_PCT(5%) × 大盘状态机仓位系数 (下跌市 ×0.5 → 2.5%),
     * 且不超纪律单票上限的剩余额度
     * (单票上限口径与 Core.Discipline._checkConcentration 一致:
     *  (已持该 code 市值 + 本次金额) / 总资产 ≤ maxSingleStockPct)
     * 股数整手(100)向下取整, 不足一手返回 null
     * @param {{ totalAssets: number, price: number, config?: object, heldValue?: number }} input
     *        heldValue: 该 code 当前实盘持仓市值 (默认 0)
     * @returns {{ shares: number, amount: number } | null}
     */
    _suggestPosition({ totalAssets, price, config, heldValue } = {}) {
      totalAssets = parseFloat(totalAssets) || 0;
      price = parseFloat(price) || 0;
      if (!(totalAssets > 0) || !(price > 0)) return null;
      const cfg = config || {};
      const maxSinglePct = parseFloat(cfg.maxSingleStockPct) > 0
        ? parseFloat(cfg.maxSingleStockPct)
        : Core.Constants.MAX_SINGLE_STOCK_PCT; // 与 Core.Discipline.DEFAULT_CONFIG 默认值一致
      // 大盘状态机: 下跌市仓位系数 0.5; Regime 不可用/异常 → 回退 1.0 (旧行为)
      let scale = 1;
      try {
        const R = window.Core && window.Core.Regime;
        if (R && typeof R.gateMultipliers === 'function') {
          const g = R.gateMultipliers();
          if (g && typeof g.positionScale === 'number' && isFinite(g.positionScale) && g.positionScale > 0) {
            scale = g.positionScale;
          }
        }
      } catch (e) {
        console.warn('[Pending] Regime gate 读取失败, 仓位系数回退 1.0:', e);
      }
      let amount = totalAssets * SUGGEST_PCT * scale;
      const room = totalAssets * maxSinglePct - (parseFloat(heldValue) || 0);
      amount = Math.min(amount, Math.max(room, 0));
      const shares = Math.floor(amount / price / LOT) * LOT;
      if (shares < LOT) return null;
      return { shares, amount: +(shares * price).toFixed(2) };
    },

    /**
     * 新增待确认交易; 同 code 且 status='pending' 已存在时不重复建卡,
     * 只刷新 createdAt/expireAt/reason 及建议仓位字段, 返回原 id
     * @returns {Promise<string>} 卡片 id
     */
    async add(trade) {
      if (!trade || !trade.code) throw new Error('Pending.add: code 必填');
      const list = await this._load();
      const now = Date.now();
      const existing = list.find(t => t.code === trade.code && t.status === 'pending');
      if (existing) {
        existing.createdAt = now;
        existing.expireAt = now + EXPIRE_DAYS * DAY_MS;
        if (trade.reason) existing.reason = trade.reason;
        if (trade.suggestedShares) existing.suggestedShares = trade.suggestedShares;
        if (trade.suggestedAmount) existing.suggestedAmount = trade.suggestedAmount;
        if (trade.stopLoss) existing.stopLoss = trade.stopLoss;
        if (trade.regime) existing.regime = trade.regime;
        await this._save(list);
        return existing.id;
      }
      const item = {
        id: window.Core.Util.uuid(),
        code: trade.code,
        name: trade.name || '',
        market: trade.market || '',
        action: 'buy',                       // 本期只做 buy 方向
        suggestedShares: trade.suggestedShares || 0,
        suggestedAmount: trade.suggestedAmount || 0,
        reason: trade.reason || '',
        assumption: trade.assumption || '',
        stopLoss: trade.stopLoss || null,
        falsifyCondition: trade.falsifyCondition || '',
        invalidation: trade.invalidation || '',
        regime: trade.regime || '',            // 建卡时的大盘市况标签 (Core.Regime)
        source: trade.source || 'unknown',
        createdAt: now,
        expireAt: now + EXPIRE_DAYS * DAY_MS,
        status: 'pending'
      };
      list.push(item);
      // 上限 MAX_ITEMS: 优先淘汰最旧的已完结卡片 (confirmed/ignored), 全是 pending 才淘汰最旧的 pending
      while (list.length > MAX_ITEMS) {
        const resolved = list.filter(t => t.status !== 'pending').sort((a, b) => a.createdAt - b.createdAt);
        const victim = resolved[0] || list.slice().sort((a, b) => a.createdAt - b.createdAt)[0];
        list.splice(list.indexOf(victim), 1);
      }
      await this._save(list);
      return item.id;
    },

    /** 列卡片 (可选按 status 过滤), 按 createdAt 倒序; 调用前惰性清理过期 */
    async list(status) {
      const list = await this.purgeExpired();
      const filtered = status ? list.filter(t => t.status === status) : list;
      return filtered.sort((a, b) => b.createdAt - a.createdAt);
    },

    async get(id) {
      const list = await this._load();
      return list.find(t => t.id === id) || null;
    },

    /** 只改状态, 不做任何成交动作 */
    async confirm(id) { return this._setStatus(id, 'confirmed'); },
    async ignore(id) { return this._setStatus(id, 'ignored'); },

    async _setStatus(id, status) {
      const list = await this._load();
      const t = list.find(x => x.id === id);
      if (!t) return false;
      t.status = status;
      await this._save(list);
      return true;
    },

    /**
     * 过期清理: expireAt 已过期的 pending 自动标 'ignored' (list 时惰性执行)
     * @param {number} [now] 可注入时间便于测试
     * @returns {Promise<Array>} 清理后的完整数组
     */
    async purgeExpired(now) {
      now = now || Date.now();
      const list = await this._load();
      let changed = false;
      for (const t of list) {
        if (t.status === 'pending' && t.expireAt && t.expireAt <= now) {
          t.status = 'ignored';
          changed = true;
        }
      }
      if (changed) await this._save(list);
      return list;
    }
  };
})();
