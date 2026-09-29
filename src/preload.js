'use strict';

// The only bridge between the renderer and the main process. Keep this list
// in sync with src/main/ipc.js and never expose ipcRenderer itself.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld(
  'blazma',
  Object.freeze({
    getAppInfo: () => ipcRenderer.invoke('app:getInfo'),
    getSetupState: () => ipcRenderer.invoke('setup:getState'),
    startSetup: (modelId) => ipcRenderer.invoke('setup:start', String(modelId)),
    retrySetup: () => ipcRenderer.invoke('setup:retry'),
    stopServer: () => ipcRenderer.invoke('server:stop'),
    getConnection: () => ipcRenderer.invoke('server:getConnection'),
    getChatSettings: () => ipcRenderer.invoke('chat:getSettings'),
    onSetupState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('setup:state', listener);
      return () => ipcRenderer.removeListener('setup:state', listener);
    },
  }),
);
