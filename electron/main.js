/**
 * Electron main process — StockMaster Windows 桌面端
 *
 * 启动行为:
 *   1) 启动 dev-proxy 子进程 (端口 8089, 代理 akshare / llm / fund)
 *   2) 启动 Vite dev 子进程 (端口 3003, dev-only HMR)
 *   3) 等两端都起来, 弹窗口加载 http://127.0.0.1:3003
 *
 * 生产模式 (electron-builder 打包后):
 *   - 不再启动 dev-proxy / vite, 直接加载 www/index.html (file://)
 *   - dev-proxy 用 dev mode 通过 settings.akshareProxyUrl 配置
 *
 * 退出: 关窗口 → 杀子进程 → 退出主进程
 */
const { app, BrowserWindow, shell, dialog, Menu, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const agentRegistry = require('./agent-registry');
const { registerExtension } = require('./agent-registry-ext');

// V13: 扩展工具集 (22 个域写工具, R/W 两档)
registerExtension(agentRegistry);

// ===== 启动前清理: 杀残留进程 (端口 8088/8089) =====
// 解决: 上次 Electron 崩溃后 dev-proxy / aktools / vite / static-server 进程残留,
//       端口占用导致新实例启动失败 (用户反馈: "运行 npx electron . 时自动杀一下死进程")
// 注意: execSync 走 cmd.exe (不是 PowerShell), 管道符直接用 | 不用 ^|
const { execSync } = require('child_process');
(function cleanupStaleProcesses() {
  const ports = [8088, 8089];
  const myPid = process.pid;
  let killed = 0;
  ports.forEach(port => {
    try {
      const out = execSync('netstat -ano | findstr ":' + port + ' "', { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'] });
      out.split(/\r?\n/).forEach(line => {
        const m = line.match(/LISTENING\s+(\d+)/);
        if (m) {
          const pid = parseInt(m[1]);
          if (pid && pid !== myPid) {
            try { execSync('taskkill /f /pid ' + pid, { stdio: 'ignore' }); killed++; } catch (e) { /* 进程可能已结束 */ }
          }
        }
      });
    } catch (e) { /* 端口未被占用, 正常跳过 */ }
  });
  if (killed > 0) console.log('[main] 已清理 ' + killed + ' 个残留进程 (端口 ' + ports.join(',') + ')');
})();

// ===== 自动更新 (electron-updater) =====
function setupAutoUpdater() {
  // v0.2.11 修: dev 模式 (npm run dev:electron) 也跑升级检查, 方便本地端到端测试升级流程
  //   - 走 env override (STOCKMASTER_FEED_URL) 或 package.json build.publish
  //   - 检查失败不阻塞应用, 只 console.log 排查信息
  if (!app.isPackaged && !process.env.STOCKMASTER_DEV_UPDATE) {
    console.log('[autoUpdater] dev 模式未开 STOCKMASTER_DEV_UPDATE, 跳过升级检查');
    return;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  // v0.2.11 修: 支持自定义 feed URL (env override), 用于自建 nginx/局域网共享/私服
  //   格式: STOCKMASTER_FEED_URL=https://update.example.com/stockmaster
  //   不设时走 package.json build.publish (github provider, owner=huaanwu, repo=-)
  const customFeed = process.env.STOCKMASTER_FEED_URL;
  if (customFeed) {
    console.log('[autoUpdater] 使用自定义 feed URL: ' + customFeed);
    autoUpdater.setFeedURL(customFeed);
  } else {
    // v0.2.11 修: 删 setFeedURL 显式调用 (跟 package.json publish 重复)
    //   electron-updater 默认读 package.json build.publish 段, 无需重复
    const pub = require('../package.json').build && require('../package.json').build.publish;
    if (pub) {
      console.log('[autoUpdater] feed: ' + pub.provider + ' ' + pub.owner + '/' + pub.repo);
    } else {
      console.warn('[autoUpdater] package.json build.publish 未配置, 升级功能不可用');
    }
  }

  autoUpdater.on('checking-for-update', () => {
    console.log('[autoUpdater] 检查更新中...');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[autoUpdater] 发现新版本: ' + info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info);
    }
  });

  autoUpdater.on('update-not-available', () => {
    console.log('[autoUpdater] 当前已是最新版本');
  });

  autoUpdater.on('download-progress', (p) => {
    console.log('[autoUpdater] 下载进度: ' + Math.round(p.percent) + '%');
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[autoUpdater] 下载完成: ' + info.version);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', info);
    }
  });

  autoUpdater.on('error', (err) => {
    console.error('[autoUpdater] 错误: ' + err.message);
    // B5 修复: 错误也推到渲染端, 让用户看到红色 toast (不只写 stderr)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-error', { message: err.message });
    }
  });

  ipcMain.on('start-download-update', () => {
    autoUpdater.downloadUpdate();
  });
  ipcMain.on('install-update', () => {
    // v0.2.14 修: 升级前 taskkill 进程树, NSIS 才能替换 .exe
    //   流程: 等 200ms IPC flush → taskkill → 等 500ms → quitAndInstall
    // v0.2.21 修: 用户报告 "一直说有后台阻止" → 等 3s + poll
    // v0.2.22 修 (用户报告 "下载好后点重启升级没反应"): 之前 taskkill 了 StockMaster.exe **自身**
    //   → 进程死了 → JS 上下文销毁 → quitAndInstall 永远不执行 → NSIS 永远不跑
    //   正确: **不要杀主进程**. quitAndInstall 内部:
    //     - spawnLog NSIS (detached:true, p.unref()) — 父退出后 NSIS 还活着
    //     - app.quit() → before-quit handler 杀子进程 (dev-proxy / 29037 static server)
    //   NSIS 启动时已 detached, 父退出它不死, 文件锁 free, NSIS 能替换 .exe
    setImmediate(() => {
      setTimeout(() => {
        try {
          console.log('[autoUpdater] 调 quitAndInstall (electron-updater spawn NSIS detached, 然后 app.quit)');
          // quitAndInstall(isSilent, isForceRunAfter) — BaseUpdater 签名只 2 个参数, 第三个被忽略
          autoUpdater.quitAndInstall(false, true);
        } catch (e) {
          console.error('[autoUpdater] quitAndInstall 失败:', e.message);
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('update-error', { message: '升级安装失败: ' + e.message });
          }
        }
      }, 200);
    });
  });

  // 启动 3 秒后静默检查更新
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error('[autoUpdater] 检查失败: ' + err.message);
    });
  }, 3000);
}

