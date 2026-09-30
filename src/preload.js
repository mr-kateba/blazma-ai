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
    webSearch: (query) => ipcRenderer.invoke('web:search', String(query)),
    webOpen: (url) => ipcRenderer.invoke('web:open', String(url)),
    openExternal: (url) => ipcRenderer.invoke('web:openExternal', String(url)),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
    monitorInfo: () => ipcRenderer.invoke('monitor:info'),
    monitorStart: (intervalMs) => ipcRenderer.invoke('monitor:start', Number(intervalMs)),
    monitorStop: () => ipcRenderer.invoke('monitor:stop'),
    monitorLast: () => ipcRenderer.invoke('monitor:last'),
    runBenchmark: () => ipcRenderer.invoke('bench:run'),
    exportReport: () => ipcRenderer.invoke('report:export'),
    onMonitorSample: (callback) => {
      const listener = (_event, sample) => callback(sample);
      ipcRenderer.on('monitor:sample', listener);
      return () => ipcRenderer.removeListener('monitor:sample', listener);
    },
    onAlerts: (callback) => {
      const listener = (_event, alerts) => callback(alerts);
      ipcRenderer.on('monitor:alerts', listener);
      return () => ipcRenderer.removeListener('monitor:alerts', listener);
    },
    onSetupState: (callback) => {
      const listener = (_event, state) => callback(state);
      ipcRenderer.on('setup:state', listener);
      return () => ipcRenderer.removeListener('setup:state', listener);
    },
  }),
);
