/**
 * Core.Steward.Strategies — sleeve 下的子策略 (ST: sub-strategy 实验期机制)
 *
 * 设计:
 *   - 一个 sleeve (long/short) 下可以挂多条 sub-strategy, 各自有独立 rules 和实验期
 *   - 新 sub-strategy 默认带 experimentWeeks (默认 4 周), 实验期内仓位受 allocator 的
 *     experimentCap 限制 (默认 sleeve 仓位 × 0.30), 不会一上来就吃满仓
 *   - 实验期满由 tickExperiment 评估: 胜率 <35% → freeze, ≥55% → 转正 (experimentWeeks=0)
 *     中间地带 (35%~55%) 不动, 下次 tick 继续观察
 *   - suggest() 是纯函数: 从 lessons 里聚类 pattern, 给用户提建议, 但绝不自动写库
 *     (跟 Lessons.distill 一个思路 — AI 只出候选, 人拍板)
 *
 * 表: sub_strategies (Dexie v8)
 *   strategyId (PK) | sleeve | status | ts | name | desc | rules[] | experimentWeeks | createdAt
 *
 * rules 形态: [{ kind: 'screener'|'kb'|'llm', ref: string, weight: number }]
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;
  const Steward = window.Core.Steward = window.Core.Steward || {};

  const TABLE = 'sub_strategies';
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const DEFAULT_EXPERIMENT_WEEKS = 4;
  const FREEZE_WIN_RATE = 0.35;      // 胜率低于此 → 冻结
  const PROMOTE_WIN_RATE = 0.55;     // 胜率高于此 → 转正
  const SUGGEST_MIN_SAMPLES = 3;     // 同 pattern ≥3 笔才建议开子策略
  const VALID_KINDS = ['screener', 'kb', 'llm'];
  // KIMI-6 连亏熔断: 连续亏损 ≥ LOSS_STREAK_TRIP 笔 → freeze + 熔断 CIRCUIT_DAYS 天
  const LOSS_STREAK_TRIP = 3;
  const CIRCUIT_DAYS = 3;
  const CIRCUIT_MS = CIRCUIT_DAYS * 24 * 60 * 60 * 1000;

  /**
   * 列子策略
   * @param {{sleeve?: 'long'|'short', status?: 'active'|'frozen'}} [opts]
   * @returns {Promise<Array>}
   */
  async function list(opts = {}) {
    const all = (await Core.Storage.all(TABLE)) || [];
    let rows = all;
    if (opts.sleeve) rows = rows.filter(s => s && s.sleeve === opts.sleeve);
    if (opts.status) rows = rows.filter(s => s && s.status === opts.status);
    rows.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return rows;
  }

  /**
   * 取单条子策略
   * @param {string} strategyId
   * @returns {Promise<object|null>}
   */
  async function get(strategyId) {
    if (!strategyId) return null;
    const row = await Core.Storage.get(TABLE, String(strategyId));
    return row || null;
  }

  /**
   * 新建子策略 (strategyId 唯一, status='active')
   * @param {object} args
   * @param {string} args.strategyId
   * @param {'long'|'short'} args.sleeve
   * @param {string} args.name
   * @param {string} [args.desc]
   * @param {Array} args.rules - [{kind, ref, weight}]
   * @param {number} [args.experimentWeeks=4] - 0 表示直接正式生效
   * @returns {Promise<object>} 落库后的 Strategy
   */
  async function create({ strategyId, sleeve, name, desc, rules, experimentWeeks = DEFAULT_EXPERIMENT_WEEKS }) {
    if (!strategyId || String(strategyId).trim() === '') throw new Error('create: strategyId 必填');
    if (!['long', 'short'].includes(sleeve)) throw new Error('create: sleeve 仅 long/short, 给的是: ' + sleeve);
    if (!name || String(name).trim() === '') throw new Error('create: name 必填');

    const id = String(strategyId).trim();
    const dup = await get(id);
    if (dup) throw new Error(`create: strategyId 已存在 (${id}), 拒绝覆盖`);

    const normRules = _normRules(rules);
    if (normRules.length === 0) throw new Error('create: rules 不能为空 (至少一条 screener/kb/llm 规则)');

    const weeks = Number.isFinite(experimentWeeks) ? Math.max(0, Math.floor(experimentWeeks)) : DEFAULT_EXPERIMENT_WEEKS;
    const now = Date.now();
    const row = {
      strategyId: id,
      sleeve,
      name: String(name),
      desc: desc ? String(desc) : '',
      rules: normRules,
      experimentWeeks: weeks,
      status: 'active',
      createdAt: now,
      ts: now
    };
    await Core.Storage.put(TABLE, row);
    return row;
  }

  /**
   * 冻结 (status='frozen') — allocator 不再给它分配仓位
   * @param {string} strategyId
   * @returns {Promise<object>}
   */
  async function freeze(strategyId) {
    return await _setStatus(strategyId, 'frozen');
  }

  /**
   * 解冻 (status='active')
   * @param {string} strategyId
   * @returns {Promise<object>}
   */
  async function unfreeze(strategyId) {
    return await _setStatus(strategyId, 'active');
  }

  /**
   * 实验期到点评估 — 对所有 experimentWeeks>0 且 createdAt + weeks*7d ≤ now 的子策略:
   *   胜率 <35% → freeze; ≥55% → 转正 (experimentWeeks=0); 中间地带保持观察
   * @param {number|Date} [now] - 缺省取当前时间
   * @returns {Promise<{evaluated:number, promoted:number, frozen:number}>}
   */
  async function tickExperiment(now) {
    const t = now instanceof Date ? now.getTime() : (Number.isFinite(now) ? now : Date.now());
    const all = await list({});
    let evaluated = 0, promoted = 0, frozen = 0;

    // 逐条策略用 where 索引查 lessons (不再全表 toArray 内存过滤)

    for (const s of all) {
      if (!s || !Number.isFinite(s.experimentWeeks) || s.experimentWeeks <= 0) continue;
      const due = (Number(s.createdAt) || 0) + s.experimentWeeks * WEEK_MS;
      if (due > t) continue;                    // 实验期还没满
      evaluated++;

      // 用 strategy 索引查属于本策略的交易 (替代全表 toArray 内存过滤)
      const allMine = (await Core.Storage.where('steward_lessons', 'strategy', s.strategyId)) || [];
      const mine = allMine.filter(l => l && (Number(l.ts) || 0) >= (Number(s.createdAt) || 0));
      const stats = _stats(mine);

      if (stats.winRate < FREEZE_WIN_RATE) {
        await Core.Storage.put(TABLE, Object.assign({}, s, {
          status: 'frozen', ts: t,
          lastEval: { at: t, winRate: stats.winRate, samples: stats.samples, verdict: 'freeze' }
        }));
        frozen++;
      } else if (stats.winRate >= PROMOTE_WIN_RATE) {
        await Core.Storage.put(TABLE, Object.assign({}, s, {
          experimentWeeks: 0, status: 'active', ts: t,
          lastEval: { at: t, winRate: stats.winRate, samples: stats.samples, verdict: 'promote' }
        }));
        promoted++;
      } else {
        // 灰色地带: 只留痕, 不改状态, 下个 tick 继续观察
        await Core.Storage.put(TABLE, Object.assign({}, s, {
          lastEval: { at: t, winRate: stats.winRate, samples: stats.samples, verdict: 'observe' }
        }));
      }
    }
    return { evaluated, promoted, frozen };
  }

  /**
   * 从 lessons 聚类出候选子策略 (纯函数, 不写库 — 等用户拍板)
   * 规则: 同 pattern 累计 ≥3 笔 → 出一条 StrategyDraft
   * @param {{lessons: Array, sleeve?: 'long'|'short'}} args
   * @returns {Array} StrategyDraft[]
   */
  function suggest({ lessons, sleeve } = {}) {
    if (!Array.isArray(lessons) || lessons.length === 0) return [];
    const pool = sleeve ? lessons.filter(l => l && l.sleeve === sleeve) : lessons;

    const groups = {};
    for (const l of pool) {
      if (!l) continue;
      const pattern = String(l.pattern || 'default');
      const sl = (l.sleeve === 'short') ? 'short' : 'long';
      const k = `${sl}|${pattern}`;
      if (!groups[k]) groups[k] = { sleeve: sl, pattern, items: [] };
      groups[k].items.push(l);
    }

    const drafts = [];
    for (const g of Object.values(groups)) {
      if (g.items.length < SUGGEST_MIN_SAMPLES) continue;
      const stats = _stats(g.items);
      drafts.push({
        strategyId: `${g.sleeve}-auto-${_slug(g.pattern)}`,
        sleeve: g.sleeve,
        name: `${g.pattern} (自动聚类)`,
        desc: `${g.items.length} 笔 ${g.pattern} 交易, 胜率 ${(stats.winRate * 100).toFixed(1)}%, 平均盈亏 ${stats.avgPnl.toFixed(2)}`,
        rules: [
          { kind: 'screener', ref: `pattern:${g.pattern}`, weight: 0.6 },
          { kind: 'llm', ref: 'scan-market', weight: 0.4 }
        ],
        experimentWeeks: DEFAULT_EXPERIMENT_WEEKS,
        evidence: {
          samples: stats.samples,
          winRate: stats.winRate,
          avgPnl: +stats.avgPnl.toFixed(4),
          codes: Array.from(new Set(g.items.map(l => l.code).filter(Boolean))).slice(0, 10)
        }
      });
    }
    drafts.sort((a, b) => (b.evidence.winRate - a.evidence.winRate) || (b.evidence.samples - a.evidence.samples));
    return drafts;
  }

  /**
   * KIMI-6 连亏熔断检查 (收盘结算时对每支 active 子策略调用)
   * 规则: 近 N 笔 (默认 3 笔) 全亏损 → freeze + circuitUntil (3 天后到期)
   *   - 熔断期靠 kv 'steward_circuit_<strategyId>' 记录, 不直接改 experimentWeeks
   *   - 到期自动恢复: circuitUntil 已过 → 清熔断标记 + status=active (除非实验期评估先把它 freeze 了)
   *   - 已有 circuit 标记且未到期 → 维持冻结, 不重复记
   * @param {object} args
   * @param {string} args.strategyId
   * @param {Array} args.lessons - 该策略最近的 lessons (倒序/乱序均可, 内部按 ts 排)
   * @param {number|Date} [args.now]
   * @returns {Promise<{status, circuitUntil, reason?}>} status: 'active'|'frozen'|'already-frozen'
   */
  async function checkLossStreak({ strategyId, lessons, now }) {
    if (!strategyId) return { status: 'noop', reason: '缺 strategyId' };
    const s = await get(strategyId);
    if (!s) return { status: 'noop', reason: '策略不存在' };
    const t = now instanceof Date ? now.getTime() : (Number.isFinite(now) ? now : Date.now());

    const circuitKey = 'steward_circuit_' + strategyId;
    const circuit = (await Core.Storage.kvGet(circuitKey)) || null;
    // 熔断期内 → 维持冻结, 不重复记
    if (circuit && circuit.until > t) {
      if (s.status !== 'frozen') await Core.Storage.put(TABLE, Object.assign({}, s, { status: 'frozen', ts: t }));
      return { status: 'already-frozen', circuitUntil: circuit.until };
    }
    // 熔断已到期 → 清标记, 恢复 active (除非被实验期评估冻结过, 那交给 tickExperiment 管理)
    if (circuit && circuit.until <= t) {
      await Core.Storage.kvDelete(circuitKey);
      if (s.status === 'frozen') {
        await Core.Storage.put(TABLE, Object.assign({}, s, { status: 'active', ts: t }));
      }
      return { status: 'active', reason: '熔断期已过, 恢复' };
    }

    // 无熔断记录 → 看最近连亏
    const mine = _stats(_recentLosses(lessons, LOSS_STREAK_TRIP));
    if (mine.samples >= LOSS_STREAK_TRIP) {
      // 连续 LOSS_STREAK_TRIP 笔全亏 → 冻结 + 熔断期
      const until = t + CIRCUIT_MS;
      await Core.Storage.kvSet(circuitKey, { at: t, until, trips: (circuit && circuit.trips || 0) + 1 });
      await Core.Storage.put(TABLE, Object.assign({}, s, {
        status: 'frozen', ts: t,
        lastCircuit: { at: t, until, tripCount: (circuit && circuit.trips || 0) + 1 }
      }));
      return { status: 'frozen', circuitUntil: until, reason: '连亏 ' + LOSS_STREAK_TRIP + ' 笔' };
    }
    return { status: 'active', reason: '无连亏' };
  }

  /** 取最近 N 笔亏损 (倒序取 N 笔, 必须全亏才算 streak) */
  function _recentLosses(lessons, n) {
    const arr = (Array.isArray(lessons) ? lessons : []).filter(l => l && l.pnl !== undefined && l.pnl !== null);
    arr.sort((a, b) => (Number(b.ts) || 0) - (Number(a.ts) || 0));
    const last = arr.slice(0, n);
    const allLoss = last.length === n && last.every(l => (Number(l.pnl) || 0) < 0);
    return allLoss ? last : [];
  }

  // ====================== 内部 helpers ======================

  /** 改 status 并回写 ts */
  async function _setStatus(strategyId, status) {
    const row = await get(strategyId);
    if (!row) throw new Error(`找不到 sub-strategy: ${strategyId}`);
    const next = Object.assign({}, row, { status, ts: Date.now() });
    await Core.Storage.put(TABLE, next);
    return next;
  }

  /** rules 规范化 + 校验 kind */
  function _normRules(rules) {
    if (!Array.isArray(rules)) return [];
    return rules.filter(r => r && r.ref).map((r, i) => {
      if (!VALID_KINDS.includes(r.kind)) {
        throw new Error(`rules[${i}] kind 必须是 screener/kb/llm, 给的是: ${r.kind}`);
      }
      return {
        kind: r.kind,
        ref: String(r.ref),
        weight: Number.isFinite(r.weight) ? r.weight : 1
      };
    });
  }

  /** 一组 lessons 的胜率/平均盈亏 (纯函数) */
  function _stats(items) {
    const arr = Array.isArray(items) ? items : [];
    if (arr.length === 0) return { samples: 0, wins: 0, winRate: 0, avgPnl: 0, totalPnl: 0 };
    let wins = 0, total = 0;
    for (const l of arr) {
      const pnl = Number(l.pnl) || 0;
      if (pnl > 0) wins++;
      total += pnl;
    }
    return {
      samples: arr.length,
      wins,
      winRate: +(wins / arr.length).toFixed(4),
      avgPnl: total / arr.length,
      totalPnl: total
    };
  }

  /** pattern → 适合放进 strategyId 的 slug */
  function _slug(s) {
    return String(s || 'default').trim().toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'default';
  }

  // 暴露
  window.Core.Steward.Strategies = {
    list,
    get,
    create,
    freeze,
    unfreeze,
    tickExperiment,
    suggest,
    checkLossStreak,
    // 内部/常量 (测试可访问)
    _stats,
    _normRules,
    _slug,
    _recentLosses,
    TABLE,
    DEFAULT_EXPERIMENT_WEEKS,
    FREEZE_WIN_RATE,
    PROMOTE_WIN_RATE,
    SUGGEST_MIN_SAMPLES,
    LOSS_STREAK_TRIP,
    CIRCUIT_DAYS,
    CIRCUIT_MS
  };

  console.log('[Steward/Strategies] 子策略模块已就绪 (Dexie sub_strategies, 实验期机制)');
})();
