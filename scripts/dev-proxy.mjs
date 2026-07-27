#!/usr/bin/env node
/**
 * dev-proxy: AKShare 数据代理 (开发环境)
 *
 * 背景:
 *   - AKShare 是 Python 库,直接在浏览器里跑不了
 *   - 浏览器直接 fetch 东方财富/新浪/天天基金的接口会有 CORS 问题
 *   - 这个代理把 Python 起的 AKShare HTTP 服务透出来
 *
 * 启动方式 (两个都要跑):
 *   1) Python 端: python -m aktools http --host 127.0.0.1 8088
 *      (或者直接 pip install aktools, 详见 https://akshare.akfamily.xyz/)
 *   2) Node 端(本脚本): node scripts/dev-proxy.mjs
 *      → http://127.0.0.1:8089 (前端用这个)
 *
 * 前端代码里调用:
 *   fetch('/api/akshare/stock_zh_a_hist?symbol=000001&...')
 *   通过 Vite proxy (开发) 或 直接 http://10.0.2.2:8089 (Android emulator)
 *
 * 生产环境(APK):
 *   用户需要在本地跑这个代理,APK 通过局域网 IP 访问
 *   (Capacitor androidScheme: http 已经允许 HTTP 流量)
 */

import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import http from 'node:http';
import os from 'node:os';

const PORT = process.env.PROXY_PORT || 8089;
const AKSHARE_TARGET = process.env.AKSHARE_TARGET || 'http://127.0.0.1:8088';

// ===== LLM 代理 (解决浏览器 CORS) =====
// 浏览器 → /api/llm/{provider}/v1/chat/completions
//         ↓ (dev-proxy)
// DeepSeek/OpenAI/...
const LLM_TARGETS = {
  deepseek: 'https://api.deepseek.com',
  openai:   'https://api.openai.com',
  moonshot: 'https://api.moonshot.cn',
  qwen:     'https://dashscope.aliyuncs.com',
  zhipu:    'https://open.bigmodel.cn'
};

// ===== 自动发现 (本地大模型端点扫描) =====
// OpenAI 兼容端点常见端口
const DISCOVER_PORTS = [
  { port: 8082,  type: 'llama.cpp', label: 'llama.cpp server' },
  { port: 1234,  type: 'lmstudio',  label: 'LM Studio' },
  { port: 11434, type: 'ollama',    label: 'Ollama' },
  { port: 11435, type: 'ollama',    label: 'Ollama (alt)' },
  { port: 8000,  type: 'vllm',      label: 'vLLM' }
];

// 探测目标 host: localhost + dev-proxy 自身所有非内部 IPv4
function _getScanHosts() {
  const hosts = new Set(['127.0.0.1']);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name] || []) {
        if (iface.family === 'IPv4' && !iface.internal) hosts.add(iface.address);
      }
    }
  } catch (e) { console.warn('[discover] networkInterfaces 失败:', e); }
  return [...hosts];
}

// 单 host:port 探测: 3s 超时, GET /v1/models (OpenAI 标准)
function _probeEndpoint(host, port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const start = Date.now();
    const req = http.get({
      host, port, path: '/v1/models', timeout: timeoutMs,
      headers: { 'Accept': 'application/json' }
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; if (body.length > 1024 * 256) body = body.slice(0, 1024 * 256); });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          resolve({ ok: false, host, port, status: res.statusCode, latencyMs: Date.now() - start });
          return;
        }
        let models = [];
        try {
          const j = JSON.parse(body);
          models = (j.data || []).map(m => m.id || m.name).filter(Boolean);
        } catch (e) { /* 返非 JSON 视作 baseURL 通但不识 */ }
        resolve({ ok: true, host, port, models, latencyMs: Date.now() - start });
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, host, port, error: 'timeout', latencyMs: timeoutMs }); });
    req.on('error', (e) => { resolve({ ok: false, host, port, error: e.code || e.message, latencyMs: Date.now() - start }); });
  });
}

const app = express();

// 简单的健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    akshare_target: AKSHARE_TARGET,
    timestamp: new Date().toISOString()
  });
});

// 自动发现本地大模型端点 (服务器端探, 避浏览器 CORS)
app.get('/api/discover/local-llm', async (req, res) => {
  const hosts = _getScanHosts();
  const tasks = [];
  for (const host of hosts) {
    for (const p of DISCOVER_PORTS) {
      tasks.push(_probeEndpoint(host, p.port).then(r => ({
        ...r,
        type: p.type,
        label: p.label,
        baseURL: `http://${host}:${p.port}/v1`
      })));
    }
  }
  const results = await Promise.all(tasks);
  const found = results.filter(r => r.ok && r.models && r.models.length > 0);
  const serverIPs = hosts.filter(h => h !== '127.0.0.1');
  res.json({
    found: found.map(f => ({
      baseURL: f.baseURL,
      host: f.host,
      port: f.port,
      type: f.type,
      label: f.label,
      models: f.models,
      latencyMs: f.latencyMs
    })),
    scanned: results.length,
    serverIPs,
    host: serverIPs[0] || '127.0.0.1',
    timestamp: new Date().toISOString()
  });
});

