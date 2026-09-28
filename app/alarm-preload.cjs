const { contextBridge, ipcRenderer, webFrame } = require('electron');
contextBridge.exposeInMainWorld('alarm', {
  setZoom: factor => { if (Number.isFinite(factor)) webFrame.setZoomFactor(Math.min(1.75, Math.max(1, factor))); },
  action: action => ipcRenderer.invoke('alarm-action', action),
  onData: callback => ipcRenderer.on('alarm-data', (_event, value) => callback(value)),
  onMessage: callback => ipcRenderer.on('alarm-message', (_event, value) => callback(value))
});
