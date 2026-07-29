const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  installUpdate: () => ipcRenderer.send('install-update')
});