/**
 * Core.AI - 大模型调用统一入口
 * 支持 DeepSeek / OpenAI 兼容 / 自定义 (OpenAI 协议)
 * 特性:
 *   - 流式 (SSE) + 一次性
 *   - 自动从 Core.State 读配置 (provider/apiKey/model/baseURL)
 *   - 错误降级: 网络错误/CORS/401 都返回结构化错误
 *   - 不写死任何 API Key, 全部运行时 UI 配置
 */
(function() {
  'use strict';

  // ===== Provider 配置表 =====
  const PROVIDERS = {
    deepseek: {
      name: 'DeepSeek',
      baseURL: 'https://api.deepseek.com/v1',
      // 部分企业部署只支持 v4 模型名 (如 deepseek-v4-pro / deepseek-v4-flash)
      // 公网 API 仍可用 deepseek-chat / deepseek-reasoner
      defaultModel: 'deepseek-v4-flash',
      models: [
        // v4 系列 (新版 / 企业部署)
        'deepseek-v4-flash', 'deepseek-v4-pro',
        // v3 系列 (公网 API 传统名)
        'deepseek-chat', 'deepseek-reasoner'
      ],
      docs: 'https://platform.deepseek.com/'
    },
    openai: {
      name: 'OpenAI',
      baseURL: 'https://api.openai.com/v1',
      defaultModel: 'gpt-4o-mini',
      models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      docs: 'https://platform.openai.com/'
    },
    moonshot: {
      name: 'Moonshot (Kimi)',
      baseURL: 'https://api.moonshot.cn/v1',
      defaultModel: 'moonshot-v1-8k',
      models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
      docs: 'https://platform.moonshot.cn/'
    },
    qwen: {
      name: '通义千问 (DashScope, OpenAI 兼容)',
      baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      defaultModel: 'qwen-plus',
      models: ['qwen-turbo', 'qwen-plus', 'qwen-max', 'qwen-long'],
      docs: 'https://dashscope.aliyun.com/'
    },
    zhipu: {
      name: '智谱 GLM (OpenAI 兼容)',
      baseURL: 'https://open.bigmodel.cn/api/paas/v4',
      defaultModel: 'glm-4-flash',
      models: ['glm-4-flash', 'glm-4', 'glm-4-plus'],
      docs: 'https://open.bigmodel.cn/'
    },
    custom: {
      name: '自定义 (OpenAI 兼容)',
      baseURL: '',
      defaultModel: '',
      models: [],
      docs: '任意 OpenAI 兼容端点 (LM Studio / Ollama / vLLM 等)'
    }
  };

  function getProviderConfig(provider) {
    return PROVIDERS[provider] || PROVIDERS.deepseek;
  }

  function getConfig() {
    const s = Core.State.get();
    const ai = s.ai || {};
    const provider = ai.provider || 'deepseek';
    const pcfg = getProviderConfig(provider);

    // baseURL 解析优先级: 本地代理 (勾了) > 用户填的 > provider 默认
    // 勾本地代理时强制走 /api/llm/{provider}/v1, 解决 CORS
    const useProxyWanted = ai.useProxy !== false && provider !== 'custom';
    let baseURL;
    let useProxy = false;
    if (useProxyWanted) {
      baseURL = `/api/llm/${provider}/v1`;
      useProxy = true;
    } else if (ai.baseURL) {
      baseURL = ai.baseURL;
    } else {
      baseURL = pcfg.baseURL;
    }

    // 5.3.3: 本地 LLM 配置 (DeepSeek v4-flash 本地部署, 个人自用)
    // 优先用 ai.localEndpoint, 否则回退到主配置
    const local = ai.localEndpoint || {};
    const localConfig = {
      baseURL: local.baseURL || '',
      apiKey: local.apiKey || 'local-no-auth',  // 本地部署通常不验 key
      model: local.model || ai.model || pcfg.defaultModel,
      enabled: ai.preferLocal === true && !!local.baseURL
    };

    return {
      provider,
      baseURL,
      model: ai.model || pcfg.defaultModel,
      apiKey: ai.apiKey || '',
      temperature: ai.temperature ?? 0.7,
      maxTokens: ai.maxTokens ?? 8000,
      useProxy,
      preferLocal: ai.preferLocal === true,
      local: localConfig
    };
  }

  /**
   * 5.3.3: 解析一个 opts 对象, 决定用本地还是远程
   * opts.local === true → 强制本地 (即使 preferLocal=false)
   * opts.local === false → 强制远程 (即使 preferLocal=true)
   * opts.local 未指定 → 按 cfg.preferLocal 决定
   * 规则: 本地未启用 (无 baseURL 或 enabled=false) → 回退远程
   * 返回: { baseURL, apiKey, model, isLocal, reason }
   */
  function resolveEndpoint(opts = {}) {
    const cfg = getConfig();
    const wantLocal = opts.local === true ? true : (opts.local === false ? false : cfg.preferLocal);
    const canLocal = cfg.local.enabled;
    if (wantLocal && canLocal) {
      return {
        baseURL: cfg.local.baseURL,
        apiKey: cfg.local.apiKey,
        model: cfg.local.model,
        isLocal: true,
        reason: 'local'
      };
    }
    return {
      baseURL: (opts.baseURL || cfg.baseURL).replace(/\/$/, ''),
      apiKey: opts.apiKey || cfg.apiKey,
      model: opts.model || cfg.model,
      isLocal: false,
      reason: (wantLocal && !canLocal) ? 'local-disabled-fallback-remote' : 'remote'
    };
  }

  /**
   * 主调用入口
   * opts: {
   *   prompt, systemPrompt,
   *   stream, onChunk, onDone, onError,
   *   temperature, model, apiKey, baseURL  // 覆盖默认
   *   local: true|false   // 5.3.3: 强制本地/远程
   * }
   * 返回: 完整文本
   */
  async function call(opts) {
    const cfg = getConfig();
    // 5.3.3: 解析 endpoint (本地优先 / 远程)
    const ep = resolveEndpoint(opts);
    const baseURL = ep.baseURL;
    const model = ep.model;
    const apiKey = ep.apiKey;
    const temperature = opts.temperature ?? cfg.temperature;
    const maxTokens = opts.maxTokens ?? cfg.maxTokens;

    if (!apiKey && cfg.provider !== 'custom' && !ep.isLocal) {
      throw new Error('未配置 API Key - 请到 ⚙️ 设置页填入');
    }
    if (!baseURL) {
      throw new Error('未配置 API 地址');
    }
    if (!model) {
      throw new Error('未配置模型名');
    }

    const body = {
      model,
      messages: [
        ...(opts.systemPrompt ? [{ role: 'system', content: opts.systemPrompt }] : []),
        { role: 'user', content: opts.prompt }
      ],
      temperature,
      max_tokens: maxTokens,
      stream: !!opts.stream
    };

    const url = `${baseURL}/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
    } catch (e) {
      throw new Error('网络请求失败 (可能是 CORS 或断网): ' + e.message);
    }

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg = `HTTP ${resp.status}`;
      try {
        const j = JSON.parse(errText);
        if (j.error && j.error.message) errMsg = j.error.message;
        if (j.error && j.error.type === 'invalid_request_error' && /model/i.test(errMsg)) {
          // 模型名错误, 自动列出可用模型
          const cfg = getProviderConfig(cfg.provider);
          errMsg += `\n\n当前 Provider (${cfg.name}) 支持的模型:\n  ${cfg.models.join(', ')}\n默认: ${cfg.defaultModel}`;
        }
      } catch (e) { /* not JSON */ }
      if (resp.status === 401) errMsg = 'API Key 无效或过期';
      if (resp.status === 429) errMsg = '请求太频繁 / 余额不足';
      if (resp.status === 402) errMsg = '余额不足, 请充值';
      throw new Error(errMsg);
    }

    if (opts.stream) {
      return await readSSE(resp.body, opts.onChunk, opts.onError);
    } else {
      const j = await resp.json();
      return j.choices?.[0]?.message?.content || '';
    }
  }

  /**
   * SSE 流式读取 (OpenAI 协议)
   * onChunk(delta, fullText)
   */
  async function readSSE(body, onChunk, onError) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const payload = trimmed.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const obj = JSON.parse(payload);
            const delta = obj.choices?.[0]?.delta?.content || '';
            if (delta) {
              full += delta;
              if (onChunk) {
                try { onChunk(delta, full); }
                catch (e) { console.warn('[AI] onChunk error:', e); }
              }
            }
          } catch (e) { /* 忽略单行解析错误 */ }
        }
      }
    } catch (e) {
      if (onError) onError(e);
      else console.error('[AI] SSE 中断:', e.message);
    }
    return full;
  }

  /**
   * 测试连接 (1 token 的最小请求)
   * 返回: {ok, model, latencyMs, error}
   */
  async function testConnection() {
    const cfg = getConfig();
    const start = Date.now();
    try {
      // 推理模型 (v4-flash/pro) 会烧 reasoning_tokens, 至少给 500 token 才能看到 content
      const text = await call({
        prompt: '请用中文只回一个词: 通',
        maxTokens: 500,
        temperature: 0
      });
      return {
        ok: true,
        provider: cfg.provider,
        model: cfg.model,
        latencyMs: Date.now() - start,
        reply: text.trim()
      };
    } catch (e) {
      return {
        ok: false,
        provider: cfg.provider,
        model: cfg.model,
        latencyMs: Date.now() - start,
        error: e.message
      };
    }
  }

  window.Core = window.Core || {};
  window.Core.AI = {
    call,
    testConnection,
    getConfig,
    getProviderConfig,
    resolveEndpoint,
    PROVIDERS
  };
})();
