/**
 * Fund.AiAdvisor - AI 选基 (多维解读)
 *
 * 弹窗收集用户偏好 + 宏观上下文, 调用 LLM 多维解读:
 *   - 收益来源 / 宏观契合 / 政策契合 / 风险点
 *   - 用户可勾选"包含新闻",自动按关键词筛 top 10
 */
(function() {
  'use strict';
  if (!window.Fund) window.Fund = {};

  window.Fund.aiAdvisorDialog = function() {
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
  };

  window.Fund._aiRefreshMacro = async function() {
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
  };

  window.Fund._aiRefreshNews = async function() {
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
  };

  window.Fund.aiAdvisorRun = async function() {
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

    // 加载候选数据 + 宏观 + 财经新闻 (并行) + Phase O: 13 维上下文 + KB
    const seedP = fetch('/fund_ai_seed.json').then(r => r.json());
    const macroP = Core.Macro.get().catch(e => ({ error: e.message, data: {} }));
    const newsP = includeNews ? Core.News.get().catch(e => ({ error: e.message, relevant: [] })) : Promise.resolve(null);
    const ctxP = Core.Data.getAiContextSnapshot().catch(e => null);
    const intlP = Core.Data.getIntlSnapshot().catch(e => null);
    const goldP = Core.Data.getGoldAu9999().catch(e => null);

    const [seed, macro, news, ctx, intl, gold] = await Promise.all([seedP, macroP, newsP, ctxP, intlP, goldP]);

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
    const ctxText = ctx ? Core.Data.formatAiContextForPrompt(ctx) : '(市场上下文不可用)';
    const intlText = intl ? Core.Data.formatIntlForPrompt(intl) : '(国际形势不可用)';
    const goldText = gold ? Core.Data.formatGoldForPrompt(gold, 30) : '(黄金数据不可用)';

    // KB 智能匹配 (Phase N+O)
    let kbText = '';
    try {
      const kbEntries = await Core.KB.pickRelevant({
        holdings: seed.candidates.slice(0, 5).map(c => ({ name: c.name, type: c.category })),
        context: ctx || {},
        maxN: 4
      });
      kbText = Core.KB.formatForPrompt(kbEntries);
    } catch (e) { console.warn('[ai-advisor] KB 取条失败:', e); }

    const systemPrompt = `你是 Phase O 高手版中国 A 股基金投资顾问, 风格稳健, 严守数据边界。

【投资框架】价值 + 趋势 + 风险平价 混合:
- 价值: 票息 / 资本利得 / 估值分位
- 趋势: 利率方向 / 板块轮动 / 北向流向
- 风险平价: 跨资产相关性 / 组合最大回撤 / 夏普

【用户画像】长期稳健型 (年化 3-5% 跑赢通胀), 不追求暴利。

【输出风格】先证据后结论, 每条 reason 引用具体数据; 给信心等级 (高/中/低)。

【规则】
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
      "riskScore": 1-5 (1=极低风险, 5=高风险),
      "confidence": "高" | "中" | "低",
      ${Core.Premortem.PROMPT_SPEC}
    }
  ],
  "allocation": "短债/纯债/宽基 配比说明",
  "summary": "整体策略说明 3-4 句 (必须引用具体宏观数据 + 至少 1 条新闻)",
  "risks": ["风险点 1", "风险点 2", "..."],
  "kbRefs": ["VAL-001", "POS-003"]  // 引用的 KB 条目号
}
3. picks 数量 2-3 只, 总 amount 必须等于用户给的总金额
4. 类别组合建议: 极度保守→短债+纯债; 稳健→纯债为主+少量短债; 平衡→可加 20-30% 宽基
5. 优先选 tier1 (规模+回撤+夏普 全过), tier2 备选
6. **多维度分析** (每只 pick 给 4 条 reason):
   - 收益来源 (票息/资本利得/久期暴露/打新等)
   - 宏观契合 (与当前利率环境/政策的匹配度, **必须引用具体 LPR/回购/CPI/PMI 数据**)
   - 政策/新闻契合 (**如有新闻必须引用至少 1 条**)
   - 风险点 (利率风险/信用风险/流动性风险/政策风险)
7. **KB 引用**: 如有相关条目 (data.kb 字段), 在 reasons 里引用条目号, kbRefs 数组填条目号
8. **置信度**: confidence = 高 (多维数据一致+符合 KB 经典模式) / 中 (数据冲突或 KB 不明确) / 低 (新策略/极端市场)
9. **pre-mortem 必填**: 每只 pick 必须给 bullCase/bearCase/falsifyCondition/invalidation 四字段; bearCase 禁止"无明显风险/暂无风险"空话 (利率/信用/流动性/政策风险至少写一条具体的), falsifyCondition 必须具体可观测 (如"10 年期国债收益率上行超 X bp"/"单月回撤 >X%")
10. 禁止用"建议投资""一定赚钱"等绝对化表述`;

    const userPrompt = `【用户画像】
- 总金额: ${amount} 元
- 风险偏好: ${riskText}
- 投资期限: ${horizonText}
- 是否允许权益类: ${allowEquity === 'no' ? '不允许 (100% 债基)' : '允许最多 30%'}
- 用户关注点: ${userNotes || '(无)'}

${macroText}

${newsText ? newsText : '## 近期财经新闻: (未启用或拉取失败)'}

${ctxText}

${intlText}

${goldText}

${kbText}

【候选池 (共 ${seed.candidates.length} 只, 已按 tier 严格筛选, 字段: 代码 名称 类别 规模(亿) 1年% 3年% 年化% 回撤% 夏普 tier)】
${candidatesText}

请基于【用户画像 + 宏观环境 + 财经新闻 + 市场上下文(Phase M) + 国际形势(Phase L) + 黄金(Phase J) + KB(Phase N) + 候选池】做多维度分析, 严格使用候选项, JSON 输出 (按 systemPrompt 的格式), 总金额 = ${amount} 元。每条 reason 必须引用具体的宏观数据或新闻, 信心等级和 KB 引用必填。`;

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

      // Phase T: schema 校验 (picks 必填数组, summary/macroView 必填字符串)
      const AI_FUND_SCHEMA = {
        required: ['picks', 'summary', 'macroView', 'risks'],
        types: { picks: 'array', summary: 'string', macroView: 'string', risks: 'array' },
        arrayItemTypes: { picks: 'object' }
      };
      const parsed = Core.AI.parseJsonOutput(fullText, AI_FUND_SCHEMA);
      // Phase D1: pre-mortem 四字段并入必填校验 (缺字段 → 走同一套降级模式)
      if (parsed.ok) {
        const pmErrs = Core.Premortem.checkPicks(parsed.obj.picks || []);
        if (pmErrs.length > 0) {
          parsed.ok = false;
          parsed.errors = parsed.errors.concat(pmErrs);
        }
      }
      if (parsed.ok) {
        const obj = parsed.obj;
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
              ${Core.Premortem.renderBlock(p)}
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
        // Phase T: schema 校验失败
        const errList = parsed.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('');
        // Phase V: 失败时显示"🔄 重新生成"按钮
        streamEl.innerHTML = `<div style="color:var(--down);">⚠ JSON 校验失败:</div><ul style="margin:4px 0 8px;font-size:12px;">${errList}</ul><pre style="white-space:pre-wrap;font-size:12px;max-height:240px;overflow:auto;">${escapeHtml(fullText)}</pre><div style="margin-top:10px;"><button class="btn btn-primary" onclick="Fund.aiAdvisorRun()">🔄 重新生成</button></div>`;
      }
    } catch (e) {
      streamEl.innerHTML = `<div style="color:var(--down);">❌ ${escapeHtml(e.message)}</div>`;
      toastError('AI 调用失败: ' + e.message);
    }
  };
})();