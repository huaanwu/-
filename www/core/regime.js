/**
 * Core.Regime - 大盘状态机 (market regime gate)
 * 依赖: Core.Storage (kv) / Core.Data (沪深300 日K)
 *
 * 用途: 所有 AI 买入建议的前置 gate —— 先判断大盘状态, 下跌市自动提高门槛
 *   (回测 Sharpe 阈值 0.5 → 1.0, 建议仓位 ×0.5)。不做"禁止建卡", 只降仓位+提阈值。
 *
 * 状态定义 (3 态, 基于沪深300 日K, MA60 + 斜率):
 *   - 趋势市 bull : 收盘 > MA60 且 MA60 上行 (今日 MA60 ≥ 10 个交易日前 MA60, 走平算上行)
 *   - 下跌市 bear : 收盘 < MA60 × 0.97 (跌破 3%) 且 MA60 严格下行
 *   - 震荡市 range: 其余 (价格在 MA60 ±3% 内, 或 MA60 走平/方向不明)
 * 迟滞防横跳: 当前状态是 bear 时, 需"收盘价重新站上 MA60 连续 3 个交易日"
 *   才退出 (退到 range, 不直接进 bull)。
 *
 * 存储: kv 'market_regime' = { state, since, aboveMa60Streak, lastDate, snapshot }
 *   lastDate 去重, 每日最多重算一次, 成本可忽略。
 *
 * 降级: K线 < MIN_BARS 根或拉取失败 → 保持旧状态 + console.warn, 返回旧值。
 *   Regime 整体不可用时, gateMultipliers() 回退 range 档 (= 旧行为: 阈值 0.5 / 仓位 ×1)。
 *
 * 备注: 市场宽度 (涨跌家数) 确认票未实现 —— data.js / market.js 没有现成数据,
 *   按设计约定不接未验证的新接口。
 */
