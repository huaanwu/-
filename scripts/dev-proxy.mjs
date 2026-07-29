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
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';

const PORT = process.env.PROXY_PORT || 8089;
const AKSHARE_TARGET = process.env.AKSHARE_TARGET || 'http://127.0.0.1:8088';
const NO_AKTOOLS_AUTOSTART = process.env.NO_AKTOOLS_AUTOSTART === '1';

// ===== aktools 自动拉起 =====
// 行为:
//   - 启动时 ping ${AKSHARE_TARGET}, 3s 内 200 则认为外部有人跑, 不动
//   - 否则尝试 spawn `python -m aktools --host 127.0.0.1 --port 8088` 子进程
//   - 等最多 15s, 起来就当依赖用, 失败就降级到手动提示
// 关掉: NO_AKTOOLS_AUTOSTART=1 node scripts/dev-proxy.mjs
function _parseHostPort(url) {
  try {
    const u = new URL(url);
    return { host: u.hostname, port: parseInt(u.port || '80', 10) };
  } catch (e) {
    console.warn('[aktools] AKSHARE_TARGET 解析失败:', e.message);
    return null;
  }
}
const _aktoolsParsed = _parseHostPort(AKSHARE_TARGET);

function _probeOnce(target, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const { host, port } = _parseHostPort(target) || { host: '127.0.0.1', port: 8088 };
    // 用 /api/public/macro_china_lpr 探活 (aktools 0.0.91 + Py 3.14 上实测稳定 200, 不需参数)
    const r = http.get({
      host, port,
      path: '/api/public/macro_china_lpr',
      timeout: timeoutMs
    }, (resp) => {
      resp.resume();
      resolve({ ok: resp.statusCode < 500, status: resp.statusCode, host, port });
    });
    r.on('timeout', () => { r.destroy(); resolve({ ok: false, status: 0, reason: 'timeout', host, port }); });
    r.on('error', (e) => resolve({ ok: false, status: 0, reason: e.code || e.message, host, port }));
  });
}

async function _waitForPort(port, host, maxMs = 15000, intervalMs = 500) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const ok = await new Promise((resolve) => {
      const s = net.connect(port, host, () => { s.end(); resolve(true); });
      s.on('error', () => resolve(false));
    });
    if (ok) return Date.now() - start;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return -1;
}

