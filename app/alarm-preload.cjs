const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('alarm', {
  action: action => ipcRenderer.invoke('alarm-action', action),
  onData: callback => ipcRenderer.on('alarm-data', (_event, value) => callback(value)),
  onMessage: callback => ipcRenderer.on('alarm-message', (_event, value) => callback(value))
});
