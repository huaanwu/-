/**
 * Fund.Rebalance - 再平衡建议 UI
 *
 * 纯函数 _computeRebalanceAdvice 在主文件 fund.js (被 test_all.js vm 测)
 * 本子文件只承载 UI 部分: 拉持仓 → 调主文件纯函数 → 渲染 + 跳第三方链接
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  let _lastRebalanceAdvice = null;  // 给 _openRebalanceLinks 用
  let _lastRebalanceHoldings = null;
  let _lastRebalanceTargets = null;

  window.Fund.rebalanceDialog = async function() {
    // 1. 拉当前持仓 + 实时净值
    const list = await Core.Storage.all('funds');
    const holdings = [];
    for (const f of list) {
      if (!f.shares || f.shares <= 0) continue;
      let currentNav = null;
      try {
        const data = await Core.Data.getFundSpot(f.code);
        if (Array.isArray(data) && data.length > 0) {
          currentNav = parseFloat(data[data.length - 1].单位净值 || data[data.length - 1]['单位净值'] || data[data.length - 1].value);
        }
      } catch (e) { /* 拉不到就不算 */ }
      if (!currentNav) continue;
      holdings.push({
        code: f.code,
        name: f.name,
        type: f.type,
        shares: f.shares,
        currentNav,
        value: f.shares * currentNav
      });
    }

    // 2. 目标配置 (可调整: 暂用默认 20/80)
    const targets = { short_bond: 0.20, pure_bond: 0.80 };
    const advice = this._computeRebalanceAdvice(holdings, targets);
    _lastRebalanceAdvice = advice;  // 缓存给 _openRebalanceLinks 用
    _lastRebalanceHoldings = holdings;
    _lastRebalanceTargets = targets;  // 给 _aiExplain 用

    // 3. 渲染
    const html = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:680px;width:100%;">
          <h3>⚖️ 基金再平衡建议</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;line-height:1.5;">
            目标配置: 短债 20% · 纯债 80% (硬编码, 后续可在 ⚙️ 设置调)
          </div>
          ${this._renderRebalanceHTML(advice)}
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            <button class="btn btn-ghost" id="rbAIBtn" onclick="Fund._aiExplain()">✨ AI 讲讲为什么</button>
            ${advice.suggestions.length > 0 ? '<button class="btn btn-primary" onclick="Fund._openRebalanceLinks()">🛒 跳第三方调仓</button>' : ''}
          </div>
          <div id="rbAIExplain" style="margin-top:12px;padding:12px;background:var(--bg-base);border-radius:6px;font-size:12px;line-height:1.7;white-space:pre-wrap;display:none;"></div>
        </div>
      </div>
    `;
    document.getElementById('modalRoot').innerHTML = html;
  };

  window.Fund._renderRebalanceHTML = function(advice) {
    if (!advice.ok) {
      return `<div style="padding:20px;text-align:center;color:var(--text-muted);">${escapeHtml(advice.reason || '暂无法计算')}</div>`;
    }

    // 总览
    const overview = `
      <div class="summary-card" style="margin-bottom:12px;">
        <div style="font-size:11px;color:var(--text-muted);">总市值</div>
        <div style="font-size:18px;font-weight:600;">${fmtMoney(advice.totalValue)}</div>
      </div>
      <div class="summary-card" style="margin-bottom:12px;">
        <div style="font-size:11px;color:var(--text-muted);">总调仓</div>
        <div style="font-size:18px;font-weight:600;color:${advice.needRebalance ? 'var(--accent)' : 'var(--up)'};">${fmtMoney(advice.totalAdjust)}</div>
      </div>
      <div class="summary-card" style="margin-bottom:12px;">
        <div style="font-size:11px;color:var(--text-muted);">预估费率</div>
        <div style="font-size:18px;font-weight:600;">${fmtMoney(advice.costEstimate)}</div>
      </div>
    `;

    // 漂移表
    const driftRows = advice.drift.map(d => {
      const curPct = (d.currentPct * 100).toFixed(1);
      const tgtPct = d.targetPct !== undefined ? (d.targetPct * 100).toFixed(0) : '-';
      const driftPct = d.driftPct !== 0 ? ((d.driftPct > 0 ? '+' : '') + (d.driftPct * 100).toFixed(1)) : '0.0';
      const driftColor = d.driftPct > 0.001 ? 'var(--up)' : (d.driftPct < -0.001 ? 'var(--down)' : 'var(--text-muted)');
      const flag = d.triggered ? ' ⚠️' : '';
      return `<tr>
        <td><span class="code">${escapeHtml(d.code)}</span></td>
        <td>${escapeHtml(d.name || '')}</td>
        <td>${this._typeLabel(d.type)}</td>
        <td style="text-align:right;">${curPct}%</td>
        <td style="text-align:right;">${tgtPct}%</td>
        <td style="text-align:right;color:${driftColor};">${driftPct}%${flag}</td>
      </tr>`;
    }).join('');

    // 调仓建议
    let suggestHTML = '';
    if (advice.needRebalance) {
      if (advice.suggestions.length === 0) {
        suggestHTML = '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">触发阈值但金额都 < 100 元, 调仓不划算, 建议等下次漂移更大时再调。</div>';
      } else {
        const items = advice.suggestions.map(s => {
          const icon = s.action === 'reduce' ? '📉 减仓' : '📈 加仓';
          const color = s.action === 'reduce' ? 'var(--up)' : 'var(--down)';
          const sharesStr = s.shares !== null ? ` (${s.shares.toFixed(2)} 份)` : '';
          const feeStr = s.fee > 0 ? ` · 费 ${fmtMoney(s.fee)}` : '';
          return `<div style="background:var(--bg-base);padding:10px;border-radius:6px;margin-bottom:6px;border-left:3px solid ${color};">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
              <strong>${icon}: ${escapeHtml(s.code)} ${escapeHtml(s.name || '')}</strong>
              <span style="font-weight:600;color:${color};font-size:14px;">${fmtMoney(s.amount)}${sharesStr}</span>
            </div>
            <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(s.reason)}${feeStr}</div>
          </div>`;
        }).join('');
        suggestHTML = `<div style="margin:12px 0;"><strong>📋 调仓动作</strong>:</div>${items}`;
      }
    }

    // 警告
    const warningsHTML = advice.warnings.length > 0
      ? `<div style="margin-top:12px;padding:8px;background:rgba(245,158,11,0.1);border-left:3px solid var(--accent);border-radius:4px;font-size:12px;">
          ${advice.warnings.map(w => `<div>⚠ ${escapeHtml(w)}</div>`).join('')}
        </div>`
      : '';

    return `
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">${overview}</div>
      <table style="margin:12px 0;">
        <thead>
          <tr><th>代码</th><th>名称</th><th>类型</th><th style="text-align:right;">当前%</th><th style="text-align:right;">目标%</th><th style="text-align:right;">漂移</th></tr>
        </thead>
        <tbody>${driftRows}</tbody>
      </table>
      ${suggestHTML}
      ${warningsHTML}
    `;
  };

  /**
   * 打开所有要调仓的基金的第三方购买链接
   * (减仓 → 走天天基金赎回, 加仓 → 走申购)
   */
  window.Fund._openRebalanceLinks = function() {
    // 简单实现: 把 _computeRebalanceAdvice 缓存下来供这里读
    const list = _lastRebalanceAdvice;
    if (!list || !list.suggestions) {
      // 重新算
      this.rebalanceDialog().then(() => this._openRebalanceLinks());
      return;
    }
    for (const s of list.suggestions) {
      if (s.action === 'add') {
        // 申购链接
        window.open(`https://fund.eastmoney.com/${s.code}.html`, '_blank');
      } else {
        // 赎回链接 (跳持仓页让用户操作)
        window.open(`https://fund.eastmoney.com/${s.code}.html`, '_blank');
      }
    }
    toastSuccess(`已打开 ${list.suggestions.length} 个调仓链接`);
  };

  /**
   * Phase H.1: 用本地 qwen3 把"再平衡表格"翻译成人话
   * 流式输出到 #rbAIExplain。
   */
  window.Fund._aiExplain = async function() {
    const btn = document.getElementById('rbAIBtn');
    const panel = document.getElementById('rbAIExplain');
    const advice = _lastRebalanceAdvice;
    const holdings = _lastRebalanceHoldings || [];
    const targets = _lastRebalanceTargets || {};
    if (!advice) {
      if (window.toastError) toastError('当前没有可讲解的建议');
      return;
    }
    if (btn) btn.disabled = true;
    if (panel) {
      panel.style.display = 'block';
      panel.textContent = '⏳ AI 思考中, 大约 10-30 秒...';
    }

    const totalValue = advice.totalValue || holdings.reduce((s, h) => s + (h.value || 0), 0);
    const systemPrompt = [
      '你是一名资深基金投资顾问,擅长把复杂的资产配置数字翻译成人话。',
      '- 用户是 A 股 / 基金小额长期投资者(目标年化 3-5% 跑赢通胀)',
      '- 不要给"具体买卖金额",只解释逻辑、风险、优先级',
      '- 输出 200-400 字中文,使用 3 段: 📊 现在 / ⚖️ 调整原因 / ⚠️ 注意事项',
      '- 引用用户实际数据(总市值、漂移 %、目标 %),不要凭空举数字'
    ].join('\n');

    const payload = {
      持仓: holdings.map(h => ({
        代码: h.code,
        名称: h.name,
        类型: this._typeLabel(h.type),
        当前占比: totalValue > 0 ? ((h.value / totalValue) * 100).toFixed(1) + '%' : '-'
      })),
      目标配置: targets,
      总市值: totalValue,
      漂移: (advice.drift || []).map(d => ({
        代码: d.code,
        当前占比: ((d.currentPct || 0) * 100).toFixed(1) + '%',
        目标占比: d.targetPct !== undefined ? ((d.targetPct) * 100).toFixed(0) + '%' : '-',
        漂移: ((d.driftPct || 0) * 100).toFixed(1) + '%'
      })),
      调仓动作: (advice.suggestions || []).map(s => ({ 操作: s.action, 基金: s.code, 金额: s.amount })),
      警告: advice.warnings || []
    };
    const prompt = `用户当前持仓 + 再平衡建议(JSON):\n${JSON.stringify(payload, null, 2)}\n\n请用通俗中文解释这份建议,采用上面 3 段格式。`;

    try {
      await Core.AI.call({
        systemPrompt,
        prompt,
        stream: true,
        maxTokens: 600,
        onChunk: (delta, full) => {
          if (panel) panel.textContent = full;
        }
      });
      const finalText = panel ? panel.textContent : '';
      if (panel) {
        panel.innerHTML = '🤖 AI 讲解:\n\n' + window.Core.Util.escapeHtml(finalText);
      }
    } catch (e) {
      console.warn('[Fund] AI 讲解失败:', e);
      if (panel) panel.textContent = '❌ AI 讲解失败: ' + e.message;
      if (window.toastError) toastError('AI 调用失败: ' + e.message);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
})();