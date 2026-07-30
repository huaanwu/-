const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installUpdate: () => ipcRenderer.send('install-update'),

  // ===== 自动升级事件订阅 (B5 修复: 之前漏, 渲染端拿不到新版本提示) =====
  // 主进程 autoUpdater 发 'update-available' / 'update-downloaded' / 'update-error'
  // 这里订阅后通过 onUpdateAvailable(cb) / onUpdateDownloaded(cb) / onUpdateError(cb) 给渲染端
  onUpdateAvailable: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('update-available', listener);
    return () => ipcRenderer.removeListener('update-available', listener);
  },
  onUpdateDownloaded: (cb) => {
    const listener = (_event, info) => cb(info);
    ipcRenderer.on('update-downloaded', listener);
    return () => ipcRenderer.removeListener('update-downloaded', listener);
  },
  onUpdateError: (cb) => {
    const listener = (_event, err) => cb(err);
    ipcRenderer.on('update-error', listener);
    return () => ipcRenderer.removeListener('update-error', listener);
  },
  // 用户点 banner 上的"下载"按钮触发
  startDownloadUpdate: () => ipcRenderer.send('start-download-update'),

  // ===== AI Agent 工具调用桥 =====
  listAgentTools: () => ipcRenderer.invoke('agent:list'),
  invokeAgent: (name, args, ctx) => ipcRenderer.invoke('agent:invoke', name, args, ctx),

  // 应用层 (非工具调用, 直接暴露给 UI 用)
  openExternal: (url) => ipcRenderer.invoke('agent:openExternal', url),

  // v0.2.19: dev-proxy 死了后, 用户在自检页点 "🔄 重启 dev-proxy" 触发
  restartDevProxy: () => ipcRenderer.invoke('restart-dev-proxy')
});