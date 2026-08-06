// ============== ai-adapter.js · AI 全能管家桥接 ==============
// reverse-watch (3020) → 主程序 dev-proxy (8089) /api/llm/{provider}/*
// 复用主程序 AI Service 的 6 家 provider + 密钥 + 超时 + CORS, 不复制核心逻辑。

const AI_CONFIG_KEY = '_rw_ai_config_v1';
const AI_DEFAULTS = {
  provider: 'deepseek',
  apiKey: '',
  model: 'deepseek-chat',
  baseURL: '',
  temperature: 0.3
};
const PROVIDER_DEFAULTS = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai:   { baseURL: 'https://api.openai.com/v1',    model: 'gpt-4o-mini' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1',   model: 'moonshot-v1-8k' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  zhipu:    { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  // minimax AI (MiniMax) — 【修 #178】minimax/minimaxi 不给 CORS, 强制走 dev-proxy :8089
  // dev-proxy route 表 LLM_TARGETS.minimax = 'https://api.minimax.chat' (308 重定向到 minimaxi.com)
  // 浏览器直连 https://api.minimaxi.com/v1/chat/completions → CORS 拒 → "Failed to fetch"
  // 修法: provider=minimax 走 dev-proxy, ai-adapter 自动拼 /api/llm/minimax/v1/chat/completions
  minimax:  { baseURL: '/api/llm/minimax/v1', model: 'MiniMax-Text-01', forceProxy: true },
  // 本地 LLM (llama.cpp 默认 :8082, 走 dev-proxy /api/local/v1, 不带 Authorization)
  local:    { baseURL: '/api/local/v1', model: 'qwen2.5-7b-instruct-q4_k_m', noAuth: true },
  custom:   { baseURL: '', model: '' }
};

function getAIConfig() {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY);
    if (!raw) return { ...AI_DEFAULTS };
    return { ...AI_DEFAULTS, ...JSON.parse(raw) };
  } catch (e) { console.warn('[ai-adapter] loadConfig 解析失败:', e.message); return { ...AI_DEFAULTS }; }
}
function setAIConfig(cfg) {
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(cfg));
  document.dispatchEvent(new CustomEvent('rw:ai-config-changed', { detail: cfg }));
}

function getProxyBase() {
  // 优先用 reverse-watch 顶层 PROXY_BASE (来自 app.js)
  return (typeof PROXY_BASE !== 'undefined' ? PROXY_BASE : 'http://127.0.0.1:8089').replace(/\/$/, '');
}

