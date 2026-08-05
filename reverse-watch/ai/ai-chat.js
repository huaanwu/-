// ============== ai-chat.js · AI 管家对话抽屉 ==============
// 挂在 F4.7 butlerPanel 末尾: 用户 → LLM 多轮对话, LLM 返回结构化
// {reply, adjustments[]} → 走 AIFeedback.previewAdjustment 渲染 diff 卡片
// → 用户点 ✓ 才 applyAdjustment, ✗ 跳过 (避免误改)

// ----- constants -----
const CHAT_HISTORY_KEY = '_rw_chat_history';
const CHAT_HISTORY_MAX = 20;

// ----- helpers -----
function loadHistory() {
  try { const raw = localStorage.getItem(CHAT_HISTORY_KEY); return raw ? JSON.parse(raw) : []; }
  catch (e) { console.warn('[ai-chat] loadHistory 解析失败:', e.message); return []; }
}
function saveHistory(list) {
  const trimmed = list.slice(-CHAT_HISTORY_MAX);
  try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(trimmed)); }
  catch (e) { console.warn('[ai-chat] 存历史失败:', e.message); }
}
function clearHistory() {
  try { localStorage.removeItem(CHAT_HISTORY_KEY); return true; }
  catch (e) { console.warn('[ai-chat] clearHistory 失败:', e.message); return false; }
}

// ----- JSON 解析 (复用 ai-adapter 已修的 markdown fallback) -----
function parseLLMJson(text) {
  const raw = String(text || '').trim();
  let parsed = null;
  // P2 豁免: 这两处 catch {} 是 JSON 探测的预期失败路径 (先试裸 JSON 再试 ```围栏```)
  // 加 console.warn 会刷屏 (每次 chat 都触发), 不加
  try { parsed = JSON.parse(raw); } catch {}
  if (!parsed) {
    const m = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (m) { try { parsed = JSON.parse(m[1].trim()); } catch {} }
  }
  if (parsed && typeof parsed === 'object') return parsed;
  return null;
}

// ----- DOM 工具 -----
function el(tag, attrs, text) {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
      else if (k === 'class') e.className = v;
      else e.setAttribute(k, v);
    }
  }
  if (text != null) e.textContent = String(text);
  return e;
}

