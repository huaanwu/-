/**
 * Backtest Worker
 * 在 Worker 里跑回测,避免主线程卡顿
 *
 * 支持的策略:
 *   - ma_cross: 双均线交叉(fast 上穿 slow 买,下穿卖)
 *   - breakout: N日突破(收盘 > N日最高 买,收盘 < N日最低 卖)
 *   - turtle:   海龟(20日突破买,10日跌破卖)
 */

// ==================== 指标计算 ====================

function sma(arr, n) {
  const out = new Array(arr.length).fill(null);
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

// ==================== 策略 ====================

function strategyMaCross(data, params) {
  const { fast = 5, slow = 20 } = params;
  const closes = data.map(d => d.close);
  const maF = sma(closes, fast);
  const maS = sma(closes, slow);
  const signals = new Array(data.length).fill(0); // 1=买 -1=卖 0=无

  for (let i = 1; i < data.length; i++) {
    if (maF[i] == null || maS[i] == null || maF[i - 1] == null || maS[i - 1] == null) continue;
    // 上穿
    if (maF[i - 1] <= maS[i - 1] && maF[i] > maS[i]) signals[i] = 1;
    // 下穿
    else if (maF[i - 1] >= maS[i - 1] && maF[i] < maS[i]) signals[i] = -1;
  }
  return signals;
}

function strategyBreakout(data, params) {
  const { n = 20 } = params;
  const signals = new Array(data.length).fill(0);
  for (let i = n; i < data.length; i++) {
    const highN = Math.max(...data.slice(i - n, i).map(d => d.high));
    const lowN = Math.min(...data.slice(i - n, i).map(d => d.low));
    if (data[i].close > highN) signals[i] = 1;
    else if (data[i].close < lowN) signals[i] = -1;
  }
  return signals;
}

function strategyTurtle(data, params) {
  const { entry = 20, exit = 10 } = params;
  const signals = new Array(data.length).fill(0);
  for (let i = entry; i < data.length; i++) {
    const highEntry = Math.max(...data.slice(i - entry, i).map(d => d.high));
    const lowExit = Math.min(...data.slice(i - exit, i).map(d => d.low));
    if (data[i].close > highEntry) signals[i] = 1;
    else if (data[i].close < lowExit) signals[i] = -1;
  }
  return signals;
}

// ==================== 回测引擎 ====================

function backtest({ data, signals, capital, fee }) {
  // 空数据兜底
  if (!Array.isArray(data) || data.length === 0) {
    return { trades: [], equityCurve: [], benchCurve: [] };
  }
  let cash = capital;
  let position = 0;     // 持有股数
  let cost = 0;         // 持仓成本
  const trades = [];
  const equityCurve = [];

  for (let i = 0; i < data.length; i++) {
    const d = data[i];
    const sig = signals[i];

    if (sig === 1 && position === 0) {
      // 全仓买入
      const buyPrice = d.open * (1 + fee);  // 滑点 + 手续费
      const shares = Math.floor(cash / buyPrice / 100) * 100;  // A股 100 股一手
      if (shares > 0) {
        cost = shares * buyPrice;
        cash -= cost;
        position = shares;
        trades.push({ buyDate: d.date, buyPrice: d.open, shares, buyIdx: i });
      }
    } else if (sig === -1 && position > 0) {
      // 全仓卖出
      const sellPrice = d.open * (1 - fee);
      cash += position * sellPrice;
      const last = trades[trades.length - 1];
      last.sellDate = d.date;
      last.sellPrice = d.open;
      last.sellIdx = i;
      last.return = (sellPrice - last.buyPrice) / last.buyPrice;
      last.holdDays = i - last.buyIdx;
      position = 0;
      cost = 0;
    }

    // 记录当日净值
    const value = cash + position * d.close;
    equityCurve.push({ date: d.date, value });
  }

  // 强制平仓(还在持仓)
  if (position > 0) {
    cash += position * data[data.length - 1].close * (1 - fee);
    const last = trades[trades.length - 1];
    last.sellDate = data[data.length - 1].date;
    last.sellPrice = data[data.length - 1].close;
    last.return = (last.sellPrice - last.buyPrice) / last.buyPrice;
    last.holdDays = data.length - 1 - last.buyIdx;
  }

  // 基准:买入持有
  const benchShares = Math.floor(capital / data[0].open / 100) * 100;
  const benchCost = benchShares * data[0].open * (1 + fee);
  const benchCurve = data.map(d => ({
    date: d.date,
    value: benchCost + benchShares * (d.close - data[0].open)
  }));

  return { trades, equityCurve, benchCurve };
}

// ==================== 绩效指标 ====================

function calcMetrics(equityCurve, benchCurve, capital) {
  const eq = equityCurve.map(p => p.value);
  const bench = benchCurve.map(p => p.value);
  const n = eq.length;
  if (n === 0) {
    return { totalReturn: 0, annualReturn: 0, maxDrawdown: 0, sharpe: 0 };
  }

  const finalValue = eq[n - 1];
  const totalReturn = (finalValue - capital) / capital;

  // 年化(按 250 个交易日估算)
  const years = n / 250;
  const annualReturn = years > 0 ? (Math.pow(finalValue / capital, 1 / years) - 1) : totalReturn;

  // 最大回撤
  let peak = eq[0], maxDD = 0;
  for (const v of eq) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // 日收益
  const dailyReturns = [];
  for (let i = 1; i < n; i++) {
    dailyReturns.push((eq[i] - eq[i - 1]) / eq[i - 1]);
  }
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  const variance = dailyReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / dailyReturns.length;
  const std = Math.sqrt(variance) || 1e-10;
  const sharpe = (mean / std) * Math.sqrt(250);  // 年化

  return { totalReturn, annualReturn, maxDrawdown: maxDD, sharpe };
}

// ==================== 主入口 ====================

self.onmessage = (e) => {
  try {
    const { data, strategy, params, capital, fee } = e.data;

    let signals;
    if (strategy === 'ma_cross') signals = strategyMaCross(data, params);
    else if (strategy === 'breakout') signals = strategyBreakout(data, params);
    else if (strategy === 'turtle') signals = strategyTurtle(data, params);
    else throw new Error('未知策略: ' + strategy);

    const { trades, equityCurve, benchCurve } = backtest({ data, signals, capital, fee });
    const metrics = calcMetrics(equityCurve, benchCurve, capital);

    // 胜率
    const closed = trades.filter(t => t.sellDate);
    const winRate = closed.length > 0
      ? closed.filter(t => t.return > 0).length / closed.length
      : 0;

    self.postMessage({
      ...metrics,
      trades,
      equityCurve,
      benchCurve,
      winRate,
      startDate: data.length > 0 ? data[0].date : '',
      endDate: data.length > 0 ? data[data.length - 1].date : ''
    });
  } catch (err) {
    self.postMessage({ error: err.message });
  }
};
