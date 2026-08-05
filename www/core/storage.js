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
  const DB_VERSION = 2;  // v0.2.4: 加 settings_snapshots 表 (WebDAV 同步保险, push 前存云端上一版)

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
      kv: '&key',
      // v0.2.4: WebDAV 同步备份 — 每次 push 前 GET 云端上一版, 落到这里.
      //   reason: 'pre-push' / 'manual' / 'pre-restore'
      //   items 是压缩的 settings 字典 (跟 settings-sync.js collect() 一致)
      settings_snapshots: '&id, ts, reason'
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
   * P2-1/P2-2: Dexie 跨表事务 (读写)
   * 解决 addCondOrder / buy 等"读 + 校验 + 写多表"流程的 TOCTOU / 状态半成品问题.
   * @param {'rw'|'r'} mode - 读写/只读
   * @param {string[]} tables - 涉及的表名 (例 ['kv', 'holdings', 'transactions'])
   * @param {Function} fn - 事务体 (async, 可用 d.transaction-bound 的 this 访问同名 helper)
   * @returns Promise<fn 的返回值>
   */
  async function transaction(mode, tables, fn) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    if (!Array.isArray(tables) || tables.length === 0) throw new Error('transaction: tables 非空数组');
    if (typeof fn !== 'function') throw new Error('transaction: fn 必填');
    return await d.transaction(mode, tables, fn);
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

  /**
   * V0.2.3 设置项同步钩子: kvSet/kvDelete 触发监听
   * 监听者 (Core.SettingsSync) 收到 (key, value | null) 事件
   * 业务逻辑 / 临时缓存 (cache 表) 不需要这个钩子, 但 kvSet 是单点所以一视同仁发出去,
   * SettingsSync 自己按白名单过滤, 避免 hook 调用方做白名单筛选导致新增设置项漏同步
   */
  const _kvWatchers = new Set();
  function onKvChange(fn) {
    if (typeof fn === 'function') _kvWatchers.add(fn);
    return () => _kvWatchers.delete(fn);
  }
  function _emitKvChange(key, value) {
    for (const fn of _kvWatchers) {
      try { fn(key, value); } catch (e) { console.warn('[Storage] kv watcher error:', e); }
    }
  }

  async function kvSet(key, value) {
    const d = init();
    if (!d) return;
    await d.kv.put({ key, value });
    _emitKvChange(key, value);
  }

  async function kvDelete(key) {
    const d = init();
    if (!d) return;
    await d.kv.delete(key);
    _emitKvChange(key, null);
  }

  /**
   * v0.2.4: WebDAV 同步保险 — settings_snapshots 表专用 helper
   * 写一份 snapshot, 按 ts 排序保留最近 N 份, 超出删最老 (默认 5, 走 kv 'settings_sync_backup_keep')
   */
  async function saveSettingsSnapshot(snap) {
    const d = init();
    if (!d) throw new Error('DB not ready');
    await d.settings_snapshots.put(snap);
    const keepRaw = await kvGet('settings_sync_backup_keep');
    const keep = Math.max(1, Math.min(50, parseInt(keepRaw, 10) || 5));
    const all = await d.settings_snapshots.orderBy('ts').reverse().toArray();
    if (all.length > keep) {
      const toDel = all.slice(keep).map(s => s.id);
      await d.settings_snapshots.bulkDelete(toDel);
    }
    return snap.id;
  }

  async function listSettingsSnapshots() {
    const d = init();
    if (!d) return [];
    return await d.settings_snapshots.orderBy('ts').reverse().toArray();
  }

  async function getSettingsSnapshot(id) {
    const d = init();
    if (!d) return null;
    return await d.settings_snapshots.get(id);
  }

  async function deleteSettingsSnapshot(id) {
    const d = init();
    if (!d) return;
    await d.settings_snapshots.delete(id);
  }

  async function clearSettingsSnapshots() {
    const d = init();
    if (!d) return;
    await d.settings_snapshots.clear();
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
    transaction,  // P2-1/P2-2: 跨表事务 (Dexie transaction)
    cacheGet, cacheSet, cacheClear,
    kvGet, kvSet, kvDelete,
    onKvChange,
    clearAll,
    saveSettingsSnapshot, listSettingsSnapshots, getSettingsSnapshot, deleteSettingsSnapshot, clearSettingsSnapshots,
    DB_NAME, DB_VERSION
  };
})();
