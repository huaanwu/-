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

const app = express();

// 简单的健康检查
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    akshare_target: AKSHARE_TARGET,
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
  console.log(`   /api/akshare/* → ${AKSHARE_TARGET}`);
  console.log(`   /api/llm/{provider}/* → ${JSON.stringify(LLM_TARGETS)}`);
  console.log(`   Health: http://127.0.0.1:${PORT}/health`);
  console.log('');
  console.log('⚠️  Make sure AKShare is running:');
  console.log('   pip install aktools');
  console.log('   python -m aktools http --host 127.0.0.1 8088');
});
