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
            <button class="btn btn-sm" title="让 AI 给这只持仓设盯盘规则" onclick="Holdings._aiSuggestForOne('${escapeHtml(r.h.id)}')">🪄</button>
            <button class="btn btn-sm" title="跳券商 App 查看 / 交易" onclick="Holdings.brokerDialog('${escapeHtml(r.h.code)}','${escapeHtml(r.h.name || r.s?.名称 || '')}')">📱</button>
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

    /**
     * 让 AI 给单只持仓生成盯盘规则建议
     * 复用 Alerts.aiAssistantDialog, 预填 textarea 让用户改写或直接让 AI 解析
     */
    async _aiSuggestForOne(id) {
      const list = await Core.Storage.all('holdings');
      const h = list.find(x => x.id === id);
      if (!h) { if (window.toastError) toastError('找不到这只持仓'); return; }
      const code = h.code;
      const name = h.name || code;
      // 复用 alerts 弹窗, 预填 "给 600519 加一条财报披露前 3 天提醒"
      await Alerts.aiAssistantDialog();
      const ta = document.getElementById('aaInput');
      if (ta) {
        ta.value = `给 ${code} (${name}) 加一条财报披露前 3 天提醒`;
        ta.focus();
      }
    },

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
    },

    /**
     * 券商 App 跳转弹窗
     * 4 个常用券商: 同花顺 / 华泰 / 东方财富 / 雪球
     * 自动识别代码前缀: sh6/sz0/sz3 → 不同券商深度链接格式略不同, 这里全部用 web 详情页, 跨平台可用
     */
    brokerDialog(code, name) {
      const codeFull = code;
      const market = code.startsWith('6') ? 'SH' : code.startsWith('0') || code.startsWith('3') ? 'SZ' : '';
      const codeWithPrefix = market ? `${codeFull}.${market}` : codeFull;

      const links = [
        {
          name: '同花顺',
          icon: '📊',
          desc: 'A股老牌, 散户最爱',
          url: `https://stockpage.10jqka.com.cn/${codeFull}/`,
          mobile: `thsapp://stock/quote?code=${codeWithPrefix}`
        },
        {
          name: '东方财富',
          icon: '📈',
          desc: '行情 + 资讯最全',
          url: `https://quote.eastmoney.com/${codeFull}.html`,
          mobile: `emstock://quote?code=${codeWithPrefix}`
        },
        {
          name: '雪球',
          icon: '❄️',
          desc: '社区 + 大 V 分析',
          url: `https://xueqiu.com/S/${codeFull}`,
          mobile: `xueqiu://stock/${codeWithPrefix}`
        },
        {
          name: '华泰证券',
          icon: '🦁',
          desc: '涨乐财富通, 大券商',
          url: `https://www.htsc.com.cn`,
          mobile: `zlsgphapp://stock?code=${codeWithPrefix}`
        }
      ];

      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Holdings.closeModal()">
          <div class="modal" style="max-width:520px;width:100%;">
            <h3>📱 跳券商 App - ${escapeHtml(code)} ${escapeHtml(name || '')}</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
              ⚠ app <b>不能</b>直接交易 (合规要求)。<br>
              点下方链接 → 新窗口打开券商详情页 → 用户手动买卖 → 回来点 <b>+T</b> 录入实际成交
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;">
              ${links.map(l => `
                <a href="${escapeHtml(l.url)}" rel="noopener noreferrer" class="btn" style="justify-content:flex-start;text-align:left;" onclick="(function(u){if(window.Fund&&Fund._openExternal){Fund._openExternal(u);return false;}window.open(u,'_blank','noopener,noreferrer');return false;})('${escapeHtml(l.url)}')">
                  <span style="font-size:20px;margin-right:8px;">${l.icon}</span>
                  <span style="flex:1;">
                    <strong>${escapeHtml(l.name)}</strong>
                    <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(l.desc)}</div>
                  </span>
                  <span style="font-size:14px;color:var(--text-muted);">↗</span>
                </a>
              `).join('')}
            </div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:12px;line-height:1.6;">
              💡 <b>提示</b>:<br>
              • 移动端优先安装券商 App, 用 <code>zlsgphapp://</code> 这种深度链接直接打开那只股<br>
              • 桌面浏览器打开的是 web 详情页, 需登录券商账号才能交易<br>
              • 买/卖完务必回 app 点 <b>+T</b> 录入, 否则持仓对不上
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Holdings.closeModal()">关闭</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    /**
     * 账户余额对账
     * 用户手动输入券商 App 显示的"总资产"或"持仓市值+现金"
     * app 跟自身计算的"总市值(持仓按现价)+现金"对比
     * 偏差 > 50 元 → 提示"可能有漏录交易"
     */
    async reconcileDialog() {
      // 拉所有 holdings + cashflow
      const holdings = (await Core.Storage.all('holdings')).filter(h => !h.isPaper);
      const cashflows = await Core.Storage.all('cashflow');

      // app 自身计算: 总市值 + 现金
      let appValue = 0, appCash = 0;
      try {
        const spot = await Core.Data.getStockSpot();
        const spotMap = {};
        spot.forEach(s => { spotMap[s.代码] = s; });
        holdings.forEach(h => {
          const s = spotMap[h.code];
          const price = s ? parseFloat(s.最新价) : null;
          const shares = parseFloat(h.shares) || 0;
          if (price) appValue += shares * price;
        });
      } catch (e) { console.warn('[Holdings] 行情拉取失败:', e); }
      // 现金 = 所有 cashflow 净额(正=收入,负=支出)
      cashflows.forEach(f => { appCash += parseFloat(f.amount) || 0; });
      const appTotal = appValue + appCash;

      // 上次校准时间 + 上次校准值
      const last = await Core.Storage.kvGet('holdings_last_reconcile') || {};

      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Holdings.closeModal()">
          <div class="modal" style="max-width:480px;">
            <h3>⚖️ 账户对账</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.6;">
              把券商 App 显示的 <b>总资产</b> 数字输进来, app 自动对比自算值<br>
              偏差大 → 提示可能有漏录交易<br>
              <span style="font-size:11px;">💡 合规要求, 不能直连券商, 所以每天手动输一次, 1 分钟搞定</span>
            </div>

            <div style="background:var(--bg-base);padding:10px;border-radius:6px;margin-bottom:12px;font-size:13px;line-height:1.7;">
              <div>📊 <b>app 自算</b>: ${fmtMoney(appValue)} (持仓市值)</div>
              <div>💵 <b>现金</b>: ${fmtMoney(appCash)} (cashflow 净额)</div>
              <div style="border-top:1px solid var(--border);margin-top:6px;padding-top:6px;">
                <b>总计</b>: <span style="color:var(--accent);font-size:15px;">${fmtMoney(appTotal)}</span>
              </div>
            </div>

            <div class="form-row">
              <label>券商 App 总资产 (元)</label>
              <input type="number" id="reconcileBrokerTotal" step="0.01" placeholder="例: 51823.56">
              <div style="font-size:11px;color:var(--text-muted);">打开券商 App → 资产总览 → 复制数字</div>
            </div>
            <div class="form-row">
              <label>对账日期</label>
              <input type="date" id="reconcileDate" value="${new Date().toISOString().slice(0,10)}">
            </div>
            <div class="form-row">
              <label>备注 (可选)</label>
              <input type="text" id="reconcileNote" placeholder="例: 今天有笔国债逆回购到账">
            </div>

            <div id="reconcilePreview" style="background:var(--bg-base);padding:10px;border-radius:4px;margin:8px 0;font-size:12px;line-height:1.6;">
              填完数字自动算偏差
            </div>

            ${last.date ? `
              <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
                上次对账: ${escapeHtml(last.date)} · 当时偏差 ${fmtMoney(last.diff || 0)}
              </div>
            ` : ''}

            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Holdings.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Holdings.reconcileSave()">✓ 保存对账</button>
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
        const broker = parseFloat(document.getElementById('reconcileBrokerTotal')?.value);
        const el = document.getElementById('reconcilePreview');
        if (!el) return;
        if (isNaN(broker)) { el.textContent = '填完数字自动算偏差'; return; }
        const diff = broker - this._reconcileAppTotal;
        const absDiff = Math.abs(diff);
        let status, color;
        if (absDiff < 50) {
          status = '✅ 完全对得上 (偏差 < 50 元, 可能是取整)';
          color = 'var(--up)';
        } else if (absDiff < 500) {
          status = '⚠️ 轻微偏差, 检查今日是否有手续费/分红漏录';
          color = 'var(--text-muted)';
        } else if (diff > 0) {
          status = `❌ 券商比 app 多 ${fmtMoney(diff)}, 可能漏录了 ${fmtMoney(diff)} 的买入或漏算资金到账`;
          color = 'var(--down)';
        } else {
          status = `❌ 券商比 app 少 ${fmtMoney(-diff)}, 可能多录了 ${fmtMoney(-diff)} 或漏算卖出`;
          color = 'var(--down)';
        }
        el.innerHTML = `
          <b>偏差</b>: <span style="color:${color};font-size:15px;">${fmtMoney(diff)}</span><br>
          <span style="color:${color};">${status}</span>
        `;
      };
      const input = document.getElementById('reconcileBrokerTotal');
      if (input) input.addEventListener('input', upd);
      upd();
    },

    async reconcileSave() {
      const broker = parseFloat(document.getElementById('reconcileBrokerTotal').value);
      const date = document.getElementById('reconcileDate').value;
      const note = document.getElementById('reconcileNote').value.trim();
      if (isNaN(broker)) { toastError('填券商总资产数字'); return; }
      if (!date) { toastError('填日期'); return; }
      const diff = broker - this._reconcileAppTotal;

      const rec = {
        date,
        brokerTotal: broker,
        appTotal: this._reconcileAppTotal,
        diff,
        note,
        createdAt: Date.now()
      };
      // 存进 kv (kvSet), 滚动保留最近 30 条
      const list = (await Core.Storage.kvGet('holdings_reconcile_log')) || [];
      list.push(rec);
      if (list.length > 30) list.shift();
      await Core.Storage.kvSet('holdings_reconcile_log', list);
      await Core.Storage.kvSet('holdings_last_reconcile', { date, diff });

      this.closeModal();
      const abs = Math.abs(diff);
      if (abs < 50) {
        toastSuccess(`✅ 对账通过, 偏差 ${fmtMoney(diff)}`);
      } else if (abs < 500) {
        toastSuccess(`对账已记录, 偏差 ${fmtMoney(diff)}, 请检查手续费/分红`);
      } else {
        toastError(`偏差 ${fmtMoney(diff)} 较大, 已记录. 请检查今日交易是否漏录`);
      }
      this.render();
    }
  };

  window.Holdings = Holdings;
  window._onShow_pageHoldings = function() { Holdings.render(); };
})();
