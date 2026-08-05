/**
 * V13 阶段 4 — 飞书命令解析 (LLM 解析自然语言 → ToolRegistry 调用)
 *
 * 设计:
 *   - 输入: 飞书用户文本 + agentRegistry 工具清单
 *   - 输出: {tool, args, rationale} | {intent:'chat', reply} | {intent:'clarify', question}
 *   - LLM 走 dev-proxy (http://127.0.0.1:8089/api/llm/{provider}), 复用现有 LLM 配置
 *   - 不引入新 SDK: 用内置 http.request 调
 *
 * 不依赖:
 *   - @larksuiteoapi/node-sdk (不需要)
 *   - Core.AI.callLLM (renderer 端 IIFE, 主进程拿不到)
 */
'use strict';

const http = require('http');

const DEV_PROXY_LLM_URL = 'http://127.0.0.1:8089/api/llm';

/**
 * 从 agentRegistry 抽取可注册工具的元数据 (name + description + input_schema + risk)
 * 给 LLM 做工具发现
 */
function _listTools(agentRegistry) {
  if (!agentRegistry || typeof agentRegistry.list !== 'function') return [];
  return agentRegistry.list().map(t => ({
    name: t.name,
    description: t.description || '',
    risk: t.risk || 'R',
    input_schema: t.input_schema || { type: 'object', properties: {} }
  }));
}

/**
 * 拼 system prompt
 */
function _buildSystemPrompt(tools) {
  const toolBlock = tools.map(t => {
    const props = Object.entries(t.input_schema.properties || {}).map(([k, v]) => {
      return `    ${k}: ${v.type || 'string'} (${v.description || ''})`;
    }).join('\n');
    return `- ${t.name} [${t.risk}]\n  描述: ${t.description}\n  入参:\n${props}`;
  }).join('\n\n');
  return `你是 stock-master 的 AI 管家, 用户在飞书跟你说话.

可用工具 (按 R=只读自动执行 / W=写操作需用户二次确认):
${toolBlock || '(无)'}

用户发自然语言, 你必须严格按以下 JSON 输出 (不要有任何额外文字):

情形 A — 需要调工具:
{"tool": "<工具名>", "args": { ... }, "rationale": "<10 字内说明>"}

情形 B — 用户在闲聊 (无工具调用):
{"intent": "chat", "reply": "<你回的话>"}

情形 C — 信息不够需要追问:
{"intent": "clarify", "question": "<具体问什么>"}

注意:
- 调工具时 args 必须符合 input_schema 类型
- W 类工具 (写操作) 不要自己主动调, 先问用户确认 (用 clarify 情形)
- 单次只调一个工具, 不串调
`;
}

/**
 * 用 LLM 解析用户消息
 * @param {object} opts
 * @param {string} opts.text 飞书文本
 * @param {object} opts.agentRegistry 含 list() 方法
 * @param {object} opts.llmConfig { provider, apiKey, baseURL, model }
 * @returns {Promise<{tool?, args?, rationale?, intent?, reply?, question?, error?}>}
 */
function _normalizeArgs(args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return {};
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (k.startsWith('__')) continue;
    out[k] = v;
  }
  return out;
}

function _isConfirmPhrase(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === '确认' || t === '确定' || t === '好' || t === 'ok' || t === 'yes' || t === 'y' || t === '是';
}

function _isCancelPhrase(text) {
  const t = String(text || '').trim().toLowerCase();
  return t === '取消' || t === 'no' || t === '不' || t === 'cancel';
}

async function parseUserMessage(opts) {
  const { text, agentRegistry, llmConfig, pending, openId } = opts || {};
  const tools = _listTools(agentRegistry);
  const pendingTool = pending && openId && typeof pending.get === 'function' ? pending.get(openId) : null;

  if (pendingTool) {
    if (_isConfirmPhrase(text)) {
      return { tool: pendingTool.tool, args: pendingTool.args, rationale: pendingTool.rationale || '飞书确认', confirmReuse: true };
    }
    if (_isCancelPhrase(text)) {
      return { intent: 'cancelled', tool: pendingTool.tool, args: pendingTool.args };
    }
  }

  const system = _buildSystemPrompt(tools);
  const prompt = '用户: ' + text + '\n请输出 JSON:';

  try {
    const raw = await _callLLM({ system, prompt, llmConfig });
    // 解析 JSON (宽容: 提取 { ... } 段)
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return { intent: 'chat', reply: raw.slice(0, 500) };
    const obj = JSON.parse(m[0]);

    if (obj.intent === 'chat') return { intent: 'chat', reply: obj.reply || '' };
    if (obj.intent === 'clarify') return { intent: 'clarify', question: obj.question || '请补充信息' };
    if (obj.tool) {
      // 验证 tool 名是否真实存在
      const exists = tools.find(t => t.name === obj.tool);
      if (!exists) return { intent: 'clarify', question: '工具不存在: ' + obj.tool };
      // W 类工具不让 LLM 直接执行 (确认权交给用户)
      if (exists.risk === 'W') {
        return {
          intent: 'confirm',
          tool: exists.name,
          args: _normalizeArgs(obj.args),
          rationale: obj.rationale || '',
          question: '该操作(' + obj.tool + ')需要你二次确认 (风险 W), 是否继续? 如继续请回复 "确认"'
        };
      }
      return { tool: exists.name, args: _normalizeArgs(obj.args), rationale: obj.rationale || '' };
    }
    return { intent: 'chat', reply: raw.slice(0, 500) };
  } catch (e) {
    return { error: 'LLM 解析失败: ' + e.message };
  }
}

/**
 * 调 LLM (走 dev-proxy /api/llm/{provider})
 */
function _callLLM({ system, prompt, llmConfig }) {
  return new Promise((resolve, reject) => {
    const cfg = llmConfig || {};
    const provider = cfg.provider || 'deepseek';
    const apiKey = cfg.apiKey || '';
    const model = cfg.model || '';
    const body = JSON.stringify({
      model: model || 'deepseek-chat',
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        { role: 'user', content: prompt }
      ],
      max_tokens: 500,
      temperature: 0.2
    });
    // 走 dev-proxy 透传 LLM: 路径 /api/llm/{provider}/v1/chat/completions
    // API key 放在 Authorization header, dev-proxy 透传给上游
    const url = new URL('http://127.0.0.1:8089/api/llm/' + provider + '/v1/chat/completions');
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(apiKey ? { 'Authorization': 'Bearer ' + apiKey } : {})
      },
      timeout: 30 * 1000
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
        try {
          const r = JSON.parse(data);
          if (r.error) return reject(new Error(r.error));
          // OpenAI 格式: choices[0].message.content
          const content = r.choices?.[0]?.message?.content || r.content || r.text || '';
          resolve(content);
        } catch (e) { reject(new Error('JSON parse: ' + e.message)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.write(body);
    req.end();
  });
}

module.exports = { parseUserMessage, _listTools, _buildSystemPrompt, _isConfirmPhrase, _isCancelPhrase, _normalizeArgs };