const IS_DEV = !app.isPackaged;
// 生产: __dirname/.. 是 app.asar 根, www 在 app 内; dev-proxy 在 resources/dev-proxy.mjs
// dev:  electron/.. → 项目根
const ROOT = IS_DEV ? path.resolve(__dirname, '..') : path.resolve(__dirname, '..');
const RESOURCES = IS_DEV ? ROOT : process.resourcesPath;
let mainWindow = null;
const children = [];

// ===== 子进程启动 =====
function spawnChild(name, cmd, args, cwd, color) {
  const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: color || '1', NO_AKTOOLS_AUTOSTART: name === 'proxy' ? '1' : undefined } });
  child._serviceName = name;
  children.push(child);
  const tag = '[' + name + ']';
  child.stdout.on('data', (d) => process.stdout.write(tag + ' ' + d));
  child.stderr.on('data', (d) => process.stderr.write(tag + ' ' + d));
  child.on('exit', (code) => {
    process.stdout.write(tag + ' exit ' + code + '\n');
    // v0.2.19: dev-proxy 死了自动重启 (auto-restart watchdog)
    // 背景: prod 模式 dev-proxy 是 child process, 任何原因 (aktools hang / 端口冲突 / OOM) 死掉都会让
    //       renderer selfCheck 全 ×, 用户得重启 StockMaster 才能恢复. 改成自动重启.
    if (name === 'proxy' && !app.isQuitting) {
      process.stdout.write('[proxy] 3s 后自动重启...\n');
      setTimeout(() => {
        if (app.isQuitting) return;
        // 找到 children[] 里这个已死的 child, 替换成新的
        const deadIdx = children.indexOf(child);
        const newProxy = _spawnDevProxy();
        if (deadIdx >= 0 && newProxy) children[deadIdx] = newProxy;
      }, 3000);
    }
  });
  return child;
}

// v0.2.19: 单独启 dev-proxy (auto-restart + IPC "重启 dev-proxy" 按钮都用)
function _spawnDevProxy() {
  try {
    const proxyScript = IS_DEV
      ? path.join(ROOT, 'scripts', 'dev-proxy.mjs')
      : path.join(RESOURCES, 'dev-proxy.mjs');
    if (!fs.existsSync(proxyScript)) {
      process.stderr.write('[proxy] script 不存在: ' + proxyScript + '\n');
      return null;
    }
    const c = spawn('node', [proxyScript], {
      cwd: IS_DEV ? ROOT : RESOURCES,
      env: {
        ...process.env,
        FORCE_COLOR: '1',
        NO_AKTOOLS_AUTOSTART: '1',
        // 生产模式: dev-proxy 同时 serve 静态文件, 需要知道 www 路径
        ...(IS_DEV
          ? {}
          : {
            NODE_PATH: require('path').join(RESOURCES, 'node_modules'),
            STATIC_ROOT: require('path').join(RESOURCES, 'app', 'www')
          })
      }
    });
    c.stdout.on('data', (d) => process.stdout.write('[proxy] ' + d));
    c.stderr.on('data', (d) => process.stderr.write('[proxy] ' + d));
    c.on('exit', (code) => {
      process.stdout.write('[proxy] exit ' + code + '\n');
      if (!app.isQuitting) {
        process.stdout.write('[proxy] 3s 后自动重启...\n');
        setTimeout(() => {
          if (app.isQuitting) return;
          const deadIdx = children.indexOf(c);
          const newProxy = _spawnDevProxy();
          if (deadIdx >= 0 && newProxy) children[deadIdx] = newProxy;
        }, 3000);
      }
    });
    process.stdout.write('[proxy] 启动 (pid ' + c.pid + ')\n');
    return c;
  } catch (e) {
    process.stderr.write('[proxy] 启动失败: ' + e.message + '\n');
    return null;
  }
}

/** 找一个可用的 Python 可执行文件, 优先 python3 / python, 被 pip 隔离时 fallback sys.executable */
function _pickPython() {
  const cand = ['python', 'python3', process.env.PYTHON || ''];
  const cp = require('child_process');
  for (const c of cand) {
    if (!c) continue;
    try { cp.execFileSync(c, ['--version'], { timeout: 5000 }); return c; } catch (_) {}
  }
  return null;
}

