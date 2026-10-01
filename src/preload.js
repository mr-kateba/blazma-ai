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
    modelsList: () => ipcRenderer.invoke('models:list'),
    modelsUse: (id) => ipcRenderer.invoke('models:use', String(id)),
    modelsDelete: (id) => ipcRenderer.invoke('models:delete', String(id)),
    modelsAddCustom: (hf) => ipcRenderer.invoke('models:addCustom', String(hf)),
    modelsRemoveCustom: (id) => ipcRenderer.invoke('models:removeCustom', String(id)),
    stopServer: () => ipcRenderer.invoke('server:stop'),
    getConnection: () => ipcRenderer.invoke('server:getConnection'),
    getChatSettings: () => ipcRenderer.invoke('chat:getSettings'),
    webSearch: (query) => ipcRenderer.invoke('web:search', String(query)),
    webOpen: (url) => ipcRenderer.invoke('web:open', String(url)),
    openExternal: (url) => ipcRenderer.invoke('web:openExternal', String(url)),
    chatsList: () => ipcRenderer.invoke('chats:list'),
    chatsGet: (id) => ipcRenderer.invoke('chats:get', String(id)),
    chatsSave: (chat) => ipcRenderer.invoke('chats:save', chat),
    chatsRename: (id, title) => ipcRenderer.invoke('chats:rename', String(id), String(title)),
    chatsDelete: (id) => ipcRenderer.invoke('chats:delete', String(id)),
    chatsSearch: (q) => ipcRenderer.invoke('chats:search', String(q)),
    deviceSummary: () => ipcRenderer.invoke('device:summary'),
    studioList: () => ipcRenderer.invoke('studio:list'),
    studioGet: (id) => ipcRenderer.invoke('studio:get', String(id)),
    studioSave: (project) => ipcRenderer.invoke('studio:save', project),
    studioDelete: (id) => ipcRenderer.invoke('studio:delete', String(id)),
    studioExport: (id) => ipcRenderer.invoke('studio:export', String(id)),
    studioImportFolder: () => ipcRenderer.invoke('studio:importFolder'),
    studioPreview: (files) => ipcRenderer.invoke('studio:preview', files),
    saveTextFile: (content, lang) => ipcRenderer.invoke('file:saveText', String(content), String(lang || '')),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
    chooseModelsDir: () => ipcRenderer.invoke('settings:chooseModelsDir'),
    resetModelsDir: () => ipcRenderer.invoke('settings:resetModelsDir'),
    openFolder: (kind) => ipcRenderer.invoke('settings:openFolder', kind === 'models' ? 'models' : 'data'),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke('settings:setLaunchAtLogin', Boolean(enabled)),
    restartServer: () => ipcRenderer.invoke('server:restart'),
    extractFile: (name, bytes) => ipcRenderer.invoke('files:extract', String(name), bytes),
    checkUpdates: () => ipcRenderer.invoke('updates:check'),
    updateEngine: () => ipcRenderer.invoke('updates:engine'),
    openRelease: (url) => ipcRenderer.invoke('updates:openRelease', String(url)),
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
