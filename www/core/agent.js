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

  async function _loadPolicy() {
    try {
      const saved = await Core.Storage.kvGet('agent_auth_policy');
      if (saved && typeof saved === 'object') _policy = Object.assign(_policy, saved);
      const once = await Core.Storage.kvGet('agent_once_allow');
      if (Array.isArray(once)) _onceAllow = new Set(once);
    } catch (_) { /* ignore */ }
  }

  async function _savePolicy() {
    try {
      await Core.Storage.kvSet('agent_auth_policy', _policy);
      await Core.Storage.kvSet('agent_once_allow', Array.from(_onceAllow));
    } catch (_) {}
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
    if (!window.electronAPI || !window.electronAPI.invokeAgent) {
      return _mkToolResult(toolUse.id, { ok: false, error: 'Electron IPC 桥未就绪 (浏览器模式不支持工具调用)' });
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
      messages.push(assistantMsg);
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

  /** 把 callRaw 响应标准化成 { role, text, tool_uses } */
  function _normalizeAssistant(resp) {
    if (!resp) return { role: 'assistant', text: '(LLM 返回空)' };
    const text = resp.text || '';
    const tool_uses = (resp.tool_calls || []).map(tc => ({
      id: tc.id,
      name: tc.function && tc.function.name,
      input: _safeParse(tc.function && tc.function.arguments)
    })).filter(tu => tu.name);
    return { role: 'assistant', text, tool_uses };
  }

  function _safeParse(s) {
    if (!s) return {};
    try { return JSON.parse(s); } catch (_) { return { _raw: s }; }
  }

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
    /** 测试钩子 (test_only): 暴露内部纯函数让 test/test_all.js 单测 */
    _test: { _normalizeAssistant, _mkToolResult, _safeParse },
    /** UI 钩子: 侧边栏注册 confirm 实现后覆盖此函数 */
    confirmUI: async function (tool, input) {
      // 默认 fallback: 全 deny, 强制 UI 层接管
      console.warn('[Agent] confirmUI 未实现, 默认拒绝', tool.name);
      return false;
    },
    init: async function () {
      await _loadPolicy();
      // 同步主进程工具注册表到 _toolsIndex
      if (window.electronAPI && window.electronAPI.listAgentTools) {
        try {
          const tools = await window.electronAPI.listAgentTools();
          for (const t of tools) {
            Core.Agent._toolsIndex.set(t.name, t);
          }
          console.log('[Agent] 已加载 ' + tools.length + ' 个工具');
        } catch (e) {
          console.warn('[Agent] 工具表同步失败:', e);
        }
      }
    }
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
    _test: Core.Agent._test,
    confirmUI: Core.Agent.confirmUI,
    init: Core.Agent.init
  };
})();