/** 自动启动 aktools Python 后端 (端口 8088), 如果已经在跑则跳过 */
async function _ensureAktools() {
  const http = require('http');
  const aktoolsTarget = process.env.AKSHARE_TARGET || 'http://127.0.0.1:8088';
  const url = new URL(aktoolsTarget);
  const alreadyUp = await new Promise((resolve) => {
    const req = http.get(aktoolsTarget + '/api/public/macro_china_lpr', { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 422);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  if (alreadyUp) {
    process.stdout.write('[aktools] 已有外部进程在 ' + aktoolsTarget + ', 不自动拉起\n');
    return;
  }
  const py = _pickPython();
  if (!py) {
    process.stdout.write('[aktools] ' + aktoolsTarget + ' 不通, 且没找到 python/python3, 跳过\n');
    return;
  }
  const cp = require('child_process');
  try { cp.execFileSync(py, ['-c', 'import aktools'], { timeout: 5000 }); }
  catch (_) {
    process.stdout.write('[aktools] ' + py + ' 在但 aktools 没装, 跳过\n');
    return;
  }
  process.stdout.write('[aktools] 自动拉起: ' + py + ' -m aktools --host ' + url.hostname + ' --port ' + url.port + '\n');
  spawnChild('aktools', py, ['-m', 'aktools', '--host', url.hostname, '--port', url.port], ROOT, '3');
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const req = http.get(aktoolsTarget + '/api/public/macro_china_lpr', { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 422);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) break;
    await new Promise(r => setTimeout(r, 1000));
  }
}
// _startStaticServer 已迁移到 dev-proxy.mjs (端口 8089 同时 serve 静态文件)

async function startBackend() {
  await _ensureAktools();

  // 检查目标 URL 是否可访问 (避免与外部已启动的服务冲突)
  async function _portUp(url, timeoutMs = 1000) {
    try { await waitForUrl(url, timeoutMs); return true; } catch (e) { return false; }
  }

  if (IS_DEV) {
    const proxyScript = path.join(ROOT, 'scripts', 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      // 如果端口 8089 已被占用 (外部 npm run dev 已启 proxy), 跳过
      const proxyUp = await _portUp('http://127.0.0.1:8089/health', 1000);
      if (!proxyUp) spawnChild('proxy', 'node', [proxyScript], ROOT, '1');
      else process.stdout.write('[startBackend] 检测到外部 dev-proxy 已在运行 (端口 8089), 跳过启动\n');
    }
    // 如果端口 3003 已被占用 (外部 vite 已启), 跳过
    const viteUp = await _portUp('http://127.0.0.1:3003', 1000);
    if (!viteUp) spawnChild('vite', 'npx', ['vite'], ROOT, '2');
    else process.stdout.write('[startBackend] 检测到外部 vite 已在运行 (端口 3003), 跳过启动\n');
    await waitForUrl('http://127.0.0.1:3003', 15000);
    await waitForUrl('http://127.0.0.1:8089/health', 5000).catch(() => {
      process.stderr.write('[startBackend] ⚠️ dev-proxy 启动 5s 内未就绪, selfCheck 会显示 ×\n');
    });
  } else {
    // v0.2.19: 用 _spawnDevProxy 走统一启停, 死了自动重启, IPC 也能手动重启
    const proxyScript = path.join(RESOURCES, 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      const c = _spawnDevProxy();
      if (c) children.push(c);
      // 8s 等就绪, fail 也不阻塞 (auto-restart watchdog 会救活)
      const ready = await waitForUrl('http://127.0.0.1:8089/health', 8000).then(() => true).catch(() => false);
      if (!ready) process.stderr.write('[startBackend] ⚠️ dev-proxy 启动 8s 内未就绪, 看 selfCheck 状态 (可手动点 🔄 重启 dev-proxy)\n');
    }
  }
}

function waitForUrl(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const http = require('http');
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => { res.resume(); resolve(); });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('timeout ' + url));
        else setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

// ===== 主窗口 =====
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#0d1117',
    title: 'StockMaster',
    icon: (() => {
      const candidates = [
        path.join(ROOT, 'www', 'icons', 'icon.ico'),
        path.join(RESOURCES, 'www', 'icons', 'icon.ico'),
        path.join(process.resourcesPath || '', 'www', 'icons', 'icon.ico')
      ];
      return candidates.find(p => p && fs.existsSync(p)) || candidates[0];
    })(),
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  if (IS_DEV) {
    mainWindow.loadURL('http://127.0.0.1:3003');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadURL('http://127.0.0.1:8089');
  }

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== 菜单 =====
function buildMenu() {
  const template = [
    {
      label: 'StockMaster',
      submenu: [
        { role: 'reload', label: '刷新' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'quit', label: '退出' }
      ]
    },
    {
      label: '数据',
      submenu: [
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ===== Headless 模式 (--agent-mode=headless) =====
/**
 * headless 模式: 不创建 BrowserWindow, 通过内置 HTTP endpoint 远程触发 AI 调度
 *
 * 设计:
 *   - agent:headless:invoke IPC channel — main 进程主动调工具, 与 agent:invoke (renderer→main) 反方向
 *   - /api/headless/run  HTTP endpoint — 外部/定时任务 POST 触发 AI strategy
 *   - 所有 tool 调用直接走 agentRegistry (不经过 IPC serialization)
 *   - V13 阶段 2: 主进程 Daemon — 60s tick 调度 news-refresh / portfolio-scan 等
 */
const { Daemon } = require('./daemon');

function setupHeadless() {
  // 注册 headless IPC channel (用于 main→main 自调用, 或者将来 Electron renderer+headless 混合模式)
  ipcMain.handle('agent:headless:invoke', async (event, name, args, ctx) => {
    process.stdout.write('[headless] invoke: ' + name + '\n');
    try {
      const result = await agentRegistry.invoke(name, args || {}, ctx || {});
      return result;
    } catch (e) {
      return { ok: false, error: e.message || String(e) };
    }
  });

  // app.on('headless:run') 事件触发器: 内部调度入口
  //   - HTTP endpoint POST /api/headless/run 时调用
  //   - 将来定时任务 / 飞书 webhook 回调也可触发
  app.on('headless:run', async (strategy, payload) => {
    process.stdout.write('[headless] 收到调度请求: ' + (strategy || 'agents') + '\n');
    try {
      const result = await agentRegistry.invoke('ai.runStrategy', { strategy: strategy || 'agents', payload: payload || {} }, {});
      return { ok: true, mode: 'headless', strategy: strategy || 'agents', result: result };
    } catch (e) {
      return { ok: false, mode: 'headless', strategy: strategy || 'unknown', error: e.message || String(e) };
    }
  });

  // G5: HTTP endpoint — 独立 HTTP server 监听 8090 端口 (不动 startBackend)
  //   POST /api/headless/run  body: { strategy: 'long'|'short'|'fund'|'agents', payload: {...} }
  //   替代 startBackend listener 修改, 简单可靠
  const HEADLESS_HTTP_PORT = 8090;
  const http = require('http');
  const headlessServer = http.createServer((req, res) => {
    // CORS (开发时浏览器跨域调)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    if (req.method === 'GET' && req.url === '/api/headless/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'headless', port: HEADLESS_HTTP_PORT }));
      return;
    }

    if (req.method === 'POST' && req.url === '/api/headless/run') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) { req.destroy(); } });
      req.on('end', async () => {
        let payload = {};
        try { payload = body ? JSON.parse(body) : {}; }
        catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'JSON parse failed: ' + e.message }));
          return;
        }
        const strategy = payload.strategy || 'agents';
        try {
          const result = await new Promise((resolve) => {
            // emit 事件, headless:run handler 处理; resolve(handler 返回值)
            app.emit('headless:run', strategy, payload);
            // 注: app.emit 不返回 handler 结果, 我们直接 await registry.invoke
            resolve(agentRegistry.invoke('ai.runStrategy', { strategy, payload }, {}));
          });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, strategy, result: await result }));
        } catch (e) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, strategy, error: e.message || String(e) }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'not found: ' + req.url }));
  });
  headlessServer.listen(HEADLESS_HTTP_PORT, '127.0.0.1', () => {
    process.stdout.write('[headless] HTTP 监听 127.0.0.1:' + HEADLESS_HTTP_PORT + ' (POST /api/headless/run)\n');
  });
  headlessServer.on('error', (e) => {
    process.stderr.write('[headless] HTTP server 失败: ' + e.message + '\n');
  });

  // 启动健康检查
  setInterval(async () => {
    try {
      const health = await new Promise((resolve) => {
        const req = http.get('http://127.0.0.1:8089/health', { timeout: 5000 }, (res) => {
          let body = '';
          res.on('data', (c) => { body += c; });
          res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: body.slice(0, 200) }));
        });
        req.on('error', (e) => resolve({ ok: false, error: e.code }));
        req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
      });
      process.stdout.write('[headless] heartbeat: dev-proxy ' + (health.ok ? 'OK' : 'FAIL') + (health.error ? ' (' + health.error + ')' : '') + '\n');
    } catch (e) {
      process.stderr.write('[headless] heartbeat 异常: ' + e.message + '\n');
    }
  }, 60000); // 每分钟心跳

  process.stdout.write('[headless] 已就绪, 等待 AI 调度请求\n');

  // V13 阶段 2: 启动主进程 Daemon — 60s tick 调度后台任务
  // 与 renderer 端 Core.Scheduler 并行不冲突 (daemon task 用 daemon.* 前缀命名)
  setupDaemon();

  // V13 阶段 3: 启动飞书 (WebSocket 长连); 凭证从环境变量读 (开发), 或从 Dexie kv 同步 (生产)
  setupFeishu({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET });
}