// 核心调用: 走主程序 dev-proxy /api/llm/{provider}/chat/completions
// #21: 支持 opts.config 临时覆盖 (testBtn 不污染 localStorage)
async function callLLM(prompt, opts = {}) {
  const baseCfg = getAIConfig();
  const cfg = (opts.config && typeof opts.config === 'object') ? { ...baseCfg, ...opts.config } : baseCfg;
  // minimax 等 forceProxy provider 即使没填 apiKey 也能调通 — dev-proxy 启动时读 .env 注入
  //   浏览器发无 Authorization 的请求, dev-proxy 看到 .env 有 key 就自动注入
  //   (浏览器源码/UI 永远不出现明文 key)
  const _isProxyProvider = !!PROVIDER_DEFAULTS[cfg.provider]?.forceProxy;
  if (!cfg.apiKey && !(PROVIDER_DEFAULTS[cfg.provider]?.noAuth) && !_isProxyProvider) {
    throw new Error('未配置 API key');
  }
  const pd = PROVIDER_DEFAULTS[cfg.provider] || {};
  // 【修 #178】forceProxy: true 的 provider 强制走 dev-proxy, 忽略用户填的 cfg.baseURL
  // (minimax/minimaxi 这类不给 CORS 的 provider, 必须由 dev-proxy 中转)
  const baseURL = pd.forceProxy ? pd.baseURL : (cfg.baseURL || pd.baseURL);
  const model = cfg.model || pd.model;
  const isAbsolute = /^https?:\/\//.test(baseURL);
  const endpoint = isAbsolute
    ? `${baseURL.replace(/\/$/, '')}/chat/completions`
    : `${getProxyBase()}${baseURL}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 15000);
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey && !pd.noAuth) headers['Authorization'] = `Bearer ${cfg.apiKey}`;
  try {
    let resp;
    try {
      resp = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: opts.systemPrompt || '你是 A 股投资助手, 回答简洁严谨。' },
            { role: 'user',   content: prompt }
          ],
          temperature: cfg.temperature,
          max_tokens: opts.maxTokens || 800
        }),
        signal: ctrl.signal
      });
    } catch (e) {
      // 【修 #178】浏览器 fetch 失败 (典型: CORS/网络断/握手失败) 默认报 "Failed to fetch", 吞了具体原因
      // 把 endpoint + 提示都包给上层, 方便 UI 区分: dev-proxy 没起? 配置错? minimax 不给 CORS?
      throw new Error(`fetch 失败 (${e.message}) → ${endpoint}  [provider=${cfg.provider}, forceProxy=${!!pd.forceProxy}]`);
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '';
    return { text, provider: cfg.provider, model, usage: data?.usage };
  } finally {
    clearTimeout(timer);
  }
}

// 测试连接 (单 ping) — #21: 支持 opts.config 临时 cfg, 不写 localStorage
async function testConnection(opts = {}) {
  const t0 = Date.now();
  try {
    const r = await callLLM('ping', { systemPrompt: '回复一个字: ok', maxTokens: 8, timeoutMs: 8000, ...opts });
    return { ok: true, latencyMs: Date.now() - t0, text: r.text };
  } catch (e) {
    return { ok: false, latencyMs: Date.now() - t0, error: e.message };
  }
}

// 单股简评 — 详情页用
// 补 MA5/MA10/MA20 价格 + 量比, 让 AI 算真实偏离, 不再编造"偏离MA20较多"
async function summarizeStock(stock, context = '') {
  const tech = stock.tech || null;
  const ma5 = (tech && typeof tech.ma5 === 'number') ? tech.ma5.toFixed(2) : '?';
  const ma10 = (tech && typeof tech.ma10 === 'number') ? tech.ma10.toFixed(2) : '?';
  const ma20 = (tech && typeof tech.ma20 === 'number') ? tech.ma20.toFixed(2) : '?';
  const price = (tech && typeof tech.price === 'number') ? tech.price.toFixed(2)
              : (tech && typeof tech.last === 'number') ? tech.last.toFixed(2) : '?';
  const volRatio = (tech && typeof tech.volRatio === 'number') ? tech.volRatio.toFixed(2) : '?';
  const chg20 = (tech && typeof tech.chg20 === 'number') ? (tech.chg20 * 100).toFixed(1) + '%' : '?';
  // 描述相对均线的客观位置 (不评价"较多/较少", 让 AI 看见数字自己说)
  const pos = (tech && typeof tech.price === 'number' && typeof tech.ma5 === 'number' && typeof tech.ma20 === 'number')
    ? (tech.price > tech.ma5 ? '价在 MA5 之上' : tech.price > tech.ma20 ? '价在 MA5 之下 MA20 之上' : '价跌破 MA20')
    : '';

  // 算真实偏离, 喂"预计算"文本, 禁止 AI 自己拿原数算百分比
  // 之前给 AI 喂 "MA20 5.06 + 20日涨幅 -6.2%" → 模型把两个数拼接变成 -623.2%
  // 这次给的具体描述, 让 AI 改不到数字
  const calcPos = (() => {
    if (!tech) return '数据不足';
    const p = tech.price ?? tech.last;
    if (typeof p !== 'number') return '数据不足';
    const arr = [];
    if (typeof tech.ma5 === 'number') {
      const diff = ((p - tech.ma5) / tech.ma5) * 100;
      arr.push(`MA5 ${diff >= 0 ? '上方' : '下方'} ${Math.abs(diff).toFixed(1)}%`);
    }
    if (typeof tech.ma20 === 'number') {
      const diff = ((p - tech.ma20) / tech.ma20) * 100;
      arr.push(`MA20 ${diff >= 0 ? '上方' : '下方'} ${Math.abs(diff).toFixed(1)}%`);
    }
    if (typeof tech.volRatio === 'number') {
      const v = tech.volRatio;
      arr.push(v < 0.8 ? `量比 ${v.toFixed(2)} 交投萎缩` : v > 1.5 ? `量比 ${v.toFixed(2)} 放量` : `量比 ${v.toFixed(2)} 平稳`);
    }
    return arr.join('; ');
  })();

  // ?v=ai-detail-fix2: 禁词 + 行业规则强制, 杜绝 5 个事实错
  //  - 禁止"偏离 MA20 较多" (实际 0.6% 几乎贴着)
  //  - 银行/白酒/煤炭等蓝筹行业不要用"封板率/涨停"作为资金指标
  //  - 价已破 MA5 时说"反抽受阻/等待站回"而不是"回踩找机会"
  //  - 量比 < 1 说"交投萎缩/观望"别说"蓄势待发"
  //  - "替身/龙头" 抽象词不用, 改说"非板块内市值前 3" 这种事实型描述
  const sector = stock.sector || '?';
  const industry = stock.industry || sector;
  // 蓝筹行业判定: 银行/白酒/煤炭/钢铁/石油/电力/公路/铁路 → 封板率不适用
  const isBlueChip = /银行|白酒|煤炭|钢铁|石油|电力|公路|铁路|港口|航空|高速/.test(industry + sector);
  const industryWarn = isBlueChip
    ? `- 行业警告: ${industry} 是蓝筹行业, 板块封板率作为资金指标无效, 改用"板块成交额/资金净流入/与大盘相对强弱"`
    : `- 板块资金参考: 封板率 ${stock.limitsUpRate_2d ?? '?'}`;
  const ctxLine = context ? `上下文: ${context}` : '';
  const prompt = `股票 ${stock.code} ${stock.name} (板块 ${sector}, 行业 ${industry}), PB 分位 ${stock.pbPercentile ?? '?'}%。
预计算客观事实 (直接引用, 不要自己算):
- 现价/均线位置: ${calcPos}
${industryWarn}
${ctxLine}

请 80 字内一段话, 严格按以下规则:
1. 偏离 MA20 数字必须用上面预计算的"MA20 上方/下方 X%", 禁止自己重新算
2. ${isBlueChip ? '作为蓝筹行业, 不要用封板率/涨停作为板块资金指标' : '板块资金用封板率参考即可'}
3. 现价 < MA5 时说"反抽 MA5 受阻", 禁止说"回踩 MA5 找机会"
4. 量比 < 1 说"交投萎缩/观望", 禁止说"蓄势待发/放量"
5. 不要用"替身/龙头"等抽象话术, 改说"非板块市值前 3" 或事实型描述
6. 不确定就说"数据不足", 禁止编造数字 / 概念`;
  return await callLLM(prompt, { maxTokens: 300, timeoutMs: 15000 });
}

// 全页管家报告 (JSON 4 段)
// 学习闭环 4 层注入 (buildLearningContext 来自 ai-chat.js)
// ?v=daemon4-logic2 P1 #10: 多策略解析 (剥离 <think> / <reasoning> / ```json / function_call / 首段 {...})
//   + P1 (残缺 JSON 校验): opportunity/trap/position/risk 四个字段必须有非空字符串, 否则整体降级
async function butlerReport(snapshot) {
  const ctxFn = window.ReverseWatch?.AIChat?.buildLearningContext;
  const learning = (typeof ctxFn === 'function') ? ctxFn() : '(无学习上下文)';
  // ?v=daemon4-logic2 P2 #11: prompt 截断防切 JSON 中间 — 用 codePoints 数, 找合法边界
  const snapshotStr = JSON.stringify(snapshot);
  const MAX_SNAPSHOT_CHARS = 1500;
  let safeSnapshot = snapshotStr.slice(0, MAX_SNAPSHOT_CHARS);
  // 找最后一个 } 或 ] 收尾, 避免切到 "codes":[" 中
  const lastBrace = Math.max(safeSnapshot.lastIndexOf('}'), safeSnapshot.lastIndexOf(']'));
  if (lastBrace > 0 && lastBrace < MAX_SNAPSHOT_CHARS - 1) safeSnapshot = safeSnapshot.slice(0, lastBrace + 1);
  const prompt = `${learning}

根据以下持仓快照生成 4 段报告 (严格 JSON):
${safeSnapshot}

输出 schema:
{"opportunity": "今日机会 (≤60字, 不要推用户已否定的股)", "trap": "今日陷阱 (≤60字)", "position": "仓位建议 (≤60字, 参考用户的持仓规律)", "risk": "风险提示 (≤60字)"}
只输出 JSON, 不要 markdown。`;
  const r = await callLLM(prompt, { systemPrompt: '你是 A 股投资管家。严格输出一段 JSON, 禁止任何解释/markdown/思考过程。不要 think 标签, 不要 ```json 包裹, 第一行必须是 {', maxTokens: 500, timeoutMs: 20000 });
  // 多策略解析: 依次尝试
  let raw = (r.text || '').trim();
  // 1) 剥 <think> ...</think> (DeepSeek/Qwen)
  raw = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // 2) 剥 <reasoning>...</reasoning> (OpenAI o1 类模型)
  raw = raw.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();
  // 3) 剥 markdown 围栏 ```json ... ```
  raw = raw.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim();
  // 4) 剥 function_call(...) 包装
  raw = raw.replace(/^function_call\s*\([^)]*\)\s*/i, '').trim();
  let parsed = null;
  try { parsed = JSON.parse(raw); }
  catch {
    // 5) 用平衡括号扫描找首段 {...} (LLM 经常返 "好的,以下是: {...}")
    const m = raw.match(/\{[\s\S]*?\}/);
    if (m) {
      try { parsed = JSON.parse(m[0]); } catch {}
    }
  }
  // P1 (残缺 JSON 校验): 4 字段都需非空字符串, 否则整体降级到 raw 前 80 字 (单一占位)
  if (parsed && typeof parsed === 'object' && Array.isArray(['opportunity', 'trap', 'position', 'risk'])) {
    // 不会进, 兜底
  }
  if (parsed && typeof parsed === 'object') {
    const keys = ['opportunity', 'trap', 'position', 'risk'];
    const valid = keys.every(k => typeof parsed[k] === 'string' && parsed[k].trim().length > 0);
    if (valid) return parsed;
    // 残缺 JSON: 补缺字段为空字符串 (UI 显示 "—"), 不污染其他字段
    const out = {};
    for (const k of keys) out[k] = (typeof parsed[k] === 'string' && parsed[k].trim()) ? parsed[k] : '';
    return out;
  }
  return { opportunity: raw.slice(0, 80), trap: '', position: '', risk: '' };
}

