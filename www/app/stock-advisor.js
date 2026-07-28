/**
 * StockAdvisor - 单股 AI 简评 (Phase O) + 财报深度读 (Phase R)
 *
 * 用途: 行情/持仓列表的"💡"按钮 → 弹出该股的 AI 简评 / 财报深度读
 * 数据: 单股基本面 (PE/PB/ROE) + 13 维市场上下文 + KB 智能引用
 *       + 财报历史 (近 4 期营收/净利/毛利/ROE 等)
 * 输出: 估值/技术/政策/风险/Action Items/KB 引用 (高手版 LLM)
 *       + 财报拐点 / 质量判定 / 趋势解读
 */
(function() {
  'use strict';
  window.StockAdvisor = window.StockAdvisor || {};

  // 当前 tab 状态 (Phase R)
  let _currentTab = 'brief';

  // Phase D2: 最近一次 💡 简评的上下文 ({ code, name, systemPrompt, prompt, text })
  // 供 "🤝 第二意见" 用同一份上下文换 provider 重跑
  let _lastBrief = null;

  /**
   * 单股 AI 简评 (弹窗 + 流式)
   * @param {string} code - 股票代码 (6 位)
   * @param {string} [name] - 股票名称 (可选, 用于显示)
   */
  window.StockAdvisor.show = async function(code, name) {
    if (!code) { toastError('缺少股票代码'); return; }
    _currentTab = 'brief';

    // 弹窗骨架 (Phase R: 加 tab 切换)
    document.getElementById('modalRoot').innerHTML = `
      <div class="modal-backdrop" onclick="if(event.target===this)Fund.closeModal()">
        <div class="modal" style="max-width:640px;width:100%;">
          <h3>${escapeHtml(name || code)} <span style="color:var(--text-muted);font-size:14px;">${escapeHtml(code)}</span></h3>
          <div style="display:flex;gap:6px;margin-bottom:10px;">
            <button class="btn btn-sm sa-tab" data-tab="brief" onclick="StockAdvisor.switchTab('brief')" style="flex:1;">💡 AI 简评</button>
            <button class="btn btn-sm sa-tab" data-tab="report" onclick="StockAdvisor.switchTab('report')" style="flex:1;">📊 财报深度读</button>
          </div>
          <div id="saLoading" style="padding:12px;color:var(--text-muted);">⏳ 拉取基本面 + 市场上下文 + KB...</div>
          <div id="saResult" style="background:var(--bg-base);border-radius:6px;padding:14px;line-height:1.7;white-space:pre-wrap;font-size:13px;min-height:200px;"></div>
          <div id="saExtra" style="margin-top:10px;"></div>
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            <button class="btn btn-ghost" id="saRefreshBtn" onclick="StockAdvisor.refresh()">🔄 重评</button>
            <button class="btn btn-ghost" id="saPreBtBtn" onclick="StockAdvisor.runPreBacktest()">📊 历史验证</button>
            <button class="btn btn-ghost" id="saSecondBtn" onclick="StockAdvisor.runSecondOpinion()">🤝 第二意见</button>
          </div>
        </div>
      </div>`;

    _highlightTab();
    await _runBrief(code, name);
  };

  /**
   * tab 切换 (Phase R)
   */
  window.StockAdvisor.switchTab = async function(tab) {
    if (tab === _currentTab) return;
    _currentTab = tab;
    _highlightTab();
    // Phase D2: tab 切换清掉旧的历史验证/第二意见结果
    const extraEl = document.getElementById('saExtra');
    if (extraEl) extraEl.innerHTML = '';
    if (tab !== 'brief') _lastBrief = null;
    // 从 modalRoot 提取当前 code/name
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const titleEl = root.querySelector('h3 span');
    const code = titleEl ? titleEl.textContent.trim() : '';
    if (!code) return;
    const nameEl = root.querySelector('h3');
    const name = nameEl ? nameEl.firstChild.textContent.trim() : code;
    if (tab === 'brief') {
      await _runBrief(code, name);
    } else if (tab === 'report') {
      await _runReport(code, name);
    }
  };

  /**
   * 刷新按钮 (Phase R)
   */
  window.StockAdvisor.refresh = async function() {
    const root = document.getElementById('modalRoot');
    if (!root) return;
    const titleEl = root.querySelector('h3 span');
    const code = titleEl ? titleEl.textContent.trim() : '';
    const nameEl = root.querySelector('h3');
    const name = nameEl ? nameEl.firstChild.textContent.trim() : code;
    // Phase D2: 重评清掉旧的历史验证/第二意见结果
    const extraEl = document.getElementById('saExtra');
    if (extraEl) extraEl.innerHTML = '';
    if (_currentTab === 'brief') await _runBrief(code, name);
    else if (_currentTab === 'report') await _runReport(code, name);
  };

  /**
   * Phase D2: 📊 历史验证 (回测前置, 按需触发)
   * 对当前弹窗个股拉近 2 年日 K 跑策略回测, 结果渲染到 #saExtra
   */
  window.StockAdvisor.runPreBacktest = async function() {
    const btn = document.getElementById('saPreBtBtn');
    const extra = document.getElementById('saExtra');
    const root = document.getElementById('modalRoot');
    const titleEl = root && root.querySelector('h3 span');
    const code = titleEl ? titleEl.textContent.trim() : '';
    if (!code || !extra || !window.Core.PreBacktest) return;
    if (btn) btn.disabled = true;
    extra.innerHTML = '<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">⏳ 拉取近 2 年 K 线 + 回测中 (约 5-15 秒)...</div>';
    // 假设文本用简评全文 (含多方/空方/动作建议), 供策略映射
    const assumption = (_lastBrief && _lastBrief.code === code) ? _lastBrief.text : '';
    const r = await Core.PreBacktest.runForPick({ code, assumption });
    if (btn) btn.disabled = false;
    extra.innerHTML = r
      ? Core.PreBacktest.renderResultHtml(r)
      : Core.PreBacktest.renderUnavailableHtml();
  };

  /**
   * Phase D2: 🤝 第二意见 (双模型交叉验证, 按需触发)
   * 流程: 第二个已配置 provider 对同一份上下文再跑一次简评 (1 次调用)
   *       → 两段并排展示 → 主模型做 ≤100 字一致性小结 (1 次调用)
   * 第二 provider 的 key 在设置页"第二意见"区配置 (state.apiKeys.llm)
   */
  window.StockAdvisor.runSecondOpinion = async function() {
    const extra = document.getElementById('saExtra');
    if (!extra || !window.Core.CrossCheck) return;
    if (_currentTab !== 'brief' || !_lastBrief || !_lastBrief.text) {
      toastError('请先在 💡 AI 简评 tab 跑一次简评, 再来要第二意见');
      return;
    }
    const second = Core.CrossCheck.resolveSecondOpinion(Core.State.get());
    if (!second) {
      toastError('请先在设置里配置第二个 LLM 的 API Key (⚙️ 设置 → 🤝 第二意见)');
      return;
    }
    const mainCfg = Core.AI.getConfig();
    const mainLabel = `${Core.AI.getProviderConfig(mainCfg.provider).name || mainCfg.provider} / ${mainCfg.model}`;
    const secondLabel = `${second.label} / ${second.model}`;

    const btn = document.getElementById('saSecondBtn');
    if (btn) btn.disabled = true;
    extra.innerHTML = `<div style="padding:8px 12px;color:var(--text-muted);font-size:12px;">⏳ 第二意见 (${escapeHtml(secondLabel)}) 生成中, 大约 10-20 秒...</div>`;

    try {
      // 第 1 次调用: 第二 provider 重跑同一上下文
      // local:false 强制远程, 防止"优先本地"把 baseURL 覆盖劫持到本地 LLM
      const textB = await Core.AI.callWithTimeout({
        systemPrompt: _lastBrief.systemPrompt,
        prompt: _lastBrief.prompt,
        baseURL: second.baseURL,
        apiKey: second.apiKey,
        model: second.model,
        local: false,
        maxTokens: 1000,
        timeout: 90000
      });
      if (!textB || !textB.trim()) throw new Error('第二意见返回为空');

      extra.innerHTML = _renderSecondOpinion(_lastBrief.text, textB, mainLabel, secondLabel, null);

      // 第 2 次调用: 主模型对两份输出做一致性小结 (走默认配置, 尊重优先本地)
      try {
        const summary = await Core.AI.callWithTimeout({
          prompt: Core.CrossCheck.buildComparePrompt(_lastBrief.text, textB, mainLabel, secondLabel),
          maxTokens: 300,
          timeout: 60000
        });
        extra.innerHTML = _renderSecondOpinion(_lastBrief.text, textB, mainLabel, secondLabel, summary);
      } catch (e) {
        console.warn('[sa] 一致性小结失败:', e);
        extra.innerHTML = _renderSecondOpinion(_lastBrief.text, textB, mainLabel, secondLabel, '⚠ 一致性小结失败: ' + e.message);
      }
    } catch (e) {
      console.warn('[sa] 第二意见失败:', e);
      extra.innerHTML = `<div style="padding:8px 12px;font-size:12px;color:var(--down);">❌ 第二意见失败: ${escapeHtml(e.message)}</div>`;
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  /**
   * Phase D2: 第二意见并排渲染 (全转义)
   * summary 为 null 时显示"对比中"占位
   */
  function _renderSecondOpinion(textA, textB, labelA, labelB, summary) {
    const panel = (label, text, border) =>
      `<div style="flex:1;min-width:220px;padding:10px 12px;background:var(--bg-base);border-radius:6px;border-left:3px solid ${border};">` +
      `<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">${escapeHtml(label)}</div>` +
      `<div style="white-space:pre-wrap;font-size:12px;line-height:1.6;">${escapeHtml(text)}</div></div>`;
    const summaryHtml = summary === null
      ? '<div style="margin-top:8px;font-size:12px;color:var(--text-muted);">⏳ 主模型一致性对比中...</div>'
      : `<div style="margin-top:8px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;line-height:1.6;border-left:3px solid var(--accent);"><strong>🤝 结论一致性</strong><br>${escapeHtml(summary)}</div>`;
    return `<div style="display:flex;gap:8px;flex-wrap:wrap;">${panel('主模型 · ' + labelA, textA, 'var(--accent)')}${panel('第二意见 · ' + labelB, textB, 'var(--up)')}</div>${summaryHtml}`;
  }

  function _highlightTab() {
    document.querySelectorAll('.sa-tab').forEach(b => {
      if (b.dataset.tab === _currentTab) {
        b.style.background = 'var(--accent)';
        b.style.color = 'var(--bg-base)';
      } else {
        b.style.background = '';
        b.style.color = '';
      }
    });
  }

  /**
   * 💡 AI 简评 (Phase O 原始功能)
   */
  async function _runBrief(code, name) {
    const ld = document.getElementById('saLoading');
    const el = document.getElementById('saResult');
    if (ld) ld.textContent = '⏳ 拉取基本面 + 市场上下文 + KB...';
    if (el) el.textContent = '';

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
      // Phase D1: 近期公告上下文 (最近 5 条标题+日期; null=拉取失败 → "公告数据不可用")
      if (window.Core.News && typeof Core.News.getStockNotices === 'function') {
        const notices = await Core.News.getStockNotices(code, 5)
          .catch(e => { console.warn('[sa] 公告拉取失败:', e); return null; });
        data.notices = Core.News.formatNoticesForPrompt(notices, 5);
      } else {
        data.notices = '(公告数据不可用)';
      }
    } catch (e) {
      console.warn('[sa] 数据拉取失败:', e);
      if (ld) ld.textContent = '❌ 数据拉取失败: ' + e.message;
      return;
    }

    if (ld) ld.textContent = '⏳ AI 简评中, 大约 10-20 秒...';

    const systemPrompt = [
      '你是一名 A 股个股投资顾问 (高手版, Phase O), 服务对象按 Core.UserProfile 渲染。',
      '',
      '【用户画像】(Core.UserProfile 单次动态注入)',
      Core.AI.formatUserProfile() || '长期稳健型 (年化 3-5%), 不追短期暴利。',
      '',
      '【输出风格】先证据后结论, 每条 reason 引用具体数据; 给信心等级 (高/中/低)。',
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
      '【硬性】不许编造数字; 没有的数据说"无"; 总长度 300-550 字',
      '',
      '【Phase P 多视角辩论】在 📌 动作建议 之前, 增加:',
      '  📈 多方观点 (80 字): 看多的依据 (估值/资金/政策)',
      '  📉 空方观点 (80 字): 看空的依据 (估值/行业/技术)',
      '  ⚖️ 综合判断 (40 字): 权衡后倾向',
      '',
      '【Phase D1 pre-mortem 强制】在 ⚖️ 综合判断 之后, 必须逐行输出 4 行 (标签照抄):',
      '  看多: ≤2 条看多理由 (引用具体数据)',
      '  看空: ≤2 条看空理由 (必填, 禁止"无明显风险/暂无风险"这类空话, 写具体风险)',
      '  证伪条件: 出现什么情况说明以上判断错了 (具体可观测, 如"跌破 20 日线且放量"/"季报净利润增速 <10%")',
      '  失效条件: 建议多久没兑现就该放弃 (如"2 周内未突破 X 元")',
      '',
      '【近期公告】数据里有 notices 字段 ("近期无公告"/"公告数据不可用" 也有可能), 风险点和证伪条件须结合公告 (如减持/增发/诉讼)'
    ].join('\n');

    const prompt = `单股简评请求:\n${JSON.stringify(data, null, 2)}\n\n请按上面 4 段结构输出。`;

    try {
      // Phase W: 缓存包装 — 24h 内重复访问同一只股直接命中
      // 1) 命中缓存: 模拟流式 (30 字符/批, ~50ms)
      // 2) 未命中: 走流式 AI.call, 完成后异步写缓存
      // 缓存键: sa_brief_{code}_{context前50字}_{intl前50字} (FNV-1a hash)
      // 注: 上层 data (基本面/行情) 不入缓存键, 因为基本面日级别刷新, 同一天同一股应该命中
      const cacheKey = _briefCacheKey(code, data.context || '', data.intl || '');
      let cachedText = null;
      try { const c = await Core.Storage.cacheGet(cacheKey); if (c && c.text) cachedText = c.text; } catch (e) { /* ignore */ }

      let finalText;
      if (cachedText) {
        if (ld) ld.textContent = '⚡ 24h 缓存命中, 立即显示';
        const chunks = [];
        for (let i = 0; i < cachedText.length; i += 30) chunks.push(cachedText.slice(i, i + 30));
        let acc = '';
        for (const c of chunks) {
          acc += c;
          if (el) el.textContent = acc;
          await new Promise(r => setTimeout(r, 50));
        }
        finalText = cachedText;
      } else {
        await Core.AI.call({
          systemPrompt,
          prompt,
          stream: true,
          maxTokens: 1000,
          onChunk: (delta, full) => {
            if (ld) ld.remove();
            if (el) el.textContent = full;
          }
        });
        finalText = (el && el.textContent) || '';
        // 异步写缓存 (24h TTL, 不阻塞当前 UI)
        if (finalText) {
          Core.Storage.cacheSet(cacheKey, { text: finalText, at: Date.now() }, 24 * 60 * 60 * 1000)
            .catch(e => console.warn('[sa] 写缓存失败:', e));
        }
      }
      if (el) el.innerHTML = window.Core.Util.renderWithSources(finalText);

      // Phase D2: 缓存本次简评上下文, 供 "🤝 第二意见" 换 provider 重跑同一份输入
      _lastBrief = { code, name, systemPrompt, prompt, text: finalText };

      // Phase D1: pre-mortem 软校验 (free-text 无 JSON schema, 缺字段只警告不拦截, 不崩 UI)
      if (el && el.parentElement && finalText && !(finalText.includes('证伪') && finalText.includes('失效'))) {
        const pmWarn = document.createElement('div');
        pmWarn.className = 'sa-premortem-warn';
        pmWarn.style.cssText = 'margin-top:12px;padding:8px 12px;background:var(--bg-base);border-radius:6px;font-size:12px;border-left:3px solid var(--down);';
        pmWarn.textContent = '⚠ 本次输出缺少 pre-mortem 字段 (看多/看空/证伪条件/失效条件), 可点 🔄 重评重新生成';
        el.parentElement.appendChild(pmWarn);
      }

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
  }

  /**
   * 📊 财报深度读 (Phase R)
   * 数据: stock_zh_a_financial_indicator (近 4 期对比)
   * 输出: 收入趋势 / 盈利质量 / 拐点信号 / 多视角辩论 / self-check
   */
  async function _runReport(code, name) {
    const ld = document.getElementById('saLoading');
    const el = document.getElementById('saResult');
    if (ld) ld.textContent = '⏳ 拉取财报历史 + KB...';
    if (el) el.textContent = '';
    // 清掉旧 self-check (从 _runBrief 留下的)
    if (el && el.parentElement) {
      el.parentElement.querySelectorAll('.sa-selfcheck').forEach(n => n.remove());
    }

    const data = { code, name: name || code, history: null, latest: null };

    try {
      const [histRaw, ctx, kbEntries, fin] = await Promise.all([
        Core.Data.getStockFinancialHistory(code).catch(e => { console.warn('[sa] 财报历史失败:', e); return null; }),
        Core.Data.getAiContextSnapshot().catch(e => null),
        Core.KB.pickRelevant({ holdings: [{ name: name || code }], context: window._wrCtx || {}, maxN: 4 }).catch(e => []),
        Core.Data.getStockFinancial(code).catch(e => null)
      ]);

      data.history = _extractHistory(histRaw);
      data.latest = _extractFundamentals(fin);
      data.context = ctx ? Core.Data.formatAiContextForPrompt(ctx) : '(市场上下文不可用)';
      data.kb = Core.KB.formatForPrompt(kbEntries);
    } catch (e) {
      console.warn('[sa] 财报数据拉取失败:', e);
      if (ld) ld.textContent = '❌ 财报数据拉取失败: ' + e.message;
      return;
    }

    if (!data.history || data.history.length === 0) {
      if (ld) ld.textContent = '⚠ 财报历史数据为空 (aktools 可能没返回)';
      return;
    }

    if (ld) ld.textContent = `⏳ AI 财报深度读中 (基于 ${data.history.length} 期对比), 大约 15-30 秒...`;

    const systemPrompt = [
      '你是一名 A 股财报分析师 (Phase R 深度读模式), 服务对象按 Core.UserProfile 渲染。',
      '',
      '【用户画像】(Core.UserProfile 单次动态注入)',
      Core.AI.formatUserProfile() || '长期稳健型 (年化 3-5%), 不追短期暴利。',
      '',
      '【输出风格】先证据后结论, 每条 reason 引用具体数据; 给信心等级 (高/中/低)。',
      '',
      '【数据】下面是该股近 4 期财报核心指标 (营收/净利/毛利/ROE/ROA/资产负债率/经营现金流):',
      '  - 已按"最近→最远"排序,最新一期在最前面',
      '  - 单位见字段名, 同比/环比已计算',
      '',
      '【必给结构】5 段:',
      '  📈 营收趋势 (近 4 期增速变化, 是否加速/减速/拐点)',
      '  💰 盈利质量 (净利率走势, 扣非利润可信度, ROE 是否稳定)',
      '  🏭 资产健康 (资产负债率趋势, 经营现金流 vs 净利润 比值)',
      '  ⚠️ 异常信号 (2-3 条, 单期骤变 / 季度对冲 / 应收回款风险)',
      '  📌 财报结论 (1-2 条, 操作+触发条件+信心)',
      '',
      '【📌 结论规则】每条: 操作 (关注/加仓/减仓/止损/持有) + 触发条件 + 信心等级 (高/中/低)',
      '',
      '【KB 引用】如有相关条目 (例 KB-VAL-002 盈利质量), 引用条目号',
      '',
      '【硬性规则】',
      '  - 必须引用具体数字 (从 history), 不许编造',
      '  - 没有的数据说"无"或"该期未披露"',
      '  - 不要给"强烈买入/卖出"绝对化表述',
      '  - 总长度 350-550 字',
      '',
      '【Phase P 多视角辩论】在 📌 财报结论 之前, 增加:',
      '  📈 多方观点 (100 字): 财报看多的依据',
      '  📉 空方观点 (100 字): 财报看空的依据',
      '  ⚖️ 综合判断 (60 字): 权衡后倾向'
    ].join('\n');

    const prompt = `财报深度读请求:\n${JSON.stringify(data, null, 2)}\n\n请按上面 5 段结构输出。`;

    try {
      await Core.AI.call({
        systemPrompt,
        prompt,
        stream: true,
        maxTokens: 1200,
        onChunk: (delta, full) => {
          if (ld) ld.remove();
          if (el) el.textContent = full;
        }
      });
      const finalText = (el && el.textContent) || '';
      if (el) el.innerHTML = window.Core.Util.renderWithSources(finalText);

      // Phase P 反向 self-check (后台, 标 .sa-selfcheck 便于 tab 切换时清掉)
      const checkEl = document.createElement('div');
      checkEl.className = 'sa-selfcheck';
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
          ? `<strong>✓ self-check 通过</strong> · 财报解读无幻觉/过度自信`
          : `<strong>⚠ self-check 反馈</strong><br>${escapeHtml(critique)}`;
        checkEl.style.borderLeftColor = passThrough ? 'var(--up)' : 'var(--down)';
      } catch (e) {
        checkEl.textContent = '⚠ self-check 失败: ' + e.message;
      }
    } catch (e) {
      console.warn('[sa] 财报 AI 调用失败:', e);
      if (ld) ld.remove();
      if (el) el.textContent = '❌ AI 调用失败: ' + e.message;
      if (window.toastError) toastError('AI 调用失败: ' + e.message);
    }
  }

  /**
   * 从 akshare 财务数据里提取关键字段 (容错)
   */
  function _extractFundamentals(raw) {
    if (!raw || typeof raw !== 'object') return null;
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

  /**
   * 从 stock_financial_analysis_indicator_em 提取近 4 期 (Phase R)
   * 字段名: AKShare 1.13+ 的大写英文缩写 (见 data.js getStockFinancialHistory)
   */
  function _extractHistory(raw) {
    if (!Array.isArray(raw) || raw.length === 0) return null;
    const keyMap = {
      period: ['REPORT_DATE', 'REPORT_DATE_NAME', '报告日期'],
      reportType: ['REPORT_TYPE', '报告类型'],
      revenue: ['TOTALOPERATEREVE', '营业总收入', '营业收入'],
      revenueYoY: ['TOTALOPERATEREVETZ', '营业总收入同比增长', '营收同比'],
      netProfit: ['PARENTNETPROFIT', '归母净利润', '净利润'],
      netProfitYoY: ['PARENTNETPROFITTZ', '归母净利润同比增长', '净利润同比'],
      deductedProfit: ['KCFJCXSYJLR', '扣非净利润'],
      grossMargin: ['XSMLL', '销售毛利率', '毛利率'],
      netMargin: ['XSJLL', '销售净利率', '净利率'],
      roe: ['ROEJQ', 'ROEKCJQ', '加权平均净资产收益率', 'ROE'],
      roa: ['ZZCJLL', '总资产报酬率', 'ROA'],
      debtRatio: ['ZCFZL', '资产负债率'],
      eps: ['EPSJB', 'EPSKCJB', '基本每股收益', 'EPS'],
      bps: ['BPS', '每股净资产'],
      operatingCashflow: ['MGJYXJJE', '每股经营性现金流', '经营现金流'],
      cashflowRatio: ['XJLLB', '经营现金流/营业收入']
    };
    const look = (obj, keys, isString = false) => {
      for (const k of keys) {
        if (obj[k] != null && obj[k] !== '') {
          if (isString) return String(obj[k]);
          const v = parseFloat(obj[k]);
          if (!isNaN(v)) return v;
        }
      }
      return null;
    };
    // 取最近 4 期 (raw 已按 REPORT_DATE DESC 倒序)
    const list = raw.slice(0, 4).map(row => {
      const out = {};
      for (const [k, keys] of Object.entries(keyMap)) {
        const v = (k === 'period' || k === 'reportType')
          ? look(row, keys, true)
          : look(row, keys, false);
        if (v !== null) out[k] = v;
      }
      return out;
    }).filter(r => r.period || r.revenue != null);
    return list.length > 0 ? list : null;
  }

  // 测试钩子 (Phase R): 不影响业务, 仅供 test_runtime.js 调用
  if (typeof window !== 'undefined') {
    window.StockAdvisor._test_extractHistory = _extractHistory;
  }

  /**
   * Phase W: AI 简评缓存键
   * 键格式: sa_brief_{FNV-1a(code + context[:50] + intl[:50])}
   * 入键字段:
   *   - code: 决定是哪只股
   *   - data.context[:50]: 市场上下文快照前 50 字 (估值分位/北向/板块变化大)
   *   - data.intl[:50]: 国际形势前 50 字 (美元/原油/美股 1-3 天变化大)
   * 不入键:
   *   - 基本面 (PE/PB/ROE): 日级别变化, 24h 缓存期内应可复用
   *   - KB 条目: 本地静态, 不影响输出
   *   - 近期公告 (Phase D1): 6h 级数据, 24h 缓存期内复用可接受 (重评按钮可强制刷新)
   */
  function _briefCacheKey(code, context, intl) {
    const data = `brief_${code}_${(context || '').slice(0, 50)}_${(intl || '').slice(0, 50)}`;
    let hash = 2166136261;
    for (let i = 0; i < data.length; i++) {
      hash ^= data.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return 'sa_brief_' + (hash >>> 0).toString(36);
  }

  if (typeof window !== 'undefined') {
    window.StockAdvisor._test_briefCacheKey = _briefCacheKey;
  }
})();