/**
 * Holdings - 持仓管理
 * 持仓(组合) + 交易记录 + 实时盈亏
 */
(function() {
  'use strict';

  const Holdings = {

    async init() {},

    async render() {
      // Phase E: 待确认交易区 (持仓列表上方, 无待确认时不渲染)
      await this._renderPending();
      // 排除模拟盘 (isPaper) 行, 真实持仓视图不受 Paper 模块污染
      const holdings = (await Core.Storage.all('holdings')).filter(h => !h.isPaper);
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
            <button class="btn btn-sm" title="AI 简评" onclick="StockAdvisor.show('${escapeHtml(r.h.code)}','${escapeHtml(r.h.name || r.s?.名称 || '')}')">💡</button>
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

    // ========== Phase E: 实盘"待确认交易" (AI 建议 → 人确认 → 原有买入流程, 不绕过纪律) ==========

    /** 渲染页面顶部"📥 待确认交易"区块; 无 pending 卡片时清空不渲染 */
    async _renderPending() {
      const el = document.getElementById('pendingTrades');
      if (!el) return;
      if (!window.Core || !Core.Pending) { el.innerHTML = ''; return; }
      let list = [];
      try { list = await Core.Pending.list('pending'); }
      catch (e) { console.warn('[Holdings] 待确认交易读取失败:', e); }
      if (!list.length) { el.innerHTML = ''; return; }
      const now = Date.now();
      const cards = list.map(t => {
        const daysLeft = Math.max(0, Math.ceil((t.expireAt - now) / 86400000));
        const pmRows = [];
        if (t.reason) pmRows.push(`<div><strong>理由</strong>: ${escapeHtml(t.reason)}</div>`);
        if (t.assumption) pmRows.push(`<div><strong>买入假设</strong>: ${escapeHtml(t.assumption)}${t.stopLoss ? ` · <strong>止损价</strong>: ${escapeHtml(String(t.stopLoss))}` : ''}</div>`);
        if (t.falsifyCondition) pmRows.push(`<div><strong>证伪条件</strong>: ${escapeHtml(t.falsifyCondition)}</div>`);
        if (t.invalidation) pmRows.push(`<div><strong>失效条件</strong>: ${escapeHtml(t.invalidation)}</div>`);
        return `
          <div class="pending-card" style="border:1px solid var(--border, #30363d);border-radius:6px;padding:10px;margin-bottom:8px;">
            <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px;">
              <span><strong>${escapeHtml(t.code)} ${escapeHtml(t.name || '')}</strong></span>
              <span style="font-size:12px;color:var(--text-muted);">
                建议买入 ${fmtNum(t.suggestedShares, 0)} 股 ≈ ${fmtMoney(t.suggestedAmount)}
                · 来源: ${escapeHtml(t.source)} · 剩余 ${daysLeft} 天
              </span>
            </div>
            <details style="margin:6px 0;font-size:12px;color:var(--text-muted);">
              <summary style="cursor:pointer;">理由 / Pre-mortem</summary>
              <div style="margin-top:4px;line-height:1.6;">${pmRows.join('') || '(无)'}</div>
            </details>
            <div>
              <button class="btn btn-sm btn-primary" onclick="Holdings.confirmPending('${escapeHtml(t.id)}')">✅ 确认买入</button>
              <button class="btn btn-sm" onclick="Holdings.ignorePending('${escapeHtml(t.id)}')">✖ 忽略</button>
            </div>
          </div>
        `;
      }).join('');
      el.innerHTML = `
        <div class="data-card" style="margin-bottom:12px;">
          <div style="font-weight:bold;margin-bottom:8px;">📥 待确认交易
            <span style="font-weight:normal;font-size:12px;color:var(--text-muted);">(AI 建议, 确认后走正常买入流程, 含纪律检查)</span>
          </div>
          ${cards}
        </div>
      `;
    },

    /**
     * ✅ 确认买入: 只打开买入表单并预填, 不直接改卡片状态
     * 实际成交成功 (save/saveTx 落库) 后才标 confirmed; 用户放弃保存则保持 pending
     */
    async confirmPending(id) {
      const t = await Core.Pending.get(id);
      if (!t || t.status !== 'pending') { toastWarning('该卡片已处理'); this._renderPending(); return; }
      // 预填成本价: 拉实时现价, 失败回退建议均价
      let price = 0;
      try {
        const q = await Core.Data.getStockQuote(t.code);
        price = q ? (parseFloat(q.最新价 ?? q.price) || 0) : 0;
      } catch (e) { console.warn('[Holdings] 待确认交易拉行情失败:', t.code, e); }
      if (!price && t.suggestedShares > 0) price = +(t.suggestedAmount / t.suggestedShares).toFixed(2);
      const prefill = {
        pendingId: id, code: t.code, name: t.name,
        shares: t.suggestedShares || '', costPrice: price || '',
        assumption: t.assumption || '', stopLoss: t.stopLoss || '',
        reason: t.reason || ''
      };
      // 已有同 code 实盘持仓 → 走"添加交易"加仓表单, 否则新建持仓表单
      const existing = ((await Core.Storage.all('holdings')) || []).find(h => !h.isPaper && h.code === t.code);
      if (existing) this.addTxDialog(existing.id, prefill);
      else this._formDialog(null, prefill);
    },

    /** ✖ 忽略: 只改卡片状态 */
    async ignorePending(id) {
      await Core.Pending.ignore(id);
      toastSuccess('已忽略');
      this._renderPending();
    },

    async _formDialog(id, prefill) {
      let h = { code: '', name: '', shares: '', costPrice: '', note: '' };
      if (id) {
        h = await Core.Storage.get('holdings', id);
        if (!h) { toastError('持仓不存在'); return; }
      }
      // Phase E: 从待确认卡片进入时预填 (仅新建场景), 并记住卡片 id 待成交后标 confirmed
      this._pendingConfirmId = (!id && prefill && prefill.pendingId) || null;
      if (!id && prefill) {
        h = { code: prefill.code || '', name: prefill.name || '', shares: prefill.shares || '',
              costPrice: prefill.costPrice || '', note: prefill.reason || '' };
      }
      const preAssumption = (!id && prefill && prefill.assumption) || '';
      const preStopLoss = (!id && prefill && prefill.stopLoss) || '';
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
            ${!id ? `
            <div class="form-row">
              <label>买入假设</label>
              <select id="hAssumption">
                <option value="">(必选)</option>
                ${Core.Discipline.ASSUMPTIONS.map(a => `<option value="${a}" ${a === preAssumption ? 'selected' : ''}>${a}</option>`).join('')}
              </select>
            </div>
            <div class="form-row">
              <label>止损价</label>
              <input type="number" id="hStopLoss" step="0.01" min="0" placeholder="必填, 低于成本价" value="${preStopLoss}">
            </div>
            <div id="hCheckResult"></div>
            ` : ''}
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
        // Phase B 交易纪律: 新建持仓 = 一笔买入, 先过硬校验 (blocks 拦截 / warns 确认放行)
        const assumption = document.getElementById('hAssumption').value;
        const stopLoss = parseFloat(document.getElementById('hStopLoss').value);
        const chk = await Core.Discipline.preBuyCheck({
          code, name, market: Core.Util.stockCodePrefix(code),
          price: costPrice, shares, amount: shares * costPrice,
          isPaper: false, assumption, stopLoss
        });
        if (!chk.ok) {
          document.getElementById('hCheckResult').innerHTML = Core.Discipline.renderCheckResult(chk);
          toastError('交易纪律检查未通过, 已拦截');
          return;
        }
        if (chk.warns.length && !confirm(Core.Discipline._resultToText(chk) + '\n\n确认继续买入?')) return;
        data.assumption = assumption;  // 非索引字段, 不改 schema
        data.stopLoss = stopLoss;
        data.id = uuid();
        data.createdAt = Date.now();
        await Core.Storage.add('holdings', data);
        await this._markPendingConfirmed();  // Phase E: 成交成功后才标 confirmed
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
     * @param {string} holdingId
     * @param {object} [prefill] Phase E: 待确认卡片预填 { pendingId, shares, costPrice, assumption, stopLoss, reason }
     */
    async addTxDialog(holdingId, prefill) {
      const h = await Core.Storage.get('holdings', holdingId);
      if (!h) return;
      // Phase E: 从待确认卡片进入时记住卡片 id, 成交成功后才标 confirmed
      this._pendingConfirmId = (prefill && prefill.pendingId) || null;
      const preAssumption = (prefill && prefill.assumption) || '';
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
              <input type="number" id="txPrice" step="0.01" placeholder="1700.50" value="${(prefill && prefill.costPrice) || ''}">
            </div>
            <div class="form-row">
              <label>数量</label>
              <input type="number" id="txShares" step="100" placeholder="100" value="${(prefill && prefill.shares) || ''}">
            </div>
            <div class="form-row">
              <label>理由/笔记</label>
              <textarea id="txNote" placeholder="为什么买/卖?">${escapeHtml((prefill && prefill.reason) || '')}</textarea>
            </div>
            <div class="form-row">
              <label>买入假设</label>
              <select id="txAssumption">
                <option value="">(买入必选)</option>
                ${Core.Discipline.ASSUMPTIONS.map(a => `<option value="${a}" ${a === preAssumption ? 'selected' : ''}>${a}</option>`).join('')}
              </select>
            </div>
            <div class="form-row">
              <label>止损价</label>
              <input type="number" id="txStopLoss" step="0.01" min="0" placeholder="买入必填, 低于价格" value="${(prefill && prefill.stopLoss) || ''}">
            </div>
            <div id="txCheckResult"></div>
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

      // Phase B 交易纪律: 买入先过硬校验 (卖出永远放行)
      if (tx.type === 'buy') {
        const assumption = document.getElementById('txAssumption').value;
        const stopLoss = parseFloat(document.getElementById('txStopLoss').value);
        const chk = await Core.Discipline.preBuyCheck({
          code: h.code, name: h.name || '', market: h.market || '',
          price: tx.price, shares: tx.shares, amount: tx.price * tx.shares,
          isPaper: false, assumption, stopLoss
        });
        if (!chk.ok) {
          document.getElementById('txCheckResult').innerHTML = Core.Discipline.renderCheckResult(chk);
          toastError('交易纪律检查未通过, 已拦截');
          return;
        }
        if (chk.warns.length && !confirm(Core.Discipline._resultToText(chk) + '\n\n确认继续买入?')) return;
        tx.assumption = assumption;  // 非索引字段, 不改 schema
        tx.stopLoss = stopLoss;
        h.assumption = assumption;   // 同步到持仓行
        h.stopLoss = stopLoss;
      }
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

      // Phase E: 买入成交成功后才标 confirmed (卖出/分红不关卡片)
      if (tx.type === 'buy') await this._markPendingConfirmed();

      this.closeModal();
      toastSuccess('已记录');
      this.render();
    },

    /** Phase E: 成交成功后把来源待确认卡片标 confirmed (无来源卡片则空转) */
    async _markPendingConfirmed() {
      if (!this._pendingConfirmId || !window.Core || !Core.Pending) return;
      const pid = this._pendingConfirmId;
      this._pendingConfirmId = null;
      try { await Core.Pending.confirm(pid); }
      catch (e) { console.warn('[Holdings] 待确认卡片状态更新失败:', e); }
    },

    closeModal() {
      this._pendingConfirmId = null;  // 放弃保存: 卡片保持 pending
      document.getElementById('modalRoot').innerHTML = '';
    }
  };

  window.Holdings = Holdings;
  window._onShow_pageHoldings = function() { Holdings.render(); };
})();
