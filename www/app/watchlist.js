/**
 * Watchlist - 行情看板
 * 自选股 + 实时行情 + K线
 */
(function() {
  'use strict';

  const KLINE_PERIODS = [
    { value: 'daily', label: '日K' },
    { value: 'weekly', label: '周K' },
    { value: 'monthly', label: '月K' }
  ];

  let _klineChart = null;
  let _currentKLineCode = null;

  const Watchlist = {

    async init() {
      // 第一次进入时渲染
      await this.render();
    },

    async render() {
      const list = await Core.Storage.all('watchlist');
      const summaryEl = document.getElementById('watchlistSummary');
      const tableEl = document.getElementById('watchlistTable');

      if (!list || list.length === 0) {
        summaryEl.innerHTML = '';
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">📊</div>
            <div>还没有自选股</div>
            <div style="margin-top:8px;font-size:12px;">点击右上角"添加"开始</div>
          </div>
        `;
        return;
      }

      // 顶部 summary
      summaryEl.innerHTML = `
        <div class="summary-card">
          <div class="label">自选数</div>
          <div class="value">${list.length}</div>
        </div>
        <div class="summary-card">
          <div class="label">市场</div>
          <div class="value" id="wlMarketStatus">-</div>
        </div>
        <div class="summary-card">
          <div class="label">最后更新</div>
          <div class="value" style="font-size:14px;" id="wlUpdateTime">-</div>
        </div>
      `;

      // 拉行情
      tableEl.innerHTML = '<div class="loading">加载行情...</div>';
      let spot = [];
      try {
        spot = await Core.Data.getStockSpot();
      } catch (e) {
        tableEl.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div>数据加载失败: ${escapeHtml(e.message)}<br><br>请检查 AKShare 代理是否运行</div>`;
        return;
      }
      // 建索引
      const spotMap = {};
      spot.forEach(s => { spotMap[s.代码] = s; });

      // 渲染表格
      const rows = list.map(item => {
        const s = spotMap[item.code];
        if (!s) {
          return `<tr>
            <td><span class="code">${escapeHtml(item.code)}</span></td>
            <td>${escapeHtml(item.name || '-')}</td>
            <td colspan="5" style="color:var(--text-muted);">无行情</td>
            <td><button class="btn btn-sm" onclick="Watchlist.remove('${escapeHtml(item.code)}')">✕</button></td>
          </tr>`;
        }
        const price = parseFloat(s.最新价);
        const changePct = parseFloat(s.涨跌幅) / 100;
        return `<tr style="cursor:pointer;" onclick="Watchlist.showKLine('${escapeHtml(item.code)}','${escapeHtml(item.name || s.名称)}')">
          <td><span class="code">${escapeHtml(item.code)}</span></td>
          <td>${escapeHtml(item.name || s.名称)}</td>
          <td>${fmtNum(price, 2)}</td>
          <td class="${pctClass(changePct)}">${fmtPct(changePct)}</td>
          <td class="${pctClass(changePct)}">${s.涨跌额 ? fmtNum(parseFloat(s.涨跌额), 2) : '<span style="color:var(--text-muted);" title="' + escapeHtml('该股今日停牌/无成交, 涨跌额/成交量/换手率无数据') + '">停牌</span>'}</td>
          <td>${s.成交量 || '<span style="color:var(--text-muted);" title="' + escapeHtml('该股今日停牌/无成交, 涨跌额/成交量/换手率无数据') + '">停牌</span>'}</td>
          <td>${s.换手率 ? parseFloat(s.换手率).toFixed(2) + '%' : '<span style="color:var(--text-muted);" title="' + escapeHtml('该股今日停牌/无成交, 涨跌额/成交量/换手率无数据') + '">停牌</span>'}</td>
          <td><button class="btn btn-sm" title="AI 简评" onclick="event.stopPropagation();StockAdvisor.show('${escapeHtml(item.code)}','${escapeHtml(item.name || s.名称 || '')}')">💡</button> <button class="btn btn-sm" onclick="event.stopPropagation();Watchlist.remove('${escapeHtml(item.code)}')">✕</button></td>
        </tr>`;
      }).join('');

      tableEl.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>代码</th><th>名称</th><th>现价</th><th>涨跌幅</th>
              <th>涨跌额</th><th>成交量</th><th>换手率</th><th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;

      document.getElementById('wlMarketStatus').textContent = Core.State.get('marketOpen') ? '开盘' : '休市';
      document.getElementById('wlUpdateTime').textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    },

    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Watchlist.closeModal()">
          <div class="modal">
            <h3>添加自选股</h3>
            <div class="form-row">
              <label>代码 / 名称</label>
              <input type="text" id="wlAddInput" placeholder="例: 600519 或 600519 贵州茅台" autofocus>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Watchlist.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Watchlist.add()">添加</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      setTimeout(() => document.getElementById('wlAddInput')?.focus(), 100);
    },

    async add() {
      const input = document.getElementById('wlAddInput').value.trim();
      if (!input) { toastWarning('请输入代码或名称'); return; }
      const parsed = parseStockInput(input);
      if (!parsed) { toastError('格式不对,例: 600519 或 600519 贵州茅台'); return; }
      const exists = await Core.Storage.get('watchlist', parsed.code);
      if (exists) { toastWarning('已在自选中'); this.closeModal(); return; }
      await Core.Storage.add('watchlist', {
        code: parsed.code,
        name: parsed.name || '',
        addedAt: Date.now()
      });
      this.closeModal();
      toastSuccess('已添加');
      this.render();
    },

    async remove(code) {
      if (!confirm(`确定从自选中删除 ${code}?`)) return;
      await Core.Storage.remove('watchlist', code);
      toastSuccess('已删除');
      this.render();
    },

    closeModal() {
      document.getElementById('modalRoot').innerHTML = '';
    },

    /**
     * 显示 K 线
     */
    async showKLine(code, name) {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Watchlist.closeKLine()">
          <div class="modal" style="max-width:800px;width:100%;">
            <h3>${escapeHtml(code)} ${escapeHtml(name)}</h3>
            <div style="display:flex;gap:6px;margin-bottom:12px;">
              ${KLINE_PERIODS.map(p => `<button class="btn btn-sm" data-period="${p.value}" onclick="Watchlist.loadKLine('${escapeHtml(code)}','${p.value}')">${p.label}</button>`).join('')}
            </div>
            <div id="klineChart" style="width:100%;height:400px;background:var(--bg-base);border-radius:6px;"></div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Watchlist.closeKLine()">关闭</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      this.loadKLine(code, 'daily');
    },

    async loadKLine(code, period) {
      _currentKLineCode = code;
      const chartEl = document.getElementById('klineChart');
      if (!chartEl) return;
      chartEl.innerHTML = '<div class="loading">加载K线...</div>';

      const end = new Date();
      const start = new Date();
      // K线范围:日K 1年,周K 3年,月K 5年
      const days = period === 'daily' ? 365 : (period === 'weekly' ? 365 * 3 : 365 * 5);
      start.setDate(start.getDate() - days);

      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

      try {
        const data = await Core.Data.getStockKLine(
          code, period,
          fmt(start), fmt(end), 'qfq'
        );
        if (!data || data.length === 0) {
          chartEl.innerHTML = '<div class="empty">无数据</div>';
          return;
        }
        this._renderKLine(code, data);
      } catch (e) {
        chartEl.innerHTML = `<div class="empty">K线加载失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    _renderKLine(code, data) {
      const chartEl = document.getElementById('klineChart');
      if (!chartEl) return;
      if (_klineChart) { _klineChart.dispose(); _klineChart = null; }

      // ECharts 全局
      if (typeof echarts === 'undefined') {
        chartEl.innerHTML = '<div class="empty">ECharts 未加载</div>';
        return;
      }

      _klineChart = echarts.init(chartEl, 'dark');

      // AKShare stock_zh_a_hist 列: 日期,开盘,收盘,最高,最低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率
      const dates = data.map(d => d.日期);
      const kline = data.map(d => [d.开盘, d.收盘, d.最低, d.最高]);
      const volumes = data.map((d, i) => {
        const up = d.收盘 >= d.开盘;
        return [i, parseFloat(d.成交量) || 0, up ? 1 : -1];
      });
      const ma5 = this._calcMA(data, 5, '收盘');
      const ma10 = this._calcMA(data, 10, '收盘');
      const ma20 = this._calcMA(data, 20, '收盘');

      _klineChart.setOption({
        backgroundColor: 'transparent',
        legend: { data: ['MA5', 'MA10', 'MA20'], textStyle: { color: '#8b949e' }, top: 0 },
        tooltip: { trigger: 'axis', axisPointer: { type: 'cross' } },
        grid: [
          { left: 50, right: 20, top: 30, height: '60%' },
          { left: 50, right: 20, top: '75%', height: '18%' }
        ],
        xAxis: [
          { type: 'category', data: dates, boundaryGap: false, axisLine: { lineStyle: { color: '#30363d' } }, axisLabel: { color: '#8b949e' } },
          { type: 'category', gridIndex: 1, data: dates, axisLine: { lineStyle: { color: '#30363d' } }, axisLabel: { show: false } }
        ],
        yAxis: [
          { scale: true, splitLine: { lineStyle: { color: '#21262d' } }, axisLabel: { color: '#8b949e' } },
          { gridIndex: 1, splitLine: { show: false }, axisLabel: { color: '#8b949e' } }
        ],
        dataZoom: [
          { type: 'inside', xAxisIndex: [0, 1], start: 70, end: 100 },
          { show: true, xAxisIndex: [0, 1], type: 'slider', bottom: 5, start: 70, end: 100, textStyle: { color: '#8b949e' } }
        ],
        series: [
          {
            name: 'K线', type: 'candlestick', data: kline,
            itemStyle: {
              color: '#ef4444', color0: '#10b981',
              borderColor: '#ef4444', borderColor0: '#10b981'
            }
          },
          { name: 'MA5', type: 'line', data: ma5, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#fbbf24' } },
          { name: 'MA10', type: 'line', data: ma10, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#58a6ff' } },
          { name: 'MA20', type: 'line', data: ma20, smooth: true, showSymbol: false, lineStyle: { width: 1, color: '#a78bfa' } },
          {
            name: '成交量', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: volumes,
            itemStyle: { color: (p) => p.data[2] > 0 ? '#ef4444' : '#10b981' }
          }
        ]
      });
    },

    _calcMA(data, n, field) {
      const out = [];
      for (let i = 0; i < data.length; i++) {
        if (i < n - 1) { out.push('-'); continue; }
        let sum = 0;
        for (let j = 0; j < n; j++) sum += parseFloat(data[i - j][field]);
        out.push((sum / n).toFixed(2));
      }
      return out;
    },

    closeKLine() {
      if (_klineChart) { _klineChart.dispose(); _klineChart = null; }
      this.closeModal();
    }
  };

  window.Watchlist = Watchlist;

  // 切到本页时刷新
  window._onShow_pageWatchlist = function() { Watchlist.render(); };
})();