// ----- 学习闭环 共享上下文: 4 层注入 (反馈 / 偏好 / 规则 / 自调) -----
// 被 buildSystemPrompt / butlerReport / summarizeStock 三处复用
// 输入 options: {holding?, settings?, customPrompt?, holdingSummaryFn?}
// 返回 1 段统一字符串, 调用方决定拼到 systemPrompt 还是 user prompt
function buildLearningContext(opts = {}) {
  const rw = window.ReverseWatch || {};
  const holding = opts.holding || (rw.loadHolding ? rw.loadHolding() : {});
  const settings = opts.settings || (rw.SETTINGS || {});
  const customPrompt = opts.customPrompt != null ? opts.customPrompt : (rw.getCustomPrompt ? rw.getCustomPrompt() : '');
  // holdingSummaryFn: app.js 的 holdingRulesSummary(fbAware) — 从 ReverseWatch 取
  const summaryFn = opts.holdingSummaryFn || (rw.holdingRulesSummary || (() => ''));

  // ① 反馈: _rw_feedback down 名单 (走 loadActiveFeedback 应用 7d TTL, C1 修)
  const fbAll = (rw.loadActiveFeedback ? rw.loadActiveFeedback() : (rw.loadFeedback ? rw.loadFeedback() : {}));
  const downList = Object.entries(fbAll)
    .filter(([, v]) => v && v.verdict === 'down')
    .slice(0, 10)
    .map(([code, v]) => `${code} (${v.note || '无备注'})`)
    .join(', ') || '(无)';

  // ② 偏好: customPrompt (蒸馏后)
  // ③ 规则: holdingRulesSummary(fbAware) — 自动含拉严注记
  const rulesSummary = summaryFn(true);

  // ④ 自调: _rw_adjustments_log 最近 5 条
  const adjLog = (rw.AIFeedback && rw.AIFeedback.getHistory) ? rw.AIFeedback.getHistory(5) : [];
  const adjSummary = adjLog.map(a =>
    `${a.target}: ${JSON.stringify(a.oldValue)} → ${JSON.stringify(a.newValue)} (${a.reason || '无说明'})`
  ).join('; ') || '(无)';

  // ⑤ 基本面排雷 (RiskMine): 扫描 _rw_risk_cache, 列出已命中风险 + 排除候选数
  let riskSummary = '(RiskMine 未加载)';
  if (rw.RiskMine && rw.RiskMine.readCachedRisk) {
    try {
      const raw = localStorage.getItem('_rw_risk_cache');
      const cache = raw ? JSON.parse(raw) : {};
      const entries = Object.entries(cache);
      const now = Date.now();
      const TTL = 6 * 60 * 60 * 1000;
      const hits = entries.filter(([, v]) => v && (now - (v.ts || 0)) < TTL && Array.isArray(v.reasons) && v.reasons.length > 0);
      if (hits.length === 0) {
        riskSummary = '(无扫描命中)';
      } else {
        const detail = hits.slice(0, 10).map(([code, v]) => `${code} (${v.reasons.join('/')})`).join(', ');
        riskSummary = `命中 ${hits.length} 只: ${detail}${hits.length > 10 ? '…' : ''}`;
      }
    } catch (e) { console.warn('[ai-chat] 读 risk cache 失败:', e.message); riskSummary = '(读失败)'; }
  }

  return [
    '【学习闭环 (5 层) — 你必须参考, 避免重复建议用户已否定或已排雷的事】',
    `① 用户偏好: ${customPrompt || '(无)'}`,
    `② 用户已否定 (不要再推): ${downList}`,
    `③ 持仓规律 (fbAware, 含自动拉严): ${rulesSummary}`,
    `④ 最近调整记录 (避免重复建议): ${adjSummary}`,
    `⑤ 基本面排雷 (RiskMine): ${riskSummary} — 命中股不要作为推荐`,
    // ⑥ 自动调参 (AutoTuner): 让管家知道系统最近自动改了什么, 不要反向建议
    (() => {
      let tunerLine = '(AutoTuner 未加载)';
      try {
        if (rw.AutoTuner && typeof rw.AutoTuner.getLog === 'function' && typeof rw.AutoTuner.getPending === 'function') {
          const log = rw.AutoTuner.getLog(10);
          const pending = rw.AutoTuner.getPending();
          const tiny = log.filter(e => e && e.status === 'applied').slice(0, 5).map(e =>
            `${e.adjustment?.target} ${JSON.stringify(e.adjustment?.oldValue)}→${JSON.stringify(e.adjustment?.value)}`
          ).join(', ') || '(无)';
          const rolled = log.filter(e => e && e.status === 'rolledBack').length;
          tunerLine = `本周已自动调 ${log.filter(e => e.status === 'applied').length} 次 (${tiny}), 待批准 ${pending.length} 条, 已回滚 ${rolled} 次 — 不要重复建议已自动调过的字段`;
        }
      } catch (e) { console.warn('[ai-chat] 读 AutoTuner 失败:', e.message); }
      return `⑥ 自动调参概览: ${tunerLine}`;
    })()
  ].join('\n');
}