/** V13: Daemon — 主进程常驻调度器 */
const daemon = new Daemon({ runOnInit: true });
let _daemonConfigured = false;

function setupDaemon() {
  if (_daemonConfigured) return daemon;
  _daemonConfigured = true;
  // news-refresh: 每 30 分钟拉一次所有关注票新闻快照 (复用 V12 工具)
  // 注: 通过 executeJavaScript 调 renderer 端的 Core.News.snapshot.build
  daemon.register('daemon.news-refresh', 30 * 60 * 1000, async (now) => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) { console.warn('[daemon] news-refresh: 无窗口, 跳过'); return; }
    const r = await win.webContents.executeJavaScript(
      'window.Core && window.Core.News && window.Core.News.snapshot ? window.Core.News.snapshot.build() : null',
      true
    );
    if (r) console.log('[daemon] news-refresh: 拉了 ' + (r.codes || 0) + ' 只, ' + (r.itemCount || 0) + ' 条公告');
  }, { jitterMs: 2 * 60 * 1000, runOnInit: false });

  // heartbeat: 每分钟上报 daemon + agentRegistry 状态 (调试用)
  daemon.register('daemon.heartbeat', 60 * 1000, async (now) => {
    const status = daemon.status();
    const running = status.filter(t => t.running).map(t => t.name);
    process.stdout.write('[daemon] heartbeat: ' + status.length + ' task, 运行中=[' + running.join(',') + ']\n');
  }, { jitterMs: 5 * 1000, runOnInit: false });

  // v27 P0: steward-tick — 每 5 分钟推一次给 renderer 触发 Steward 扫描
  daemon.register('daemon.steward-tick', 5 * 60 * 1000, async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) { console.warn('[daemon] steward-tick: 无窗口, 跳过'); return; }
    win.webContents.send('steward:tick', { phase: 'preopen', ts: Date.now() });
  }, { jitterMs: 30 * 1000, runOnInit: false });

  // 注: portfolio-scan / morning-briefing / evening-review / weekly-attribution
  //     在后续阶段实现 (需要更多 agentRegistry 工具 + 飞书推送通道), 此处先留口子

  // 退出清理 hook
  app.on('before-quit', () => {
    daemon.stop();
    if (global._feishuApp) global._feishuApp.stop();
  });

  daemon.start();
  process.stdout.write('[daemon] 已启动\n');
  return daemon;
}

