/**
 * AI Agent 工具调用循环 + 分级授权 — 渲染进程侧
 *
 * 架构:
 *   用户在侧边栏对话窗发消息
 *     → Core.Agent.chat([...messages], tools)
 *     → Core.AI.callWithTimeout(provider, {messages, tools}) 返回含 tool_use 的 assistant message
 *     → 对每个 tool_use 调 Core.Agent.confirmIfNeeded(tool) 决定是否弹窗
 *     → electronAPI.invokeAgent(name, args) 走 IPC 到主进程执行
 *     → 把 tool_result 追加到 messages 循环, 直到 LLM 返回纯文本或达到 MAX_TURNS
 *
 * 工具注册表 = 主进程 registry + 渲染进程 schema 表 (双源, 启动时通过 IPC 同步)。
 * 分级授权策略在 _resolveAuthPolicy 里, 单一可信源。
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;

  /** 用户授权偏好 (运行时可改, 持久化到 Dexie kv 'agent_auth_policy') */
  let _policy = {
    // 'auto'    : 弹窗询问一次后记住'总是允许'
    // 'ask'     : 每次都弹窗
    // 'deny'    : 拒绝该等级所有工具
    L: 'auto',
    M: 'auto',    // 顺手策略: M 第一次问, 之后记住总是允许
    H: 'ask'
  };

  /** 工具名级别的"曾经允许过"覆盖 (用户点了"总是允许"后记这里, 重启也保留) */
  let _onceAllow = new Set();

  /** AI 管家独立的 LLM 配置 (覆盖主 AI 配置). 任意字段为空 → fallback 主配置 */
  let _llmConfig = null; // { provider?: string, model?: string, baseURL?: string, apiKey?: string, localEndpoint?: {...} }

  async function _loadPolicy() {
    try {
      const saved = await Core.Storage.kvGet('agent_auth_policy');
      if (saved && typeof saved === 'object') _policy = Object.assign(_policy, saved);
      const once = await Core.Storage.kvGet('agent_once_allow');
      if (Array.isArray(once)) _onceAllow = new Set(once);
      const llm = await Core.Storage.kvGet('agent_llm_config');
      if (llm && typeof llm === 'object') _llmConfig = llm;
    } catch (_) { /* ignore */ }
  }

  async function _savePolicy() {
    try {
      await Core.Storage.kvSet('agent_auth_policy', _policy);
      await Core.Storage.kvSet('agent_once_allow', Array.from(_onceAllow));
    } catch (_) {}
  }

  /** 管家独立 LLM 配置读写 */
  function getLlmConfig() {
    return _llmConfig ? Object.assign({}, _llmConfig) : null;
  }

  async function setLlmConfig(cfg) {
    _llmConfig = cfg && typeof cfg === 'object' && Object.keys(cfg).length > 0 ? cfg : null;
    try {
      if (_llmConfig) {
        await Core.Storage.kvSet('agent_llm_config', _llmConfig);
      } else {
        await Core.Storage.kvDel('agent_llm_config');
      }
    } catch (_) {}
    return _llmConfig;
  }

  /**
   * 解析 AI 管家实际用的 LLM 配置: 独立配置覆盖主配置, 字段级合并
   * @returns { provider, model, baseURL, apiKey, local/localEndpoint, _isCustom }
   */
  function _resolveLlmConfig() {
    const mainCfg = (Core.AI && Core.AI.getConfig && Core.AI.getConfig()) || {};
    if (!_llmConfig) return mainCfg;
    const merged = Object.assign({}, mainCfg, _llmConfig);
    // local / localEndpoint 字段级合并 (避免主 baseURL/apiKey 残留)
    // Core.AI.getConfig 返回 local; 早期版本可能用 localEndpoint — 兼容两者
    const localKey = mainCfg.local ? 'local' : (mainCfg.localEndpoint ? 'localEndpoint' : 'local');
    if (_llmConfig[localKey] && mainCfg[localKey]) {
      merged[localKey] = Object.assign({}, mainCfg[localKey], _llmConfig[localKey]);
    } else if (_llmConfig[localKey]) {
      merged[localKey] = _llmConfig[localKey];
    }
    return merged;
  }

  function setPolicyLevel(risk, mode) {
    if (!['L', 'M', 'H'].includes(risk)) throw new Error('invalid risk');
    if (!['auto', 'ask', 'deny'].includes(mode)) throw new Error('invalid mode');
    _policy[risk] = mode;
    _savePolicy();
  }

  function getPolicy() { return Object.assign({}, _policy); }

  /**
   * 决定一次工具调用是否需要弹窗确认。
   * @returns {'allow' | 'deny' | 'confirm'}
   *
   * 决策逻辑:
   *   policy[risk] === 'deny'   → deny
   *   policy[risk] === 'ask'    → confirm
   *   policy[risk] === 'auto'   → 如果 _onceAllow 里有此工具 → allow
   *                                否则 → confirm (弹窗里给"总是允许"选项)
   *
   * 注意: 'allow' 和 'confirm' 都允许执行, 区别仅在 UI 是否弹窗。
   */
  function _resolveAuthPolicy(tool) {
    const mode = _policy[tool.risk] || 'ask';
    if (mode === 'deny') return 'deny';
    if (mode === 'ask') return 'confirm';
    // mode === 'auto'
    if (_onceAllow.has(tool.name)) return 'allow';
    return 'confirm'; // 第一次: 弹窗, 提供"总是允许"按钮
  }

  /** 用户在弹窗里点了"总是允许", 调这个永久记住 */
  function rememberAllow(toolName) {
    _onceAllow.add(toolName);
    _savePolicy();
  }

  function forgetAllow(toolName) {
    _onceAllow.delete(toolName);
    _savePolicy();
  }

  function listOnceAllow() { return Array.from(_onceAllow); }

  /** 单步: 执行一个 tool_use, 返回 tool_result 消息对象 */
  async function executeTool(toolUse, ctx) {
    const tool = Core.Agent._toolsIndex.get(toolUse.name);
    if (!tool) {
      return _mkToolResult(toolUse.id, { ok: false, error: '未知工具: ' + toolUse.name });
    }
    const verdict = _resolveAuthPolicy(tool);
    if (verdict === 'deny') {
      return _mkToolResult(toolUse.id, {
        ok: false, error: '该风险等级 ' + tool.risk + ' 工具已被用户禁用 (设置 → AI 授权)'
      });
    }
    if (verdict === 'confirm') {
      const ok = await Core.Agent.confirmUI(tool, toolUse.input);
      if (!ok) return _mkToolResult(toolUse.id, { ok: false, error: '用户拒绝执行' });
    }
    // 分发: renderer 工具 (Core.AgentTools 注册) 优先, 走 in-process 调用
    // 主进程工具 (Electron 文件/重启/健康) 走 IPC
    if (Core.AgentTools && Core.AgentTools.get && Core.AgentTools.get(toolUse.name)) {
      const out = await Core.AgentTools.invoke(toolUse.name, toolUse.input, ctx || {});
      return _mkToolResult(toolUse.id, out);
    }
    if (!window.electronAPI || !window.electronAPI.invokeAgent) {
      return _mkToolResult(toolUse.id, { ok: false, error: 'Electron IPC 桥未就绪 (浏览器模式不支持该工具)' });
    }
    // 把当前 Core.State.ai 配置透传给主进程, 主进程用它探测 LLM endpoint 而非写死 11434
    let aiCtx = {};
    try {
      const cfg = (Core.AI && Core.AI.getConfig && Core.AI.getConfig()) || {};
      aiCtx.__llmBaseUrl = cfg.baseURL || (cfg.localEndpoint && cfg.localEndpoint.baseURL) || '';
    } catch (_) { /* 浏览器模式 getConfig 可能失败, 不阻塞 */ }
    const out = await window.electronAPI.invokeAgent(toolUse.name, Object.assign({}, toolUse.input, aiCtx), ctx || {});
    return _mkToolResult(toolUse.id, out);
  }

  function _mkToolResult(toolUseId, payload) {
    return {
      role: 'tool',
      tool_call_id: toolUseId,
      content: JSON.stringify(payload)
    };
  }

  /**
   * 主循环: 把 LLM 的 tool_use 一路执行完, 直到它返回纯文本或 MAX_TURNS。
   *
   * @param {Array} messages - 对话历史 (会被原地追加)
   * @param {Object} opts - { provider, model, onTurn, onToolCall, onText }
   * @returns {string} 最后一次 assistant 的纯文本回复
   */
  async function chat(messages, opts) {
    const MAX_TURNS = opts.maxTurns || 8;
    let lastText = '';
    const tools = (opts.tools && opts.tools.length > 0)
      ? opts.tools.map(t => ({ type: 'function', function: t }))
      : undefined;
    for (let i = 0; i < MAX_TURNS; i++) {
      const resp = await Core.AI.callRawWithTimeout({
        provider: opts.provider,
        model: opts.model,
        messages,
        tools,
        tool_choice: tools ? 'auto' : undefined,
        temperature: opts.temperature,
        timeout: opts.timeout || 120000,
        stream: false
      });
      const assistantMsg = _normalizeAssistant(resp);
      // 推回 messages 时必须用 OAI 字段 (content / tool_calls), 不能用内部表示 (text / tool_uses)
      // 否则 qwen36 等兼容 provider 在下一轮会拒绝:
      //   'Assistant message must contain either content or tool_calls'
      messages.push(_toOaiAssistant(assistantMsg));
      if (opts.onText && assistantMsg.text) {
        lastText = assistantMsg.text;
        opts.onText(assistantMsg.text);
      }
      const toolUses = assistantMsg.tool_uses || [];
      if (toolUses.length === 0) return lastText;
      if (opts.onToolCall) opts.onToolCall(toolUses);
      for (const tu of toolUses) {
        const resultMsg = await executeTool(tu, opts.ctx);
        messages.push(resultMsg);
        if (opts.onToolResult) {
          let parsed;
          try { parsed = JSON.parse(resultMsg.content); }
          catch (e) {
            console.warn('[Agent] tool_result JSON.parse 失败, 原样回传:', e.message);
            parsed = resultMsg.content;
          }
          opts.onToolResult(tu, parsed);
        }
      }
    }
    return lastText || '(已达到最大工具调用轮次)';
  }

  /** 把内部 assistant 表示 {role, text, tool_uses} 转成 OAI 协议消息 {role, content, tool_calls} */
  function _toOaiAssistant(internal) {
    const out = { role: 'assistant' };
    if (internal.tool_uses && internal.tool_uses.length > 0) {
      // OAI 协议: tool_calls 是数组, 每项 { id, type:'function', function:{ name, arguments } }
      out.tool_calls = internal.tool_uses.map(tu => ({
        id: tu.id,
        type: 'function',
        function: {
          name: tu.name,
          arguments: typeof tu.input === 'string' ? tu.input : JSON.stringify(tu.input || {})
        }
      }));
      // 工具调用轮 assistant 消息 content 通常为 null (qwen36 接受)
      out.content = internal.text && internal.text.length > 0 ? internal.text : null;
    } else {
      // 纯文本轮: content 是 text; 若 text 为空给个占位空格避免部分 provider 拒绝
      out.content = (internal.text && internal.text.length > 0) ? internal.text : ' ';
    }
    return out;
  }

  /** 把 callRaw 响应标准化成 { role, text, tool_uses } */
  function _normalizeAssistant(resp) {
    if (!resp) return { role: 'assistant', text: '(LLM 返回空)', tool_uses: [] };
    const text = resp.text || '';
    const tool_uses = (resp.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function && tc.function.name,
      input: _safeParse(tc.function && tc.function.arguments)
    })).filter(tu => tu.name);
    // OpenAI 协议要求 assistant 消息必须有 content 或 tool_calls 之一
    // text 空 + tool_calls 空 会让 provider 在下一轮拒绝 ('Assistant message must contain either content or tool_calls')
    const finalText = (text && text.length > 0) ? text : (tool_uses.length > 0 ? '' : ' ');
    return { role: 'assistant', text: finalText, tool_uses };
  }

  function _safeParse(s) {
    if (!s) return {};
    try { return JSON.parse(s); } catch (_) { return { _raw: s }; }
  }

  /** 默认 fallback: UI 未接管时全 deny */
  const confirmUI = async function (tool, input) {
    console.warn('[Agent] confirmUI 未实现, 默认拒绝', tool.name);
    return false;
  };

  /** 异步初始化: 加载授权偏好 + 同步主进程工具表 */
  const init = async function () {
    await _loadPolicy();
    // 1) 加载主进程工具 (Electron IPC 端 — 文件/重启/健康)
    if (window.electronAPI && window.electronAPI.listAgentTools) {
      try {
        const tools = await window.electronAPI.listAgentTools();
        for (const t of tools) {
          Core.Agent._toolsIndex.set(t.name, t);
        }
        console.log('[Agent] 已加载主进程 ' + tools.length + ' 个工具');
      } catch (e) {
        console.warn('[Agent] 工具表同步失败:', e);
      }
    }
    // 2) 加载 renderer 工具 (Core.AgentTools — UI 操作类: 页面切换/自选股/提醒/模拟盘等)
    if (Core.AgentTools && Core.AgentTools.list) {
      try {
        const rTools = Core.AgentTools.list();
        for (const t of rTools) {
          Core.Agent._toolsIndex.set(t.name, t);
        }
        console.log('[Agent] 已加载 renderer ' + rTools.length + ' 个工具');
      } catch (e) {
        console.warn('[Agent] renderer 工具表同步失败:', e);
      }
    }
  };

  const _testExports = { _normalizeAssistant, _toOaiAssistant, _mkToolResult, _safeParse, _resolveLlmConfig, _loadPolicy };

  Core.Agent = {
    chat,
    executeTool,
    setPolicyLevel,
    getPolicy,
    rememberAllow,
    forgetAllow,
    listOnceAllow,
    _resolveAuthPolicy,
    _toolsIndex: new Map(),
    /** 管家独立 LLM 配置: 留空 fallback 主配置, 字段级合并 */
    getLlmConfig,
    setLlmConfig,
    getEffectiveLlmConfig: _resolveLlmConfig,
    /** 测试钩子 (test_only): 暴露内部纯函数让 test/test_all.js 单测 */
    _test: _testExports,
    /** UI 钩子: 侧边栏注册 confirm 实现后覆盖此函数 */
    confirmUI,
    init
  };
  window.Core.Agent = {
    chat,
    executeTool,
    setPolicyLevel,
    getPolicy,
    rememberAllow,
    forgetAllow,
    listOnceAllow,
    _resolveAuthPolicy,
    _toolsIndex: Core.Agent._toolsIndex,
    getLlmConfig,
    setLlmConfig,
    getEffectiveLlmConfig: _resolveLlmConfig,
    _test: _testExports,
    confirmUI,
    init
  };
})();