// ----- 构造 system prompt -----
// 学习闭环 4 层注入走共享 buildLearningContext()
function buildSystemPrompt(snapshot, currentConfig) {
  const settings = (currentConfig && currentConfig.settings) || {};
  const holding = (currentConfig && currentConfig.holding) || {};
  const customPrompt = (currentConfig && currentConfig.customPrompt) || '';
  const candidates = (snapshot && snapshot.candidates) || [];
  const candSummary = candidates.slice(0, 5).map(c =>
    `${c.code} ${c.name} (板块 ${c.sector}, PB 分位 ${c.pbPercentile}%, 板块中位 ${c.sectorPbMedian}%, 差 ${(c.sectorPbMedian - c.pbPercentile)}pp, 信心 ${c.confidence})`
  ).join('\n');
  const regime = snapshot && snapshot.regime;

  const learning = buildLearningContext({ holding, settings, customPrompt });

  // RiskMine 概览 (顶部提醒, 让管家区分"自动排雷"vs"用户偏好")
  const riskOverview = (() => {
    try {
      const rw2 = window.ReverseWatch || {};
      const RM = rw2.RiskMine;
      if (!RM || !RM.readCachedRisk) return '';
      const raw = localStorage.getItem('_rw_risk_cache');
      if (!raw) return '';
      const cache = JSON.parse(raw);
      const now = Date.now();
      const TTL = 6 * 60 * 60 * 1000;
      const high = [];
      const medium = [];
      for (const [code, v] of Object.entries(cache)) {
        if (!v || (now - (v.ts || 0)) >= TTL) continue;
        if (!Array.isArray(v.reasons) || v.reasons.length === 0) continue;
        for (const r of v.reasons) {
          const sev = (RM.SEVERITY && RM.SEVERITY[r]) || '?';
          if (sev === 'high') high.push(`${code}(${r})`);
          else if (sev === 'medium') medium.push(`${code}(${r})`);
        }
      }
      if (high.length === 0 && medium.length === 0) return '';
      return `【RiskMine 概览】已自动排雷 ${high.length} 只 high / ${medium.length} 只 medium: high=[${high.slice(0, 5).join(', ')}${high.length > 5 ? '…' : ''}] medium=[${medium.slice(0, 3).join(', ')}${medium.length > 3 ? '…' : ''}] — 这些股已在候选池外, 不要重复建议加 pool.exclude`;
    } catch (e) { console.warn('[buildSystemPrompt] riskOverview 读失败:', e.message); return ''; }
  })();

  return `你是 A 股反向策略顾问, 帮用户调整选股与持仓标准。
风格: 中文, 简洁, 每条回复 ≤200 字, 鼓励用户拍板。

${riskOverview ? riskOverview + '\n\n' : ''}${learning}

当前大盘状态: ${regime ? `${regime.regime} (置信 ${regime.confidence})` : '未知'}
当前持仓规律: ${JSON.stringify(holding, null, 0)}
当前 4 闸阈值: ${JSON.stringify(settings.gates || {}, null, 0)}

今日候选:
${candSummary || '(暂无)'}

用户对你说: 你可以:
1) 普通回答问题 (用 reply 字段)
2) 建议调整标准 (用 adjustments[] 字段), 每条调整 schema: {target, value, reason}
   target 命名空间:
   - gates.sectorMin / gates.pbDeltaMin / gates.quantRejectPct / gates.excludeLeaders (数值)
   - holding.fishTailTrimPct / holding.shortStopLossPct / holding.monthlyMaxDrawdown (0-1 小数)
   - preference.customPrompt (字符串)
   - pool.exclude (字符串数组, 股票代码; 但 RiskMine 已自动排的股不要重复建议)

严格输出 JSON: {reply: string, adjustments?: [{target, value, reason}?]}
不要 markdown, 不要解释。`;
}

