const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  pickFolder: (initial) => ipcRenderer.invoke('pick-folder', initial),
  openFolder: (path) => ipcRenderer.invoke('open-folder', path),
  showInFolder: (path) => ipcRenderer.invoke('show-in-folder', path),
  openFile: (path) => ipcRenderer.invoke('open-file', path),
  checkForUpdates: () => ipcRenderer.invoke('update-check'),
  installUpdate: () => ipcRenderer.invoke('update-install'),
  onUpdateStatus: (cb) => ipcRenderer.on('update-status', (_e, data) => cb(data)),
  onAppMeta: (cb) => ipcRenderer.on('app-meta', (_e, data) => cb(data)),
  isElectron: true,
});
