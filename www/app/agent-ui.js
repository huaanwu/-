/**
 * AI 管家 - 常驻侧边栏对话窗 + 授权弹窗
 *
 * 渲染流程:
 *   1) 启动时在 #aiAssistantRoot 插入侧边栏 DOM
 *   2) 注入 Core.Agent.confirmUI = 我们的弹窗实现
 *   3) 注册"AI 管家"按钮 (在 Header 右上角)
 *   4) 用户发消息 → chat history → Core.Agent.chat() → 实时渲染 token 流
 *   5) 工具调用时显示气泡 (input + risk + 结果), 弹窗时阻塞主循环等用户点
 *
 * 风格: 沿用现有 app-nav 样式, 浅色单色 + emoji + risk badge
 */
(function () {
  'use strict';
  window.Core = window.Core || {};
  const Core = window.Core;
  const escapeHtml = s => (Core.Util && Core.Util.escapeHtml)
    ? Core.Util.escapeHtml(s)
    : String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** 对话历史 (持久到 sessionStorage) */
  let _messages = [];
  const SESSION_KEY = 'agent_chat_session';

  function _loadSession() {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) _messages = JSON.parse(raw);
    } catch (_) { _messages = []; }
  }
  function _saveSession() {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(_messages.slice(-50))); } catch (_) {}
  }
  function _clearSession() {
    _messages = [];
    try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
  }

  /** 当前活动的 pending 弹窗 (用于 confirm/deny) */
  let _pendingConfirm = null;

  /**
   * 授权弹窗实现 — 替换 Core.Agent 默认的 (默认 deny)
   * 返回 Promise<boolean>: true=同意(含"总是允许"), false=拒绝
   */
  async function confirmUI(tool, input) {
    const inputPreview = JSON.stringify(input, null, 2).slice(0, 600);
    const riskMap = { L: '🟢 自动', M: '🟡 谨慎', H: '🔴 高危' };
    const riskLabel = riskMap[tool.risk] || ('等级 ' + String(tool.risk || '?'));

    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop';
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:flex;align-items:center;justify-content:center;';
      const card = document.createElement('div');
      card.className = 'modal-card';
      card.style.cssText = 'background:var(--card,#1e2128);color:var(--fg,#e6edf3);padding:24px;border-radius:12px;max-width:520px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,.4);';

      // 用 DOM API 构造, 避免 innerHTML 拼 user-supplied 字符串
      const h3 = document.createElement('h3');
      h3.style.cssText = 'margin:0 0 12px;font-size:16px;';
      h3.textContent = 'AI 请求执行工具';
      card.appendChild(h3);

      const head = document.createElement('div');
      head.style.cssText = 'margin-bottom:12px;';
      const nm = document.createElement('div');
      nm.style.cssText = 'font-weight:600;';
      nm.textContent = tool.name;
      const badge = document.createElement('span');
      badge.style.cssText = 'font-size:12px;padding:2px 8px;border-radius:4px;background:#3b3f4a;margin-left:4px;';
      badge.textContent = riskLabel;
      nm.appendChild(badge);
      head.appendChild(nm);
      const desc = document.createElement('div');
      desc.style.cssText = 'font-size:13px;opacity:.8;margin-top:4px;';
      desc.textContent = tool.description || '';
      head.appendChild(desc);
      card.appendChild(head);

      const argBox = document.createElement('div');
      argBox.style.cssText = 'margin-bottom:12px;';
      const argLabel = document.createElement('div');
      argLabel.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:4px;';
      argLabel.textContent = '参数预览:';
      const pre = document.createElement('pre');
      pre.style.cssText = 'background:#0d1117;padding:10px;border-radius:6px;font-size:12px;max-height:200px;overflow:auto;white-space:pre-wrap;word-break:break-all;';
      pre.textContent = inputPreview;
      argBox.appendChild(argLabel);
      argBox.appendChild(pre);
      card.appendChild(argBox);

      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
      const defs = [
        { act: 'once-deny', text: '拒绝', bg: 'transparent', fg: 'inherit', border: '#555' },
        { act: 'always-deny', text: '总是拒绝', bg: 'transparent', fg: 'inherit', border: '#555' },
        { act: 'once-allow', text: '同意一次', bg: '#2da44e', fg: '#fff', border: 'none' },
        { act: 'always-allow', text: '总是允许', bg: '#1f6feb', fg: '#fff', border: 'none' }
      ];
      function cleanup(result) {
        document.body.removeChild(overlay);
        _pendingConfirm = null;
        resolve(result);
      }
      for (const d of defs) {
        const btn = document.createElement('button');
        btn.dataset.act = d.act;
        btn.textContent = d.text;
        btn.style.cssText = 'padding:8px 14px;border-radius:6px;border:' + d.border + ';background:' + d.bg + ';color:' + d.fg + ';cursor:pointer;';
        btn.addEventListener('click', () => {
          if (d.act === 'once-allow') cleanup(true);
          else if (d.act === 'once-deny') cleanup(false);
          else if (d.act === 'always-allow') { Core.Agent.rememberAllow(tool.name); cleanup(true); }
          else if (d.act === 'always-deny') { Core.Agent.setPolicyLevel(tool.risk, 'deny'); cleanup(false); }
        });
        btns.appendChild(btn);
      }
      card.appendChild(btns);

      overlay.appendChild(card);
      document.body.appendChild(overlay);
      _pendingConfirm = { overlay, tool, resolve: cleanup };
    });
  }

  /** 工具调用气泡 (在对话流中显示) */
  function _bubbleToolCall(toolUse) {
    const msg = document.createElement('div');
    msg.className = 'agent-bubble agent-bubble-tool';
    msg.style.cssText = 'background:#21262d;color:#8b949e;font-size:12px;padding:8px 12px;border-radius:8px;margin:4px 0;font-family:monospace;border-left:3px solid #58a6ff;';

    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;color:#58a6ff;';
    head.textContent = '🔧 工具调用: ' + toolUse.name;
    msg.appendChild(head);
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;word-break:break-all;font-size:11px;';
    pre.textContent = JSON.stringify(toolUse.input, null, 2).slice(0, 500);
    msg.appendChild(pre);
    return msg;
  }

  function _bubbleToolResult(toolUse, result) {
    const msg = document.createElement('div');
    msg.className = 'agent-bubble agent-bubble-result';
    const ok = result && result.ok;
    msg.style.cssText = 'background:#21262d;color:#8b949e;font-size:12px;padding:6px 12px;border-radius:8px;margin:2px 0 8px 24px;font-family:monospace;border-left:3px solid ' + (ok ? '#2da44e' : '#cf222e') + ';';
    const head = document.createElement('div');
    head.style.cssText = 'font-weight:600;color:' + (ok ? '#2da44e' : '#cf222e') + ';';
    head.textContent = (ok ? '✓ 结果' : '✗ 失败') + ': ' + toolUse.name;
    msg.appendChild(head);
    let body;
    if (ok) {
      const data = result.data;
      body = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    } else {
      body = result.error || '未知错误';
    }
    if (body.length > 800) body = body.slice(0, 800) + '...(已截断)';
    const pre = document.createElement('pre');
    pre.style.cssText = 'margin:4px 0 0;white-space:pre-wrap;word-break:break-all;font-size:11px;';
    pre.textContent = body;
    msg.appendChild(pre);
    return msg;
  }

  function _bubbleText(role, text) {
    const msg = document.createElement('div');
    const isUser = role === 'user';
    msg.className = 'agent-bubble agent-bubble-' + role;
    msg.style.cssText = [
      'padding:8px 12px;border-radius:10px;margin:6px 0;font-size:13px;line-height:1.5;max-width:90%;word-break:break-word;',
      isUser
        ? 'background:#1f6feb;color:#fff;margin-left:auto;text-align:left;'
        : 'background:#161b22;color:#c9d1d9;border:1px solid #30363d;'
    ].join('');
    msg.textContent = text;
    return msg;
  }

  function _bubbleThinking() {
    const el = document.createElement('div');
    el.className = 'agent-bubble agent-bubble-thinking';
    el.style.cssText = 'background:#161b22;color:#8b949e;border:1px solid #30363d;padding:8px 12px;border-radius:10px;margin:6px 0;font-size:13px;font-style:italic;';
    el.textContent = 'AI 思考中...';
    return el;
  }

  /** 渲染历史消息到对话流 */
  function _renderHistory(root) {
    root.innerHTML = '';
    for (const m of _messages) {
      if (m.role === 'user') root.appendChild(_bubbleText('user', m.content));
      else if (m.role === 'assistant' && m.text) root.appendChild(_bubbleText('assistant', m.text));
    }
  }

  /** 核心: 发送一条用户消息, 跑完整 chat 循环 */
  async function _send(text) {
    if (!text || !text.trim()) return;
    _messages.push({ role: 'user', content: text });
    _saveSession();
    const root = _ensureStreamRoot();

    const userBubble = _bubbleText('user', text);
    root.appendChild(userBubble);
    root.scrollTop = root.scrollHeight;

    const cfg = Core.Agent && typeof Core.Agent.getEffectiveLlmConfig === 'function'
      ? Core.Agent.getEffectiveLlmConfig()
      : ((Core.AI && Core.AI.getConfig) ? Core.AI.getConfig() : null);
    if (!cfg) {
      _appendAssistant(root, '⚠️ AI 未配置。请先在设置页填 Provider / API Key / Model。');
      _messages.push({ role: 'assistant', content: 'AI 未配置' });
      _saveSession();
      return;
    }
    if (!cfg.apiKey && cfg.provider !== 'custom' && !(cfg.local && cfg.local.enabled)) {
      _appendAssistant(root, '⚠️ AI 未配置 API Key。请先在 ⚙ 管家 → 🧠 模型 或主设置里填入。');
      _messages.push({ role: 'assistant', content: 'AI 未配置' });
      _saveSession();
      return;
    }

    const thinking = _bubbleThinking();
    root.appendChild(thinking);
    root.scrollTop = root.scrollHeight;

    const tools = Array.from(Core.Agent._toolsIndex.values()).map(t => ({
      name: t.name,
      description: t.description,
      parameters: { type: 'object', properties: {}, additionalProperties: true } // 简化, 让 LLM 自己看着办
    }));

    try {
      await Core.Agent.chat(_messages, {
        provider: cfg.provider,
        model: cfg.model || cfg.localEndpoint?.model,
        tools,
        maxTurns: 6,
        temperature: 0.7,
        onText: (delta) => {
          // 流式更新最后一条 assistant 气泡
          if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
          const last = root.querySelector('.agent-bubble-assistant.streaming');
          if (last) last.textContent += delta;
          else {
            const b = _bubbleText('assistant', delta);
            b.classList.add('streaming');
            root.appendChild(b);
          }
          root.scrollTop = root.scrollHeight;
        },
        onToolCall: (toolUses) => {
          if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
          for (const tu of toolUses) {
            root.appendChild(_bubbleToolCall(tu));
          }
          root.scrollTop = root.scrollHeight;
        },
        onToolResult: (toolUse, result) => {
          root.appendChild(_bubbleToolResult(toolUse, result));
          root.scrollTop = root.scrollHeight;
        },
        onTurn: () => {
          // 同上, 暂无特别操作
        }
      });
    } catch (e) {
      _appendAssistant(root, '✗ 调用失败: ' + (e.message || String(e)));
      _messages.push({ role: 'assistant', content: '[调用失败]' });
      _saveSession();
      return;
    }
    // 清理 streaming class
    root.querySelectorAll('.agent-bubble-assistant.streaming').forEach(el => el.classList.remove('streaming'));
    if (thinking.parentNode) thinking.parentNode.removeChild(thinking);
    _saveSession();
  }

  function _appendAssistant(root, text) {
    const b = _bubbleText('assistant', text);
    root.appendChild(b);
    root.scrollTop = root.scrollHeight;
  }

  let _streamRoot = null;
  function _ensureStreamRoot() {
    if (_streamRoot) return _streamRoot;
    _streamRoot = document.querySelector('#aiStream');
    return _streamRoot;
  }

  /** 注入侧边栏 DOM + 全局切换按钮 */
  function inject() {
    if (document.getElementById('aiAssistantRoot')) return;
    const root = document.createElement('div');
    root.id = 'aiAssistantRoot';
    root.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:380px;background:#0d1117;color:#c9d1d9;border-left:1px solid #30363d;display:none;flex-direction:column;z-index:9000;box-shadow:-4px 0 24px rgba(0,0,0,.4);font-family:-apple-system,BlinkMacSystemFont,sans-serif;';
    root.innerHTML = [
      '<div style="padding:14px 16px;border-bottom:1px solid #30363d;display:flex;align-items:center;justify-content:space-between;">',
      '  <div style="font-weight:600;font-size:15px;">🤖 AI 管家</div>',
      '  <div style="display:flex;gap:8px;">',
      '    <button id="aiBtnModel" title="为 AI 管家单独配置大模型 (留空则用主 AI 配置)" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">🧠 模型</button>',
      '    <button id="aiBtnPolicy" title="调整分级授权策略" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">⚙ 授权</button>',
      '    <button id="aiBtnClear" title="清空对话" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">🗑 清空</button>',
      '    <button id="aiBtnClose" title="关闭" style="background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:4px 10px;font-size:12px;cursor:pointer;">✕</button>',
      '  </div>',
      '</div>',
      '<div id="aiStream" style="flex:1;overflow-y:auto;padding:12px;"></div>',
      '<div style="padding:12px;border-top:1px solid #30363d;display:flex;gap:8px;">',
      '  <textarea id="aiInput" placeholder="问 AI 任何东西, 比如「跑一下长线 AI 选股」「读我的持仓 JSON」..." rows="2" style="flex:1;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:8px;font-size:13px;resize:none;font-family:inherit;"></textarea>',
      '  <button id="aiBtnSend" style="background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:8px 14px;font-size:13px;cursor:pointer;font-weight:600;">发送</button>',
      '</div>'
    ].join('');
    document.body.appendChild(root);

    // 头部触发按钮 — 优先挂到 .app-header, 找不到则挂到 body 右上角 (兜底防静默丢失)
    const trigger = document.createElement('button');
    trigger.id = 'aiTriggerBtn';
    trigger.innerHTML = '🤖 AI';
    trigger.title = '打开 AI 管家';
    const header = document.querySelector('.app-header');
    if (header) {
      trigger.style.cssText = 'background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-weight:600;margin-left:8px;';
      header.appendChild(trigger);
    } else {
      trigger.style.cssText = 'position:fixed;top:12px;right:80px;z-index:8500;background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,.3);';
      document.body.appendChild(trigger);
      console.warn('[AgentUI] .app-header 未找到, 触发按钮已挂到 body 右上角');
    }
    trigger.addEventListener('click', () => _toggle(true));

    // 关闭
    document.getElementById('aiBtnClose').addEventListener('click', () => _toggle(false));
    document.getElementById('aiBtnClear').addEventListener('click', () => {
      _clearSession();
      const stream = document.getElementById('aiStream');
      if (stream) stream.innerHTML = '';
    });
    document.getElementById('aiBtnPolicy').addEventListener('click', _showPolicyEditor);
    document.getElementById('aiBtnModel').addEventListener('click', _showLlmConfigEditor);

    // 发送
    const input = document.getElementById('aiInput');
    document.getElementById('aiBtnSend').addEventListener('click', () => {
      const text = input.value;
      input.value = '';
      _send(text);
    });
    // Enter 直接发送, Shift+Enter 换行; 中文 IME 合成时 (composition) 不发
    input.addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (e.shiftKey) return;                  // Shift+Enter 显式换行
      if (e.isComposing || e.keyCode === 229) return;   // 中文/日文输入法未确认
      e.preventDefault();
      const text = input.value;
      if (!text.trim()) return;
      input.value = '';
      _send(text);
    });
  }

  function _toggle(open) {
    const root = document.getElementById('aiAssistantRoot');
    if (!root) return;
    root.style.display = open ? 'flex' : 'none';
    if (open) _renderHistory(document.getElementById('aiStream'));
  }

  /** 授权策略面板 */
  function _showPolicyEditor() {
    const policy = Core.Agent.getPolicy();
    const onceList = Core.Agent.listOnceAllow();
    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--card,#1e2128);color:var(--fg,#e6edf3);padding:24px;border-radius:12px;max-width:480px;width:90%;';

    const h3 = document.createElement('h3');
    h3.style.cssText = 'margin:0 0 16px;font-size:16px;';
    h3.textContent = 'AI 管家 - 分级授权';
    card.appendChild(h3);

    const levels = [
      { k: 'L', label: '🟢 低风险 (读/查询)', hint: '默认: 自动(可改)' },
      { k: 'M', label: '🟡 中风险 (应用生命周期)', hint: '默认: 第一次问, 后记住' },
      { k: 'H', label: '🔴 高风险 (写文件/不可逆)', hint: '默认: 每次问' }
    ];
    const modes = [
      { k: 'auto', label: '自动执行 (M 第一次问后记住)' },
      { k: 'ask', label: '每次弹窗询问' },
      { k: 'deny', label: '禁用该等级' }
    ];
    for (const lv of levels) {
      const row = document.createElement('div');
      row.style.cssText = 'margin-bottom:14px;padding:12px;background:#161b22;border-radius:6px;';
      const ttl = document.createElement('div');
      ttl.style.cssText = 'font-weight:600;margin-bottom:6px;';
      ttl.textContent = lv.label;
      row.appendChild(ttl);
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;';
      for (const m of modes) {
        const cur = policy[lv.k] === m.k;
        const b = document.createElement('button');
        b.style.cssText = 'flex:1;padding:6px;border-radius:4px;border:1px solid ' + (cur ? '#1f6feb' : '#30363d') + ';background:' + (cur ? '#1f6feb' : 'transparent') + ';color:inherit;cursor:pointer;font-size:12px;';
        b.textContent = m.label;
        b.addEventListener('click', () => {
          Core.Agent.setPolicyLevel(lv.k, m.k);
          modal.remove();
          _showPolicyEditor();
        });
        btns.appendChild(b);
      }
      row.appendChild(btns);
      card.appendChild(row);
    }
    if (onceList.length > 0) {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'margin-top:14px;padding-top:14px;border-top:1px solid #30363d;';
      const ttl = document.createElement('div');
      ttl.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:6px;';
      ttl.textContent = '已记住"总是允许":';
      wrap.appendChild(ttl);
      const list = document.createElement('div');
      list.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;';
      for (const name of onceList) {
        const b = document.createElement('button');
        b.style.cssText = 'background:#21262d;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;padding:4px 8px;font-size:12px;cursor:pointer;';
        b.textContent = name + ' ✕'; // 工具名经 agent-registry register() 白名单限定, 安全
        b.addEventListener('click', () => {
          Core.Agent.forgetAllow(name);
          modal.remove();
          _showPolicyEditor();
        });
        list.appendChild(b);
      }
      wrap.appendChild(list);
      card.appendChild(wrap);
    }
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:16px;text-align:right;';
    const closeBtn = document.createElement('button');
    closeBtn.style.cssText = 'padding:8px 16px;border-radius:6px;border:none;background:#1f6feb;color:#fff;cursor:pointer;';
    closeBtn.textContent = '完成';
    closeBtn.addEventListener('click', () => modal.remove());
    actions.appendChild(closeBtn);
    card.appendChild(actions);

    modal.appendChild(card);
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
  }

  /**
   * 🧠 AI 管家独立 LLM 配置编辑器
   *
   * 数据源: Core.Agent.getLlmConfig() / setLlmConfig(cfg)
   * 留空 = fallback 主 AI 配置 (Core.AI.getConfig())
   * 字段级合并: 独立配置的非空字段覆盖主配置, 未填字段保持主配置
   */
  function _showLlmConfigEditor() {
    const mainCfg = (Core.AI && Core.AI.getConfig) ? Core.AI.getConfig() : {};
    const agentCfg = (Core.Agent && Core.Agent.getLlmConfig) ? (Core.Agent.getLlmConfig() || {}) : {};
    const Providers = (Core.AI && Core.AI.PROVIDERS) ? Core.AI.PROVIDERS : {};
    const providerKeys = Object.keys(Providers);

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:99998;display:flex;align-items:center;justify-content:center;';
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--card,#1e2128);color:var(--fg,#e6edf3);padding:24px;border-radius:12px;max-width:520px;width:90%;max-height:85vh;overflow-y:auto;';

    const h3 = document.createElement('h3');
    h3.style.cssText = 'margin:0 0 6px;font-size:16px;';
    h3.textContent = '🧠 AI 管家 - 独立大模型';
    card.appendChild(h3);

    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;opacity:.7;margin-bottom:14px;line-height:1.5;';
    hint.textContent = '选 Provider + 填 Key 即可, baseURL/模型会按 Provider 默认填上, 留空 = 沿用主 AI 配置.';
    card.appendChild(hint);

    // 主配置当前状态
    const cur = document.createElement('div');
    cur.style.cssText = 'font-size:12px;padding:8px 10px;background:#161b22;border-radius:6px;margin-bottom:14px;line-height:1.6;';
    cur.textContent = '主配置当前: ' + (mainCfg.provider || '(无)') + ' / ' + (mainCfg.model || '(无)');
    card.appendChild(cur);

    // 现有独立配置 → 推断初始 provider (兼容老版本 kv 仅有 baseURL/apiKey/model 没 provider 字段的情况)
    let initialProvider = agentCfg.provider;
    if (!initialProvider) {
      // 兜底: baseURL 形如包含 deepseek/openai/moonshot/dashscope/bigmodel/minimax → 推断
      const u = (agentCfg.baseURL || '').toLowerCase();
      if (u.includes('deepseek')) initialProvider = 'deepseek';
      else if (u.includes('moonshot')) initialProvider = 'moonshot';
      else if (u.includes('dashscope')) initialProvider = 'qwen';
      else if (u.includes('bigmodel')) initialProvider = 'zhipu';
      else if (u.includes('openai.com')) initialProvider = 'openai';
      else if (u.includes('minimax')) initialProvider = 'minimax';
      else if (u) initialProvider = 'custom';
      else if (mainCfg.provider) initialProvider = mainCfg.provider;
    }
    if (!Providers[initialProvider]) initialProvider = providerKeys[0] || 'deepseek';
    const curPcfg = Providers[initialProvider] || {};

    // ---- Provider 下拉 ----
    const provRow = document.createElement('div');
    provRow.style.cssText = 'margin-bottom:12px;';
    const provLbl = document.createElement('div');
    provLbl.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:4px;';
    provLbl.textContent = 'Provider';
    provRow.appendChild(provLbl);
    const provSel = document.createElement('select');
    provSel.style.cssText = 'width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;box-sizing:border-box;';
    for (const k of providerKeys) {
      const opt = document.createElement('option');
      opt.value = k;
      opt.textContent = Providers[k].name || k;
      if (k === initialProvider) opt.selected = true;
      provSel.appendChild(opt);
    }
    provRow.appendChild(provSel);
    card.appendChild(provRow);

    // ---- API Key ----
    const keyRow = document.createElement('div');
    keyRow.style.cssText = 'margin-bottom:12px;';
    const keyLbl = document.createElement('div');
    keyLbl.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:4px;';
    keyLbl.textContent = 'API Key';
    keyRow.appendChild(keyLbl);
    const keyInp = document.createElement('input');
    keyInp.type = 'password';
    keyInp.placeholder = agentCfg.apiKey ? '••••(已设置, 不改留空)' : (mainCfg.apiKey ? '主配置已设, 不改留空' : '填入 Provider 的 API Key');
    keyInp.value = '';
    keyInp.style.cssText = 'width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;box-sizing:border-box;';
    keyRow.appendChild(keyInp);
    // Key 状态行
    const keyHint = document.createElement('div');
    keyHint.style.cssText = 'font-size:11px;opacity:.6;margin-top:3px;';
    keyHint.textContent = agentCfg.apiKey
      ? '✓ 已保存 (显示留空, 填新值覆盖, 不填 = 保留旧)'
      : (mainCfg.apiKey ? '主配置已有 key, 留空沿用' : '必填 (除非走主配置)');
    keyRow.appendChild(keyHint);
    card.appendChild(keyRow);

    // ---- 模型 (下拉 + 自由输入) ----
    const modelRow = document.createElement('div');
    modelRow.style.cssText = 'margin-bottom:12px;';
    const modelLbl = document.createElement('div');
    modelLbl.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:4px;';
    modelLbl.textContent = '模型';
    modelRow.appendChild(modelLbl);
    const modelWrap = document.createElement('div');
    modelWrap.style.cssText = 'display:flex;gap:6px;';
    const modelSel = document.createElement('select');
    modelSel.style.cssText = 'flex:0 0 auto;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;';
    const modelInp = document.createElement('input');
    modelInp.type = 'text';
    modelInp.placeholder = curPcfg.defaultModel || '默认模型';
    modelInp.style.cssText = 'flex:1;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;box-sizing:border-box;';
    modelWrap.appendChild(modelSel);
    modelWrap.appendChild(modelInp);
    modelRow.appendChild(modelWrap);
    card.appendChild(modelRow);

    // ---- baseURL (仅 custom 显示, 其他 Provider 隐藏) ----
    const urlRow = document.createElement('div');
    urlRow.style.cssText = 'margin-bottom:12px;display:none;';
    const urlLbl = document.createElement('div');
    urlLbl.style.cssText = 'font-size:12px;font-weight:600;margin-bottom:4px;';
    urlLbl.textContent = 'Base URL (custom 必填)';
    urlRow.appendChild(urlLbl);
    const urlInp = document.createElement('input');
    urlInp.type = 'text';
    urlInp.placeholder = 'https://your-openai-compatible/v1';
    urlInp.style.cssText = 'width:100%;background:#0d1117;color:#e6edf3;border:1px solid #30363d;border-radius:4px;padding:6px 8px;font-size:13px;box-sizing:border-box;';
    urlRow.appendChild(urlInp);
    card.appendChild(urlRow);

    // 当前模型的回填函数 (按 provider 切 + 现有 agentCfg.model 优先)
    function _refreshModelUI(provKey) {
      const pcfg = Providers[provKey] || {};
      const models = Array.isArray(pcfg.models) ? pcfg.models : [];
      modelSel.innerHTML = '';
      const placeholderOpt = document.createElement('option');
      placeholderOpt.value = '__custom__';
      placeholderOpt.textContent = (models.length === 0 ? '(填模型名)' : '自定义...');
      modelSel.appendChild(placeholderOpt);
      for (const m of models) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSel.appendChild(opt);
      }
      // 决定 input 显示什么: agentCfg.model > 选下拉首项 > Provider 默认
      const targetModel = (initialProvider === provKey && agentCfg.model) ? agentCfg.model
        : (models[0] || pcfg.defaultModel || '');
      const exact = models.includes(targetModel);
      if (exact) {
        modelSel.value = targetModel;
        modelInp.value = '';
      } else {
        modelSel.value = '__custom__';
        modelInp.value = targetModel || '';
      }
      // custom 时显示 baseURL, 否则隐藏
      urlRow.style.display = (provKey === 'custom') ? 'block' : 'none';
      urlInp.value = (provKey === 'custom' && initialProvider === 'custom') ? (agentCfg.baseURL || '') : (pcfg.baseURL || '');
      // baseURL placeholder 跟着 provider 走
      if (provKey === 'custom') {
        urlInp.placeholder = pcfg.baseURL ? '(默认: ' + pcfg.baseURL + ')' : 'https://your-openai-compatible/v1';
      }
    }
    _refreshModelUI(initialProvider);
    provSel.addEventListener('change', () => _refreshModelUI(provSel.value));
    modelSel.addEventListener('change', () => {
      if (modelSel.value !== '__custom__') modelInp.value = '';
    });

    // ---- 操作按钮 ----
    const actions = document.createElement('div');
    actions.style.cssText = 'margin-top:18px;display:flex;gap:8px;justify-content:space-between;';
    const left = document.createElement('div');
    left.style.cssText = 'display:flex;gap:8px;';
    const resetBtn = document.createElement('button');
    resetBtn.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;cursor:pointer;font-size:12px;';
    resetBtn.textContent = '清空 (回到主配置)';
    resetBtn.addEventListener('click', async () => {
      if (Core.Agent && Core.Agent.setLlmConfig) {
        await Core.Agent.setLlmConfig(null);
        _appendAssistant(_ensureStreamRoot(), '✓ AI 管家已切回主 AI 配置');
        modal.remove();
      }
    });
    left.appendChild(resetBtn);
    actions.appendChild(left);

    const right = document.createElement('div');
    right.style.cssText = 'display:flex;gap:8px;';
    const cancelBtn = document.createElement('button');
    cancelBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid #555;background:transparent;color:inherit;cursor:pointer;';
    cancelBtn.textContent = '取消';
    cancelBtn.addEventListener('click', () => modal.remove());
    const saveBtn = document.createElement('button');
    saveBtn.style.cssText = 'padding:6px 14px;border-radius:6px;border:none;background:#1f6feb;color:#fff;cursor:pointer;font-weight:600;';
    saveBtn.textContent = '保存';
    saveBtn.addEventListener('click', async () => {
      const newCfg = {};
      const prov = provSel.value;
      if (prov && prov !== mainCfg.provider) newCfg.provider = prov;
      const key = keyInp.value.trim();
      if (key) newCfg.apiKey = key;
      const finalModel = (modelSel.value === '__custom__') ? modelInp.value.trim() : modelSel.value;
      if (finalModel && finalModel !== mainCfg.model) newCfg.model = finalModel;
      if (prov === 'custom') {
        const url = urlInp.value.trim();
        if (url) newCfg.baseURL = url;
      }
      try {
        if (Core.Agent && Core.Agent.setLlmConfig) {
          await Core.Agent.setLlmConfig(Object.keys(newCfg).length > 0 ? newCfg : null);
          const keys = Object.keys(newCfg);
          _appendAssistant(_ensureStreamRoot(),
            '✓ AI 管家模型已保存' + (keys.length > 0 ? ' (覆盖 ' + keys.join('/') + ')' : ' (走主配置)'));
        }
        modal.remove();
      } catch (e) {
        console.warn('[AgentUI] setLlmConfig 失败:', e);
        alert('保存失败: ' + e.message);
      }
    });
    right.appendChild(cancelBtn);
    right.appendChild(saveBtn);
    actions.appendChild(right);
    card.appendChild(actions);

    modal.appendChild(card);
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.remove();
    });
    document.body.appendChild(modal);
    provSel.focus();
  }

  Core.AgentUI = {
    init: function () {
      _loadSession();
      // confirmUI 注入必须 try/catch — 若 Core.Agent 未就绪 / DOM 异常, 不阻塞后续 inject()
      try {
        if (window.Core && Core.Agent && typeof confirmUI === 'function') {
          Core.Agent.confirmUI = confirmUI;
        } else {
          console.warn('[AgentUI] Core.Agent 未就绪, confirmUI 注入跳过 (executeTool 时 confirm 弹窗会回到默认 deny)');
        }
      } catch (e) {
        console.warn('[AgentUI] confirmUI 注入失败:', e.message);
      }
      try {
        inject();
        console.log('[AgentUI] 初始化完成, 历史消息 ' + _messages.length + ' 条');
      } catch (e) {
        console.error('[AgentUI] inject() 失败:', e);
      }
    },
    send: _send,
    toggle: _toggle
  };
})();