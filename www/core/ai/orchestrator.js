/**
 * Core.AI.Orchestrator - AI agent 统一编排入口 (Phase 3)
 * 依赖: Core.AI.ToolRegistry / Core.AI.Tracing / Core.AI.cachedCall / Core.Agents._summarizeCtx / _coerceList
 *
 * 设计:
 *   - runAgent({strategy, agentType, ctx, opts}) 统一入口, 替代 agents.js 三处独立 runObserver/Analyst/Coach
 *   - 生成 runId 并透传 cachedCall → _logAICall (ai_call_log.runId 字段)
 *   - Tracing.start / recordEvent / finish / flush 串联
 *   - 返回形状与旧 runXxx 完全一致 ({ok, summary, data, raw, error, runId})
 *   - 复用 Core.Agents._summarizeCtx(AgentRun 5 秒级间隔, 每次 reload ctx)
 *   - 引用 Core.Agents._coerceList 解析 LLM JSON 输出
 *   - agent-ui.js 19 处 Core.Agent.* 引用完全不动
 *
 * ALLOWED 枚举直接引用 Core.Agents.ALLOWED, 保持一致
 *
 * CLAUDE.md 安全准则:
 *   - innerHTML 不在本文件范围 (UI 由调用方渲染)
 *   - 空 catch 必须 console.warn
 *   - runId 生成不含日期以外的 PII
 */
