/**
 * AI Agent 工具注册表 — 主进程侧
 *
 * 每个工具有:
 *   - name: 工具名 (供 LLM 引用)
 *   - risk: 'L' | 'M' | 'H' 风险等级
 *     L = 自动执行 (读/查询/可逆操作)
 *     M = 弹窗确认后执行 (应用生命周期)
 *     H = 弹窗 + 高亮警告后执行 (写文件/不可逆)
 *   - description + input_schema: LLM 调用协议 (Claude/OpenAI 兼容)
 *   - handler(args, ctx): 主进程执行, ctx 含 mainWindow / userDataPath / 状态
 *
 * 渲染进程通过 preload 暴露的 electronAPI.invokeAgent(name, args) 调用,
 * 由 ipcMain.handle('agent:invoke') 路由到对应 handler。
 * 授权策略由 renderer 的分级弹窗 (Core.Agent.confirmIfNeeded) 处理,
 * 主进程不参与授权决策 (保持单一可信源在 UI 层)。
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, shell } = require('electron');

/** 当前注册的 handler 集合 */
const registry = new Map();

function register(tool) {
  if (!tool.name || !tool.handler) {
    throw new Error('[Agent] 工具注册失败: 缺 name 或 handler');
  }
  if (!['L', 'M', 'H'].includes(tool.risk)) {
    throw new Error('[Agent] 工具 ' + tool.name + ' 风险等级必须是 L/M/H');
  }
  registry.set(tool.name, tool);
  return tool;
}

function get(name) { return registry.get(name); }
function list() { return Array.from(registry.values()).map(t => ({
  name: t.name, risk: t.risk, description: t.description
})); }

/** 渲染进程调用入口 */
async function invoke(name, args, ctx) {
  const tool = registry.get(name);
  if (!tool) throw new Error('未知工具: ' + name);
  try {
    const out = await tool.handler(args || {}, ctx || {});
    return { ok: true, data: out };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

// ===== 内置工具: 行情/数据查询 (risk: L) =====
register({
  name: 'data.health',
  risk: 'L',
  description: '检查 akshare / dev-proxy / LLM provider 是否在线,返回布尔状态 + 错误详情',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async (_args, ctx) => {
    const http = require('http');
    const probe = (url) => new Promise(resolve => {
      const req = http.get(url, { timeout: 5000 }, (res) => {
        const ok = res.statusCode === 200 || res.statusCode === 422;
        resolve({ ok, status: res.statusCode });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.code || e.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    });
    // v0.2.19: dev-proxy /health 返 akshare_status, 走 dev-proxy 间接探 aktools 更鲁棒
    //   (aktools 8088 直连可能跟 dev-proxy 不同步, dev-proxy 死了 8088 也探不到)
    const dp = await probe('http://127.0.0.1:8089/health');
    let aktoolsOk = false, aktoolsDetail = { url: 'http://127.0.0.1:8089/health (akshare_status)' };
    if (dp.ok) {
      try {
        // 复用 dp 抓到的 body (http.get 是一次性 stream, 重新发一次)
        const j = await new Promise((resolve) => {
          const req = http.get('http://127.0.0.1:8089/health', { timeout: 3000 }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; if (body.length > 4096) body = body.slice(0, 4096); });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
          });
          req.on('error', () => resolve(null));
          req.on('timeout', () => { req.destroy(); resolve(null); });
        });
        if (j) { aktoolsOk = j.akshare_status === 'ok'; aktoolsDetail.akshare_status = j.akshare_status; aktoolsDetail.akshare_target = j.akshare_target; }
      } catch (e) { aktoolsDetail.error = e.message; }
    } else {
      aktoolsDetail.error = 'dev-proxy 不可达, aktools 没法探';
    }
    // v0.2.19: llmBaseUrl 优先用 renderer 传的 localEndpoint (用户的 8082 llama.cpp), 不是远程 baseURL
    const llmUrl = ctx.llmBaseUrl ? (ctx.llmBaseUrl.endsWith('/') ? ctx.llmBaseUrl : ctx.llmBaseUrl + '/') + 'models' : null;
    const lm = llmUrl ? await probe(llmUrl) : { ok: false, error: 'no __llmBaseUrl' };
    return {
      aktools: aktoolsOk,
      devProxy: dp.ok,
      llm: lm.ok,
      detail: {
        aktools: aktoolsDetail,
        devProxy: { url: 'http://127.0.0.1:8089/health', ...dp },
        llm: { url: llmUrl || '(not configured)', ...lm }
      }
    };
  }
});

register({
  name: 'data.listAccounts',
  risk: 'L',
  description: '列出当前模拟盘/实盘账户的现金、持仓数、总资产',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    // 通过 IPC 转发到 renderer 调用 Core.Portfolio.getAssets
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (!win) return { error: '无窗口' };
    return win.webContents.executeJavaScript('window.Core.Portfolio.getAssets({paper: false})');
  }
});