// ----- 学习闭环 ② 偏好蒸馏 -----
// 从用户消息里抽强偏好关键词, 自动追加到 _rw_custom_prompt
// 触发模式: "不要 X" / "拒绝 X" / "我想看 X" / "我不接 X"
const PREFERENCE_PATTERNS = [
  { regex: /(不要|不接|拒绝|不想)([^。,!?\n]{2,15})/g, kind: 'avoid', capture: 2 },
  { regex: /(我想看|我想找|偏好|倾向)([^。,!?\n]{2,15})/g, kind: 'favor', capture: 2 },
  { regex: /(永远|始终)(不要|不接)([^。,!?\n]{2,15})/g, kind: 'avoid_perm', capture: 3 }
];
function distillPreferences(userText) {
  if (!userText) return false;
  let appended = [];
  for (const p of PREFERENCE_PATTERNS) {
    let m;
    p.regex.lastIndex = 0;
    while ((m = p.regex.exec(userText)) !== null) {
      const kw = m[p.capture].trim();
      if (!kw) continue;
      const marker = p.kind.startsWith('avoid') ? '不接' : '偏好';
      appended.push(`${marker}${kw}`);
    }
  }
  if (appended.length === 0) return false;
  // 去重 (跟现有 customPrompt 比对)
  const rw = window.ReverseWatch || {};
  const cur = rw.getCustomPrompt ? rw.getCustomPrompt() : '';
  const curLines = cur.split(/[,\n;]+/).map(s => s.trim()).filter(Boolean);
  const fresh = appended.filter(a => !curLines.some(l => l === a));
  if (fresh.length === 0) return false;
  const merged = cur ? `${cur}; ${fresh.join('; ')}` : fresh.join('; ');
  if (rw.setCustomPrompt) rw.setCustomPrompt(merged);
  console.log('[ai-chat] 蒸馏偏好:', fresh);
  return true;
}

// ----- 渲染单条消息 -----
function renderMsg(msg) {
  const wrap = el('div', { class: 'ai-chat-msg ' + (msg.role || 'assistant') });
  wrap.textContent = msg.content;
  return wrap;
}

// ----- 渲染 adjustment diff 卡片 -----
// preview = {target, ns, field, oldValue, newValue, reason, summary, ok}
// 返回 DOM 节点, 用户点 ✓ 才调用 applyAdjustments
function renderAdjCard(preview, onApply, onSkip) {
  const card = el('div', { class: 'ai-chat-adj-card' });
  const title = el('div', {}, `🔧 建议调整: ${preview.summary}`);
  card.appendChild(title);
  if (preview.reason) {
    const r = el('div', { style: { color: 'var(--text-mute)', marginTop: '4px' } }, `理由: ${preview.reason}`);
    card.appendChild(r);
  }
  if (!preview.ok) {
    card.appendChild(el('div', { style: { color: 'var(--danger)', marginTop: '4px' } }, '⚠ 未知字段, 已忽略'));
    return card;
  }
  const btnRow = el('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' } });
  const okBtn = el('button', { class: 'btn-secondary' }, '✓ 应用');
  okBtn.onclick = () => {
    onApply();
    okBtn.disabled = true;
    okBtn.textContent = '✓ 已应用';
    skipBtn.disabled = true;
  };
  const skipBtn = el('button', { class: 'btn-secondary' }, '✗ 跳过');
  skipBtn.onclick = () => { onSkip(); card.remove(); };
  btnRow.appendChild(okBtn);
  btnRow.appendChild(skipBtn);
  card.appendChild(btnRow);
  return card;
}