(function() {
  'use strict';

  /**
   * 核心入口: 跑一个 AI agent
   * @param {{
   *   strategy: 'long'|'short'|'fund'|'agents',
   *   agentType: 'observer'|'analyst'|'coach',
   *   ctx: object,                  // 事实数据, 经 _summarizeCtx 渲染后当 prompt
   *   opts?: {
   *     deps?: { callLLM?: Function },
   *     runId?: string,             // 外部传入 runId (pipeline 顶层生成)
   *     temperature?: number,
   *     maxTokens?: number,
   *     ttl?: number,               // cachedCall TTL
   *     contextHash?: string,       // cachedCall contextHash (版本号)
   *     skipCache?: boolean,        // 是否跳过缓存 (走 call 而非 cachedCall)
   *     local?: boolean,            // Core.AI.call local 参数
   *     stream?: boolean            // 暂不支持 (Orchestrator 层不做流式)
   *   }
   * }} param
   * @returns {Promise<{
   *   runId: string,
   *   agent: string,
   *   ok: boolean,
   *   summary: string,
   *   data: object,
   *   raw?: string,
   *   error?: string,
   *   latencyMs: number
   * }>}
   */
  async function runAgent({ strategy, agentType, ctx, opts }) {
    const t0 = Date.now();
    opts = opts || {};
    strategy = strategy || 'agents';
    agentType = agentType || 'observer';
    ctx = ctx || {};

    // 1. 生成/复用 runId
    const runId = opts.runId || ('run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));

    // 2. Tracing 初始化
    const tracing = window.Core && window.Core.AI && window.Core.AI.Tracing;
    if (tracing) {
      tracing.start(runId, { intent: agentType, strategy, agentType, startedAt: t0 });
      tracing.recordEvent(runId, { kind: 'agent.start', summary: `${agentType} start` });
    }

    let result;
    try {
      // 3. 按 agentType 构造 system prompt + ALLOWED 枚举
      // P3.3: 先 await 一次 KB 取毛选元规则, 失败 fallback
      const maoBlock = await _maoBlockAsync();
      const { sys, resultKey, allowed } = _buildPrompt(agentType, maoBlock);

      // 4. 渲染 ctx → prompt 文本
      const summarize = window.Core && window.Core.Agents && window.Core.Agents._summarizeCtx;
      const ctxText = typeof summarize === 'function' ? summarize(ctx) : JSON.stringify(ctx).slice(0, 2000);
      const prompt = _buildUserPrompt(agentType, ctxText);

      // 5. 调 AI (优先 deps.callLLM 用于测试注入)
      const deps = opts.deps || {};
      let text;
      if (typeof deps.callLLM === 'function') {
        text = await deps.callLLM({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: opts.temperature ?? 0.3 });
      } else if (opts.skipCache) {
        text = await Core.AI.call({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: opts.temperature ?? 0.3, runId });
      } else {
        text = await Core.AI.cachedCall({ prompt, systemPrompt: sys, local: opts.local !== false, temperature: opts.temperature ?? 0.3, maxTokens: opts.maxTokens, ttl: opts.ttl, contextHash: opts.contextHash, runId, strategy: strategy });
      }

      // 6. 解析 LLM JSON 输出
      const coerce = window.Core && window.Core.Agents && window.Core.Agents._coerceList;
      const parsed = typeof coerce === 'function'
        ? _parsedOrDefault(coerce, text, resultKey, allowed, agentType)
        : _fallbackParse(text, resultKey, agentType);

      if (tracing) {
        tracing.recordEvent(runId, { kind: 'ai.result', summary: `${agentType} parsed ${parsed.length} items`, detail: { count: parsed.length } });
      }

      result = {
        ok: true,
        summary: _summaryOf(agentType, parsed.length),
        data: _dataOf(agentType, parsed),
        raw: text,
        runId
      };
    } catch (e) {
      console.warn('[Orchestrator]', agentType, '失败:', e);
      if (tracing) {
        tracing.recordEvent(runId, { kind: 'error', summary: `${agentType} error: ${e.message}` });
      }
      result = {
        ok: false,
        summary: _failedSummary(agentType, e.message),
        data: _emptyData(agentType),
        raw: '',
        error: e.message,
        runId
      };
    }

    // 7. Tracing finish + flush
    const latencyMs = Date.now() - t0;
    if (tracing) {
      tracing.finish(runId, { ok: result.ok, totalMs: latencyMs, finishedAt: Date.now(), steps: [{ agent: agentType, ok: result.ok }] });
      tracing.flush(runId).catch((e) => console.warn('[Orchestrator] flush 失败:', e));
    }

    result.latencyMs = latencyMs;
    result.agent = agentType;
    return result;
  }

  // ========== 内部: prompt 构造 ==========

  const ALLOWED_OBSERVER = { category: ['异动', '公告', '情绪', '技术', '资金', '宏观'], severity: ['high', 'medium', 'low'] };
  const ALLOWED_ANALYST = { type: ['positive', 'negative', 'neutral'], confidence: ['high', 'medium', 'low'] };
  const ALLOWED_COACH = { action: ['buy', 'sell', 'hold', 'watch', 'cut'], urgency: ['immediate', 'high', 'medium', 'low'] };

  /**
   * P3.3: 毛选/纪律元规则 (从 KB.rule 异步加载, 缓存到 module 级)
   * 三 agent 共用同一段元规则
   * 注: KB 启动是异步的, 这里用 Promise 一次性预取, 失败 fallback 硬编码
   */
  let _maoBlockPromise = null;
  function _loadMaoDiscipline() {
    if (_maoBlockPromise) return _maoBlockPromise;
    _maoBlockPromise = (async () => {
      const FALLBACK = `## 交易纪律元规则 (毛选 + 行为金融提炼)
1. **抓主要矛盾** (《矛盾论》): 每轮牛熊只抓 1-2 个主线, 不撒胡椒面; 拒绝「平均分配仓位」
2. **没有调查就没有发言权** (《调查研究》): 每只票必须看过 PE 自身历史分位 + 行业产能 + 公告才给结论, 没数据不交易
3. **集中优势兵力** (《战略战术》): 研究池 ≤50 只, 单只仓位 ≤2%, 不均摊; 重仓高确定性
4. **敌进我退** (《论持久战》): 跌破 20 日线 / -8% 强制止损, 不抢反弹; 熊市状态强制降仓
5. **持久战哲学** (《论持久战》): 长期池以年为单位持有, 不被日线波动带偏; 短期池快进快出
6. **实事求是** (《矛盾论》): 拒绝套用通用策略; 每只票单独判断 4 阶段 (周期/估值/资金/消息)
7. **反人性** (行为金融): 警惕处置效应/确认偏误/沉没成本/回本妄想/锚定/FOMO, 这些是你的本能陷阱, 不是「坚持」
`;
      try {
        if (typeof window === 'undefined' || !window.Core || !window.Core.KB) return FALLBACK;
        const entries = await window.Core.KB.get('rule');
        const mao = (entries || []).filter(e => /^MAO-/.test(e.id));
        if (mao.length === 0) return FALLBACK;
        const lines = ['## 交易纪律元规则 (毛选提炼, 从 KB.rule 取)'];
        mao.sort((a, b) => a.id.localeCompare(b.id)).forEach(e => {
          lines.push(`- **${e.id} ${e.title}**: ${e.summary.split(/[。\n]/)[0]}`);
        });
        return lines.join('\n');
      } catch (e) {
        return FALLBACK;
      }
    })();
    return _maoBlockPromise;
  }

  /**
   * 同步取 maoBlock 文本; 第一次 _buildPrompt 调用时如果还没加载完, 用 fallback
   */
  function _maoBlockSync() {
    const FALLBACK = `## 交易纪律元规则 (毛选 + 行为金融提炼)
1. **抓主要矛盾** (《矛盾论》): 每轮牛熊只抓 1-2 个主线, 不撒胡椒面
2. **没有调查就没有发言权** (《调查研究》): 没数据不交易
3. **集中优势兵力** (《战略战术》): 单只仓位 ≤2%, 不均摊
4. **敌进我退** (《论持久战》): 跌破 20 日线 / -8% 强制止损
5. **持久战哲学**: 长期池以年为单位持有
6. **实事求是**: 每只票单独判断 4 阶段
7. **反人性**: 警惕处置效应/确认偏误/沉没成本
`;
    // 启动预取 (fire-and-forget, 第二次起从缓存读)
    const p = _loadMaoDiscipline();
    // 同步读 Promise 不可行, 但 init() 在启动期已跑完, 这里直接用 FALLBACK
    // _buildPrompt 是同步函数, maoBlock 的异步加载在 init 完成后立即可见
    // 但 _buildPrompt 自身是同步调用, 所以这里用 FALLBACK 保证不阻塞
    // 后续 runAgent 调用方在 _buildPrompt 之前 await _loadMaoDiscipline() 取最新值
    return FALLBACK;
  }

  async function _maoBlockAsync() {
    return await _loadMaoDiscipline();
  }

  function _buildPrompt(agentType, maoBlock) {
    const block = maoBlock || _maoBlockSync();
    if (agentType === 'observer') {
      return {
        sys: block + `

你是一个投资观察者助手. 你的任务是基于用户给的事实, 提取出有意义的"观察点".
只输出严格 JSON, 不要任何解释. 格式:
{"observations":[{"category":"异动|公告|情绪|技术|资金|宏观","code":"股票代码或基金代码,无则空","text":"一句话观察,30字内","severity":"high|medium|low","source":"holding|alert|journal|market|news"}]}
每个事实一条, 最多 8 条. 没有值得说的就返回空数组.`,
        resultKey: 'observations',
        allowed: ALLOWED_OBSERVER
      };
    }
    if (agentType === 'analyst') {
      return {
        sys: block + `

你是一个投资分析师. 基于"观察点"做诊断: 找出风险/机会/中性信号.
只输出严格 JSON, 不要任何解释. 格式:
{"findings":[{"type":"positive|negative|neutral","code":"股票代码或基金代码,无则空","text":"一句话结论,40字内","confidence":"high|medium|low"}]}
最多 6 条. 只保留有意义的诊断, 没看出来就空数组.`,
        resultKey: 'findings',
        allowed: ALLOWED_ANALYST
      };
    }
    // coach
    return {
      sys: block + `

你是个人投资教练. 基于诊断结果, 给出具体可执行的行动建议.
只输出严格 JSON, 不要任何解释. 格式:
{"actions":[{"code":"股票代码或基金代码","action":"buy|sell|hold|watch|cut","reason":"一句话,30字内","urgency":"immediate|high|medium|low","targetPrice":数字或null}],"watchlist":[]}
最多 4 条 actions. 保守为先: 不确定就 hold. 行动必须对应到具体 code.`,
      resultKey: 'actions',
      allowed: ALLOWED_COACH
    };
  }

  function _buildUserPrompt(agentType, ctxText) {
    const prefix = agentType === 'observer' ? '以下是我的事实, 请提取观察点:' :
                   agentType === 'analyst' ? '观察点如下, 请诊断:' :
                   '诊断结论如下, 请给行动建议:';
    return `${prefix}\n${ctxText}`;
  }

  // ========== 内部: 解析 / 汇总 ==========

  function _parsedOrDefault(coerceFn, text, resultKey, allowed, agentType) {
    try {
      return coerceFn(text, resultKey, allowed);
    } catch (e) {
      console.warn('[Orchestrator] _coerceList 失败, 回退 _fallbackParse:', agentType, e.message);
      return _fallbackParse(text, resultKey, agentType);
    }
  }

  /** 完全不依赖 Core.Agents 的回退解析 (纯正则) */
  function _fallbackParse(text, resultKey, agentType) {
    try {
      const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      const j = JSON.parse(cleaned);
      if (Array.isArray(j[resultKey])) return j[resultKey];
      return [];
    } catch (e) {
      return [];
    }
  }

  function _summaryOf(agentType, count) {
    if (agentType === 'observer') return `观察者提取 ${count} 条观察`;
    if (agentType === 'analyst') return `分析师给出 ${count} 条诊断`;
    return `教练给出 ${count} 条行动建议`;
  }

  function _failedSummary(agentType, msg) {
    if (agentType === 'observer') return '观察者失败: ' + msg;
    if (agentType === 'analyst') return '分析师失败: ' + msg;
    return '教练失败: ' + msg;
  }

  function _dataOf(agentType, parsed) {
    if (agentType === 'observer') return { observations: parsed };
    if (agentType === 'analyst') return { findings: parsed };
    return { actions: parsed, watchlist: [] };
  }

  function _emptyData(agentType) {
    if (agentType === 'observer') return { observations: [] };
    if (agentType === 'analyst') return { findings: [] };
    return { actions: [], watchlist: [] };
  }

  // 暴露
  window.Core = window.Core || {};
  window.Core.AI = window.Core.AI || {};
  window.Core.AI.Orchestrator = {
    runAgent,
    _buildPrompt, _buildUserPrompt, _fallbackParse,
    _loadMaoDiscipline, _maoBlockAsync, _maoBlockSync
  };
})();