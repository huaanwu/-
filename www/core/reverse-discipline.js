/**
 * Core.ReverseDiscipline — 反向策略入场前 4 闸预检 (V13 拍板 / 偏误防御第一层)
 *
 * 用法:
 *   const r = Core.ReverseDiscipline.preBuyCheck({ symbol, sector, stock, ... });
 *   if (r.blocks.length) → 拒绝 (4 闸未过)
 *   else if (r.warns.length) → 警告 (但允许你拍板)
 *   else → 通过
 *
 * 设计原则:
 *   - 纯函数: 输入决定输出, 不读 DOM/不调 API (单元测试可跑)
 *   - caller 注入数据 (sector / stock / currentProxyAllocation / trapLockedSymbols)
 *   - 不依赖外部模块: AI 推倌时跑 / 你拍板买时跑 / 周末复盘跑 同一条路径
 *
 * V13 拍板对齐:
 *   - code-level 偏误防御 (位置), 此为第一层
 *   - 仓位: 10% 默认上限, 20% 绝对上限 (超则 block)
 *   - 替身层累计 ≤ 30% (超则 warn)
 *
 * 反向策略 7 铁律 → 此 4 闸:
 *   block 1 → 规则 1 (板块封板率连续 2 日 ≥ 60%)
 *   block 2 → 规则 2 (PB 分位 ≤ 板块中位 - 20%)
 *   block 3 → 规则 6 (龙虎榜含量化专用席位)
 *   block 4 → 规则 3 衍生 (是板块龙头本身则 block,接替身不接龙头)
 *   warn 1  → 单票仓位超 10% (代码锁上限, V13 拍板)
 *   warn 2  → 替身层累计超 30%
 *   warn 3  → 陷阱池 24h 锁定中
 */
