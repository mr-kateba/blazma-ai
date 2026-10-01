'use strict';

// Every channel the renderer may call is registered here and mirrored in
// preload.js. Calls from any frame not served by app://blazma are rejected.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { app, dialog, ipcMain, nativeTheme, shell } = require('electron');
const { APP_ORIGIN } = require('./protocol');
const settings = require('./settings');
const models = require('./models');
const { runBenchmark } = require('./benchmark');
const { exportReport } = require('./report');
const { toAppError } = require('./errors');
const web = require('./web');
const chats = require('./chats');
const vscode = require('./vscode');
const updates = require('./updates');
const documents = require('./documents');
const localmodels = require('./localmodels');
const knowledge = require('./knowledge');
const voice = require('./voice');
const images = require('./images');
const personas = require('./personas');
const { exportChat } = require('./exporter');
const paths = require('./paths');

// Settings the renderer may change (more are added with the settings page).
const EDITABLE_SETTINGS = [
  'monitorIntervalMs',
  'lhmEnabled',
  'overlayEnabled',
  'theme',
  'overlayCorner',
  'lhmPort',
  'gpuTempWarn',
  'gpuTempDanger',
  'webSearch',
  'kbInChat',
  'tourDone',
  'voiceModel',
  'shareDeviceInfo',
  'systemPrompt',
  'temperature',
  'contextSize',
  'gpuLayers',
  'kvCache',
  'idleUnloadMin',
  'speculative',
  'port',
];

// Starting with Windows uses the OS login items; elsewhere it is not offered.
const loginSupported = () => process.platform === 'win32';

// File extensions for "حفظ كملف" on code blocks, by the block's language tag.
const CODE_EXT = {
  python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css',
  json: 'json', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', go: 'go', rust: 'rs',
  php: 'php', ruby: 'rb', sql: 'sql', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', ps1: 'ps1',
  kotlin: 'kt', swift: 'swift', dart: 'dart', yaml: 'yaml', yml: 'yml', xml: 'xml', markdown: 'md', md: 'md',
};

// Tool calls return { ok, result } or { ok: false, error } instead of throwing,
// so the model can be told what went wrong and carry on.
async function wrap(fn) {
  try {
    return { ok: true, result: await fn() };
  } catch (err) {
    const e = toAppError(err, 'web-failed');
    return { ok: false, error: { code: e.code, detail: e.detail } };
  }
}

function isTrustedSender(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith(`${APP_ORIGIN}/`);
}

function handle(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error(`Rejected IPC from untrusted sender: ${channel}`);
    return fn(...args);
  });
}

