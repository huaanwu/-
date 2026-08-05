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
import https from 'node:https';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import net from 'node:net';
import { readFileSync, existsSync, watch as fsWatch } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'node:crypto';

const PORT = process.env.PROXY_PORT || 8089;
const AKSHARE_TARGET = process.env.AKSHARE_TARGET || 'http://127.0.0.1:8088';
const NO_AKTOOLS_AUTOSTART = process.env.NO_AKTOOLS_AUTOSTART === '1';
const __dirname = dirname(fileURLToPath(import.meta.url));

// ?v=dev-proxy-env1: 启动时读 .env (项目根目录), 把 MINIMAX_KEY 等塞进 process.env
// ?v=dev-proxy-env4 P1-2: 抽成可重入函数 + fs.watch 热加载
// 浏览器调 /api/llm/minimax 时 dev-proxy 自动注入 Authorization: Bearer ${MINIMAX_KEY}
// → 浏览器零 key, 项目源码零硬编码, .env 由 .gitignore 隔离
const _envPath = resolve(__dirname, '..', '.env');
// ?v=dev-proxy-env4 P0-C: 启动前快照真·shell env keys (只保护这些, 允许 .env 覆盖自己加载过的 key)
//   之前 if (process.env[_k] === undefined) 把"启动时 .env 加载的"和"PowerShell 直传的"混为一谈
//   导致 key rotation 永远不生效 (reloaded 0 keys 误导)
const _shellEnvKeys = new Set(Object.keys(process.env));
function _parseEnvText(_envText) {
  const _kv = {};
  for (const _line of _envText.split(/\r?\n/)) {
    const _m = _line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!_m) continue;
    let _v = _m[2];
    if ((_v.startsWith('"') && _v.endsWith('"')) || (_v.startsWith("'") && _v.endsWith("'"))) {
      _v = _v.slice(1, -1);
    }
    _kv[_m[1]] = _v;
  }
  return _kv;
}
function _reloadEnv(logPrefix = '[env]') {
  if (!existsSync(_envPath)) return null;
  try {
    const _envText = readFileSync(_envPath, 'utf8');
    const _kv = _parseEnvText(_envText);
    // P0-C: 只保护真·shell env (PowerShell/cmd 直传的) — 让 .env 能覆盖之前自己加载的 key
    //   真·shell env 优先级 > .env (用户手设的最高)
    //   .env 启动加载的 < .env 热加载 (rotation 场景)
    let _loaded = 0;
    let _shellSkipped = 0;
    for (const [_k, _v] of Object.entries(_kv)) {
      if (_shellEnvKeys.has(_k)) {
        _shellSkipped++;
        continue;
      }
      process.env[_k] = _v;
      _loaded++;
    }
    // 同步刷新 LLM_KEYS (从 process.env 读, 反映最新值)
    LLM_KEYS.minimax  = process.env.MINIMAX_KEY  || '';
    LLM_KEYS.deepseek = process.env.DEEPSEEK_KEY || '';
    LLM_KEYS.openai   = process.env.OPENAI_KEY   || '';
    LLM_KEYS.moonshot = process.env.MOONSHOT_KEY || '';
    LLM_KEYS.qwen     = process.env.QWEN_KEY     || '';
    LLM_KEYS.zhipu    = process.env.ZHIPU_KEY    || '';
    LLM_KEYS.custom   = process.env.CUSTOM_LLM_KEY || '';
    console.log(`${logPrefix} reloaded ${_loaded} keys (skipped ${_shellSkipped} shell-protected) from ${_envPath}`);
    return _kv;
  } catch (e) {
    console.warn(`${logPrefix} reload failed: ${e.message}`);
    return null;
  }
}
// 启动时一次性加载
const LLM_KEYS = {};
_reloadEnv('[env] loaded');
// ?v=dev-proxy-env4 P1-2: fs.watch 监听 .env 改动, 热加载 (debounce 500ms, 防止编辑器多次写入触发多次 reload)
// ?v=dev-proxy-env4 P0-C: Windows 编辑器 (VSCode/Sublime/Notepad++) 用 write-temp-then-rename 模式保存
//   会触发 `rename` 事件而非 `change` — 不能过滤 rename, 否则永远不 reload
if (existsSync(_envPath)) {
  let _envReloadTimer = null;
  try {
    fsWatch(_envPath, { persistent: true }, (eventType, filename) => {
      // Linux/Mac: change; Windows 编辑器: rename (write-temp-then-rename)
      if (eventType !== 'change' && eventType !== 'rename') return;
      if (_envReloadTimer) clearTimeout(_envReloadTimer);
      _envReloadTimer = setTimeout(() => {
        _envReloadTimer = null;
        _reloadEnv('[env:hot]');
      }, 500);
    });
    console.log(`[env] watching ${_envPath} for hot reload`);
  } catch (e) {
    console.warn(`[env] watch failed: ${e.message}`);
  }
}

