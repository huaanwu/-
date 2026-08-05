/**
 * Journal - 复盘笔记
 * Markdown 格式,可关联股票
 *
 * 互通: 复盘新建时自动带 当日大盘 + 持仓盈亏 + 资金流水 (一键插入正文)
 *       列表每张卡片实时显示关联股票当前持仓 (5.1.1 接入 holdings)
 */
(function() {
  'use strict';

  // v0.2.19 兼容: ContextBuilder 不存在时手动拉 holdings/alerts/journals/portfolio/macro/marketWidth
  //   测试 vm / 老 NSIS 没加载 data/*.js (Phase 1.6 子文件) 时降级
  //   返回 DTO 跟 ContextBuilder.build 一致: { slices: {...}, sourceDigest, partialErrors }
  const _legacyBuildContext = async (intent) => {
    const partialErrors = [];
    const slices = { holdings: [], alerts: [], recentJournals: [], portfolio: null, macro: null, marketWidth: null };
    try {
      if (Core.Holdings && typeof Core.Holdings.getAll === 'function') {
        slices.holdings = (await Core.Holdings.getAll()) || [];
      } else if (Core.Storage && typeof Core.Storage.all === 'function') {
        const all = await Core.Storage.all('holdings').catch(() => []);
        slices.holdings = (all || []).filter(h => !h.isPaper);
      }
    } catch (e) { partialErrors.push({ source: 'holdings', msg: e.message }); }
    try {
      if (Core.Alerts && typeof Core.Alerts.list === 'function') {
        slices.alerts = (await Core.Alerts.list()) || [];
      } else if (Core.Storage && typeof Core.Storage.all === 'function') {
        slices.alerts = (await Core.Storage.all('alerts').catch(() => [])) || [];
      }
    } catch (e) { partialErrors.push({ source: 'alerts', msg: e.message }); }
    try {
      if (Core.Storage && typeof Core.Storage.all === 'function') {
        const all = await Core.Storage.all('journals').catch(() => []);
        slices.recentJournals = (all || []).slice(-8);
      }
    } catch (e) { partialErrors.push({ source: 'journals', msg: e.message }); }
    try {
      if (Core.Portfolio && typeof Core.Portfolio.getAssets === 'function') {
        slices.portfolio = await Core.Portfolio.getAssets({ paper: false });
      }
    } catch (e) { partialErrors.push({ source: 'portfolio', msg: e.message }); }
    try {
      if (Core.Macro && typeof Core.Macro.getText === 'function') {
        slices.macro = await Core.Macro.getText();
      }
    } catch (e) { partialErrors.push({ source: 'macro', msg: e.message }); }
    try {
      if (Core.MarketWidth && typeof Core.MarketWidth.getMarketWidth === 'function') {
        slices.marketWidth = await Core.MarketWidth.getMarketWidth();
      }
    } catch (e) { partialErrors.push({ source: 'marketWidth', msg: e.message }); }
    return { slices, sourceDigest: '', partialErrors };
  };

  const Journal = {

    async init() {},

    async render() {
      const list = await Core.Storage.all('journals');
      const root = document.getElementById('journalList');

      if (!list || list.length === 0) {
        root.innerHTML = `
          <div class="empty">
            <div class="empty-icon">📝</div>
            <div>还没有复盘</div>
            <div style="margin-top:8px;font-size:12px;">点击"新建"开始记录, 写复盘时自动带当日数据</div>
          </div>
        `;
        return;
      }

      // 按日期倒序
      list.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

      // 5.1.1: 一次性查所有持仓 + 行情, 给每张卡附 "现持仓" 标记
      const holdingsContext = await this._buildHoldingsContext();

      root.innerHTML = list.map(j => {
        const ctx = j.code ? holdingsContext[j.code] : null;
        const ctxHTML = ctx ? this._renderHoldingBadge(ctx) : '';
        return `
        <div class="data-card" data-journal-id="${j.id}" style="margin-bottom:12px;padding:16px;cursor:pointer;" onclick="Journal.editDialog('${j.id}')">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;">
            <h3 style="font-size:15px;margin:0;">${escapeHtml(j.title || '(无标题)')}</h3>
            <span style="color:var(--text-muted);font-size:11px;">${escapeHtml(j.date || '')}</span>
          </div>
          ${j.code ? `<div style="margin-bottom:6px;"><span class="code">${escapeHtml(j.code)}</span> <span class="tag">${escapeHtml(j.code)}</span></div>` : ''}
          <div style="color:var(--text-secondary);font-size:13px;line-height:1.5;">
            ${escapeHtml((j.content || '').slice(0, 200))}${(j.content || '').length > 200 ? '...' : ''}
          </div>
          ${j.tags && j.tags.length ? `<div style="margin-top:8px;">${j.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join(' ')}</div>` : ''}
          ${this._renderStructuredTags(j)}
          ${ctxHTML}
          ${j.aiAppliedAt ? '<span class="tag" style="color:var(--accent);font-size:10px;margin-top:4px;display:inline-block;">✓ AI 已应用</span>' : `<button class="btn btn-sm btn-ghost" data-role="ai-attr-btn" style="font-size:10px;padding:2px 6px;margin-top:4px;" onclick="event.stopPropagation();Journal._runAttributeManually('${j.id}')">🪄 AI 归因</button>`}
        </div>
      `;
      }).join('');

      // 5.2.2: 给有 aiSuggested 但未应用的 note 加 "应用 AI 建议" 按钮
      for (const j of list) {
        if (j.aiSuggested && !j.aiAppliedAt) {
          this._showAiSuggestionToast(j, j.aiSuggested);
        }
      }
    },

    /**
     * 5.1.1: 一次性拉所有持仓 + 对应行情 + 最早买入日, 缓存给 render 用
     * 返回 { [code]: { shares, cost, currentPrice, currentMkt, totalPL, totalPLPct, holdingDays, firstBuyDate, name } | null }
     */
    async _buildHoldingsContext() {
      const map = {};
      try {
        // 排除模拟盘 (isPaper) 行
        const holdings = ((await Core.Storage.all('holdings')) || []).filter(h => !h.isPaper);
        if (!holdings || holdings.length === 0) return map;

        // 一次性拉行情 (失败则单只价格为空)
        let spotMap = {};
        try {
          const spot = await Core.Data.getStockSpot();
          (spot || []).forEach(s => { spotMap[s.代码] = s; });
        } catch (e) {
          console.warn('[Journal] _buildHoldingsContext 拉行情失败:', e);
        }

        // 一次性拉所有交易, 按 holdingId 分组
        let txs = [];
        try { txs = ((await Core.Storage.all('transactions')) || []).filter(t => !t.isPaper); } catch (e) { console.warn('[Journal] _buildHoldingsContext 拉 tx 失败:', e); }
        const buyByHolding = {};
        for (const t of (txs || [])) {
          if (t.type === 'buy') {
            const cur = buyByHolding[t.holdingId];
            if (!cur || (t.date || '') < (cur.date || '')) buyByHolding[t.holdingId] = t;
          }
        }

        const today = Date.now();
        for (const h of holdings) {
          const shares = parseFloat(h.shares) || 0;
          if (shares <= 0) continue;
          const costPrice = parseFloat(h.costPrice) || 0;
          const cost = shares * costPrice;
          const s = spotMap[h.code];
          const currentPrice = s ? parseFloat(s.最新价) : null;
          const currentMkt = currentPrice ? shares * currentPrice : null;
          const totalPL = currentMkt !== null ? currentMkt - cost : null;
          const totalPLPct = totalPL !== null && cost > 0 ? totalPL / cost : null;

          // 持仓天数: 用最早 buy 交易 → 没记录则用 createdAt
          const firstBuy = buyByHolding[h.id];
          const firstBuyDate = firstBuy ? firstBuy.date : (h.createdAt ? fmtDate(new Date(h.createdAt)) : null);
          let holdingDays = null;
          if (firstBuyDate) {
            const start = new Date(firstBuyDate);
            if (!isNaN(start.getTime())) {
              holdingDays = Math.max(0, Math.floor((today - start.getTime()) / 86400000));
            }
          }
          map[h.code] = {
            shares, cost, currentPrice, currentMkt, totalPL, totalPLPct,
            holdingDays, firstBuyDate, name: h.name || ''
          };
        }
      } catch (e) {
        console.warn('[Journal] _buildHoldingsContext 失败:', e);
      }
      return map;
    },

    /**
     * 单只持仓的现况 badge HTML (用于复盘卡片底部)
     * ctx: { shares, cost, currentMkt, totalPL, totalPLPct, holdingDays, firstBuyDate, name }
     */
    _renderHoldingBadge(ctx) {
      if (!ctx) return '';
      const pl = ctx.totalPL;
      const plPct = ctx.totalPLPct;
      const plColor = pl === null ? 'var(--text-muted)' : (pl > 0 ? 'var(--up)' : (pl < 0 ? 'var(--down)' : 'var(--text-muted)'));
      const plSign = pl > 0 ? '+' : '';
      const daysStr = ctx.holdingDays !== null ? `持仓 ${ctx.holdingDays} 天` : '';
      const priceStr = ctx.currentPrice !== null ? `现价 ${ctx.currentPrice.toFixed(2)}` : '现价 -';
      const plStr = pl !== null ? `${plSign}${fmtMoney(pl)} (${plSign}${(plPct * 100).toFixed(2)}%)` : '盈亏 -';
      return `<div style="margin-top:8px;padding:6px 8px;background:var(--bg-base);border-radius:4px;font-size:11px;color:var(--text-secondary);line-height:1.5;">
        <span style="color:var(--up);">💼 现持仓</span> · ${priceStr} · <span style="color:${plColor};">${plStr}</span>${daysStr ? ' · ' + daysStr : ''}
      </div>`;
    },

    /**
     * 5.2.1: 渲染 3 个结构化标签 (买入假设 / 情绪标签 / 事后验证)
     * 5.2.2: 标 AI 建议/已应用 状态
     */
    _renderStructuredTags(j) {
      if (!j) return '';
      const a = j.assumption, e = j.emotion, v = j.verify;
      if (!a && !e && !v) return '';
      const aiBadge = (j.aiSuggested && !j.aiAppliedAt) ? ' <span class="tag" style="background:var(--bg-accent);color:var(--up);">🤖 AI 待确认</span>' :
                      (j.aiAppliedAt ? ' <span class="tag" style="background:var(--bg-base);color:var(--text-muted);font-size:10px;">🤖 已应用</span>' : '');
      const verifyColor = v === 'verified' ? 'var(--up)' : (v === 'pending' ? 'var(--text-muted)' : 'var(--text-secondary)');
      const verifyLabel = ({pending: '⏳ 待回看', '1w': '📅 1 周后', '1m': '📅 1 月后', '3m': '📅 3 月后', verified: '✅ 已验证'})[v] || v;
      return `<div style="margin-top:6px;font-size:11px;line-height:1.6;">
        ${a ? `<span class="tag">假设: ${escapeHtml(a)}</span> ` : ''}
        ${e ? `<span class="tag">情绪: ${escapeHtml(e)}</span> ` : ''}
        ${v ? `<span class="tag" style="color:${verifyColor};">${escapeHtml(verifyLabel)}</span>` : ''}
        ${aiBadge}
      </div>`;
    },

    newDialog() { this._formDialog(null); },
    editDialog(id) { this._formDialog(id); },

    /**
     * 5.3.1: AI 同事弹窗 — 一键跑多智能体 pipeline (observer/analyst/coach)
     * 数据源: 持仓 + 告警 + 近期复盘
     * 结果: 三段 (观察 / 诊断 / 行动) + 4 个意图按钮 + 记忆同步
     */
    async aiColleagueDialog() {
      if (!window.Core?.Agents?.runPipeline) {
        toastError('Core.Agents 未加载');
        return;
      }
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Journal.closeModal()">
          <div class="modal" style="max-width:720px;width:100%;">
            <h3>🤖 AI 同事 (5.3.1)</h3>
            <div style="font-size:11px;color:var(--text-muted);line-height:1.5;margin-bottom:12px;">
              整合持仓 / 告警 / 复盘, 由 observer(拉事实) → analyst(诊断) → coach(行动) 三个 agent 串行输出。
              <br>💡 LLM 走 ⚙️ 设置里的 provider + baseURL, 没配会失败。
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              <button class="btn btn-primary btn-sm" onclick="Journal._runAgentPipeline('today', this)">▶ 今日全链路</button>
              <button class="btn btn-sm" onclick="Journal._runAgentPipeline('diagnose', this)">🔍 诊断持仓</button>
              <button class="btn btn-sm" onclick="Journal._runAgentPipeline('observe', this)">👀 仅观察</button>
              <button class="btn btn-sm" onclick="Journal._runAgentPipeline('next', this)">💡 下一步行动</button>
            </div>
            <div id="aiColleagueResult" style="min-height:80px;padding:8px;background:var(--bg-base);border-radius:4px;font-size:12px;line-height:1.6;">
              <span style="color:var(--text-muted);">点上面按钮跑</span>
            </div>
            <div style="border-top:1px solid var(--border);margin-top:12px;padding-top:8px;">
              <div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">🧠 AI 记忆同步 (5.3.2 · 需先在 ⚙️ 设置登录 Supabase)</div>
              <div style="display:flex;gap:6px;">
                <button class="btn btn-sm btn-ghost" onclick="Journal._pushAIMemory(this)">⬆️ 推 AI 记忆</button>
                <button class="btn btn-sm btn-ghost" onclick="Journal._pullAIMemory(this)">⬇️ 拉 AI 记忆</button>
              </div>
              <div id="aiMemoryResult" style="font-size:11px;color:var(--text-muted);margin-top:6px;"></div>
            </div>
            <div style="display:flex;justify-content:flex-end;margin-top:12px;">
              <button class="btn" onclick="Journal.closeModal()">关闭</button>
            </div>
          </div>
        </div>`;
      const root = document.getElementById('modalRoot');
      if (root) root.innerHTML = html;
    },

    /**
     * 5.3.1: 跑 runPipeline, 把 steps 渲染到弹窗
     */
    async _runAgentPipeline(intent, btn) {
      const out = document.getElementById('aiColleagueResult');
      if (!out) return;
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ 跑中...';
      out.innerHTML = '<span style="color:var(--text-muted);">⏳ 拉事实 → 调 LLM → 输出...</span>';
      try {
        // Phase 2.3: 走 ContextBuilder.build('diagnose') 一行收口
        //   自动按需拉 holdings/alerts/journals/portfolio/macro/marketWidth,
        //   失败部分记 partialErrors 不污染整体, quote 走 Facade 自动降级
        // v0.2.19 兼容: ContextBuilder 不存在时降级到手动装配 (老路径, 不破测试 vm)
        const ctxDto = (Core.Data && Core.Data.ContextBuilder && typeof Core.Data.ContextBuilder.build === 'function')
          ? await Core.Data.ContextBuilder.build('diagnose')
          : await _legacyBuildContext('diagnose');
        // DTO -> 老 ctx 结构 (向后兼容 _summarizeCtx / _aiColleague 渲染层)
        const holdings = ctxDto.slices.holdings || [];
        const alerts = ctxDto.slices.alerts || [];
        const recentJournals = ctxDto.slices.recentJournals || [];
        const portfolio = ctxDto.slices.portfolio;
        const macroText = ctxDto.slices.macro;
        const marketWidth = ctxDto.slices.marketWidth;
        // 局部兜底: 部分失败时记录 (老的 warn 仍输出)
        ctxDto.partialErrors.forEach(e => console.warn('[aiColleague]', e.source + ':', e.msg));
        const ctx = { holdings, alerts, recentJournals, portfolio, macro: macroText, marketWidth, sourceDigest: ctxDto.sourceDigest };
        // P0: 注入研究池代码白名单 — 通用管家 (coach) 必须只从池子里推 code
        // 不在池子里的代码 LLM 推了会在后处理里被丢弃 (避免越界选股)
        try {
          if (Core.ResearchPool && typeof Core.ResearchPool.list === 'function') {
            const pool = await Core.ResearchPool.list();
            ctx.researchPoolCodes = (pool || []).map(r => r.code).filter(Boolean);
          }
        } catch (e) { console.warn('[aiColleague] 研究池注入失败:', e); }
        // Phase 1.6: 给 observer 的 ctx 注入 sourceDigest (压缩数据来源摘要)
        if (Core.Data && Core.Data.Facade && typeof Core.Data.Facade.digest === 'function' && quoteEnvelopes.length > 0) {
          ctx.sourceDigest = Core.Data.Facade.digest(quoteEnvelopes);
        }
        // 跑 pipeline
        const r = await Core.Agents.runPipeline(intent, ctx);
        // 渲染 steps
        const stepHtml = (r.steps || []).map(s => {
          const ok = s.ok ? '✅' : '❌';
          return `<div style="margin-bottom:4px;">${ok} <b>${escapeHtml(s.agent)}</b>: ${escapeHtml(s.summary || '')}</div>`;
        }).join('');
        // 渲染 final (observations/findings/actions)
        let finalHtml = '';
        const data = r.final || {};
        if (Array.isArray(data.observations) && data.observations.length) {
          finalHtml += `<div style="margin-top:8px;"><b>👀 观察 (${data.observations.length}):</b><ul style="margin:4px 0 0 16px;padding:0;">${data.observations.map(o => `<li><b>[${escapeHtml(o.category || '?')}]</b> ${escapeHtml(o.code || '')} ${escapeHtml(o.text || '')} <span style="color:var(--text-muted);">(${escapeHtml(o.severity || 'info')})</span></li>`).join('')}</ul></div>`;
        }
        if (Array.isArray(data.findings) && data.findings.length) {
          finalHtml += `<div style="margin-top:8px;"><b>🔍 诊断 (${data.findings.length}):</b><ul style="margin:4px 0 0 16px;padding:0;">${data.findings.map(f => {
            const color = f.type === 'positive' ? 'var(--up)' : f.type === 'negative' ? 'var(--down)' : 'var(--text)';
            return `<li style="color:${color};"><b>[${escapeHtml(f.type || '?')}]</b> ${escapeHtml(f.code || '')} ${escapeHtml(f.text || '')} <span style="color:var(--text-muted);">(${escapeHtml(f.confidence || 'low')})</span></li>`;
          }).join('')}</ul></div>`;
        }
        if (Array.isArray(data.actions) && data.actions.length) {
          finalHtml += `<div style="margin-top:8px;"><b>💡 行动 (${data.actions.length}):</b><ul style="margin:4px 0 0 16px;padding:0;">${data.actions.map(a => {
            const urgent = a.urgency === 'immediate' ? '🚨' : a.urgency === 'high' ? '⚠️' : '·';
            return `<li>${urgent} <b>${escapeHtml(a.action || '?')}</b> ${escapeHtml(a.code || '')} — ${escapeHtml(a.reason || '')}</li>`;
          }).join('')}</ul></div>`;
        }
        if (Array.isArray(data.watchlist) && data.watchlist.length) {
          finalHtml += `<div style="margin-top:8px;"><b>📋 关注:</b> ${data.watchlist.map(c => `<code>${escapeHtml(c)}</code>`).join(' ')}</div>`;
        }
        out.innerHTML = `<div style="font-size:11px;color:var(--text-muted);">意图: ${escapeHtml(intent)} · 耗时 ${r.totalMs || 0}ms</div>${stepHtml}${finalHtml || '<div style="margin-top:8px;color:var(--text-muted);">本次无输出 (数据太少或 LLM 返空)</div>'}`;
      } catch (e) {
        out.innerHTML = '❌ ' + escapeHtml(e.message);
        console.error('[aiColleague]', e);
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    },

    /** 5.3.2: 推 AI 记忆到 Supabase */
    async _pushAIMemory(btn) {
      const out = document.getElementById('aiMemoryResult');
      if (!out) return;
      if (!Core.Sync?.isLoggedIn?.()) {
        out.innerHTML = '⚠ 未登录 Supabase, 请到 ⚙️ 设置里登录';
        out.style.color = 'var(--text-muted)';
        return;
      }
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ 推送...';
      out.textContent = '';
      try {
        const r = await Core.Sync.pushAIMemory();
        out.innerHTML = `✅ 推送 ${r.journals} 复盘 + ${r.alerts} 告警 (${r.total} 条, ts=${r.ts})`;
        out.style.color = 'var(--up)';
      } catch (e) {
        out.innerHTML = '❌ ' + escapeHtml(e.message);
        out.style.color = 'var(--down)';
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    },

    /** 5.3.2: 从 Supabase 拉 AI 记忆 */
    async _pullAIMemory(btn) {
      const out = document.getElementById('aiMemoryResult');
      if (!out) return;
      if (!Core.Sync?.isLoggedIn?.()) {
        out.innerHTML = '⚠ 未登录 Supabase, 请到 ⚙️ 设置里登录';
        out.style.color = 'var(--text-muted)';
        return;
      }
      const oldText = btn.textContent;
      btn.disabled = true;
      btn.textContent = '⏳ 拉取...';
      out.textContent = '';
      try {
        const r = await Core.Sync.pullAIMemory();
        if (r.reason === 'no-cloud-data') {
          out.innerHTML = 'ℹ️ 云端无 AI 记忆';
        } else {
          out.innerHTML = `✅ 合并 ${r.journals} 复盘 + ${r.alerts} 告警 (云端共 ${r.total} 条)`;
        }
        out.style.color = 'var(--up)';
      } catch (e) {
        out.innerHTML = '❌ ' + escapeHtml(e.message);
        out.style.color = 'var(--down)';
      } finally {
        btn.disabled = false;
        btn.textContent = oldText;
      }
    },

    async _formDialog(id) {
      let j = {
        title: '', content: '', code: '', date: fmtDate(new Date()),
        tags: [], mood: 'neutral',
        // 5.2.1: 3 个结构化字段
        assumption: '',  // 买入假设: 业绩拐点/估值修复/题材催化/技术突破/分红套利/其他
        emotion: '',     // 情绪标签: 理性建仓/冲动追高/FOMO/恐慌割肉/计划内止盈/计划内止损/长期持有中/其他
        verify: 'pending' // 事后验证: pending/1w/1m/3m/verified
      };
      if (id) {
        const found = await Core.Storage.get('journals', id);
        if (found) j = found;
      }
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Journal.closeModal()">
          <div class="modal" style="max-width:640px;width:100%;">
            <h3>${id ? '编辑' : '新建'}复盘</h3>
            <div class="form-row">
              <label>日期</label>
              <input type="date" id="jDate" value="${escapeHtml(j.date || '')}" onchange="Journal._maybeReloadSnapshot()">
            </div>
            <div class="form-row">
              <label>标题</label>
              <input type="text" id="jTitle" value="${escapeHtml(j.title || '')}" placeholder="今天的复盘总结">
            </div>
            <div class="form-row">
              <label>关联股票</label>
              <input type="text" id="jCode" value="${escapeHtml(j.code || '')}" placeholder="可选,600519">
            </div>
            <div class="form-row">
              <label>买入假设 (5.2.1)</label>
              <select id="jAssumption">
                <option value="" ${!j.assumption ? 'selected' : ''}>(未选)</option>
                <option value="业绩拐点" ${j.assumption === '业绩拐点' ? 'selected' : ''}>业绩拐点</option>
                <option value="估值修复" ${j.assumption === '估值修复' ? 'selected' : ''}>估值修复</option>
                <option value="题材催化" ${j.assumption === '题材催化' ? 'selected' : ''}>题材催化</option>
                <option value="技术突破" ${j.assumption === '技术突破' ? 'selected' : ''}>技术突破</option>
                <option value="分红套利" ${j.assumption === '分红套利' ? 'selected' : ''}>分红套利</option>
                <option value="其他" ${j.assumption === '其他' ? 'selected' : ''}>其他</option>
              </select>
            </div>
            <div class="form-row">
              <label>情绪标签 (5.2.1)</label>
              <select id="jEmotion">
                <option value="" ${!j.emotion ? 'selected' : ''}>(未选)</option>
                <option value="理性建仓" ${j.emotion === '理性建仓' ? 'selected' : ''}>理性建仓</option>
                <option value="冲动追高" ${j.emotion === '冲动追高' ? 'selected' : ''}>冲动追高</option>
                <option value="FOMO" ${j.emotion === 'FOMO' ? 'selected' : ''}>FOMO</option>
                <option value="恐慌割肉" ${j.emotion === '恐慌割肉' ? 'selected' : ''}>恐慌割肉</option>
                <option value="计划内止盈" ${j.emotion === '计划内止盈' ? 'selected' : ''}>计划内止盈</option>
                <option value="计划内止损" ${j.emotion === '计划内止损' ? 'selected' : ''}>计划内止损</option>
                <option value="长期持有中" ${j.emotion === '长期持有中' ? 'selected' : ''}>长期持有中</option>
                <option value="其他" ${j.emotion === '其他' ? 'selected' : ''}>其他</option>
              </select>
            </div>
            <div class="form-row">
              <label>事后验证 (5.2.1)</label>
              <select id="jVerify">
                <option value="pending" ${(j.verify || 'pending') === 'pending' ? 'selected' : ''}>⏳ 待回看</option>
                <option value="1w" ${j.verify === '1w' ? 'selected' : ''}>📅 1 周后</option>
                <option value="1m" ${j.verify === '1m' ? 'selected' : ''}>📅 1 月后</option>
                <option value="3m" ${j.verify === '3m' ? 'selected' : ''}>📅 3 月后</option>
                <option value="verified" ${j.verify === 'verified' ? 'selected' : ''}>✅ 已验证</option>
              </select>
            </div>
            <div class="form-row">
              <label>标签</label>
              <input type="text" id="jTags" value="${escapeHtml((j.tags || []).join(','))}" placeholder="用逗号分隔,如:趋势,试仓,止损">
            </div>
            <div class="form-row">
              <label>心情</label>
              <select id="jMood">
                <option value="bullish" ${j.mood === 'bullish' ? 'selected' : ''}>看多 🐂</option>
                <option value="bearish" ${j.mood === 'bearish' ? 'selected' : ''}>看空 🐻</option>
                <option value="neutral" ${j.mood === 'neutral' ? 'selected' : ''}>中性 😐</option>
              </select>
            </div>
            ${id ? '' : `
            <div class="form-row" id="journalSnapshotRow" style="background:var(--bg-base);padding:10px;border-radius:6px;">
              <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">
                <strong style="font-size:13px;">📋 今日数据快照</strong>
                <div style="display:flex;gap:6px;">
                  <button class="btn btn-sm btn-ghost" type="button" onclick="Journal._loadSnapshotNow()">🔄 刷新</button>
                  <button class="btn btn-sm btn-primary" type="button" onclick="Journal._insertSnapshot()">📥 插入到正文</button>
                </div>
              </div>
              <div id="journalSnapshotBody" style="font-size:12px;line-height:1.6;color:var(--text-secondary);">⏳ 加载中...</div>
            </div>
            `}
            <div class="form-row">
              <label>正文(Markdown)</label>
              <textarea id="jContent" rows="10" placeholder="## 今日操作\n- ...">${escapeHtml(j.content || '')}</textarea>
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Journal.closeModal()">取消</button>
              ${id ? `<button class="btn btn-danger" onclick="Journal.remove('${id}')">删除</button>` : ''}
              <button class="btn btn-primary" onclick="Journal.save('${id || ''}')">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;

      // 新建时自动加载当日快照
      if (!id) {
        this._currentSnapshot = null;
        this._loadSnapshotNow();
      }
    },

    /**
     * 加载并渲染当日快照 UI
     */
    async _loadSnapshotNow() {
      const body = document.getElementById('journalSnapshotBody');
      if (!body) return;
      const date = document.getElementById('jDate')?.value || fmtDate(new Date());
      body.innerHTML = '<div style="color:var(--text-muted);">⏳ 拉取指数/持仓/流水...</div>';

      try {
        this._currentSnapshot = await this._loadDailySnapshot(date);
        body.innerHTML = this._renderSnapshotHTML(this._currentSnapshot);
      } catch (e) {
        body.innerHTML = `<div style="color:var(--down);">⚠ 加载失败: ${escapeHtml(e.message)}</div>`;
        console.warn('[Journal] 快照加载失败:', e);
      }
    },

    /**
     * 日期改了, 重新加载
     */
    _maybeReloadSnapshot() {
      if (this._currentSnapshot !== undefined && document.getElementById('journalSnapshotBody')) {
        this._loadSnapshotNow();
      }
    },

    /**
     * 加载当日快照 (大盘 + 持仓 + 流水)
     * 失败部分降级: 拉不到指数/拉不到 quote 都不阻塞其他
     */
    async _loadDailySnapshot(date) {
      const result = { date, indices: [], holdings: [], cashflow: [], errors: [] };

      // 1. 大盘指数 (优先用 Core.Market, 失败回退到 Core.Data)
      // Core.Market 跟其他页 (资金账户/选股/复盘) 共享同一缓存, 切页不会重复拉
      try {
        let idx = null;
        if (window.Core && Core.Market && typeof Core.Market.get === 'function') {
          const snap = await Core.Market.get('wide');
          if (snap && Array.isArray(snap.items)) {
            idx = snap.items.map(it => ({
              代码: it.code, 名称: it.name,
              最新价: it.price, 涨跌幅: it.change
            }));
            if (snap.stale) result.errors.push('指数(旧缓存)');
          }
        }
        if (!idx) {
          idx = await Core.Data.getIndexSpot();
        }
        // 接口字段: 代码/最新价/涨跌幅/涨跌额/成交量/成交额 (依 AKShare 版本)
        result.indices = (idx || []).slice(0, 6).map(it => ({
          code: it.代码 || it.code,
          name: it.名称 || it.name,
          price: parseFloat(it.最新价 ?? it.price ?? 0),
          change: parseFloat(it.涨跌幅 ?? it.change_pct ?? 0)
        }));
      } catch (e) {
        result.errors.push('指数: ' + e.message);
        console.warn('[Journal] 拉指数失败:', e);
      }

      // 2. 持仓当日盈亏 (按代码并行拉 quote)
      try {
        const holdings = ((await Core.Storage.all('holdings')) || []).filter(h => !h.isPaper);  // 排除模拟盘
        // 5.1.1: 拉所有 buy 交易, 找每只的最早买入日
        let buyTxByHolding = {};
        try {
          const txs = ((await Core.Storage.all('transactions')) || []).filter(t => !t.isPaper);
          for (const t of (txs || [])) {
            if (t.type === 'buy') {
              const cur = buyTxByHolding[t.holdingId];
              if (!cur || (t.date || '') < (cur.date || '')) buyTxByHolding[t.holdingId] = t;
            }
          }
        } catch (e) {
          // V6: 用户可见提示 — 读不到 transactions 时复盘业绩归因会缺数据, 用户看到空值但不报错
          console.warn('[Journal] 读 transactions 失败:', e);
          if (window.Core && Core.Toast && Core.Toast.warning) {
            Core.Toast.warning('复盘读交易流水失败, 业绩归因可能不全', 5000);
          }
        }
        const snapshotDate = date ? new Date(date) : new Date();
        const withPL = [];
        // Phase 2.4: 走 Facade.getQuoteMany 批量, 失败时降级单只 getStockQuote
        let envByCode = {};
        if (Core.Data && Core.Data.Facade && typeof Core.Data.Facade.getQuoteMany === 'function') {
          try {
            const envs = await Core.Data.Facade.getQuoteMany(holdings.map(h => h.code).filter(Boolean));
            envs.forEach(e => { if (e && e.symbol) envByCode[e.symbol] = e; });
          } catch (_) { /* fall through to single fetcher below */ }
        }
        for (const h of holdings) {
          const shares = parseFloat(h.shares) || 0;
          if (shares <= 0) continue;
          let price = null, changePct = null;
          try {
            const env = envByCode[h.code] || (Core.Data && Core.Data.Facade ? await Core.Data.Facade.getQuote(h.code) : null);
            if (env && env.payload) {
              price = env.payload.price;
              changePct = (env.payload.changePercent != null) ? env.payload.changePercent * 100 : null;  // 转回 %
            } else {
              const q = await Core.Data.getStockQuote(h.code);
              if (!q) continue;
              price = parseFloat(q.最新价 ?? q.price ?? 0);
              changePct = parseFloat(q.涨跌幅 ?? q.change_pct ?? 0);
            }
            const cost = parseFloat(h.cost) || 0;
            const mkt = shares * price;
            const costTotal = shares * cost;
            const dayPL = mkt * (changePct / 100);  // 当日盈亏 = 当前市值 × 当日涨跌幅
            const totalPL = mkt - costTotal;
            // 5.1.1: 持仓天数 = 快照日期 - 最早买入日
            const firstBuy = buyTxByHolding[h.id];
            const firstBuyDate = firstBuy ? firstBuy.date : (h.createdAt ? fmtDate(new Date(h.createdAt)) : null);
            let holdingDays = null;
            if (firstBuyDate) {
              const start = new Date(firstBuyDate);
              if (!isNaN(start.getTime())) {
                holdingDays = Math.max(0, Math.floor((snapshotDate.getTime() - start.getTime()) / 86400000));
              }
            }
            withPL.push({
              code: h.code,
              name: h.name || '',
              shares,
              price,
              changePct,
              dayPL,
              totalPL,
              mkt,
              holdingDays
            });
          } catch (e) {
            // 单只失败不阻塞
            console.warn('[Journal] 拉持仓 quote 失败:', h.code, e);
          }
        }
        result.holdings = withPL;
      } catch (e) {
        result.errors.push('持仓: ' + e.message);
        console.warn('[Journal] 读 holdings 失败:', e);
      }

      // 3. 当日资金流水
      try {
        const all = await Core.Storage.all('cashflow');
        result.cashflow = (all || []).filter(f => f.date === date);
      } catch (e) {
        result.errors.push('流水: ' + e.message);
        console.warn('[Journal] 读 cashflow 失败:', e);
      }

      return result;
    },

    /**
     * 渲染快照 HTML
     */
    _renderSnapshotHTML(snap) {
      if (!snap) return '<div style="color:var(--text-muted);">无数据</div>';

      const idxHTML = snap.indices.length === 0
        ? '<div style="color:var(--text-muted);">指数拉取失败 (检查 aktools)</div>'
        : `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;">
            ${snap.indices.map(i => {
              const c = i.change > 0 ? 'var(--up)' : (i.change < 0 ? 'var(--down)' : 'var(--text-muted)');
              const sign = i.change > 0 ? '+' : '';
              return `<div style="background:var(--bg-card);padding:6px;border-radius:4px;">
                <div style="font-size:11px;color:var(--text-muted);">${escapeHtml(i.name || i.code)}</div>
                <div style="font-size:13px;font-weight:600;">${i.price.toFixed(2)}</div>
                <div style="font-size:11px;color:${c};">${sign}${i.change.toFixed(2)}%</div>
              </div>`;
            }).join('')}
          </div>`;

      const totalMkt = snap.holdings.reduce((s, h) => s + h.mkt, 0);
      const totalDayPL = snap.holdings.reduce((s, h) => s + h.dayPL, 0);
      const totalTotalPL = snap.holdings.reduce((s, h) => s + h.totalPL, 0);
      const dayColor = totalDayPL > 0 ? 'var(--up)' : (totalDayPL < 0 ? 'var(--down)' : 'var(--text-muted)');
      const daySign = totalDayPL > 0 ? '+' : '';

      const holdingsHTML = snap.holdings.length === 0
        ? '<div style="color:var(--text-muted);">当前无持仓</div>'
        : `<div style="font-size:12px;">
            持仓 ${snap.holdings.length} 只 · 市值 ${fmtMoney(totalMkt)} ·
            <span style="color:${dayColor};font-weight:600;">当日 ${daySign}${fmtMoney(totalDayPL)}</span> ·
            累计 ${fmtMoney(totalTotalPL)}
            <div style="margin-top:4px;color:var(--text-muted);font-size:11px;">
              ${snap.holdings.slice(0, 5).map(h => {
                const c = h.dayPL > 0 ? 'var(--up)' : (h.dayPL < 0 ? 'var(--down)' : 'var(--text-muted)');
                const sign = h.dayPL > 0 ? '+' : '';
                return `<span style="margin-right:8px;">${escapeHtml(h.code)} ${escapeHtml((h.name || '').slice(0, 4))} <span style="color:${c};">${sign}${fmtMoney(h.dayPL)}</span></span>`;
              }).join('')}
              ${snap.holdings.length > 5 ? '...' : ''}
            </div>
          </div>`;

      const cashflowHTML = snap.cashflow.length === 0
        ? '<div style="color:var(--text-muted);">当日无资金操作</div>'
        : `<div style="font-size:12px;">
            ${snap.cashflow.map(f => {
              const c = f.amount >= 0 ? 'var(--up)' : 'var(--down)';
              const sign = f.amount >= 0 ? '+' : '';
              return `<div>${escapeHtml(f.date)} · ${escapeHtml(f.type)} · <span style="color:${c};">${sign}${fmtMoney(f.amount)}</span>${f.target ? ' · ' + escapeHtml(f.target) : ''}${f.note ? ' · ' + escapeHtml(f.note.slice(0, 30)) : ''}</div>`;
            }).join('')}
          </div>`;

      const errHTML = snap.errors.length > 0
        ? `<div style="color:var(--down);font-size:11px;margin-top:4px;">⚠ 部分失败: ${snap.errors.map(escapeHtml).join('; ')}</div>`
        : '';

      return `
        <div style="margin-bottom:8px;">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">🌐 大盘</div>
          ${idxHTML}
        </div>
        <div style="margin-bottom:8px;">
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">💼 持仓</div>
          ${holdingsHTML}
        </div>
        <div>
          <div style="font-size:11px;color:var(--text-muted);margin-bottom:4px;">💸 资金流水</div>
          ${cashflowHTML}
        </div>
        ${errHTML}
      `;
    },

    /**
     * 把当前快照格式化为 Markdown 文本 (供插入正文)
     */
    _formatSnapshotForMarkdown(snap) {
      if (!snap) return '';
      const lines = [];
      lines.push(`## 今日数据快照 (${snap.date})`);
      lines.push('');

      // 指数
      if (snap.indices.length > 0) {
        lines.push('### 🌐 大盘');
        lines.push('| 指数 | 点位 | 涨跌幅 |');
        lines.push('|---|---|---|');
        for (const i of snap.indices) {
          const sign = i.change > 0 ? '+' : '';
          lines.push(`| ${i.name || i.code} | ${i.price.toFixed(2)} | ${sign}${i.change.toFixed(2)}% |`);
        }
        lines.push('');
      }

      // 持仓
      if (snap.holdings.length > 0) {
        const totalMkt = snap.holdings.reduce((s, h) => s + h.mkt, 0);
        const totalDayPL = snap.holdings.reduce((s, h) => s + h.dayPL, 0);
        const totalTotalPL = snap.holdings.reduce((s, h) => s + h.totalPL, 0);
        const daySign = totalDayPL > 0 ? '+' : '';
        lines.push(`### 💼 持仓 (${snap.holdings.length} 只, 市值 ${totalMkt.toFixed(2)} 元, 当日 ${daySign}${totalDayPL.toFixed(2)}, 累计 ${totalTotalPL.toFixed(2)})`);
        lines.push('| 代码 | 名称 | 份额 | 价 | 持仓天数 | 当日盈亏 | 累计盈亏 |');
        lines.push('|---|---|---|---|---|---|---|');
        for (const h of snap.holdings) {
          const ds = h.dayPL > 0 ? '+' : '';
          const ts = h.totalPL > 0 ? '+' : '';
          const daysStr = h.holdingDays !== null ? `${h.holdingDays}` : '-';
          lines.push(`| ${h.code} | ${h.name || ''} | ${h.shares} | ${h.price.toFixed(2)} | ${daysStr} | ${ds}${h.dayPL.toFixed(2)} | ${ts}${h.totalPL.toFixed(2)} |`);
        }
        lines.push('');
      } else {
        lines.push('### 💼 持仓');
        lines.push('(空)');
        lines.push('');
      }

      // 流水
      if (snap.cashflow.length > 0) {
        lines.push('### 💸 资金流水');
        for (const f of snap.cashflow) {
          const sign = f.amount >= 0 ? '+' : '';
          lines.push(`- ${f.date} · ${f.type} · ${sign}${f.amount.toFixed(2)} 元${f.target ? ' · ' + f.target : ''}${f.note ? ' · ' + f.note : ''}`);
        }
        lines.push('');
      }

      return lines.join('\n');
    },

    /**
     * 插入快照到正文
     */
    _insertSnapshot() {
      if (!this._currentSnapshot) {
        toastWarning('快照未加载');
        return;
      }
      const md = this._formatSnapshotForMarkdown(this._currentSnapshot);
      const ta = document.getElementById('jContent');
      if (!ta) { toastError('找不到正文框'); return; }
      const cur = ta.value;
      // 如果正文为空, 直接填; 否则 append 在前面(快照应该在前)
      if (cur.trim()) {
        ta.value = md + '\n\n---\n\n' + cur;
      } else {
        ta.value = md;
      }
      toastSuccess('已插入');
    },

    async save(id) {
      const title = document.getElementById('jTitle').value.trim();
      const content = document.getElementById('jContent').value;
      const code = document.getElementById('jCode').value.trim();
      const date = document.getElementById('jDate').value;
      const tags = document.getElementById('jTags').value.split(',').map(s => s.trim()).filter(Boolean);
      const mood = document.getElementById('jMood').value;
      // 5.2.1: 3 个结构化字段
      const assumption = document.getElementById('jAssumption').value;
      const emotion = document.getElementById('jEmotion').value;
      const verify = document.getElementById('jVerify').value;
      if (!title && !content) { toastWarning('标题和正文至少填一个'); return; }
      const data = { title, content, code, date, tags, mood,
        assumption, emotion, verify,  // 5.2.1 结构化
        updatedAt: Date.now() };
      if (id) {
        data.id = id;
        await Core.Storage.put('journals', data);
      } else {
        data.id = uuid();
        data.createdAt = Date.now();
        data.aiSuggested = false;  // 5.2.2: 标记是否被 AI 预填过, 后续可让用户主动触发 AI 复盘助手
        await Core.Storage.add('journals', data);
      }
      this.closeModal();
      toastSuccess('已保存');
      this.render();
      // 5.2.2: 保存后异步触发 AI 复盘助手 v1, 不阻塞 UI
      if (!id && (window.Core && Core.AI)) {
        this._runAiAssistant(data).catch(e => console.warn('[Journal] AI 复盘助手失败:', e));
      }
    },

    /**
     * 5.2.2: AI 复盘助手 v1
     * 每次新建复盘后, 异步调 LLM 自动归类: 买入假设/情绪标签/事后验证
     * 成功 → 用 toast 通知用户, 用户可点击 "应用" 把建议填进最近一次保存
     * 失败 → 静默, 不影响保存流程
     *
     * 提示词故意很短, 避免 LLM 长篇大论; 输出严格 JSON 方便解析
     */
    async _runAiAssistant(savedNote) {
      try {
        const aiCfg = (window.Core && Core.AI) ? Core.AI.getConfig() : null;
        if (!aiCfg || (!aiCfg.apiKey && aiCfg.provider !== 'custom')) {
          // 没配 API Key, 直接跳过
          return;
        }
        const content = (savedNote.content || '').trim();
        if (!content || content.length < 10) return;

        const ASSUMPTIONS = ['业绩拐点', '估值修复', '题材催化', '技术突破', '分红套利', '其他'];
        const EMOTIONS = ['理性建仓', '冲动追高', 'FOMO', '恐慌割肉', '计划内止盈', '计划内止损', '长期持有中', '其他'];
        const VERIFIES = ['pending', '1w', '1m', '3m', 'verified'];

        const systemPrompt = `你是一个严谨的 A 股个人投资复盘助手, 任务是从复盘笔记中提取结构化标签, 严格按用户提供的候选分类选择, 禁止编造。规则:
1. 只能从下方候选值里选, 选最匹配的一个
2. 输出严格 JSON, 三个字段分别选一个值
3. 没把握的字段填 "其他" / "pending"
4. 严禁自由发挥或解释`;

        // Regime 状态注入 (跟 5 调用方对齐: 让 LLM 知道当前市场状态, 影响 assumption 判定)
        let regimeBlock = '';
        try {
          if (Core.Regime && typeof Core.Regime._formatRegimeBlock === 'function') {
            regimeBlock = Core.Regime._formatRegimeBlock() || '';
          }
        } catch (e) { /* 降级空串 */ }

        const userPrompt = `【复盘笔记】
标题: ${savedNote.title || '(无)'}
关联股票: ${savedNote.code || '(无)'}
正文:
${content.slice(0, 800)}

${regimeBlock ? regimeBlock + '\n' : ''}【候选值】
买入假设: ${ASSUMPTIONS.join(' / ')}
情绪标签: ${EMOTIONS.join(' / ')}
事后验证: pending(还没回头看) / 1w(1 周后回看) / 1m(1 月后回看) / 3m(3 月后回看) / verified(已验证)

【输出 JSON】
{"assumption":"...","emotion":"...","verify":"..."}`;

        const text = await Core.AI.callThrough({
          systemPrompt,
          prompt: userPrompt,
          stream: false,
          maxTokens: 200,
          page: 'journal', purpose: 'ai-colleague-assumption'
        }, 'journal');
        // Phase T: schema 校验 (3 个字段必填字符串)
        const parsed = Core.AI.parseJsonOutput(text, {
          required: ['assumption', 'emotion', 'verify'],
          types: { assumption: 'string', emotion: 'string', verify: 'string' }
        });
        if (!parsed.ok) {
          console.warn('[Journal] AI JSON 校验失败:', parsed.errors);
          return;
        }
        const obj = parsed.obj;
        // 校验: 必须从候选值里选, 不接受 LLM 自由发挥
        const sugAssumption = ASSUMPTIONS.includes(obj.assumption) ? obj.assumption : '其他';
        const sugEmotion = EMOTIONS.includes(obj.emotion) ? obj.emotion : '其他';
        const sugVerify = VERIFIES.includes(obj.verify) ? obj.verify : 'pending';

        // 把建议存到 note 上, 弹 toast 让用户确认
        savedNote.aiSuggested = { assumption: sugAssumption, emotion: sugEmotion, verify: sugVerify };
        await Core.Storage.put('journals', savedNote);
        this.render();

        // 通知 (用户可点击 "应用" 把 AI 建议写入 3 个字段)
        this._showAiSuggestionToast(savedNote, savedNote.aiSuggested);
      } catch (e) {
        console.warn('[Journal] _runAiAssistant 解析失败:', e);
      }
    },

    /**
     * AI 建议确认 toast
     * 用户点 "应用" → 把 3 个字段更新到这条 note + 重新渲染
     */
    _showAiSuggestionToast(note, sug) {
      const summary = `${note.code || '通用'} | 假设:${sug.assumption} | 情绪:${sug.emotion} | 验证:${sug.verify}`;
      if (window.toastInfo) {
        toastInfo(`🤖 AI 已建议: ${summary} (回编辑页确认)`, 5000);
      } else if (window.toastWarning) {
        toastWarning(`🤖 AI 已建议: ${summary} (回编辑页确认)`, 5000);
      }
      // 弹一个操作确认 toast, 让用户主动选择是否应用
      // 简单实现: 在该 note 的卡片上加一个"应用 AI 建议"按钮
      const card = document.querySelector(`[data-journal-id="${note.id}"]`);
      if (card && !card.querySelector('.ai-apply-btn')) {
        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-primary ai-apply-btn';
        btn.style.cssText = 'margin-top:4px;font-size:11px;';
        btn.textContent = `🤖 应用 AI 建议: ${sug.assumption} / ${sug.emotion} / ${sug.verify}`;
        btn.onclick = async () => {
          note.assumption = sug.assumption;
          note.emotion = sug.emotion;
          note.verify = sug.verify;
          note.aiAppliedAt = Date.now();
          await Core.Storage.put('journals', note);
          btn.remove();
          this.render();
          toastSuccess('已应用 AI 建议');
        };
        card.appendChild(btn);
      }
    },

    /**
     * Phase H.3: 用户点 🪄 AI 归因 按钮 → 主动触发 AI 归因流程
     * 流程: 拿 note → 内联 _runAiAssistant 核心逻辑 → 复用 _showAiSuggestionToast(卡片加应用按钮)
     * 防重: card.dataset.aiAttrRunning 在请求期间标记
     */
    async _runAttributeManually(noteId) {
      const list = await Core.Storage.all('journals');
      const note = (list || []).find(x => x.id === noteId);
      if (!note) return;
      const card = document.querySelector(`[data-journal-id="${noteId}"]`);
      if (!card) return;

      // 防重入 (用 card 上的 dataset, 不依赖按钮 class)
      if (card.dataset.aiAttrRunning === '1') return;
      card.dataset.aiAttrRunning = '1';
      const btn = card.querySelector('[data-role="ai-attr-btn"]');
      if (btn) {
        btn.textContent = '⏳ AI 归因中...';
        btn.disabled = true;
      }
      // scroll-into-view 让用户看到进度
      try { card.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { console.warn('[Journal] scrollIntoView 失败:', e); }

      try {
        const aiCfg = (window.Core && Core.AI) ? Core.AI.getConfig() : null;
        if (!aiCfg || (!aiCfg.apiKey && aiCfg.provider !== 'custom')) {
          if (window.toastError) toastError('未配置 AI,无法归因(请到设置页配 API Key 或本地 LLM)');
          return;
        }
        const content = (note.content || '').trim();
        if (!content || content.length < 10) {
          if (window.toastWarning) toastWarning('正文太短(<10 字), 无法 AI 归因');
          return;
        }

        const ASSUMPTIONS = ['业绩拐点', '估值修复', '题材催化', '技术突破', '分红套利', '其他'];
        const EMOTIONS = ['理性建仓', '冲动追高', 'FOMO', '恐慌割肉', '计划内止盈', '计划内止损', '长期持有中', '其他'];
        const VERIFIES = ['pending', '1w', '1m', '3m', 'verified'];

        const systemPrompt = `你是一个严谨的 A 股个人投资复盘助手, 任务是从复盘笔记中提取结构化标签, 严格按用户提供的候选分类选择, 禁止编造。规则:
1. 只能从下方候选值里选, 选最匹配的一个
2. 输出严格 JSON, 三个字段分别选一个值
3. 没把握的字段填 "其他" / "pending"
4. 严禁自由发挥或解释`;

        const userPrompt = `【复盘笔记】
标题: ${note.title || '(无)'}
关联股票: ${note.code || '(无)'}
正文:
${content.slice(0, 800)}

【候选值】
买入假设: ${ASSUMPTIONS.join(' / ')}
情绪标签: ${EMOTIONS.join(' / ')}
事后验证: pending(还没回头看) / 1w(1 周后回看) / 1m(1 月后回看) / 3m(3 月后回看) / verified(已验证)

【输出 JSON】
{"assumption":"...","emotion":"...","verify":"..."}`;

        const text = await Core.AI.callThrough({
          systemPrompt, prompt: userPrompt, stream: false, maxTokens: 200,
          page: 'journal', purpose: 'ai-colleague-assumption-v2'
        }, 'journal');
        const m = text.match(/\{[\s\S]*?\}/);
        if (!m) {
          if (window.toastError) toastError('AI 返回非 JSON 格式');
          return;
        }
        const obj = JSON.parse(m[0]);
        const sugAssumption = ASSUMPTIONS.includes(obj.assumption) ? obj.assumption : '其他';
        const sugEmotion = EMOTIONS.includes(obj.emotion) ? obj.emotion : '其他';
        const sugVerify = VERIFIES.includes(obj.verify) ? obj.verify : 'pending';

        note.aiSuggested = { assumption: sugAssumption, emotion: sugEmotion, verify: sugVerify };
        await Core.Storage.put('journals', note);

        // 走既有 toast + 卡片"应用 AI 建议"按钮(同一 _showAiSuggestionToast)
        this._showAiSuggestionToast(note, note.aiSuggested);
      } catch (e) {
        console.warn('[Journal] _runAttributeManually 失败:', e);
        if (window.toastError) toastError('AI 归因失败: ' + e.message);
      } finally {
        card.dataset.aiAttrRunning = '';
        if (btn) {
          btn.disabled = false;
          btn.textContent = '🪄 AI 归因';
        }
      }
    },

    async remove(id) {
      if (!confirm('确定删除此复盘?')) return;
      await Core.Storage.remove('journals', id);
      this.closeModal();
      toastSuccess('已删除');
      this.render();
    },

    closeModal() {
      this._currentSnapshot = null;
      document.getElementById('modalRoot').innerHTML = '';
    }
  };

  window.Journal = Journal;
  window._onShow_pageJournal = function() {
    Journal.render();
    if (window.MarketBar) MarketBar.mount('pageJournal', 'wide');
  };
})();
