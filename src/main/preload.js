'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('stuadio', {
  platform: process.platform,
  pickFile: () => ipcRenderer.invoke('pick-file'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  load: (file) => ipcRenderer.invoke('load', file),
  enhance: (settings) => ipcRenderer.invoke('enhance', settings),
  cancel: () => ipcRenderer.invoke('cancel'),
  exportAudio: (opts) => ipcRenderer.invoke('export', opts),
  reveal: (p) => ipcRenderer.invoke('reveal', p),
  version: () => ipcRenderer.invoke('app:version'),
  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  reportOnline: () => ipcRenderer.send('update:online'),
  onUpdate: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('update', fn);
    return () => ipcRenderer.removeListener('update', fn);
  },
  onProgress: (cb) => {
    const fn = (_e, p) => cb(p);
    ipcRenderer.on('progress', fn);
    return () => ipcRenderer.removeListener('progress', fn);
  },
});