// 找 python 命令
function _pickPython() {
  for (const cmd of ['python', 'py', 'python3']) {
    try {
      const out = execFileSync(cmd, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const v = (out.toString() || '').trim();
      if (v) return { cmd, version: v };
    } catch (e) { /* try next */ }
  }
  return null;
}

let _aktoolsChild = null;

async function _ensureAktools() {
  // 1) 先探一次, 通就直接用
  const initial = await _probeOnce(AKSHARE_TARGET, 1500);
  if (initial.ok && initial.status === 200) {
    console.log(`[aktools] 已有外部进程在 ${AKSHARE_TARGET} (HTTP ${initial.status}), 不自动拉起`);
    return { spawned: false, ok: true, probe: initial };
  }
  if (NO_AKTOOLS_AUTOSTART) {
    console.log(`[aktools] ${AKSHARE_TARGET} ❌ 不通, NO_AKTOOLS_AUTOSTART=1 跳过自动拉起, 手动跑: pip install aktools && python -m aktools --host 127.0.0.1 --port 8088`);
    return { spawned: false, ok: false, probe: initial };
  }
  // 2) 找 python
  const py = _pickPython();
  if (!py) {
    console.log(`[aktools] ${AKSHARE_TARGET} ❌ 不通, 且没找到 python/python3, 请手动跑: pip install aktools && python -m aktools --host 127.0.0.1 --port 8088`);
    return { spawned: false, ok: false, probe: initial, noPython: true };
  }
  // 3) 先确认 aktools 模块已装
  try {
    execFileSync(py.cmd, ['-c', 'import aktools'], { stdio: ['ignore', 'ignore', 'ignore'] });
  } catch (e) {
    console.log(`[aktools] ${AKSHARE_TARGET} ❌ 不通, ${py.cmd} (${py.version}) 在但 aktools 没装`);
    console.log(`[aktools] → 安装: ${py.cmd} -m pip install aktools`);
    console.log(`[aktools] → 然后: ${py.cmd} -m aktools --host 127.0.0.1 --port 8088`);
    return { spawned: false, ok: false, probe: initial, noAktoolsPkg: true };
  }
  // 4) spawn aktools
  console.log(`[aktools] ${AKSHARE_TARGET} 不通, 自动拉起: ${py.cmd} -m aktools --host 127.0.0.1 --port 8088`);
  try {
    const host = _aktoolsParsed?.host || '127.0.0.1';
    const port = _aktoolsParsed?.port || 8088;
    _aktoolsChild = spawn(py.cmd, ['-m', 'aktools', '--host', host, '--port', String(port)], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    const tag = `[aktools pid=${_aktoolsChild.pid}]`;
    _aktoolsChild.stdout.on('data', (c) => process.stdout.write(`${tag} ${c}`));
    _aktoolsChild.stderr.on('data', (c) => process.stderr.write(`${tag} ${c}`));
    _aktoolsChild.on('exit', (code) => {
      console.log(`[aktools] 子进程 exit (code=${code})`);
      _aktoolsChild = null;
    });
  } catch (e) {
    console.log(`[aktools] spawn 失败: ${e.message}`);
    return { spawned: false, ok: false, probe: initial };
  }
  // 5) 等待端口起来
  const waitMs = await _waitForPort(_aktoolsParsed?.port || 8088, _aktoolsParsed?.host || '127.0.0.1', 15000);
  if (waitMs < 0) {
    console.log(`[aktools] 15s 内没起来, 请检查: ${py.cmd} -m aktools --host 127.0.0.1 --port 8088`);
    return { spawned: true, ok: false, probe: initial };
  }
  // 6) 再探一次确认业务端点 (端口起来但服务还没就绪也会失败)
  const settle = await _probeOnce(AKSHARE_TARGET, 5000);
  if (settle.ok && settle.status === 200) {
    console.log(`[aktools] ✅ 起来了 (端口等 ${waitMs}ms, 端点 HTTP ${settle.status})`);
    return { spawned: true, ok: true, probe: settle };
  }
  console.log(`[aktools] ⚠️ 端口开了但端点没就绪 (HTTP ${settle.status}), 多等一会儿再试`);
  return { spawned: true, ok: false, probe: settle };
}

// ===== LLM 代理 (解决浏览器 CORS) =====
// 浏览器 → /api/llm/{provider}/v1/chat/completions
//         ↓ (dev-proxy)
// DeepSeek/OpenAI/...
const LLM_TARGETS = {
  deepseek: 'https://api.deepseek.com',
  openai:   'https://api.openai.com',
  moonshot: 'https://api.moonshot.cn',
  qwen:     'https://dashscope.aliyuncs.com',
  zhipu:    'https://open.bigmodel.cn',
  minimax:  'https://api.minimax.chat'
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

// ===== CORS 放行 (APK 局域网访问用) =====
// V10: APK WebView origin 是 http://localhost (Capacitor androidScheme: 'http'),
//      fetch http://192.168.x.x:8089/api/akshare/... 是 cross-origin, 浏览器会先发 OPTIONS 预检.
//      之前只放行 /health, 导致 /api/* 的 OPTIONS 预检 404, fetch 直接 reject (浏览器能通因为 Android Chrome 对 user-typed URL 宽容, WebView 标准 fetch 严).
//      这里通用放行 /api/* OPTIONS (ACAO: * + ACAM: GET/POST + ACCH: Content-Type),
//      不全局放行 (只针对 /api/* + /health, 避免被恶意页面当开放代理).
// 注意: http-proxy-middleware 在 proxy 路由里会接管 res, 用 res.setHeader 设的 ACAO 会被上游响应覆盖.
//       必须在 proxy.onProxyRes 钩子里再注入一次. 下面 createProxyMiddleware 调用统一传入 onProxyRes.
function _addCorsHeaders(proxyRes, req, res) {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization';
}
const _proxyOpts = { onProxyRes: _addCorsHeaders };

// V15: CORS preflight — 用 middleware 避 path-to-regexp 5.x 的 * 通配符废弃
app.use((req, res, next) => {
  // 对所有路由加 ACAO:* (包括非 /api/*, 因 /api/sina 等经 proxy 后 ACAO 丢失)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
});
// V15: 纯快速存活探测 (不做任何 aktools 检查), 给 APK 自动发现用
app.options('/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(204).end();
});
app.get('/ping', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', ping: true, timestamp: new Date().toISOString() });
});

app.options('/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.status(204).end();
});
app.get('/health', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  // 顺便 ping aktools (Python 后端), selfCheck 一次性拿到 dev-proxy + aktools 状态
  // 探针用 /api/public/index (aktools 列表页, 0.0.91+ 必定存在, 不需参数)
  const aktoolsCheck = await new Promise((resolve) => {
    const req2 = http.get(AKSHARE_TARGET + '/api/public/macro_china_lpr', { timeout: 4000 }, (r2) => {
      let body = '';
      r2.on('data', (c) => { body += c; if (body.length > 4096) body = body.slice(0, 4096); });
      r2.on('end', () => {
        // 200/422 = ok (422 = 端点存在但参数不对); 404/500 = down
        const ok = r2.statusCode === 200 || r2.statusCode === 422;
        resolve({ ok, status: r2.statusCode, sample: body.slice(0, 200) });
      });
    });
    req2.on('timeout', () => { req2.destroy(); resolve({ ok: false, status: 0, reason: 'timeout' }); });
    req2.on('error', (e) => { resolve({ ok: false, status: 0, reason: e.code || e.message }); });
  });
  const akshare_status = aktoolsCheck.ok ? 'ok' : 'down';
  res.json({
    status: 'ok',
    akshare_target: AKSHARE_TARGET,
    akshare_status,
    akshare_check_detail: aktoolsCheck,
    timestamp: new Date().toISOString()
  });
});