// ----- 主入口: 渲染 chat 抽屉 -----
// container = butlerPanel div (已在 renderButlerPanel 里构造好 .butler-card)
// 重复调用不会重复挂 (检查 .ai-chat-drawer 是否已存在)
function renderChatPanel(container, snapshot, currentConfig) {
  if (!container) return;
  // 防重复挂载 (render() 多次调用时)
  let drawer = container.querySelector('.ai-chat-drawer');
  if (drawer) drawer.remove();
  drawer = el('details', { class: 'ai-chat-drawer' });
  const summary = el('summary', {}, '💬 跟 AI 管家聊聊 (调整选股标准)');
  drawer.appendChild(summary);

  const body = el('div', { class: 'ai-chat-body' });
  // 历史消息流
  const msgBox = el('div', { class: 'ai-chat-msgs' });
  const history = loadHistory();
  if (history.length === 0) {
    const empty = el('div', { class: 'ai-chat-empty', style: { color: 'var(--text-mute)', fontSize: '12px', padding: '8px' } },
      '👋 试着问我: "把鱼尾阈值收紧到 10%" 或 "PB 分位差要 ≥ 20"');
    msgBox.appendChild(empty);
  } else {
    history.forEach(h => msgBox.appendChild(renderMsg(h)));
  }
  body.appendChild(msgBox);

  // quick-action 按钮
  const quick = el('div', { class: 'ai-chat-quick' });
  [
    { label: '📉 收紧鱼尾 (10%)', prompt: '把鱼尾减半阈值收紧到 10%' },
    { label: '📈 放低 PB 门槛 (10pp)', prompt: '把 PB 分位差下限降到 10pp, 候选能多几只' },
    { label: '🚫 不接 ST 股', prompt: '我不想接 ST 股, 加到偏好里' },
    { label: '🎯 重看回踩 (只看 5 日线附近)', prompt: '我想看看哪些候选在 5 日线附近回踩' }
  ].forEach(q => {
    const b = el('button', { type: 'button' }, q.label);
    b.onclick = () => sendMsg(q.prompt, msgBox, currentConfig, snapshot);
    quick.appendChild(b);
  });
  body.appendChild(quick);

  // 输入框
  const form = el('form', { class: 'ai-chat-input' });
  const ta = el('textarea', { placeholder: '输入消息… (Enter 发送, Shift+Enter 换行)', rows: '2' });
  form.appendChild(ta);
  const sendBtn = el('button', { class: 'btn-primary', type: 'submit' }, '发送');
  form.appendChild(sendBtn);
  form.onsubmit = (e) => {
    e.preventDefault();
    const txt = ta.value.trim();
    if (!txt) return;
    sendMsg(txt, msgBox, currentConfig, snapshot);
    ta.value = '';
  };
  body.appendChild(form);

  // 清空按钮
  const clearBtn = el('button', { class: 'btn-secondary', style: { fontSize: '11px', marginTop: '6px' } }, '🗑 清空历史');
  clearBtn.onclick = () => {
    if (confirm('清空聊天历史?')) {
      clearHistory();
      while (msgBox.firstChild) msgBox.removeChild(msgBox.firstChild);
      toast('聊天历史已清空', 'ok');
    }
  };
  body.appendChild(clearBtn);

  drawer.appendChild(body);
  container.appendChild(drawer);
}

