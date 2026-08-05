/**
 * Core.ReversePool — 反向策略 4 池存储 (V13 拍板 / P1.0)
 *
 * 4 池:
 *   base    → 债性底仓 (周日扫一遍, 2 周一轮)
 *   dragon  → 龙头观察 (板块强度 top 5 入池, 5 日无动作出)
 *   proxy   → 替身候选 (ScreenerReverse.run() 注入)
 *   trap    → 陷阱锁定 (被规则 4/5/6 踢出, 24h 锁定)
 *
 * V13 拍板对齐:
 *   - trap 24h 后自动出池 (你这轮拍板)
 *   - 不新建 Dexie 表 (对齐 stock-master-status 不新建项目)
 *   - 用 Core.Storage.kvGet/kvSet (跟 Steward.lessons 同模式)
 *   - snapId = `${date}-${sleeve}` (复用 Steward.pool 命名)
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  const POOLS = ['base', 'dragon', 'proxy', 'trap'];

  /** key 前缀 */
  const KEY_PREFIX = 'reverse_pool_';

  /** 24h 锁定 (V13 拍板: 24h 后自动出) */
  const TRAP_LOCK_HOURS = 24;

  /** 龙头入池保活天数 */
  const DRAGON_KEEP_DAYS = 5;

  function _todayStr() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return yyyy + '-' + mm + '-' + dd;
  }

  function _key(sleeve, date) {
    if (!POOLS.includes(sleeve)) throw new Error('Invalid sleeve: ' + sleeve);
    return KEY_PREFIX + sleeve + '_' + (date || _todayStr());
  }

  function _storage() {
    if (window.Core && window.Core.Storage) return window.Core.Storage;
    throw new Error('Core.Storage 不可用');
  }

  /**
   * 入池: 覆盖当日 sleeve 快照
   * @param {string} sleeve - base/dragon/proxy/trap
   * @param {Array} items - [{code, name?, reason?, sector?, ...}]
   * @returns {Promise<{ok, sleeve, count, date}>}
   */
  async function save(sleeve, items) {
    if (!POOLS.includes(sleeve)) {
      return { ok: false, error: 'invalid sleeve' };
    }
    const date = _todayStr();
    const key = _key(sleeve, date);
    const storage = _storage();

    const payload = {
      sleeve,
      date,
      savedAt: Date.now(),
      items: Array.isArray(items) ? items : []
    };

    await storage.kvSet(key, payload);
    return { ok: true, sleeve, count: payload.items.length, date };
  }

  /**
   * 加载某 sleeve 最近一次快照
   * @param {string} sleeve
   * @returns {Promise<{items: Array, date: string, savedAt: number}|null>}
   */
  async function load(sleeve) {
    if (!POOLS.includes(sleeve)) return null;
    const storage = _storage();
    const date = _todayStr();
    const todayKey = _key(sleeve, date);
    const todayData = await storage.kvGet(todayKey);
    if (todayData) return todayData;

    // 当日无快照 → 尝试最近一次 (kvSet 是覆盖, 用兜底 key)
    const fallbackKey = KEY_PREFIX + sleeve + '_latest';
    return await storage.kvGet(fallbackKey);
  }

  /**
   * trap 踢出 (V13 拍板: 24h 锁定)
   * @param {string} symbol
   * @param {string} reason - block-1-sector-weak | block-3-quant-seat | ...
   * @param {number} [hours=24]
   * @returns {Promise<{ok, symbol, unlockAt}>}
   */
  async function trapKickOut(symbol, reason, hours) {
    const lockHours = typeof hours === 'number' && hours > 0 ? hours : TRAP_LOCK_HOURS;
    const now = Date.now();
    const unlockAt = now + lockHours * 60 * 60 * 1000;

    const current = (await load('trap')) || { items: [] };
    const items = Array.isArray(current.items) ? current.items : [];

    // 已存在则更新 (同 code 不重复入池)
    const existing = items.find(i => i.code === symbol);
    if (existing) {
      existing.kickedAt = now;
      existing.unlockAt = unlockAt;
      existing.reason = reason;
      existing.count = (existing.count || 1) + 1;
    } else {
      items.push({
        code: symbol,
        kickedAt: now,
        unlockAt,
        reason,
        count: 1
      });
    }

    await save('trap', items);
    // 同步: 把 symbol 列入 trapLockedSymbols 列表 (供 ReverseDiscipline.preBuyCheck 调用)
    await _syncTrapLockedList(items);

    return { ok: true, symbol, unlockAt };
  }

  /**
   * 检查 trap 锁定中列表 (自动剔除过期)
   */
  async function listTrapLocked() {
    const data = await load('trap');
    if (!data || !Array.isArray(data.items)) return [];
    const now = Date.now();
    const locked = [];
    const stillLocked = [];
    for (const it of data.items) {
      if (it.unlockAt && it.unlockAt > now) {
        locked.push(it.code);
        stillLocked.push(it);
      }
      // 过期则不入 locked
    }
    // 写回 (剔除过期)
    if (stillLocked.length !== data.items.length) {
      await save('trap', stillLocked);
    }
    return locked;
  }

  /** 内部: 维护 trapLockedSymbols 列表, 供 preBuyCheck 调用 */
  async function _syncTrapLockedList(items) {
    const locked = items.filter(it => it.unlockAt && it.unlockAt > Date.now()).map(it => it.code);
    const storage = _storage();
    await storage.kvSet('reverse_trap_locked_symbols', locked);
  }

  /**
   * 提供 trapLockedSymbols 给 preBuyCheck (用户拍板买时调)
   */
  async function getTrapLockedSymbols() {
    return await listTrapLocked();
  }

  /** 内部: 取历史 (debug 用) */
  async function listAllPools() {
    const out = {};
    const storage = _storage();
    for (const sleeve of POOLS) {
      const data = await load(sleeve);
      out[sleeve] = data ? data.items : [];
    }
    return out;
  }

  window.Core.ReversePool = {
    VERSION: 'v0.1.0-P1.0',
    POOLS: POOLS.slice(),
    TRAP_LOCK_HOURS,
    DRAGON_KEEP_DAYS,

    save,
    load,
    trapKickOut,
    listTrapLocked,
    getTrapLockedSymbols,
    listAllPools,

    /** 调试用 */
    _todayStr
  };
})();