// 启动时探测 aktools: 通则不动, 不通则自动 spawn 子进程
let _aktoolsBootResult = { spawned: false, ok: false };
(async () => {
  // 50ms 等 express 起来再 ping (避免冷启动顺序问题)
  await new Promise(r => setTimeout(r, 50));
  _aktoolsBootResult = await _ensureAktools();
  if (!_aktoolsBootResult.ok && !_aktoolsBootResult.spawned) {
    // 降级到手动提示 (NO_AKTOOLS_AUTOSTART / 没 python / 没装 aktools)
    console.log('[dev-proxy] → 备用手动启动: pip install aktools');
    console.log('[dev-proxy] → 然后: python -m aktools --host 127.0.0.1 --port 8088');
    console.log('[dev-proxy] → (aktools 0.0.91+ 已移除 http 子命令, 直接 --host/--port)');
  }
})();

// 退出时清理 spawn 的 aktools 子进程 (仅本脚本拉的)
function _killAktoolsChild() {
  if (_aktoolsChild && !_aktoolsChild.killed) {
    try { _aktoolsChild.kill(); } catch (e) { /* 静默退出 */ }
  }
}
process.on('SIGINT', () => { _killAktoolsChild(); process.exit(0); });
process.on('SIGTERM', () => { _killAktoolsChild(); process.exit(0); });

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

