/**
 * Core.PreBacktest - AI 建议"回测前置" (Phase D2)
 *
 * 思路: AI 建议上桌前, 先用该标的近 2 年日 K 跑一个简单策略回测,
 *       给"历史有效/一般/无效"的参考徽章。按需触发 (用户点 📊 历史验证),
 *       不接任何自动流程。
 *
 * 策略映射 (拍脑袋, 够用即可):
 *   - 假设里出现"突破/放量/新高/趋势"等技术突破词 → breakout (N日突破)
 *   - 出现"业绩/拐点/估值/修复/基本面"            → ma_cross (双均线)
 *   - 其他 → ma_cross (默认; 双均线是最通用的趋势跟随, 泛化最好)
 *
 * verdict 判定 (拍脑袋阈值, 依据: 自用工具只要"别明显离谱"的参考):
 *   - sharpe < 0        → 历史无效     (风险调整后收益为负, 策略在该股历史上纯亏钱)
 *   - 0 ≤ sharpe < 0.5  → 历史表现一般 (A股日线简单策略年化 sharpe 0.5 已算"有点东西")
 *   - sharpe ≥ 0.5      → 历史有效
 *
 * 降级: K线拉取失败 / K线不足 / worker 异常 / 15s 超时 → 返回 null + console.warn,
 *       调用方显示"回测不可用", 不阻塞 AI 建议展示。
 */
