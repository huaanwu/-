/**
 * Core.Storage - IndexedDB 存储层 (Dexie 封装)
 * 依赖: Dexie 4 (从 /node_modules/ 通过 vite optimizeDeps 暴露,或直接挂 window)
 *
 * 数据表:
 *   - watchlist: 自选股
 *   - holdings:  持仓(包含 transactions 子表)
 *   - transactions: 交易记录
 *   - journals:  复盘笔记
 *   - alerts:    提醒规则
 *   - funds:     自选基金
 *   - cache:     数据缓存(K线/财务,key 是 JSON.stringify(args))
 *   - kv:        通用键值(API key 等)
 */
(function() {
  'use strict';

  // Dexie 期望 window 暴露(Dexie 4 UMD 模式),由 index.html 引入
  // 这里直接 new Dexie()

  const DB_NAME = 'stockmaster';
  const DB_VERSION = 1;

  let db = null;

  function init() {
    if (db) return db;
    if (typeof Dexie === 'undefined') {
      console.error('[Storage] Dexie 未加载');
      return null;
    }
    db = new Dexie(DB_NAME);

    db.version(DB_VERSION).stores({
      // 表名: 字段1, 字段2, ...
      // 第一个是主键
      watchlist: '&code, name, market, addedAt',
      holdings: '&id, code, name, market, type, createdAt',
      transactions: '&id, holdingId, code, type, date, createdAt',
      journals: '&id, code, date, createdAt, updatedAt',
      alerts: '&id, code, type, active, createdAt',
      funds: '&code, name, type, addedAt',
      cashflow: '&id, date, type, createdAt',  // 资金流水 (存入/取出/分红/费用)
      cache: '&key, expiresAt',
      kv: '&key'
    });

    return db;
  }

  /**
   * 通用 CRUD helper
   */
  async function add(table, data) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].add(data);
  }

  async function put(table, data) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].put(data);
  }

  async function get(table, key) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].get(key);
  }

  async function all(table) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].toArray();
  }

  async function where(table, index, value) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].where(index).equals(value).toArray();
  }

  async function remove(table, key) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].delete(key);
  }

  async function clear(table) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    return await d[table].clear();
  }

  /**
   * 缓存层(带 TTL)
   * key: string
   * data: any
   * ttl: ms (默认 5 分钟)
   */
  async function cacheGet(key) {
    const d = init();
    if (!d) return null;
    const item = await d.cache.get(key);
    if (!item) return null;
    if (item.expiresAt && item.expiresAt < Date.now()) {
      await d.cache.delete(key);
      return null;
    }
    return item.data;
  }

  async function cacheSet(key, data, ttl = 5 * 60 * 1000) {
    const d = init();
    if (!d) return;
    await d.cache.put({
      key,
      data,
      expiresAt: Date.now() + ttl
    });
  }

  async function cacheClear() {
    const d = init();
    if (!d) return;
    await d.cache.clear();
  }

  /**
   * KV(简单设置存储,不加密,敏感信息别放这里)
   */
  async function kvGet(key) {
    const d = init();
    if (!d) return null;
    const item = await d.kv.get(key);
    return item ? item.value : null;
  }

  async function kvSet(key, value) {
    const d = init();
    if (!d) return;
    await d.kv.put({ key, value });
  }

  async function kvDelete(key) {
    const d = init();
    if (!d) return;
    await d.kv.delete(key);
  }

  /**
   * 清空所有业务表(保留 settings)
   */
  async function clearAll() {
    const d = init();
    if (!d) return;
    await Promise.all([
      d.watchlist.clear(),
      d.holdings.clear(),
      d.transactions.clear(),
      d.journals.clear(),
      d.alerts.clear(),
      d.funds.clear(),
      d.cache.clear()
    ]);
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.Storage = {
    init,
    add, put, get, all, where, remove, clear,
    cacheGet, cacheSet, cacheClear,
    kvGet, kvSet, kvDelete,
    clearAll,
    DB_NAME, DB_VERSION
  };
})();
