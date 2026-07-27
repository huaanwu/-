/**
 * Backtest - 策略回测
 * 简单策略(双均线/突破/海龟)在 Web Worker 中跑
 */
(function() {
  'use strict';

  const STRATEGIES = [
    { value: 'ma_cross', label: '双均线交叉', params: { fast: 5, slow: 20 } },
    { value: 'breakout', label: 'N日突破', params: { n: 20 } },
    { value: 'turtle', label: '海龟交易', params: { entry: 20, exit: 10 } }
  ];

  const Backtest = {

    async init() { this._renderForm(); },

    _renderForm() {
      const root = document.getElementById('backtestForm');
      if (!root) return;
      root.innerHTML = `
        <div class="form-row">
          <label>股票代码</label>
          <input type="text" id="btCode" placeholder="600519">
        </div>
        <div class="form-row">
          <label>策略</label>
          <select id="btStrategy">
            ${STRATEGIES.map(s => `<option value="${s.value}">${s.label}</option>`).join('')}
          </select>
        </div>
        <div class="form-row">
          <label>开始日期</label>
          <input type="date" id="btStart" value="${this._defaultStart()}">
        </div>
        <div class="form-row">
          <label>结束日期</label>
          <input type="date" id="btEnd" value="${this._defaultEnd()}">
        </div>
        <div class="form-row">
          <label>初始资金</label>
          <input type="number" id="btCapital" value="100000" step="10000">
        </div>
        <div class="form-row">
          <label>手续费</label>
          <input type="number" id="btFee" value="0.0003" step="0.0001">
          <span style="font-size:11px;color:var(--text-muted);">单边,默认万三</span>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          数据量较大,首次拉取可能需要 5-10 秒。回测在 Web Worker 中跑,不卡 UI。
        </div>
      `;
    },

    _defaultStart() {
      const d = new Date();
      d.setFullYear(d.getFullYear() - 1);
      return d.toISOString().slice(0, 10);
    },
    _defaultEnd() {
      return new Date().toISOString().slice(0, 10);
    },

    async run() {
      const resultEl = document.getElementById('backtestResult');
      const code = document.getElementById('btCode').value.trim();
      const strategy = document.getElementById('btStrategy').value;
      const start = document.getElementById('btStart').value;
      const end = document.getElementById('btEnd').value;
      const capital = parseFloat(document.getElementById('btCapital').value) || 100000;
      const fee = parseFloat(document.getElementById('btFee').value) || 0.0003;

      if (!code || !/^\d{6}$/.test(code)) { toastError('股票代码必须 6 位'); return; }

      resultEl.innerHTML = '<div class="loading">拉取历史数据 + 回测中...</div>';

      try {
        const startStr = start.replace(/-/g, '');
        const endStr = end.replace(/-/g, '');
        const kline = await Core.Data.getStockKLine(code, 'daily', startStr, endStr, 'qfq');
        if (!kline || kline.length < 30) {
          resultEl.innerHTML = '<div class="empty">数据不足(少于 30 根 K 线)</div>';
          return;
        }

        // 转纯数组
        const data = kline.map(d => ({
          date: d.日期,
          open: parseFloat(d.开盘),
          high: parseFloat(d.最高),
          low: parseFloat(d.最低),
          close: parseFloat(d.收盘)
        }));

        // 跑 Web Worker
        const strategyDef = STRATEGIES.find(s => s.value === strategy);
        const result = await this._runWorker({
          data,
          strategy,
          params: strategyDef.params,
          capital,
          fee
        });

        this._renderResult(code, strategyDef.label, result);
      } catch (e) {
        resultEl.innerHTML = `<div class="empty">回测失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    _runWorker({ data, strategy, params, capital, fee }) {
      return new Promise((resolve, reject) => {
        // Vite 打包会处理这个 import
        const worker = new Worker('/workers/backtest.worker.js', { type: 'module' });
        worker.onmessage = (e) => {
          worker.terminate();
          if (e.data.error) reject(new Error(e.data.error));
          else resolve(e.data);
        };
        worker.onerror = (e) => {
          worker.terminate();
          reject(new Error(e.message || 'Worker error'));
        };
        worker.postMessage({ data, strategy, params, capital, fee });
      });
    },

    _renderResult(code, strategyName, r) {
      const resultEl = document.getElementById('backtestResult');
      const sign = r.totalReturn >= 0 ? '+' : '';
      resultEl.innerHTML = `
        <div style="padding:16px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h3 style="margin:0;">${escapeHtml(code)} · ${escapeHtml(strategyName)}</h3>
            <span style="color:var(--text-muted);font-size:12px;">${r.startDate} ~ ${r.endDate}</span>
          </div>

          <div class="summary-cards" style="margin-bottom:16px;">
            <div class="summary-card">
              <div class="label">总收益</div>
              <div class="value ${r.totalReturn >= 0 ? 'up' : 'down'}">${sign}${(r.totalReturn * 100).toFixed(2)}%</div>
            </div>
            <div class="summary-card">
              <div class="label">年化</div>
              <div class="value ${r.annualReturn >= 0 ? 'up' : 'down'}">${sign}${(r.annualReturn * 100).toFixed(2)}%</div>
            </div>
            <div class="summary-card">
              <div class="label">最大回撤</div>
              <div class="value down">${(r.maxDrawdown * 100).toFixed(2)}%</div>
            </div>
            <div class="summary-card">
              <div class="label">夏普</div>
              <div class="value">${r.sharpe.toFixed(2)}</div>
            </div>
            <div class="summary-card">
              <div class="label">交易次数</div>
              <div class="value">${r.trades.length}</div>
            </div>
            <div class="summary-card">
              <div class="label">胜率</div>
              <div class="value">${(r.winRate * 100).toFixed(1)}%</div>
            </div>
          </div>

          <div id="btChart" style="width:100%;height:400px;background:var(--bg-base);border-radius:6px;"></div>

          ${r.trades.length > 0 ? `
            <h4 style="margin:16px 0 8px;">交易记录</h4>
            <table>
              <thead>
                <tr><th>买入日期</th><th>买入价</th><th>卖出日期</th><th>卖出价</th><th>收益率</th><th>持有天数</th></tr>
              </thead>
              <tbody>
                ${r.trades.map(t => `
                  <tr>
                    <td>${escapeHtml(t.buyDate)}</td>
                    <td>${t.buyPrice.toFixed(2)}</td>
                    <td>${escapeHtml(t.sellDate)}</td>
                    <td>${t.sellPrice.toFixed(2)}</td>
                    <td class="${t.return >= 0 ? 'up' : 'down'}">${(t.return * 100).toFixed(2)}%</td>
                    <td>${t.holdDays}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          ` : ''}
        </div>
      `;
      this._renderEquityChart(r.equityCurve, r.benchCurve);
    },

    _renderEquityChart(equity, bench) {
      const el = document.getElementById('btChart');
      if (!el || typeof echarts === 'undefined') return;
      const chart = echarts.init(el, 'dark');
      const dates = equity.map(p => p.date);
      const eqData = equity.map(p => p.value);
      const benchData = bench.map(p => p.value);

      chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: ['策略净值', '基准(买入持有)'], textStyle: { color: '#8b949e' } },
        xAxis: { type: 'category', data: dates, axisLabel: { color: '#8b949e' } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
        series: [
          {
            name: '策略净值', type: 'line', data: eqData, smooth: true, showSymbol: false,
            lineStyle: { color: '#f59e0b', width: 2 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.15)' }
          },
          {
            name: '基准(买入持有)', type: 'line', data: benchData, smooth: true, showSymbol: false,
            lineStyle: { color: '#8b949e', width: 1, type: 'dashed' }
          }
        ]
      });
    }
  };

  window.Backtest = Backtest;
  window._onShow_pageBacktest = function() {
    if (!document.getElementById('backtestForm').innerHTML) Backtest._renderForm();
  };
})();