(function() {
  'use strict';

  const SHARPE_INVALID = 0;          // 见头注释
  const SHARPE_GOOD = 0.5;           // 见头注释
  const MIN_BARS = 60;               // 少于 60 根日 K, 回测没有统计意义
  const WORKER_TIMEOUT_MS = 15000;   // worker 挂起保护
  const BACKTEST_YEARS = 2;          // 回测窗口: 近 2 年日 K
  const CAPITAL = 100000;            // 与 Backtest 页默认一致
  const FEE = 0.0003;                // 单边万三, 与 Backtest 页默认一致

  // 策略默认参数/标签 (与 Backtest 页 STRATEGIES 一致)
  const STRATEGY_PARAMS = {
    ma_cross: { fast: 5, slow: 20 },
    breakout: { n: 20 },
    turtle: { entry: 20, exit: 10 }
  };
  const STRATEGY_LABELS = { ma_cross: '双均线交叉', breakout: 'N日突破', turtle: '海龟交易' };

  // 转义: 优先 Core.Util.escapeHtml, vm 沙箱/兜底用本地实现
  function _esc(s) {
    if (typeof Core !== 'undefined' && Core.Util && Core.Util.escapeHtml) return Core.Util.escapeHtml(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /**
   * 假设文本 → 策略 (纯函数, 可 Node 测试)
   * @param {string} assumption - AI 建议的假设/理由文本
   * @returns {'ma_cross'|'breakout'}
   */
  function pickStrategy(assumption) {
    const a = String(assumption || '');
    if (/突破|放量|新高|趋势/.test(a)) return 'breakout';
    if (/业绩|拐点|估值|修复|基本面/.test(a)) return 'ma_cross';
    return 'ma_cross';  // 默认: 双均线泛化最好
  }

  /**
   * 读大盘状态机的 Sharpe 门槛 (下跌市 0.5 → 1.0); Regime 不可用/异常 → 回退 SHARPE_GOOD
   */
  function _gateSharpeGood() {
    try {
      if (typeof Core !== 'undefined' && Core.Regime && typeof Core.Regime.gateMultipliers === 'function') {
        const g = Core.Regime.gateMultipliers();
        if (g && typeof g.sharpeThreshold === 'number' && isFinite(g.sharpeThreshold) && g.sharpeThreshold > 0) {
          return g.sharpeThreshold;
        }
      }
    } catch (e) {
      console.warn('[PreBacktest] Regime gate 读取失败, 回退默认阈值:', e);
    }
    return SHARPE_GOOD;
  }

  /**
   * sharpe → verdict 三档判定 (纯函数, 阈值见头注释)
   * "历史有效"的阈值走大盘状态机 gate (下跌市提高), 常量 SHARPE_GOOD 仅作回退默认
   * @returns {'历史无效'|'历史表现一般'|'历史有效'|null}
   */
  function judgeVerdict(sharpe) {
    if (typeof sharpe !== 'number' || !isFinite(sharpe)) return null;
    if (sharpe < SHARPE_INVALID) return '历史无效';
    if (sharpe < _gateSharpeGood()) return '历史表现一般';
    return '历史有效';
  }

  /**
   * worker 原始返回 → 卡片展示字段 (纯函数)
   * 返回 { sharpe, maxDrawdown, annualReturn, winRate, trades, verdict }
   * trades 为成交笔数 (worker 返回的是交易数组, 这里取长度)
   */
  function formatResult(r) {
    const trades = Array.isArray(r && r.trades) ? r.trades.length : 0;
    const sharpe = (r && typeof r.sharpe === 'number') ? r.sharpe : NaN;
    return {
      sharpe,
      maxDrawdown: (r && typeof r.maxDrawdown === 'number') ? r.maxDrawdown : 0,
      annualReturn: (r && typeof r.annualReturn === 'number') ? r.annualReturn : 0,
      winRate: (r && typeof r.winRate === 'number') ? r.winRate : 0,
      trades,
      verdict: judgeVerdict(sharpe)
    };
  }

  /**
   * 结果徽章 HTML (纯函数; 全部数值/固定文案, 日期走转义)
   */
  function renderResultHtml(result) {
    if (!result) return renderUnavailableHtml();
    const v = result.verdict || '历史表现一般';
    const color = v === '历史无效' ? 'var(--down)' : (v === '历史有效' ? 'var(--up)' : 'var(--text-muted)');
    const icon = v === '历史无效' ? '⚠' : (v === '历史有效' ? '✓' : '•');
    const stratLabel = STRATEGY_LABELS[result.strategy] || result.strategy || '';
    const range = (result.startDate && result.endDate) ? ` ${_esc(result.startDate)} ~ ${_esc(result.endDate)}` : '';
    const sharpeTxt = isFinite(result.sharpe) ? result.sharpe.toFixed(2) : '?';
    // 大盘状态机: 下跌市门槛已提高的小字提示 (gate 读取失败静默忽略, 不影响徽章)
    let gateNote = '';
    try {
      if (typeof Core !== 'undefined' && Core.Regime && typeof Core.Regime.gateMultipliers === 'function') {
        const g = Core.Regime.gateMultipliers();
        if (g && g.state === 'bear') {
          gateNote = `<br><span style="color:var(--text-muted);font-size:11px;">📉 下跌市门槛已提高 (历史有效需 Sharpe ≥ ${_esc(g.sharpeThreshold)})</span>`;
        }
      }
    } catch (e) {
      console.warn('[PreBacktest] Regime 徽章读取失败:', e);
    }
    return `<div class="pb-result-inner" style="margin-top:8px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;line-height:1.6;border-left:3px solid ${color};">` +
      `<strong style="color:${color};">${icon} ${_esc(v)}</strong>` +
      `<span style="color:var(--text-muted);"> · 近2年 ${_esc(stratLabel)} 回测${range}</span><br>` +
      `Sharpe <b>${sharpeTxt}</b> · 最大回撤 <b>${(result.maxDrawdown * 100).toFixed(1)}%</b> · ` +
      `年化 <b>${(result.annualReturn * 100).toFixed(1)}%</b> · 胜率 ${(result.winRate * 100).toFixed(0)}% · ${result.trades} 笔` +
      gateNote +
      `</div>`;
  }

  /**
   * 降级文案 (纯函数): 回测不可用, 不阻塞建议展示
   */
  function renderUnavailableHtml() {
    return '<div class="pb-result-inner" style="margin-top:8px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;border-left:3px solid var(--text-muted);color:var(--text-muted);">' +
      '📊 历史验证不可用 (K线不足/数据源失败/回测超时), 不影响上方 AI 建议' +
      '</div>';
  }

  /**
   * 调回测 worker, 带超时保护 (仅浏览器; worker 协议见 workers/backtest.worker.js)
   * @param {object} payload - { data, strategy, params, capital, fee }
   * @param {number} [timeoutMs] - 超时毫秒 (测试可注入小值)
   */
  function _runWorker(payload, timeoutMs) {
    const timeout = timeoutMs ?? WORKER_TIMEOUT_MS;
    return new Promise((resolve, reject) => {
      const worker = new Worker('/workers/backtest.worker.js', { type: 'module' });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error(`回测超时 (${Math.round(timeout / 1000)}s)`));
      }, timeout);
      worker.onmessage = (e) => {
        clearTimeout(timer);
        worker.terminate();
        if (e.data && e.data.error) reject(new Error(e.data.error));
        else resolve(e.data);
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        worker.terminate();
        reject(new Error(e.message || 'Worker error'));
      };
      worker.postMessage(payload);
    });
  }

  /**
   * 主入口: 对一条 AI 建议跑"回测前置"
   * @param {object} opts - { code, assumption, timeoutMs(测试用) }
   * @returns {Promise<object|null>} formatResult 字段 + strategy/startDate/endDate; 任何失败 → null
   */
  async function runForPick({ code, assumption, timeoutMs } = {}) {
    try {
      if (typeof Worker === 'undefined') {
        console.warn('[PreBacktest] 非浏览器环境, 无 Worker');
        return null;
      }
      if (!code) {
        console.warn('[PreBacktest] 缺少 code');
        return null;
      }
      // 近 2 年日 K (只读 Core.Data, 缓存/限流由 data.js 管)
      const end = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - BACKTEST_YEARS);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');
      const kline = await Core.Data.getStockKLine(code, 'daily', fmt(start), fmt(end), 'qfq');
      if (!Array.isArray(kline) || kline.length < MIN_BARS) {
        console.warn(`[PreBacktest] ${code} K线不足 (${Array.isArray(kline) ? kline.length : 0} < ${MIN_BARS})`);
        return null;
      }
      // 转 worker 协议格式 (同 Backtest 页映射)
      const data = kline.map(d => ({
        date: d.日期,
        open: parseFloat(d.开盘),
        high: parseFloat(d.最高),
        low: parseFloat(d.最低),
        close: parseFloat(d.收盘)
      })).filter(d => isFinite(d.open) && isFinite(d.high) && isFinite(d.low) && isFinite(d.close));
      if (data.length < MIN_BARS) {
        console.warn(`[PreBacktest] ${code} 有效 K线不足 (${data.length} < ${MIN_BARS})`);
        return null;
      }

      const strategy = pickStrategy(assumption);
      const r = await _runWorker({
        data,
        strategy,
        params: STRATEGY_PARAMS[strategy],
        capital: CAPITAL,
        fee: FEE
      }, timeoutMs);

      return {
        ...formatResult(r),
        strategy,
        startDate: r.startDate || '',
        endDate: r.endDate || ''
      };
    } catch (e) {
      console.warn('[PreBacktest] 回测失败, 降级为不可用:', e);
      return null;
    }
  }

  window.Core = window.Core || {};
  window.Core.PreBacktest = {
    pickStrategy,
    judgeVerdict,
    formatResult,
    renderResultHtml,
    renderUnavailableHtml,
    runForPick,
    THRESHOLDS: { invalid: SHARPE_INVALID, good: SHARPE_GOOD },
    MIN_BARS
  };
})();
