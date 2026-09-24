const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(name, ...args);
contextBridge.exposeInMainWorld('still', {
  websiteTarget: invoke('websiteTarget'), websiteIcons: invoke('websiteIcons'), websiteImage: invoke('websiteImage'), websiteSetup: invoke('websiteSetup'),
  bootstrap: invoke('bootstrap'), appIcons: invoke('appIcons'), showWindow: invoke('showWindow'), status: invoke('status'), savePreferences: invoke('savePreferences'),
  install: invoke('install'), uninstall: invoke('uninstall'), discover: invoke('discover'), browse: invoke('browse'),
  start: invoke('start'), requestUnlock: invoke('requestUnlock'), cancelUnlock: invoke('cancelUnlock'), end: invoke('end'),
  window: invoke('window'), exportHistory: invoke('exportHistory'), checkForUpdates: invoke('checkForUpdates'), downloadUpdate: invoke('downloadUpdate'), updateHistory: invoke('updateHistory'),
  listAlerts: invoke('alerts:list'), saveAlert: invoke('alerts:save'), deleteAlert: invoke('alerts:delete'), toggleAlert: invoke('alerts:toggle'), previewAlert: invoke('alerts:preview'), pickAlertMedia: invoke('alerts:media'),
  onAlerts: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('alerts-changed', listener); return () => ipcRenderer.removeListener('alerts-changed', listener); },
  onAlertError: callback => ipcRenderer.on('alert-error', (_event, value) => callback(value)),
  onPresentation: callback => ipcRenderer.on('presentation-visible', (_event, value) => callback(value)),
  onStatus: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('guard-status', listener); return () => ipcRenderer.removeListener('guard-status', listener); }
});
