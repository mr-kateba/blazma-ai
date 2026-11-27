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
    ttsStatus: () => ipcRenderer.invoke('tts:status'),
    ttsPlan: () => ipcRenderer.invoke('tts:plan'),
    ttsInstall: () => ipcRenderer.invoke('tts:install'),
    ttsSynth: (text) => ipcRenderer.invoke('tts:synth', String(text)),
    onTtsProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('tts:progress', listener);
      return () => ipcRenderer.removeListener('tts:progress', listener);
    },
    voiceStatus: () => ipcRenderer.invoke('voice:status'),
    voiceInstall: () => ipcRenderer.invoke('voice:install'),
    voiceTranscribe: (wav) => ipcRenderer.invoke('voice:transcribe', wav),
    voiceSegments: (wav) => ipcRenderer.invoke('voice:segments', wav),
    onVoiceProgress(cb) {
      const listener = (_e, p) => cb(p);
      ipcRenderer.on('voice:progress', listener);
      return () => ipcRenderer.removeListener('voice:progress', listener);
    },
    kbStatus: () => ipcRenderer.invoke('kb:status'),
    agentRead: (name, args) => ipcRenderer.invoke('agent:read', String(name), args),
    agentPlan: (name, args) => ipcRenderer.invoke('agent:plan', String(name), args),
    agentRun: (planId, journalId) => ipcRenderer.invoke('agent:run', String(planId), String(journalId)),
    agentUndo: (journalId) => ipcRenderer.invoke('agent:undo', String(journalId)),
    agentChanges: (journalId) => ipcRenderer.invoke('agent:changes', String(journalId)),
    agentPlaces: () => ipcRenderer.invoke('agent:places'),
    brainStatus: () => ipcRenderer.invoke('brain:status'),
    wakeHeard: (wav, mode) => ipcRenderer.invoke('wake:heard', wav, String(mode)),
    wakeReady: (ok, error) => ipcRenderer.invoke('wake:ready', Boolean(ok), error ? String(error) : null),
    wakeStatus: () => ipcRenderer.invoke('wake:status'),
    wakeEnable: (on) => ipcRenderer.invoke('wake:enable', Boolean(on)),
    wakeSpoken: () => ipcRenderer.invoke('wake:spoken'),
    onWakeCommand(cb) {
      const listener = (_e, m) => cb(m);
      ipcRenderer.on('wake:command', listener);
      return () => ipcRenderer.removeListener('wake:command', listener);
    },
    onWake(cb) {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('wake:changed', listener);
      return () => ipcRenderer.removeListener('wake:changed', listener);
    },
    brainEnable: (on) => ipcRenderer.invoke('brain:enable', Boolean(on)),
    brainRefresh: () => ipcRenderer.invoke('brain:refresh'),
    brainAddFolder: () => ipcRenderer.invoke('brain:addFolder'),
    brainRemoveFolder: (folder) => ipcRenderer.invoke('brain:removeFolder', String(folder)),
    onBrain(cb) {
      const listener = (_e, s) => cb(s);
      ipcRenderer.on('brain:changed', listener);
      return () => ipcRenderer.removeListener('brain:changed', listener);
    },
    kbAddFolder: () => ipcRenderer.invoke('kb:addFolder'),
    kbRemoveFolder: (folder) => ipcRenderer.invoke('kb:removeFolder', String(folder)),
    kbUpdate: () => ipcRenderer.invoke('kb:update'),
    kbSearch: (question, folders) => ipcRenderer.invoke('kb:search', String(question), Array.isArray(folders) ? folders.map(String) : null),
    kbReveal: (file) => ipcRenderer.invoke('kb:reveal', String(file)),
    kbFiles: () => ipcRenderer.invoke('kb:files'),
    kbFileText: (file) => ipcRenderer.invoke('kb:fileText', String(file)),
    kbAddUrl: (url) => ipcRenderer.invoke('kb:addUrl', String(url)),
    kbSummarize: (file) => ipcRenderer.invoke('kb:summarize', String(file)),
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
    translateParse: (name, bytes) => ipcRenderer.invoke('translate:parse', String(name), bytes),
    translateBuild: (id, list, lang, suffix) => ipcRenderer.invoke('translate:build', String(id), list, String(lang), String(suffix)),
    translateReveal: (file) => ipcRenderer.invoke('translate:reveal', String(file)),
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
    vscodeCodeComplete: (on) => ipcRenderer.invoke('vscode:codeComplete', Boolean(on)),
    chatsSetMeta: (id, meta) => ipcRenderer.invoke('chats:setMeta', id, meta),
    chatsBackup: () => ipcRenderer.invoke('chats:backup'),
    chatsRestore: () => ipcRenderer.invoke('chats:restore'),
    saveTextFile: (content, lang) => ipcRenderer.invoke('file:saveText', String(content), String(lang || '')),
    getSettings: () => ipcRenderer.invoke('settings:get'),
    previewSet: (code, lang) => ipcRenderer.invoke('preview:set', String(code), String(lang || '')),
    previewDiagram: (code, dark) => ipcRenderer.invoke('preview:diagram', String(code), Boolean(dark)),
    crashStatus: () => ipcRenderer.invoke('crash:status'),
    crashOpen: () => ipcRenderer.invoke('crash:open'),
    quickSetKey: (key, kind) => ipcRenderer.invoke('quick:setKey', String(key), kind === 'screen' ? 'screen' : 'text'),
    quickReplace: (text) => ipcRenderer.invoke('quick:replace', String(text)),
    quickSetEnabled: (on) => ipcRenderer.invoke('quick:setEnabled', Boolean(on)),
    quickContext: () => ipcRenderer.invoke('quick:context'),
    quickHide: () => ipcRenderer.invoke('quick:hide'),
    quickToChat: (text) => ipcRenderer.invoke('quick:toChat', String(text)),
    tasksRun: (id) => ipcRenderer.invoke('tasks:run', String(id)),
    mcpEnsure: () => ipcRenderer.invoke('mcp:ensure'),
    mcpTools: () => ipcRenderer.invoke('mcp:tools'),
    mcpCall: (server, tool, args) => ipcRenderer.invoke('mcp:call', String(server), String(tool), args),
    onQuickContext(cb) {
      const listener = (_e, c) => cb(c);
      ipcRenderer.on('quick:context', listener);
      return () => ipcRenderer.removeListener('quick:context', listener);
    },
    onQuickToChat(cb) {
      const listener = (_e, t) => cb(t);
      ipcRenderer.on('quick:toChat', listener);
      return () => ipcRenderer.removeListener('quick:toChat', listener);
    },
    onTaskOpen(cb) {
      const a = (_e, id) => cb(id);
      const b = (_e, d) => cb(null, d);
      ipcRenderer.on('tasks:open', a);
      ipcRenderer.on('tasks:done', b);
      return () => {
        ipcRenderer.removeListener('tasks:open', a);
        ipcRenderer.removeListener('tasks:done', b);
      };
    },
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
