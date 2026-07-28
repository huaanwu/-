/**
 * Core.Regime - 大盘状态机 (market regime gate)
 * 依赖: Core.Storage (kv) / Core.Data (getIndexKLine 多指数)
 *
 * 用途: 所有 AI 买入建议的前置 gate —— 先判断大盘状态, 下跌市自动提高门槛
 *   (回测 Sharpe 阈值 0.5 → 1.0, 建议仓位 ×0.5)。不做"禁止建卡", 只降仓位+提阈值。
 *
 * H3 升级:
 *   - 多指数共识: HS300 + CSI1000 + CSI2000 (Core.Constants.REGIME_INDEX_CODES)
 *     多数共识 (Core.Constants.MIN_INDEX_AGREE) 决定最终 state
 *     原: 仅沪深300 → 单点失灵 = 永远震荡市
 *   - ATR14 动态阈值带 (Core.Constants.ATR_PERIOD / ATR_MIN_BAND / ATR_MAX_BAND)
 *     替代固定 BAND=0.03。低波(≤1%) / 高波(≥6%) 自动夹, 适配 2024-09 后低波新结构
 *   - 失灵熔断: 连续失败 ≥ STALE_FAIL_THRESHOLD → 强制 range + stale:true
 *     修复 kvSet 静默失败 (L2 风险, 旧版 _mem 与 kv 不一致)
 *
 * 状态定义 (3 态):
 *   - 趋势市 bull : close > ma60 + band (即未跌破下沿) 且 ma60 上行 (今日 ≥ 10 日前, 走平算上行)
 *   - 下跌市 bear : close < ma60 * (1 - band) 且 ma60 严格下行
 *   - 震荡市 range: 其余 (价格在 ma60 ±band 内, 或 ma60 走平/方向不明)
 * 迟滞防横跳: 当前 bear → 需连续 EXIT_STREAK 日站上 ma60 才退出到 range (不直接进 bull)。
 *
 * 存储: kv 'market_regime' = { state, since, aboveStreak, lastDate, snapshot, stale, indices, staleFailures }
 *   lastDate 去重, 每日最多重算一次。
 *
 * 降级: K线 < MIN_BARS / 拉取失败 → 不计入共识该指数; 全失败 ≥ STALE_FAIL_THRESHOLD → 强制 range + stale:true
 */
