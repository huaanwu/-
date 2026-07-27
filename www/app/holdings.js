/**
 * Holdings - 持仓管理
 * 持仓(组合) + 交易记录 + 实时盈亏
 */
(function() {
  'use strict';

  const Holdings = {

    async init() {},

    async render() {
      const holdings = await Core.Storage.all('holdings');
      const summaryEl = document.getElementById('holdingsSummary');
      const tableEl = document.getElementById('holdingsTable');

      if (!holdings || holdings.length === 0) {
        summaryEl.innerHTML = '';
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">💼</div>
            <div>还没有持仓</div>
            <div style="margin-top:8px;font-size:12px;">点击"新建"记录第一笔交易</div>
          </div>
        `;
        return;
      }

      // 拉行情
      let spotMap = {};
      try {
        const spot = await Core.Data.getStockSpot();
        spot.forEach(s => { spotMap[s.代码] = s; });
      } catch (e) {
        console.warn('[Holdings] 行情拉取失败:', e);
      }

      // 汇总
      let totalCost = 0, totalValue = 0;
      const rows = holdings.map(h => {
        const s = spotMap[h.code];
        const currentPrice = s ? parseFloat(s.最新价) : null;
        const shares = parseFloat(h.shares) || 0;
        const costPrice = parseFloat(h.costPrice) || 0;
        const cost = shares * costPrice;
        const value = currentPrice ? shares * currentPrice : null;
        const pl = value !== null ? value - cost : null;
        const plPct = pl !== null && cost > 0 ? pl / cost : null;
        if (value !== null) {
          totalCost += cost;
          totalValue += value;
        }
        return { h, s, shares, costPrice, currentPrice, cost, value, pl, plPct };
      });

      const totalPL = totalValue - totalCost;
      const totalPLPct = totalCost > 0 ? totalPL / totalCost : 0;

      summaryEl.innerHTML = `
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
        <div class="summary-card">
          <div class="label">持仓数</div>
          <div class="value">${holdings.length}</div>
        </div>
      `;

      // 表格
      const tableRows = rows.map(r => `
        <tr>
          <td><span class="code">${escapeHtml(r.h.code)}</span><br><span style="color:var(--text-muted);font-size:11px;">${escapeHtml(r.h.name || r.s?.名称 || '')}</span></td>
          <td>${fmtNum(r.shares, 0)}</td>
          <td>${fmtNum(r.costPrice, 3)}</td>
          <td>${r.currentPrice ? fmtNum(r.currentPrice, 2) : '-'}</td>
          <td>${fmtMoney(r.cost)}</td>
          <td>${r.value !== null ? fmtMoney(r.value) : '-'}</td>
          <td class="${pctClass(r.plPct)}">
            ${r.pl !== null ? fmtMoney(r.pl) : '-'}<br>
            <span style="font-size:11px;">${r.plPct !== null ? fmtPct(r.plPct) : ''}</span>
          </td>
          <td>
            <button class="btn btn-sm" onclick="Holdings.addTxDialog('${escapeHtml(r.h.id)}')">+T</button>
            <button class="btn btn-sm" onclick="Holdings.editDialog('${escapeHtml(r.h.id)}')">✎</button>
            <button class="btn btn-sm" onclick="Holdings.remove('${escapeHtml(r.h.id)}')">✕</button>
          </td>
        </tr>
      `).join('');

      tableEl.innerHTML = `
        <table>
          <thead>
            <tr>
              <th>代码/名称</th><th>股数</th><th>成本价</th><th>现价</th>
              <th>成本</th><th>市值</th><th>盈亏</th><th>操作</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      `;
    },

    addDialog() { this._formDialog(null); },
    editDialog(id) { this._formDialog(id); },

    async _formDialog(id) {
      let h = { code: '', name: '', shares: '', costPrice: '', note: '' };
      if (id) {
        h = await Core.Storage.get('holdings', id);
        if (!h) { toastError('持仓不存在'); return; }
      }
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Holdings.closeModal()">
          <div class="modal">
            <h3>${id ? '编辑' : '新建'}持仓</h3>
            <div class="form-row">
              <label>代码</label>
              <input type="text" id="hCode" value="${escapeHtml(h.code)}" placeholder="600519" ${id ? 'readonly' : ''}>
            </div>
            <div class="form-row">
              <label>名称</label>
              <input type="text" id="hName" value="${escapeHtml(h.name || '')}" placeholder="可选">
            </div>
            <div class="form-row">
              <label>股数</label>
              <input type="number" id="hShares" value="${h.shares || ''}" placeholder="100" step="100">
            </div>
            <div class="form-row">
              <label>成本价</label>
              <input type="number" id="hCost" value="${h.costPrice || ''}" placeholder="1700.50" step="0.01">
            </div>
            <div class="form-row">
              <label>备注</label>
              <input type="text" id="hNote" value="${escapeHtml(h.note || '')}" placeholder="可选">
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Holdings.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Holdings.save('${id || ''}')">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async save(id) {
      const code = document.getElementById('hCode').value.trim();
      const name = document.getElementById('hName').value.trim();
      const shares = parseFloat(document.getElementById('hShares').value);
      const costPrice = parseFloat(document.getElementById('hCost').value);
      const note = document.getElementById('hNote').value.trim();
      if (!code || !/^\d{6}$/.test(code)) { toastError('代码必须 6 位'); return; }
      if (!shares || shares <= 0) { toastError('股数必须 > 0'); return; }
      if (!costPrice || costPrice <= 0) { toastError('成本价必须 > 0'); return; }
      const data = { code, name, shares, costPrice, note, updatedAt: Date.now() };
      if (id) {
        data.id = id;
        await Core.Storage.put('holdings', data);
      } else {
        data.id = uuid();
        data.createdAt = Date.now();
        await Core.Storage.add('holdings', data);
      }
      this.closeModal();
      toastSuccess('已保存');
      this.render();
    },

    async remove(id) {
      if (!confirm('确定删除此持仓?关联的交易记录也会删除')) return;
      await Core.Storage.remove('holdings', id);
      // 删关联交易
      const txs = await Core.Storage.where('transactions', 'holdingId', id);
      for (const tx of txs) {
        await Core.Storage.remove('transactions', tx.id);
      }
      toastSuccess('已删除');
      this.render();
    },

    /**
     * 添加交易记录(后续买入/卖出)
     */
    async addTxDialog(holdingId) {
      const h = await Core.Storage.get('holdings', holdingId);
      if (!h) return;
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Holdings.closeModal()">
          <div class="modal">
            <h3>添加交易 - ${escapeHtml(h.code)} ${escapeHtml(h.name || '')}</h3>
            <div class="form-row">
              <label>类型</label>
              <select id="txType">
                <option value="buy">买入</option>
                <option value="sell">卖出</option>
                <option value="dividend">分红</option>
              </select>
            </div>
            <div class="form-row">
              <label>日期</label>
              <input type="date" id="txDate" value="${fmtDate(new Date())}">
            </div>
            <div class="form-row">
              <label>价格</label>
              <input type="number" id="txPrice" step="0.01" placeholder="1700.50">
            </div>
            <div class="form-row">
              <label>数量</label>
              <input type="number" id="txShares" step="100" placeholder="100">
            </div>
            <div class="form-row">
              <label>理由/笔记</label>
              <textarea id="txNote" placeholder="为什么买/卖?"></textarea>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Holdings.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Holdings.saveTx('${holdingId}')">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async saveTx(holdingId) {
      const h = await Core.Storage.get('holdings', holdingId);
      if (!h) return;
      const tx = {
        id: uuid(),
        holdingId,
        code: h.code,
        type: document.getElementById('txType').value,
        date: document.getElementById('txDate').value,
        price: parseFloat(document.getElementById('txPrice').value),
        shares: parseFloat(document.getElementById('txShares').value),
        note: document.getElementById('txNote').value,
        createdAt: Date.now()
      };
      if (!tx.price || !tx.shares) { toastError('价格和数量必填'); return; }
      await Core.Storage.add('transactions', tx);

      // 简化:更新持仓的 shares/costPrice(加权平均)
      if (tx.type === 'buy') {
        const oldCost = h.shares * h.costPrice;
        const newCost = tx.shares * tx.price;
        const totalShares = h.shares + tx.shares;
        h.costPrice = (oldCost + newCost) / totalShares;
        h.shares = totalShares;
      } else if (tx.type === 'sell') {
        h.shares = Math.max(0, h.shares - tx.shares);
      }
      h.updatedAt = Date.now();
      await Core.Storage.put('holdings', h);

      this.closeModal();
      toastSuccess('已记录');
      this.render();
    },

    closeModal() {
      document.getElementById('modalRoot').innerHTML = '';
    }
  };

  window.Holdings = Holdings;
  window._onShow_pageHoldings = function() { Holdings.render(); };
})();
