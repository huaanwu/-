/**
 * Fund - 基金专项(主入口)
 *
 * 子模块拆分(按职责):
 *   - macro-bar.js       顶部宏观数据条 (Core.Macro, 24h 缓存)
 *   - news-bar.js        财经新闻条 (Core.News, 6h 缓存)
 *   - seed.js            seedRecommended 一键导入推荐组合
 *   - ai-advisor.js      AI 选基弹窗 + 异步流式输出
 *   - portfolio-risk.js  portfolioRiskDialog + _renderPortfolioRisk UI
 *   - news-impact.js     newsImpactDialog + _renderNewsImpact UI
 *   - rebalance.js       rebalanceDialog + _renderRebalanceHTML + _openRebalanceLinks UI
 *   - buy-import.js      申购计划 + 快速登记
 *
 * 跨 cluster 共享/被测试的纯函数 + DOMAINS 方法必须留主文件:
 *   - _typeLabel       所有 cluster 共享 label helper
 *   - _computePortfolioMetrics  纯函数,test_all.js 测
 *   - _computeRebalanceAdvice   纯函数,test_all.js 测
 *   - _analyzeNewsImpact        纯函数,test_all.js 测
 *
 * 加载顺序: index.html 先加载本文件,后加载子模块;子模块各自 IIFE 挂
 *           window.Fund.xxx,主文件不重置 window.Fund 引用。
 *           render 内部 this._xxx() 调用,this === window.Fund,能
 *           找到子模块挂的方法。
 */