(function() {
  'use strict';

  const KV_KEY = 'market_regime';

  // 多指数列表 (H3): 改用 Core.Constants 收口常量, 5 调用方可读 (UI 红条/量化参考)
  const CODES = window.Core.Constants.REGIME_INDEX_CODES;
  const MIN_INDEX_AGREE = window.Core.Constants.MIN_INDEX_AGREE;

  const STALE_FAIL_THRESHOLD = window.Core.Constants.STALE_FAIL_THRESHOLD;
  const ATR_PERIOD = window.Core.Constants.ATR_PERIOD;
  const ATR_MIN_BAND = window.Core.Constants.ATR_MIN_BAND;
  const ATR_MAX_BAND = window.Core.Constants.ATR_MAX_BAND;
  const FALLBACK_BAND = window.Core.Constants.REGIME_FALLBACK_BAND;

  const BARS = 120;             // 取近 120 根日K 参与计算
  const MIN_BARS = 70;          // 最少 70 根 (ma60 + 10 日斜率回看), 不足 → 该指数不计入
  const MA_PERIOD = 60;
  const SLOPE_LOOKBACK = 10;    // ma60 斜率: 今日 ma60 vs 10 个交易日前 ma60
  const EXIT_STREAK = 3;        // bear 迟滞: 连续 3 日站上 ma60 才退出

  // 三档 gate 参数 (消费点: prebacktest 阈值 / pending 仓位 / market-bar 徽章)
  const GATES = {
    bull:  { sharpeThreshold: 0.5, positionScale: 1.0, label: '趋势市',   badgeClass: 'regime-bull',  icon: '🐂' },
    range: { sharpeThreshold: 0.5, positionScale: 1.0, label: '震荡市',   badgeClass: 'regime-range', icon: '↔️' },
    bear:  { sharpeThreshold: 1.0, positionScale: 0.5, label: '下跌市 ⚠', badgeClass: 'regime-bear', icon: '🐻' }
  };

  let _mem = null;        // 内存缓存 (gateMultipliers 同步读)
  let _staleFails = 0;    // 连续失灵计数器 (修 L2: refresh 失败才递增; refresh 成功清零)

  function _todayStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function _avg(arr) {
    if (!arr.length) return NaN;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function _clamp(x, lo, hi) {
    return Math.min(Math.max(x, lo), hi);
  }

  function _defaultRec() {
    return {
      state: 'range', since: '', aboveMa60Streak: 0, lastDate: '',
      snapshot: null, stale: false, indices: {}, staleFailures: 0
    };
  }

  /**
   * 计算 ATR14 (近 14 日 trueRange 均值)
   * @param {number[]} closes 已升序排列的收盘价数组
   * @returns {number} ATR; 长度 < ATR_PERIOD → fallback NaN (调用方用 FALLBACK_BAND)
   */
  function _atr14(closes) {
    if (!Array.isArray(closes) || closes.length < ATR_PERIOD + 1) return NaN;
    const trs = [];
    // trueRange 近似 = |close[n] - close[n-1]| (单源 K 线无完整 high/low)
    for (let i = 1; i < closes.length; i++) {
      trs.push(Math.abs(closes[i] - closes[i - 1]));
    }
    const tail = trs.slice(-ATR_PERIOD);
    return tail.length ? _avg(tail) : NaN;
  }

  /**
   * 按 ATR 计算动态阈值带 (夹 ATR_MIN_BAND / ATR_MAX_BAND)
   * @returns {number} band ∈ [ATR_MIN_BAND, ATR_MAX_BAND], 数据不足时 fallback
   */
  function _computeBand(closes, lastClose) {
    if (!isFinite(lastClose) || lastClose <= 0) return FALLBACK_BAND;
    const atr = _atr14(closes);
    if (!isFinite(atr) || atr <= 0) return FALLBACK_BAND;
    return _clamp(atr / lastClose, ATR_MIN_BAND, ATR_MAX_BAND);
  }

  /**
   * 判定单个指数的状态 (纯函数, 测试可注入)
   * @param {{ close: number, ma60: number, ma60Prev: number|null,
   *           prevState?: string, aboveStreak?: number, band?: number }} input
   *        band 默认 FALLBACK_BAND (K线 <ATR_PERIOD 时由 _processIndex 传入)
   * @returns {{ state: 'bull'|'range'|'bear', aboveStreak: number }}
   */
  function _classifyPerIndex({ close, ma60, ma60Prev, prevState, aboveStreak, band } = {}) {
    close = parseFloat(close);
    ma60 = parseFloat(ma60);
    ma60Prev = (ma60Prev == null) ? null : parseFloat(ma60Prev);
    aboveStreak = parseInt(aboveStreak, 10) || 0;
    const b = isFinite(parseFloat(band)) && parseFloat(band) > 0 ? parseFloat(band) : FALLBACK_BAND;
    if (!isFinite(close) || !isFinite(ma60) || ma60 <= 0) {
      return { state: GATES[prevState] ? prevState : 'range', aboveStreak };
    }
    const above = close > ma60;
    const streak = above ? aboveStreak + 1 : 0;
    const maUp = ma60Prev != null && isFinite(ma60Prev) && ma60 >= ma60Prev;
    const maDown = ma60Prev != null && isFinite(ma60Prev) && ma60 < ma60Prev;

    if (prevState === 'bear') {
      if (streak >= EXIT_STREAK) return { state: 'range', aboveStreak: 0 };
      return { state: 'bear', aboveStreak: streak };
    }
    // 下跌市: 跌破 ma60 × (1 - band) 且 ma60 下行
    if (close < ma60 * (1 - b) && maDown) return { state: 'bear', aboveStreak: streak };
    // 趋势市: 站上 ma60 且 ma60 上行
    if (above && maUp) return { state: 'bull', aboveStreak: streak };
    return { state: 'range', aboveStreak: streak };
  }

  /**
   * 多指数共识 (H3): 多数指数 state 一致才算最终 state
   * @param {Array<{code, state, aboveStreak}>} perIndex
   * @returns {{ state, aboveStreak, agreeCount }}
   */
  function _consensus(perIndex) {
    const usable = perIndex.filter(x => GATES[x.state]);
    if (usable.length === 0) return { state: 'range', aboveStreak: 0, agreeCount: 0 };
    // 票数最多的 state 取胜
    const counts = { bull: 0, range: 0, bear: 0 };
    const streaks = { bull: [], range: [], bear: [] };
    for (const x of usable) {
      counts[x.state] = (counts[x.state] || 0) + 1;
      streaks[x.state].push(x.aboveStreak || 0);
    }
    const order = ['bull', 'bear', 'range'];    // bull/bear 优先于 range 打破平局 (range 是"无信号")
    let best = null;
    for (const s of order) {
      if (counts[s] >= MIN_INDEX_AGREE) {
        if (!best || counts[s] > counts[best]) best = s;
      }
    }
    if (!best) {
      // 没达共识门槛 → 默认 range (保守)
      best = 'range';
    }
    const agreeCount = counts[best];
    const aboveStreak = streaks[best].length ? Math.max(...streaks[best]) : 0;
    return { state: best, aboveStreak, agreeCount };
  }

  /**
   * 拉单只指数 K 线 → 处理 → 判 state
   * @returns {Promise<null|{code, state, aboveStreak, close, ma60, band, reason?}>}
   */
  async function _processIndex(code) {
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 300);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const kline = await window.Core.Data.getIndexKLine(code, 'daily', fmt(start), fmt(end), 'qfq');
      const bars = (Array.isArray(kline) ? kline : [])
        .map(d => ({ date: d.日期, close: parseFloat(d.收盘) }))
        .filter(b => isFinite(b.close) && b.close > 0)
        .slice(-BARS);
      if (bars.length < MIN_BARS) {
        return { code, state: null, aboveStreak: 0, close: NaN, ma60: NaN, band: FALLBACK_BAND, reason: `K线不足 ${bars.length}/${MIN_BARS}` };
      }
      const closes = bars.map(b => b.close);
      const close = closes[closes.length - 1];
      const ma60 = _avg(closes.slice(-MA_PERIOD));
      const ma60Prev = _avg(closes.slice(-MA_PERIOD - SLOPE_LOOKBACK, -SLOPE_LOOKBACK));
      const band = _computeBand(closes, close);
      const r = _classifyPerIndex({
        close, ma60, ma60Prev,
        prevState: _mem && _mem.state,
        aboveStreak: _mem && _mem.aboveMa60Streak,
        band
      });
      return { code, state: r.state, aboveStreak: r.aboveStreak, close, ma60, band };
    } catch (e) {
      console.warn(`[Regime] ${code} 处理失败:`, e.message || e);
      return { code, state: null, aboveStreak: 0, close: NaN, ma60: NaN, band: FALLBACK_BAND, reason: 'fetch失败' };
    }
  }

  /** 读 kv 状态 (失败/非法降级默认 range 记录) */
  async function _loadRec() {
    try {
      const rec = await window.Core.Storage.kvGet(KV_KEY);
      if (rec && GATES[rec.state]) {
        _mem = rec;
        if (typeof rec.staleFailures === 'number') _staleFails = rec.staleFailures;
        return rec;
      }
    } catch (e) {
      console.warn('[Regime] kv 读取失败, 用默认状态:', e);
    }
    if (!_mem) _mem = _defaultRec();
    return _mem;
  }

  /**
   * 读当前状态: 内存 → kv → 现算 (refresh)
   */
  async function get() {
    if (_mem) return _mem;
    const rec = await _loadRec();
    if (rec.lastDate) return rec;
    return await refresh();
  }

  const _subscribers = [];
  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    _subscribers.push(cb);
    return () => {
      const i = _subscribers.indexOf(cb);
      if (i >= 0) _subscribers.splice(i, 1);
    };
  }
  function _emit(oldState, newState, rec) {
    for (const cb of _subscribers) {
      try { cb({ oldState, newState, rec }); }
      catch (e) { console.warn('[Regime] 订阅回调失败:', e); }
    }
  }

  /**
   * 重算状态 (每日最多一次, lastDate 去重)
   * 多指数并行拉 → 各自 _classifyPerIndex → _consensus 取多数 → 写回 kv
   *
   * H3 失灵熔断:
   *   - refresh 完全失败 (全部失败 → perIndex 0 usable) → 不立刻熔断
   *   - 连续 STALE_FAIL_THRESHOLD 次失败 → 强制 range + stale:true (不再相信旧 state)
   *   - refresh 成功 → _staleFails = 0 (清零)
   */
  async function refresh() {
    const old = await _loadRec();
    const today = _todayStr();
    if (old.lastDate === today) return old;

    const perIndex = await Promise.all(CODES.map(c => _processIndex(c)));
    const usableCount = perIndex.filter(x => x && x.state && GATES[x.state]).length;

    // 全失败或部分失败: 不更新 _mem (但 _staleFails 累加)
    if (usableCount === 0) {
      _staleFails++;
      const shouldForceRange = _staleFails >= STALE_FAIL_THRESHOLD;
      const rec = shouldForceRange ? {
        state: 'range',
        since: old.since || today,
        aboveMa60Streak: 0,
        lastDate: today,
        snapshot: old.snapshot || null,
        stale: true,
        indices: Object.fromEntries(perIndex.map(x => [x.code, { reason: x.reason || '失败', state: null }])),
        staleFailures: _staleFails
      } : {
        ...old,
        staleFailures: _staleFails
      };
      // L2 修复: kvSet 失败抛错时, _mem 保留旧值 (不静默被新值覆盖)
      try {
        await window.Core.Storage.kvSet(KV_KEY, rec);
        _mem = rec;
      } catch (e) {
        console.warn('[Regime] kvSet 失败 (全失败路径), _mem 保持旧值:', e);
      }
      if (shouldForceRange && old.state !== rec.state) _emit(old.state, rec.state, rec);
      return _mem;
    }

    // 多数共识
    const { state, aboveStreak } = _consensus(perIndex);
    const indices = Object.fromEntries(perIndex.map(x => [x.code, {
      state: x.state,
      close: isFinite(x.close) ? +x.close.toFixed(2) : null,
      ma60: isFinite(x.ma60) ? +x.ma60.toFixed(2) : null,
      band: isFinite(x.band) ? +x.band.toFixed(4) : null,
      reason: x.reason || null
    }]));

    const rec = {
      state,
      since: state !== old.state ? today : (old.since || today),
      aboveMa60Streak: aboveStreak,
      lastDate: today,
      snapshot: (() => {
        const head = perIndex.find(x => x.code === CODES[0]) || perIndex.find(x => x.state);
        if (!head || !isFinite(head.close)) return old.snapshot || null;
        return {
          date: today,
          close: +head.close.toFixed(2),
          ma60: +head.ma60.toFixed(2),
          band: +head.band.toFixed(4)
        };
      })(),
      stale: false,
      indices,
      staleFailures: 0    // 成功路径重置
    };
    try {
      await window.Core.Storage.kvSet(KV_KEY, rec);
      _mem = rec;
    } catch (e) {
      // L2 修复: kvSet 失败时保留旧 _mem, 不让 _mem 和 kv 状态分裂
      console.warn('[Regime] kvSet 失败 (成功路径), _mem 保持旧值:', e);
      return old;
    }
    _staleFails = 0;     // refresh 成功 → 清零 (下次失灵重新计数)
    if (old.state !== rec.state) _emit(old.state, rec.state, rec);
    return rec;
  }

  /**
   * gate 参数 (同步, 读内存缓存; 失灵时 stale=true)
   * H3: 新增 stale / staleFailures / indices 字段, UI 红条 / 5 调用方 prompt 消费
   */
  function gateMultipliers() {
    const state = (_mem && GATES[_mem.state]) ? _mem.state : 'range';
    const stale = !!(_mem && _mem.stale);
    return {
      state, ...GATES[state],
      stale,
      staleFailures: (_mem && typeof _mem.staleFailures === 'number') ? _mem.staleFailures : _staleFails,
      indices: (_mem && _mem.indices) ? _mem.indices : {}
    };
  }

  /** 测试专用: 重置内部状态 (供 vm sandbox 在多组测试间清理) */
  function _resetForTest() {
    _mem = null;
    _staleFails = 0;
  }

  window.Core = window.Core || {};
  window.Core.Regime = {
    KV_KEY, GATES, CODES,
    get,
    refresh,
    _classifyPerIndex,
    _atr14,
    _computeBand,
    _consensus,
    _processIndex,
    gateMultipliers,
    subscribe,
    _resetForTest
  };
})();
