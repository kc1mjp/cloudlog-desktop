'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cl', {
  call: (name, ...args) => ipcRenderer.invoke('api', name, args),
  on: (cb) => {
    ipcRenderer.on('event', (_e, msg) => cb(msg));
  },
});
