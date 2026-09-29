'use strict';

// The only bridge between the renderer and the main process. Keep this list
// in sync with src/main/ipc.js and never expose ipcRenderer itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'blazma',
  Object.freeze({
    getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
  }),
);
