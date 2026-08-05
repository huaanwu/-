/**
 * Core.CrossCheck - 双模型交叉验证 (Phase D2)
 *
 * 思路: 💡 单股简评可用"第二个 LLM"对同一份上下文再评一次,
 *       然后主模型对两份输出做一次 ≤100 字的一致性小结 (共 2 次额外调用)。
 *       按需触发 (🤝 第二意见按钮), 不接任何自动流程, 成本可控。
 *
 * key 存储: Core.State.apiKeys.llm = { [provider]: apiKey }
 *           (设置页"🤝 第二意见"区维护; 与主 AI 配置的单一 apiKey 互不干扰)
 *
 * 实现路径: Core.AI.call 的 opts 支持 baseURL/apiKey/model 覆盖 + local:false
 *           强制远程, 因此不需要改 ai-service.js 即可按调用指定 provider。
 */
(function() {
  'use strict';

  // provider 候选顺序 (与 Core.AI.PROVIDERS key 顺序一致; custom 不走 dev-proxy, 排除)
  const PROVIDER_ORDER = ['deepseek', 'openai', 'moonshot', 'qwen', 'zhipu', 'minimax'];

  /**
   * 挑第二意见的 provider (纯函数, 可 Node 测试)
   * 规则: 按 PROVIDER_ORDER 顺序, 找第一个 ≠ 当前主 provider 且配了 key 的
   * @param {string} currentProvider - 当前主 provider
   * @param {object} llmKeys - { [provider]: apiKey }
   * @param {string[]} [order] - 可选候选顺序 (测试注入)
   * @returns {string|null} provider key, 没有可用第二 provider → null
   */
  function pickSecondProvider(currentProvider, llmKeys, order) {
    const keys = llmKeys || {};
    const candidates = (Array.isArray(order) && order.length > 0) ? order : PROVIDER_ORDER;
    for (const p of candidates) {
      if (p !== currentProvider && typeof keys[p] === 'string' && keys[p].trim()) return p;
    }
    return null;
  }

  /**
   * 从全局 state 解析第二意见的调用配置 (供 Core.AI.call opts 覆盖用)
   * @param {object} state - Core.State.get() 的返回 ({ ai, apiKeys, ... })
   * @returns {object|null} { provider, label, baseURL, apiKey, model } 或 null (未配置)
   */
  function resolveSecondOpinion(state) {
    const ai = (state && state.ai) || {};
    const apiKeys = (state && state.apiKeys) || {};
    const provider = pickSecondProvider(ai.provider || 'deepseek', apiKeys.llm);
    if (!provider) return null;
    if (typeof Core === 'undefined' || !Core.AI || !Core.AI.getProviderConfig) return null;
    const pcfg = Core.AI.getProviderConfig(provider);
    // 与 ai-service.getConfig 同款逻辑: 勾了本地代理 (默认勾) → /api/llm/{provider}/v1
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const useProxy = ai.useProxy !== false;
    const baseURL = useProxy ? _apiUrl(`/api/llm/${provider}/v1`) : (pcfg.baseURL || '');
    if (!baseURL) return null;
    return {
      provider,
      label: pcfg.name || provider,
      baseURL,
      apiKey: (apiKeys.llm[provider] || '').trim(),
      model: pcfg.defaultModel || ''
    };
  }

  /**
   * 一致性对比 prompt (纯函数): 主模型对两份简评做 ≤100 字小结
   */
  function buildComparePrompt(textA, textB, labelA, labelB) {
    return [
      '你是投资分析质检员。下面是两个不同 LLM 对同一只 A 股个股、同一份上下文给出的简评。',
      '',
      `【${labelA || '模型A'} 的简评】`,
      String(textA || ''),
      '',
      `【${labelB || '模型B'} 的简评】`,
      String(textB || ''),
      '',
      '请输出"结论一致性"小结 (≤100 字):',
      '1. 一致点 (1-2 条)',
      '2. 分歧点 (1-2 条, 没有就写"无明显分歧")',
      '3. 最后一行结论: 结论一致 / 部分一致 / 明显分歧',
      '不要重复原文, 不要给新的投资建议。'
    ].join('\n');
  }

  window.Core = window.Core || {};
  window.Core.CrossCheck = {
    pickSecondProvider,
    resolveSecondOpinion,
    buildComparePrompt
  };
})();