// ===== 内置工具: 应用生命周期 (risk: M, 默认需确认) =====
register({
  name: 'app.restart',
  risk: 'M',
  description: '重启 Electron 应用 (用户授权后调用)',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    app.relaunch();
    app.quit();
    return { restarted: true };
  }
});

register({
  name: 'app.checkUpdate',
  risk: 'M',
  description: '触发一次更新检查, 有新版本时返回版本号',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  handler: async () => {
    const { autoUpdater } = require('electron-updater');
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ available: false, timeout: true }), 8000);
      autoUpdater.once('update-available', (info) => {
        clearTimeout(timer);
        resolve({ available: true, version: info.version });
      });
      autoUpdater.once('update-not-available', () => {
        clearTimeout(timer);
        resolve({ available: false });
      });
      autoUpdater.checkForUpdates().catch((e) => {
        clearTimeout(timer);
        resolve({ available: false, error: e.message });
      });
    });
  }
});

// ===== 内置工具: 本地文件 (读 L / 写 H) =====
register({
  name: 'fs.readUserFile',
  risk: 'L',
  description: '读取用户数据目录下的文本文件 (复盘.md / 持仓.json 等), 限制 1MB',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string', description: '相对于 userData 的路径, 如 "journal/2025-01.md"' }
    },
    required: ['relPath'],
    additionalProperties: false
  },
  handler: async ({ relPath }) => {
    const safe = path.normalize(relPath).replace(/^([\\/]+)/, '');
    if (safe.includes('..')) throw new Error('路径越界');
    const full = path.join(app.getPath('userData'), safe);
    if (!fs.existsSync(full)) return { missing: true, path: full };
    const stat = fs.statSync(full);
    if (stat.size > 1024 * 1024) throw new Error('文件超过 1MB 限制');
    return { content: fs.readFileSync(full, 'utf8'), size: stat.size };
  }
});

register({
  name: 'fs.writeUserFile',
  risk: 'H',
  description: '写入用户数据目录下的文本文件, 会覆盖原内容 (高危: 不可逆)',
  input_schema: {
    type: 'object',
    properties: {
      relPath: { type: 'string' },
      content: { type: 'string' }
    },
    required: ['relPath', 'content'],
    additionalProperties: false
  },
  handler: async ({ relPath, content }) => {
    const safe = path.normalize(relPath).replace(/^([\\/]+)/, '');
    if (safe.includes('..')) throw new Error('路径越界');
    const full = path.join(app.getPath('userData'), safe);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
    return { written: true, size: Buffer.byteLength(content, 'utf8'), path: full };
  }
});

register({
  name: 'shell.openExternal',
  risk: 'M',
  description: '用系统浏览器打开 URL (公告/研报/新闻链接)',
  input_schema: {
    type: 'object',
    properties: { url: { type: 'string' } },
    required: ['url'],
    additionalProperties: false
  },
  handler: async ({ url }) => {
    if (!/^https?:\/\//.test(url)) throw new Error('非 http(s) URL');
    await shell.openExternal(url);
    return { opened: url };
  }
});

module.exports = { register, get, list, invoke };