/**
 * Screener - 选股筛选
 * 多条件筛选(基本面 + 技术面)
 */
(function() {
  'use strict';

  const Screener = {

    async init() {
      this._renderForm();
      // Y.2: 从 Dexie kv 恢复用户黑名单
      try {
        const v = window.Core && Core.Storage && Core.Storage.kvGet
          ? await Core.Storage.kvGet('screener_blacklist')
          : null;
        const ta = document.getElementById('scBlacklist');
        if (ta && v && typeof v === 'string') ta.value = v;
      } catch (e) { console.warn('[screener] blacklist 恢复失败:', e); }
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
            跑完硬筛后, 点 [🤖 AI 解读结果] 会把这些偏好 + 宏观环境 + top 候选股 一起喂给 LLM。<br>
            💡 <b>留空</b>走 ⚙️ 设置页"用户画像"里的<b>个人偏好</b> (选股/选基共用同一来源)。
          </div>
        </div>
        <fieldset style="border:1px solid var(--bg-base);border-radius:6px;padding:8px 12px;margin:8px 0;">
          <legend style="font-size:12px;color:var(--text-muted);padding:0 4px;">🛡️ 自动排雷 (默认全开)</legend>
          <label style="display:block;font-size:13px;margin:4px 0;">
            <input type="checkbox" id="scExclGoodwill" checked> 商誉偏高 (占总资产 &gt; 30%)
          </label>
          <label style="display:block;font-size:13px;margin:4px 0;">
            <input type="checkbox" id="scExclDecrease" checked> 股东大额减持 (变动比例 &gt; 1%)
          </label>
          <label style="display:block;font-size:13px;margin:4px 0;">
            <input type="checkbox" id="scExclLoss" checked> 业绩亏损/预减 (首亏/续亏/同比下降)
          </label>
          <label style="display:block;font-size:13px;margin:4px 0;">
            <input type="checkbox" id="scExclCapitulate" checked> 主力出逃 (主力净流入 &lt; -1000 万)
          </label>
          <div style="margin-top:8px;">
            <label style="font-size:12px;color:var(--text-muted);">🚫 用户黑名单 (代码或名称, 一行一条):</label>
            <textarea id="scBlacklist" rows="2" placeholder="例:
600519
贵州茅台
002594"></textarea>
          </div>
        </fieldset>
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

        // Y.2 排雷 (位置 B: 硬筛后, top 截取后, 不隐藏被排雷股票)
        const riskResult = await this._runRiskFilter(all, filtered);
        const riskMap = riskResult.map;
        const riskErrors = riskResult.errors;

        // 保存结果供 AI 解读
        this._lastResults = {
          all, filtered, top, conditions: { market, peMax, pbMax, mktCapMin, turnoverMin, changeMin, changeMax },
          _riskMap: riskMap,
          _riskErrors: riskErrors,
          _riskEnabled: riskResult.enabled
        };

        // 4) 渲染
        if (top.length === 0) {
          resultEl.innerHTML = '<div class="empty">没有符合条件的股票</div>';
          return;
        }

        const aiCfg = Core.AI.getConfig();
        const hasAiKey = !!aiCfg.apiKey || aiCfg.provider === 'custom';

        const flaggedCount = top.filter(s => riskMap && riskMap.has(s.代码)).length;
        const riskHint = riskResult.enabled
          ? (flaggedCount > 0
              ? `,排雷命中 <strong style="color:var(--down);">${flaggedCount}</strong> 只 (已标 ⚠,仅供参考)`
              : `,排雷全清 ✓`)
          : `,排雷未启用`;

        resultEl.innerHTML = `
          <div style="padding:12px 16px;color:var(--text-muted);font-size:12px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
            <span>命中 ${filtered.length} 只,展示前 ${top.length} 只(按涨跌幅降序)${riskHint}</span>
            <button class="btn btn-sm btn-primary" onclick="Screener.aiInterpret()" ${hasAiKey ? '' : 'disabled title="请先到 ⚙️ 设置页配置 AI API Key"'}>
              🤖 AI 解读结果
            </button>
          </div>
          <div id="screenerAiResult"></div>
          <table>
            <thead>
              <tr>
                <th>代码</th><th>名称</th><th>现价</th><th>涨跌幅</th>
                <th>PE</th><th>PB</th><th>换手率</th><th>总市值</th><th>⚠ 排雷</th>
              </tr>
            </thead>
            <tbody>
              ${top.map(s => {
                const reasons = riskMap && riskMap.has(s.代码) ? Array.from(riskMap.get(s.代码)) : [];
                const reasonsHtml = reasons.map(r => `<span style="display:inline-block;background:var(--bg-base);color:var(--down);border-radius:3px;padding:1px 4px;margin:1px;font-size:11px;">${escapeHtml(r)}</span>`).join('');
                return `
                <tr style="cursor:pointer;" onclick="Watchlist.showKLine('${escapeHtml(s.代码)}','${escapeHtml(s.名称)}')">
                  <td><span class="code">${escapeHtml(s.代码)}</span></td>
                  <td>${escapeHtml(s.名称)}</td>
                  <td>${fmtNum(parseFloat(s.最新价), 2)}</td>
                  <td class="${pctClass(parseFloat(s.涨跌幅) / 100)}">${fmtPct(parseFloat(s.涨跌幅) / 100)}</td>
                  <td>${s.市盈率 !== '-' && s.市盈率 != null ? parseFloat(s.市盈率).toFixed(1) : '-'}</td>
                  <td>${s.市净率 !== '-' && s.市净率 != null ? parseFloat(s.市净率).toFixed(2) : '-'}</td>
                  <td>${s.换手率 ? parseFloat(s.换手率).toFixed(2) + '%' : '-'}</td>
                  <td>${s.总市值 ? fmtMoney(parseFloat(s.总市值)) : '-'}</td>
                  <td>${reasonsHtml}</td>
                </tr>
              `;
              }).join('')}
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
      const { filtered, top, conditions, _riskMap, _riskErrors, _riskEnabled } = this._lastResults;
      // 优先用 scPreference 本次覆盖; 留空走 Core.UserProfile.preference 全局值; 都空才 (无)
      const scPref = document.getElementById('scPreference')?.value.trim() || '';
      let upPref = '';
      try { upPref = (Core.UserProfile && Core.UserProfile.load()?.preference) || ''; }
      catch (e) { console.warn('[Screener] UserProfile.preference 读不到:', e); }
      const preference = scPref || upPref.trim() || '';

      const aiResultEl = document.getElementById('screenerAiResult');
      if (!aiResultEl) return;
      aiResultEl.innerHTML = '<div class="ai-stream" style="background:var(--bg-base);border-radius:6px;padding:12px;margin-bottom:12px;font-size:13px;line-height:1.6;white-space:pre-wrap;color:var(--text-muted);">⏳ AI 思考中, 大约 10-30 秒...</div>';

      // Y.3 P-A: 我的现有持仓 (top 10, 让 AI 不要推已重仓的)
      let portfolioLine = '(无)';
      try {
        const portfolio = await Core.Portfolio.getAssets({ paper: false });
        if (portfolio && portfolio.valueByCode) {
          const held = Object.entries(portfolio.valueByCode)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([code, val]) => `${code} ${(val / 10000).toFixed(1)}万`);
          portfolioLine = held.length > 0 ? held.join(', ') : '(无)';
        }
      } catch (e) { console.warn('[screener] 拉持仓失败:', e); }

      // 喂 LLM: 命中股票 top 30 (限制 token)
      const candidates = top.slice(0, 30).map((s, i) => {
        const pe = parseFloat(s.市盈率);
        const pb = parseFloat(s.市净率);
        const turn = parseFloat(s.换手率);
        const mcap = parseFloat(s.总市值);
        // Y.3 P-C: PE<=0 (亏损股) 标 '亏损' 防误读
        const peStr = isNaN(pe) ? '-' : (pe <= 0 ? '亏损' : pe.toFixed(1));
        return `[${i}] ${s.代码} ${s.名称} | PE=${peStr} | PB=${isNaN(pb) ? '-' : pb.toFixed(2)} | 换手=${isNaN(turn) ? '-' : turn.toFixed(2) + '%'} | 市值=${isNaN(mcap) ? '-' : (mcap / 1e8).toFixed(1) + '亿'} | 涨跌幅=${parseFloat(s.涨跌幅).toFixed(2)}%`;
      }).join('\n');

      // 并行加载宏观 + 新闻 + Phase O: 13 维上下文 + KB + Y.3 P-A 持仓
      const macroP = Core.Macro.get().catch(e => null);
      const newsP = Core.News.get().catch(e => null);
      const ctxP = Core.Data.getAiContextSnapshot().catch(e => null);
      const intlP = Core.Data.getIntlSnapshot().catch(e => null);
      const [macro, news, ctx, intl] = await Promise.all([macroP, newsP, ctxP, intlP]);
      // Y.3 P-D: 失败用 [降级] 标记
      const macroText = macro ? Core.Macro.formatForPrompt(macro) : '[降级] 宏观数据不可用';
      const newsText = news ? Core.News.formatForPrompt(news, 8) : '[降级] 新闻数据不可用';
      const ctxText = ctx ? Core.Data.formatAiContextForPrompt(ctx) : '[降级] 市场上下文 (9 维) 不可用';
      const intlText = intl ? Core.Data.formatIntlForPrompt(intl) : '[降级] 国际形势不可用';

      // KB 智能匹配 (Phase N+O) — 失败同样 [降级]
      let kbText = '';
      try {
        const topNames = top.slice(0, 8).map(s => ({ name: s.名称 }));
        const kbEntries = await Core.KB.pickRelevant({
          holdings: topNames,
          context: ctx || {},
          maxN: 4
        });
        kbText = Core.KB.formatForPrompt(kbEntries) || '[降级] KB 知识库为空';
      } catch (e) {
        console.warn('[screener] KB 取条失败:', e);
        kbText = '[降级] KB 拉取失败';
      }

      // Y.2 排雷段: 把 _riskMap 序列化成 代码 → [reason, ...] 文本
      const riskList = _riskMap ? Core.RiskMine.serialize(_riskMap) : [];
      let riskText = '';
      if (!_riskEnabled) {
        riskText = '本轮未启用排雷过滤 (用户未勾任何 checkbox)';
      } else if (riskList.length === 0 && (_riskErrors || []).length === 0) {
        riskText = '本轮已启用排雷但全部清零 ✓ (无商誉/减持/亏损/主力出逃命中)';
      } else if (riskList.length === 0) {
        riskText = `[降级] 4 个排雷数据源全部拉取失败: ${(_riskErrors || []).join(', ')}`;
      } else {
        riskText = '被排雷的股票 (★ 严禁选入 picks 除非 KB 明确反驳):\n' + riskList
          .map(r => `- ${r.code}: ${r.reasons.join(', ')}`).join('\n');
      }

      const condsDesc = [];
      if (conditions.market && conditions.market !== 'all') condsDesc.push(`市场=${conditions.market}`);
      if (conditions.peMax) condsDesc.push(`PE ≤ ${conditions.peMax}`);
      if (conditions.pbMax) condsDesc.push(`PB ≤ ${conditions.pbMax}`);
      if (conditions.mktCapMin) condsDesc.push(`市值 ≥ ${conditions.mktCapMin} 亿`);
      if (conditions.turnoverMin) condsDesc.push(`换手率 ≥ ${conditions.turnoverMin}%`);
      if (conditions.changeMin !== null) condsDesc.push(`涨跌幅 ≥ ${conditions.changeMin}%`);
      if (conditions.changeMax !== null) condsDesc.push(`涨跌幅 ≤ ${conditions.changeMax}%`);

      // TODO H1 凯利 接入: 当前 LLM schema 只返 confidence (高/中/低 类别),
      // 没有 numeric probability 也没有 triggerPrice/stopLoss/targetPrice —
      // 凯利公式 (Core.PositionSizing._kellyFraction) 需要 4 个数值字段。
      // 等以后 schema 扩展 (LLM 报 probability 0-100 + 3 件套价格),
      // 在 picks[] 里加这些字段, 在落地前用 _kellyFraction 算 positionPct
      // 替代当前按 confidence 类别硬映射。
      //
      // TODO H2 校准 接入: 当前 screener 没有 (predict → actual) 机械
      // 验证数据 (不像 short-trader T4 学习环有完整闭环), 校准注入会误导 LLM。
      // 等以后周度机械 verify 落实后, 在这里拼 _calibrationBuckets →
      // Core.Calibration._formatCalibrationPrompt 段, samples < 5 自动不渲染。
      // H3 大盘状态机段: 多指数共识 + 失灵提示, 让 LLM 在 bear/range 时更保守
      const regimeBlock = (Core.Regime && Core.Regime._formatRegimeBlock)
        ? Core.Regime._formatRegimeBlock() : '';
      // P3 全系统学习池
      let poolBlock = '';
      try {
        const pt = await Core.LearningPool.format();
        if (pt) poolBlock = '\n\n【全系统学习池】' + pt;
      } catch (e) { /* 学习池可选 */ }
      const systemPrompt = `你是 Phase O 高手版 A 股个股投资顾问, 风格稳健, 严守数据边界。

【投资框架】价值 + 趋势 + 风险平价 混合:
- 价值: PE/PB/ROE + 历史分位
- 趋势: 板块轮动、北向方向、行业资金流
- 风险: 个股波动、行业暴露、相关性

${regimeBlock}

【用户画像】(Core.UserProfile 单次动态注入 - 选股/选基共用同一来源)
${Core.AI.formatUserProfile() || '长期稳健型 (年化 3-5%), 不追短期暴利。'}

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
      "confidence": "高" | "中" | "低",
      ${Core.Premortem.PROMPT_SPEC}
    }
  ],
  "risks": ["风险点 1", "风险点 2", "..."],
  "kbRefs": ["VAL-001", "POS-002"]  // 引用的 KB 条目号
}
3. picks 数量 5-10 只, 按性价比 (低估值 + 高质量) 排序
4. **多维度分析**: 基本面/技术面/资金面/政策面/行业面
5. **KB 引用**: 如有相关条目, 在 reasons 里引用条目号, kbRefs 数组填条目号
6. **置信度**: 高 (多维数据一致+符合 KB 经典模式) / 中 (数据冲突) / 低 (极端市场/新策略)
7. **pre-mortem 必填**: 每只 pick 必须给 bullCase/bearCase/falsifyCondition/invalidation 四字段; bearCase 禁止"无明显风险/暂无风险"空话, falsifyCondition 必须具体可观测 (价格/指标/财报数字)
8. **已有持仓友好**: 用户持仓超过 10 万的代码视为"重复持仓", 应在 marketView / risks 中提示, 不强制进 picks
9. **排雷标签 ✓ 必须尊重**: 候选池中如已被前端标 [排雷] 的代码 (商誉偏高/股东减持/业绩亏损/主力出逃), 一律不进 picks, 除非 KB 经典模式能给出反转理由 (例如"高商誉但 ROE 持续 > 20% 的特例")
10. 严禁绝对化表述 ("一定涨" 等)${poolBlock}`;

      const userPrompt = `【我的现有持仓 (前 10, Y.3 P-A)】
${portfolioLine}
若候选池含以上已有持仓, 按规则 8 处理.

【用户筛选条件】
${condsDesc.length > 0 ? condsDesc.join(', ') : '(无特定条件, 全市场)'}
命中 ${filtered.length} 只, 已按涨跌幅降序展示前 ${top.length} 只。

【用户偏好】
${preference || '(无)'}

【排雷标记 (Y.2, 必须在 picks 中遵守规则 9)】
${riskText}

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
          let picks = obj.picks || [];
          // 5.1.3: 把 AI 选股结果 (含 reasons/risks) 暂存, 给"加自选"按钮写入 journal 用
          this._lastAiPicks = picks;
          this._lastAiContext = { marketView: obj.marketView || '', policyView: obj.policyView || '', risks: obj.risks || [], conditions };
          // Bug H 修复 (选股 picks ⊆ top30): AI 可能编出候选池外代码 (类似 Bug G),
          // 渲染前用 _lastResults.top 前 30 提 Set, 给每个 pick 标 outOfTop, UI 灰按钮禁入库
          const top30Codes = new Set((top || []).slice(0, 30).map(s => s && s.代码).filter(Boolean));
          picks = (picks || []).map(p => Object.assign({}, p, { outOfTop: p && p.code && !top30Codes.has(p.code) }));
          let html = '';
          if (obj.marketView) html += `<div class="ai-macro-view"><strong>📈 大盘视角</strong>: ${escapeHtml(obj.marketView)}</div>`;
          if (obj.policyView) html += `<div class="ai-policy-view"><strong>📰 政策/新闻</strong>: ${escapeHtml(obj.policyView)}</div>`;
          html += '<div style="margin:8px 0;">';
          html += picks.map(p => {
            const riskColor = p.riskScore >= 4 ? 'var(--down)' : (p.riskScore <= 2 ? 'var(--up)' : 'var(--text-muted)');
            const reasons = (p.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join('');
            // 5.1.3: data-reasons / data-riskscore 让 addWatchlistFromPick 能拿到 AI 选股理由
            // Phase D1: data-falsify / data-invalidation 一并沉淀到 journal + 模拟盘交易行
            const reasonsJson = JSON.stringify(p.reasons || []).replace(/"/g, '&quot;');
            // Phase D2: 回测前置的"假设"文本 = 理由 + bullCase, 供策略映射 (技术突破→突破策略等)
            const bullTxt = Array.isArray(p.bullCase) ? p.bullCase.join(' ') : (p.bullCase || '');
            const assumptionTxt = escapeHtml((p.reasons || []).join(' ') + ' ' + bullTxt);
            // Bug H 修复: outOfTop 标 [未在候选池] 红字; 禁"加自选"按钮
            const outTag = p.outOfTop ? `<span style="color:var(--down);font-size:11px;margin-left:6px;">[未在候选池]</span>` : '';
            const addBtnHtml = p.outOfTop
              ? `<button class="btn btn-sm" data-code="${escapeHtml(p.code)}" data-action="add" disabled style="opacity:0.5;cursor:not-allowed;" title="不在 top30 候选池, 拒绝加入">⛔ ${escapeHtml(p.code)} 未在候选池</button>`
              : `<button class="btn btn-sm btn-primary" data-code="${escapeHtml(p.code)}" data-name="${escapeHtml(p.name || '')}" data-riskscore="${p.riskScore || ''}" data-reasons="${reasonsJson}" data-falsify="${escapeHtml(p.falsifyCondition || '')}" data-invalidation="${escapeHtml(p.invalidation || '')}" data-action="add">📌 加入自选</button>`;
            return `
              <div class="ai-pick">
                <div class="ai-pick-head">
                  <strong>${escapeHtml(p.code)} ${escapeHtml(p.name || '')}</strong>${outTag}
                  <span class="ai-risk-score" style="color:${riskColor};">风险 ${p.riskScore || '?'}/5</span>
                </div>
                <ul class="ai-pick-reasons">${reasons}</ul>
                ${Core.Premortem.renderBlock(p)}
                <div style="margin-top:6px;">
                  ${addBtnHtml}
                  <button class="btn btn-sm" data-code="${escapeHtml(p.code)}" data-name="${escapeHtml(p.name || '')}" data-action="kline">📈 K线</button>
                  <button class="btn btn-sm" data-code="${escapeHtml(p.code)}" data-assumption="${assumptionTxt}" data-action="backtest">📊 历史验证</button>
                </div>
                <div class="pb-result"></div>
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
                if (btn.disabled) {
                  // Bug H 守卫: 即便绕过 disabled 也再判一次 outOfTop → 拒绝
                  btn.onclick = () => toastError(`${code} 不在 top30 候选池, 拒绝加入`);
                } else {
                  // 5.1.3: 改名为 addWatchlistFromPick, 复用 reasons 写 journal
                  btn.onclick = () => this._addWatchlistFromPick(btn, code, name);
                }
              } else if (action === 'kline') {
                btn.onclick = () => Watchlist.showKLine(code, name);
              } else if (action === 'backtest') {
                // Phase D2: 回测前置 (按需, 用户点击才跑)
                btn.onclick = () => this._runPreBacktest(btn, code);
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
     * Y.2 排雷 UI: 4 checkbox + blacklist textarea 状态聚合
     * 任一 checkbox 勾选 或 blacklist 非空 即视为启用
     */
    _isAnyRiskFlagOn() {
      const ck = id => !!document.getElementById(id) && document.getElementById(id).checked;
      const c1 = ck('scExclGoodwill');
      const c2 = ck('scExclDecrease');
      const c3 = ck('scExclLoss');
      const c4 = ck('scExclCapitulate');
      const bl = (document.getElementById('scBlacklist')?.value || '').trim();
      return c1 || c2 || c3 || c4 || bl.length > 0;
    },

    /**
     * Y.2 读取用户黑名单 textarea → { codes: [], names: [] }
     * 自动 trim / 去空 / 去重; 输入含 "600519" → codes, "茅台" → names
     * 多合一 (例 "600519 茅台" 拆成 code + name 两部分)
     * 顺便把当前内容存到 Dexie kv (跨刷新持久化)
     */
    async _readBlacklist() {
      const raw = document.getElementById('scBlacklist')?.value || '';
      const lines = raw.split(/[\n,，\s]+/).map(s => s.trim()).filter(Boolean);
      const codes = new Set();
      const names = new Set();
      for (const tok of lines) {
        // 全 6 位数字 → 当代码
        if (/^\d{6}$/.test(tok)) codes.add(tok);
        // 含汉字/英文 → 当名称
        else if (/[一-龥A-Za-z]/.test(tok)) names.add(tok);
      }
      const out = { codes: Array.from(codes), names: Array.from(names) };
      // Dexie kv 持久化 (失败静默, 不影响本次)
      try {
        if (window.Core && Core.Storage && Core.Storage.kvSet) {
          await Core.Storage.kvSet('screener_blacklist', raw);
        }
      } catch (e) { console.warn('[screener] blacklist 持久化失败:', e); }
      return out;
    },

    /**
     * Y.2 排雷主入口: 4 个 fetch 并行 + RiskMine 聚合 + 用户黑名单叠加
     * 全部失败也只是返空 map + errors[], 不抛
     */
    async _runRiskFilter(allStocks, _hardFiltered) {
      const enabled = this._isAnyRiskFlagOn();
      if (!enabled) {
        return { enabled: false, map: null, errors: [] };
      }
      const errors = [];
      const safeFetch = async (name, fn) => {
        try {
          const r = await fn();
          if (!Array.isArray(r) || r.length === 0) {
            errors.push(`${name}=空`);
            return [];
          }
          return r;
        } catch (e) {
          console.warn(`[screener] ${name} 排雷数据拉取失败:`, e);
          errors.push(name);
          return [];
        }
      };
      const [g, d, p, c] = await Promise.all([
        safeFetch('商誉', () => Core.Data.getStockGoodwillRanks()),
        safeFetch('减持', () => Core.Data.getStockHolderDecreases()),
        safeFetch('业绩', () => Core.Data.getStockEarningsForecastFresh()),
        safeFetch('主力', () => Core.Data.getStockCapitalFlight())
      ]);
      // 仅在前端确实勾选时计入对应类 (避免无关数据污染 map)
      const ck = id => !!document.getElementById(id) && document.getElementById(id).checked;
      const bl = await this._readBlacklist();
      const map = Core.RiskMine.buildReasonSet(
        ck('scExclGoodwill') ? g : [],
        ck('scExclDecrease') ? d : [],
        ck('scExclLoss') ? p : [],
        ck('scExclCapitulate') ? c : []
      );
      // 用户黑名单叠加 (代码 + 名称)
      if (bl.codes.length > 0 || bl.names.length > 0) {
        for (const code of bl.codes) {
          if (!map.has(code)) map.set(code, new Set());
          map.get(code).add(Core.RiskMine.REASONS.BLACKLIST);
        }
        if (Array.isArray(allStocks) && bl.names.length > 0) {
          for (const s of allStocks) {
            if (s.名称 && bl.names.some(n => s.名称.includes(n))) {
              if (!map.has(s.代码)) map.set(s.代码, new Set());
              map.get(s.代码).add(Core.RiskMine.REASONS.BLACKLIST);
            }
          }
        }
      }
      return { enabled: true, map, errors };
    },

    /**
     * Phase D2: 单条 pick 的"📊 历史验证" (回测前置, 按需触发)
     * 结果渲染在该卡片 .pb-result 里; 失败降级"回测不可用", 不影响建议展示
     */
    async _runPreBacktest(btn, code) {
      const card = btn.closest('.ai-pick');
      const box = card && card.querySelector('.pb-result');
      if (!box || !window.Core.PreBacktest) return;
      btn.disabled = true;
      btn.textContent = '⏳ 回测中...';
      const assumption = btn.dataset.assumption || '';
      const r = await Core.PreBacktest.runForPick({ code, assumption });
      btn.disabled = false;
      btn.textContent = '📊 历史验证';
      box.innerHTML = r
        ? Core.PreBacktest.renderResultHtml(r)
        : Core.PreBacktest.renderUnavailableHtml();
    },

    /**
     * 5.1.3: 选股结果一键加自选 + 自动记 AI 选股理由到 journal
     * 复用 btn 上的 data-reasons/data-riskscore, 拼成 Markdown 复盘笔记
     * 加自选失败/已存在时不创建 journal, 避免重复记录
     */
    async _addWatchlistFromPick(btn, code, name) {
      try {
        // Bug H 守卫: pick.code 必须 ∈ _lastResults.top 前 30, 否则拒绝
        if (this._lastResults && Array.isArray(this._lastResults.top)) {
          const top30Codes = new Set(this._lastResults.top.slice(0, 30).map(s => s && s.代码).filter(Boolean));
          if (!top30Codes.has(code)) {
            toastError(`${code} 不在 top30 候选池, 拒绝加入`);
            return;
          }
        }
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
        // Phase D1: pre-mortem 证伪/失效条件, 供 --verify 事后验证对照
        const falsifyCondition = (btn.dataset.falsify || '').trim();
        const invalidation = (btn.dataset.invalidation || '').trim();

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
        // Phase D1: pre-mortem 证伪/失效条件 (事后验证对照锚点)
        if (falsifyCondition || invalidation) {
          lines.push('### 🔬 Pre-mortem');
          if (falsifyCondition) lines.push(`- **证伪条件**: ${falsifyCondition}`);
          if (invalidation) lines.push(`- **失效条件**: ${invalidation}`);
          lines.push('');
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
        // Phase D1: 非索引字段, 供 --verify 事后验证对照 (不改 DB schema)
        if (falsifyCondition) journal.falsifyCondition = falsifyCondition;
        if (invalidation) journal.invalidation = invalidation;
        await Core.Storage.add('journals', journal);
        toastSuccess(`已记入复盘: ${code} 选股理由`);

        // 3) 模拟盘自动成交 (Phase A: AI 建议按真实行情在模拟盘成交; Paper 不存在则跳过, 不硬依赖)
        // Phase D1: 证伪/失效条件随 pick 传给模拟盘, 写入 transactions 行
        if (window.Paper && typeof window.Paper.autoTradeFromPick === 'function') {
          window.Paper.autoTradeFromPick({ code, name, falsifyCondition, invalidation });
        }

        // 4) Phase E: 生成实盘"待确认交易"卡片 (人确认才成交; 失败只 warn, 不影响加自选主流程)
        if (window.Core && Core.Pending && typeof Core.Pending.add === 'function') {
          try {
            const q = await Core.Data.getStockQuote(code);
            const price = q ? (parseFloat(q.最新价 ?? q.price ?? 0) || 0) : 0;
            if (price > 0) {
              // 总资产/单票已持市值复用 Core.Portfolio.getAssets (FIX-3 收口, 与纪律检查分母一致)
              const assets = await Core.Portfolio.getAssets({ paper: false });
              const config = await Core.Discipline.getConfig();
              const pos = Core.Pending._suggestPosition({
                totalAssets: assets.totalAssets, price, config,
                heldValue: (assets.valueByCode && assets.valueByCode[code]) || 0
              });
              if (!pos) {
                console.warn(`[Screener] 待确认交易跳过 ${code}: 建议仓位不足一手或单票额度已满 (价 ${price})`);
              } else {
                // 大盘状态机: 卡片记录当前市况标签 (下跌市建议仓位已由 _suggestPosition 自动减半)
                let regimeLabel = '';
                try {
                  if (Core.Regime && typeof Core.Regime.gateMultipliers === 'function') {
                    const g = Core.Regime.gateMultipliers();
                    if (g && g.label) regimeLabel = (g.icon || '') + g.label;
                  }
                } catch (e) {
                  console.warn('[Screener] 市况标签读取失败:', e);
                }
                await Core.Pending.add({
                  code, name, market: Core.Util.stockCodePrefix(code), action: 'buy',
                  suggestedShares: pos.shares, suggestedAmount: pos.amount,
                  reason: reasons.join('；') || 'AI 选股',
                  assumption: '题材催化',                    // 与模拟盘口径一致: AI 场景固定归"题材催化"
                  stopLoss: +(price * Core.Constants.STOP_LOSS_RATIO_AUTO).toFixed(2),      // 与模拟盘口径一致: 现价 × STOP_LOSS_RATIO_AUTO
                  falsifyCondition, invalidation,
                  regime: regimeLabel,
                  source: 'screener'
                });
                toastSuccess('已生成实盘待确认交易, 请到持仓页确认');
              }
            } else {
              console.warn(`[Screener] 待确认交易跳过 ${code}: 现价不可用`);
            }
          } catch (e) {
            console.warn('[Screener] 生成待确认交易失败:', e);
          }
        }
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