// ===== V13 阶段 3: 飞书应用模块 (WebSocket 长连 + 消息路由) =====
const { FeishuApp } = require('./feishu-app');
const { parseUserMessage } = require('./feishu-parser');
const { Permission } = require('./permission');
const { PendingConfirmations } = require('./feishu-pending');
let _permission = null;   // 单例, 飞书 setup 时初始化
const _pendingConfirms = new PendingConfirmations();

/**
 * 启动飞书 (从 Dexie kv 读凭证; kv 由 renderer 端 settings-sync 同步)
 * 凭证来源: 优先 global._feishuCreds (主进程 init 时从 kv 拿), fallback 环境变量
 */
function setupFeishu(creds) {
  // 优先级: 显式参数 > 缓存 > 环境变量
  const c = creds || _feishuCredsCache || {};
  const appId = c.appId || process.env.FEISHU_APP_ID || '';
  const appSecret = c.appSecret || process.env.FEISHU_APP_SECRET || '';
  if (!appId || !appSecret) {
    process.stdout.write('[feishu] 未配置凭证 (FEISHU_APP_ID/FEISHU_APP_SECRET 或 Dexie kv), 跳过启动\n');
    return null;
  }
  if (c.enabled === false) {
    process.stdout.write('[feishu] 凭证 feishu_enabled=false, 跳过启动\n');
    return null;
  }

  const feishu = new FeishuApp({
    appId,
    appSecret,
    onMessage: async (msg) => {
      // V13 阶段 5.6: openId 白名单
      const allowList = (c.allowedOpenIds || []).filter(Boolean);
      process.stdout.write('[feishu] 来消息 openId=' + msg.openId + ' text=' + JSON.stringify(msg.text) + ' allowList=' + JSON.stringify(allowList) + '\n');
      if (allowList.length > 0 && !allowList.includes(msg.openId)) {
        process.stdout.write('[feishu] openId 未在白名单: ' + msg.openId + ', 拒绝\n');
        return null;   // 不回消息
      }
      // V13 阶段 4: LLM 解析 → ToolRegistry
      try {
        const parsed = await parseUserMessage({
          text: msg.text,
          agentRegistry,
          openId: msg.openId,
          pending: _pendingConfirms,
          llmConfig: {
            provider: _llmConfigCache.provider || process.env.LLM_PROVIDER || 'deepseek',
            apiKey: _llmConfigCache.apiKey || process.env.LLM_API_KEY || '',
            baseURL: process.env.LLM_BASE_URL,
            model: _llmConfigCache.model || process.env.LLM_MODEL || ''
          }
        });
        if (parsed.error) return '[Feishu] 解析失败: ' + parsed.error;
        if (parsed.intent === 'chat') return parsed.reply || '(空回复)';
        if (parsed.intent === 'clarify') return '🤔 ' + parsed.question;
        if (parsed.intent === 'cancelled') {
          _pendingConfirms.consume(msg.openId);
          return '⛔ 已取消 ' + parsed.tool;
        }
        if (parsed.intent === 'confirm' && parsed.tool) {
          _pendingConfirms.set(msg.openId, { tool: parsed.tool, args: parsed.args, rationale: parsed.rationale });
          return '🤔 ' + (parsed.question || '请回复"确认"或"取消"');
        }
        if (parsed.tool) {
          // V13 阶段 5.2: W 类先发确认卡片
          // (parser 已经把 W 转 clarify, 这里是兜底 — 直接调也走确认)
          const meta = agentRegistry.get && agentRegistry.get(parsed.tool);
          if (meta && meta.risk === 'W' && _permission) {
            if (parsed.confirmReuse) {
              _pendingConfirms.consume(msg.openId);
            } else {
              _pendingConfirms.set(msg.openId, { tool: parsed.tool, args: parsed.args, rationale: parsed.rationale });
              const ok = await _permission.askConfirm(msg.openId, parsed.tool, parsed.args || {});
              if (!ok) return '⛔ ' + parsed.tool + ' 已取消 (用户拒绝或超时)';
              _pendingConfirms.consume(msg.openId);
            }
          } else if (meta && meta.risk === 'W' && !_permission) {
            _pendingConfirms.set(msg.openId, { tool: parsed.tool, args: parsed.args, rationale: parsed.rationale });
          }
          const r = await agentRegistry.invoke(parsed.tool, parsed.args || {}, { source: 'feishu', userOpenId: msg.openId });
          if (r.ok) return '✅ ' + parsed.tool + ' 成功: ' + JSON.stringify(r.data).slice(0, 800);
          return '❌ ' + parsed.tool + ' 失败: ' + r.error;
        }
        return '[Feishu] 未知解析结果: ' + JSON.stringify(parsed);
      } catch (e) {
        return '[Feishu] handler 异常: ' + e.message;
      }
    },
    onAction: async (act) => {
      // 卡片按钮回调 → permission 匹配
      if (_permission && act.action && act.action.askId) {
        const handled = _permission.handleAction(act.action.askId, act.action.decision);
        if (handled) {
          // 给用户回执
          await feishu.sendText(act.openId, act.action.decision === 'confirm' ? '✅ 已确认, 正在执行...' : '❌ 已取消');
        }
      }
    },
    onError: (e) => process.stderr.write('[feishu] ' + e.message + '\n'),
    onStatus: (s) => {
      process.stdout.write('[feishu] 状态: ' + (s.connected ? '已连' : '断') + (s.lastError ? ' (' + s.lastError + ')' : '') + '\n');
      // V13 5.4: tray 菜单显示最新飞书状态
      refreshTrayMenu();
    }
  });

  // V13 阶段 5.2: 初始化 Permission + attachTo
  _permission = new Permission({ timeoutMs: 5 * 60 * 1000 });
  _permission.attachTo(feishu);

  feishu.start().then((ok) => {
    if (ok) process.stdout.write('[feishu] 已启动, app_id=' + appId.slice(0, 8) + '...\n');
    else process.stderr.write('[feishu] 启动失败\n');
  });
  global._feishuApp = feishu;
  return feishu;
}

