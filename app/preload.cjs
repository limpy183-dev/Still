const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('still', {
  bootstrap: invoke('bootstrap'), status: invoke('status'), savePreferences: invoke('savePreferences'),
  install: invoke('install'), uninstall: invoke('uninstall'), discover: invoke('discover'), browse: invoke('browse'),
  start: invoke('start'), requestUnlock: invoke('requestUnlock'), cancelUnlock: invoke('cancelUnlock'), end: invoke('end'),
  window: invoke('window'), exportHistory: invoke('exportHistory'), updateHistory: invoke('updateHistory'),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('guard-status', listener); return () => ipcRenderer.removeListener('guard-status', listener); }
});