function registerIpc({ setup, monitor, getWindow }) {
  handle('app:getInfo', () => ({ name: app.getName(), version: app.getVersion() }));
  handle('setup:getState', () => setup.snapshot());
  handle('setup:start', (modelId) => {
    if (typeof modelId === 'string') setup.start(modelId);
  });
  handle('setup:retry', () => setup.retry());

  // Models page.
  handle('models:list', () => setup.refreshModels());
  handle('models:use', (id) => setup.start(String(id)));
  handle('models:delete', (id) => setup.deleteModel(String(id)));
  handle('models:addCustom', async (hf) => {
    const res = await wrap(() => models.addCustom(String(hf || '').slice(0, 200)));
    setup.refreshModels();
    return res;
  });
  // A GGUF file on this computer, picked by the user.
  handle('models:addLocalFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'اختر ملف موديل GGUF',
      properties: ['openFile'],
      filters: [{ name: 'GGUF', extensions: ['gguf'] }],
    });
    if (canceled || !filePaths[0]) return { ok: true, result: null };
    const res = await wrap(() => localmodels.addFile(filePaths[0]));
    setup.refreshModels();
    return res;
  });
  // Image generation: stable-diffusion.cpp + Z-Image Turbo (images.js). The
  // chat model is paused while drawing so both do not compete for memory.
  handle('images:status', () => images.status());
  handle('images:plan', () => wrap(() => images.plan()));
  handle('images:install', () =>
    wrap(() =>
      images.install({ gpu: Boolean(setup.nvidia && setup.nvidia.available) }, (p) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('images:progress', p);
      }),
    ),
  );
  handle('images:generate', async (req) => {
    const wasRunning = ['ready', 'loading'].includes(setup.snapshot().phase);
    if (wasRunning) await setup.stopServer();
    try {
      const vram = setup.nvidia && setup.nvidia.available ? setup.nvidia.best.vramMB : 0;
      const size = vram >= 8000 ? '1024x1024' : vram >= 4000 ? '768x768' : '512x512';
      return await wrap(() => images.generate({ prompt: String((req && req.prompt) || ''), size }));
    } finally {
      if (wasRunning) setup.restart();
    }
  });
  handle('images:cancel', () => images.cancel());
  handle('images:save', async (dataUrl) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
    if (!m) return { ok: false };
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), { title: 'حفظ الصورة', defaultPath: 'blazma-image.png', filters: [{ name: 'PNG', extensions: ['png'] }] });
    if (canceled || !filePath) return { ok: true, result: null };
    fs.writeFileSync(filePath, Buffer.from(m[1], 'base64'));
    return { ok: true, result: filePath };
  });
  // Voice input: whisper.cpp on this computer (voice.js).
  handle('voice:status', () => voice.status());
  handle('voice:install', () =>
    wrap(() =>
      voice.install((p) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('voice:progress', p);
      }),
    ),
  );
  handle('voice:transcribe', (wav) => wrap(() => voice.transcribe(wav instanceof Uint8Array ? wav : new Uint8Array(wav || []))));
  // "مكتبتي": the user's document folders, indexed for answers (knowledge.js).
  handle('kb:status', () => knowledge.status());
  handle('kb:addFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), { title: 'اختر مجلد مستندات', properties: ['openDirectory'] });
    if (canceled || !filePaths[0]) return { ok: true, result: null };
    return wrap(() => knowledge.addFolder(filePaths[0]));
  });
  handle('kb:removeFolder', (folder) => wrap(() => knowledge.removeFolder(String(folder || ''))));
  handle('kb:update', () =>
    wrap(() =>
      knowledge.update((p) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('kb:progress', p);
      }),
    ),
  );
  handle('kb:search', (question) => wrap(() => knowledge.search(String(question || ''))));
  // Shows a source file in Explorer; only files that are in the index.
  handle('kb:reveal', (file) => {
    // Only a file that is in the index (a source shown under a reply).
    const f = String(file || '');
    if (knowledge.isIndexed(f)) shell.showItemInFolder(f);
  });
  // Every GGUF in a folder the user picks, or in LM Studio's models folder.
  handle('models:scanFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'اختر مجلداً فيه موديلات GGUF',
      properties: ['openDirectory'],
    });
    if (canceled || !filePaths[0]) return { ok: true, result: null };
    return wrap(() => localmodels.scanFolder(filePaths[0], 'folder'));
  });
  handle('models:scanLmStudio', () => wrap(() => localmodels.scanFolder(localmodels.lmStudioDir(), 'lmstudio')));
  handle('models:addScanned', async (key) => {
    const res = await wrap(() => localmodels.addScanned(String(key || '')));
    setup.refreshModels();
    return res;
  });
  // A .gguf dropped on the models page (its path comes from webUtils in the
  // preload; addFile checks the extension, the file and its GGUF header).
  handle('models:addDropped', async (file) => {
    const res = await wrap(() => localmodels.addFile(String(file || ''), 'file'));
    setup.refreshModels();
    return res;
  });
  // Models downloaded by Ollama, used in place.
  handle('models:scanOllama', () => wrap(() => localmodels.scanOllama()));
  handle('models:addOllama', async (key) => {
    const res = await wrap(() => localmodels.addOllama(String(key || '')));
    setup.refreshModels();
    return res;
  });
  handle('models:removeCustom', async (id) => {
    const model = models.findModel(String(id));
    if (!model || !model.custom) return { ok: false, code: 'model-invalid' };
    const res = await setup.deleteModel(model.id);
    if (!res.ok) return res;
    models.removeCustom(model.id);
    setup.refreshModels();
    return { ok: true };
  });
  handle('server:stop', () => setup.stopServer());
  handle('server:getConnection', () => setup.connection());
  // Per-request generation options: the active model's recommended sampling
  // (from catalog.json), the user's temperature if set, and thinking on/off.
  handle('chat:getSettings', () => {
    const s = settings.get();
    const model = models.findModel(s.activeModelId);
    const sampling = { ...((model && model.sampling) || {}) };
    if (s.temperature !== null) sampling.temperature = s.temperature;
    // On the CPU, thinking first can mean minutes before the answer starts.
    const onGpu = Boolean(setup.snapshot().hardware && setup.snapshot().hardware.nvidia);
    return {
      systemPrompt: s.systemPrompt,
      sampling,
      thinking: Boolean(model && model.thinking && onGpu),
      vision: Boolean(setup.snapshot().vision),
      webSearch: s.webSearch,
      kbInChat: s.kbInChat,
      shareDeviceInfo: s.shareDeviceInfo,
      contextSize: s.contextSize,
    };
  });

  const settingsView = () => {
    const s = settings.get();
    return {
      ...Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, s[k]])),
      modelsDir: settings.modelsDir(),
      modelsDirCustom: Boolean(s.modelsDir),
      apiEnabled: s.apiEnabled,
      apiKey: s.apiEnabled ? s.apiKey : '',
      defaults: {
        systemPrompt: settings.DEFAULTS.systemPrompt,
        contextSize: settings.DEFAULTS.contextSize,
        gpuLayers: settings.DEFAULTS.gpuLayers,
        kvCache: settings.DEFAULTS.kvCache,
        port: settings.DEFAULTS.port,
      },
      launchAtLogin: { supported: loginSupported(), enabled: loginSupported() ? app.getLoginItemSettings().openAtLogin : false },
    };
  };
  handle('settings:get', settingsView);
  handle('settings:update', (patch) => {
    const clean = {};
    for (const k of EDITABLE_SETTINGS) if (patch && k in patch) clean[k] = patch[k];
    settings.update(clean);
    if (clean.theme) {
      nativeTheme.themeSource = settings.get().theme;
      sendTheme();
    }
    return settingsView();
  });
  // Light or dark for the page (<html data-theme>). Sent explicitly: the
  // page's prefers-color-scheme did not follow themeSource in every test.
  // nativeTheme "updated" covers Windows switching while on "system".
  const sendTheme = () => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('theme:changed', { dark: nativeTheme.shouldUseDarkColors });
  };
  nativeTheme.on('updated', sendTheme);
  handle('theme:get', () => ({ dark: nativeTheme.shouldUseDarkColors }));
  // The folder for new model downloads. Files already downloaded stay where they are.
  handle('settings:chooseModelsDir', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), {
      title: 'اختر مجلد الموديلات',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths[0]) return settingsView();
    try {
      fs.accessSync(filePaths[0], fs.constants.W_OK);
    } catch {
      return { ...settingsView(), error: 'not-writable' };
    }
    settings.update({ modelsDir: filePaths[0] });
    setup.refreshModels();
    return settingsView();
  });
  handle('settings:resetModelsDir', () => {
    settings.update({ modelsDir: '' });
    setup.refreshModels();
    return settingsView();
  });
  handle('settings:openFolder', (kind) => {
    const dir = kind === 'models' ? settings.modelsDir() : paths.userData();
    fs.mkdirSync(dir, { recursive: true });
    return shell.openPath(dir);
  });
  handle('settings:setLaunchAtLogin', (enabled) => {
    if (loginSupported()) app.setLoginItemSettings({ openAtLogin: Boolean(enabled) });
    return settingsView();
  });
  handle('server:restart', () => setup.restart());
  // Local API for other programs: the same llama-server (127.0.0.1 only),
  // with a key that stays the same between starts. Applied by restarting.
  const newApiKey = () => `bz-${crypto.randomBytes(24).toString('hex')}`;
  handle('api:setEnabled', (on) => {
    const s = settings.get();
    settings.update({ apiEnabled: Boolean(on), apiKey: on && !s.apiKey ? newApiKey() : s.apiKey });
    setup.restart();
    return settingsView();
  });
  handle('api:newKey', () => {
    settings.update({ apiKey: newApiKey() });
    if (settings.get().apiEnabled) setup.restart();
    refreshAiConfig();
    return settingsView();
  });
  handle('personas:list', () => personas.list());
  handle('personas:save', (p) => wrap(() => personas.save(p || {})));
  handle('personas:delete', (id) => personas.remove(String(id)));
  handle('chats:export', (payload) => wrap(() => exportChat(getWindow(), payload || {})));
  handle('files:extract', (name, bytes) => wrap(() => documents.extractFile(name, bytes)));

  // Updates: only when the user presses the button.
  handle('updates:check', async () => {
    const [appRes, engineRes] = await Promise.all([wrap(() => updates.checkApp()), wrap(() => updates.checkEngine(setup.nvidia))]);
    return { app: appRes, engine: engineRes };
  });
  handle('updates:engine', () => wrap(() => setup.updateEngine()));
  handle('updates:downloadApp', () =>
    wrap(() =>
      updates.downloadApp((pct) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('updates:progress', pct);
      }),
    ),
  );
  handle('updates:installApp', () => wrap(() => updates.installApp()));
  handle('updates:openRelease', (url) => {
    if (typeof url === 'string' && url.startsWith(updates.APP_RELEASES_PAGE)) shell.openExternal(url);
  });

  handle('web:search', (query) => wrap(() => web.search(String(query || '').slice(0, 300))));
  handle('web:open', (url) => wrap(() => web.openPage(String(url || '').slice(0, 2000))));
  // Source links under answers open in the user's browser (https/http only).
  handle('web:openExternal', (url) => {
    try {
      const u = new URL(String(url));
      if (u.protocol === 'https:' || u.protocol === 'http:') shell.openExternal(u.href);
    } catch {}
  });

  handle('chats:list', () => chats.list());
  handle('chats:get', (id) => chats.get(String(id)));
  handle('chats:save', (chat) => chats.save(chat || {}));
  handle('chats:rename', (id, title) => chats.rename(String(id), String(title || '')));
  handle('chats:delete', (id) => chats.remove(String(id)));
  handle('chats:search', (q) => chats.search(String(q || '').slice(0, 200)));

  handle('device:summary', () => monitor.modelSummary());

  // Programming page: VS Code (VSCodium) shown inside the window (vscode.js).
  const cleanBounds = (b) => (b && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite(Number(b[k]))) ? { x: Number(b.x), y: Number(b.y), width: Number(b.width), height: Number(b.height) } : null);
  // The AI in VS Code follows the running model and the API's port and key.
  const refreshAiConfig = () => {
    const s = settings.get();
    if (!vscode.aiInstalled() || !s.apiEnabled || !s.apiKey) return false;
    const model = models.findModel(setup.snapshot().modelId || s.activeModelId);
    vscode.syncContinueConfig({ port: setup.port || s.port, apiKey: s.apiKey, modelName: model && model.name });
    return true;
  };
  // The engine moved to another port: Continue follows.
  setup.on('port-changed', () => refreshAiConfig());
  let codeFolder = null; // a folder to open next time the page shows (then cleared)
  handle('vscode:status', () => ({ ...vscode.status(), ai: vscode.aiInstalled(), aiReady: vscode.aiInstalled() && settings.get().apiEnabled, folder: vscode.currentFolder() || codeFolder || vscode.projectsDir() }));
  handle('vscode:plan', () => wrap(() => vscode.plan()));
  handle('vscode:install', () =>
    wrap(() =>
      vscode.install((p) => {
        const w = getWindow();
        if (w && !w.isDestroyed()) w.webContents.send('vscode:progress', p);
      }),
    ),
  );
  handle('vscode:show', (bounds) =>
    wrap(async () => {
      const b = cleanBounds(bounds);
      if (!b) throw new AppError('vscode-failed', 'bad bounds');
      vscode.migrateStudioProjects();
      refreshAiConfig();
      const folder = codeFolder;
      codeFolder = null;
      return vscode.showView(getWindow(), b, folder);
    }),
  );
  handle('vscode:bounds', (bounds) => vscode.setBounds(cleanBounds(bounds)));
  handle('vscode:hide', () => vscode.hideView());
  handle('vscode:openFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWindow(), { title: 'اختر مجلد مشروع', properties: ['openDirectory', 'createDirectory'] });
    if (canceled || !filePaths.length) return null;
    codeFolder = filePaths[0];
    return codeFolder;
  });
  handle('vscode:openProjects', () => {
    fs.mkdirSync(vscode.projectsDir(), { recursive: true });
    codeFolder = vscode.projectsDir();
    return codeFolder;
  });
  handle('vscode:snippet', (code, lang) => {
    codeFolder = vscode.saveSnippet(String(code || '').slice(0, 2_000_000), String(lang || ''));
    return codeFolder;
  });
  handle('vscode:restart', () => {
    vscode.stop();
    return true;
  });
  // Turns on the local API (fixed key) if needed, installs Continue from
  // Open VSX, and points it at the running model.
  handle('vscode:connectAi', () =>
    wrap(async () => {
      const s = settings.get();
      if (!s.apiEnabled || !s.apiKey) {
        settings.update({ apiEnabled: true, apiKey: s.apiKey || newApiKey() });
        await setup.restart(); // the port is settled after this
      }
      await vscode.installAi();
      refreshAiConfig();
      vscode.reloadView();
      return true;
    }),
  );

  // User-initiated only (a click on a code block): the save dialog decides
  // where the file goes.
  handle('file:saveText', async (content, lang) => {
    const ext = CODE_EXT[String(lang || '').toLowerCase()] || 'txt';
    const { canceled, filePath } = await dialog.showSaveDialog(getWindow(), {
      title: 'حفظ الكود كملف',
      defaultPath: `code.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: '*', extensions: ['*'] }],
    });
    if (canceled || !filePath) return { saved: false };
    fs.writeFileSync(filePath, String(content ?? ''), 'utf8');
    return { saved: true };
  });

  handle('monitor:info', () => monitor.info());
  handle('monitor:start', (intervalMs, client) => monitor.start(client === 'overlay' ? 'overlay' : 'device', Number(intervalMs)));
  handle('monitor:stop', (client) => monitor.stop(client === 'overlay' ? 'overlay' : 'device'));
  handle('monitor:last', () => monitor.last);

  let lastBench = null;
  handle('bench:run', async () => {
    try {
      lastBench = await runBenchmark({ connection: setup.connection(), nvidia: setup.nvidia });
      return { ok: true, result: lastBench };
    } catch (err) {
      const e = toAppError(err, 'bench-failed');
      return { ok: false, error: { code: e.code, detail: e.detail } };
    }
  });
  handle('report:export', async () =>
    exportReport(getWindow(), { info: await monitor.info(), last: monitor.last, bench: lastBench, setupState: setup.snapshot() }),
  );
}

module.exports = { registerIpc };
