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
   * 唤起外部浏览器 (绕开 WebView 拦截)
   * - APK/Capacitor: window.Capacitor.Plugins.App.openUrl({url}) → 走系统浏览器
   * - 浏览器: 直接 window.open 即可
   * Capacitor 7+ App.openUrl 已 deprecated, 改用 Browser.open
   * @param {string} url
   */
  function _openExternal(url) {
    if (!url) return;
    // Capacitor (APK 走这里)
    if (window.Capacitor && window.Capacitor.Plugins) {
      const Cap = window.Capacitor.Plugins;
      // 优先 Browser 插件 (Capacitor 7+ 标准); 退回 App 插件
      const plugin = Cap.Browser || Cap.App;
      if (plugin && typeof plugin.openUrl === 'function') {
        try {
          plugin.openUrl({ url }).catch(e => {
            console.warn('[Fund] 唤起外部浏览器失败, 退化为 window.open:', e);
            window.open(url, '_blank', 'noopener,noreferrer');
          });
          return;
        } catch (e) { console.warn('[Fund] 唤起外部浏览器异常:', e); }
      }
    }
    // 浏览器 fallback
    try { window.open(url, '_blank', 'noopener,noreferrer'); }
    catch (e) { console.warn('[Fund] window.open 失败:', e); }
  }
  window.Fund._openExternal = _openExternal;

  /**
   * 申购计划 - 显示多个基金的快速购买链接
   * 跳转到第三方 (天天/支付宝/蛋卷) → 用户买完 → 用 快速登记 加到持仓
   */
  window.Fund.buyDialog = function(specificCode) {
    // 候选基金: 用户的自选 + 推荐组合
    const list = [];
    // 从 ai_seed.json 拿 (CLAUDE.md PWA 陷阱: cache:'no-store' 防 SW + 浏览器缓存拦截)
    fetch('/fund_ai_seed.json', { cache: 'no-store' }).then(r => r.json()).then(seed => {
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
                <a href="https://fund.eastmoney.com/${escapeHtml(f.code)}.html" rel="noopener noreferrer" class="btn btn-sm btn-primary" onclick="Fund._openExternal('https://fund.eastmoney.com/${escapeHtml(f.code)}.html');return false;">🛒 天天基金 (H5)</a>
                <a href="https://danjuanapp.com/fund/${escapeHtml(f.code)}" rel="noopener noreferrer" class="btn btn-sm" onclick="Fund._openExternal('https://danjuanapp.com/fund/${escapeHtml(f.code)}');return false;">🥚 蛋卷基金</a>
                <a href="https://fund.10jqka.com.cn/${escapeHtml(f.code)}" rel="noopener noreferrer" class="btn btn-sm" onclick="Fund._openExternal('https://fund.10jqka.com.cn/${escapeHtml(f.code)}');return false;">📈 同花顺</a>
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

  /**
   * 赎回计划 - 跳第三方 (天天/支付宝/蛋卷) → 用户赎回 → 用 quickRedeem 减份额
   */
  window.Fund.sellDialog = function(specificCode) {
    Core.Storage.get('funds', specificCode).then(f => {
      const list = [{
        code: specificCode,
        name: f?.name || '(查不到, 直接搜吧)',
        category: f?.type || 'other',
        shares: f?.shares || 0
      }];
      this._renderSellDialog(list);
    }).catch(e => {
      toastError('加载失败: ' + e.message);
      this._renderSellDialog([{ code: specificCode, name: '', category: 'other', shares: 0 }]);
    });
  };

  window.Fund._renderSellDialog = function(funds) {
    const html = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:680px;width:100%;">
          <h3>💰 赎回计划</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
            ⚠ app <b>不能</b>直接赎回基金。<br>
            点下方按钮跳到第三方平台 → 登录 → 卖出(赎回) → 回来点 <b>📤 快速赎回登记</b> 把数据减回去
          </div>
          ${funds.map(f => `
            <div class="ai-pick" style="margin-bottom:8px;">
              <div class="ai-pick-head">
                <strong>${escapeHtml(f.code)} ${escapeHtml(f.name || '')}</strong>
                <span class="tag">${this._typeLabel(f.category || '')}</span>
                ${f.shares > 0 ? `<span style="font-size:11px;color:var(--text-muted);margin-left:6px;">持有 ${fmtNum(f.shares, 2)} 份</span>` : '<span style="font-size:11px;color:var(--down);margin-left:6px;">(空仓)</span>'}
              </div>
              <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px;">
                <a href="https://fund.eastmoney.com/${escapeHtml(f.code)}.html" rel="noopener noreferrer" class="btn btn-sm btn-primary" onclick="Fund._openExternal('https://fund.eastmoney.com/${escapeHtml(f.code)}.html');return false;">🛒 天天基金 (H5)</a>
                <a href="https://danjuanapp.com/fund/${escapeHtml(f.code)}" rel="noopener noreferrer" class="btn btn-sm" onclick="Fund._openExternal('https://danjuanapp.com/fund/${escapeHtml(f.code)}');return false;">🥚 蛋卷基金</a>
                <a href="https://fund.10jqka.com.cn/${escapeHtml(f.code)}" rel="noopener noreferrer" class="btn btn-sm" onclick="Fund._openExternal('https://fund.10jqka.com.cn/${escapeHtml(f.code)}');return false;">📈 同花顺</a>
                <button class="btn btn-sm btn-ghost" onclick="Fund.quickRedeem('${escapeHtml(f.code)}','${escapeHtml((f.name || '').replace(/'/g, "\\'"))}')" ${f.shares > 0 ? '' : 'disabled style="opacity:0.5;"'}>📤 快速赎回登记</button>
              </div>
            </div>
          `).join('')}
          <div style="font-size:11px;color:var(--text-muted);margin-top:12px;line-height:1.6;">
            💡 <b>赎回规则</b>:<br>
            • T 日 15:00 前赎回 → T+1 确认, T+2 到账<br>
            • 持有 < 7 天: <b>1.5% 惩罚性赎回费</b><br>
            • 持有 ≥ 7 天: 大部分债基 <b>0% 赎回费</b><br>
            • 持有 ≥ 30 天: 几乎所有基金 <b>0% 赎回费</b>
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
   * 快速赎回登记 - 用户在第三方赎回后, 回来填数字减份额
   * 输赎回份额 + 净值 → 自动从 funds 表扣减 → 写 cashflow 正向流入
   */
  window.Fund.quickRedeem = async function(code, name) {
    const existing = await Core.Storage.get('funds', code);
    if (!existing || !existing.shares || existing.shares <= 0) {
      toastError('当前无持仓可赎回');
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const html = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:480px;">
          <h3>📤 快速赎回登记 - ${escapeHtml(code)}</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
            ${escapeHtml(name || '')} - 当前持有 <b style="color:var(--accent);">${fmtNum(existing.shares, 2)}</b> 份
          </div>
          <div class="form-row">
            <label>赎回日期</label>
            <input type="date" id="qrDate" value="${today}">
          </div>
          <div class="form-row">
            <label>赎回份额</label>
            <input type="number" id="qrShares" value="${existing.shares}" step="0.01" max="${existing.shares}">
            <div style="font-size:11px;color:var(--text-muted);">最多可赎回 ${fmtNum(existing.shares, 2)} 份</div>
          </div>
          <div class="form-row">
            <label>赎回费率 (%)</label>
            <input type="number" id="qrFee" value="0" step="0.01">
            <div style="font-size:11px;color:var(--text-muted);">持有 ≥ 7 天债基 0%, < 7 天 1.5%, 股票基 ≥ 30 天 0%</div>
          </div>
          <div class="form-row">
            <label>赎回净值</label>
            <input type="number" id="qrNav" step="0.0001" placeholder="例: 1.0523">
            <div style="font-size:11px;color:var(--text-muted);">在 第三方 App 的"持仓"或"交易记录"里能看到</div>
          </div>
          <div id="qrPreview" style="background:var(--bg-base);padding:10px;border-radius:4px;margin:8px 0;font-size:12px;line-height:1.6;">
            填完份额+净值自动算
          </div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
            <button class="btn btn-primary" onclick="Fund.quickRedeemSave()">✓ 登记赎回</button>
          </div>
        </div>
      </div>
    `;
    document.getElementById('modalRoot').innerHTML = html;
    _qiPre = existing;
    this._bindQuickRedeemCalc();
  };

  window.Fund._bindQuickRedeemCalc = function() {
    const upd = () => {
      const shares = parseFloat(document.getElementById('qrShares')?.value);
      const fee = parseFloat(document.getElementById('qrFee')?.value) || 0;
      const nav = parseFloat(document.getElementById('qrNav')?.value);
      const el = document.getElementById('qrPreview');
      const max = _qiPre?.shares || 0;
      if (!el) return;
      if (isNaN(shares) || isNaN(nav) || nav <= 0 || shares <= 0) {
        el.textContent = '填完份额+净值自动算';
        return;
      }
      const gross = shares * nav;
      const feeMoney = gross * fee / 100;
      const net = gross - feeMoney;
      const remain = max - shares;
      el.innerHTML = `
        <b>赎回总额</b>: ${gross.toFixed(2)} 元 (含 ${feeMoney.toFixed(2)} 元手续费)<br>
        <b>实际到账</b>: <span style="color:var(--up);font-size:14px;">${net.toFixed(2)} 元</span><br>
        <b>赎回份额</b>: ${shares.toFixed(2)} 份<br>
        <b>剩余持仓</b>: ${remain.toFixed(2)} 份 ${remain <= 0 ? '<span style="color:var(--down);">(全部清空)</span>' : ''}
      `;
    };
    ['qrShares', 'qrFee', 'qrNav'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', upd);
    });
    upd();
  };

  window.Fund.quickRedeemSave = async function() {
    const code = _qiPre?.code;
    if (!code) { toastError('内部错误, 请重试'); return; }
    const date = document.getElementById('qrDate').value;
    const shares = parseFloat(document.getElementById('qrShares').value);
    const feePct = parseFloat(document.getElementById('qrFee').value) || 0;
    const nav = parseFloat(document.getElementById('qrNav').value);
    if (!date) { toastError('填日期'); return; }
    if (isNaN(shares) || shares <= 0) { toastError('份额要 > 0'); return; }
    if (isNaN(nav) || nav <= 0) { toastError('净值要 > 0'); return; }
    const max = _qiPre?.shares || 0;
    if (shares > max) { toastError(`不能超过持有份额 ${fmtNum(max, 2)}`); return; }

    const gross = shares * nav;
    const feeMoney = gross * feePct / 100;
    const netAmount = gross - feeMoney;

    const existing = await Core.Storage.get('funds', code);
    if (!existing) { toastError('找不到该基金'); return; }
    const remainShares = max - shares;
    if (remainShares <= 0.0001) {
      // 全部赎回 → 直接删记录
      await Core.Storage.delete('funds', code);
    } else {
      // 部分赎回 → 保留剩余份额, costNav 不变 (卖出不影响成本)
      existing.shares = remainShares;
      existing.updatedAt = Date.now();
      await Core.Storage.put('funds', existing);
    }

    // 同步写一条 cashflow (正数 = 资金流入)
    const flowRec = {
      id: uuid(),
      date,
      type: 'transfer',
      amount: netAmount,
      target: code,
      note: `赎回 ${shares.toFixed(2)} 份, 净值 ${nav}, 费率 ${feePct}%, 到账 ${netAmount.toFixed(2)} 元`,
      createdAt: Date.now()
    };
    await Core.Storage.add('cashflow', flowRec);

    this.closeModal();
    toastSuccess(`已赎回 ${shares.toFixed(2)} 份, 到账 ${netAmount.toFixed(2)} 元 ${remainShares <= 0.0001 ? '(已清仓)' : `(剩 ${remainShares.toFixed(2)} 份)`}`);
    this.render();
  };
})();