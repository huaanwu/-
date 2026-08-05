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
    minimax: {
      // 用户授权预填的 Minimax Coding (Anthropic 兼容 + Claude 模型族)
      // 与 stock-master 上原有的本地 qwen3 互补: 本地跑不出/稳定性差时切远端
      name: 'Minimax Coding',
      baseURL: 'https://api.minimax.chat/v1',
      defaultModel: 'minimax-coding',
      models: ['minimax-coding'],
      docs: 'https://api.minimax.chat/'
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
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const useProxyWanted = ai.useProxy !== false && provider !== 'custom';
    let baseURL;
    let useProxy = false;
    if (useProxyWanted) {
      baseURL = _apiUrl(`/api/llm/${provider}/v1`);
      useProxy = true;
    } else if (ai.baseURL) {
      baseURL = ai.baseURL;
    } else {
      baseURL = pcfg.baseURL;
    }

    // 5.3.3: 本地 LLM 配置 (DeepSeek v4-flash 本地部署, 个人自用)
    // 优先用 ai.localEndpoint, 否则回退到主配置
    const local = ai.localEndpoint || {};
    // 7) 自动发现模式: baseURL 形如 http://<ip>:8082/v1 → 强制走 /api/local/v1 绕浏览器 CORS
    // APK / 真机场景: 本地 LLM 直连会被 CORS 拦截, 通过 dev-proxy /api/local 转发
    let localBaseURL = local.baseURL || '';
    if (localBaseURL && !localBaseURL.startsWith('/')) {
      const _isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
      const isSameHost = (location.hostname === 'localhost' || location.hostname === '127.0.0.1' || /^\[.*\]$/.test(location.hostname) || /^::1$/.test(location.hostname));
      if (isSameHost || _isNative) {
        // 本机场景 / APK 场景: 走 dev-proxy /api/local 绕 CORS
        try {
          const u = new URL(localBaseURL);
          localBaseURL = _apiUrl(`/api/local${u.pathname}`.replace(/\/v1\/v1$/, '/v1'));
        } catch (e) { console.warn('[AI] 本地 LLM baseURL 解析失败, 保留原值:', e.message); }
      }
    }
    const localConfig = {
      baseURL: localBaseURL,
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
   *   injectContext: true|false  // Z1c: 默认 true, 自动注入 Core.MarketWidth 市场宽度信号
   * }
   * 返回: 完整文本
   */
  async function call(opts) {
    const t0 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const cfg = getConfig();
    // 5.3.3: 解析 endpoint (本地优先 / 远程)
    const ep = resolveEndpoint(opts);
    const baseURL = ep.baseURL;
    const model = ep.model;
    const apiKey = ep.apiKey;
    const temperature = opts.temperature ?? cfg.temperature;
    const maxTokens = opts.maxTokens ?? cfg.maxTokens;

    // Z6: 准备日志入参 (失败也写, 用于诊断)
    const logEntry = {
      page: opts.page || '?',
      purpose: opts.purpose || '?',
      prompt: opts.prompt || '',
      systemPrompt: '',
      response: '',
      latencyMs: 0,
      model,
      baseURL,
      injected: { width: false },
      _t0: t0  // 给 _logAICall 算 latency
    };

    if (!apiKey && cfg.provider !== 'custom' && !ep.isLocal) {
      const err = new Error('未配置 API Key - 请到 ⚙️ 设置页填入');
      _logAICall(logEntry, err);  // 失败也记录
      throw err;
    }
    if (!baseURL) {
      const err = new Error('未配置 API 地址');
      _logAICall(logEntry, err);
      throw err;
    }
    if (!model) {
      const err = new Error('未配置模型名');
      _logAICall(logEntry, err);
      throw err;
    }

    // Z1c: 默认注入市场宽度信号 (Kimi Regime 之外的 cross-check 维度)
    // injectContext=false 可关, 默认 true
    let systemPrompt = opts.systemPrompt || '';
    if (opts.injectContext !== false && window.Core && Core.MarketWidth) {
      try {
        const width = await Core.MarketWidth.getMarketWidth();
        if (width && width.status && width.status !== 'unknown') {
          systemPrompt = (systemPrompt ? systemPrompt + '\n\n' : '') + Core.MarketWidth.formatWidthForPrompt(width);
          logEntry.injected.width = true;
        }
      } catch (e) {
        console.warn('[AI] 注入市场宽度失败, 继续:', e.message);
      }
    }
    logEntry.systemPrompt = systemPrompt;

    const body = {
      model,
      messages: [
        ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
        { role: 'user', content: opts.prompt }
      ],
      temperature,
      max_tokens: maxTokens,
      stream: !!opts.stream
    };

    // v0.2.15 修: 用 Core.Data.apiUrl() 解析 baseURL, 避免 Electron 安装版 (29037 内置 http 不代理 /api/*) 下的相对路径 fetch 失败
    //   远程绝对 URL (https://api.minimax.chat/v1) → apiUrl 透传 → 直连 (CORS 由服务器控制)
    //   相对路径 (/api/llm/minimax-coding/v1, 自动从 dev-proxy 走) → dev 模式 vite proxy, prod 模式 fallback 127.0.0.1:8089
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const url = `${_apiUrl(baseURL)}/chat/completions`;
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify(body),
        signal: opts.signal  // Phase Q: AbortController 支持
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;  // 让外层区分超时
      _logAICall(logEntry, e);
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
      _logAICall(logEntry, new Error(errMsg));
      throw new Error(errMsg);
    }

    if (opts.stream) {
      const out = await readSSE(resp.body, opts.onChunk, opts.onError);
      logEntry.response = (out || '').slice(0, 200);
      _logAICall(logEntry, null);
      return out;
    } else {
      const j = await resp.json();
      const text = j.choices?.[0]?.message?.content || '';
      logEntry.response = text.slice(0, 200);
      _logAICall(logEntry, null);
      return text;
    }
  }

  // Z6: 异步写日志, 不阻塞主路径
  function _logAICall(entry, err) {
    const t1 = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    entry.latencyMs = Math.round(t1 - (entry._t0 || t1));
    if (err) entry.error = err.message || String(err);
    if (window.Core && Core.AICallLog && typeof Core.AICallLog.record === 'function') {
      Promise.resolve().then(() => Core.AICallLog.record(entry)).catch(e => {
        console.warn('[AI] 写日志失败:', e.message);
      });
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

  /**
   * 自动发现本地大模型端点
   * 浏览器调用 /api/discover/local-llm (dev-proxy 服务器端扫, 避开 CORS)
   * @returns {Promise<{found: Array<{baseURL, host, port, type, label, models, latencyMs}>, scanned, serverIPs, host}>}
   */
  async function discoverLocalLLM() {
    const _apiUrl = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    // cache: 'no-store' 避免 Service Worker cache-first 命中早期 "found: []" 的 stale 响应
    // (CLAUDE.md 全局规则第一条: SW + Cache Storage 三层缓存坑静态资源)
    const resp = await fetch(_apiUrl('/api/discover/local-llm'), { method: 'GET', cache: 'no-store' });
    if (!resp.ok) throw new Error('自动发现端点 HTTP ' + resp.status);
    const j = await resp.json();
    return {
      found: j.found || [],
      scanned: j.scanned || 0,
      serverIPs: j.serverIPs || [],
      host: j.host || '127.0.0.1'
    };
  }

  /**
   * selfCheck (Phase P 反向 self-check)
   * 拿之前的 AI 输出, 让 LLM 自己挑刺
   * @param {object} opts - { originalOutput, originalSystemPrompt, originalPrompt, onChunk, maxTokens=400 }
   * @returns {string} self-check 结果 (若无问题: "✓ self-check 通过")
   */
  async function selfCheck(opts) {
    if (!opts || !opts.originalOutput) throw new Error('selfCheck: 缺少 originalOutput');
    const criticSystemPrompt = [
      '你是一名严格的 AI 输出质检员 (Phase P 反向 self-check)。',
      '',
      '【任务】对原 AI 输出做挑刺, 找出以下 4 类问题:',
      '  1) 幻觉: 编造了不存在的数字/事件/标的/基金代码',
      '  2) 过度自信: 用了绝对化表述 ("一定涨", "稳赚", "绝对")',
      '  3) 漏判: 用户场景的关键风险/机会, 输出完全没提到',
      '  4) 逻辑漏洞: 前后矛盾, 推理链断裂',
      '',
      '【输出格式】',
      '  - 若全部无问题: 输出 "✓ self-check 通过, 无明显问题"',
      '  - 若有问题: 列出 1-3 条, 每条 "[严重度] 问题描述"',
      '  - 严重度: 高 (幻觉/漏判) / 中 (过度自信) / 低 (表述瑕疵)',
      '',
      '【硬性规则】',
      '  - 不要重复原文',
      '  - 不要给替代答案, 只指出问题',
      '  - 总长度 < 200 字'
    ].join('\n');

    const criticPrompt = `【原 AI 输出】\n${opts.originalOutput}\n\n【原 prompt 上下文 (供你理解原任务)】\n${(opts.originalPrompt || '').slice(0, 500)}\n\n请按上面格式输出 self-check 结果。`;

    return await call({
      systemPrompt: criticSystemPrompt,
      prompt: criticPrompt,
      stream: !!opts.onChunk,
      onChunk: opts.onChunk,
      maxTokens: opts.maxTokens ?? 400
    });
  }

  /**
   * cachedCall (Phase Q) - 同 (systemPrompt + prompt) 24h 内不重算
   * 仅适合非流式调用. 流式场景直接用 call(), 自己在业务层缓存结果即可.
   * @param {object} opts - { systemPrompt, prompt, maxTokens, ttl, contextHash }
   * @returns {string} AI 输出
   */
  async function cachedCall(opts) {
    if (opts && opts.stream) {
      console.warn('[AI] cachedCall 不支持 stream, 自动转 call()');
      return await call(opts);
    }
    const ttl = (opts && opts.ttl) ?? 24 * 60 * 60 * 1000;  // 默认 24h
    // 生成 cache key (基于内容 hash)
    const keyRaw = JSON.stringify({
      sp: opts.systemPrompt || '',
      p: opts.prompt || '',
      ch: opts.contextHash || '',
      mt: opts.maxTokens || 0
    });
    // 简单 hash (FNV-1a)
    let hash = 2166136261;
    for (let i = 0; i < keyRaw.length; i++) {
      hash ^= keyRaw.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    const cacheKey = 'ai_cache_' + (hash >>> 0).toString(36);

    try {
      const cached = await Core.Storage.cacheGet(cacheKey);
      if (cached && typeof cached.text === 'string') {
        if (opts.onChunk) {
          // BUGFIX P2-6: 原代码按 100 char 切, 可能把 CJK surrogate pair 切断.
          //   JS `String.slice` 按 UTF-16 code unit 切, 中文占 1 unit 但 emoji / 部分生僻字占 2 unit.
          //   切到 surrogate pair 中间 → 替换回时显示乱码 (U+FFFD).
          //   修后: 优先用 Intl.Segmenter 按 grapheme 切, onChunk(delta, fullUpToNow).
          const text = cached.text;
          let fullAcc = '';
          const emit = (delta) => { fullAcc += delta; opts.onChunk(delta, fullAcc); };
          if (typeof Intl !== 'undefined' && Intl.Segmenter) {
            const seg = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
            const graphemes = Array.from(seg.segment(text), s => s.segment);
            const CHUNK = 20;  // 中文按 20 个字为一段 (≈ 40 字节)
            let buf = '';
            let bufCount = 0;
            for (const g of graphemes) {
              buf += g;
              bufCount++;
              if (bufCount >= CHUNK) { emit(buf); buf = ''; bufCount = 0; }
            }
            if (buf) emit(buf);
          } else {
            // 旧浏览器兜底: 50 char 切片 (足够小, 即使切碎 surrogate, onChunk 渲染时浏览器会修正部分)
            const CHUNK_FALLBACK = 50;
            const chunks = Math.ceil(text.length / CHUNK_FALLBACK);
            for (let i = 0; i < chunks; i++) {
              emit(text.slice(i * CHUNK_FALLBACK, (i + 1) * CHUNK_FALLBACK));
            }
          }
        }
        return cached.text;
      }
    } catch (e) { console.warn('[AI] cacheGet 失败:', e); }

    // 缓存未命中, 调 call()
    const text = await call(opts);

    // 写入缓存
    try {
      await Core.Storage.cacheSet(cacheKey, { text, at: Date.now() }, ttl);
    } catch (e) { console.warn('[AI] cacheSet 失败:', e); }

    return text;
  }

  /**
   * callWithTimeout (Phase Q) - 给 call() 加 AbortController 超时
   * opts: 同 call(), 额外:
   *   - timeout: 毫秒 (默认 60000)
   * @returns {string} AI 输出
   */
  async function callWithTimeout(opts) {
    const timeout = (opts && opts.timeout) ?? 60000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), timeout);
    try {
      return await call({ ...opts, signal: ac.signal });
    } catch (e) {
      if (e && (e.name === 'AbortError' || String(e.message || e).includes('abort'))) {
        throw new Error(`AI 调用超时 (${Math.round(timeout / 1000)}s)`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * callThrough (v0.2.x) - 域脚本统一入口, 走带超时的 call() 并支持 pageTag 透传 (用于 audit / tracing)
   * opts: 同 call() + callWithTimeout() (timeout/maxTokens/stream/... 都透传)
   * pageTag: 可选, 业务标识 (e.g. 'journal' / 'stock-advisor' / 'fund-ai'), 仅作占位, 未来可接 audit log
   * @returns {string} AI 输出
   */
  async function callThrough(opts, pageTag) {
    // 透传 page 到 opts, 给未来 audit hook 留口子 (call/callWithTimeout 会忽略未知字段)
    return await callWithTimeout({ ...(opts || {}), _pageTag: pageTag || (opts && opts.page) || 'unknown' });
  }

  /**
   * callRaw (Phase: AI 管家) - 透传完整 messages + tools, 返回原始结构化响应
   *
   * 与 call() 区别:
   *   - call() 重写成 system + single user, 适合 LongTrader/Screener 一次性输出 JSON
   *   - callRaw() 接受 opts.messages (OpenAI Chat Completions 协议格式),
   *     可选 opts.tools (OpenAI tools schema), 返回 { text, tool_calls, raw }
   *     而不仅是纯文本
   *
   * opts: { provider, model, messages: [{role, content, tool_calls?, tool_call_id?}],
   *         tools?: [{type:'function', function:{name, description, parameters}}],
   *         tool_choice?: 'auto' | 'required' | 'none' | { type:'function', function:{name}},
   *         temperature, maxTokens, signal, stream, onChunk }
   *
   * @returns { text, tool_calls, raw, usage }
   */
  async function callRaw(opts) {
    const cfg = await resolveEndpoint(opts);
    const { baseURL, apiKey, model } = cfg;
    const temperature = opts.temperature ?? 0.7;
    const maxTokens = opts.maxTokens ?? 2048;

    const body = {
      model,
      messages: opts.messages || [],
      temperature,
      max_tokens: maxTokens,
      stream: !!opts.stream
    };
    if (Array.isArray(opts.tools) && opts.tools.length > 0) {
      body.tools = opts.tools;
      if (opts.tool_choice) body.tool_choice = opts.tool_choice;
      else body.tool_choice = 'auto';
    }

    // v0.2.15 修: 同上, _apiUrl 解析 baseURL (相对路径 → 8089 fallback, 绝对 URL 透传)
    const _apiUrl2 = (window.Core && Core.Data && Core.Data.apiUrl) ? Core.Data.apiUrl : (p) => p;
    const url = _apiUrl2(baseURL) + '/chat/completions';
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey
        },
        body: JSON.stringify(body),
        signal: opts.signal
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new Error('网络请求失败 (CORS/断网): ' + e.message);
    }
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      let errMsg = 'HTTP ' + resp.status;
      try {
        const j = JSON.parse(errText);
        if (j.error && j.error.message) errMsg = j.error.message;
      } catch (_) {}
      if (resp.status === 401) errMsg = 'API Key 无效或过期';
      if (resp.status === 429) errMsg = '请求太频繁 / 余额不足';
      if (resp.status === 402) errMsg = '余额不足';
      throw new Error(errMsg);
    }

    if (opts.stream) {
      const out = await readSSEWithTools(resp.body, opts.onChunk);
      return out; // { text, tool_calls }
    } else {
      const j = await resp.json();
      const choice = j.choices && j.choices[0];
      const msg = choice && choice.message || {};
      // OpenAI 协议: assistant 消息必须至少有 content 或 tool_calls 之一
      // 某些 provider (reasoning 模型) 会返回 reasoning_content, 通过这里转 content
      let text = msg.content;
      if (text == null && typeof msg.reasoning_content === 'string') text = msg.reasoning_content;
      if (text == null) text = '';
      const tool_calls = msg.tool_calls || [];
      return {
        text,
        tool_calls,
        raw: j,
        usage: j.usage || null
      };
    }
  }

  /**
   * callRawWithTimeout - 给 callRaw 加 AbortController 超时
   */
  async function callRawWithTimeout(opts) {
    const timeout = (opts && opts.timeout) ?? 120000;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort('timeout'), timeout);
    try {
      return await callRaw({ ...opts, signal: ac.signal });
    } catch (e) {
      if (e && (e.name === 'AbortError' || String(e.message || e).includes('abort'))) {
        throw new Error('AI 调用超时 (' + Math.round(timeout / 1000) + 's)');
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * readSSEWithTools - 流式读 SSE 同时累积 tool_calls (OpenAI 协议)
   * onChunk(delta) 每次推一段文本增量
   * 返回 { text, tool_calls } - tool_calls 数组含 { id, type, function: { name, arguments } }
   */
  async function readSSEWithTools(body, onChunk) {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';
    let full = '';
    const toolCallsAccum = new Map(); // index -> tool_call
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
            const choice = obj.choices && obj.choices[0];
            if (!choice) continue;
            const delta = choice.delta || {};
            if (delta.content) {
              full += delta.content;
              if (onChunk) {
                try { onChunk(delta.content, full); } catch (e) { console.warn('[AI] onChunk 抛错:', e && e.message); }
              }
            }
            if (delta.tool_calls) {
              for (const tcDelta of delta.tool_calls) {
                const idx = tcDelta.index;
                if (!toolCallsAccum.has(idx)) {
                  toolCallsAccum.set(idx, {
                    id: tcDelta.id || null,
                    type: tcDelta.type || 'function',
                    function: { name: '', arguments: '' }
                  });
                }
                const tc = toolCallsAccum.get(idx);
                if (tcDelta.id) tc.id = tcDelta.id;
                if (tcDelta.function) {
                  if (tcDelta.function.name) tc.function.name += tcDelta.function.name;
                  if (tcDelta.function.arguments) tc.function.arguments += tcDelta.function.arguments;
                }
              }
            }
          } catch (e) { console.warn('[AI] SSE 单行 parse 失败:', e && e.message); }
        }
      }
    } catch (e) { console.warn('[AI] readSSEWithTools 外层异常:', e && e.message); }
    const tool_calls = [];
    for (const tc of toolCallsAccum.values()) {
      if (!tc.id) {
        // id 是 OAI 协议强约束, 缺失要让上层知道而不是 fabricating
        console.warn('[AI] tool_call 缺 id, 丢弃: name=' + (tc.function.name || '?'));
        continue;
      }
      tool_calls.push({
        type: tc.type,
        function: { name: tc.function.name, arguments: tc.function.arguments }
      });
    }
    return { text: full, tool_calls };
  }

  /**
   * parseJsonOutput (Phase T) - 从 AI 输出里抽 JSON 并按 schema 校验
   * 抽取: 用 match 找第一个 { 到最后一个 }, 容错 markdown ```json 围栏
   * 校验: schema = { required: ['picks', ...], types: { picks: 'array', ...}, arrayItemTypes: { picks: 'object' } }
   * 返回: { ok, obj, errors } - errors 为人类可读错误列表
   */
  function parseJsonOutput(text, schema = {}) {
    const result = { ok: false, obj: null, errors: [], raw: text };
    if (!text || typeof text !== 'string') {
      result.errors.push('empty output');
      return result;
    }
    // 1. 抽 JSON (容错 markdown 围栏)
    let jsonText = null;
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence && fence[1]) {
      jsonText = fence[1].trim();
    } else {
      // 优先: 完整对象 {...}
      const objStart = text.indexOf('{');
      const objEnd = text.lastIndexOf('}');
      if (objStart >= 0 && objEnd > objStart) {
        jsonText = text.slice(objStart, objEnd + 1);
      } else if (objStart >= 0) {
        // 截断对象: 截到末尾让 JSON.parse 报错
        jsonText = text.slice(objStart);
      } else {
        // 否则找 [ 到 ]
        const arrStart = text.indexOf('[');
        const arrEnd = text.lastIndexOf(']');
        if (arrStart >= 0 && arrEnd > arrStart) jsonText = text.slice(arrStart, arrEnd + 1);
        else if (arrStart >= 0) jsonText = text.slice(arrStart);
      }
    }
    if (!jsonText) {
      result.errors.push('no JSON object found');
      return result;
    }
    // 2. parse
    let obj;
    try { obj = JSON.parse(jsonText); }
    catch (e) {
      result.errors.push('JSON parse error: ' + e.message);
      return result;
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
      result.errors.push('JSON root is not an object');
      return result;
    }
    result.obj = obj;
    // 3. schema 校验
    const required = Array.isArray(schema.required) ? schema.required : [];
    const types = schema.types || {};
    const arrayItemTypes = schema.arrayItemTypes || {};
    for (const key of required) {
      if (!(key in obj)) {
        result.errors.push(`missing required field: "${key}"`);
        continue;
      }
      const v = obj[key];
      const expectedType = types[key];
      if (expectedType === 'array' && !Array.isArray(v)) {
        result.errors.push(`"${key}" should be array, got ${typeof v}`);
      } else if (expectedType === 'string' && typeof v !== 'string') {
        result.errors.push(`"${key}" should be string, got ${typeof v}`);
      } else if (expectedType === 'number' && typeof v !== 'number') {
        result.errors.push(`"${key}" should be number, got ${typeof v}`);
      } else if (expectedType === 'object' && (typeof v !== 'object' || Array.isArray(v))) {
        result.errors.push(`"${key}" should be object, got ${Array.isArray(v) ? 'array' : typeof v}`);
      }
      // 数组内部类型 (轻校验)
      if (Array.isArray(v) && arrayItemTypes[key]) {
        const wantItemType = arrayItemTypes[key];
        const bad = v.findIndex(item => {
          if (wantItemType === 'object') return typeof item !== 'object' || Array.isArray(item);
          if (wantItemType === 'string') return typeof item !== 'string';
          return false;
        });
        if (bad >= 0) result.errors.push(`"${key}[${bad}]" should be ${wantItemType}, got ${typeof v[bad]}`);
      }
    }
    result.ok = result.errors.length === 0;
    return result;
  }

  /**
   * jsonCall (Phase T) - 流式 AI 调用 + 内置 JSON 抽取 + schema 校验
   * opts: 同 call(), 额外:
   *   - schema: { required: [...], types: {...}, arrayItemTypes: {...} }
   * 返回: { ok, obj, errors, text }
   */
  async function jsonCall(opts) {
    const schema = opts.schema || {};
    const text = await call(opts);
    const parsed = parseJsonOutput(text, schema);
    return { ...parsed, text };
  }

  /**
   * formatUserProfile (Phase W: 用户画像注入) - 统一把 Core.UserProfile 渲染成中文 prompt 段
   * 返回多行字符串, 调用方直接拼到 systemPrompt
   * 数据源: Core.UserProfile (7 字段 schema). 失败降级返 ""
   *
   * 用法 (screener.js / fund/ai-advisor.js):
   *   const seg = Core.AI.formatUserProfile();
   *   systemPrompt = base + '\n\n【用户画像】\n' + seg;
   */
  function formatUserProfile() {
    try {
      const UP = window.Core && window.Core.UserProfile;
      if (!UP || typeof UP.load !== 'function') return '';
      const p = UP.load();
      if (!p) return '';
      const lines = [];
      lines.push('- 风险偏好: ' + (UP.riskLabel ? UP.riskLabel(p.risk) : p.risk));
      lines.push('- 投资期限: ' + (UP.horizonLabel ? UP.horizonLabel(p.horizon) : p.horizon));
      lines.push('- 是否允许权益类: ' + (UP.allowEquityLabel
        ? UP.allowEquityLabel(p.allowEquity)
        : p.allowEquity));
      if (typeof p.targetReturn === 'number' && isFinite(p.targetReturn)) {
        lines.push('- 目标年化收益率: ' + p.targetReturn + '%');
      }
      if (typeof p.maxDrawdown === 'number' && isFinite(p.maxDrawdown)) {
        lines.push('- 可接受最大回撤: ' + p.maxDrawdown + '%');
      }
      if (p.preference && String(p.preference).trim()) {
        lines.push('- 个人偏好: ' + String(p.preference).trim());
      }
      if (p.blacklist && String(p.blacklist).trim()) {
        lines.push('- 行业/品种黑名单: ' + String(p.blacklist).trim());
      }
      return lines.join('\n');
    } catch (e) {
      console.warn('[AI] formatUserProfile 失败:', e);
      return '';
    }
  }

  window.Core = window.Core || {};
  window.Core.AI = {
    call,
    cachedCall,
    callWithTimeout,
    callThrough,
    callRaw,
    callRawWithTimeout,
    jsonCall,
    parseJsonOutput,
    testConnection,
    discoverLocalLLM,
    getConfig,
    getProviderConfig,
    resolveEndpoint,
    selfCheck,
    formatUserProfile,
    PROVIDERS
  };
})();