(function() {
  'use strict';

  let _chart = null;

  const Fund = {

    async init() {},

    _typeLabel(t) {
      return {
        short_bond: '短债',
        pure_bond: '纯债',
        mixed_bond: '混合债',
        csi300: '沪深300',
        csi500: '中证500',
        '上证50': '上证50',
        '红利': '红利',
        '红利低波': '红利低波',
        A50: 'A50',
        other: '其他'
      }[t] || t || '-';
    },

    async render() {
      const list = await Core.Storage.all('funds');
      const summaryEl = document.getElementById('fundSummary');
      const tableEl = document.getElementById('fundTable');

      // 异步加载宏观数据 + 财经新闻 (不阻塞主渲染)
      this._renderMacroBar().catch(e => console.warn('[Fund] 宏观数据加载失败:', e));
      this._renderNewsBar().catch(e => console.warn('[Fund] 新闻加载失败:', e));

      if (!list || list.length === 0) {
        summaryEl.innerHTML = '';
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">🏦</div>
            <div>还没有自选基金</div>
            <div style="margin-top:8px;font-size:12px;">点击"添加"开始, 或一键导入推荐组合</div>
            <button class="btn btn-primary" style="margin-top:16px;" onclick="Fund.seedRecommended()">
              📥 一键导入推荐组合(2 只)
            </button>
            <div style="margin-top:8px;font-size:11px;color:var(--text-muted);max-width:280px;">
              长城短债 A 007194 (20%) + 中银纯债 D 018581 (80%)<br>
              预期年化 ≈ 4.25%, 历史最大回撤 ≈ -1.7%
            </div>
          </div>
        `;
        return;
      }

      let totalCost = 0, totalValue = 0;
      const rows = [];
      for (const f of list) {
        let currentNav = null;
        let dayChange = null;
        try {
          const data = await Core.Data.getFundSpot(f.code);
          // AKShare fund_open_fund_info_em 返回结构: 不同 indicator 不同
          if (Array.isArray(data) && data.length > 0) {
            const latest = data[data.length - 1];
            currentNav = parseFloat(latest.单位净值 || latest['单位净值'] || latest.value);
            if (data.length >= 2) {
              const prev = data[data.length - 2];
              const prevNav = parseFloat(prev.单位净值 || prev['单位净值'] || prev.value);
              if (currentNav && prevNav) {
                dayChange = (currentNav - prevNav) / prevNav;
              }
            }
          }
        } catch (e) {
          console.warn('[Fund] 拉净值失败:', f.code, e);
        }

        const shares = parseFloat(f.shares) || 0;
        const costNav = parseFloat(f.costNav) || 0;
        const value = currentNav ? shares * currentNav : null;
        const cost = shares * costNav;
        const pl = value !== null ? value - cost : null;
        const plPct = (pl !== null && cost > 0) ? pl / cost : null;
        if (value !== null) {
          totalCost += cost;
          totalValue += value;
        }
        rows.push({ f, currentNav, dayChange, shares, costNav, value, cost, pl, plPct });
      }

      // 按 type 聚合占比
      const byType = {};
      for (const r of rows) {
        if (r.value === null) continue;
        const t = r.f.type || 'other';
        byType[t] = (byType[t] || 0) + r.value;
      }
      const target = { ...Core.Constants.REBALANCE_TARGET_DEFAULT };
      let allocRows = '';
      for (const [type, val] of Object.entries(byType)) {
        const cur = totalValue > 0 ? val / totalValue : 0;
        const tgt = target[type];
        const diff = tgt !== undefined ? cur - tgt : null;
        const diffStr = diff !== null ? (diff > 0 ? '+' : '') + (diff * 100).toFixed(1) + '%' : '-';
        const tgtStr = tgt !== undefined ? (tgt * 100).toFixed(0) + '%' : '-';
        const curPct = (cur * 100).toFixed(1) + '%';
        allocRows += `
          <div class="alloc-row">
            <span class="alloc-label">${this._typeLabel(type)}</span>
            <span class="alloc-cur">${curPct}</span>
            <span class="alloc-tgt">目标 ${tgtStr}</span>
            <span class="alloc-diff ${diff !== null && Math.abs(diff) > Core.Constants.REBALANCE_DRIFT_THRESHOLD ? 'alloc-warn' : 'alloc-ok'}">${diff !== null ? diffStr : ''}</span>
          </div>
        `;
      }
      if (!allocRows) allocRows = '<div class="alloc-empty">填入份额/成本后显示配置占比</div>';

      const totalPL = totalValue - totalCost;
      const totalPLPct = totalCost > 0 ? totalPL / totalCost : 0;

      summaryEl.innerHTML = `
        <div class="summary-card">
          <div class="label">自选数</div>
          <div class="value">${list.length}</div>
        </div>
        <div class="summary-card">
          <div class="label">总成本</div>
          <div class="value">${fmtMoney(totalCost)}</div>
        </div>
        <div class="summary-card">
          <div class="label">总市值</div>
          <div class="value">${fmtMoney(totalValue)}</div>
        </div>
        <div class="summary-card">
          <div class="label">总盈亏</div>
          <div class="value ${pctClass(totalPLPct)}">${fmtMoney(totalPL)}</div>
          <div class="delta ${pctClass(totalPLPct)}">${fmtPct(totalPLPct)}</div>
        </div>
      `;

      tableEl.innerHTML = `
        <div class="alloc-block">
          <div class="alloc-title">📊 实际配置 vs 目标 (短债 20% / 纯债 80%)</div>
          ${allocRows}
          <div class="alloc-hint">⚠ 偏离 > 5% 时建议再平衡 (到 🔔 提醒页开启季度检查)</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>代码</th><th>名称</th><th>类型</th><th>单位净值</th><th>日涨跌</th>
              <th>份额</th><th>成本净值</th><th>市值</th><th>占比</th><th>盈亏</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const pct = (r.value !== null && totalValue > 0) ? (r.value / totalValue * 100).toFixed(1) + '%' : '-';
              return `
              <tr>
                <td><span class="code">${escapeHtml(r.f.code)}</span></td>
                <td>${escapeHtml(r.f.name || '')}</td>
                <td><span class="tag">${this._typeLabel(r.f.type || '')}</span></td>
                <td>${r.currentNav ? r.currentNav.toFixed(4) : '-'}</td>
                <td class="${pctClass(r.dayChange)}">${r.dayChange !== null ? fmtPct(r.dayChange) : '-'}</td>
                <td>${fmtNum(r.shares, 2)}</td>
                <td>${r.costNav ? r.costNav.toFixed(4) : '-'}</td>
                <td>${r.value !== null ? fmtMoney(r.value) : '-'}</td>
                <td><strong>${pct}</strong></td>
                <td class="${pctClass(r.plPct)}">
                  ${r.pl !== null ? fmtMoney(r.pl) : '-'}<br>
                  <span style="font-size:11px;">${r.plPct !== null ? fmtPct(r.plPct) : ''}</span>
                </td>
                <td>
                  <button class="btn btn-sm" onclick="Fund.showChart('${escapeHtml(r.f.code)}','${escapeHtml(r.f.name || '')}')">📈</button>
                  <button class="btn btn-sm" onclick="Fund.buyDialog('${escapeHtml(r.f.code)}')" title="跳第三方平台申购">🛒</button>
                  <button class="btn btn-sm" onclick="Fund.sellDialog('${escapeHtml(r.f.code)}')" title="跳第三方平台赎回 / 快速赎回登记">💰</button>
                  <button class="btn btn-sm" onclick="Fund.remove('${escapeHtml(r.f.code)}')">✕</button>
                </td>
              </tr>
            `;}).join('')}
          </tbody>
        </table>
      `;
    },

    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal">
            <h3>添加自选基金</h3>
            <div class="form-row">
              <label>基金代码</label>
              <input type="text" id="fCode" placeholder="例: 519069" autofocus>
            </div>
            <div class="form-row">
              <label>名称</label>
              <input type="text" id="fName" placeholder="可选">
            </div>
            <div class="form-row">
              <label>持有份额</label>
              <input type="number" id="fShares" placeholder="10000" step="0.01">
            </div>
            <div class="form-row">
              <label>成本净值</label>
              <input type="number" id="fCostNav" placeholder="1.2345" step="0.0001">
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Fund.save()">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async save() {
      const code = document.getElementById('fCode').value.trim();
      const name = document.getElementById('fName').value.trim();
      const shares = parseFloat(document.getElementById('fShares').value) || 0;
      const costNav = parseFloat(document.getElementById('fCostNav').value) || 0;
      if (!code || !/^\d{6}$/.test(code)) { toastError('基金代码必须 6 位'); return; }
      const exists = await Core.Storage.get('funds', code);
      if (exists) { toastWarning('已在自选中'); this.closeModal(); return; }
      await Core.Storage.add('funds', { code, name, shares, costNav, addedAt: Date.now() });
      this.closeModal();
      toastSuccess('已添加');
      this.render();
    },

    async remove(code) {
      if (!confirm(`确定从自选基金删除 ${code}?`)) return;
      await Core.Storage.remove('funds', code);
      toastSuccess('已删除');
      this.render();
    },

    /**
     * 基金账户余额对账
     * 用户手动输入第三方 App (天天/支付宝/蛋卷) 显示的"基金市值总资产"
     * app 跟自身计算 (按当日净值 × 份额) 对比
     * 偏差 > 50 元 → 提示"可能有漏录的申购/赎回"
     */
    async reconcileDialog() {
      const list = await Core.Storage.all('funds');
      const cashflows = await Core.Storage.all('cashflow');

      // app 自身计算: 拉最新净值 → 份额 × 当前净值
      let appValue = 0, hasValue = false;
      for (const f of (list || [])) {
        const shares = parseFloat(f.shares) || 0;
        if (shares <= 0) continue;
        let nav = null;
        try {
          const spot = await Core.Data.getFundSpot(f.code);
          if (Array.isArray(spot) && spot.length > 0) {
            const latest = spot[spot.length - 1];
            nav = parseFloat(latest.单位净值 || latest['单位净值'] || latest.value);
          }
        } catch (e) { console.warn('[Fund] 净值拉取失败:', f.code, e); }
        if (nav) { appValue += shares * nav; hasValue = true; }
      }

      // 现金部分 (cashflow 中 target 是 6 位基金代码 或 type=transfer 涉及基金的)
      // 简单口径: 所有 cashflow 净额 (正=入, 负=出). 跟股票口径分开, 用 key prefix 区分
      // 这里只看基金相关 cashflow: target 形如 6 位基金代码 (不是股票代码)
      let appCash = 0;
      cashflows.forEach(f => {
        const tgt = (f.target || '').toString();
        const isFund = /^\d{6}$/.test(tgt) && (
          tgt.startsWith('00') || tgt.startsWith('01') || tgt.startsWith('02') ||
          tgt.startsWith('03') || tgt.startsWith('04') || tgt.startsWith('05')
        );
        // 简化: 只对 type='transfer' 且 target 是 6 位数字的, 视为基金资金流
        if (isFund) appCash += parseFloat(f.amount) || 0;
      });

      const appTotal = appValue + appCash;
      const last = await Core.Storage.kvGet('fund_last_reconcile') || {};

      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:480px;">
            <h3>⚖️ 基金对账</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
              把第三方基金 App 显示的 <b>基金市值总资产</b> 数字输进来, app 自动对比自算值<br>
              偏差大 → 提示可能有漏录的申购/赎回<br>
              <span style="font-size:11px;">💡 跟股票对账分开存 (key 前缀不同), 互不干扰</span>
            </div>

            <div style="background:var(--bg-base);padding:10px;border-radius:6px;margin-bottom:12px;font-size:13px;line-height:1.7;">
              <div>📊 <b>app 自算</b>: ${fmtMoney(appValue)} (持仓按今日净值)${hasValue ? '' : ' <span style="color:var(--down);">(净值未拉到)</span>'}</div>
              <div>💵 <b>净流入</b>: ${fmtMoney(appCash)} (基金 cashflow 净额)</div>
              <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;">
                <b>总计</b>: <span style="color:var(--accent);font-size:15px;">${fmtMoney(appTotal)}</span>
              </div>
            </div>

            <div class="form-row">
              <label>第三方 App 基金总资产 (元)</label>
              <input type="number" id="fReconcileBroker" step="0.01" placeholder="例: 82345.67">
              <div style="font-size:11px;color:var(--text-muted);">打开天天基金 App → 资产总览 → 复制数字</div>
            </div>
            <div class="form-row">
              <label>对账日期</label>
              <input type="date" id="fReconcileDate" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-row">
              <label>备注 (可选)</label>
              <input type="text" id="fReconcileNote" placeholder="例: 周三定投 1000 已扣款">
            </div>

            <div id="fReconcilePreview" style="background:var(--bg-base);padding:10px;border-radius:4px;margin:8px 0;font-size:12px;line-height:1.6;">
              填完数字自动算偏差
            </div>

            ${last.date ? `
              <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
                上次对账: ${escapeHtml(last.date)} · 当时偏差 ${fmtMoney(last.diff || 0)}
              </div>
            ` : ''}

            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Fund.reconcileSave()">✓ 保存对账</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      this._reconcileAppTotal = appTotal;
      this._bindReconcileCalc();
    },

    _bindReconcileCalc() {
      const upd = () => {
        const broker = parseFloat(document.getElementById('fReconcileBroker')?.value);
        const el = document.getElementById('fReconcilePreview');
        if (!el) return;
        if (isNaN(broker)) { el.textContent = '填完数字自动算偏差'; return; }
        const diff = broker - this._reconcileAppTotal;
        const absDiff = Math.abs(diff);
        let status, color;
        if (absDiff < 50) {
          status = '✅ 完全对得上 (偏差 < 50 元, 可能是净值波动)';
          color = 'var(--up)';
        } else if (absDiff < 500) {
          status = '⚠️ 轻微偏差, 可能是今日净值未及时刷新, 或小额定投漏录';
          color = 'var(--text-muted)';
        } else if (diff > 0) {
          status = `❌ 第三方比 app 多 ${fmtMoney(diff)}, 可能漏录了 ${fmtMoney(diff)} 的申购或漏算定投`;
          color = 'var(--down)';
        } else {
          status = `❌ 第三方比 app 少 ${fmtMoney(-diff)}, 可能多录了 ${fmtMoney(-diff)} 或漏算赎回`;
          color = 'var(--down)';
        }
        el.innerHTML = `
          <b>偏差</b>: <span style="color:${color};font-size:15px;">${fmtMoney(diff)}</span><br>
          <span style="color:${color};">${status}</span>
        `;
      };
      const input = document.getElementById('fReconcileBroker');
      if (input) input.addEventListener('input', upd);
      upd();
    },

    async reconcileSave() {
      const broker = parseFloat(document.getElementById('fReconcileBroker').value);
      const date = document.getElementById('fReconcileDate').value;
      const note = document.getElementById('fReconcileNote').value.trim();
      if (isNaN(broker)) { toastError('填第三方基金总资产数字'); return; }
      if (!date) { toastError('填日期'); return; }
      const diff = broker - this._reconcileAppTotal;

      const rec = { date, brokerTotal: broker, appTotal: this._reconcileAppTotal, diff, note, createdAt: Date.now() };
      // 基金侧独立 kv, 跟股票侧 holdings_reconcile_log 分开
      const list = (await Core.Storage.kvGet('fund_reconcile_log')) || [];
      list.push(rec);
      if (list.length > 30) list.shift();
      await Core.Storage.kvSet('fund_reconcile_log', list);
      await Core.Storage.kvSet('fund_last_reconcile', { date, diff });

      this.closeModal();
      const abs = Math.abs(diff);
      if (abs < 50) {
        toastSuccess(`✅ 基金对账通过, 偏差 ${fmtMoney(diff)}`);
      } else if (abs < 500) {
        toastSuccess(`基金对账已记录, 偏差 ${fmtMoney(diff)}, 检查今日净值/定投`);
      } else {
        toastError(`基金偏差 ${fmtMoney(diff)} 较大, 已记录. 请检查申购/赎回是否漏录`);
      }
      this.render();
    },

    async showChart(code, name) {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:800px;width:100%;">
            <h3>${escapeHtml(code)} ${escapeHtml(name)} - 净值走势</h3>
            <div id="fundChart" style="width:100%;height:400px;background:var(--bg-base);border-radius:6px;"></div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;

      const chartEl = document.getElementById('fundChart');
      chartEl.innerHTML = '<div class="loading">加载净值...</div>';

      try {
        const end = new Date();
        const start = new Date();
        start.setMonth(start.getMonth() - 6);
        const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

        const data = await Core.Data.getFundHistory(code, fmt(start), fmt(end));
        if (!data || data.length === 0) {
          chartEl.innerHTML = '<div class="empty">无数据</div>';
          return;
        }
        this._renderChart(code, data);
      } catch (e) {
        chartEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    _renderChart(code, data) {
      const chartEl = document.getElementById('fundChart');
      if (!chartEl || typeof echarts === 'undefined') return;
      if (_chart) { _chart.dispose(); _chart = null; }
      _chart = echarts.init(chartEl, 'dark');

      const dates = data.map(d => d.净值日期 || d.x日期 || '');
      const navs = data.map(d => parseFloat(d.单位净值 || d['单位净值'] || d.y));
      const accNavs = data.map(d => parseFloat(d.累计净值 || d['累计净值']));

      _chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: ['单位净值', '累计净值'], textStyle: { color: '#8b949e' } },
        xAxis: { type: 'category', data: dates, axisLabel: { color: '#8b949e' } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
        series: [
          {
            name: '单位净值', type: 'line', data: navs, smooth: true, showSymbol: false,
            lineStyle: { color: '#f59e0b', width: 2 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.1)' }
          },
          {
            name: '累计净值', type: 'line', data: accNavs, smooth: true, showSymbol: false,
            lineStyle: { color: '#58a6ff', width: 1 }
          }
        ]
      });
    },

    closeModal() {
      if (_chart) { _chart.dispose(); _chart = null; }
      document.getElementById('modalRoot').innerHTML = '';
    },

    // ========== 跨 cluster 共享的纯函数(被 test_all.js 测,不能拆) ==========

    /**
     * 组合风险指标 (纯函数)
     * 输入: holdings (含 value) + navHistory (按 code 索引的 [{date, nav}, ...])
     * 输出: { totalValue, weights, period, metrics: {annualReturn, annualVol, sharpe, sortino, maxDD, calmar, ...} }
     *
     * 算法:
     *   1. 权重 = value / totalValue
     *   2. 每只基金日收益 r_i = (nav_t - nav_{t-1}) / nav_{t-1}
     *   3. 组合日收益 r_p = Σ w_i × r_i_t (按时间对齐)
     *   4. 年化收益 = mean(r_p_daily) × 252
     *   5. 年化波动 = std(r_p_daily) × √252
     *   6. Sharpe = (年化 - 无风险) / 年化波动
     *   7. Sortino = (年化 - 无风险) / 下行波动 (只算负收益 std)
     *   8. 最大回撤 = max(1 - cum_t / max(cum_so_far))
     *   9. Calmar = 年化 / |最大回撤|
     */
    _computePortfolioMetrics(holdings, navHistory, riskFreeRate = 0.02) {
      const valid = (holdings || []).filter(h => h.value && h.value > 0);
      if (valid.length === 0) {
        return { ok: false, reason: '无持仓', metrics: null };
      }
      const totalValue = valid.reduce((s, h) => s + h.value, 0);
      if (totalValue <= 0) {
        return { ok: false, reason: '总市值 0', metrics: null };
      }
      const weights = {};
      for (const h of valid) weights[h.code] = h.value / totalValue;

      // 取每只基金日收益 (按 date 对齐)
      const dateSet = new Set();
      for (const h of valid) {
        const arr = (navHistory || {})[h.code] || [];
        for (const it of arr) if (it && it.date && typeof it.nav === 'number') dateSet.add(it.date);
      }
      const dates = Array.from(dateSet).sort();

      // 算每只基金的日收益 map
      const returnsByCode = {};
      for (const h of valid) {
        const arr = (navHistory || {})[h.code] || [];
        const sorted = arr.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const rMap = {};
        for (let i = 1; i < sorted.length; i++) {
          const cur = sorted[i], prev = sorted[i - 1];
          if (cur.nav && prev.nav) rMap[cur.date] = (cur.nav - prev.nav) / prev.nav;
        }
        returnsByCode[h.code] = rMap;
      }

      // 算组合日收益序列
      const portReturns = [];
      const portDateReturns = [];
      for (const d of dates) {
        let r = 0, has = false;
        for (const h of valid) {
          const ri = returnsByCode[h.code][d];
          if (typeof ri === 'number') {
            r += weights[h.code] * ri;
            has = true;
          }
        }
        if (has) {
          portReturns.push(r);
          portDateReturns.push({ date: d, r });
        }
      }

      if (portReturns.length < 5) {
        return {
          ok: false,
          reason: `组合日收益数据不足 (${portReturns.length} < 5 天), 需要更长历史`,
          totalValue,
          weights,
          metrics: null
        };
      }

      // 年化收益 (用算术均值, 简化)
      const meanDaily = portReturns.reduce((s, x) => s + x, 0) / portReturns.length;
      const annualReturn = meanDaily * 252;

      // 年化波动率 (总体 std)
      const variance = portReturns.reduce((s, x) => s + (x - meanDaily) ** 2, 0) / portReturns.length;
      const stdDaily = Math.sqrt(variance);
      const annualVol = stdDaily * Math.sqrt(252);

      // Sharpe
      const sharpe = annualVol > 0 ? (annualReturn - riskFreeRate) / annualVol : 0;

      // Sortino (下行波动: 只算 r < 0 的 std)
      const negReturns = portReturns.filter(r => r < 0);
      let sortino = 0;
      if (negReturns.length > 0) {
        const negMean = negReturns.reduce((s, x) => s + x, 0) / negReturns.length;
        const downVar = negReturns.reduce((s, x) => s + (x - negMean) ** 2, 0) / negReturns.length;
        const downStd = Math.sqrt(downVar) * Math.sqrt(252);
        sortino = downStd > 0 ? (annualReturn - riskFreeRate) / downStd : 0;
      }

      // 最大回撤
      let cum = 1, peak = 1, maxDD = 0;
      for (const r of portReturns) {
        cum *= (1 + r);
        if (cum > peak) peak = cum;
        const dd = (peak - cum) / peak;
        if (dd > maxDD) maxDD = dd;
      }
      // 最大回撤为负数(代表下跌)
      const maxDD_pct = -maxDD;

      // Calmar = 年化 / |最大回撤|
      const calmar = maxDD > 0.001 ? annualReturn / maxDD : 0;

      // 胜率 (日收益 > 0 的占比)
      const winRate = portReturns.filter(r => r > 0).length / portReturns.length;

      // 起始/结束日期 + 实际年化 (复利)
      const cumStart = 1, cumEnd = cum;
      const days = portReturns.length;
      const yearsActual = days / 252;
      const cumAnnual = yearsActual > 0 ? (Math.pow(cumEnd / cumStart, 1 / yearsActual) - 1) : 0;

      return {
        ok: true,
        totalValue,
        weights,
        period: {
          start: portDateReturns[0].date,
          end: portDateReturns[portDateReturns.length - 1].date,
          tradingDays: days,
          years: yearsActual
        },
        metrics: {
          annualReturn,       // 算术年化
          cumAnnual,          // 复利年化
          annualVol,
          sharpe,
          sortino,
          maxDD: maxDD_pct,   // 负数
          calmar,
          winRate,
          bestDay: Math.max(...portReturns),
          worstDay: Math.min(...portReturns)
        },
        warnings: []
      };
    },

    /**
     * 基金再平衡 - 纯函数: 根据当前持仓 + 目标配置, 生成调仓建议
     *
     * @param {Array<{code, name, type, value, currentNav}>} holdings  当前持仓 (value=当前市值, currentNav=实时净值)
     * @param {Object} targets  目标配置 { short_bond: 0.20, pure_bond: 0.80 }
     * @param {number} threshold  漂移阈值 (默认 0.05 = 5%)
     * @param {Object} fees 费率 { redeem: 0, buy: 0.001 } (默认 0.1% 申购)
     * @returns {Object} {
     *   ok: boolean,
     *   reason: string,  // 不可调仓时
     *   totalValue: number,
     *   drift: [...],   // 每只基金的当前% / 目标% / 差值 / 是否触发
     *   suggestions: [...],  // 调仓动作: { code, name, action, amount, shares, fromPct, toPct, reason }
     *   totalAdjust: number,  // 总调仓金额 (绝对值)
     *   costEstimate: number,  // 预估费率成本
     *   warnings: [...],  // 提示
     *   expectedConfig: [...]  // 调后配置
     * }
     */
    _computeRebalanceAdvice(holdings, targets, threshold = Core.Constants.REBALANCE_DRIFT_THRESHOLD, fees = { redeem: 0, buy: 0.001 }) {
      // 过滤掉没市值的
      const valid = (holdings || []).filter(h => h.value && h.value > 0);
      if (valid.length === 0) {
        return { ok: false, reason: '当前无持仓', drift: [], suggestions: [], warnings: [], expectedConfig: [] };
      }

      const totalValue = valid.reduce((s, h) => s + h.value, 0);
      if (totalValue <= 0) {
        return { ok: false, reason: '总市值为 0', drift: [], suggestions: [], warnings: [], expectedConfig: [] };
      }

      // Bug I 修复: 类型级 drift (恢复聚合语义)
      // byType 聚合 type → { currentValue, currentPct, targetPct, driftPct, triggered }
      // 原 bug: 之前按单只算 curPct vs type 级 targetPct, 同 type 多只时每只都被判 drift, 越调越歪
      const byType = {};
      for (const h of valid) {
        const t = h.type || 'other';
        if (!byType[t]) byType[t] = { type: t, currentValue: 0, currentPct: 0, holdings: [] };
        byType[t].currentValue += h.value;
        byType[t].holdings.push(h);
      }
      for (const t of Object.keys(byType)) {
        byType[t].currentPct = byType[t].currentValue / totalValue;
        const tgt = targets[t];
        byType[t].targetPct = tgt !== undefined ? tgt : null;
        byType[t].driftPct = tgt !== undefined ? byType[t].currentPct - tgt : 0;
        byType[t].triggered = tgt !== undefined && Math.abs(byType[t].driftPct) > threshold;
      }
      // drift 数组改成 type 级 (UI 展示用)
      const drift = Object.values(byType).map(b => ({
        type: b.type,
        currentValue: b.currentValue,
        currentPct: b.currentPct,
        targetPct: b.targetPct,
        driftPct: b.driftPct,
        triggered: b.triggered,
        holdingCount: b.holdings.length
      }));

      // 1. 检查整体是否需要调
      const triggeredAny = drift.some(d => d.triggered);
      if (!triggeredAny) {
        return {
          ok: true,
          needRebalance: false,
          reason: `所有类型漂移 ≤ ${(threshold * 100).toFixed(0)}%, 无需调仓`,
          totalValue,
          drift,
          suggestions: [],
          totalAdjust: 0,
          costEstimate: 0,
          warnings: [],
          expectedConfig: valid.map(h => ({ code: h.code, type: h.type, currentPct: h.value / totalValue, targetPct: targets[h.type] }))
        };
      }

      // 2. 算调仓建议 (类型级: 每条建议对应一个 type, 列出涉及的代表持仓)
      const suggestions = [];
      let totalAdjust = 0;
      let costEstimate = 0;
      // 原始 delta 收集, 后面算上限警告
      const rawDeltas = [];

      for (const d of drift) {
        if (d.targetPct === null) continue;  // type 不在目标里, 不动
        if (!d.triggered) continue;  // 没超阈值, 不动
        const targetValue = totalValue * d.targetPct;
        const diffValue = d.currentValue - targetValue;  // >0 超配, <0 欠配
        if (Math.abs(diffValue) < 100) continue;  // 太小不调 (< 100 元)
        rawDeltas.push({ d, diffValue, targetValue });
      }

      // 3. 总调仓金额上限 10% totalValue (警告, 不强制缩减)
      // 原始比例保留: 漂移严重时给用户警示, 但建议金额按差额照算, 让用户自己决定是否分批调
      const MAX_TOTAL_ADJUST_RATIO = 0.10;
      const totalRawAdjust = rawDeltas.reduce((s, x) => s + Math.abs(x.diffValue), 0);
      const cap = totalValue * MAX_TOTAL_ADJUST_RATIO;
      const overCap = totalRawAdjust > cap;

      for (const { d, diffValue } of rawDeltas) {
        const action = diffValue > 0 ? 'reduce' : 'add';
        const amount = Math.abs(diffValue);
        // 选代表持仓: add/reduce 都取当前最大 (加减大头)
        const holdings = byType[d.type].holdings;
        const pick = holdings.slice().sort((a, b) => b.value - a.value)[0];
        // 费率
        const feeRate = action === 'reduce' ? fees.redeem : fees.buy;
        const fee = amount * feeRate;
        totalAdjust += amount;
        costEstimate += fee;
        const fromPct = d.currentPct;
        const toPct = d.targetPct;
        const reason = action === 'reduce'
          ? `${d.type} 当前 ${(fromPct * 100).toFixed(1)}% 超配 ${(Math.abs(d.driftPct) * 100).toFixed(1)}%, 减仓回到目标 ${(toPct * 100).toFixed(0)}%`
          : `${d.type} 当前 ${(fromPct * 100).toFixed(1)}% 欠配 ${(Math.abs(d.driftPct) * 100).toFixed(1)}%, 加仓回到目标 ${(toPct * 100).toFixed(0)}%`;
        suggestions.push({
          type: d.type,
          action,
          amount,
          code: pick.code,
          name: pick.name,
          currentNav: pick.currentNav,
          shares: pick.currentNav ? Math.round((amount / pick.currentNav) * 100) / 100 : null,
          fromPct,
          toPct,
          fee,
          reason
        });
      }

      // 4. 警告
      const warnings = [];
      const reduceSum = suggestions.filter(s => s.action === 'reduce').reduce((s, x) => s + x.amount, 0);
      const addSum = suggestions.filter(s => s.action === 'add').reduce((s, x) => s + x.amount, 0);
      if (Math.abs(reduceSum - addSum) > 1) {
        warnings.push(`减仓 ${reduceSum.toFixed(0)} 元 ≠ 加仓 ${addSum.toFixed(0)} 元, 差额可能因 type 不在目标里`);
      }
      if (costEstimate / totalValue > 0.005) {
        warnings.push(`费率成本 ${(costEstimate).toFixed(0)} 元 ≈ ${(costEstimate / totalValue * 100).toFixed(2)}% 总市值, 较高`);
      }
      if (totalAdjust < 500) {
        warnings.push(`总调仓金额 < 500 元, 申赎费可能不划算`);
      }
      if (overCap) {
        warnings.push(`总调仓 ${totalRawAdjust.toFixed(0)} 元 > ${(MAX_TOTAL_ADJUST_RATIO * 100).toFixed(0)}% 上限 ${cap.toFixed(0)} 元, 建议分批调仓`);
      }

      // 5. 调后配置 (按 type 推算): 加仓 type 实际% 上升, 减仓 type 实际% 下降
      const expectedConfig = valid.map(h => {
        const b = byType[h.type];
        const expectedTypePct = b.targetPct !== null ? b.targetPct : b.currentPct;
        // 按持仓在 type 内占比分配
        const share = b.currentValue > 0 ? h.value / b.currentValue : 0;
        return {
          code: h.code,
          name: h.name,
          type: h.type,
          currentPct: h.value / totalValue,
          targetPct: targets[h.type],
          expectedPct: expectedTypePct * share
        };
      });

      return {
        ok: true,
        needRebalance: true,
        totalValue,
        drift,
        suggestions,
        totalAdjust,
        costEstimate,
        warnings,
        expectedConfig
      };
    },

    /**
     * 新闻→持仓影响 (纯函数, 静态规则匹配)
     */
    _analyzeNewsImpact(newsItems, holdings) {
      // 规则: 关键词 + 影响的 type + 影响方向 + 原因
      const RULES = [
        // 利好债基
        { kws: ['降息', '降准', '下调存款准备金率', '下调LPR', 'LPR下调', '下调逆回购'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'positive', reason: '利率下行 → 债基净值涨' },
        { kws: ['资金宽松', '流动性宽松', '宽松货币', '公开市场净投放'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'positive', reason: '资金面宽松 → 利好债基' },
        { kws: ['通缩', 'CPI下行', 'CPI走低', 'PPI下行'],
          types: ['short_bond', 'pure_bond'],
          impact: 'positive', reason: '通缩风险 → 利率或下行, 利好债基' },

        // 利空债基
        { kws: ['加息', '上调LPR', 'LPR上调', '上调存款准备金率', '收紧货币', '流动性收紧'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'negative', reason: '利率上行 → 债基净值跌' },
        { kws: ['通胀', 'CPI上行', 'CPI走高', 'CPI超预期'],
          types: ['short_bond', 'pure_bond'],
          impact: 'negative', reason: '通胀 → 利率或上行, 利空债基' },

        // 利好权益
        { kws: ['经济复苏', 'PMI回升', 'PMI 回升', 'PMI扩张', 'PMI 扩张', '稳增长', '刺激政策', '财政发力'],
          types: ['csi300', 'csi500', 'wide', 'A50', '上证50', '红利', '红利低波'],
          impact: 'positive', reason: '经济/政策利好 → 利好权益' },

        // 利空权益
        { kws: ['经济下行', 'PMI收缩', 'PMI 收缩', 'PMI跌破', 'PMI 跌破', '衰退担忧'],
          types: ['csi300', 'csi500', 'wide', 'A50', '上证50'],
          impact: 'negative', reason: '经济下行 → 利空权益' },

        // 信用风险
        { kws: ['城投违约', '信用债违约', '信用风险', '暴雷'],
          types: ['pure_bond', 'mixed_bond'],
          impact: 'negative', reason: '信用风险 → 利空信用债持仓多的' }
      ];

      const results = [];
      for (const it of newsItems) {
        const text = ((it.tag || '') + ' ' + (it.summary || '')).toLowerCase();
        const matches = [];  // {rule, hold: 适用持仓}
        for (const rule of RULES) {
          for (const kw of rule.kws) {
            if (text.includes(kw.toLowerCase())) {
              // 找适用持仓
              const affected = holdings.filter(h => rule.types.includes(h.type || 'other'));
              if (affected.length > 0) {
                matches.push({ rule, kw, affected, impact: rule.impact, reason: rule.reason });
              }
              break;  // 一条规则只匹配一次
            }
          }
        }
        if (matches.length > 0) {
          // 合并: 同一持仓的多次影响, 抵消
          const byHolding = {};
          for (const m of matches) {
            for (const h of m.affected) {
              if (!byHolding[h.code]) byHolding[h.code] = { holding: h, positives: 0, negatives: 0, reasons: [] };
              if (m.impact === 'positive') byHolding[h.code].positives++;
              else byHolding[h.code].negatives++;
              byHolding[h.code].reasons.push(m.reason);
            }
          }
          const items = Object.values(byHolding).map(b => {
            const net = b.positives - b.negatives;
            const impact = net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral');
            return { holding: b.holding, impact, reasons: [...new Set(b.reasons)] };
          });
          results.push({ news: it, items });
        }
      }
      return results;
    }
  };

  window.Fund = Fund;
  window._onShow_pageFund = function() {
    Fund.render();
    if (window.MarketBar) MarketBar.mount('pageFund', 'wide');
  };
})();