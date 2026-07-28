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
const { app, BrowserWindow, shell, dialog, Menu } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

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
  const tag = `[${name}]`;
  child.stdout.on('data', (d) => process.stdout.write(`${tag} ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`${tag} ${d}`));
  child.on('exit', (code) => process.stdout.write(`${tag} exit ${code}\n`));
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
  // 先探一下, 通就跳过
  const alreadyUp = await new Promise((resolve) => {
    const req = http.get(`${aktoolsTarget}/api/public/macro_china_lpr`, { timeout: 3000 }, (res) => {
      resolve(res.statusCode === 200 || res.statusCode === 422);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
  if (alreadyUp) {
    process.stdout.write(`[aktools] 已有外部进程在 ${aktoolsTarget}, 不自动拉起\n`);
    return;
  }
  const py = _pickPython();
  if (!py) {
    process.stdout.write(`[aktools] ${aktoolsTarget} 不通, 且没找到 python/python3, 跳过自动拉起\n`);
    return;
  }
  // 确认 aktools 模块已装
  const cp = require('child_process');
  try { cp.execFileSync(py, ['-c', 'import aktools'], { timeout: 5000 }); }
  catch (_) {
    process.stdout.write(`[aktools] ${py} 在但 aktools 没装, 跳过自动拉起 (手动: ${py} -m pip install aktools)\n`);
    return;
  }
  process.stdout.write(`[aktools] ${aktoolsTarget} 不通, 自动拉起: ${py} -m aktools --host ${url.hostname} --port ${url.port}\n`);
  spawnChild('aktools', py, ['-m', 'aktools', '--host', url.hostname, '--port', url.port], ROOT, '3');
  // 等端口起来 (最多 20s)
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const ok = await new Promise(resolve => {
      const req = http.get(`${aktoolsTarget}/api/public/macro_china_lpr`, { timeout: 2000 }, (res) => {
        resolve(res.statusCode === 200 || res.statusCode === 422);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (ok) break;
    await new Promise(r => setTimeout(r, 1000));
  }
}

async function startBackend() {
  // 0) 自动拉起 aktools (生产/开发 都一样)
  await _ensureAktools();

  if (IS_DEV) {
    // dev mode: 启动 dev-proxy + vite (跟 npm run dev 一致)
    const proxyScript = path.join(ROOT, 'scripts', 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      spawnChild('proxy', 'node', [proxyScript], ROOT, '1');
    }
    spawnChild('vite', 'npx', ['vite'], ROOT, '2');
    // 等 vite 起来
    await waitForUrl('http://127.0.0.1:3003', 15000);
    await waitForUrl('http://127.0.0.1:8089/health', 5000).catch(() => null);
  } else {
    // 生产模式: 启动 dev-proxy (用户需本机跑 aktools :8088, 否则前端会显示降级)
    const proxyScript = path.join(RESOURCES, 'dev-proxy.mjs');
    if (fs.existsSync(proxyScript)) {
      // 把 extraResources 里的 node_modules 加到 NODE_PATH, 让 dev-proxy 找得到 express
      const proxyModules = path.join(RESOURCES, 'node_modules');
      spawnChild('proxy', 'node',
        [proxyScript],
        RESOURCES,
        '1');
      await waitForUrl('http://127.0.0.1:8089/health', 8000).catch(() => null);
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
      // 不允许跨域, 配合 dev-proxy 处理
    }
  });

  const indexPath = path.join(ROOT, 'www', 'index.html');
  if (IS_DEV) {
    mainWindow.loadURL('http://127.0.0.1:3003');
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    if (fs.existsSync(indexPath)) {
      mainWindow.loadFile(indexPath);
    } else {
      dialog.showErrorBox('StockMaster 启动失败', `找不到入口: ${indexPath}\n请先 npm run build, 然后用 electron-builder 打包`);
      app.quit();
      return;
    }
  }

  // 外链走系统默认浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ===== 菜单 (极简, 隐藏 MenuBar) =====
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