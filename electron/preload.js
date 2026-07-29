const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installUpdate: () => ipcRenderer.send('install-update'),

  // ===== AI Agent 工具调用桥 =====
  listAgentTools: () => ipcRenderer.invoke('agent:list'),
  invokeAgent: (name, args, ctx) => ipcRenderer.invoke('agent:invoke', name, args, ctx),

  // 应用层 (非工具调用, 直接暴露给 UI 用)
  openExternal: (url) => ipcRenderer.invoke('agent:openExternal', url)
});