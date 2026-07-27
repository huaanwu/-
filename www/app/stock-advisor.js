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
          <div class="modal-footer">
            <button class="btn btn-ghost" onclick="Fund.closeModal()">关闭</button>
            <button class="btn btn-ghost" id="saRefreshBtn" onclick="StockAdvisor.refresh()">🔄 重评</button>
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
    if (_currentTab === 'brief') await _runBrief(code, name);
    else if (_currentTab === 'report') await _runReport(code, name);
  };

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
          maxTokens: 800,
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
      '你是一名 A 股财报分析师 (Phase R 深度读模式), 服务长期稳健型投资者。',
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