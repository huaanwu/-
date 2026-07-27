/**
 * Account - 资金账户
 * 统一视图: 现金 + 股票市值 + 基金市值 + 总盈亏 + 资金流水
 *
 * 数据源:
 *   - 现金: Core.State.account.cash (用户输入)
 *   - 股票市值: Core.Storage 'holdings' × Core.Data.getStockQuote (实时)
 *   - 基金市值: Core.Storage 'funds' × Core.Data.getFundSpot (实时)
 *   - 资金流水: Core.Storage 'cashflow' (用户记账)
 */
(function() {
  'use strict';

  const Account = {
    async init() {},

    async render() {
      const summaryEl = document.getElementById('accountSummary');
      const breakdownEl = document.getElementById('accountBreakdown');
      const flowEl = document.getElementById('accountFlow');
      const historyEl = document.getElementById('accountHistory');

      // 顶部: 备份/恢复 快速按钮 + 云同步状态
      const syncStatus = Core.Sync ? Core.Sync.getStatus() : { configured: false, loggedIn: false };
      const syncBadge = syncStatus.loggedIn
        ? `<span style="color:var(--up);">☁️ ${escapeHtml(syncStatus.email)}</span>`
        : syncStatus.configured
          ? `<span style="color:var(--text-muted);">☁️ 已配置未登录</span>`
          : `<span style="color:var(--text-muted);">☁️ 离线</span>`;
      const headerEl = document.querySelector('#pageAccount .page-header');
      if (headerEl && !headerEl.querySelector('.account-actions')) {
        const actions = document.createElement('div');
        actions.className = 'account-actions';
        actions.style.cssText = 'display:flex;gap:8px;align-items:center;';
        actions.innerHTML = `
          <span style="font-size:11px;">${syncBadge}</span>
          <button class="btn btn-sm" onclick="exportData()">📤 导出</button>
          <button class="btn btn-sm" onclick="importData()">📥 导入</button>
          <button class="btn btn-sm btn-primary" onclick="syncNow()">🔄 云同步</button>
        `;
        headerEl.appendChild(actions);
      }

      // 现金 (从 state 读, 默认 0)
      const cash = parseFloat(Core.State.get('accountCash')) || 0;

      // 拉所有持仓/基金, 并行拉实时价
      const [holdings, funds, flow] = await Promise.all([
        Core.Storage.all('holdings'),
        Core.Storage.all('funds'),
        Core.Storage.all('cashflow')
      ]);

      // 拉实时价 (并行)
      const stockQuotes = {};
      await Promise.all(holdings.map(async h => {
        try {
          const q = await Core.Data.getStockQuote(h.code);
          if (q) stockQuotes[h.code] = parseFloat(q.最新价) || 0;
        } catch (e) { /* 单只失败不影响整体 */ }
      }));
      const fundNavs = {};
      await Promise.all(funds.map(async f => {
        if (!f.shares || f.shares <= 0) return;
        try {
          const arr = await Core.Data.getFundSpot(f.code);
          if (Array.isArray(arr) && arr.length > 0) {
            const last = arr[arr.length - 1];
            const nav = parseFloat(last.单位净值 || last['单位净值'] || last.value);
            if (nav) fundNavs[f.code] = nav;
          }
        } catch (e) { /* skip */ }
      }));

      // 计算总值
      let stockMkt = 0, stockCost = 0;
      const stockRows = [];
      for (const h of holdings) {
        const shares = parseFloat(h.shares) || 0;
        const cost = parseFloat(h.cost) || 0;
        const price = stockQuotes[h.code];
        if (shares <= 0) continue;
        const mkt = price ? shares * price : null;
        const costTotal = shares * cost;
        const pl = mkt !== null ? mkt - costTotal : null;
        stockMkt += mkt || 0;
        stockCost += costTotal;
        stockRows.push({ h, shares, cost, price, mkt, costTotal, pl });
      }

      let fundMkt = 0, fundCost = 0;
      const fundRows = [];
      for (const f of funds) {
        const shares = parseFloat(f.shares) || 0;
        const costNav = parseFloat(f.costNav) || 0;
        const nav = fundNavs[f.code];
        if (shares <= 0) continue;
        const mkt = nav ? shares * nav : null;
        const costTotal = shares * costNav;
        const pl = mkt !== null ? mkt - costTotal : null;
        fundMkt += mkt || 0;
        fundCost += costTotal;
        fundRows.push({ f, shares, costNav, nav, mkt, costTotal, pl });
      }

      const totalAssets = cash + stockMkt + fundMkt;
      const totalCost = stockCost + fundCost;
      const totalPL = (stockMkt - stockCost) + (fundMkt - fundCost);
      const totalPLPct = totalCost > 0 ? totalPL / totalCost : 0;

      // 流水统计
      const deposits = flow.filter(f => f.type === 'deposit').reduce((s, f) => s + (f.amount || 0), 0);
      const withdraws = flow.filter(f => f.type === 'withdraw').reduce((s, f) => s + (f.amount || 0), 0);
      const dividends = flow.filter(f => f.type === 'dividend').reduce((s, f) => s + (f.amount || 0), 0);

      // === 总览卡片 ===
      summaryEl.innerHTML = `
        <div class="summary-card" style="border-left:3px solid var(--accent);">
          <div class="label">💰 总资产</div>
          <div class="value" style="font-size:24px;">${fmtMoney(totalAssets)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">现金 + 股票 + 基金</div>
        </div>
        <div class="summary-card" style="border-left:3px solid ${totalPL >= 0 ? 'var(--up)' : 'var(--down)'};">
          <div class="label">📈 总盈亏</div>
          <div class="value ${pctClass(totalPLPct)}" style="font-size:24px;">${fmtMoney(totalPL)}</div>
          <div class="delta ${pctClass(totalPLPct)}">${fmtPct(totalPLPct)}</div>
        </div>
        <div class="summary-card">
          <div class="label">💵 现金</div>
          <div class="value" style="font-size:20px;">${fmtMoney(cash)}</div>
          <button class="btn btn-sm btn-ghost" onclick="Account.editCash()" style="margin-top:6px;font-size:11px;padding:2px 8px;">✏️ 编辑</button>
        </div>
        <div class="summary-card">
          <div class="label">📊 股票市值</div>
          <div class="value" style="font-size:20px;">${fmtMoney(stockMkt)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">${holdings.length} 持仓 / 成本 ${fmtMoney(stockCost)}</div>
        </div>
        <div class="summary-card">
          <div class="label">🏦 基金市值</div>
          <div class="value" style="font-size:20px;">${fmtMoney(fundMkt)}</div>
          <div class="delta" style="font-size:11px;color:var(--text-muted);">${funds.filter(f => f.shares > 0).length} 持仓 / 成本 ${fmtMoney(fundCost)}</div>
        </div>
      `;

      // === 资产分布 ===
      const parts = [
        { label: '现金', val: cash, color: 'var(--up)', icon: '💵' },
        { label: '股票', val: stockMkt, color: 'var(--accent)', icon: '📊' },
        { label: '基金', val: fundMkt, color: 'var(--link, #58a6ff)', icon: '🏦' }
      ].filter(p => p.val > 0);

      if (parts.length === 0) {
        breakdownEl.innerHTML = '<div class="empty" style="padding:24px;">还没有任何资产。点下方"记一笔"开始记账。</div>';
      } else {
        breakdownEl.innerHTML = `
          <div class="alloc-block">
            <div class="alloc-title">📊 资产分布 (共 ${fmtMoney(totalAssets)})</div>
            ${parts.map(p => {
              const pct = (p.val / totalAssets * 100).toFixed(1);
              return `
                <div class="alloc-row">
                  <span class="alloc-label">${p.icon} ${p.label}</span>
                  <span class="alloc-cur"><strong>${fmtMoney(p.val)}</strong> (${pct}%)</span>
                  <div style="grid-column: span 2;">
                    <div style="height:6px;background:var(--bg-base);border-radius:3px;overflow:hidden;margin-top:4px;">
                      <div style="height:100%;width:${pct}%;background:${p.color};"></div>
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
            ${totalCost > 0 ? `
              <div class="alloc-hint">
                累计投入: ${fmtMoney(totalCost)} · 累计盈亏: <span class="${pctClass(totalPLPct)}">${fmtMoney(totalPL)} (${fmtPct(totalPLPct)})</span>
              </div>
            ` : ''}
          </div>
        `;
      }

      // === 持仓明细 ===
      const detailRows = [];
      for (const r of stockRows) {
        detailRows.push(`
          <tr>
            <td><span class="code">${escapeHtml(r.h.code)}</span></td>
            <td>${escapeHtml(r.h.name || '')}</td>
            <td>${fmtNum(r.shares, 0)}</td>
            <td>${r.cost.toFixed(3)}</td>
            <td>${r.price ? r.price.toFixed(2) : '-'}</td>
            <td>${r.mkt !== null ? fmtMoney(r.mkt) : '-'}</td>
            <td class="${pctClass(r.pl !== null ? (r.pl / r.costTotal) : 0)}">${r.pl !== null ? fmtMoney(r.pl) : '-'}</td>
          </tr>
        `);
      }
      for (const r of fundRows) {
        detailRows.push(`
          <tr>
            <td><span class="code">${escapeHtml(r.f.code)}</span></td>
            <td>${escapeHtml(r.f.name || '')}</td>
            <td>${fmtNum(r.shares, 2)}</td>
            <td>${r.costNav.toFixed(4)}</td>
            <td>${r.nav ? r.nav.toFixed(4) : '-'}</td>
            <td>${r.mkt !== null ? fmtMoney(r.mkt) : '-'}</td>
            <td class="${pctClass(r.pl !== null ? (r.pl / r.costTotal) : 0)}">${r.pl !== null ? fmtMoney(r.pl) : '-'}</td>
          </tr>
        `);
      }

      flowEl.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin:8px 0;">
          <div style="font-size:13px;color:var(--text-muted);">
            💵 现金流水: 存入 ${fmtMoney(deposits)} · 取出 ${fmtMoney(withdraws)} · 分红 ${fmtMoney(dividends)}
          </div>
          <button class="btn btn-sm btn-primary" onclick="Account.addFlow()">+ 记一笔</button>
        </div>
      `;

      if (detailRows.length === 0) {
        historyEl.innerHTML = '<div class="empty" style="padding:16px;">还没有任何持仓。<br><a href="javascript:switchPage(\'pageHoldings\')">去持仓页加 →</a> 或 <a href="javascript:switchPage(\'pageFund\')">去基金页加 →</a></div>';
      } else {
        historyEl.innerHTML = `
          <table>
            <thead>
              <tr>
                <th>代码</th><th>名称</th><th>份额</th><th>成本</th><th>现价/净值</th><th>市值</th><th>盈亏</th>
              </tr>
            </thead>
            <tbody>${detailRows.join('')}</tbody>
          </table>
        `;
      }

      // === 流水明细 ===
      const sortedFlow = [...flow].sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, 20);
      if (sortedFlow.length === 0) {
        document.getElementById('accountFlowList').innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:8px 0;">还没有流水记录</div>';
      } else {
        document.getElementById('accountFlowList').innerHTML = `
          <table>
            <thead>
              <tr><th>日期</th><th>类型</th><th>标的</th><th>金额</th><th>备注</th><th></th></tr>
            </thead>
            <tbody>
              ${sortedFlow.map(f => `
                <tr>
                  <td>${escapeHtml(f.date || '')}</td>
                  <td>${this._typeLabel(f.type)}</td>
                  <td>${escapeHtml(f.target || '-')}</td>
                  <td class="${(f.amount || 0) >= 0 ? 'up' : 'down'}">${(f.amount || 0) >= 0 ? '+' : ''}${fmtMoney(f.amount || 0)}</td>
                  <td>${escapeHtml(f.note || '')}</td>
                  <td><button class="btn btn-sm" onclick="Account.removeFlow('${f.id}')">✕</button></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      }
    },

    _typeLabel(t) {
      return {
        deposit: '💵 存入',
        withdraw: '💸 取出',
        dividend: '🎁 分红',
        fee: '💳 费用',
        transfer: '🔄 转账'
      }[t] || t;
    },

    async editCash() {
      const cur = Core.State.get('accountCash') || 0;
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Account.closeModal()">
          <div class="modal">
            <h3>编辑现金余额</h3>
            <div class="form-row">
              <label>现金余额 (元)</label>
              <input type="number" id="acCash" value="${cur}" step="100">
            </div>
            <div style="font-size:11px;color:var(--text-muted);">
              现金 = 银行活期/货币基金/未投入股市的钱
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Account.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Account.saveCash()">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async saveCash() {
      const v = parseFloat(document.getElementById('acCash').value);
      if (isNaN(v) || v < 0) { toastError('金额必须 ≥ 0'); return; }
      Core.State.set('accountCash', v);
      this.closeModal();
      toastSuccess('已保存');
      this.render();
    },

    async addFlow() {
      const today = new Date().toISOString().slice(0, 10);
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Account.closeModal()">
          <div class="modal">
            <h3>记一笔</h3>
            <div class="form-row">
              <label>类型</label>
              <select id="afType">
                <option value="deposit">💵 存入 (银行→投资账户)</option>
                <option value="withdraw">💸 取出 (投资→银行)</option>
                <option value="dividend">🎁 分红 (基金/股票派息)</option>
                <option value="fee">💳 费用 (管理费/手续费)</option>
                <option value="transfer">🔄 转账 (内部)</option>
              </select>
            </div>
            <div class="form-row">
              <label>日期</label>
              <input type="date" id="afDate" value="${today}">
            </div>
            <div class="form-row">
              <label>金额 (正=入账, 负=出账)</label>
              <input type="number" id="afAmount" step="0.01" placeholder="10000">
            </div>
            <div class="form-row">
              <label>标的 (可选)</label>
              <input type="text" id="afTarget" placeholder="例: 007194 / 600519 / 银行卡">
            </div>
            <div class="form-row">
              <label>备注</label>
              <input type="text" id="afNote" placeholder="可选">
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Account.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Account.saveFlow()">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async saveFlow() {
      const type = document.getElementById('afType').value;
      const date = document.getElementById('afDate').value;
      const amount = parseFloat(document.getElementById('afAmount').value);
      const target = document.getElementById('afTarget').value.trim();
      const note = document.getElementById('afNote').value.trim();
      if (!date) { toastError('请填日期'); return; }
      if (isNaN(amount)) { toastError('请填金额'); return; }
      // deposit/withdraw 自动正负号
      let signed = amount;
      if (type === 'withdraw' || type === 'fee') signed = -Math.abs(amount);
      if (type === 'deposit' || type === 'dividend') signed = Math.abs(amount);

      const rec = {
        id: uuid(),
        type, date,
        amount: signed,
        target, note,
        createdAt: Date.now()
      };
      await Core.Storage.add('cashflow', rec);
      this.closeModal();
      toastSuccess('已记录');
      this.render();
    },

    async removeFlow(id) {
      if (!confirm('确定删除这条流水?')) return;
      await Core.Storage.remove('cashflow', id);
      toastSuccess('已删除');
      this.render();
    },

    closeModal() {
      document.getElementById('modalRoot').innerHTML = '';
    }
  };

  window.Account = Account;
  window._onShow_pageAccount = function() {
    Account.render();
    if (window.MarketBar) MarketBar.mount('pageAccount', 'wide');
  };
})();
