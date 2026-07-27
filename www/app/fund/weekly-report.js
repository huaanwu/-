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
        // 把 ctx 缓存给 KB.pickRelevant 用 (避免再 fetch)
        window._wrCtx = ctx;
      } catch (e) { console.warn('[weekly] 拉市场上下文失败:', e); data.context = '(市场上下文数据不可用)'; }
      // KB 引用 (Phase N)
      try {
        const relevant = await Core.KB.pickRelevant({
          holdings: data.holdings,
          context: window._wrCtx || {},
          maxN: 4
        });
        data.kb = Core.KB.formatForPrompt(relevant);
      } catch (e) { console.warn('[weekly] 拉 KB 失败:', e); data.kb = ''; }
      // 历史周报 (Phase N) - 上次 AI 判断
      try {
        const prev = await _getLastWeeklyReport();
        if (prev && prev.summary) {
          data.prev = `## 上周 AI 判断 (${prev.weekKey || '上期'})\n${prev.summary.slice(0, 600)}`;
        }
      } catch (e) { console.warn('[weekly] 拉历史周报失败:', e); }
    } catch (e) {
      console.warn('[weekly] 数据拉取失败:', e);
      if (ld) ld.textContent = '❌ 数据拉取失败: ' + e.message;
      return;
    }

    if (ld) ld.textContent = '⏳ AI 撰写中, 大约 15-45 秒...';

    const systemPrompt = [
      '你是一名资深基金投资顾问 (Phase N 升级到"高手版"), 服务对象是长期稳健型 A 股/基金投资者。',
      '',
      '【投资框架】价值 + 趋势 + 风险平价 混合 (不放任任何单一学派):',
      '  - 价值: 估值分位、基本面拐点',
      '  - 趋势: 板块轮动、北向方向、股指期货基差',
      '  - 风险平价: 跨资产相关性、组合最大回撤、夏普',
      '',
      '【用户画像】年化 3-5% 跑赢通胀, 不追求暴利; 持仓可能含基金 + 个股。',
      '',
      '【输出风格】先证据后结论, 每段必引数据; 给信心等级 (高/中/低)。',
      '',
      '【强制结构】共 5 段:',
      '  📊 本周盈亏 (数字, 引用 holdings)',
      '  📰 重要事件 (2-3 条, 综合新闻+宏观+国际形势)',
      '  🎯 下周关注 (2-3 条, 综合估值分位/北向/板块/政策日历)',
      '  ⚠️ 风险提示 (1-2 条, 综合估值/两融/财经日历)',
      '  📌 本周动作 (1-3 条 具体操作, 见下方)',
      '',
      '【📌 本周动作 强制规则】每条必须包含:',
      '  - 操作: 加仓 / 减仓 / 止盈 / 止损 / 持有 / 不动',
      '  - 标的: 基金代码 / 板块 / 资产类别',
      '  - 触发条件: 例如"若 PE 分位突破 80%"、"若 LPR 下调 10BP"',
      '  - 信心等级: 高/中/低',
      '例: "📌 减仓白酒主题基金 5% (若 PE 分位 >85%, 高信心)"',
      '',
      '【KB 引用规则】如投资百科 (data.kb) 有相关条目, 回答时引用条目号:',
      '  - 例: "...符合 KB-VAL-001 PE 估值原则"',
      '  - 例: "...参考 KB-POS-003 再平衡频率"',
      '',
      '【硬性规则】',
      '  - 必须引用本周 % 变化数字 (从 holdings), 不许编造',
      '  - 如果有"黄金 Au9999"段, 风险提示必须提金价方向',
      '  - 如果有"国际形势"段, 重要事件或下周关注必须提美股/美元/原油方向',
      '  - 如果有"市场上下文"段, 综合估值分位/北向/板块轮动',
      '  - 如果有"上周 AI 判断"段, 必须点评上周判断的兑现情况',
      '  - 总长度 500-800 字 (因 Action 段可能更长)',
      '',
      '【Phase P 多视角辩论】在 📌 本周动作 之前, 增加 2 段简短辩论:',
      '  📈 多方观点 (100 字): 看多的依据 + 标的',
      '  📉 空方观点 (100 字): 看空的依据 + 风险',
      '  ⚖️ 综合判断 (50 字): 权衡后倾向哪一方, 为什么'
    ].join('\n');
    const prompt = `基金周报数据:\n${JSON.stringify(data, null, 2)}\n\n请生成给小白看的本周小结。`;

    try {
      await Core.AI.call({
        systemPrompt,
        prompt,
        stream: true,
        maxTokens: 1400,
        onChunk: (delta, full) => {
          if (ld) ld.remove();
          if (el) el.textContent = full;
        }
      });
      const finalText = (el && el.textContent) || '';
      if (el) el.innerHTML = window.Core.Util.renderWithSources(finalText);
      // 保存到 Dexie (Phase N: 历史复盘)
      _saveWeeklyReport(finalText, data).catch(e => console.warn('[weekly] 保存历史失败:', e));

      // Phase P 反向 self-check (后台, 不阻塞 UI)
      const checkEl = document.createElement('div');
      checkEl.style.cssText = 'margin-top:12px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;line-height:1.6;border-left:3px solid var(--accent);';
      checkEl.innerHTML = '🔍 self-check 中...';
      if (el && el.parentElement) el.parentElement.appendChild(checkEl);
      try {
        const critique = await Core.AI.selfCheck({
          originalOutput: finalText,
          originalPrompt: JSON.stringify(data).slice(0, 500),
          maxTokens: 300
        });
        const passThrough = critique.includes('✓ self-check 通过');
        checkEl.innerHTML = passThrough
          ? `<strong>✓ self-check 通过</strong> · 输出无幻觉/过度自信/漏判`
          : `<strong>⚠ self-check 反馈</strong><br>${escapeHtml(critique)}`;
        checkEl.style.borderLeftColor = passThrough ? 'var(--up)' : 'var(--down)';
      } catch (e) {
        checkEl.textContent = '⚠ self-check 失败: ' + e.message;
      }
    } catch (e) {
      console.warn('[weekly] AI 调用失败:', e);
      if (ld) ld.remove();
      // Phase V: 失败时显示重新生成按钮
      if (el) el.innerHTML = `❌ AI 调用失败: ${escapeHtml(e.message)}<div style="margin-top:10px;"><button class="btn btn-primary" onclick="Fund.weeklyReportDialog()">🔄 重新生成</button></div>`;
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

  // ISO 周编号 (YYYY-Www), 例 '2026-W31'
  function _weekKey(d = new Date()) {
    const date = new Date(d);
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + 4 - (date.getDay() || 7));
    const yearStart = new Date(date.getFullYear(), 0, 1);
    const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
    return date.getFullYear() + '-W' + String(weekNo).padStart(2, '0');
  }

  // 读最近一次周报 (用于下次回顾)
  async function _getLastWeeklyReport() {
    try {
      const raw = await Core.Storage.kvGet('ai_weekly_reports');
      if (!raw || !Array.isArray(raw) || raw.length === 0) return null;
      return raw[0];  // 最新一条
    } catch (e) { return null; }
  }

  // 保存本次周报 (覆盖式, 只保留最近 4 周)
  async function _saveWeeklyReport(summary, data) {
    if (!summary) return;
    const entry = {
      weekKey: _weekKey(),
      weekStart: _daysAgoStr(7),
      weekEnd: _todayStr(),
      generatedAt: new Date().toISOString(),
      summary,
      context: {
        valuation: (data.context || '').slice(0, 200),
        holdings: (data.holdings || []).map(h => h.name + ' ' + h.weekChange)
      }
    };
    let list = [];
    try { list = (await Core.Storage.kvGet('ai_weekly_reports')) || []; } catch (e) { list = []; }
    // 去重同周, prepend 新条, 保留 4 周
    list = list.filter(e => e.weekKey !== entry.weekKey);
    list.unshift(entry);
    list = list.slice(0, 4);
    try {
      await Core.Storage.kvSet('ai_weekly_reports', list);
    } catch (e) { console.warn('[weekly] kvSet 失败:', e); }
  }
})();