// AKShare 代理
// aktools 0.0.91+ 接口路径是 /api/public/{item_id} 和 /api/private/{item_id}
// 前端代码用 /api/akshare/{item_id},这里重写成 /api/public/{item_id}
//
// 注意:app.use('/api/akshare', proxy) 会把 /api/akshare 前缀剥掉再传给 proxy,
// 所以 pathRewrite 收到的路径是 /stock_zh_a_spot,要用函数式重写拼回前缀
app.use('/api/akshare', createProxyMiddleware({
  target: AKSHARE_TARGET,
  changeOrigin: true,
  pathRewrite: (path) => `/api/public${path}`,
  onError: (err, req, res) => {
    console.error(`[proxy] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'AKSHARE_PROXY_ERROR',
      message: `无法连接到 AKShare (${AKSHARE_TARGET})。请先在另一个终端运行: python -m aktools --host 127.0.0.1 --port 8088`,
      detail: err.message
    });
  },
  onProxyReq: (proxyReq, req) => {
    console.log(`[proxy] ${req.method} ${req.url} → ${AKSHARE_TARGET}/api/public${req.url}`);
  }
}));

// 东方财富代理 — 解决浏览器 CORS (push2.eastmoney.com / 82.push2.eastmoney.com 等)
// 用法: /api/eastmoney/{rest} → https://push2.eastmoney.com/{rest} (querystring 原样透传)
app.use('/api/eastmoney', createProxyMiddleware({
  target: 'https://push2.eastmoney.com',
  changeOrigin: true,
  pathRewrite: (path) => path,  // 不改 path, query 自动透传
  onError: (err, req, res) => {
    console.error(`[eastmoney] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'EASTMONEY_PROXY_ERROR',
      message: `无法连接到东方财富: ${err.message}`
    });
  },
  onProxyReq: (proxyReq, req) => {
    console.log(`[eastmoney] ${req.method} ${req.url} → push2.eastmoney.com${req.url}`);
  }
}));

// 新浪行业板块代理 (解决浏览器 CORS; fallback 当东财 push2 限流时)
// 用法: /api/sina/{rest} → http://money.finance.sina.com.cn/{rest}
// data: param=industry 申万行业(84板块)/启明星(63)/概念/地域
// 注意: 新浪端点只支持 HTTP (80); https 会返 [] (2026-07-27 实测)
app.use('/api/sina', createProxyMiddleware({
  target: 'http://money.finance.sina.com.cn',
  changeOrigin: true,
  pathRewrite: (path) => path,  // 不改 path
  onError: (err, req, res) => {
    console.error(`[sina] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'SINA_PROXY_ERROR',
      message: `无法连接到新浪行业接口: ${err.message}`
    });
  },
  onProxyReq: (proxyReq, req) => {
    console.log(`[sina] ${req.method} ${req.url} → money.finance.sina.com.cn${req.url}`);
  }
}));

// LLM 代理 — /api/llm/{provider}/{rest} → {LLM_TARGETS[provider]}/{rest}
// 例如: /api/llm/deepseek/v1/chat/completions → https://api.deepseek.com/v1/chat/completions
app.use('/api/llm', (req, res, next) => {
  // 从 /api/llm/{provider}/... 解析 provider
  const m = req.url.match(/^\/([^/?]+)(.*)$/);
  if (!m) return res.status(400).json({ error: 'BAD_PATH', message: 'URL 必须是 /api/llm/{provider}/... 格式' });
  const provider = m[1];
  const rest = m[2] || '/';
  const target = LLM_TARGETS[provider];
  if (!target) {
    return res.status(400).json({
      error: 'UNKNOWN_PROVIDER',
      message: `不支持的 LLM provider: ${provider}`,
      supported: Object.keys(LLM_TARGETS)
    });
  }
  console.log(`[llm] ${req.method} /api/llm/${provider}${rest} → ${target}${rest}`);
  return createProxyMiddleware({
    target,
    changeOrigin: true,
    pathRewrite: () => rest,
    onError: (err, _req, _res) => console.error(`[llm] ${err.message}`)
  })(req, res, next);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StockMaster dev-proxy listening on http://0.0.0.0:${PORT}`);
  console.log('   /api/akshare/* → ' + AKSHARE_TARGET);
  console.log('   /api/eastmoney/* → push2.eastmoney.com');
  console.log('   /api/sina/* → money.finance.sina.com.cn (新加, 行业板块 fallback)');
  console.log('   /api/llm/{provider}/* → ' + JSON.stringify(LLM_TARGETS));
  console.log(`   /api/discover/local-llm → scan ${DISCOVER_PORTS.length} ports × N hosts (server-side)`);
  console.log(`   Health: http://127.0.0.1:${PORT}/health`);
  console.log('');
  console.log('⚠️  Make sure AKShare is running:');
  console.log('   pip install aktools');
  console.log('   python -m aktools http --host 127.0.0.1 8088');
});
