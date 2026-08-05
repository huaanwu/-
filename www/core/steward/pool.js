/**
 * Core.Steward.Pool — 股池快照持久化 + diff
 *
 * 设计:
 *   - 每天每个 sleeve 一个快照 (long / short), 主键 snapId = `${date}-${sleeve}`
 *   - 自然幂等: 同一天同一 sleeve 重跑直接 put 覆盖, 不丢历史 (靠 date 索引查)
 *   - diff(a, b) 纯函数, 给两天 items 算 added/removed/kept
 *
 * 表: pool_snapshots (Dexie v7)
 *   snapId (PK) | date | sleeve | ts | runId | source | regime | cycleStage | factor
 *   items[]     | diff{added,removed,kept} | kbIds[] | promptDigest | itemCount
 *
 * item 形态 (对齐 plan §C):
 *   { code, name, rank, score, confidence, dims,
 *     ruleReason, llmReason, ruleRefs: [], delta: 'new'|'keep' }
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  const TABLE = 'pool_snapshots';

  /**
   * 写快照 (upsert by snapId)
   * @param {object} snap
   *   snapId, date, sleeve, ts, runId, source, regime, cycleStage, factor,
   *   items[], kbIds, promptDigest
   * @param {{ allowEmpty?: boolean }} [opts] - allowEmpty=true 放行零股池
   * @returns {Promise<{snapId, itemCount, ok:true}>}
   */
  async function save(snap, opts = {}) {
    if (!snap || typeof snap !== 'object') throw new Error('snap 必须是非空对象');
    const required = ['snapId', 'date', 'sleeve'];
    for (const k of required) {
      if (!snap[k]) throw new Error('save 缺字段: ' + k);
    }
    if (!['long', 'short'].includes(snap.sleeve)) throw new Error('sleeve 仅 long/short, 给的是: ' + snap.sleeve);

    const items = Array.isArray(snap.items) ? snap.items : [];
    if (!opts.allowEmpty && items.length === 0) throw new Error('snap.items 不能为空 (零股池不允许落库, 传 {allowEmpty:true} 可放行)');

    // items 形态规范化: 缺字段补默认, ruleReason 必填 (用于复盘)
    // ST: strategy 必填 — 每只票必须说清楚是哪条 sub-strategy 选出来的, 否则 allocator 没法分桶
    const normItems = items.map((it, i) => {
      const refs = Array.isArray(it.ruleRefs) ? it.ruleRefs : [];
      if (!it.ruleReason || String(it.ruleReason).trim() === '') {
        throw new Error(`items[${i}] (${it.code}) ruleReason 不能为空 — 复盘要靠这条理由`);
      }
      if (typeof it.strategy !== 'string' || it.strategy.trim() === '') {
        throw new Error(`items[${i}] (${it.code}) strategy 必填 (非空字符串) — 要归到某条 sub-strategy 才能分桶配资`);
      }
      return {
        code: String(it.code || ''),
        name: String(it.name || ''),
        strategy: it.strategy.trim(),
        rank: Number.isFinite(it.rank) ? it.rank : (i + 1),
        score: Number.isFinite(it.score) ? it.score : 0,
        price: Number.isFinite(it.price) ? it.price : 0,
        confidence: Number.isFinite(it.confidence) ? it.confidence : 0,
        dims: it.dims && typeof it.dims === 'object' ? it.dims : {},
        ruleReason: String(it.ruleReason),
        llmReason: it.llmReason ? String(it.llmReason) : '',
        ruleRefs: refs,
        delta: it.delta === 'new' ? 'new' : 'keep'
      };
    });

    const allCodes = new Set(normItems.map(it => it.code));
    if (allCodes.size !== normItems.length) {
      throw new Error(`items 内有重复 code (${normItems.length} 条但去重后 ${allCodes.size}), 拒绝写入`);
    }

    // P1 修正: 拿前一日同 sleeve 快照算真 diff (added/removed/kept/deltaPct)
    //   首日 / 找不到前日 → 兜底全 added, removed 空, deltaPct=0
    const prevDate = new Date(new Date(snap.date).getTime() - 86400000).toISOString().slice(0, 10);
    const prev = await Core.Storage.get(TABLE, prevDate + '-' + snap.sleeve);
    const diffReal = prev
      ? _diffFromItems(normItems, prev.items || [])
      : { added: normItems.map(it => it.code), removed: [], kept: [], deltaPct: 0 };

    const full = Object.assign({}, snap, {
      items: normItems,
      itemCount: normItems.length,
      diff: snap.diff || diffReal,
      kbIds: Array.isArray(snap.kbIds) ? snap.kbIds : [],
      promptDigest: snap.promptDigest || '',
      ts: snap.ts || Date.now()
    });

    await Core.Storage.put(TABLE, full);
    return { snapId: full.snapId, itemCount: full.itemCount, ok: true };
  }

  /**
   * 取一天某 sleeve 的快照
   * @param {string} date - YYYY-MM-DD
   * @param {'long'|'short'} sleeve
   */
  async function get(date, sleeve) {
    if (!date || !sleeve) throw new Error('date+sleeve 必填');
    const snapId = `${date}-${sleeve}`;
    return await Core.Storage.get(TABLE, snapId);
  }

  /**
   * 取某 sleeve 最近的快照 (默认 today, 找不到回退到前一天)
   * @param {'long'|'short'} sleeve
   * @param {Date|string} [now]
   */
  async function latest(sleeve, now) {
    if (!['long', 'short'].includes(sleeve)) throw new Error('sleeve 仅 long/short');
    const base = now ? new Date(now) : new Date();
    // 最多回溯 7 天 (一周内最近一份)
    for (let i = 0; i < 7; i++) {
      const d = new Date(base.getTime() - i * 86400000);
      const ds = d.toISOString().slice(0, 10);
      const snap = await get(ds, sleeve);
      if (snap) return snap;
    }
    return null;
  }

  /**
   * 列出某 sleeve 最近 N 条快照 (按日期倒序)
   * @param {'long'|'short'} sleeve
   * @param {number} [limit=10]
   */
  async function list(sleeve, limit) {
    if (!['long', 'short'].includes(sleeve)) throw new Error('sleeve 仅 long/short');
    const lim = Number.isFinite(limit) ? limit : 10;
    const all = (await Core.Storage.where(TABLE, 'sleeve', sleeve)) || [];
    all.sort((a, b) => String(b.date).localeCompare(String(a.date)));
    return all.slice(0, lim);
  }

  /**
   * 算两天快照的 diff
   * @param {object} aSnap - 旧
   * @param {object} bSnap - 新
   * @returns {{added:string[], removed:string[], kept:string[], deltaPct:number}}
   */
  function diff(aSnap, bSnap) {
    if (!aSnap || !bSnap) return { added: [], removed: [], kept: [], deltaPct: 0 };
    const aCodes = new Set((aSnap.items || []).map(it => it.code));
    const bCodes = new Set((bSnap.items || []).map(it => it.code));
    const added = [];
    const kept = [];
    for (const c of bCodes) {
      if (aCodes.has(c)) kept.push(c);
      else added.push(c);
    }
    const removed = [];
    for (const c of aCodes) {
      if (!bCodes.has(c)) removed.push(c);
    }
    const totalB = bCodes.size || 1;
    const deltaPct = Math.round(((added.length - removed.length) / totalB) * 100);
    return { added, removed, kept, deltaPct };
  }

  /**
   * 给单份 items 算 self-diff (纯留痕用, 给 pool_snapshots.diff 兜底)
   * @param {Array} items
   * @param {Array} prevItems
   */
  function _diffFromItems(items, prevItems) {
    const prevCodes = new Set((prevItems || []).map(it => it.code));
    return {
      added: (items || []).map(it => it.code).filter(c => !prevCodes.has(c)),
      removed: [],
      kept: (items || []).map(it => it.code).filter(c => prevCodes.has(c)),
      deltaPct: 0
    };
  }

  /**
   * 查最近 30 天某 sleeve 的换手率 (每天 diff.removed 平均 / 总池)
   * @param {'long'|'short'} sleeve
   * @returns {Promise<{avgTurnover:number, samples:number}>}
   */
  async function turnover(sleeve) {
    const snaps = await list(sleeve, 30);
    if (snaps.length < 2) return { avgTurnover: 0, samples: snaps.length };
    let sum = 0, n = 0;
    for (let i = 0; i < snaps.length - 1; i++) {
      const newer = snaps[i];
      const older = snaps[i + 1];
      const d = diff(older, newer);
      const total = (older.items || []).length || 1;
      sum += d.removed.length / total;
      n++;
    }
    return { avgTurnover: n > 0 ? +(sum / n).toFixed(3) : 0, samples: n };
  }

  window.Core.Steward = window.Core.Steward || {};
  window.Core.Steward.Pool = {
    save,
    get,
    latest,
    list,
    diff,
    turnover,
    TABLE
  };

  console.log('[Steward/Pool] 股池快照模块已就绪 (Dexie pool_snapshots)');
})();
