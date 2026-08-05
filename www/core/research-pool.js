/**
 * Core.ResearchPool — 用户研究的本地股票池 (Phase R)
 *
 * 设计目的: 锁定 AI 选股边界
 *   - 用户先往池子里加"我想研究的股票" (≤50 只, 强制精选)
 *   - AI 选股 (screener/long-trader/short-trader) 只能从这个池子里挑
 *   - 池空 → AI 选股直接禁止, 提示用户先加研究池
 *
 * 与 watchlist 的区别:
 *   - watchlist: "现在想关注的票" (可多可少, 临时)
 *   - research_pool: "我愿意花时间研究的票" (≤50, 强制精选, 持久)
 *
 * 数据结构 (Dexie table: research_pool):
 *   { code, name, market, tags: [], note, addedAt, addedBy }
 *   code 为主键 (A 股 6 位数, 用 parseStockInput 解析)
 *
 * 使用:
 *   const pool = await Core.ResearchPool.list();
 *   await Core.ResearchPool.add('600519', '贵州茅台');
 *   const isReady = await Core.ResearchPool.checkSize();  // returns { ready, count, limit, missing }
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  const TABLE = 'research_pool';
  // v0.2.25 S3 Steward: 50→100 总池 + 新增每 sleeve 50 分槽
  //   长短线池各 50 (long50 + short50) 需要池子至少 100
  //   老的单 sleeve=50 限制保留 (screener 导入时, 同 sleeve 自动加的最旧的踢一只)
  const MAX_SIZE = 100;            // 强制精选: ≤100 只 (长线 50 + 短线 50)
  const MAX_PER_SLEEVE = 50;       // 单 sleeve 上限 (long/short 各 50)
  const MIN_SIZE = 1;              // 至少 1 只才允许 AI 选股

  function _inferMarket(code) {
    const c = String(code || '').trim();
    if (/^60/.test(c) || /^90/.test(c)) return 'SH';
    if (/^00/.test(c) || /^20/.test(c) || /^30/.test(c)) return 'SZ';
    if (/^8/.test(c) || /^43/.test(c) || /^92/.test(c)) return 'BJ';
    return '';
  }

  /**
   * 解析输入 (代码 / "代码 名称")
   * @returns { code, name }
   */
  function _parseInput(input) {
    if (!input) throw new Error('输入不能为空');
    const s = String(input).trim();
    // 形如 "600519 贵州茅台" 或 "600519,贵州茅台"
    const m = s.match(/^(\d{6})\s*[,\s]+(.+)$/);
    if (m) return { code: m[1], name: m[2].trim() };
    if (/^\d{6}$/.test(s)) return { code: s, name: '' };
    throw new Error('解析失败: 需 6 位股票代码, 或 "代码 名称" 格式');
  }

  /**
   * 加入研究池
   * @param {string} input - "600519" 或 "600519 贵州茅台"
   * @param {object} [opts] - { tags: [], note: '' }
   */
  async function add(input, opts = {}) {
    const parsed = _parseInput(input);
    const code = parsed.code;
    const name = parsed.name || '';

    // 1) 上限校验 + 智能替换
    const cur = await Core.Storage.all(TABLE);
    const newSleeve = (opts.tags || [])[0] || '';

    // v0.2.25 S3 Steward: 先查 sleeve 配额, 同 sleeve 已满 → 触发 sleeve 分槽替换
    if (newSleeve) {
      const sleeveCount = cur.filter(r => Array.isArray(r.tags) && r.tags.includes(newSleeve)).length;
      if (sleeveCount >= MAX_PER_SLEEVE) {
        // 找同 sleeve + 自动加的最旧一只踢掉
        const candidate = cur
          .filter(r => Array.isArray(r.tags) && r.tags.includes(newSleeve) && typeof r.addedBy === 'string' && r.addedBy.startsWith('screener-'))
          .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0))[0];
        if (candidate) {
          await Core.Storage.remove(TABLE, candidate.code);
          const newRecord = {
            code, name, market: opts.market || _inferMarket(code),
            tags: Array.isArray(opts.tags) ? opts.tags : [],
            note: opts.note || '',
            addedAt: Date.now(),
            addedBy: opts.addedBy || 'manual',
            replacedFrom: candidate.code
          };
          await Core.Storage.put(TABLE, newRecord);
          return { added: true, existed: false, code, name, replaced: candidate.code, replacedSleeve: newSleeve, replacedReason: 'sleeve-full' };
        }
        throw new Error(`研究池 sleeve=${newSleeve} 已满 (${sleeveCount}/${MAX_PER_SLEEVE}), 同 sleeve 自动加的票已无可踢, 请手动删除几只再试`);
      }
    }

    if (cur.length >= MAX_SIZE) {
      // 替换策略: 优先替换同 sleeve 的最旧一只
      //   同 sleeve 兜底策略: 长线/短线有 sleeve tag, 通用 add 没 sleeve 不参与自动替换
      //   避免误踢"用户手动加的重要股" — 自动替换只能踢自动加的 (addedBy 含 screener-)
      let candidate = null;
      if (newSleeve) {
        // 同 sleeve + 自动加的 (addedBy 以 screener- 开头) → 候选
        const sameKind = cur
          .filter(r => Array.isArray(r.tags) && r.tags.includes(newSleeve) && typeof r.addedBy === 'string' && r.addedBy.startsWith('screener-'))
          .sort((a, b) => (a.addedAt || 0) - (b.addedAt || 0));
        candidate = sameKind[0];
      }
      if (candidate) {
        // 替换: 删旧 + 写新
        await Core.Storage.remove(TABLE, candidate.code);
        const newRecord = {
          code, name, market: opts.market || _inferMarket(code),
          tags: Array.isArray(opts.tags) ? opts.tags : [],
          note: opts.note || '',
          addedAt: Date.now(),
          addedBy: opts.addedBy || 'manual',
          replacedFrom: candidate.code
        };
        await Core.Storage.put(TABLE, newRecord);
        return { added: true, existed: false, code, name, replaced: candidate.code, replacedSleeve: newSleeve };
      }
      throw new Error(`研究池已满 (${cur.length}/${MAX_SIZE}), 自动替换无候选 (同 sleeve 自动加的票已无可踢), 请手动删除几只再试`);
    }

    // 2) 已存在则更新 tags（幂等 + tag 合并，screener 导入时可能重复出现需合并）
    const exists = cur.find(r => r.code === code);
    if (exists) {
      let updated = false;
      if (Array.isArray(opts.tags) && opts.tags.length > 0) {
        const existingTags = new Set(exists.tags || []);
        opts.tags.forEach(t => existingTags.add(t));
        const mergedTags = [...existingTags];
        if (mergedTags.length !== (exists.tags || []).length) {
          await Core.Storage.put(TABLE, { ...exists, tags: mergedTags });
          updated = true;
        }
      }
      return { added: false, existed: true, code, name: exists.name || name, updated };
    }

    // 3) 写库
    const record = {
      code,
      name,
      market: opts.market || _inferMarket(code),
      tags: Array.isArray(opts.tags) ? opts.tags : [],
      note: opts.note || '',
      addedAt: Date.now(),
      addedBy: opts.addedBy || 'manual'
    };
    await Core.Storage.put(TABLE, record);
    return { added: true, existed: false, code, name };
  }

  /**
   * 移除
   * @param {string} code
   */
  async function remove(code) {
    if (!code) throw new Error('code 必填');
    const cur = await Core.Storage.all(TABLE);
    const target = cur.find(r => r.code === code);
    if (!target) return { removed: false, existed: false };
    await Core.Storage.remove(TABLE, code);
    return { removed: true, existed: true, code };
  }

  /**
   * 更新 (改名 / 加标签 / 备注)
   */
  async function update(code, patch) {
    if (!code) throw new Error('code 必填');
    const all = await Core.Storage.all(TABLE);
    const target = all.find(r => r.code === code);
    if (!target) throw new Error('研究池中不存在: ' + code);
    const next = { ...target, ...patch, code, updatedAt: Date.now() };
    await Core.Storage.put(TABLE, next);
    return next;
  }

  /**
   * 列出所有
   */
  async function list() {
    return (await Core.Storage.all(TABLE)) || [];
  }

  /**
   * 大小状态
   * @returns {{ count, limit, ready: boolean, missing: number }}
   */
  async function checkSize() {
    const list = (await Core.Storage.all(TABLE)) || [];
    return {
      count: list.length,
      limit: MAX_SIZE,
      ready: list.length >= MIN_SIZE,
      missing: Math.max(0, MIN_SIZE - list.length)
    };
  }

  /**
   * AI 选股边界过滤 (在已有 stock 数组里只保留池子里的票)
   * @param {Array} stocks - 全市场或预筛结果 (含 code 字段)
   * @returns {{ kept: Array, dropped: number, total: number, poolEmpty: boolean }}
   */
  async function filterByPool(stocks) {
    const pool = await list();
    const codes = new Set(pool.map(r => r.code));
    const filtered = (stocks || []).filter(s => codes.has(String(s.code || s['代码'] || '')));
    return {
      kept: filtered,
      dropped: (stocks || []).length - filtered.length,
      total: (stocks || []).length,
      poolEmpty: pool.length === 0,
      poolSize: pool.length,
      limit: MAX_SIZE
    };
  }

  /**
   * 从 watchlist 批量导入
   * @returns {{ imported: number, skipped: number, failed: number, message: string }}
   */
  async function importFromWatchlist() {
    const wl = (await Core.Storage.all('watchlist')) || [];
    if (wl.length === 0) {
      return { imported: 0, skipped: 0, failed: 0, message: '自选股为空, 无可导入' };
    }
    let imported = 0, skipped = 0, failed = 0;
    const errors = [];
    for (const w of wl) {
      try {
        const r = await add(w.code + (w.name ? ' ' + w.name : ''));
        if (r.added) imported++;
        else skipped++;
      } catch (e) {
        failed++;
        if (errors.length < 3) errors.push(e.message);
      }
    }
    const msg = (failed > 0 ? '失败: ' + errors.join(' / ') : '');
    return { imported, skipped, failed, message: msg };
  }

  /**
   * 清空 (危险操作, 需确认)
   */
  async function clearAll() {
    const all = await list();
    for (const r of all) {
      try { await remove(r.code); } catch (_) {}
    }
    return { cleared: all.length };
  }

  window.Core.ResearchPool = {
    MAX_SIZE,
    MIN_SIZE,
    add,
    remove,
    update,
    list,
    checkSize,
    filterByPool,
    importFromWatchlist,
    clearAll,
    _parseInput,
    _inferMarket
  };

  console.log('[ResearchPool] 本地研究池模块已就绪 (上限 ' + MAX_SIZE + ' 只)');
})();