(function() {
  'use strict';

  const KV_KEY = 'market_regime';
  const INDEX_CODE = 'sh000300';  // 沪深300; 与 market.js INDEX_MAP / getIndexSpotTencent 用法一致 (腾讯源认 sh 前缀)
  const BARS = 120;               // 取近 120 根日K 参与计算
  const MIN_BARS = 70;            // 最少 70 根 (MA60 + 10 日斜率回看), 不足则保持旧状态
  const MA_PERIOD = 60;
  const SLOPE_LOOKBACK = 10;      // MA60 斜率: 今日 MA60 vs 10 个交易日前 MA60
  const BAND = 0.03;              // 跌破 MA60 × (1-3%) 才算"跌破"
  const EXIT_STREAK = 3;          // bear 迟滞: 连续 3 日站上 MA60 才退出

  // 三档 gate 参数 (消费点: prebacktest 阈值 / pending 仓位 / market-bar 徽章)
  const GATES = {
    bull:  { sharpeThreshold: 0.5, positionScale: 1.0, label: '趋势市',   badgeClass: 'regime-bull',  icon: '🐂' },
    range: { sharpeThreshold: 0.5, positionScale: 1.0, label: '震荡市',   badgeClass: 'regime-range', icon: '↔️' },
    bear:  { sharpeThreshold: 1.0, positionScale: 0.5, label: '下跌市 ⚠', badgeClass: 'regime-bear', icon: '🐻' }
  };

  let _mem = null;  // 内存缓存 (gateMultipliers 是同步函数, 只能读内存; refresh/get 负责填充)

  // 本地日期串 (kv lastDate 去重用, 不用 UTC)
  function _todayStr(d = new Date()) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function _avg(arr) {
    if (!arr.length) return NaN;
    return arr.reduce((s, v) => s + v, 0) / arr.length;
  }

  function _defaultRec() {
    return { state: 'range', since: '', aboveMa60Streak: 0, lastDate: '', snapshot: null };
  }

  /**
   * 全部判定逻辑集中在这个纯函数 (Node 可测)
   * @param {{ close: number, ma60: number, ma60Prev: number|null,
   *           prevState?: string, aboveStreak?: number }} input
   *        ma60Prev: 10 个交易日前的 MA60 (null = 斜率未知, 不上 bull 也不下 bear)
   * @returns {{ state: 'bull'|'range'|'bear', aboveStreak: number }}
   */
  function _classify({ close, ma60, ma60Prev, prevState, aboveStreak } = {}) {
    close = parseFloat(close);
    ma60 = parseFloat(ma60);
    ma60Prev = (ma60Prev == null) ? null : parseFloat(ma60Prev);
    aboveStreak = parseInt(aboveStreak, 10) || 0;
    if (!isFinite(close) || !isFinite(ma60) || ma60 <= 0) {
      // 输入非法 → 不改状态
      return { state: GATES[prevState] ? prevState : 'range', aboveStreak };
    }
    const above = close > ma60;
    const streak = above ? aboveStreak + 1 : 0;
    const maUp = ma60Prev != null && isFinite(ma60Prev) && ma60 >= ma60Prev;   // 上行 (≥, 走平算上行)
    const maDown = ma60Prev != null && isFinite(ma60Prev) && ma60 < ma60Prev;  // 严格下行

    // bear 迟滞: 连续 EXIT_STREAK 日收盘重新站上 MA60 才退出到 range (不直接进 bull)
    if (prevState === 'bear') {
      if (streak >= EXIT_STREAK) return { state: 'range', aboveStreak: 0 };
      return { state: 'bear', aboveStreak: streak };
    }
    // 下跌市: 跌破 MA60 × (1-BAND) 且 MA60 下行
    if (close < ma60 * (1 - BAND) && maDown) return { state: 'bear', aboveStreak: streak };
    // 趋势市: 站上 MA60 且 MA60 上行
    if (above && maUp) return { state: 'bull', aboveStreak: streak };
    // 其余: 震荡市
    return { state: 'range', aboveStreak: streak };
  }

  /** 读 kv 状态 (失败/非法降级默认 range 记录, 不抛) */
  async function _loadRec() {
    try {
      const rec = await window.Core.Storage.kvGet(KV_KEY);
      if (rec && GATES[rec.state]) {
        _mem = rec;
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
   * @returns {Promise<{state, since, aboveMa60Streak, lastDate, snapshot}>}
   */
  async function get() {
    if (_mem) return _mem;
    const rec = await _loadRec();
    if (rec.lastDate) return rec;  // kv 里有历史记录, 直接用 (当日是否重算交给 refresh)
    return await refresh();        // 无任何记录 → 现算 (失败时 refresh 内部保持默认)
  }

  // ========== 订阅器 (Phase B-2: regime → alerts 通知) ==========
  // refresh 每次发现 state 变化 (oldState !== newState) 触发回调, 通知上层写 alerts / 弹通知
  const _subscribers = [];
  function subscribe(cb) {
    if (typeof cb !== 'function') return () => {};
    _subscribers.push(cb);
    return () => {                                  // 返回 unsubscribe
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
   * 重算状态 (每日最多一次, lastDate 去重; app.js init 异步调用)
   * 拉沪深300 近 120 根日K → MA60/斜率/连续站上计数 → _classify 迁移 → 写回 kv
   * 失败 (拉取异常 / K线 < MIN_BARS) → 保持旧状态 + console.warn, 返回旧值
   */
  async function refresh() {
    const old = await _loadRec();
    const today = _todayStr();
    if (old.lastDate === today) return old;  // 每日最多重算一次

    let kline;
    try {
      const end = new Date();
      const start = new Date();
      start.setDate(start.getDate() - 300);  // 300 自然日 ≈ 200 交易日, 切尾部 120 根足够
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      kline = await window.Core.Data.getStockKLine(INDEX_CODE, 'daily', fmt(start), fmt(end), 'qfq');
    } catch (e) {
      console.warn('[Regime] 沪深300 K线拉取失败, 保持旧状态:', e);
      return old;
    }

    const bars = (Array.isArray(kline) ? kline : [])
      .map(d => ({ date: d.日期, close: parseFloat(d.收盘) }))
      .filter(b => isFinite(b.close) && b.close > 0)
      .slice(-BARS);
    if (bars.length < MIN_BARS) {
      console.warn(`[Regime] 沪深300 有效K线不足 (${bars.length} < ${MIN_BARS}), 保持旧状态`);
      return old;
    }

    const closes = bars.map(b => b.close);
    const close = closes[closes.length - 1];
    const ma60 = _avg(closes.slice(-MA_PERIOD));
    const ma60Prev = _avg(closes.slice(-MA_PERIOD - SLOPE_LOOKBACK, -SLOPE_LOOKBACK));
    const { state, aboveStreak } = _classify({
      close, ma60, ma60Prev,
      prevState: old.state,
      aboveStreak: old.aboveMa60Streak
    });

    const rec = {
      state,
      since: state !== old.state ? today : (old.since || today),
      aboveMa60Streak: aboveStreak,
      lastDate: today,
      snapshot: {
        date: String(bars[bars.length - 1].date || ''),
        close,
        ma60: +ma60.toFixed(2),
        ma60Prev: +ma60Prev.toFixed(2)
      }
    };
    try {
      await window.Core.Storage.kvSet(KV_KEY, rec);
    } catch (e) {
      console.warn('[Regime] 状态写回 kv 失败:', e);
    }
    _mem = rec;
    // Phase B-2: 状态切换 → 通知订阅者 (alerts.js 监听写规则/弹通知)
    if (old.state !== rec.state) _emit(old.state, rec.state, rec);
    return rec;
  }

  /**
   * gate 参数 (同步, 读内存缓存; 未加载/异常时回退 range 档 = 旧行为)
   * @returns {{ state: string, sharpeThreshold: number, positionScale: number,
   *             label: string, badgeClass: string, icon: string }}
   */
  function gateMultipliers() {
    const state = (_mem && GATES[_mem.state]) ? _mem.state : 'range';
    return { state, ...GATES[state] };
  }

  window.Core = window.Core || {};
  window.Core.Regime = {
    KV_KEY, GATES,
    get,
    refresh,
    _classify,
    gateMultipliers,
    subscribe                  // Phase B-2: alerts.js 订阅状态切换
  };
})();
