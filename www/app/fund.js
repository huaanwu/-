/**
 * Fund - 基金专项
 * 自选基金 + 净值走势 + 持仓穿透
 */
(function() {
  'use strict';

  let _chart = null;

  const Fund = {

    async init() {},

    /**
     * 一键导入推荐组合(2026-07-26 基于 akshare 数据硬筛)
     * 仅写入代码+名称+type, 实际份额/成本由用户买入后编辑
     */

    /**
     * 渲染顶部宏观数据条 (24h 缓存, 后台拉, 不阻塞)
     */
    async _renderMacroBar() {
      let bar = document.getElementById('fundMacroBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'fundMacroBar';
        bar.className = 'macro-bar';
        // 插在 summaryEl 之前
        const summary = document.getElementById('fundSummary');
        summary.parentNode.insertBefore(bar, summary);
      }
      bar.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">⏳ 加载宏观数据...</div>';

      try {
        const snap = await Core.Macro.get();
        const d = snap.data;
        const items = [];
        if (d.lpr_1y !== undefined) items.push({ label: 'LPR 1Y', val: d.lpr_1y + '%', sub: d.lpr_date });
        if (d.fdr007 !== undefined) items.push({ label: '回购 7d', val: d.fdr007 + '%', sub: d.repo_date, hint: '↓ 越低资金越松' });
        if (d.cpi !== undefined) items.push({ label: 'CPI YoY', val: d.cpi + '%', sub: d.cpi_date, hint: d.cpi < 0.5 ? '⚠ 通缩' : '' });
        if (d.pmi !== undefined) {
          const state = d.pmi > 50 ? '📈 扩张' : '📉 收缩';
          items.push({ label: 'PMI', val: d.pmi.toString(), sub: d.pmi_date, hint: state });
        }
        if (d.m2 !== undefined) items.push({ label: 'M2 YoY', val: d.m2 + '%', sub: d.m2_date });

        bar.innerHTML = `
          <div class="macro-bar-head">
            <span>🌐 宏观环境快照 (24h 缓存)</span>
            <span class="macro-bar-time">${new Date(snap.generated).toLocaleString()}</span>
            <button class="btn btn-sm btn-ghost" onclick="Fund._refreshMacroBar()">🔄</button>
          </div>
          <div class="macro-bar-grid">
            ${items.map(i => `
              <div class="macro-item">
                <div class="macro-label">${i.label}</div>
                <div class="macro-val">${i.val}</div>
                <div class="macro-sub">${i.sub || ''} ${i.hint || ''}</div>
              </div>
            `).join('')}
          </div>
        `;
      } catch (e) {
        bar.innerHTML = `<div style="font-size:12px;color:var(--down);padding:8px 0;">⚠ 宏观数据加载失败: ${escapeHtml(e.message)} (需要 AKShare 代理运行)</div>`;
      }
    },

    async _refreshMacroBar() {
      await Core.Macro.refresh();
      return this._renderMacroBar();
    },

    /**
     * 渲染财经新闻条 (财新, 6h 缓存, 取 top 5 相关)
     */
    async _renderNewsBar() {
      let bar = document.getElementById('fundNewsBar');
      if (!bar) {
        bar = document.createElement('div');
        bar.id = 'fundNewsBar';
        bar.className = 'news-bar';
        // 插在 macro bar 之后
        const macro = document.getElementById('fundMacroBar');
        if (macro && macro.nextSibling) {
          macro.parentNode.insertBefore(bar, macro.nextSibling);
        } else {
          document.getElementById('fundSummary').parentNode.insertBefore(bar, document.getElementById('fundSummary'));
        }
      }
      bar.innerHTML = '<div style="font-size:11px;color:var(--text-muted);padding:8px 0;">⏳ 加载财经新闻...</div>';

      try {
        const snap = await Core.News.get();
        const top = snap.relevant.slice(0, 5);
        bar.innerHTML = `
          <div class="news-bar-head">
            <span>📰 近期财经新闻 (财新, 相关 top ${top.length}/${snap.relevant.length})</span>
            <span class="news-bar-time">${new Date(snap.generated).toLocaleString()}</span>
            <button class="btn btn-sm btn-ghost" onclick="Fund._refreshNewsBar()">🔄</button>
          </div>
          <div class="news-list">
            ${top.map((it, i) => `
              <div class="news-item">
                <span class="news-tag">${escapeHtml(it.tag || '')}</span>
                <a href="${escapeHtml(it.url || '#')}" target="_blank" rel="noopener" class="news-title">${escapeHtml(it.summary || '')}</a>
              </div>
            `).join('') || '<div style="font-size:11px;color:var(--text-muted);">无强相关内容 (仍加载了 ' + snap.total + ' 篇)</div>'}
          </div>
        `;
      } catch (e) {
        bar.innerHTML = `<div style="font-size:12px;color:var(--down);padding:8px 0;">⚠ 新闻加载失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    async _refreshNewsBar() {
      await Core.News.refresh();
      return this._renderNewsBar();
    },

    async seedRecommended() {
      const RECOMMENDED = [
        { code: '007194', name: '长城短债 A', type: 'short_bond', note: '流动性后备 / 98亿 / 3年10.54% / 回撤-1.22%' },
        { code: '018581', name: '中银纯债 D', type: 'pure_bond', note: '收益主力 / 106亿 / 3年13.04% / 回撤-1.95%' }
      ];
      let added = 0, skipped = 0;
      for (const f of RECOMMENDED) {
        const exists = await Core.Storage.get('funds', f.code);
        if (exists) { skipped++; continue; }
        await Core.Storage.add('funds', {
          code: f.code, name: f.name, type: f.type, note: f.note,
          shares: 0, costNav: 0, addedAt: Date.now()
        });
        added++;
      }
      toastSuccess(`已导入 ${added} 只, 跳过 ${skipped} 只已存在`);
      this.render();
    },

    /**
     * AI 选基 - 弹窗收集用户偏好 + 宏观上下文, 调用 LLM 多维解读
     */
    aiAdvisorDialog() {
      const aiCfg = Core.AI.getConfig();
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:640px;width:100%;">
            <h3>🤖 AI 选基 (多维解读版)</h3>
            <div id="aiAdvisorForm">
              <div class="form-row">
                <label>总金额 (元)</label>
                <input type="number" id="aiAmount" value="50000" step="1000">
              </div>
              <div class="form-row">
                <label>风险偏好</label>
                <select id="aiRisk">
                  <option value="conservative" selected>极度保守 (回撤 &lt; 2%, 跑赢存款即可)</option>
                  <option value="moderate">稳健 (回撤 5-10%, 年化 4-6%)</option>
                  <option value="balanced">平衡 (可接受 10-20% 回撤, 追求更高收益)</option>
                </select>
              </div>
              <div class="form-row">
                <label>投资期限</label>
                <select id="aiHorizon">
                  <option value="1y" selected>1 年内</option>
                  <option value="1-3y">1-3 年</option>
                  <option value="3y+">3 年以上</option>
                </select>
              </div>
              <div class="form-row">
                <label>是否允许权益类 (宽基/红利)</label>
                <select id="aiAllowEquity">
                  <option value="no" selected>不允许 (100% 债基)</option>
                  <option value="yes">允许最多 30%</option>
                </select>
              </div>
              <div class="form-row">
                <label>📰 近期关注 (可选, 多行)</label>
                <textarea id="aiUserNotes" rows="3" placeholder="例:
- 7 月 PMI 跌破 50, 担心通缩
- 央行 8 月可能降准 50bp
- 关注利率债 ETF 机会
- 美联储 9 月降息预期升温"></textarea>
                <div style="font-size:11px;color:var(--text-muted);">这些信息会作为 LLM 的"用户视角"输入, 影响推荐倾向。</div>
              </div>
              <div class="form-row">
                <label>📰 财经新闻 (财新, 6h 缓存)</label>
                <div style="display:flex;gap:8px;align-items:center;">
                  <label style="font-size:12px;font-weight:normal;">
                    <input type="checkbox" id="aiIncludeNews" checked>
                    包含 (自动按关键词筛 top 10)
                  </label>
                  <button class="btn btn-sm btn-ghost" onclick="Fund._aiRefreshNews()">🔄 刷新</button>
                </div>
                <div id="aiNewsStatus" style="font-size:11px;color:var(--text-muted);margin-top:4px;">首次拉 100 篇 (~3s), 关键词过滤后取相关 top 10 注入 prompt。</div>
              </div>
              <div class="form-row">
                <label>🌐 宏观数据 (24h 缓存)</label>
                <button class="btn btn-sm btn-ghost" onclick="Fund._aiRefreshMacro()">🔄 刷新宏观数据</button>
                <div id="aiMacroStatus" style="font-size:11px;color:var(--text-muted);margin-top:4px;">首次会拉 8 项指标 (~5s), 之后 24h 缓存。</div>
              </div>
              <div style="font-size:11px;color:var(--text-muted);line-height:1.6;">
                💡 <strong>多维解读</strong>:
                - <strong>宏观</strong>: LPR / 回购 / CPI / PMI / M2 (自动从 AKShare 拉)
                - <strong>利率敏感</strong>: 久期暴露 / 加息降息影响
                - <strong>信用风险</strong>: 城投 / 地产 / 产业债持仓比例
                - <strong>政策风险</strong>: 监管新规 / 资金面 / 赎回潮
                - <strong>流动性</strong>: 申赎限制 / 规模 / 持有人结构
                - <strong>跨周期</strong>: 熊市回撤 vs 牛市弹性
                <br>当前模型: <strong>${escapeHtml(aiCfg.provider)} / ${escapeHtml(aiCfg.model || '(默认)')}</strong>
              </div>
              <div class="modal-footer">
                <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
                <button class="btn btn-primary" id="aiAdvisorGo" onclick="Fund.aiAdvisorRun()">🚀 让 AI 选</button>
              </div>
            </div>
            <div id="aiAdvisorResult" style="display:none;">
              <div class="ai-stream" id="aiStream" style="min-height:200px;max-height:520px;overflow-y:auto;background:var(--bg-base);border-radius:6px;padding:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;"></div>
              <div id="aiAdvisorActions" style="margin-top:12px;"></div>
              <div class="modal-footer">
                <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async _aiRefreshMacro() {
      const el = document.getElementById('aiMacroStatus');
      el.textContent = '⏳ 拉取中...';
      el.style.color = 'var(--text-muted)';
      try {
        await Core.Macro.refresh();
        const snap = await Core.Macro.get();
        el.textContent = '✓ 刷新成功: ' + new Date(snap.generated).toLocaleTimeString();
        el.style.color = 'var(--up)';
      } catch (e) {
        el.textContent = '✗ 失败: ' + e.message;
        el.style.color = 'var(--down)';
      }
    },

    async _aiRefreshNews() {
      const el = document.getElementById('aiNewsStatus');
      el.textContent = '⏳ 拉取中...';
      el.style.color = 'var(--text-muted)';
      try {
        await Core.News.refresh();
        const snap = await Core.News.get();
        el.textContent = `✓ 拉取 ${snap.total} 篇, 相关 ${snap.relevant.length} 篇, 生成于 ${new Date(snap.generated).toLocaleTimeString()}`;
        el.style.color = 'var(--up)';
      } catch (e) {
        el.textContent = '✗ 失败: ' + e.message;
        el.style.color = 'var(--down)';
      }
    },

    async aiAdvisorRun() {
      const amount = parseFloat(document.getElementById('aiAmount').value) || 50000;
      const risk = document.getElementById('aiRisk').value;
      const horizon = document.getElementById('aiHorizon').value;
      const allowEquity = document.getElementById('aiAllowEquity').value;
      const userNotes = document.getElementById('aiUserNotes').value.trim();
      const includeNews = document.getElementById('aiIncludeNews').checked;
      const aiCfg = Core.AI.getConfig();

      if (!aiCfg.apiKey && aiCfg.provider !== 'custom') {
        toastError('请先到 ⚙️ 设置页配置 AI API Key');
        return;
      }

      // 加载候选数据 + 宏观 + 财经新闻 (并行)
      const seedP = fetch('/fund_ai_seed.json').then(r => r.json());
      const macroP = Core.Macro.get().catch(e => ({ error: e.message, data: {} }));
      const newsP = includeNews ? Core.News.get().catch(e => ({ error: e.message, relevant: [] })) : Promise.resolve(null);

      const [seed, macro, news] = await Promise.all([seedP, macroP, newsP]);

      // 切换到结果视图
      document.getElementById('aiAdvisorForm').style.display = 'none';
      document.getElementById('aiAdvisorResult').style.display = '';
      const streamEl = document.getElementById('aiStream');
      streamEl.innerHTML = '<div style="color:var(--text-muted);">⏳ AI 思考中, 大约 10-30 秒...</div>';

      // 构造 prompt
      const candidatesText = seed.candidates.map((c, i) => {
        return `[${i}] ${c.code} ${c.name} | 类别=${c.category} | 规模=${c.scale}亿 | 1年=${c.n1}% | 3年=${c.n3}% | 年化=${c.annual}% | 回撤=${c.max_dd}% | 夏普=${c.sharpe} | tier=${c.tier}`;
      }).join('\n');

      const riskText = {
        'conservative': '极度保守 - 最大回撤 < 2%, 跑赢存款利率 (1.5-2.5%) 即可, 不接受任何本金损失',
        'moderate': '稳健 - 最大回撤 5-10%, 目标年化 4-6%',
        'balanced': '平衡 - 可接受 10-20% 回撤, 目标年化 8%+'
      }[risk];

      const horizonText = { '1y': '1 年内 (短久期)', '1-3y': '1-3 年 (中长久期)', '3y+': '3 年以上 (长长久期)' }[horizon];

      const macroText = macro && macro.data ? Core.Macro.formatForPrompt(macro) : '⚠ 宏观数据拉取失败, AI 将仅基于候选池分析';
      const newsText = news ? Core.News.formatForPrompt(news, 10) : '';

      const systemPrompt = `你是一个严谨的中国 A 股基金投资顾问, 风格保守, 严守数据边界。规则:
1. **只能从下方候选列表中挑选**, 严禁编造不存在的基金代码/名称
2. 输出格式严格按 JSON:
{
  "macroView": "1-2 句当前宏观环境判断 + 对债市/股市的含义 (必须引用具体数据)",
  "policyView": "1-2 句近期重要政策/新闻的含义 (如提供)",
  "picks": [
    {
      "code": "xxx",
      "name": "xxx",
      "amount": 数字,
      "pct": 数字 (百分比, 整数),
      "category": "short_bond / pure_bond / mixed_bond / wide",
      "reasons": ["收益来源 1 句", "宏观契合 1 句 (引用具体数据)", "政策/新闻契合 1 句 (如提供)", "风险点 1 句"],
      "riskScore": 1-5 (1=极低风险, 5=高风险)
    }
  ],
  "allocation": "短债/纯债/宽基 配比说明",
  "summary": "整体策略说明 3-4 句 (必须引用具体宏观数据 + 至少 1 条新闻)",
  "risks": ["风险点 1", "风险点 2", "..."]
}
3. picks 数量 2-3 只, 总 amount 必须等于用户给的总金额
4. 类别组合建议: 极度保守→短债+纯债; 稳健→纯债为主+少量短债; 平衡→可加 20-30% 宽基
5. 优先选 tier1 (规模+回撤+夏普 全过), tier2 备选
6. **多维度分析** (每只 pick 给 4 条 reason):
   - 收益来源 (票息/资本利得/久期暴露/打新等)
   - 宏观契合 (与当前利率环境/政策的匹配度, **必须引用具体 LPR/回购/CPI/PMI 数据**)
   - 政策/新闻契合 (**如有新闻必须引用至少 1 条**)
   - 风险点 (利率风险/信用风险/流动性风险/政策风险)
7. 禁止用"建议投资""一定赚钱"等绝对化表述`;

      const userPrompt = `【用户画像】
- 总金额: ${amount} 元
- 风险偏好: ${riskText}
- 投资期限: ${horizonText}
- 是否允许权益类: ${allowEquity === 'no' ? '不允许 (100% 债基)' : '允许最多 30%'}
- 用户关注点: ${userNotes || '(无)'}

${macroText}

${newsText ? newsText : '## 近期财经新闻: (未启用或拉取失败)'}

【候选池 (共 ${seed.candidates.length} 只, 已按 tier 严格筛选, 字段: 代码 名称 类别 规模(亿) 1年% 3年% 年化% 回撤% 夏普 tier)】
${candidatesText}

请基于【用户画像 + 宏观环境 + 财经新闻 + 候选池】做多维度分析, 严格使用候选项, JSON 输出 (按 systemPrompt 的格式), 总金额 = ${amount} 元。每条 reason 必须引用具体的宏观数据或新闻。`;

      try {
        const fullText = await Core.AI.call({
          systemPrompt,
          prompt: userPrompt,
          stream: true,
          onChunk: (delta, full) => {
            streamEl.textContent = full;
            streamEl.scrollTop = streamEl.scrollHeight;
          }
        });

        // 解析 JSON
        const jsonMatch = fullText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          let obj;
          try {
            obj = JSON.parse(jsonMatch[0]);
          } catch (e) {
            streamEl.innerHTML = `<div style="color:var(--down);">⚠ JSON 解析失败, 原始输出:</div><pre style="white-space:pre-wrap;font-size:12px;">${escapeHtml(fullText)}</pre>`;
            return;
          }
          const picks = obj.picks || [];
          const macroView = obj.macroView || '';
          const allocation = obj.allocation || '';
          const summary = obj.summary || '';
          const risks = obj.risks || [];

          let html = '';
          if (macroView) {
            html += `<div class="ai-macro-view"><strong>🌐 宏观视角</strong>: ${escapeHtml(macroView)}</div>`;
          }
          if (obj.policyView) {
            html += `<div class="ai-policy-view"><strong>📰 政策/新闻</strong>: ${escapeHtml(obj.policyView)}</div>`;
          }
          html += `<div style="margin:8px 0;"><strong>📊 策略</strong>: ${escapeHtml(summary)}</div>`;
          if (allocation) {
            html += `<div style="font-size:12px;color:var(--text-muted);">配比: ${escapeHtml(allocation)}</div>`;
          }
          html += picks.map(p => {
            const pct = p.pct || (((p.amount || 0) / amount) * 100);
            const riskColor = p.riskScore >= 4 ? 'var(--down)' : (p.riskScore <= 2 ? 'var(--up)' : 'var(--text-muted)');
            const reasons = (p.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
            return `
              <div class="ai-pick">
                <div class="ai-pick-head">
                  <strong>${escapeHtml(p.code)} ${escapeHtml(p.name || '')}</strong>
                  <span class="ai-pick-amt">${fmtMoney(p.amount || 0)} · ${pct.toFixed ? pct.toFixed(0) : pct}%</span>
                </div>
                <div class="ai-pick-meta">
                  <span class="tag">${escapeHtml(this._typeLabel(p.category || ''))}</span>
                  <span class="ai-risk-score" style="color:${riskColor};">风险 ${p.riskScore || '?'}/5</span>
                </div>
                <ul class="ai-pick-reasons">${reasons}</ul>
              </div>
            `;
          }).join('');
          if (risks.length > 0) {
            html += `<div class="ai-risks"><strong>⚠ 风险点</strong>:<ul>${risks.map(r => `<li>${escapeHtml(r)}</li>`).join('')}</ul></div>`;
          }
          streamEl.innerHTML = html;

          // 操作按钮
          const actions = document.getElementById('aiAdvisorActions');
          actions.innerHTML = picks.map((p, idx) => `
            <button class="btn btn-primary" data-idx="${idx}">📥 加入自选: ${escapeHtml(p.code)}</button>
          `).join(' ') + `<button class="btn btn-ghost" onclick="Fund.aiAdvisorRun()">🔄 再来一次</button>`;
          actions.querySelectorAll('button[data-idx]').forEach(btn => {
            btn.onclick = async () => {
              const p = picks[parseInt(btn.dataset.idx)];
              const exists = await Core.Storage.get('funds', p.code);
              if (exists) { toastWarning(`${p.code} 已在自选`); return; }
              const seedCand = seed.candidates.find(c => c.code === p.code);
              await Core.Storage.add('funds', {
                code: p.code, name: p.name || '',
                type: p.category || (seedCand ? seedCand.category : 'other'),
                note: `AI 推荐 · 风险${p.riskScore || '?'}/5`,
                shares: 0, costNav: 0, addedAt: Date.now()
              });
              toastSuccess(`已加入自选: ${p.code} ${p.name || ''}`);
              btn.disabled = true;
              btn.textContent = '✓ 已加入';
            };
          });
        } else {
          streamEl.innerHTML = `<pre style="white-space:pre-wrap;font-size:12px;">${escapeHtml(fullText)}</pre><div style="color:var(--down);margin-top:8px;">⚠ 未找到 JSON 输出</div>`;
        }
      } catch (e) {
        streamEl.innerHTML = `<div style="color:var(--down);">❌ ${escapeHtml(e.message)}</div>`;
        toastError('AI 调用失败: ' + e.message);
      }
    },

    async render() {
      const list = await Core.Storage.all('funds');
      const summaryEl = document.getElementById('fundSummary');
      const tableEl = document.getElementById('fundTable');

      // 异步加载宏观数据 + 财经新闻 (不阻塞主渲染)
      this._renderMacroBar().catch(e => console.warn('[Fund] 宏观数据加载失败:', e));
      this._renderNewsBar().catch(e => console.warn('[Fund] 新闻加载失败:', e));

      if (!list || list.length === 0) {
        summaryEl.innerHTML = '';
        tableEl.innerHTML = `
          <div class="empty">
            <div class="empty-icon">🏦</div>
            <div>还没有自选基金</div>
            <div style="margin-top:8px;font-size:12px;">点击"添加"开始, 或一键导入推荐组合</div>
            <button class="btn btn-primary" style="margin-top:16px;" onclick="Fund.seedRecommended()">
              📥 一键导入推荐组合(2 只)
            </button>
            <div style="margin-top:8px;font-size:11px;color:var(--text-muted);max-width:280px;">
              长城短债 A 007194 (20%) + 中银纯债 D 018581 (80%)<br>
              预期年化 ≈ 4.25%, 历史最大回撤 ≈ -1.7%
            </div>
          </div>
        `;
        return;
      }

      let totalCost = 0, totalValue = 0;
      const rows = [];
      for (const f of list) {
        let currentNav = null;
        let dayChange = null;
        try {
          const data = await Core.Data.getFundSpot(f.code);
          // AKShare fund_open_fund_info_em 返回结构: 不同 indicator 不同
          if (Array.isArray(data) && data.length > 0) {
            const latest = data[data.length - 1];
            currentNav = parseFloat(latest.单位净值 || latest['单位净值'] || latest.value);
            if (data.length >= 2) {
              const prev = data[data.length - 2];
              const prevNav = parseFloat(prev.单位净值 || prev['单位净值'] || prev.value);
              if (currentNav && prevNav) {
                dayChange = (currentNav - prevNav) / prevNav;
              }
            }
          }
        } catch (e) {
          console.warn('[Fund] 拉净值失败:', f.code, e);
        }

        const shares = parseFloat(f.shares) || 0;
        const costNav = parseFloat(f.costNav) || 0;
        const value = currentNav ? shares * currentNav : null;
        const cost = shares * costNav;
        const pl = value !== null ? value - cost : null;
        const plPct = (pl !== null && cost > 0) ? pl / cost : null;
        if (value !== null) {
          totalCost += cost;
          totalValue += value;
        }
        rows.push({ f, currentNav, dayChange, shares, costNav, value, cost, pl, plPct });
      }

      // 按 type 聚合占比
      const byType = {};
      for (const r of rows) {
        if (r.value === null) continue;
        const t = r.f.type || 'other';
        byType[t] = (byType[t] || 0) + r.value;
      }
      const target = { short_bond: 0.20, pure_bond: 0.80 };
      let allocRows = '';
      for (const [type, val] of Object.entries(byType)) {
        const cur = totalValue > 0 ? val / totalValue : 0;
        const tgt = target[type];
        const diff = tgt !== undefined ? cur - tgt : null;
        const diffStr = diff !== null ? (diff > 0 ? '+' : '') + (diff * 100).toFixed(1) + '%' : '-';
        const tgtStr = tgt !== undefined ? (tgt * 100).toFixed(0) + '%' : '-';
        const curPct = (cur * 100).toFixed(1) + '%';
        allocRows += `
          <div class="alloc-row">
            <span class="alloc-label">${this._typeLabel(type)}</span>
            <span class="alloc-cur">${curPct}</span>
            <span class="alloc-tgt">目标 ${tgtStr}</span>
            <span class="alloc-diff ${diff !== null && Math.abs(diff) > 0.05 ? 'alloc-warn' : 'alloc-ok'}">${diff !== null ? diffStr : ''}</span>
          </div>
        `;
      }
      if (!allocRows) allocRows = '<div class="alloc-empty">填入份额/成本后显示配置占比</div>';

      const totalPL = totalValue - totalCost;
      const totalPLPct = totalCost > 0 ? totalPL / totalCost : 0;

      summaryEl.innerHTML = `
        <div class="summary-card">
          <div class="label">自选数</div>
          <div class="value">${list.length}</div>
        </div>
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
      `;

      tableEl.innerHTML = `
        <div class="alloc-block">
          <div class="alloc-title">📊 实际配置 vs 目标 (短债 20% / 纯债 80%)</div>
          ${allocRows}
          <div class="alloc-hint">⚠ 偏离 > 5% 时建议再平衡 (到 🔔 提醒页开启季度检查)</div>
        </div>
        <table>
          <thead>
            <tr>
              <th>代码</th><th>名称</th><th>类型</th><th>单位净值</th><th>日涨跌</th>
              <th>份额</th><th>成本净值</th><th>市值</th><th>占比</th><th>盈亏</th><th>操作</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const pct = (r.value !== null && totalValue > 0) ? (r.value / totalValue * 100).toFixed(1) + '%' : '-';
              return `
              <tr>
                <td><span class="code">${escapeHtml(r.f.code)}</span></td>
                <td>${escapeHtml(r.f.name || '')}</td>
                <td><span class="tag">${this._typeLabel(r.f.type || '')}</span></td>
                <td>${r.currentNav ? r.currentNav.toFixed(4) : '-'}</td>
                <td class="${pctClass(r.dayChange)}">${r.dayChange !== null ? fmtPct(r.dayChange) : '-'}</td>
                <td>${fmtNum(r.shares, 2)}</td>
                <td>${r.costNav ? r.costNav.toFixed(4) : '-'}</td>
                <td>${r.value !== null ? fmtMoney(r.value) : '-'}</td>
                <td><strong>${pct}</strong></td>
                <td class="${pctClass(r.plPct)}">
                  ${r.pl !== null ? fmtMoney(r.pl) : '-'}<br>
                  <span style="font-size:11px;">${r.plPct !== null ? fmtPct(r.plPct) : ''}</span>
                </td>
                <td>
                  <button class="btn btn-sm" onclick="Fund.showChart('${escapeHtml(r.f.code)}','${escapeHtml(r.f.name || '')}')">📈</button>
                  <button class="btn btn-sm" onclick="Fund.remove('${escapeHtml(r.f.code)}')">✕</button>
                </td>
              </tr>
            `;}).join('')}
          </tbody>
        </table>
      `;
    },

    /**
     * 组合风险指标 (纯函数)
     * 输入: holdings (含 value) + navHistory (按 code 索引的 [{date, nav}, ...])
     * 输出: { totalValue, weights, period, metrics: {annualReturn, annualVol, sharpe, sortino, maxDD, calmar, ...} }
     *
     * 算法:
     *   1. 权重 = value / totalValue
     *   2. 每只基金日收益 r_i = (nav_t - nav_{t-1}) / nav_{t-1}
     *   3. 组合日收益 r_p = Σ w_i × r_i_t (按时间对齐)
     *   4. 年化收益 = mean(r_p_daily) × 252
     *   5. 年化波动 = std(r_p_daily) × √252
     *   6. Sharpe = (年化 - 无风险) / 年化波动
     *   7. Sortino = (年化 - 无风险) / 下行波动 (只算负收益 std)
     *   8. 最大回撤 = max(1 - cum_t / max(cum_so_far))
     *   9. Calmar = 年化 / |最大回撤|
     */
    _computePortfolioMetrics(holdings, navHistory, riskFreeRate = 0.02) {
      const valid = (holdings || []).filter(h => h.value && h.value > 0);
      if (valid.length === 0) {
        return { ok: false, reason: '无持仓', metrics: null };
      }
      const totalValue = valid.reduce((s, h) => s + h.value, 0);
      if (totalValue <= 0) {
        return { ok: false, reason: '总市值 0', metrics: null };
      }
      const weights = {};
      for (const h of valid) weights[h.code] = h.value / totalValue;

      // 取每只基金日收益 (按 date 对齐)
      const dateSet = new Set();
      for (const h of valid) {
        const arr = (navHistory || {})[h.code] || [];
        for (const it of arr) if (it && it.date && typeof it.nav === 'number') dateSet.add(it.date);
      }
      const dates = Array.from(dateSet).sort();

      // 算每只基金的日收益 map
      const returnsByCode = {};
      for (const h of valid) {
        const arr = (navHistory || {})[h.code] || [];
        const sorted = arr.slice().sort((a, b) => (a.date || '').localeCompare(b.date || ''));
        const rMap = {};
        for (let i = 1; i < sorted.length; i++) {
          const cur = sorted[i], prev = sorted[i - 1];
          if (cur.nav && prev.nav) rMap[cur.date] = (cur.nav - prev.nav) / prev.nav;
        }
        returnsByCode[h.code] = rMap;
      }

      // 算组合日收益序列
      const portReturns = [];
      const portDateReturns = [];
      for (const d of dates) {
        let r = 0, has = false;
        for (const h of valid) {
          const ri = returnsByCode[h.code][d];
          if (typeof ri === 'number') {
            r += weights[h.code] * ri;
            has = true;
          }
        }
        if (has) {
          portReturns.push(r);
          portDateReturns.push({ date: d, r });
        }
      }

      if (portReturns.length < 5) {
        return {
          ok: false,
          reason: `组合日收益数据不足 (${portReturns.length} < 5 天), 需要更长历史`,
          totalValue,
          weights,
          metrics: null
        };
      }

      // 年化收益 (用算术均值, 简化)
      const meanDaily = portReturns.reduce((s, x) => s + x, 0) / portReturns.length;
      const annualReturn = meanDaily * 252;

      // 年化波动率 (总体 std)
      const variance = portReturns.reduce((s, x) => s + (x - meanDaily) ** 2, 0) / portReturns.length;
      const stdDaily = Math.sqrt(variance);
      const annualVol = stdDaily * Math.sqrt(252);

      // Sharpe
      const sharpe = annualVol > 0 ? (annualReturn - riskFreeRate) / annualVol : 0;

      // Sortino (下行波动: 只算 r < 0 的 std)
      const negReturns = portReturns.filter(r => r < 0);
      let sortino = 0;
      if (negReturns.length > 0) {
        const negMean = negReturns.reduce((s, x) => s + x, 0) / negReturns.length;
        const downVar = negReturns.reduce((s, x) => s + (x - negMean) ** 2, 0) / negReturns.length;
        const downStd = Math.sqrt(downVar) * Math.sqrt(252);
        sortino = downStd > 0 ? (annualReturn - riskFreeRate) / downStd : 0;
      }

      // 最大回撤
      let cum = 1, peak = 1, maxDD = 0;
      for (const r of portReturns) {
        cum *= (1 + r);
        if (cum > peak) peak = cum;
        const dd = (peak - cum) / peak;
        if (dd > maxDD) maxDD = dd;
      }
      // 最大回撤为负数(代表下跌)
      const maxDD_pct = -maxDD;

      // Calmar = 年化 / |最大回撤|
      const calmar = maxDD > 0.001 ? annualReturn / maxDD : 0;

      // 胜率 (日收益 > 0 的占比)
      const winRate = portReturns.filter(r => r > 0).length / portReturns.length;

      // 起始/结束日期 + 实际年化 (复利)
      const cumStart = 1, cumEnd = cum;
      const days = portReturns.length;
      const yearsActual = days / 252;
      const cumAnnual = yearsActual > 0 ? (Math.pow(cumEnd / cumStart, 1 / yearsActual) - 1) : 0;

      return {
        ok: true,
        totalValue,
        weights,
        period: {
          start: portDateReturns[0].date,
          end: portDateReturns[portDateReturns.length - 1].date,
          tradingDays: days,
          years: yearsActual
        },
        metrics: {
          annualReturn,       // 算术年化
          cumAnnual,          // 复利年化
          annualVol,
          sharpe,
          sortino,
          maxDD: maxDD_pct,   // 负数
          calmar,
          winRate,
          bestDay: Math.max(...portReturns),
          worstDay: Math.min(...portReturns)
        },
        warnings: []
      };
    },

    /**
     * 组合风险指标弹窗 - 拉过去 1 年日净值 + 算指标
     */
    async portfolioRiskDialog() {
      const list = await Core.Storage.all('funds');
      const holdings = [];
      const codes = [];
      for (const f of list) {
        if (!f.shares || f.shares <= 0) continue;
        // 拉最新净值
        let currentNav = null;
        try {
          const data = await Core.Data.getFundSpot(f.code);
          if (Array.isArray(data) && data.length > 0) {
            currentNav = parseFloat(data[data.length - 1].单位净值 || data[data.length - 1]['单位净值'] || data[data.length - 1].value);
          }
        } catch (e) { /* skip */ }
        if (!currentNav) continue;
        holdings.push({
          code: f.code, name: f.name, type: f.type,
          shares: f.shares, currentNav,
          value: f.shares * currentNav
        });
        codes.push(f.code);
      }

      if (holdings.length === 0) {
        const html = `
          <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
            <div class="modal"><h3>📊 组合风险</h3>
              <div style="padding:20px;text-align:center;color:var(--text-muted);">无持仓, 无法计算</div>
              <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
            </div>
          </div>`;
        document.getElementById('modalRoot').innerHTML = html;
        return;
      }

      // 拉过去 1 年日净值
      const end = new Date();
      const start = new Date();
      start.setFullYear(start.getFullYear() - 1);
      const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

      const navHistory = {};
      const loading = (pre) => {
        const el = document.getElementById('prLoading');
        if (el) el.textContent = pre;
      };

      // 先显示加载
      document.getElementById('modalRoot').innerHTML = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:680px;width:100%;">
            <h3>📊 组合风险指标</h3>
            <div id="prLoading" style="padding:20px;text-align:center;color:var(--text-muted);">⏳ 拉取 ${codes.length} 只基金 1 年日净值...</div>
            <div id="prResult"></div>
            <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
          </div>
        </div>`;

      // 并行拉
      await Promise.all(codes.map(async (code, i) => {
        loading(`⏳ 拉取 (${i + 1}/${codes.length}) ${code}...`);
        try {
          const data = await Core.Data.getFundHistory(code, fmt(start), fmt(end));
          if (Array.isArray(data) && data.length > 0) {
            navHistory[code] = data.map(d => ({
              date: (d.净值日期 || d.x日期 || '').replace(/-/g, ''),
              nav: parseFloat(d.单位净值 || d['单位净值'] || d.y)
            })).filter(x => x.date && x.nav);
          }
        } catch (e) {
          console.warn('[Fund] 拉历史净值失败:', code, e);
        }
      }));

      // 算
      const result = this._computePortfolioMetrics(holdings, navHistory);
      this._renderPortfolioRisk(result);
    },

    _renderPortfolioRisk(result) {
      const el = document.getElementById('prResult');
      const ld = document.getElementById('prLoading');
      if (ld) ld.remove();
      if (!el) return;

      if (!result.ok) {
        el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">${escapeHtml(result.reason)}</div>`;
        return;
      }

      const m = result.metrics;
      const p = result.period;
      const riskColor = (x, isDD) => {
        if (isDD) return x > -0.05 ? 'var(--up)' : (x < -0.2 ? 'var(--down)' : 'var(--text)');
        return x > 0 ? 'var(--up)' : (x < 0 ? 'var(--down)' : 'var(--text-muted)');
      };

      // 6 个指标卡
      const cards = `
        <div class="summary-cards" style="grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
          <div class="summary-card">
            <div class="label">年化收益</div>
            <div class="value ${riskColor(m.annualReturn)}">${(m.annualReturn * 100).toFixed(2)}%</div>
            <div class="delta" style="font-size:11px;color:var(--text-muted);">复利 ${(m.cumAnnual * 100).toFixed(2)}%</div>
          </div>
          <div class="summary-card">
            <div class="label">年化波动</div>
            <div class="value">${(m.annualVol * 100).toFixed(2)}%</div>
          </div>
          <div class="summary-card">
            <div class="label">最大回撤</div>
            <div class="value ${riskColor(m.maxDD, true)}">${(m.maxDD * 100).toFixed(2)}%</div>
          </div>
          <div class="summary-card">
            <div class="label">Sharpe</div>
            <div class="value">${m.sharpe.toFixed(2)}</div>
            <div class="delta" style="font-size:11px;color:var(--text-muted);">风险调整</div>
          </div>
          <div class="summary-card">
            <div class="label">Sortino</div>
            <div class="value">${m.sortino > 0 ? m.sortino.toFixed(2) : '-'}</div>
            <div class="delta" style="font-size:11px;color:var(--text-muted);">下行调整</div>
          </div>
          <div class="summary-card">
            <div class="label">Calmar</div>
            <div class="value">${m.calmar > 0 ? m.calmar.toFixed(2) : '-'}</div>
            <div class="delta" style="font-size:11px;color:var(--text-muted);">收益/回撤</div>
          </div>
        </div>
        <div style="font-size:11px;color:var(--text-muted);line-height:1.6;background:var(--bg-base);padding:8px;border-radius:4px;">
          📅 区间: ${escapeHtml(p.start)} - ${escapeHtml(p.end)} (${p.tradingDays} 交易日 ≈ ${p.years.toFixed(2)} 年)<br>
          💰 组合总市值: ${fmtMoney(result.totalValue)}<br>
          🎯 胜率: ${(m.winRate * 100).toFixed(1)}% · 最佳日: ${(m.bestDay * 100).toFixed(2)}% · 最差日: ${(m.worstDay * 100).toFixed(2)}%
        </div>
        <div style="margin-top:12px;font-size:11px;color:var(--text-muted);line-height:1.6;">
          💡 <strong>读法</strong>:<br>
          • <strong>Sharpe > 1</strong>: 风险调整后收益不错<br>
          • <strong>最大回撤</strong>: 历史上最坏情况下, 跌了多少<br>
          • <strong>Sortino</strong>: 只看下行波动, 涨的波动不算风险<br>
          • <strong>Calmar</strong>: 年化收益 / 最大回撤, 越高越好
        </div>
      `;

      el.innerHTML = cards;
    },

    /**
     * 新闻→持仓影响分析 (静态规则匹配, 不调 LLM, 快速免费)
     * 拉财新新闻 + 持仓 → 每条新闻对每只基金的影响
     */
    async newsImpactDialog() {
      // 1. 拉持仓
      const list = await Core.Storage.all('funds');
      const holdings = list.filter(f => f.shares && f.shares > 0).map(f => ({
        code: f.code, name: f.name, type: f.type
      }));
      if (holdings.length === 0) {
        const html = `
          <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
            <div class="modal"><h3>📰 新闻→持仓影响</h3>
              <div style="padding:20px;text-align:center;color:var(--text-muted);">无持仓, 无法分析</div>
              <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
            </div>
          </div>`;
        document.getElementById('modalRoot').innerHTML = html;
        return;
      }

      // 2. 拉新闻
      document.getElementById('modalRoot').innerHTML = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:760px;width:100%;">
            <h3>📰 新闻 → 持仓影响</h3>
            <div id="niLoading" style="padding:20px;text-align:center;color:var(--text-muted);">⏳ 拉取财新新闻 + 匹配持仓影响...</div>
            <div id="niResult"></div>
            <div class="modal-footer"><button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button></div>
          </div>
        </div>`;

      let snap = null;
      try { snap = await Core.News.get(); }
      catch (e) {
        document.getElementById('niLoading').innerHTML = `<div style="color:var(--down);">⚠ 新闻拉取失败: ${escapeHtml(e.message)} (需要 aktools 跑着)</div>`;
        return;
      }
      if (!snap || !snap.relevant || snap.relevant.length === 0) {
        document.getElementById('niLoading').innerHTML = '<div style="color:var(--text-muted);">无相关新闻</div>';
        return;
      }

      // 3. 规则匹配 (纯函数)
      const impacts = this._analyzeNewsImpact(snap.relevant, holdings);
      this._renderNewsImpact(snap, impacts, holdings);
    },

    _analyzeNewsImpact(newsItems, holdings) {
      // 规则: 关键词 + 影响的 type + 影响方向 + 原因
      const RULES = [
        // 利好债基
        { kws: ['降息', '降准', '下调存款准备金率', '下调LPR', 'LPR下调', '下调逆回购'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'positive', reason: '利率下行 → 债基净值涨' },
        { kws: ['资金宽松', '流动性宽松', '宽松货币', '公开市场净投放'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'positive', reason: '资金面宽松 → 利好债基' },
        { kws: ['通缩', 'CPI下行', 'CPI走低', 'PPI下行'],
          types: ['short_bond', 'pure_bond'],
          impact: 'positive', reason: '通缩风险 → 利率或下行, 利好债基' },

        // 利空债基
        { kws: ['加息', '上调LPR', 'LPR上调', '上调存款准备金率', '收紧货币', '流动性收紧'],
          types: ['short_bond', 'pure_bond', 'mixed_bond'],
          impact: 'negative', reason: '利率上行 → 债基净值跌' },
        { kws: ['通胀', 'CPI上行', 'CPI走高', 'CPI超预期'],
          types: ['short_bond', 'pure_bond'],
          impact: 'negative', reason: '通胀 → 利率或上行, 利空债基' },

        // 利好权益
        { kws: ['经济复苏', 'PMI回升', 'PMI 回升', 'PMI扩张', 'PMI 扩张', '稳增长', '刺激政策', '财政发力'],
          types: ['csi300', 'csi500', 'wide', 'A50', '上证50', '红利', '红利低波'],
          impact: 'positive', reason: '经济/政策利好 → 利好权益' },

        // 利空权益
        { kws: ['经济下行', 'PMI收缩', 'PMI 收缩', 'PMI跌破', 'PMI 跌破', '衰退担忧'],
          types: ['csi300', 'csi500', 'wide', 'A50', '上证50'],
          impact: 'negative', reason: '经济下行 → 利空权益' },

        // 信用风险
        { kws: ['城投违约', '信用债违约', '信用风险', '暴雷'],
          types: ['pure_bond', 'mixed_bond'],
          impact: 'negative', reason: '信用风险 → 利空信用债持仓多的' }
      ];

      const results = [];
      for (const it of newsItems) {
        const text = ((it.tag || '') + ' ' + (it.summary || '')).toLowerCase();
        const matches = [];  // {rule, hold: 适用持仓}
        for (const rule of RULES) {
          for (const kw of rule.kws) {
            if (text.includes(kw.toLowerCase())) {
              // 找适用持仓
              const affected = holdings.filter(h => rule.types.includes(h.type || 'other'));
              if (affected.length > 0) {
                matches.push({ rule, kw, affected, impact: rule.impact, reason: rule.reason });
              }
              break;  // 一条规则只匹配一次
            }
          }
        }
        if (matches.length > 0) {
          // 合并: 同一持仓的多次影响, 抵消
          const byHolding = {};
          for (const m of matches) {
            for (const h of m.affected) {
              if (!byHolding[h.code]) byHolding[h.code] = { holding: h, positives: 0, negatives: 0, reasons: [] };
              if (m.impact === 'positive') byHolding[h.code].positives++;
              else byHolding[h.code].negatives++;
              byHolding[h.code].reasons.push(m.reason);
            }
          }
          const items = Object.values(byHolding).map(b => {
            const net = b.positives - b.negatives;
            const impact = net > 0 ? 'positive' : (net < 0 ? 'negative' : 'neutral');
            return { holding: b.holding, impact, reasons: [...new Set(b.reasons)] };
          });
          results.push({ news: it, items });
        }
      }
      return results;
    },

    _renderNewsImpact(snap, impacts, holdings) {
      const ld = document.getElementById('niLoading');
      const el = document.getElementById('niResult');
      if (ld) ld.remove();
      if (!el) return;

      if (impacts.length === 0) {
        el.innerHTML = `<div style="padding:20px;text-align:center;color:var(--text-muted);">📭 ${snap.relevant.length} 条相关新闻中, 无匹配规则的"对持仓有影响"内容<br><span style="font-size:11px;">(都是中性新闻或关键词未覆盖)</span></div>`;
        return;
      }

      // 汇总: 利好持仓 / 利空持仓
      const byHolding = {};
      for (const imp of impacts) {
        for (const it of imp.items) {
          const code = it.holding.code;
          if (!byHolding[code]) byHolding[code] = { holding: it.holding, pos: 0, neg: 0, neut: 0 };
          if (it.impact === 'positive') byHolding[code].pos++;
          else if (it.impact === 'negative') byHolding[code].neg++;
          else byHolding[code].neut++;
        }
      }
      const summaryHTML = `
        <div style="background:var(--bg-base);padding:8px;border-radius:6px;margin-bottom:12px;font-size:12px;">
          <strong>📊 对你持仓的总体影响</strong> (基于 ${impacts.length}/${snap.relevant.length} 条匹配新闻):
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">
            ${Object.values(byHolding).map(b => {
              const code = escapeHtml(b.holding.code);
              const name = escapeHtml(b.holding.name || '');
              let label = '➖ 中性';
              let color = 'var(--text-muted)';
              if (b.pos > b.neg) { label = `📈 利好 ${b.pos} 条`; color = 'var(--up)'; }
              else if (b.neg > b.pos) { label = `📉 利空 ${b.neg} 条`; color = 'var(--down)'; }
              return `<span style="background:var(--bg-card);padding:3px 8px;border-radius:4px;border:1px solid ${color};">
                <strong>${code}</strong> ${name} <span style="color:${color};font-weight:600;">${label}</span>
              </span>`;
            }).join('')}
          </div>
        </div>
      `;

      // 每条新闻
      const itemsHTML = impacts.map(imp => {
        const positive = imp.items.filter(i => i.impact === 'positive');
        const negative = imp.items.filter(i => i.impact === 'negative');
        const dominant = positive.length >= negative.length ? 'positive' : 'negative';
        const domColor = dominant === 'positive' ? 'var(--up)' : 'var(--down)';
        const domIcon = dominant === 'positive' ? '📈' : '📉';
        const domLabel = dominant === 'positive' ? '利好' : '利空';

        const tag = escapeHtml(imp.news.tag || '财经');
        const summary = escapeHtml(imp.news.summary || '');
        const url = escapeHtml(imp.news.url || '#');

        const affectedHTML = imp.items.map(i => {
          const c = i.impact === 'positive' ? 'var(--up)' : (i.impact === 'negative' ? 'var(--down)' : 'var(--text-muted)');
          const icon = i.impact === 'positive' ? '↑' : (i.impact === 'negative' ? '↓' : '·');
          return `<div style="margin-top:4px;font-size:11px;color:var(--text-muted);">
            <span style="color:${c};font-weight:600;">${icon} ${escapeHtml(i.holding.code)} ${escapeHtml(i.holding.name || '')}</span>
            <span style="color:var(--text-muted);"> — ${i.reasons[0] || ''}</span>
          </div>`;
        }).join('');

        return `<div class="data-card" style="margin-bottom:8px;padding:10px;border-left:3px solid ${domColor};">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:4px;">
            <span class="news-tag" style="background:${domColor}22;color:${domColor};">${domIcon} ${domLabel}</span>
            <a href="${url}" target="_blank" rel="noopener" style="font-size:10px;color:var(--text-muted);text-decoration:none;">原文 →</a>
          </div>
          <a href="${url}" target="_blank" rel="noopener" class="news-title" style="font-size:12px;color:var(--text);text-decoration:none;line-height:1.5;display:block;">${summary}</a>
          <div style="margin-top:4px;">${affectedHTML}</div>
        </div>`;
      }).join('');

      el.innerHTML = summaryHTML + itemsHTML;
    },

    _typeLabel(t) {
      return {
        short_bond: '短债',
        pure_bond: '纯债',
        mixed_bond: '混合债',
        csi300: '沪深300',
        csi500: '中证500',
        上证50: '上证50',
        红利: '红利',
        红利低波: '红利低波',
        A50: 'A50',
        other: '其他'
      }[t] || t || '-';
    },

    addDialog() {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal">
            <h3>添加自选基金</h3>
            <div class="form-row">
              <label>基金代码</label>
              <input type="text" id="fCode" placeholder="例: 519069" autofocus>
            </div>
            <div class="form-row">
              <label>名称</label>
              <input type="text" id="fName" placeholder="可选">
            </div>
            <div class="form-row">
              <label>持有份额</label>
              <input type="number" id="fShares" placeholder="10000" step="0.01">
            </div>
            <div class="form-row">
              <label>成本净值</label>
              <input type="number" id="fCostNav" placeholder="1.2345" step="0.0001">
            </div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">取消</button>
              <button class="btn btn-primary" onclick="Fund.save()">保存</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    async save() {
      const code = document.getElementById('fCode').value.trim();
      const name = document.getElementById('fName').value.trim();
      const shares = parseFloat(document.getElementById('fShares').value) || 0;
      const costNav = parseFloat(document.getElementById('fCostNav').value) || 0;
      if (!code || !/^\d{6}$/.test(code)) { toastError('基金代码必须 6 位'); return; }
      const exists = await Core.Storage.get('funds', code);
      if (exists) { toastWarning('已在自选中'); this.closeModal(); return; }
      await Core.Storage.add('funds', { code, name, shares, costNav, addedAt: Date.now() });
      this.closeModal();
      toastSuccess('已添加');
      this.render();
    },

    async remove(code) {
      if (!confirm(`确定从自选基金删除 ${code}?`)) return;
      await Core.Storage.remove('funds', code);
      toastSuccess('已删除');
      this.render();
    },

    /**
     * 净值走势图
     */
    async showChart(code, name) {
      const html = `
        <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
          <div class="modal" style="max-width:800px;width:100%;">
            <h3>${escapeHtml(code)} ${escapeHtml(name)} - 净值走势</h3>
            <div id="fundChart" style="width:100%;height:400px;background:var(--bg-base);border-radius:6px;"></div>
            <div class="modal-footer">
              <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;

      const chartEl = document.getElementById('fundChart');
      chartEl.innerHTML = '<div class="loading">加载净值...</div>';

      try {
        const end = new Date();
        const start = new Date();
        start.setMonth(start.getMonth() - 6);
        const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '');

        const data = await Core.Data.getFundHistory(code, fmt(start), fmt(end));
        if (!data || data.length === 0) {
          chartEl.innerHTML = '<div class="empty">无数据</div>';
          return;
        }
        this._renderChart(code, data);
      } catch (e) {
        chartEl.innerHTML = `<div class="empty">加载失败: ${escapeHtml(e.message)}</div>`;
      }
    },

    _renderChart(code, data) {
      const chartEl = document.getElementById('fundChart');
      if (!chartEl || typeof echarts === 'undefined') return;
      if (_chart) { _chart.dispose(); _chart = null; }
      _chart = echarts.init(chartEl, 'dark');

      const dates = data.map(d => d.净值日期 || d.x日期 || '');
      const navs = data.map(d => parseFloat(d.单位净值 || d['单位净值'] || d.y));
      const accNavs = data.map(d => parseFloat(d.累计净值 || d['累计净值']));

      _chart.setOption({
        backgroundColor: 'transparent',
        tooltip: { trigger: 'axis' },
        legend: { data: ['单位净值', '累计净值'], textStyle: { color: '#8b949e' } },
        xAxis: { type: 'category', data: dates, axisLabel: { color: '#8b949e' } },
        yAxis: { type: 'value', scale: true, axisLabel: { color: '#8b949e' }, splitLine: { lineStyle: { color: '#21262d' } } },
        series: [
          {
            name: '单位净值', type: 'line', data: navs, smooth: true, showSymbol: false,
            lineStyle: { color: '#f59e0b', width: 2 },
            areaStyle: { color: 'rgba(245, 158, 11, 0.1)' }
          },
          {
            name: '累计净值', type: 'line', data: accNavs, smooth: true, showSymbol: false,
            lineStyle: { color: '#58a6ff', width: 1 }
          }
        ]
      });
    },

    closeModal() {
      if (_chart) { _chart.dispose(); _chart = null; }
      document.getElementById('modalRoot').innerHTML = '';
    },

    /**
     * 基金再平衡 - 纯函数: 根据当前持仓 + 目标配置, 生成调仓建议
     *
     * @param {Array<{code, name, type, value, currentNav}>} holdings  当前持仓 (value=当前市值, currentNav=实时净值)
     * @param {Object} targets  目标配置 { short_bond: 0.20, pure_bond: 0.80 }
     * @param {number} threshold  漂移阈值 (默认 0.05 = 5%)
     * @param {Object} fees 费率 { redeem: 0, buy: 0.001 } (默认 0.1% 申购)
     * @returns {Object} {
     *   ok: boolean,
     *   reason: string,  // 不可调仓时
     *   totalValue: number,
     *   drift: [...],   // 每只基金的当前% / 目标% / 差值 / 是否触发
     *   suggestions: [...],  // 调仓动作: { code, name, action, amount, shares, fromPct, toPct, reason }
     *   totalAdjust: number,  // 总调仓金额 (绝对值)
     *   costEstimate: number,  // 预估费率成本
     *   warnings: [...],  // 提示
     *   expectedConfig: [...]  // 调后配置
     * }
     */
    _computeRebalanceAdvice(holdings, targets, threshold = 0.05, fees = { redeem: 0, buy: 0.001 }) {
      // 过滤掉没市值的
      const valid = (holdings || []).filter(h => h.value && h.value > 0);
      if (valid.length === 0) {
        return { ok: false, reason: '当前无持仓', drift: [], suggestions: [], warnings: [], expectedConfig: [] };
      }

      const totalValue = valid.reduce((s, h) => s + h.value, 0);
      if (totalValue <= 0) {
        return { ok: false, reason: '总市值为 0', drift: [], suggestions: [], warnings: [], expectedConfig: [] };
      }

      // 1. 算每只当前 % 和 目标 % (按 type 聚合)
      const byType = {};
      for (const h of valid) {
        const t = h.type || 'other';
        byType[t] = (byType[t] || 0) + h.value;
      }
      // 每只基金也单独算 % (用于建议展示)
      const drift = valid.map(h => {
        const curPct = h.value / totalValue;
        // 找 type 对应的目标; type 不在 targets 里就保持当前% (不调)
        const tgtPct = targets[h.type];
        const driftPct = tgtPct !== undefined ? curPct - tgtPct : 0;
        return {
          code: h.code,
          name: h.name,
          type: h.type,
          value: h.value,
          currentNav: h.currentNav,
          currentPct: curPct,
          targetPct: tgtPct,
          driftPct,
          triggered: tgtPct !== undefined && Math.abs(driftPct) > threshold
        };
      });

      // 2. 检查整体是否需要调
      const triggeredAny = drift.some(d => d.triggered);
      if (!triggeredAny) {
        return {
          ok: true,
          needRebalance: false,
          reason: `所有持仓漂移 ≤ ${(threshold * 100).toFixed(0)}%, 无需调仓`,
          totalValue,
          drift,
          suggestions: [],
          totalAdjust: 0,
          costEstimate: 0,
          warnings: [],
          expectedConfig: drift.map(d => ({ code: d.code, currentPct: d.currentPct, targetPct: d.targetPct }))
        };
      }

      // 3. 算调仓建议
      // 思路: 把每只基金的 value 调到 totalValue * targetPct
      // 减仓的钱 = 加仓的钱 (总额不变)
      const suggestions = [];
      let totalAdjust = 0;
      let costEstimate = 0;

      for (const d of drift) {
        if (d.targetPct === undefined) continue;  // type 不在目标里, 不动
        if (!d.triggered) continue;  // 没超阈值, 不动
        const targetValue = totalValue * d.targetPct;
        const diffValue = d.value - targetValue;  // >0 超配, <0 欠配
        if (Math.abs(diffValue) < 100) continue;  // 太小不调 (< 100 元)
        const action = diffValue > 0 ? 'reduce' : 'add';
        const amount = Math.abs(diffValue);
        // 减仓份数按当前净值算 (近似)
        const shares = d.currentNav ? amount / d.currentNav : null;
        // 费率
        const feeRate = action === 'reduce' ? fees.redeem : fees.buy;
        const fee = amount * feeRate;
        totalAdjust += amount;
        costEstimate += fee;
        const fromPct = d.currentPct;
        const toPct = d.targetPct;
        const reason = action === 'reduce'
          ? `${d.type || ''} 当前 ${(fromPct * 100).toFixed(1)}% 超配 ${(Math.abs(d.driftPct) * 100).toFixed(1)}%, 减仓回到目标 ${(toPct * 100).toFixed(0)}%`
          : `${d.type || ''} 当前 ${(fromPct * 100).toFixed(1)}% 欠配 ${(Math.abs(d.driftPct) * 100).toFixed(1)}%, 加仓回到目标 ${(toPct * 100).toFixed(0)}%`;
        suggestions.push({
          code: d.code,
          name: d.name,
          type: d.type,
          action,
          amount,
          shares: shares ? Math.round(shares * 100) / 100 : null,
          fromPct,
          toPct,
          fee,
          reason
        });
      }

      // 4. 警告
      const warnings = [];
      // 检查调仓是否平衡 (减的钱 = 加的钱)
      const reduceSum = suggestions.filter(s => s.action === 'reduce').reduce((s, x) => s + x.amount, 0);
      const addSum = suggestions.filter(s => s.action === 'add').reduce((s, x) => s + x.amount, 0);
      if (Math.abs(reduceSum - addSum) > 1) {
        warnings.push(`减仓 ${reduceSum.toFixed(0)} 元 ≠ 加仓 ${addSum.toFixed(0)} 元, 差额可能因 type 不在目标里`);
      }
      if (costEstimate / totalValue > 0.005) {
        warnings.push(`费率成本 ${(costEstimate).toFixed(0)} 元 ≈ ${(costEstimate / totalValue * 100).toFixed(2)}% 总市值, 较高`);
      }
      if (totalAdjust < 500) {
        warnings.push(`总调仓金额 < 500 元, 申赎费可能不划算`);
      }

      // 5. 调后配置 (近似: 总市值不变)
      const expectedConfig = drift.map(d => ({
        code: d.code,
        name: d.name,
        type: d.type,
        currentPct: d.currentPct,
        targetPct: d.targetPct,
        expectedPct: d.targetPct !== undefined ? d.targetPct : d.currentPct
      }));

      return {
        ok: true,
        needRebalance: true,
        totalValue,
        drift,
        suggestions,
        totalAdjust,
        costEstimate,
        warnings,
        expectedConfig
      };
    },

    /**
     * 再平衡建议弹窗
     */
    async rebalanceDialog() {
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
      this._lastRebalanceAdvice = advice;  // 缓存给 _openRebalanceLinks 用

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
              ${advice.suggestions.length > 0 ? '<button class="btn btn-primary" onclick="Fund._openRebalanceLinks()">🛒 跳第三方调仓</button>' : ''}
            </div>
          </div>
        </div>
      `;
      document.getElementById('modalRoot').innerHTML = html;
    },

    _renderRebalanceHTML(advice) {
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
    },

    /**
     * 打开所有要调仓的基金的第三方购买链接
     * (减仓 → 走天天基金赎回, 加仓 → 走申购)
     */
    _openRebalanceLinks() {
      // 简单实现: 把 _computeRebalanceAdvice 缓存下来供这里读
      const list = this._lastRebalanceAdvice;
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
    },

    /**
     * 申购计划 - 显示多个基金的快速购买链接
     * 跳转到第三方 (天天/支付宝/蛋卷) → 用户买完 → 用 快速登记 加到持仓
     */
    buyDialog(specificCode) {
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
    },

    _renderBuyDialog(funds) {
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
    },

    /**
     * 快速登记 - 申购完成后填数字进来
     * 输金额 + 净值 → 自动算份额 → 写入 funds 表
     */
    quickImport(code, name) {
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
        this._qiPre = prefill;
        this._bindQuickImportCalc();
      });
    },

    _bindQuickImportCalc() {
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
    },

    async quickImportSave() {
      const code = this._qiPre?.code;
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
      const rec = existing || { code, name: this._qiPre.name || code, type: this._qiPre.type || 'short_bond' };
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
    }
  };

  window.Fund = Fund;
  window._onShow_pageFund = function() {
    Fund.render();
    if (window.MarketBar) MarketBar.mount('pageFund', 'wide');
  };
})();
