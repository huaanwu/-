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

// ===== 自动更新 (electron-updater) =====
function setupAutoUpdater() {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // 仓库实际名为 "-"，electron-updater 默认读 package.json build.publish,
  // 但读不到时可显式指定 feed URL 作 fallback
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: 'huaanwu',
    repo: '-'
  });

  autoUpdater.on('checking-for-update', () => {
    process.stdout.write('[autoUpdater] 检查更新中...\n');
  });

  autoUpdater.on('update-available', (info) => {
    process.stdout.write('[autoUpdater] 发现新版本: ' + info.version + '\n');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-available', info);
    }
  });

  autoUpdater.on('update-not-available', () => {
    process.stdout.write('[autoUpdater] 当前已是最新版本\n');
  });

  autoUpdater.on('download-progress', (p) => {
    process.stdout.write('[autoUpdater] 下载进度: ' + Math.round(p.percent) + '%\n');
  });

  autoUpdater.on('update-downloaded', (info) => {
    process.stdout.write('[autoUpdater] 下载完成: ' + info.version + '\n');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('update-downloaded', info);
    }
  });

  autoUpdater.on('error', (err) => {
    process.stderr.write('[autoUpdater] 错误: ' + err.message + '\n');
  });

  ipcMain.on('start-download-update', () => {
    autoUpdater.downloadUpdate();
  });
  ipcMain.on('install-update', () => {
    autoUpdater.quitAndInstall(false, true);
  });

  // 启动 3 秒后静默检查更新
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      process.stderr.write('[autoUpdater] 检查失败: ' + err.message + '\n');
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
  const child = spawn(cmd, args, { cwd, shell: true, env: { ...process.env, FORCE_COLOR: color || '1' } });
  children.push(child);
  const tag = '[' + name + ']';
  child.stdout.on('data', (d) => process.stdout.write(tag + ' ' + d));
  child.stderr.on('data', (d) => process.stderr.write(tag + ' ' + d));
  child.on('exit', (code) => process.stdout.write(tag + ' exit ' + code + '\n'));
  return child;
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

/** V14: 启动内置静态 HTTP 服务器 (避免 file:// fetch CORS 问题) */
function _startStaticServer(port) {
  const http = require('http');
  let staticDir;
  if (IS_DEV) {
    staticDir = path.join(ROOT, 'www');
  } else {
    staticDir = path.join(RESOURCES, 'app', 'www');
  }
  if (!fs.existsSync(staticDir)) {
    process.stderr.write('[static] www 目录不存在: ' + staticDir + '\n');
    return;
  }
  const DEVO_PROXY_TARGET = 'http://127.0.0.1:8089';
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api/') || req.url === '/health') {
      const options = {
        hostname: '127.0.0.1',
        port: 8089,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: '127.0.0.1:8089' }
      };
      const proxyReq = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', (e) => { res.writeHead(502); res.end(JSON.stringify({ error: 'dev-proxy 不通', detail: e.message })); });
      req.pipe(proxyReq);
      return;
    }
    let filePath = path.join(staticDir, req.url === '/' ? 'index.html' : req.url);
    if (!fs.existsSync(filePath)) filePath = path.join(staticDir, 'index.html');
    const ext = path.extname(filePath).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
    res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(filePath));
  });
  server.listen(port, '127.0.0.1', () => process.stdout.write('[static] 静态文件服务器 -> http://127.0.0.1:' + port + '/\n'));
  server.on('error', (e) => process.stderr.write('[static] 启动失败: ' + e.message + '\n'));
  const cleanup = () => { try { server.close(); } catch (_) {} };
  children.push({ kill: cleanup });
  process.on('exit', cleanup);
}

async function startBackend() {
  await _ensureAktools();

  if (IS_DEV) {
    const proxyScript = path.join(ROOT, 'scripts', 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      spawnChild('proxy', 'node', [proxyScript], ROOT, '1');
    }
    spawnChild('vite', 'npx', ['vite'], ROOT, '2');
    await waitForUrl('http://127.0.0.1:3003', 15000);
    await waitForUrl('http://127.0.0.1:8089/health', 5000).catch(() => null);
  } else {
    const proxyScript = path.join(RESOURCES, 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      spawnChild('proxy', 'node', [proxyScript], RESOURCES, '1');
      await waitForUrl('http://127.0.0.1:8089/health', 8000).catch(() => null);
    }
    _startStaticServer(29037);
    await waitForUrl('http://127.0.0.1:29037', 3000).catch(() => {
      process.stderr.write('[startBackend] 静态服务器未在 3s 内就绪, 继续尝试加载窗口\n');
    });
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
    mainWindow.loadURL('http://127.0.0.1:29037');
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

// ===== 退出清理 =====
function killChildren() {
  for (const c of children) {
    try { c.kill('SIGTERM'); } catch (_) {}
  }
}

app.whenReady().then(async () => {
  buildMenu();
  await startBackend();
  createWindow();
  setupAutoUpdater();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  killChildren();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killChildren);
process.on('exit', killChildren);
