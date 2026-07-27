/**
 * Fund.WeeklyReport - 本周基金小结 (Phase H.2)
 *
 * 用户点基金页"📰 本周 AI 小结"按钮 → 拉数据 → 调 qwen3 → 流式输出
 * 数据源: 持仓 + 最近 7 天净值变化 + Core.News + Core.Macro
 * endpoint 自动 fallback (local :8082 优先, 失败降级远程)
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund.weeklyReportDialog = async function() {
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:720px;width:100%;">
          <h3>📰 本周 AI 小结</h3>
          <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
            基于本周持仓变化、新闻、宏观,生成给小白看的简报
          </div>
          <div id="wrLoading" style="padding:12px;color:var(--text-muted);">⏳ 正在汇总本周数据...</div>
          <div id="wrResult" style="background:var(--bg-base);border-radius:6px;padding:14px;line-height:1.7;white-space:pre-wrap;font-size:13px;min-height:80px;"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            <button class="btn btn-ghost" onclick="Fund._wrCopy()">📋 复制</button>
          </div>
        </div>
      </div>`;

    const ld = document.getElementById('wrLoading');
    const el = document.getElementById('wrResult');

    const data = { week: '本周', holdings: [], news: [], macro: '' };
    try {
      const list = await Core.Storage.all('funds');
      for (const f of list) {
        if (!f.shares || f.shares <= 0) continue;
        let currentNav = null, prevNav = null;
        try {
          const spot = await Core.Data.getFundSpot(f.code);
          if (Array.isArray(spot) && spot.length > 0) {
            currentNav = parseFloat(spot[spot.length - 1].单位净值 || spot[spot.length - 1]['单位净值'] || spot[spot.length - 1].value);
          }
          const hist = await Core.Data.getFundHistory(f.code, _daysAgoStr(7), _todayStr());
          if (Array.isArray(hist) && hist.length >= 2) {
            prevNav = parseFloat(hist[0].单位净值 || hist[0]['单位净值'] || hist[0].y);
          }
        } catch (e) { console.warn('[weekly] 拉净值失败:', f.code, e); }
        data.holdings.push({
          code: f.code,
          name: f.name,
          type: window.Fund._typeLabel ? window.Fund._typeLabel(f.type) : (f.type || ''),
          value: currentNav ? f.shares * currentNav : null,
          weekChange: (currentNav && prevNav)
            ? (((currentNav - prevNav) / prevNav) * 100).toFixed(2) + '%'
            : '-'
        });
      }
      try {
        const snap = await Core.News.get();
        data.news = (snap && snap.relevant ? snap.relevant : []).slice(0, 8)
          .map(n => ({ title: n.title || n.summary || '', tag: n.tag }));
      } catch (e) { console.warn('[weekly] 拉新闻失败:', e); }
      try {
        const macro = await Core.Macro.get();
        data.macro = (macro && (macro.brief || macro.summary))
          ? (macro.brief || macro.summary)
          : (macro ? JSON.stringify(macro).slice(0, 300) : '');
      } catch (e) { console.warn('[weekly] 拉宏观失败:', e); }
      // 黄金 (Phase J)
      try {
        const gold = await Core.Data.getGoldAu9999();
        data.gold = Core.Data.formatGoldForPrompt(gold, 30);
      } catch (e) { console.warn('[weekly] 拉黄金失败:', e); data.gold = '(黄金数据不可用)'; }
      // 国际形势 (Phase L)
      try {
        const intl = await Core.Data.getIntlSnapshot();
        data.intl = Core.Data.formatIntlForPrompt(intl);
      } catch (e) { console.warn('[weekly] 拉国际形势失败:', e); data.intl = '(国际形势数据不可用)'; }
      // 市场上下文 (Phase M Tier 1: 估值/财报/北向/M2/板块)
      try {
        const ctx = await Core.Data.getAiContextSnapshot();
        data.context = Core.Data.formatAiContextForPrompt(ctx);
      } catch (e) { console.warn('[weekly] 拉市场上下文失败:', e); data.context = '(市场上下文数据不可用)'; }
    } catch (e) {
      console.warn('[weekly] 数据拉取失败:', e);
      if (ld) ld.textContent = '❌ 数据拉取失败: ' + e.message;
      return;
    }

    if (ld) ld.textContent = '⏳ AI 撰写中, 大约 15-45 秒...';

    const systemPrompt = [
      '你是一名给小白看的基金周报编辑。用通俗中文,长度 300-500 字。',
      '结构强制 4 段: 📊 本周盈亏(数字) / 📰 重要事件(2-3 条) / 🎯 下周关注(2-3 条) / ⚠️ 风险提示(1-2 条)',
      '- 必须引用本周 % 变化数字(从 holdings 数据),不许编造',
      '- 如果数据中有"黄金 Au9999"段, 必须在风险提示里提及金价方向(涨/跌/区间)',
      '- 如果数据中有"国际形势"段, 必须在重要事件或下周关注里提及美股/美元/原油方向',
      '- 如果数据中有"市场上下文"段, 必须在重要事件或下周关注里综合估值分位/北向方向/板块轮动',
      '- 不要推荐买卖动作,只汇总信息'
    ].join('\n');
    const prompt = `基金周报数据:\n${JSON.stringify(data, null, 2)}\n\n请生成给小白看的本周小结。`;

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
      if (el) {
        const finalText = el.textContent || '';
        el.innerHTML = window.Core.Util.escapeHtml(finalText);
      }
    } catch (e) {
      console.warn('[weekly] AI 调用失败:', e);
      if (ld) ld.remove();
      if (el) el.textContent = '❌ AI 调用失败: ' + e.message;
      if (window.toastError) toastError('AI 调用失败: ' + e.message);
    }
  };

  window.Fund._wrCopy = async function() {
    const el = document.getElementById('wrResult');
    if (!el) return;
    try {
      await navigator.clipboard.writeText(el.textContent || '');
      if (window.toastSuccess) toastSuccess('已复制');
    } catch (e) {
      if (window.toastError) toastError('复制失败: ' + e.message);
    }
  };

  function _todayStr() {
    return new Date().toISOString().slice(0, 10).replace(/-/g, '');
  }
  function _daysAgoStr(d) {
    const x = new Date(); x.setDate(x.getDate() - d);
    return x.toISOString().slice(0, 10).replace(/-/g, '');
  }
})();
