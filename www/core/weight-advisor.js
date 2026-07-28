/**
 * Core.WeightAdvisor - LLM 周度动态权重顾问 (Tier 6)
 *
 * 让大模型基于本周宏观/政策/板块表现, 调整下周 5 因子权重。
 * 解决"权重硬编码"无法适应市场状态切换的问题 (AI 主题期/政策利好期/熊市防御期)。
 *
 * 设计:
 *   - 触发: 每周日 20:00 (可手动调 adviseNow())
 *   - 输入: 本周宏观新闻 + 政策事件 + 板块涨跌 + Regime 状态 + 当前权重
 *   - 输出: 5 因子权重 JSON, 总和 = 1.0, 范围 [0.02, 0.35]
 *   - 校验: parseAndValidate 三层兜底, 权重变化上限 ±50% (防 LLM 过度反应)
 *   - 缓存: kv 'weight_advisor_this_week', 7 天 TTL
 *   - Fallback: LLM 调不通 → DEFAULT_WEIGHTS (来自 scoring.js)
 *
 * 用法:
 *   const weights = await Core.WeightAdvisor.getWeights();
 *   await Core.WeightAdvisor.scheduleWeekly();  // app.js init() 调
 */
(function() {
  'use strict';

  const KV_KEY = 'weight_advisor_this_week';
  const FACTOR_KEYS = ['roe', 'ep', 'turnover', 'north', 'industryPenalty'];
  const WEIGHT_MIN = 0.02;
  const WEIGHT_MAX = 0.35;
  const CHANGE_RATIO = 0.5;  // 单因子相对 DEFAULT 最大变化 ±50%

  function getDefaultWeights() {
    return (window.Core && Core.Scoring && Core.Scoring.DEFAULT_WEIGHTS) || {
      roe: 0.22, ep: 0.20, turnover: 0.16, north: 0.16, industryPenalty: 0.26
    };
  }

  function getWeekKey() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - d.getDay());  // 周日
    return d.toISOString().slice(0, 10);
  }

  function isThisWeek(cached) {
    return cached && cached.week === getWeekKey();
  }

  /**
   * 三层兜底 parse: 抓 { → JSON.parse → schema 校验
   */
  function parseAndValidate(raw) {
    if (typeof raw !== 'string') return null;
    const i = raw.indexOf('{'); const j = raw.lastIndexOf('}');
    if (i < 0 || j <= i) return null;
    let obj;
    try { obj = JSON.parse(raw.slice(i, j + 1)); } catch (e) { return null; }
    if (!obj || typeof obj !== 'object') return null;

    // schema 校验: 5 因子 + 权重和
    const weights = {};
    let sum = 0;
    for (const k of FACTOR_KEYS) {
      const v = parseFloat(obj[k]);
      if (isNaN(v)) return null;
      weights[k] = v;
      sum += v;
    }
    // 权重和容许 ±5% 误差
    if (Math.abs(sum - 1.0) > 0.05) return null;
    // 归一化
    for (const k of FACTOR_KEYS) weights[k] = +(weights[k] / sum).toFixed(4);
    return weights;
  }

  /**
   * 上下限 clamp + 变化上限 + 归一化 (防 LLM 一次推太狠)
   */
  function clamp(llmWeights, baseWeights) {
    const out = {};
    let sum = 0;
    for (const k of FACTOR_KEYS) {
      const v = llmWeights[k];
      const base = baseWeights[k] || 0.2;
      const minV = Math.max(WEIGHT_MIN, base * (1 - CHANGE_RATIO));
      const maxV = Math.min(WEIGHT_MAX, base * (1 + CHANGE_RATIO));
      out[k] = Math.max(minV, Math.min(maxV, v));
      sum += out[k];
    }
    // 再归一化到 1.0
    for (const k of FACTOR_KEYS) out[k] = +(out[k] / sum).toFixed(4);
    return out;
  }

  /**
   * 拉本周信号: 宏观 + 政策 + 板块表现 + regime
   */
  async function _collectContext() {
    const ctx = { regime: 'range', macro: '', policy: '', sectors: '' };
    try {
      if (Core.Regime && Core.Regime.get) {
        const r = await Core.Regime.get();
        if (r && r.state) ctx.regime = r.state;
      }
    } catch (e) { /* */ }
    try {
      if (Core.Macro && Core.Macro.formatForPrompt) {
        ctx.macro = (await Core.Macro.formatForPrompt()) || '';
      }
    } catch (e) { /* */ }
    try {
      if (Core.Macro && Core.Macro.formatPolicyForPrompt) {
        ctx.policy = (await Core.Macro.formatPolicyForPrompt()) || '';
      }
    } catch (e) { /* */ }
    try {
      if (Core.Market && Core.Market.sectorPerformance7d) {
        const sec = await Core.Market.sectorPerformance7d();
        ctx.sectors = (sec || []).slice(0, 10).map(s => s.name + ':' + (s.pctChange || 0).toFixed(1) + '%').join(',');
      }
    } catch (e) { /* */ }
    return ctx;
  }

  /**
   * 调 LLM 拿权重 (内部)
   */
  async function adviseNow() {
    const defaults = getDefaultWeights();
    const ctx = await _collectContext();

    const prompt = '你是 A 股长线多因子权重顾问。当前大盘状态: ' + ctx.regime + '。\n' +
      '本周宏观新闻: ' + (ctx.macro || '(无)').slice(0, 500) + '\n' +
      '本周政策事件: ' + (ctx.policy || '(无)').slice(0, 500) + '\n' +
      '本周板块表现 (top10): ' + (ctx.sectors || '(无)') + '\n\n' +
      '当前 5 因子基础权重: ' + JSON.stringify(defaults) + '\n\n' +
      '5 个因子说明:\n' +
      '- roe: ROE 质量 (基本面优先)\n' +
      '- ep: EP 低估值 (价值)\n' +
      '- turnover: 换手率反转 (低换手加分)\n' +
      '- north: 北向资金流入 (外资偏好)\n' +
      '- industryPenalty: 行业集中度惩罚 (防单行业暴露)\n\n' +
      '任务: 根据本周市场状态, 输出下周权重 (JSON):\n' +
      '{ "roe": 0.22, "ep": 0.20, "turnover": 0.16, "north": 0.16, "industryPenalty": 0.26 }\n' +
      '要求和 = 1.0 (±5% 容差), 每个因子 [0.02, 0.35]。\n' +
      '熊市加重 industryPenalty/roe, 减 north; 政策利好期可加 north; AI/科技主题期可加 roe。\n' +
      '只输出 JSON, 不要其他文字。';

    const raw = await Core.AI.callWithTimeout({
      prompt,
      temperature: 0.3,
      maxTokens: 400,
      timeoutMs: 60000,
      page: 'weight-advisor',
      purpose: 'weight-advisor-weekly'
    });
    if (!raw) return null;

    const parsed = parseAndValidate(raw);
    if (!parsed) {
      console.warn('[WeightAdvisor] LLM 输出解析失败, raw=', raw.slice(0, 200));
      return null;
    }
    return clamp(parsed, defaults);
  }

  /**
   * 拿本周权重 (带缓存 + fallback)
   */
  async function getWeights() {
    const defaults = getDefaultWeights();
    // 1. 缓存命中
    try {
      const cached = await Core.Storage.kvGet(KV_KEY);
      if (cached && isThisWeek(cached)) {
        return Object.assign({}, defaults, cached.weights || {});
      }
    } catch (e) { /* */ }

    // 2. 调 LLM
    const weights = await adviseNow().catch(e => {
      console.warn('[WeightAdvisor] adviseNow 失败:', e);
      return null;
    });
    if (!weights) return defaults;  // fallback

    // 3. 写缓存
    try {
      await Core.Storage.kvSet(KV_KEY, {
        week: getWeekKey(),
        weights,
        ts: Date.now()
      });
    } catch (e) { /* */ }
    return weights;
  }

  /**
   * 周日 20:00 自动更新 (app.js init 调)
   */
  function scheduleWeekly() {
    if (typeof setInterval === 'undefined') return null;
    // 每小时检查一次, 周日 20:00 ±1 小时触发
    const timer = setInterval(async () => {
      const d = new Date();
      if (d.getDay() === 0 && d.getHours() === 20) {
        // 检查是否本周已跑过
        const cached = await Core.Storage.kvGet(KV_KEY).catch(() => null);
        if (isThisWeek(cached)) return;
        await adviseNow().catch(e => console.warn('[WeightAdvisor] 周度更新失败:', e));
      }
    }, 60 * 60 * 1000);
    return timer;
  }

  window.Core = window.Core || {};
  window.Core.WeightAdvisor = {
    getWeights,
    adviseNow,
    scheduleWeekly,
    parseAndValidate,
    clamp
  };
})();