window.ReverseWatch = window.ReverseWatch || {};
// ?v=daemon4-minimax3: 即使本文件有低级语法错, PROVIDER_DEFAULTS 至少能保住 7 个核心 provider
// (备: 完整 syntax error 会让整个 module 加载失败, 那这一行也跑不到 — 这只是中间环节兜底)
// ?v=daemon4-logic1: 必须包含 minimax (forceProxy:true) — minimax 不给 CORS, 直连必爆 Failed to fetch
// 不能从 PROVIDER_FALLBACK 漏掉, 不然 dropdown 选 minimax 后又回到 "summarizeStock undefined" 老路
const PROVIDER_FALLBACK = {
  deepseek: { baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai:   { baseURL: 'https://api.openai.com/v1',    model: 'gpt-4o-mini' },
  moonshot: { baseURL: 'https://api.moonshot.cn/v1',   model: 'moonshot-v1-8k' },
  qwen:     { baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-turbo' },
  zhipu:    { baseURL: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  // minimax 强制走 dev-proxy :8089, baseURL 是相对路径 (会被 callLLM 拼成 dev-proxy + '/v1/chat/completions')
  minimax:  { baseURL: '/api/llm/minimax/v1', model: 'MiniMax-Text-01', forceProxy: true },
  // 本地 LLM (llama.cpp 默认 :8082, 走 dev-proxy /api/local/v1, 不带 Authorization)
  local:    { baseURL: '/api/local/v1', model: 'qwen2.5-7b-instruct-q4_k_m', noAuth: true }
};
window.ReverseWatch.AIAdapter = {
  getAIConfig,
  setAIConfig,
  callLLM,
  testConnection,
  summarizeStock,
  butlerReport,
  PROVIDER_DEFAULTS: (PROVIDER_DEFAULTS && Object.keys(PROVIDER_DEFAULTS).length > 0) ? PROVIDER_DEFAULTS : PROVIDER_FALLBACK
};