// ----- 发送一条消息 -----
async function sendMsg(text, msgBox, currentConfig, snapshot) {
  const rw = window.ReverseWatch || {};
  const AIAdapter = rw.AIAdapter;
  if (!AIAdapter || !AIAdapter.callLLM) {
    toast('AIAdapter 未加载', 'danger');
    return;
  }

  // 1. 渲染用户消息
  const userMsg = { role: 'user', content: text, ts: Date.now() };
  msgBox.appendChild(renderMsg(userMsg));

  // 1.5 学习闭环 ② 偏好蒸馏: 用户消息里抽强偏好, 自动追加到 customPrompt
  try {
    if (distillPreferences(text)) {
      const hint = el('div', { class: 'ai-chat-msg assistant', style: { fontSize: '11px', opacity: '0.7' } },
        '💡 已自动记录你的偏好到"LLM 偏好"');
      msgBox.appendChild(hint);
    }
  } catch (e) { console.warn('[ai-chat] 蒸馏失败:', e.message); }

  // 2. loading 占位
  const loading = el('div', { class: 'ai-chat-msg assistant' }, '⏳ LLM 思考中…');
  msgBox.appendChild(loading);
  msgBox.scrollTop = msgBox.scrollHeight;

  // 3. 拉历史 + 追加本轮 user
  const history = loadHistory();
  history.push(userMsg);

  try {
    const r = await AIAdapter.callLLM(text, {
      systemPrompt: buildSystemPrompt(snapshot, currentConfig),
      maxTokens: 600,
      timeoutMs: 25000
    });
    const parsed = parseLLMJson(r.text);
    const reply = parsed?.reply || r.text || '(空)';
    const adjustments = Array.isArray(parsed?.adjustments) ? parsed.adjustments : [];

    // 4. 替换 loading → assistant 消息
    loading.remove();
    const assistantMsg = { role: 'assistant', content: reply, adjustments, ts: Date.now() };
    msgBox.appendChild(renderMsg(assistantMsg));

    // 4.5 RiskMine 自动建议: 命中股 (high severity) 自动追加 pool.exclude 建议, 用户点 ✓ 才落
    const autoAdjs = [];
    try {
      const RM = rw.RiskMine;
      if (RM && RM.readCachedRisk && RM.readCachedStatus) {
        const raw = localStorage.getItem('_rw_risk_cache');
        if (raw) {
          const cache = JSON.parse(raw);
          const now = Date.now();
          const TTL = 6 * 60 * 60 * 1000;
          const existingExcludes = (() => {
            try { return JSON.parse(localStorage.getItem('_rw_pool_excludes') || '[]'); } catch (e) { console.warn('[ai-chat] existingExcludes 解析失败:', e.message); return []; }
          })();
          for (const [code, v] of Object.entries(cache)) {
            if (!v || (now - (v.ts || 0)) >= TTL) continue;
            if (v.status !== 'ok') continue; // failed/未确认 → 不建议排除 (避免给用户错信号)
            if (!Array.isArray(v.reasons) || v.reasons.length === 0) continue;
            const hasHigh = v.reasons.some(r => (RM.SEVERITY && RM.SEVERITY[r]) === 'high');
            if (!hasHigh) continue;
            if (existingExcludes.includes(code)) continue; // 已排除, 跳过
            const primary = v.reasons.find(r => (RM.SEVERITY && RM.SEVERITY[r]) === 'high') || v.reasons[0];
            autoAdjs.push({
              target: 'pool.exclude',
              value: [code],
              reason: `RiskMine 命中 ${primary} (high severity, 自动建议加进排除名单)`,
              _auto: true
            });
          }
        }
      }
    } catch (e) { console.warn('[ai-chat] 自动建议扫描失败:', e.message); }

    // 5. 渲染 adjustment diff 卡片 (LLM 建议 + 自动建议)
    const allAdjs = [...adjustments, ...autoAdjs];
    if (allAdjs.length > 0) {
      const AIFeedback = rw.AIFeedback;
      for (const a of allAdjs) {
        const prev = AIFeedback.previewAdjustment(a);
        const card = renderAdjCard(prev,
          () => {
            const results = AIFeedback.applyAdjustments([a]);
            const ok = results[0];
            toast(ok.ok ? `✅ 已应用: ${ok.message}` : `❌ ${ok.message}`, ok.ok ? 'ok' : 'danger');
          },
          () => { /* 跳过 */ }
        );
        // 自动建议加视觉标记
        if (a._auto) {
          card.style.borderLeft = '3px solid var(--accent)';
          const tag = el('div', { style: { color: 'var(--accent)', fontSize: '10px', marginTop: '2px' } }, '🤖 自动建议 (来自 RiskMine)');
          card.insertBefore(tag, card.firstChild.nextSibling);
        }
        msgBox.appendChild(card);
      }
      msgBox.scrollTop = msgBox.scrollHeight;
    }

    // 6. 存历史
    history.push(assistantMsg);
    saveHistory(history);

    msgBox.scrollTop = msgBox.scrollHeight;
  } catch (e) {
    loading.textContent = `❌ LLM 调用失败: ${e.message}`;
    console.warn('[ai-chat] LLM 调用失败:', e.message);
  }
}

// ----- 暴露 -----
window.ReverseWatch = window.ReverseWatch || {};
window.ReverseWatch.AIChat = {
  renderChatPanel,
  sendMsg,
  getHistory: loadHistory,
  clearHistory,
  // 学习闭环 ② 偏好: 暴露 distill 供测试 / 离线定时任务
  distillPreferences,
  // 学习闭环共享上下文: butler + detail + chat 都拼, 保证 4 层全覆盖
  buildLearningContext
};