// ===== 退出清理 =====
function killChildren() {
  for (const c of children) {
    try {
      // Windows 上 child.kill('SIGTERM') 只杀直接子进程,
      // 用 taskkill /t 杀整棵树 (dev-proxy → aktools)
      if (c.pid) {
        const cp = require('child_process');
        try { cp.execSync('taskkill /f /t /pid ' + c.pid, { stdio: 'ignore', timeout: 2000 }); } catch (_) {}
      }
    } catch (_) {}
  }
}

// ===== CLI 参数解析 =====
const AGENT_MODE = process.argv.includes('--agent-mode=headless');
if (AGENT_MODE) process.stdout.write('[main] 启动模式: headless (无窗口)\n');

// ===== 主入口 =====
// ===== 全局崩溃保护 (V13 fix: unhandled rejection / uncaught exception 不杀死进程) =====
process.on('unhandledRejection', (reason, p) => {
  process.stderr.write('[crash] UnhandledRejection: ' + (reason?.message || reason || String(reason)) + '\n');
});
process.on('uncaughtException', (err) => {
  process.stderr.write('[crash] UncaughtException: ' + (err?.message || err) + '\n' + (err?.stack || '').slice(0, 500) + '\n');
});

app.whenReady().then(async () => {
  buildMenu();
  await startBackend();
  if (!AGENT_MODE) {
    createWindow();
    setupAutoUpdater();
    setupDaemon();
    // V13 阶段 5.4: 启 tray (关窗不退出, 飞书/daemon 继续常驻)
    setupTray();
    // 桌面模式也启飞书 (用户关窗不影响 daemon + feishu, 见 before-quit)
    setupFeishu({ appId: process.env.FEISHU_APP_ID, appSecret: process.env.FEISHU_APP_SECRET });
  } else {
    // headless 模式: 注册 headless IPC channel + 启动 AI
    setupHeadless();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && !AGENT_MODE) createWindow();
  });
});

// ===== V13 阶段 5.4: 桌面关窗 → tray 常驻 =====
// 关窗口时只 hide (不 quit), 飞书 + daemon 继续跑; 真正退出走菜单/Tray
let _tray = null;
let _trayEnabled = false;

