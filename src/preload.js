'use strict';

// The only bridge between the renderer and the main process. Keep this list
// in sync with src/main/ipc.js and never expose ipcRenderer itself.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

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
    modelsAddLocalFile: () => ipcRenderer.invoke('models:addLocalFile'),
    modelsScanOllama: () => ipcRenderer.invoke('models:scanOllama'),
    modelsAddOllama: (key) => ipcRenderer.invoke('models:addOllama', String(key)),
    modelsScanFolder: () => ipcRenderer.invoke('models:scanFolder'),
    modelsScanLmStudio: () => ipcRenderer.invoke('models:scanLmStudio'),
    modelsAddScanned: (key) => ipcRenderer.invoke('models:addScanned', String(key)),
    // Dropped files: the path is read here, since the page cannot see it.
    modelsAddDropped: (file) => ipcRenderer.invoke('models:addDropped', webUtils.getPathForFile(file)),
    modelsRemoveCustom: (id) => ipcRenderer.invoke('models:removeCustom', String(id)),
    stopServer: () => ipcRenderer.invoke('server:stop'),
    apiSetEnabled: (on) => ipcRenderer.invoke('api:setEnabled', Boolean(on)),
    apiNewKey: () => ipcRenderer.invoke('api:newKey'),
    imagesStatus: () => ipcRenderer.invoke('images:status'),
    imagesPlan: () => ipcRenderer.invoke('images:plan'),
    imagesInstall: () => ipcRenderer.invoke('images:install'),
    imagesGenerate: (prompt) => ipcRenderer.invoke('images:generate', { prompt: String(prompt) }),
    imagesSave: (dataUrl) => ipcRenderer.invoke('images:save', String(dataUrl)),
    imagesCancel: () => ipcRenderer.invoke('images:cancel'),
    onImagesProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('images:progress', listener);
      return () => ipcRenderer.removeListener('images:progress', listener);
    },
    voiceStatus: () => ipcRenderer.invoke('voice:status'),
    voiceInstall: () => ipcRenderer.invoke('voice:install'),
    voiceTranscribe: (wav) => ipcRenderer.invoke('voice:transcribe', wav),
    onVoiceProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('voice:progress', listener);
      return () => ipcRenderer.removeListener('voice:progress', listener);
    },
    kbStatus: () => ipcRenderer.invoke('kb:status'),
    kbAddFolder: () => ipcRenderer.invoke('kb:addFolder'),
    kbRemoveFolder: (folder) => ipcRenderer.invoke('kb:removeFolder', String(folder)),
    kbUpdate: () => ipcRenderer.invoke('kb:update'),
    kbSearch: (question) => ipcRenderer.invoke('kb:search', String(question)),
    kbReveal: (file) => ipcRenderer.invoke('kb:reveal', String(file)),
    onKbProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('kb:progress', listener);
      return () => ipcRenderer.removeListener('kb:progress', listener);
    },
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
    vscodeStatus: () => ipcRenderer.invoke('vscode:status'),
    vscodePlan: () => ipcRenderer.invoke('vscode:plan'),
    vscodeInstall: () => ipcRenderer.invoke('vscode:install'),
    onVscodeProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('vscode:progress', listener);
      return () => ipcRenderer.removeListener('vscode:progress', listener);
    },
    vscodeShow: (bounds) => ipcRenderer.invoke('vscode:show', bounds),
    vscodeBounds: (bounds) => ipcRenderer.invoke('vscode:bounds', bounds),
    vscodeHide: () => ipcRenderer.invoke('vscode:hide'),
    vscodeOpenFolder: () => ipcRenderer.invoke('vscode:openFolder'),
    vscodeOpenProjects: () => ipcRenderer.invoke('vscode:openProjects'),
    vscodeSnippet: (code, lang) => ipcRenderer.invoke('vscode:snippet', String(code), String(lang || '')),
    vscodeRestart: () => ipcRenderer.invoke('vscode:restart'),
    vscodeConnectAi: () => ipcRenderer.invoke('vscode:connectAi'),
    vscodeAskAi: () => ipcRenderer.invoke('vscode:askAi'),
    saveTextFile: (content, lang) => ipcRenderer.invoke('file:saveText', String(content), String(lang || '')),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    getTheme: () => ipcRenderer.invoke('theme:get'),
    onThemeChanged(cb) {
      const listener = (_e, t) => cb(t);
      ipcRenderer.on('theme:changed', listener);
      return () => ipcRenderer.removeListener('theme:changed', listener);
    },
    updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
    chooseModelsDir: () => ipcRenderer.invoke('settings:chooseModelsDir'),
    resetModelsDir: () => ipcRenderer.invoke('settings:resetModelsDir'),
    openFolder: (kind) => ipcRenderer.invoke('settings:openFolder', kind === 'models' ? 'models' : 'data'),
    setLaunchAtLogin: (enabled) => ipcRenderer.invoke('settings:setLaunchAtLogin', Boolean(enabled)),
    restartServer: () => ipcRenderer.invoke('server:restart'),
    personasList: () => ipcRenderer.invoke('personas:list'),
    personasSave: (p) => ipcRenderer.invoke('personas:save', p),
    personasDelete: (id) => ipcRenderer.invoke('personas:delete', String(id)),
    exportChat: (payload) => ipcRenderer.invoke('chats:export', payload),
    extractFile: (name, bytes) => ipcRenderer.invoke('files:extract', String(name), bytes),
    checkUpdates: () => ipcRenderer.invoke('updates:check'),
    updateEngine: () => ipcRenderer.invoke('updates:engine'),
    downloadAppUpdate: () => ipcRenderer.invoke('updates:downloadApp'),
    installAppUpdate: () => ipcRenderer.invoke('updates:installApp'),
    onUpdateProgress(cb) {
      const listener = (_e, pct) => cb(pct);
      ipcRenderer.on('updates:progress', listener);
      return () => ipcRenderer.removeListener('updates:progress', listener);
    },
    openRelease: (url) => ipcRenderer.invoke('updates:openRelease', String(url)),
    monitorInfo: () => ipcRenderer.invoke('monitor:info'),
    monitorStart: (intervalMs, client) => ipcRenderer.invoke('monitor:start', Number(intervalMs), client === 'overlay' ? 'overlay' : 'device'),
    monitorStop: (client) => ipcRenderer.invoke('monitor:stop', client === 'overlay' ? 'overlay' : 'device'),
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
