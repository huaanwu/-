/**
 * Screener - 选股筛选
 * 多条件筛选(基本面 + 技术面)
 */
(function() {
  'use strict';

  const Screener = {

    async init() {
      this._renderForm();
    },

    _renderForm() {
      const root = document.getElementById('screenerForm');
      if (!root) return;
      const aiCfg = (window.Core && Core.AI) ? Core.AI.getConfig() : { provider: '(未配置)', model: '' };
      root.innerHTML = `
        <div class="form-row">
          <label>市场</label>
          <select id="scMarket">
            <option value="all">全部</option>
            <option value="sh">沪市(60/68)</option>
            <option value="sz">深市(00/30)</option>
            <option value="bj">北交所(8/43)</option>
          </select>
        </div>
        <div class="form-row">
          <label>PE (TTM)</label>
          <input type="number" id="scPE" placeholder="0~50" step="1">
        </div>
        <div class="form-row">
          <label>PB</label>
          <input type="number" id="scPB" placeholder="0~10" step="0.1">
        </div>
        <div class="form-row">
          <label>总市值(亿)</label>
          <input type="number" id="scMktCap" placeholder=">50" step="10">
        </div>
        <div class="form-row">
          <label>换手率(%)</label>
          <input type="number" id="scTurnover" placeholder=">1" step="0.1">
        </div>
        <div class="form-row">
          <label>涨跌幅(%)</label>
          <input type="text" id="scChange" placeholder="例: 2~7">
        </div>
        <div class="form-row">
          <label>结果数</label>
          <select id="scLimit">
            <option value="20">前 20</option>
            <option value="50" selected>前 50</option>
            <option value="100">前 100</option>
            <option value="500">前 500</option>
          </select>
        </div>
        <div class="form-row">
          <label>📰 选股偏好 (可选, 喂给 AI)</label>
          <textarea id="scPreference" rows="2" placeholder="例:
- 想要高分红的蓝筹
- 避开地产/银行/券商
- 关注新能源/医药龙头
- 中长线持有, 不看短线"></textarea>
          <div style="font-size:11px;color:var(--text-muted);">
            跑完硬筛后, 点 [🤖 AI 解读结果] 会把这些偏好 + 宏观环境 + top 候选股 一起喂给 LLM。
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          ⚠️ 拉全市场数据较慢,请耐心等待。当前 AI: <strong>${escapeHtml(aiCfg.provider)}</strong>
        </div>
      `;
    },

    async run() {
      const resultEl = document.getElementById('screenerResult');
      resultEl.innerHTML = '<div class="loading">加载全市场行情(可能需要 10-30 秒)...</div>';

      try {
        // 1) 拉全市场行情
        const all = await Core.Data.getStockSpot();
        if (!Array.isArray(all) || all.length === 0) {
          resultEl.innerHTML = '<div class="empty">未获取到行情数据</div>';
          return;
        }

        // 2) 解析筛选条件
        const market = document.getElementById('scMarket').value;
        const peMax = parseFloat(document.getElementById('scPE').value);
        const pbMax = parseFloat(document.getElementById('scPB').value);
        const mktCapMin = parseFloat(document.getElementById('scMktCap').value);
        const turnoverMin = parseFloat(document.getElementById('scTurnover').value);
        const changeRange = document.getElementById('scChange').value.trim();
        const limit = parseInt(document.getElementById('scLimit').value) || 50;

        // 涨跌幅区间 "2~7" → [2, 7]
        let changeMin = null, changeMax = null;
        if (changeRange) {
          const m = changeRange.match(/^(-?\d+(?:\.\d+)?)\s*~\s*(-?\d+(?:\.\d+)?)$/);
          if (m) {
            changeMin = parseFloat(m[1]);
            changeMax = parseFloat(m[2]);
          }
        }

        // 3) 筛选
        const filtered = all.filter(s => {
          const code = s.代码;
          // 市场
          if (market === 'sh' && !/^(60|68)/.test(code)) return false;
          if (market === 'sz' && !/^(00|30)/.test(code)) return false;
          if (market === 'bj' && !/^(8|43)/.test(code)) return false;

          // PE
          if (!isNaN(peMax)) {
            const pe = parseFloat(s.市盈率);
            if (isNaN(pe) || pe <= 0 || pe > peMax) return false;
          }
          // PB
          if (!isNaN(pbMax)) {
            const pb = parseFloat(s.市净率);
            if (isNaN(pb) || pb <= 0 || pb > pbMax) return false;
          }
          // 总市值(亿)
          if (!isNaN(mktCapMin)) {
            const mc = parseFloat(s.总市值);
            if (isNaN(mc) || mc < mktCapMin * 1e8) return false;
          }
          // 换手率
          if (!isNaN(turnoverMin)) {
            const to = parseFloat(s.换手率);
            if (isNaN(to) || to < turnoverMin) return false;
          }
          // 涨跌幅区间
          if (changeMin !== null) {
            const ch = parseFloat(s.涨跌幅);
            if (isNaN(ch) || ch < changeMin) return false;
          }
          if (changeMax !== null) {
            const ch = parseFloat(s.涨跌幅);
            if (isNaN(ch) || ch > changeMax) return false;
          }
          return true;
        });

        // 按涨跌幅降序
        filtered.sort((a, b) => parseFloat(b.涨跌幅) - parseFloat(a.涨跌幅));
        const top = filtered.slice(0, limit);

        // 保存结果供 AI 解读
        this._lastResults = { all, filtered, top, conditions: { market, peMax, pbMax, mktCapMin, turnoverMin, changeMin, changeMax } };

        // 4) 渲染
        if (top.length === 0) {
          resultEl.innerHTML = '<div class="empty">没有符合条件的股票</div>';
          return;
        }

        const aiCfg = Core.AI.getConfig();
        const hasAiKey = !!aiCfg.apiKey || aiCfg.provider === 'custom';

        resultEl.innerHTML = `
          <div style="padding:12px 16px;color:var(--text-muted);font-size:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <span>命中 ${filtered.length} 只,展示前 ${top.length} 只(按涨跌幅降序)</span>
            <button class="btn btn-sm btn-primary" onclick="Screener.aiInterpret()" ${hasAiKey ? '' : 'disabled title="请先到 ⚙️ 设置页配置 AI API Key"'}>
              🤖 AI 解读结果
            </button>
          </div>
          <div id="screenerAiResult"></div>
          <table>
            <thead>
              <tr>
                <th>代码</th><th>名称</th><th>现价</th><th>涨跌幅</th>
                <th>PE</th><th>PB</th><th>换手率</th><th>总市值</th>
              </tr>
            </thead>
            <tbody>
              ${top.map(s => `
                <tr style="cursor:pointer;" onclick="Watchlist.showKLine('${escapeHtml(s.代码)}','${escapeHtml(s.名称)}')">
                  <td><span class="code">${escapeHtml(s.代码)}</span></td>
                  <td>${escapeHtml(s.名称)}</td>
                  <td>${fmtNum(parseFloat(s.最新价), 2)}</td>
                  <td class="${pctClass(parseFloat(s.涨跌幅) / 100)}">${fmtPct(parseFloat(s.涨跌幅) / 100)}</td>
                  <td>${s.市盈率 !== '-' && s.市盈率 != null ? parseFloat(s.市盈率).toFixed(1) : '-'}</td>
                  <td>${s.市净率 !== '-' && s.市净率 != null ? parseFloat(s.市净率).toFixed(2) : '-'}</td>
                  <td>${s.换手率 ? parseFloat(s.换手率).toFixed(2) + '%' : '-'}</td>
                  <td>${s.总市值 ? fmtMoney(parseFloat(s.总市值)) : '-'}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        `;
      } catch (e) {
        resultEl.innerHTML = `<div class="empty">筛选失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    /**
     * AI 解读硬筛结果 — 从命中股票里挑 5-10 只, 多维分析
     */
    async aiInterpret() {
      if (!this._lastResults) { toastWarning('请先跑一次硬筛'); return; }
      const aiCfg = Core.AI.getConfig();
      if (!aiCfg.apiKey && aiCfg.provider !== 'custom') {
        toastError('请先到 ⚙️ 设置页配置 AI API Key');
        return;
      }
      const { filtered, top, conditions } = this._lastResults;
      const preference = document.getElementById('scPreference')?.value.trim() || '';

      const aiResultEl = document.getElementById('screenerAiResult');
      if (!aiResultEl) return;
      aiResultEl.innerHTML = '<div class="ai-stream" style="background:var(--bg-base);border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text-muted);">⏳ AI 思考中, 大约 10-30 秒...</div>';

      // 喂 LLM: 命中股票 top 30 (限制 token)
      const candidates = top.slice(0, 30).map((s, i) => {
        const pe = parseFloat(s.市盈率);
        const pb = parseFloat(s.市净率);
        const turn = parseFloat(s.换手率);
        const mcap = parseFloat(s.总市值);
        return `[${i}] ${s.代码} ${s.名称} | PE=${isNaN(pe) ? '-' : pe.toFixed(1)} | PB=${isNaN(pb) ? '-' : pb.toFixed(2)} | 换手=${isNaN(turn) ? '-' : turn.toFixed(2) + '%'} | 市值=${isNaN(mcap) ? '-' : (mcap / 1e8).toFixed(1) + '亿'} | 涨跌幅=${parseFloat(s.涨跌幅).toFixed(2)}%`;
      }).join('\n');

      // 并行加载宏观 + 新闻 + Phase O: 13 维上下文 + KB
      const macroP = Core.Macro.get().catch(e => ({ data: {} }));
      const newsP = Core.News.get().catch(e => ({ relevant: [] }));
      const ctxP = Core.Data.getAiContextSnapshot().catch(e => null);
      const intlP = Core.Data.getIntlSnapshot().catch(e => null);
      const [macro, news, ctx, intl] = await Promise.all([macroP, newsP, ctxP, intlP]);
      const macroText = macro && macro.data ? Core.Macro.formatForPrompt(macro) : '';
      const newsText = news ? Core.News.formatForPrompt(news, 8) : '';
      const ctxText = ctx ? Core.Data.formatAiContextForPrompt(ctx) : '(市场上下文不可用)';
      const intlText = intl ? Core.Data.formatIntlForPrompt(intl) : '(国际形势不可用)';

      // KB 智能匹配 (Phase N+O)
      let kbText = '';
      try {
        const topNames = top.slice(0, 8).map(s => ({ name: s.名称 }));
        const kbEntries = await Core.KB.pickRelevant({
          holdings: topNames,
          context: ctx || {},
          maxN: 4
        });
        kbText = Core.KB.formatForPrompt(kbEntries);
      } catch (e) { console.warn('[screener] KB 取条失败:', e); }

      const condsDesc = [];
      if (conditions.market && conditions.market !== 'all') condsDesc.push(`市场=${conditions.market}`);
      if (conditions.peMax) condsDesc.push(`PE ≤ ${conditions.peMax}`);
      if (conditions.pbMax) condsDesc.push(`PB ≤ ${conditions.pbMax}`);
      if (conditions.mktCapMin) condsDesc.push(`市值 ≥ ${conditions.mktCapMin} 亿`);
      if (conditions.turnoverMin) condsDesc.push(`换手率 ≥ ${conditions.turnoverMin}%`);
      if (conditions.changeMin !== null) condsDesc.push(`涨跌幅 ≥ ${conditions.changeMin}%`);
      if (conditions.changeMax !== null) condsDesc.push(`涨跌幅 ≤ ${conditions.changeMax}%`);

      const systemPrompt = `你是 Phase O 高手版 A 股个股投资顾问, 风格稳健, 严守数据边界。

【投资框架】价值 + 趋势 + 风险平价 混合:
- 价值: PE/PB/ROE + 历史分位
- 趋势: 板块轮动、北向方向、行业资金流
- 风险: 个股波动、行业暴露、相关性

【用户画像】长期稳健型 (年化 3-5%), 不追短期暴利。

【输出风格】先证据后结论, 每条 reason 引用具体数据; 给信心等级 (高/中/低)。

【规则】
1. **只能从下方候选池挑选**, 严禁编造不存在的股票代码/名称
2. 输出严格 JSON:
{
  "marketView": "1-2 句当前 A 股市场判断 (必须引用具体宏观数据)",
  "policyView": "1-2 句近期政策/新闻的含义 (如提供)",
  "picks": [
    {
      "code": "xxx",
      "name": "xxx",
      "reasons": ["基本面/估值 1 句 (引用 PE/PB)", "技术面/资金面 1 句", "宏观/政策契合 1 句", "行业板块契合 1 句 (引用板块涨跌)"],
      "riskScore": 1-5 (1=极低, 5=高),
      "confidence": "高" | "中" | "低"
    }
  ],
  "risks": ["风险点 1", "风险点 2", "..."],
  "kbRefs": ["VAL-001", "POS-002"]  // 引用的 KB 条目号
}
3. picks 数量 5-10 只, 按性价比 (低估值 + 高质量) 排序
4. **多维度分析**: 基本面/技术面/资金面/政策面/行业面
5. **KB 引用**: 如有相关条目, 在 reasons 里引用条目号, kbRefs 数组填条目号
6. **置信度**: 高 (多维数据一致+符合 KB 经典模式) / 中 (数据冲突) / 低 (极端市场/新策略)
7. 严禁绝对化表述 ("一定涨" 等)`;

      const userPrompt = `【用户筛选条件】
${condsDesc.length > 0 ? condsDesc.join(', ') : '(无特定条件, 全市场)'}
命中 ${filtered.length} 只, 已按涨跌幅降序展示前 ${top.length} 只。

【用户偏好】
${preference || '(无)'}

${macroText}

${newsText}

${ctxText}

${intlText}

${kbText}

【候选池 (按涨跌幅降序, 最多 30 只, 字段: 代码 名称 PE PB 换手率 市值 涨跌幅)】
${candidates}

请从候选池中挑出 5-10 只最适合用户偏好的股票, 严格使用候选项, JSON 输出 (按 systemPrompt 格式)。每条 reason 引用具体数据, 信心等级和 KB 引用必填。`;

      try {
        const streamEl = aiResultEl.querySelector('.ai-stream');
        const fullText = await Core.AI.call({
          systemPrompt,
          prompt: userPrompt,
          stream: true,
          onChunk: (delta, full) => {
            if (streamEl) {
              streamEl.textContent = full;
              streamEl.scrollTop = streamEl.scrollHeight;
            }
          }
        });

        // Phase T: schema 校验 (picks 必填, 数组, 元素对象)
        const AI_PICK_SCHEMA = {
          required: ['picks', 'risks'],
          types: { picks: 'array', risks: 'array' },
          arrayItemTypes: { picks: 'object' }
        };
        const parsed = Core.AI.parseJsonOutput(fullText, AI_PICK_SCHEMA);
        if (parsed.ok) {
          const obj = parsed.obj;
          const picks = obj.picks || [];
          // 5.1.3: 把 AI 选股结果 (含 reasons/risks) 暂存, 给"加自选"按钮写入 journal 用
          this._lastAiPicks = picks;
          this._lastAiContext = { marketView: obj.marketView || '', policyView: obj.policyView || '', risks: obj.risks || [], conditions };
          let html = '';
          if (obj.marketView) html += `<div class="ai-macro-view"><strong>📈 大盘视角</strong>: ${escapeHtml(obj.marketView)}</div>`;
          if (obj.policyView) html += `<div class="ai-policy-view"><strong>📰 政策/新闻</strong>: ${escapeHtml(obj.policyView)}</div>`;
          html += '<div style="margin:8px 0;">';
          html += picks.map(p => {
            const riskColor = p.riskScore >= 4 ? 'var(--down)' : (p.riskScore <= 2 ? 'var(--up)' : 'var(--text-muted)');
            const reasons = (p.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
            // 5.1.3: data-reasons / data-riskscore 让 addWatchlistFromPick 能拿到 AI 选股理由
            const reasonsJson = JSON.stringify(p.reasons || []).replace(/"/g, '&quot;');
            return `
              <div class="ai-pick">
                <div class="ai-pick-head">
                  <strong>${escapeHtml(p.code)} ${escapeHtml(p.name || '')}</strong>
                  <span class="ai-risk-score" style="color:${riskColor};">风险 ${p.riskScore || '?'}/5</span>
                </div>
                <ul class="ai-pick-reasons">${reasons}</ul>
                <div style="margin-top:6px;">
                  <button class="btn btn-sm btn-primary" data-code="${escapeHtml(p.code)}" data-name="${escapeHtml(p.name || '')}" data-riskscore="${p.riskScore || ''}" data-reasons="${reasonsJson}" data-action="add">📌 加入自选</button>
                  <button class="btn btn-sm" data-code="${escapeHtml(p.code)}" data-name="${escapeHtml(p.name || '')}" data-action="kline">📈 K线</button>
                </div>
              </div>
            `;
          }).join('');
          if (obj.risks && obj.risks.length > 0) {
            html += `<div class="ai-risks"><strong>⚠ 风险点</strong>:<ul>${obj.risks.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
          }
          html += '</div>';

          if (streamEl) {
            streamEl.innerHTML = html;
            // 绑定按钮
            streamEl.querySelectorAll('button[data-code]').forEach(btn => {
              const code = btn.dataset.code;
              const name = btn.dataset.name;
              const action = btn.dataset.action;
              if (action === 'add') {
                // 5.1.3: 改名为 addWatchlistFromPick, 复用 reasons 写 journal
                btn.onclick = () => this._addWatchlistFromPick(btn, code, name);
              } else if (action === 'kline') {
                btn.onclick = () => Watchlist.showKLine(code, name);
              }
            });
          }
        } else {
          // Phase T: schema 校验失败, 显示原始 + 错误明细
          if (streamEl) {
            const errList = parsed.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
            streamEl.innerHTML = `<div style="color:var(--down);">⚠ JSON 校验失败:</div><ul style="margin:4px 0 8px;font-size:12px;">${errList}</ul><pre style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto;">${escapeHtml(fullText)}</pre><div style="margin-top:10px;"><button class="btn btn-primary" onclick="Screener.aiInterpret()">🔄 重新生成</button></div>`;
          }
        }
      } catch (e) {
        if (aiResultEl) {
          aiResultEl.innerHTML = `<div class="ai-stream" style="color:var(--down);">❌ ${escapeHtml(e.message)}</div>`;
        }
        toastError('AI 调用失败: ' + e.message);
      }
    },

    /**
     * 5.1.3: 选股结果一键加自选 + 自动记 AI 选股理由到 journal
     * 复用 btn 上的 data-reasons/data-riskscore, 拼成 Markdown 复盘笔记
     * 加自选失败/已存在时不创建 journal, 避免重复记录
     */
    async _addWatchlistFromPick(btn, code, name) {
      try {
        const exists = await Core.Storage.get('watchlist', code);
        if (exists) { toastWarning(`${code} 已在自选`); return; }

        // 1) 写 watchlist
        await Core.Storage.add('watchlist', { code, name, market: 'sh', addedAt: Date.now() });
        toastSuccess(`已加入自选: ${code} ${name}`);
        btn.disabled = true; btn.textContent = '✓ 已加入';

        // 2) 同步写 journal (5.1.3 互通核心)
        let reasons = [];
        try { reasons = JSON.parse(btn.dataset.reasons || '[]'); } catch (e) { /* ignore */ }
        const riskScore = btn.dataset.riskscore || '';

        const conds = (this._lastAiContext && this._lastAiContext.conditions) || {};
        const condsDesc = [];
        if (conds.market && conds.market !== 'all') condsDesc.push(`市场=${conds.market}`);
        if (conds.peMax) condsDesc.push(`PE ≤ ${conds.peMax}`);
        if (conds.pbMax) condsDesc.push(`PB ≤ ${conds.pbMax}`);
        if (conds.mktCapMin) condsDesc.push(`市值 ≥ ${conds.mktCapMin} 亿`);
        if (conds.turnoverMin) condsDesc.push(`换手率 ≥ ${conds.turnoverMin}%`);
        if (conds.changeMin !== null && conds.changeMin !== undefined) condsDesc.push(`涨跌幅 ≥ ${conds.changeMin}%`);
        if (conds.changeMax !== null && conds.changeMax !== undefined) condsDesc.push(`涨跌幅 ≤ ${conds.changeMax}%`);

        const lines = [];
        lines.push(`## AI 选股结果 - ${code} ${name}`);
        lines.push('');
        lines.push(`**加入时间**: ${fmtDate(new Date())}`);
        lines.push(`**风险评分**: ${riskScore || '?'}/5`);
        if (condsDesc.length > 0) lines.push(`**筛选条件**: ${condsDesc.join(', ')}`);
        lines.push('');
        lines.push('### 📊 AI 选股理由');
        if (reasons.length > 0) {
          for (const r of reasons) lines.push(`- ${r}`);
        } else {
          lines.push('(无)');
        }
        lines.push('');
        if (this._lastAiContext && this._lastAiContext.risks && this._lastAiContext.risks.length > 0) {
          lines.push('### ⚠ 风险点');
          for (const r of this._lastAiContext.risks) lines.push(`- ${r}`);
          lines.push('');
        }
        if (this._lastAiContext && this._lastAiContext.marketView) {
          lines.push(`### 📈 大盘视角\n${this._lastAiContext.marketView}\n`);
        }
        lines.push('---');
        lines.push('*本条由 StockMaster 选股页 [📌 加入自选] 自动生成, 用于后续复盘追溯*');

        const journal = {
          id: uuid(),
          title: `AI 选股: ${code} ${name || ''}`,
          content: lines.join('\n'),
          code,
          date: fmtDate(new Date()),
          tags: ['AI选股', '自选'],
          mood: 'neutral',
          source: 'screener-add',  // 标记来源, 后续可识别/清理
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        await Core.Storage.add('journals', journal);
        toastSuccess(`已记入复盘: ${code} 选股理由`);
      } catch (e) {
        console.error('[Screener] _addWatchlistFromPick 失败:', e);
        toastError('加自选失败: ' + e.message);
      }
    }
  };

  window.Screener = Screener;
  window._onShow_pageScreener = function() {
    if (!document.getElementById('screenerForm').innerHTML) Screener._renderForm();
    if (window.MarketBar) MarketBar.mount('pageScreener', 'industry');
  };
})();