// 静态文件根目录 (Electron 生产模式用)
const STATIC_ROOT = process.env.STATIC_ROOT
  ? resolve(process.env.STATIC_ROOT)
  : (process.env.NODE_ENV === 'production'
    ? resolve(process.argv[1] || '.', '..', 'www')   // node dev-proxy.mjs → www 在上一级
    : resolve(__dirname, '..', 'www'));              // dev: 项目根/www

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

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
let _aktoolsShuttingDown = false; // dev-proxy 主动停时不触发 watchdog
let _aktoolsRestartTimer = null;
let _aktoolsRestartAttempts = 0;
const _aktoolsRestartDelay = (n) => Math.min(30000, 1000 * Math.pow(2, n)); // 退避: 1s → 2s → 4s → ... → 上限 30s

function _spawnAktools(py) {
  // 抽离 spawn 逻辑, 让 watchdog 和 boot 都能复用
  const host = _aktoolsParsed?.host || '127.0.0.1';
  const port = _aktoolsParsed?.port || 8088;
  _aktoolsChild = spawn(py.cmd, ['-m', 'aktools', '--host', host, '--port', String(port)], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  const tag = `[aktools pid=${_aktoolsChild.pid}]`;
  _aktoolsChild.stdout.on('data', (c) => process.stdout.write(`${tag} ${c}`));
  _aktoolsChild.stderr.on('data', (c) => process.stderr.write(`${tag} ${c}`));
  _aktoolsChild.on('exit', (code, signal) => {
    console.log(`[aktools] 子进程 exit (code=${code}, signal=${signal})`);
    _aktoolsChild = null;
    // watchdog: dev-proxy 主动停时不重拉 (避免退出阻塞); 其余情况指数退避重拉
    if (_aktoolsShuttingDown) return;
    if (signal === 'SIGTERM' || signal === 'SIGINT') return;
    const delay = _aktoolsRestartDelay(_aktoolsRestartAttempts);
    _aktoolsRestartAttempts++;
    console.log(`[aktools] watchdog 将在 ${delay}ms 后重拉 (第 ${_aktoolsRestartAttempts} 次)`);
    _aktoolsRestartTimer = setTimeout(async () => {
      const py2 = _pickPython();
      if (!py2) {
        console.warn('[aktools] watchdog 找不到 python, 放弃重拉');
        return;
      }
      try {
        _spawnAktools(py2);
        const waitMs = await _waitForPort(port, host, 15000);
        if (waitMs >= 0) {
          _aktoolsRestartAttempts = 0; // 起来成功, 重置计数
          console.log(`[aktools] watchdog ✅ 重拉成功 (端口等 ${waitMs}ms)`);
        } else {
          console.warn('[aktools] watchdog 端口没起来, 下次 exit 再试');
        }
      } catch (e) {
        console.warn('[aktools] watchdog 重拉失败:', e.message);
      }
    }, delay);
  });
  return _aktoolsChild;
}

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
  // 4) spawn aktools (走 _spawnAktools 共享 watchdog 钩子)
  console.log(`[aktools] ${AKSHARE_TARGET} 不通, 自动拉起: ${py.cmd} -m aktools --host 127.0.0.1 --port 8088`);
  try {
    _spawnAktools(py);
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
    _aktoolsRestartAttempts = 0; // boot 成功也重置 watchdog 计数
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
// ?v=dev-proxy-env4 P1-3: LLM 响应加 no-store + env-fingerprint, 避免浏览器缓存旧 key 生成的响应
//   cache-control: no-store 强制浏览器/SW 不缓存, 每次都走 dev-proxy
//   x-env-fingerprint: LLM_KEYS 拼接 hash, key rotation 后值变化, 浏览器/SW/Vite 可借此 revalidate
function _envFingerprint() {
  const h = createHash('sha256');
  for (const _p of Object.keys(LLM_KEYS).sort()) {
    const _k = LLM_KEYS[_p] || '';
    h.update(_p + ':' + _k.length + ':' + (_k ? _k.slice(-4) : '') + ';');
  }
  return h.digest('hex').slice(0, 12);
}
function _addCorsHeaders(proxyRes, req, res) {
  proxyRes.headers['access-control-allow-origin'] = '*';
  proxyRes.headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
  proxyRes.headers['access-control-allow-headers'] = 'Content-Type, Authorization';
  // ?v=dev-proxy-env4 P1-3: LLM 路径注入 cache-control + x-env-fingerprint
  //   关键发现 (debug 溯源): http-proxy-middleware v3.0.7 的 factory.js 直接 new HttpProxyMiddleware(opts)
  //   不调 legacyOptionsAdapter — legacy 的 onProxyRes 字段**静默失效**(只有 warn, 不报错, 不生效!)
  //   必须用 v3.0.7 新事件 API on: { proxyRes: fn }, proxyEventsPlugin 才把它注册到 proxyServer.on('proxyRes', ...)
  //   原 onProxyRes hook 在 instance 缓存模式下, 因为 legacy 适配器被跳过, 一直是死的
  //   onProxyRes 钩子的优势: 在 proxy.pipe(res) 之前修改 proxyRes.headers, 不被覆盖
  const _reqPath = req.originalUrl || req.url || '';
  if (_reqPath.includes('/api/llm/')) {
    proxyRes.headers['cache-control'] = 'no-store, max-age=0';
    proxyRes.headers['x-env-fingerprint'] = _envFingerprint();
  }
}
// ?v=dev-proxy-env4: 必须用 v3.0.7 新事件 API on: { proxyRes } — legacy onProxyRes 在 factory 直构模式下不生效
const _proxyOpts = { on: { proxyRes: _addCorsHeaders } };

// V17: 已知前端 origin 白名单 (仅作日志/调试, 实际 ACAO 仍是 *, 因为 Authorization 头是简单的 bearer 不需要凭证)
//   - http://localhost:3003  stock-master Vite dev
//   - http://127.0.0.1:3003  stock-master Vite dev
//   - http://localhost:3020  reverse-watch (独立 SPA)
//   - http://127.0.0.1:3020  reverse-watch
//   - http://localhost:8089  dev-proxy 自检 (APK)
const KNOWN_ORIGINS = [
  'http://localhost:3003', 'http://127.0.0.1:3003',
  'http://localhost:3020', 'http://127.0.0.1:3020',
  'http://localhost:8089', 'http://127.0.0.1:8089'
];

// V15: CORS preflight — 用 middleware 避 path-to-regexp 5.x 的 * 通配符废弃
app.use((req, res, next) => {
  // 对所有路由加 ACAO:* (包括非 /api/*, 因 /api/sina 等经 proxy 后 ACAO 丢失)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  // V17: 已知 origin 列表打印到启动横幅, 方便排查 reverse-watch (:3020) 这类多前端接入
  if (req.headers.origin && KNOWN_ORIGINS.includes(req.headers.origin)) {
    res.setHeader('X-Known-Origin', req.headers.origin);
  }
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
  // ?v=daemon7-degraded-fix: 探针改用 /api/public/version (aktools 0.0.91+ 必定存在 + 无参数必返 200)
  // 旧 bug: 用 /api/public/macro_china_lpr 探 (0.0.91 已废弃, 接口不存在) → 永远 timeout → akshare_status=down
  //       → 联动 daemon 报 degraded
  const aktoolsCheck = await new Promise((resolve) => {
    const req2 = http.get(AKSHARE_TARGET + '/api/public/version', { timeout: 4000 }, (r2) => {
      let body = '';
      r2.on('data', (c) => { body += c; if (body.length > 4096) body = body.slice(0, 4096); });
      r2.on('end', () => {
        // 200 = ok (aktools 在); 其它 = down
        const ok = r2.statusCode === 200;
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
})().catch(e => console.error('[dev-proxy] _ensureAktools 异常:', e));

// V13: 防止未捕获拒绝导致进程静默退出 (Express listen 后 event loop 仍在活跃,
// 但 unhandledRejection 会让 Node 16+ 打印警告然后 exit 0)
process.on('unhandledRejection', (reason) => {
  console.error('[dev-proxy] unhandledRejection:', reason instanceof Error ? reason.message : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[dev-proxy] uncaughtException:', err.message, err.stack);
});

// 退出时清理 spawn 的 aktools 子进程 (仅本脚本拉的)
function _killAktoolsChild() {
  // 先标 shutting down, 让 watchdog 的 exit 监听不再触发重拉
  _aktoolsShuttingDown = true;
  if (_aktoolsRestartTimer) { clearTimeout(_aktoolsRestartTimer); _aktoolsRestartTimer = null; }
  if (_aktoolsChild && !_aktoolsChild.killed) {
    try { _aktoolsChild.kill(); } catch (e) { /* 静默退出 */ }
  }
}
// ?v=dev-proxy-env4 P0-2: 软退出 — server.close() 等 in-flight 完成, 5s timeout 后再硬退
//   之前 _killAktoolsChild() + process.exit(0) 直接 TCP RST 中断飞行请求 (minimax 8-15s 慢响应经常被切)
let _isShuttingDown = false;
function _gracefulShutdown(signal) {
  if (_isShuttingDown) return; // 防止 SIGTERM + SIGINT 同时来
  _isShuttingDown = true;
  console.log(`[shutdown] ${signal} received, 软退出...`);
  _killAktoolsChild();
  // server.close 停止接收新连接, 等待已有连接自然结束
  if (server && server.close) {
    try {
      server.close((err) => {
        if (err) console.error('[shutdown] server.close err:', err.message);
        process.exit(0);
      });
    } catch (e) {
      console.error('[shutdown] server.close throw:', e.message);
      process.exit(1);
    }
  }
  // 5s 超时 — 超时后硬退 (in-flight 请求会被切, 但至少给了缓冲)
  setTimeout(() => {
    console.warn('[shutdown] 5s timeout, 强制退出');
    process.exit(0);
  }, 5000).unref(); // unref 防止 timer 自身阻挡 exit
}
process.on('SIGINT', () => _gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => _gracefulShutdown('SIGTERM'));

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
  on: {
    proxyRes: _proxyOpts.on.proxyRes,
    error: (err, req, res) => {
      console.error(`[proxy] ${req.method} ${req.url} → ${err.message}`);
      res.status(502).json({
        error: 'AKSHARE_PROXY_ERROR',
        message: `无法连接到 AKShare (${AKSHARE_TARGET})。请先在另一个终端运行: python -m aktools --host 127.0.0.1 --port 8088`,
        detail: err.message
      });
    },
    proxyReq: (proxyReq, req) => {
      // ?v=daemon7-degraded-fix: req.url 是原始 URL (含 /api/akshare 前缀), 转发到 aktools 是 /api/public/<item_id>
      // 旧版 log 拼 ${req.url} 误打 /api/public/api/akshare/<item_id> (路径重复假象), 实际转发 OK
      // 这里用 path (已剥前缀) 展示真实转发的目标 URL
      const target = require('node:url').parse(req.url).pathname;  // 已剥前缀的 path
      console.log(`[proxy] ${req.method} ${req.url} → ${AKSHARE_TARGET}/api/public${target}`);
    }
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
  on: {
    proxyRes: _proxyOpts.on.proxyRes,
    proxyReq: (proxyReq, req) => {
      proxyReq.setHeader('Referer', 'https://gu.qq.com/');
      proxyReq.setHeader('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      console.log(`[tencent] ${req.method} ${req.url} → qt.gtimg.cn${req.url}`);
    },
    error: (err, req, res) => {
      console.error(`[tencent] ${req.method} ${req.url} → ${err.message}`);
      res.status(502).json({
        error: 'TENCENT_PROXY_ERROR',
        message: `无法连接到腾讯行情: ${err.message}`
      });
    }
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
  on: {
    proxyRes: _proxyOpts.on.proxyRes,
    error: (err, req, res) => {
      console.error(`[sina] ${req.method} ${req.url} → ${err.message}`);
      res.status(502).json({
        error: 'SINA_PROXY_ERROR',
        message: `无法连接到新浪行业接口: ${err.message}`
      });
    },
    proxyReq: (proxyReq, req) => {
      console.log(`[sina] ${req.method} ${req.url} → money.finance.sina.com.cn${req.url}`);
    }
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
  on: {
    proxyRes: _proxyOpts.on.proxyRes,
    proxyReq: (proxyReq, req) => {
      const m = req.url.match(/^\/(eastmoney|tt)/);
      const tag = m ? m[1] : 'eastmoney';
      const target = tag === 'tt' ? 'fundgz.1234567.com.cn' : 'fund.eastmoney.com';
      console.log(`[fund] ${req.method} ${req.url} → ${target}`);
    },
    error: (err, req, res) => {
      console.error(`[fund] ${req.method} ${req.url} → ${err.message}`);
      res.status(502).json({
        error: 'FUND_PROXY_ERROR',
        message: `无法连接天天基金接口: ${err.message}`
      });
    }
  }
}));

// LLM provider → 认证 header 映射 (P1-4: Qwen/DashScope 必须 X-DashScope-API-Key, 不能硬塞 Bearer)
const LLM_AUTH_HEADERS = {
  minimax:  'Authorization',      // Bearer sk-...
  deepseek: 'Authorization',      // Bearer sk-...
  openai:   'Authorization',      // Bearer sk-...
  moonshot: 'Authorization',      // Bearer sk-...
  zhipu:    'Authorization',      // Bearer ...
  custom:   'Authorization'       // OpenAI 兼容
  // qwen: 'X-DashScope-API-Key' (DashScope 不接受 Bearer)
};
const LLM_AUTH_SCHEMES = {
  minimax:  'Bearer',
  deepseek: 'Bearer',
  openai:   'Bearer',
  moonshot: 'Bearer',
  zhipu:    'Bearer',
  custom:   'Bearer',
  qwen:     ''                    // 裸 token, 上游用 X-DashScope-API-Key: sk-...
};

// ?v=dev-proxy-env4 P1-1: 模块级缓存每个 provider 的 proxy instance
//   之前每次请求 new createProxyMiddleware(...) — v3.0.7 内部注册 end/abort/finish/close/error
//   5 个 listener 跟 IncomingMessage 互相持有引用, 长跑 (天级 PM2) 会 listener 累积
//   Express 已剥 /api/llm, req.url 是 /{provider}/{rest}。pathRewrite 剥掉 /{provider} 前缀
const _llmProxyPathRewrite = (path) => path.replace(/^\/[^/?]+/, '') || '/';
const _llmProxyInstances = {};
for (const [_p, _t] of Object.entries(LLM_TARGETS)) {
  _llmProxyInstances[_p] = createProxyMiddleware({
    target: _t,
    changeOrigin: true,
    pathRewrite: _llmProxyPathRewrite,
    on: {
      proxyRes: _proxyOpts.on.proxyRes,
      error: (err, _req, _res) => console.error(`[llm] ${_p} ${err.message}`)
    }
  });
}
// LLM 代理 — /api/llm/{provider}/{rest} → {LLM_TARGETS[provider]}/{rest}
// 例如: /api/llm/deepseek/v1/chat/completions → https://api.deepseek.com/v1/chat/completions
app.use('/api/llm', (req, res, next) => {
  // 从 /api/llm/{provider}/... 解析 provider (Express 已剥 /api/llm)
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
  // ?v=dev-proxy-env4: dev-proxy 启动时从 .env 读的 key, .env 永远是 source of truth (P0-1 修)
  //   之前 if (envKey && !req.headers.authorization) 注释反着 — 任何 XSS 都能用 fake Authorization 顶掉 .env key
  //   现在 .env 永远覆盖, 前端无法绕过
  // ?v=dev-proxy-env4: provider-specific auth header (P1-4 修)
  //   qwen 必须 X-DashScope-API-Key, 其余 Bearer Authorization
  const rawKey = LLM_KEYS[provider];
  const authHeader = LLM_AUTH_HEADERS[provider] || 'Authorization';
  const scheme = LLM_AUTH_SCHEMES[provider] !== undefined ? LLM_AUTH_SCHEMES[provider] : 'Bearer';
  if (rawKey && rawKey.trim()) {
    const headerValue = scheme ? `${scheme} ${rawKey.trim()}` : rawKey.trim();
    req.headers[authHeader.toLowerCase()] = headerValue;
    // P2-5: 不打印明文 key, 只打印 header 名 + provider + 长度 (调试可见)
    console.log(`[llm:diag] injected ${authHeader} for ${provider} (len=${rawKey.trim().length})`);
  } else if (rawKey !== undefined) {
    console.warn(`[llm:diag] ${provider} key 空白/未设置, 跳过注入 (请求会 401)`);
  }
  // ?v=dev-proxy-env4 P1-3: LLM 响应强制 no-store + 暴露 env fingerprint
  //   改在 onProxyRes 钩子实现 (v3.0.7 新事件 API on: { proxyRes })
  //   handler 里 res.setHeader 会被 proxy pipe 覆盖, 钩子里改 proxyRes.headers 才不会被覆盖
  // ?v=dev-proxy-env4 P1-1: 用缓存的 instance, 不再每次 new
  //   pathRewrite 共享 (剥 /{provider} 前缀), target 写死在 instance
  return _llmProxyInstances[provider](req, res, next);
});

// ===== 本地 LLM 透传 (绕过浏览器 CORS) =====
// 浏览器 → /api/local/v1/chat/completions → 上游 http://127.0.0.1:8082/v1/...
// 注意: 上游 host:port 可通过环境变量 LOCAL_LLM_TARGET 覆盖, 默认 8082 (llama.cpp)
const LOCAL_LLM_TARGET = process.env.LOCAL_LLM_TARGET || 'http://127.0.0.1:8082';
app.use('/api/local', createProxyMiddleware({
  target: LOCAL_LLM_TARGET,
  changeOrigin: true,
  pathRewrite: (path) => path.replace(/^\/api\/local/, ''),
  on: {
    proxyRes: _proxyOpts.on.proxyRes,
    error: (err, req, res) => {
      console.error(`[local-llm] ${req.method} ${req.url} → ${err.message}`);
      res.status(502).json({
        error: 'LOCAL_LLM_UNREACHABLE',
        message: `无法连接本地大模型 ${LOCAL_LLM_TARGET}: ${err.message}`,
        target: LOCAL_LLM_TARGET
      });
    },
    proxyReq: (proxyReq, req) => {
      console.log(`[local-llm] ${req.method} ${req.url} → ${LOCAL_LLM_TARGET}${req.url.replace(/^\/api\/local/, '')}`);
    }
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
    on: {
      // ?v=dev-proxy-env4 P0-A: 不能用 [fn1, fn2] 数组形式 — eventemitter3 抛 TypeError
      //   "The listener must be a function" → 整条 webdav 路由 500
      //   合并成单函数,顺序调用 _addCorsHeaders + access-control-expose-headers
      proxyRes: (proxyRes, req, res) => {
        _addCorsHeaders(proxyRes, req, res);
        proxyRes.headers['access-control-expose-headers'] = 'Last-Modified, ETag, Content-Length';
      },
      // ?v=dev-proxy-env4 P0-B: onProxyReq 也挪进 on: { proxyReq } — legacy 字段在 v3.0.7 静默失效
      proxyReq: (proxyReq, pReq) => {
        // 透传 Authorization: 用前端传的 username/password 拼 basic
        if (username || password) {
          const auth = Buffer.from(username + ':' + password).toString('base64');
          proxyReq.setHeader('Authorization', 'Basic ' + auth);
        }
      },
      // ?v=dev-proxy-env4 P0-B: onError 也挪进 on: { error } — legacy 字段在 v3.0.7 静默失效
      error: (err, pReq, pRes) => {
        console.error(`[webdav] ${pReq.method} ${pReq.url} → ${err.message}`);
        if (!pRes.headersSent) {
          pRes.status(502).json({ error: 'WEBDAV_UNREACHABLE', message: err.message });
        }
      }
    }
  };
  // 创建子 proxy, 调用它作为当前请求的 handler
  createProxyMiddleware(proxyOpts)(req, res, next);
}
app.use('/api/webdav', _webdavProxy);

// ===== 静态文件服务 (Electron 生产模式: 一个端口搞定全部) =====
// 匹配 /www/... 或直接根路径 /index.html
// 必须放在所有 /api/* 路由之后，否则 API 会被静态文件中间件拦截
app.use((req, res, next) => {
  // 跳过已匹配的 API 路由 (express 按顺序中间件匹配)
  if (req.url.startsWith('/api/') || req.url === '/health' || req.url === '/ping') {
    return next();
  }
  // 去掉 query string 和 hash (静态文件路径里不允许出现 ? 或 #)
  const pathname = req.url.split('?')[0].split('#')[0];
  // 只服务已存在的文件，防止路径遍历
  let filePath = pathname.startsWith('/www/')
    ? join(STATIC_ROOT, pathname.slice('/www/'.length))
    : join(STATIC_ROOT, pathname === '/' ? 'index.html' : pathname);
  if (!existsSync(filePath)) {
    // SPA fallback: 只对非文件类路径 fallback (排除 .json 等显式后缀)
    const knownExt = /\.(js|css|html|json|ico|svg|woff2?|ttf|png|jpg|jpeg|gif|webp|webmanifest|map)$/i.test(pathname);
    if (!knownExt) {
      filePath = join(STATIC_ROOT, 'index.html');
    } else {
      // 已知后缀的文件不存在 → 404
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found: ' + req.url);
      return;
    }
  }
  const ext = extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (e) {
    res.writeHead(500);
    res.end('Static file error: ' + e.message);
  }
});

const server = app.listen(PORT, '0.0.0.0', () => {
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
  console.log(`   Known CORS origins: ${KNOWN_ORIGINS.join(', ')}`);
  console.log('');
  console.log('⚠️  Make sure AKShare is running:');
  console.log('   pip install aktools');
  console.log('   python -m aktools http --host 127.0.0.1 8088');
});