// 告诉浏览器 "我在哪些 IP 上" — 给 APK 在局域网发现 dev-proxy 用
// 浏览器收到 serverIPs 后, 自己挨个 fetch {ip}:8089/health (会撞浏览器 CORS, 见下面 origin 放行)
app.get('/api/discover/dev-proxy', (req, res) => {
  const all = _getScanHosts();
  const serverIPs = all.filter(h => h !== '127.0.0.1');
  res.json({
    port: PORT,
    serverIPs,
    host: serverIPs[0] || '127.0.0.1',
    healthPath: '/health',
    proxyPath: '/api/akshare',
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
  onProxyRes: _proxyOpts.onProxyRes,
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
// 注意: app.use('/api/eastmoney', proxy) 会把 /api/eastmoney 前缀剥掉, 转发路径变成 /api/qt/clist/get
//       push2.eastmoney.com 的接口路径就是 /api/qt/... /api/qt/clist/get, 所以保持原样
// 东方财富代理 — push2.eastmoney.com 2026-07-27 实测对裸请求直接 ECONNRESET
// (任何 Referer/UA 都被拒绝, 无公开 cookie 可绕). 立即返 502 让浏览器走 sina fallback
app.use('/api/eastmoney', (req, res) => {
  console.warn(`[eastmoney] ${req.method} ${req.url} → blocked (push2 拒裸连接, 走 sina fallback)`);
  res.status(502).json({
    error: 'EASTMONEY_PUSH2_BLOCKED',
    message: 'push2.eastmoney.com 当前拒绝裸连接, 请改用 /api/sina 行业 fallback (market.js 已自动处理)',
    upstream: 'push2.eastmoney.com'
  });
});

// 腾讯行情代理 (qt.gtimg.cn 备用通道, 浏览器直连失败时 fallback)
// 用法: /api/tencent/{rest} → https://qt.gtimg.cn/{rest}
// 主用通道: www/core/data.js _tencentFetch 直连 https://qt.gtimg.cn (CORS 友好)
// 此 proxy 用于: 某些环境下 qt.gtimg.cn 被运营商劫持/限流, 改走本机 dev-proxy
app.use('/api/tencent', createProxyMiddleware({
  target: 'https://qt.gtimg.cn',
  changeOrigin: true,
  pathRewrite: (path) => path,
  onProxyRes: _proxyOpts.onProxyRes,
  onProxyReq: (proxyReq, req) => {
    proxyReq.setHeader('Referer', 'https://gu.qq.com/');
    proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    console.log(`[tencent] ${req.method} ${req.url} → qt.gtimg.cn${req.url}`);
  },
  onError: (err, req, res) => {
    console.error(`[tencent] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'TENCENT_PROXY_ERROR',
      message: `无法连接到腾讯行情: ${err.message}`
    });
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
  onProxyRes: _proxyOpts.onProxyRes,
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

// 天天基金代理 (解决浏览器 CORS; 当 aktools 端点 500 时 fallback)
// 用法: /api/fund/eastmoney/{rest} → http://fund.eastmoney.com/{rest}
// 已知端点:
//   /api/fund/eastmoney/pingzhongdata/{code}.js
//     → 包含 Data_fundHistoryNetValue (历史净值) / Data_netValueEstimate (实时估值) 等
//   /api/fund/tt/{rest} → http://fundgz.1234567.com.cn/{rest}  (实时估值 js: jsonpgz(...))
// 注意: 端点只支持 HTTP; https 时会直连失败
app.use('/api/fund', createProxyMiddleware({
  router: (req) => {
    if (req.url.startsWith('/eastmoney')) return 'https://fund.eastmoney.com';
    if (req.url.startsWith('/tt')) return 'https://fundgz.1234567.com.cn';
    return 'https://fund.eastmoney.com';
  },
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/(eastmoney|tt)/, ''),
  onProxyRes: _proxyOpts.onProxyRes,
  onProxyReq: (proxyReq, req) => {
    const m = req.url.match(/^\/(eastmoney|tt)/);
    const tag = m ? m[1] : 'eastmoney';
    const target = tag === 'tt' ? 'fundgz.1234567.com.cn' : 'fund.eastmoney.com';
    console.log(`[fund] ${req.method} ${req.url} → ${target}`);
  },
  onError: (err, req, res) => {
    console.error(`[fund] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'FUND_PROXY_ERROR',
      message: `无法连接天天基金接口: ${err.message}`
    });
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
    onProxyRes: _proxyOpts.onProxyRes,
    onError: (err, _req, _res) => console.error(`[llm] ${err.message}`)
  })(req, res, next);
});

// ===== 本地 LLM 透传 (绕过浏览器 CORS) =====
// 浏览器 → /api/local/v1/chat/completions → 上游 http://127.0.0.1:8082/v1/...
// 注意: 上游 host:port 可通过环境变量 LOCAL_LLM_TARGET 覆盖, 默认 8082 (llama.cpp)
const LOCAL_LLM_TARGET = process.env.LOCAL_LLM_TARGET || 'http://127.0.0.1:8082';
app.use('/api/local', createProxyMiddleware({
  target: LOCAL_LLM_TARGET,
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/api\/local/, ''),
  onProxyRes: _proxyOpts.onProxyRes,
  onError: (err, req, res) => {
    console.error(`[local-llm] ${req.method} ${req.url} → ${err.message}`);
    res.status(502).json({
      error: 'LOCAL_LLM_UNREACHABLE',
      message: `无法连接本地大模型 ${LOCAL_LLM_TARGET}: ${err.message}`,
      target: LOCAL_LLM_TARGET
    });
  },
  onProxyReq: (proxyReq, req) => {
    console.log(`[local-llm] ${req.method} ${req.url} → ${LOCAL_LLM_TARGET}${req.url.replace(/^\/api\/local/, '')}`);
  }
}));

// ===== WebDAV 透传 (v0.2.3 设置项云同步) =====
// 浏览器 → /api/webdav?url={完整目标 URL}&username=&password= → 透传到任意 WebDAV
// 用 query 而不是 header 传 url/credentials 是为了避免自定义 header 触发 CORS 预检
//   (WebDAV 服务器 (坚果云/Nextcloud/自建) 端支持 basic auth, 我们在 proxy 层注入 Authorization header)
function _decodeCred(value) {
  if (!value) return '';
  try { return decodeURIComponent(value); } catch (_) { return value; }
}
function _webdavProxy(req, res, next) {
  const target = req.query.url;
  if (!target) {
    return res.status(400).json({ error: 'MISSING_URL', message: '需要 ?url= 参数指定 WebDAV 目标' });
  }
  // 安全: 仅允许 http/https
  let parsed;
  try { parsed = new URL(target); } catch (e) {
    return res.status(400).json({ error: 'BAD_URL', message: 'URL 解析失败: ' + e.message });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ error: 'BAD_SCHEME', message: '仅允许 http/https, 不支持 ' + parsed.protocol });
  }
  const username = _decodeCred(req.query.username);
  const password = _decodeCred(req.query.password);
  const proxyOpts = {
    target: target,
    changeOrigin: true,
    followRedirects: true,
    pathRewrite: () => parsed.pathname + parsed.search,
    onProxyReq: (proxyReq, pReq) => {
      // 透传 Authorization: 用前端传的 username/password 拼 basic
      if (username || password) {
        const auth = Buffer.from(username + ':' + password).toString('base64');
        proxyReq.setHeader('Authorization', 'Basic ' + auth);
      }
    },
    onProxyRes: (proxyRes) => {
      // dev-proxy 头要保留 Last-Modified / ETag 给前端 (判断 mtime)
      proxyRes.headers['access-control-expose-headers'] = 'Last-Modified, ETag, Content-Length';
    },
    onError: (err, pReq, pRes) => {
      console.error(`[webdav] ${pReq.method} ${pReq.url} → ${err.message}`);
      if (!pRes.headersSent) {
        pRes.status(502).json({ error: 'WEBDAV_UNREACHABLE', message: err.message });
      }
    }
  };
  // 创建子 proxy, 调用它作为当前请求的 handler
  createProxyMiddleware(proxyOpts)(req, res, next);
}
app.use('/api/webdav', _webdavProxy);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 StockMaster dev-proxy listening on http://0.0.0.0:${PORT}`);
  console.log('   /api/akshare/* → ' + AKSHARE_TARGET);
  console.log('   /api/eastmoney/* → push2.eastmoney.com');
  console.log('   /api/sina/* → money.finance.sina.com.cn (新加, 行业板块 fallback)');
  console.log('   /api/llm/{provider}/* → ' + JSON.stringify(LLM_TARGETS));
  console.log(`   /api/discover/local-llm → scan ${DISCOVER_PORTS.length} ports × N hosts (server-side)`);
  console.log(`   /api/discover/dev-proxy → 暴露 serverIPs (给 APK 局域网自动发现用)`);
  console.log(`   /api/local/* → ${LOCAL_LLM_TARGET} (本地大模型透传, 绕浏览器 CORS)`);
  console.log(`   /api/webdav → 透传 ?url= 任意 WebDAV (设置项云同步, 鉴权走 query)`);
  console.log(`   /api/tencent/* → qt.gtimg.cn (腾讯行情备用通道, 主用 data.js 直连)`);
  console.log(`   Health: http://127.0.0.1:${PORT}/health`);
  console.log('');
  console.log('⚠️  Make sure AKShare is running:');
  console.log('   pip install aktools');
  console.log('   python -m aktools http --host 127.0.0.1 8088');
});