function setupTray() {
  if (_tray) return _tray;
  try {
    const { Tray, Menu, nativeImage } = require('electron');
    // 优先用 www/icons/icon.ico, fallback 空图标
    const iconCandidates = [
      require('path').join(ROOT, 'www', 'icons', 'icon.ico'),
      require('path').join(RESOURCES, 'www', 'icons', 'icon.ico')
    ];
    let img;
    for (const p of iconCandidates) {
      try {
        img = nativeImage.createFromPath(p);
        if (!img.isEmpty()) break;
      } catch (_) {}
    }
    if (!img || img.isEmpty()) img = nativeImage.createEmpty();
    _tray = new Tray(img);
    _tray.setToolTip('StockMaster 管家常驻中');
    _tray.setContextMenu(Menu.buildFromTemplate([
      { label: '🚀 StockMaster (管家常驻中)', enabled: false },
      { type: 'separator' },
      { label: '📊 显示主窗口', click: () => { _showMainWindow(); } },
      { label: '📱 飞书状态: ' + (global._feishuApp && global._feishuApp.isConnected() ? '✅ 已连' : '❌ 断'), enabled: false },
      { type: 'separator' },
      { label: '❌ 退出 StockMaster', click: () => { app.isQuitting = true; app.quit(); } }
    ]));
    _tray.on('click', () => { _showMainWindow(); });
    _trayEnabled = true;
    process.stdout.write('[tray] 已启动\n');
    return _tray;
  } catch (e) {
    process.stderr.write('[tray] 启动失败: ' + e.message + '\n');
    return null;
  }
}

function _showMainWindow() {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    const win = wins[0];
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else if (!AGENT_MODE) {
    createWindow();
  }
}

function refreshTrayMenu() {
  if (!_tray) return;
  const { Menu } = require('electron');
  _tray.setContextMenu(Menu.buildFromTemplate([
    { label: '🚀 StockMaster (管家常驻中)', enabled: false },
    { type: 'separator' },
    { label: '📊 显示主窗口', click: () => { _showMainWindow(); } },
    { label: '📱 飞书状态: ' + (global._feishuApp && global._feishuApp.isConnected() ? '✅ 已连' : '❌ 断'), enabled: false },
    { type: 'separator' },
    { label: '❌ 退出 StockMaster', click: () => { app.isQuitting = true; app.quit(); } }
  ]));
}

app.on('window-all-closed', () => {
  // V13: 关窗不退出, 飞书 + daemon 继续跑 (tray 常驻)
  // 真正退出走 tray 菜单 "❌ 退出 StockMaster" 或 menu bar
  if (!_trayEnabled) {
    // tray 没启 (开发模式或 headless) 才真退出
    killChildren();
    if (process.platform !== 'darwin') app.quit();
  } else {
    process.stdout.write('[main] 窗口已关, 管家继续常驻 (Tray 在系统托盘)\n');
    refreshTrayMenu();
  }
});

app.on('before-quit', () => { app.isQuitting = true; killChildren(); });
process.on('exit', killChildren);

// ===== v0.2.19: dev-proxy 重启 IPC (renderer 调这个手动重启 dev-proxy) =====
ipcMain.handle('restart-dev-proxy', async () => {
  process.stdout.write('[main] 收到 renderer 重启 dev-proxy 请求\n');
  // 找到 children[] 里名为 proxy 的, kill, 然后 spawn 新的
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    // 老的 spawnChild 启动的 child 没有 ._isProxy 标记, 简单按 pid 对比 proxy script 路径难, 用启发式
    // _spawnDevProxy 启动的 child stdout 写了 [proxy] tag, 但 runtime 不能直接判断
    // 直接遍历 kill 全部 ._v0219Spawned (新) 或 .exitCode===null (老)
    if (c.exitCode === null && c.signalCode === null) {
      // 还活着, 但只 kill 我们认为的 proxy (启发式: spawn args 含 'dev-proxy.mjs')
      const args = c.spawnargs ? c.spawnargs.join(' ') : '';
      if (args.includes('dev-proxy.mjs')) {
        try { c.kill('SIGTERM'); } catch (_) {}
        // 替换为新的
        const newProxy = _spawnDevProxy();
        if (newProxy) children[i] = newProxy;
        // 等 2s 拿 health
        const ready = await waitForUrl('http://127.0.0.1:8089/health', 4000).then(() => true).catch(() => false);
        return { ok: ready, message: ready ? 'dev-proxy 已重启' : '重启了但 4s 内未就绪' };
      }
    }
  }
  // 没找到活的, 直接启
  const newProxy = _spawnDevProxy();
  if (newProxy) children.push(newProxy);
  const ready = await waitForUrl('http://127.0.0.1:8089/health', 4000).then(() => true).catch(() => false);
  return { ok: ready, message: ready ? 'dev-proxy 已启动' : '启动了但 4s 内未就绪' };
});