(function () {
  'use strict';

  window.Core = window.Core || {};

  const POSITION_CAP_REVERSE = 0.10;       // 单票 10% 上限 (V13 拍板)
  const POSITION_MAX_OVERRIDE = 0.20;     // 例外上限 20% (超则 block)
  const PROXY_SLEEVE_CAP = 0.30;          // 替身层累计 30% 警戒

  const BLOCK_LABELS = {
    'block-1-sector-weak': '板块封板率连续 2 日 < 60% (规则 1)',
    'block-2-pb-high': 'PB 分位未达 ≤ 板块中位 - 20% (规则 2)',
    'block-3-quant-seat': '龙虎榜前 5 含量化席位 (规则 6)',
    'block-4-is-leader': '标的是板块龙头本身 (规则 3: 不接龙头)',
    'block-position-over-20pct': '单票仓位超 20% 绝对上限',
    'no-symbol': '缺少股票代码',
    'no-data': '缺少板块或股票数据',
    'invalid-shares-or-price': '下单股数或价格无效'
  };

  const WARN_LABELS = {
    'warn-1-position-over-10pct': '单票仓位超 10% (10% 是反向策略默认上限)',
    'warn-2-proxy-sleeve-over-30pct': '替身层累计占比超 30%',
    'warn-3-trap-locked': '该标的在陷阱池 24h 锁定中'
  };

  /**
   * 4 闸预检 (block 1-4 + warn 1-3)
   * @param {object} opt
   * @param {string} opt.symbol - 6 位股票代码
   * @param {object} opt.sector - 板块信息
   * @param {number} opt.sector.limitUpRate_2d - 板块今日封板率 (0-1, 通常 0.01-0.15)
   * @param {boolean} opt.sector.active2d - 是否连续 2 日封板率 ≥ 0.6
   * @param {string} opt.sector.name - 板块名 (调试用)
   * @param {object} opt.stock - 个股信息
   * @param {number} opt.stock.pbPercentile - 个股 PB 分位 (0-100)
   * @param {number} opt.stock.sectorPbMedian - 板块 PB 中位分位 (0-100)
   * @param {boolean} opt.stock.isSectorLeader - 是否板块龙头
   * @param {boolean} opt.stock.hasQuantSeat - 龙虎榜前 5 含量化席位
   * @param {string} opt.stock.name - 股票名
   * @param {number} [opt.shares] - 拟买入股数 (>=100 整手, 0 跳过仓位检查)
   * @param {number} [opt.price] - 当前价格
   * @param {number} [opt.account] - 可用模拟资金
   * @param {number} [opt.currentProxyAllocation] - 替身层当前累计占比 0-1
   * @param {string[]} [opt.trapLockedSymbols] - 陷阱池锁定的代码列表
   * @returns {{ blocks: string[], warns: string[], reason: string, ok: boolean, positionRatio: number|null }}
   */
  function preBuyCheck(opt) {
    const blocks = [];
    const warns = [];
    const symbol = opt && opt.symbol;
    const sector = opt && opt.sector;
    const stock = opt && opt.stock;

    if (!symbol) {
      return { blocks: ['no-symbol'], warns: [], reason: '缺少股票代码', ok: false, positionRatio: null };
    }
    if (!sector || !stock) {
      return { blocks: ['no-data'], warns: [], reason: '缺少板块或股票数据', ok: false, positionRatio: null };
    }

    // block 1: 板块封板率 ≥ 0.03 (规则 1, A股 sector 50 只左右, 1-2 只涨停 ≈ 2-4%, 3% 算活跃)
    //   v0.2.1-P3 阈值修正: 之前 0.6 跟实际封板率量级不匹配 (60% 涨停率 = 30/50, 不可能)
    //   上游 ScreenerReverse 现在用 sectorStocks 里 changePct>=9.5 占比实算
    if (!sector.active2d || (typeof sector.limitUpRate_2d === 'number' && sector.limitUpRate_2d < 0.03)) {
      blocks.push('block-1-sector-weak');
    }

    // block 2: PB 分位 ≤ 板块中位数 - 20% (规则 2)
    if (typeof stock.pbPercentile === 'number' && typeof stock.sectorPbMedian === 'number') {
      const pbGap = (stock.sectorPbMedian - stock.pbPercentile);  // 单位: 百分点
      if (pbGap < 20) {
        blocks.push('block-2-pb-high');
      }
    } else {
      blocks.push('block-2-pb-high');  // 数据缺失保守 block
    }

    // block 3: 龙虎榜含量化席位 (规则 6)
    if (stock.hasQuantSeat === true) {
      blocks.push('block-3-quant-seat');
    }

    // block 4: 是板块龙头本身 (规则 3 衍生)
    if (stock.isSectorLeader === true) {
      blocks.push('block-4-is-leader');
    }

    // 仓位相关 block / warn
    let positionRatio = null;
    const hasShares = opt.shares && Number.isFinite(opt.shares) && opt.shares > 0;
    const hasPrice = opt.price && Number.isFinite(opt.price) && opt.price > 0;
    const hasAccount = opt.account && Number.isFinite(opt.account) && opt.account > 0;

    if (hasShares && hasPrice && hasAccount) {
      if (opt.shares < 100 || opt.shares % 100 !== 0) {
        blocks.push('invalid-shares-or-price');
      } else {
        positionRatio = (opt.shares * opt.price) / opt.account;
        if (positionRatio > POSITION_MAX_OVERRIDE) {
          blocks.push('block-position-over-20pct');
        } else if (positionRatio > POSITION_CAP_REVERSE) {
          warns.push('warn-1-position-over-10pct');
        }

        // warn 2: 替身层累计超 30%
        if (typeof opt.currentProxyAllocation === 'number' && opt.currentProxyAllocation + positionRatio > PROXY_SLEEVE_CAP + 1e-9) {
          warns.push('warn-2-proxy-sleeve-over-30pct');
        }
      }
    } else if (hasShares && (!hasPrice || !hasAccount)) {
      blocks.push('invalid-shares-or-price');
    }

    // warn 3: 陷阱池锁定
    if (Array.isArray(opt.trapLockedSymbols) && opt.trapLockedSymbols.includes(symbol)) {
      warns.push('warn-3-trap-locked');
    }

    const ok = blocks.length === 0;
    let reason = '';
    if (!ok) {
      const labels = blocks.map(b => BLOCK_LABELS[b] || b);
      reason = '4 闸未过: ' + labels.join('; ');
    } else if (warns.length) {
      const labels = warns.map(w => WARN_LABELS[w] || w);
      reason = '通过但有警告: ' + labels.join('; ');
    } else {
      reason = '通过 4 闸';
    }

    return { blocks, warns, reason, ok, positionRatio };
  }

  /** 用 code → 自然语言 */
  function describe(code) {
    return BLOCK_LABELS[code] || WARN_LABELS[code] || code;
  }

  /** 闸常量导出 */
  const CAPS = {
    POSITION_CAP_REVERSE,
    POSITION_MAX_OVERRIDE,
    PROXY_SLEEVE_CAP
  };

  // 暴露 (inline 大字面量, 兼容测试正则 window.Core.X = ... { )
  window.Core.ReverseDiscipline = {
    VERSION: 'v0.2.0-P3',
    CAPS,
    BLOCK_LABELS,
    WARN_LABELS,
    preBuyCheck,
    describe
  };
})();
