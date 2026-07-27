/**
 * StockAdvisor - 单股 AI 简评 (Phase O)
 *
 * 用途: 行情/持仓列表的"💡"按钮 → 弹出该股的 AI 简评
 * 数据: 单股基本面 (PE/PB/ROE) + 13 维市场上下文 + KB 智能引用
 * 输出: 估值/技术/政策/风险/Action Items/KB 引用 (高手版 LLM)
 */
(function() {
  'use strict';
  window.StockAdvisor = window.StockAdvisor || {};

  /**
   * 单股 AI 简评 (弹窗 + 流式)
   * @param {string} code - 股票代码 (6 位)
   * @param {string} [name] - 股票名称 (可选, 用于显示)
   */
  window.StockAdvisor.show = async function(code, name) {
    if (!code) { toastError('缺少股票代码'); return; }

    // 弹窗
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:640px;width:100%;">
          <h3>💡 ${escapeHtml(name || code)} AI 简评</h3>
          <div id="saLoading" style="padding:12px;color:var(--text-muted);">⏳ 拉取基本面 + 市场上下文 + KB...</div>
          <div id="saResult" style="background:var(--bg-base);border-radius:6px;padding:14px;line-height:1.7;white-space:pre-wrap;font-size:13px;min-height:200px;"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            <button class="btn btn-ghost" onclick="StockAdvisor.show('${escapeHtml(code)}','${escapeHtml(name || '')}')">🔄 重评</button>
          </div>
        </div>
      </div>`;

    const ld = document.getElementById('saLoading');
    const el = document.getElementById('saResult');

    const data = { code, name: name || code, fundamental: null, quote: null };

    try {
      // 并行: 基本面 / 行情 / 市场上下文 / KB
      const [fin, ctx, kbEntries, quote] = await Promise.all([
        Core.Data.getStockFinancial(code).catch(e => { console.warn('[sa] 财务失败:', e); return null; }),
        Core.Data.getAiContextSnapshot().catch(e => { console.warn('[sa] 上下文失败:', e); return null; }),
        Core.KB.pickRelevant({ holdings: [{ name: name || code }], context: window._wrCtx || {}, maxN: 4 }).catch(e => []),
        Core.Data.getStockQuote(code).catch(e => null)
      ]);

      data.fundamental = _extractFundamentals(fin);
      data.quote = quote;
      data.context = ctx ? Core.Data.formatAiContextForPrompt(ctx) : '(市场上下文不可用)';
      data.kb = Core.KB.formatForPrompt(kbEntries);
      data.intl = await Core.Data.getIntlSnapshot().then(s => Core.Data.formatIntlForPrompt(s)).catch(e => '(国际形势不可用)');
    } catch (e) {
      console.warn('[sa] 数据拉取失败:', e);
      if (ld) ld.textContent = '❌ 数据拉取失败: ' + e.message;
      return;
    }

    if (ld) ld.textContent = '⏳ AI 简评中, 大约 10-20 秒...';

    const systemPrompt = [
      '你是一名 A 股个股投资顾问 (高手版, Phase O), 服务长期稳健型投资者。',
      '',
      '【投资框架】价值 + 趋势 + 风险平价 混合:',
      '  - 价值: PE/PB/ROE 与历史分位',
      '  - 趋势: 板块轮动、北向方向、所在行业资金流向',
      '  - 风险: 个股波动 vs 大盘、个股相关性、行业暴露',
      '',
      '【必给结构】4 段:',
      '  📊 估值与基本面 (引用 PE/PB/ROE 数据, 不许编造)',
      '  🌡️ 当前位置 (估值分位 / 行业热度 / 资金面)',
      '  ⚠️ 风险点 (2-3 条, 估值/行业/政策/财务)',
      '  📌 动作建议 (1-3 条, 操作+触发条件+信心)',
      '',
      '【📌 动作规则】每条: 操作 (关注/加仓/减仓/止损/持有) + 触发条件 + 信心等级 (高/中/低)',
      '  - 例: "📌 关注 (若 PE 分位回落到 30% 以下, 中信心)"',
      '',
      '【KB 引用】如有相关条目, 引用条目号: "..., 参考 KB-VAL-002 PB-ROE 匹配"',
      '',
      '【硬性】不许编造数字; 没有的数据说"无"; 总长度 250-450 字',
      '',
      '【Phase P 多视角辩论】在 📌 动作建议 之前, 增加:',
      '  📈 多方观点 (80 字): 看多的依据 (估值/资金/政策)',
      '  📉 空方观点 (80 字): 看空的依据 (估值/行业/技术)',
      '  ⚖️ 综合判断 (40 字): 权衡后倾向'
    ].join('\n');

    const prompt = `单股简评请求:\n${JSON.stringify(data, null, 2)}\n\n请按上面 4 段结构输出。`;

    try {
      await Core.AI.call({
        systemPrompt,
        prompt,
        stream: true,
        maxTokens: 800,
        onChunk: (delta, full) => {
          if (ld) ld.remove();
          if (el) el.textContent = full;
        }
      });
      const finalText = (el && el.textContent) || '';
      if (el) el.innerHTML = window.Core.Util.renderWithSources(finalText);

      // Phase P 反向 self-check (后台)
      const checkEl = document.createElement('div');
      checkEl.style.cssText = 'margin-top:12px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;line-height:1.6;border-left:3px solid var(--accent);';
      checkEl.innerHTML = '🔍 self-check 中...';
      if (el && el.parentElement) el.parentElement.appendChild(checkEl);
      try {
        const critique = await Core.AI.selfCheck({
          originalOutput: finalText,
          originalPrompt: JSON.stringify(data).slice(0, 500),
          maxTokens: 250
        });
        const passThrough = critique.includes('✓ self-check 通过');
        checkEl.innerHTML = passThrough
          ? `<strong>✓ self-check 通过</strong> · 无幻觉/过度自信/漏判`
          : `<strong>⚠ self-check 反馈</strong><br>${escapeHtml(critique)}`;
        checkEl.style.borderLeftColor = passThrough ? 'var(--up)' : 'var(--down)';
      } catch (e) {
        checkEl.textContent = '⚠ self-check 失败: ' + e.message;
      }
    } catch (e) {
      console.warn('[sa] AI 调用失败:', e);
      if (ld) ld.remove();
      if (el) el.textContent = '❌ AI 调用失败: ' + e.message;
      if (window.toastError) toastError('AI 调用失败: ' + e.message);
    }
  };

  /**
   * 从 akshare 财务数据里提取关键字段 (容错)
   */
  function _extractFundamentals(raw) {
    if (!raw || typeof raw !== 'object') return null;
    // akshare 财务接口字段不固定, 尝试多种 key
    const fields = {
      pe: ['市盈率', 'PE', 'pe', 'pe_ttm'],
      pb: ['市净率', 'PB', 'pb'],
      roe: ['净资产收益率', 'ROE', 'roe', '加权平均净资产收益率'],
      grossProfitMargin: ['销售毛利率', '毛利率'],
      revenueGrowth: ['营业总收入同比增长', '营收增速', 'revenue_yoy'],
      netProfitGrowth: ['净利润同比增长', '净利增速', 'profit_yoy']
    };
    const out = {};
    for (const [k, keys] of Object.entries(fields)) {
      for (const key of keys) {
        if (raw[key] != null && !isNaN(parseFloat(raw[key]))) {
          out[k] = parseFloat(raw[key]);
          break;
        }
      }
    }
    return Object.keys(out).length > 0 ? out : null;
  }
})();