// ===== 服务管理 IPC (V13 统一启动/重启面板) =====
ipcMain.handle('health-all', async () => {
  const http = require('http');
  const probe = (url, timeout = 3000) => new Promise(resolve => {
    const req = http.get(url, { timeout }, res => { res.resume(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 400, status: res.statusCode }); });
    req.on('error', e => resolve({ ok: false, error: e.code || e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
  });
  const [dp, akt] = await Promise.all([
    probe('http://127.0.0.1:8089/health', 3000),
    probe('http://127.0.0.1:8088/api/public/macro_china_lpr', 3000)
  ]);
  const feishuStatus = global._feishuApp ? (global._feishuApp.isConnected ? global._feishuApp.isConnected() : false) : false;
  return {
    services: [
      { name: 'dev-proxy', ok: dp.ok, error: dp.error, port: 8089 },
      { name: 'aktools', ok: akt.ok, error: akt.error, port: 8088 },
      { name: '飞书', ok: feishuStatus, error: feishuStatus ? null : (global._feishuApp ? '未连接' : '未配置'), port: null }
    ]
  };
});

ipcMain.handle('restart-aktools', async () => {
  // kill existing aktools child
  for (const c of children) {
    if (c._serviceName === 'aktools') {
      try { c.kill('SIGTERM'); } catch (_) {}
      break;
    }
  }
  await _ensureAktools();
  const ok = await waitForUrl('http://127.0.0.1:8088/api/public/macro_china_lpr', 15000).then(() => true).catch(() => false);
  return { ok, message: ok ? 'aktools 已启动' : '启动超时, 看控制台日志' };
});

ipcMain.handle('restart-vite', async () => {
  if (!IS_DEV) return { ok: false, message: '生产模式无 Vite' };
  for (const c of children) {
    if (c._serviceName === 'vite') {
      try { c.kill('SIGTERM'); } catch (_) {}
      break;
    }
  }
  spawnChild('vite', 'npx', ['vite'], ROOT, '2');
  const ok = await waitForUrl('http://127.0.0.1:3003', 15000).then(() => true).catch(() => false);
  return { ok, message: ok ? 'Vite 已重启' : '启动超时' };
});

ipcMain.handle('restart-feishu', async () => {
  if (global._feishuApp) {
    global._feishuApp.stop();
    global._feishuApp = null;
  }
  const f = setupFeishu(_feishuCredsCache);
  if (f) global._feishuApp = f;
  return { ok: true, message: '飞书已重启' };
});

// ===== AI Agent 工具调用 (IPC) =====
// 渲染进程通过 electronAPI.invokeAgent(name, args) 调用,
// 主进程路由到 agent-registry 的对应 handler
ipcMain.handle('agent:list', () => agentRegistry.list());

ipcMain.handle('agent:invoke', async (event, name, args) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  // args.llmBaseUrl 可选, 渲染进程把 Core.State.ai 配置透传过来
  // 这样 data.health 能真实探测用户当前用的 LLM endpoint 而不是写死的 11434
  const ctx = {
    webContents: event.sender,
    llmBaseUrl: (args && args.__llmBaseUrl) || process.env.LLM_BASE_URL || 'http://127.0.0.1:11434'
  };
  // 把 __llmBaseUrl / __llmApiKey / __page 等内部字段从 args 删掉, 不让它传到工具 handler 里污染实际输入
  if (args) {
    const clean = {};
    for (const k of Object.keys(args)) {
      if (k.startsWith('__')) continue;  // 跳过所有 __ 前缀的内部字段
      clean[k] = args[k];
    }
    args = clean;
  }
  const result = await agentRegistry.invoke(name, args, ctx);
  return result;
});

ipcMain.handle('agent:openExternal', async (event, url) => {
  if (!/^https?:\/\//.test(url)) return { ok: false, error: '非 http(s) URL' };
  await shell.openExternal(url);
  return { ok: true };
});

// ===== V13: 飞书凭证 IPC (renderer → main 推送 Dexie kv 里的凭证) =====
let _feishuCredsCache = null;   // { appId, appSecret, allowedOpenIds, enabled }

// V13: LLM 配置缓存 (renderer → main 同步)
let _llmConfigCache = { provider: 'deepseek', apiKey: '', model: '' };

ipcMain.handle('feishu:set-creds', async (event, creds) => {
  if (!creds || typeof creds !== 'object') {
    _feishuCredsCache = null;
    return { ok: true };
  }
  _feishuCredsCache = {
    appId: creds.appId || '',
    appSecret: creds.appSecret || '',
    allowedOpenIds: Array.isArray(creds.allowedOpenIds) ? creds.allowedOpenIds : [],
    enabled: creds.enabled !== false
  };
  // V13: 同时接收 LLM 配置 (renderer 设置页同步过来)
  if (creds.llmConfig) {
    _llmConfigCache = {
      provider: creds.llmConfig.provider || 'deepseek',
      apiKey: creds.llmConfig.apiKey || '',
      model: creds.llmConfig.model || ''
    };
  }
  process.stdout.write('[feishu] 凭证已从 renderer 同步: appId=' + (_feishuCredsCache.appId ? _feishuCredsCache.appId.slice(0, 8) + '...' : '(空)') + ', 白名单=' + _feishuCredsCache.allowedOpenIds.length + ' 人\n');
  // 如果飞书已经在跑, 凭证变了需要重启 feishu; 如果还没启动, 收到凭证后立即启动
  if (global._feishuApp && global._feishuApp.isConnected && global._feishuApp.isConnected()) {
    process.stdout.write('[feishu] 凭证变更, 重启飞书连接\n');
    global._feishuApp.stop();
    setTimeout(() => {
      const f = setupFeishu(_feishuCredsCache);
      if (f) global._feishuApp = f;
    }, 500);
  } else if (_feishuCredsCache.appId && _feishuCredsCache.appSecret) {
    // 首次收到凭证, 立即启动飞书 WS
    const f = setupFeishu(_feishuCredsCache);
    if (f) global._feishuApp = f;
  }
  return { ok: true };
});

ipcMain.handle('feishu:get-creds', async () => {
  return _feishuCredsCache || { appId: '', appSecret: '', allowedOpenIds: [], enabled: false };
});
