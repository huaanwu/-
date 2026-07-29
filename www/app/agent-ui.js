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

    const cfg = (Core.AI && Core.AI.getConfig) ? Core.AI.getConfig() : null;
    if (!cfg) {
      _appendAssistant(root, '⚠️ AI 未配置。请先在设置页填 Provider / API Key / Model。');
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

    // 头部触发按钮
    const trigger = document.createElement('button');
    trigger.id = 'aiTriggerBtn';
    trigger.innerHTML = '🤖 AI';
    trigger.title = '打开 AI 管家';
    trigger.style.cssText = 'background:#1f6feb;color:#fff;border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;font-weight:600;margin-left:8px;';
    const header = document.querySelector('.app-header');
    if (header) header.appendChild(trigger);
    trigger.addEventListener('click', () => _toggle(true));

    // 关闭
    document.getElementById('aiBtnClose').addEventListener('click', () => _toggle(false));
    document.getElementById('aiBtnClear').addEventListener('click', () => {
      _clearSession();
      const stream = document.getElementById('aiStream');
      if (stream) stream.innerHTML = '';
    });
    document.getElementById('aiBtnPolicy').addEventListener('click', _showPolicyEditor);

    // 发送
    const input = document.getElementById('aiInput');
    document.getElementById('aiBtnSend').addEventListener('click', () => {
      const text = input.value;
      input.value = '';
      _send(text);
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        const text = input.value;
        input.value = '';
        _send(text);
      }
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

  Core.AgentUI = {
    init: function () {
      _loadSession();
      // 把 confirmUI 实现注入 Core.Agent (必须在 Core.Agent.init 之后调用)
      Core.Agent.confirmUI = confirmUI;
      inject();
      console.log('[AgentUI] 初始化完成, 历史消息 ' + _messages.length + ' 条');
    },
    send: _send,
    toggle: _toggle
  };
})();