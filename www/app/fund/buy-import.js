/**
 * Fund.BuyImport - 申购计划 + 快速登记
 *
 * buyDialog: 跳第三方 (天天/支付宝/蛋卷) → 用户买完 → 用 quickImport 加到持仓
 * quickImport: 输金额 + 净值 → 自动算份额 → 写入 funds 表
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  let _qiPre = null;  // quickImport 预填: { code, name, type, ... }

  /**
   * 申购计划 - 显示多个基金的快速购买链接
   * 跳转到第三方 (天天/支付宝/蛋卷) → 用户买完 → 用 快速登记 加到持仓
   */
  window.Fund.buyDialog = function(specificCode) {
    // 候选基金: 用户的自选 + 推荐组合
    const list = [];
    // 从 ai_seed.json 拿
    fetch('/fund_ai_seed.json').then(r => r.json()).then(seed => {
      if (specificCode) {
        // 指定了 code: 只显示那一个
        const found = seed.candidates.find(c => c.code === specificCode);
        if (found) {
          list.push(found);
        } else {
          list.push({ code: specificCode, name: '(查不到, 直接搜吧)', category: 'short_bond' });
        }
      } else {
        // 没指定: 显示推荐组合的 2 只
        list.push(seed.candidates.find(c => c.code === '007194'));
        list.push(seed.candidates.find(c => c.code === '018581'));
      }
      this._renderBuyDialog(list);
    }).catch(e => {
      toastError('加载候选失败: ' + e.message);
      // 退化: 只显示一个
      this._renderBuyDialog([{ code: specificCode || '007194', name: '长城短债 A', category: 'short_bond' }]);
    });
  };

  window.Fund._renderBuyDialog = function(funds) {
    const html = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:680px;width:100%;">
          <h3>🛒 申购计划</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
            ⚠ app <b>不能</b>直接买卖基金 (没有基金销售牌照)。<br>
            点下方按钮跳到第三方平台 → 登录 → 买入 → 回来点 <b>📥 快速登记</b> 把数据导进来
          </div>
          ${funds.map(f => `
            <div class="ai-pick" style="margin-bottom:8px;">
              <div class="ai-pick-head">
                <strong>${escapeHtml(f.code)} ${escapeHtml(f.name || '')}</strong>
                <span class="tag">${this._typeLabel(f.category || '')}</span>
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
                <a href="https://fund.eastmoney.com/${escapeHtml(f.code)}.html" target="_blank" rel="noopener" class="btn btn-sm btn-primary">🛒 天天基金 (H5)</a>
                <a href="https://danjuanapp.com/fund/${escapeHtml(f.code)}" target="_blank" rel="noopener" class="btn btn-sm">🥚 蛋卷基金</a>
                <a href="https://fund.10jqka.com.cn/${escapeHtml(f.code)}" target="_blank" rel="noopener" class="btn btn-sm">📈 同花顺</a>
                <button class="btn btn-sm btn-ghost" onclick="Fund.quickImport('${escapeHtml(f.code)}','${escapeHtml((f.name || '').replace(/'/g, "\\'"))}')">📥 快速登记</button>
              </div>
            </div>
          `).join('')}
          <div style="font-size:11px;color:var(--text-muted);margin-top:12px;line-height:1.5;">
            💡 <b>常用平台费率</b> (买 1 万对比):<br>
            • 天天基金: 0.1% 申购费 = <b>10 元</b> (1 折, 推荐)<br>
            • 支付宝 / 蚂蚁基金: 0.1% = 10 元<br>
            • 蛋卷 / 雪球: 0.1% = 10 元<br>
            • 银行 App: <b>1.5% = 150 元</b> (贵 15 倍, 别用)
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('modalRoot').innerHTML = html;
  };

  /**
   * 快速登记 - 申购完成后填数字进来
   * 输金额 + 净值 → 自动算份额 → 写入 funds 表
   */
  window.Fund.quickImport = function(code, name) {
    // 如果基金已在 self 列表, 预填名字
    Core.Storage.get('funds', code).then(existing => {
      const prefill = existing || { code, name, shares: 0, costNav: 0 };
      const today = new Date().toISOString().slice(0, 10);
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:480px;">
            <h3>📥 快速登记 - ${escapeHtml(code)}</h3>
            <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
              ${escapeHtml(name || '')} - 填实际申购信息, 自动算份额加进持仓
            </div>
            <div class="form-row">
              <label>申购日期</label>
              <input type="date" id="qiDate" value="${today}">
            </div>
            <div class="form-row">
              <label>申购金额 (元)</label>
              <input type="number" id="qiAmount" value="10000" step="100">
            </div>
            <div class="form-row">
              <label>申购费率 (%)</label>
              <input type="number" id="qiFee" value="0.1" step="0.01">
              <div style="font-size:11px;color:var(--text-muted);">天天/支付宝/蛋卷 0.1% · 银行 1.5%</div>
            </div>
            <div class="form-row">
              <label>确认净值 (T+1 公布的净值)</label>
              <input type="number" id="qiNav" step="0.0001" placeholder="例: 1.0456">
              <div style="font-size:11px;color:var(--text-muted);">在 第三方 App 的"持仓"里能看到</div>
            </div>
            <div id="qiPreview" style="background:var(--bg-base);padding:10px;border-radius:4px;margin:8px 0;font-size:12px;line-height:1.6;">
              填完金额+净值自动算
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Fund.quickImportSave()">✓ 登记并加入持仓</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
      _qiPre = prefill;
      this._bindQuickImportCalc();
    });
  };

  window.Fund._bindQuickImportCalc = function() {
    const upd = () => {
      const amt = parseFloat(document.getElementById('qiAmount')?.value);
      const fee = parseFloat(document.getElementById('qiFee')?.value) || 0;
      const nav = parseFloat(document.getElementById('qiNav')?.value);
      const el = document.getElementById('qiPreview');
      if (!el) return;
      if (isNaN(amt) || isNaN(nav) || nav <= 0) {
        el.textContent = '填完金额+净值自动算';
        return;
      }
      const feeMoney = amt * fee / 100;
      const netAmt = amt - feeMoney;
      const shares = netAmt / nav;
      el.innerHTML = `
        <b>实际扣款</b>: ${amt.toFixed(2)} 元 (含 ${feeMoney.toFixed(2)} 元手续费)<br>
        <b>确认份额</b>: <span style="color:var(--accent);font-size:14px;">${shares.toFixed(2)} 份</span><br>
        <b>成本净值</b>: ${nav.toFixed(4)} 元/份<br>
        <b>手续费率</b>: ${fee}%
      `;
    };
    ['qiAmount', 'qiFee', 'qiNav'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', upd);
    });
    upd();
  };

  window.Fund.quickImportSave = async function() {
    const code = _qiPre?.code;
    if (!code) { toastError('内部错误, 请重试'); return; }
    const date = document.getElementById('qiDate').value;
    const amount = parseFloat(document.getElementById('qiAmount').value);
    const feePct = parseFloat(document.getElementById('qiFee').value) || 0;
    const nav = parseFloat(document.getElementById('qiNav').value);
    if (!date) { toastError('填日期'); return; }
    if (isNaN(amount) || amount <= 0) { toastError('金额要 > 0'); return; }
    if (isNaN(nav) || nav <= 0) { toastError('净值要 > 0'); return; }

    const feeMoney = amount * feePct / 100;
    const shares = (amount - feeMoney) / nav;
    const existing = await Core.Storage.get('funds', code);
    const rec = existing || { code, name: _qiPre.name || code, type: _qiPre.type || 'short_bond' };
    // 累加 (多次申购)
    const oldShares = parseFloat(rec.shares) || 0;
    const oldCost = oldShares * (parseFloat(rec.costNav) || 0);
    const newShares = oldShares + shares;
    const newCost = oldCost + (amount - feeMoney);  // 实际投入 (扣手续费)
    const newCostNav = newCost / newShares;  // 加权平均成本

    rec.shares = newShares;
    rec.costNav = newCostNav;
    rec.updatedAt = Date.now();
    if (!rec.addedAt) rec.addedAt = Date.now();
    await Core.Storage.put('funds', rec);

    // 同步写一条 cashflow
    const flowRec = {
      id: uuid(),
      date,
      type: 'transfer',  // 转账 (投入基金)
      amount: -(amount),  // 负 (从现金出)
      target: code,
      note: `申购 ${shares.toFixed(2)} 份, 净值 ${nav}, 费率 ${feePct}%`,
      createdAt: Date.now()
    };
    await Core.Storage.add('cashflow', flowRec);

    this.closeModal();
    toastSuccess(`已加入: ${shares.toFixed(2)} 份 (平均成本 ${newCostNav.toFixed(4)})`);
    this.render();
  };
})();