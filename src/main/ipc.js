'use strict';

// Every channel the renderer may call is registered here and mirrored in
// preload.js. Calls from any frame not served by app://blazma are rejected.

const fs = require('node:fs');
const { app, dialog, ipcMain, shell } = require('electron');
const { APP_ORIGIN } = require('./protocol');
const settings = require('./settings');
const models = require('./models');
const { runBenchmark } = require('./benchmark');
const { exportReport } = require('./report');
const { toAppError } = require('./errors');
const web = require('./web');
const chats = require('./chats');

// Settings the renderer may change (more are added with the settings page).
const EDITABLE_SETTINGS = ['monitorIntervalMs', 'gpuTempWarn', 'gpuTempDanger', 'webSearch', 'shareDeviceInfo'];

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
    const onGpu = Boolean(setup.snapshot().hardware && setup.snapshot().hardware.nvidia) && !(model && model.cpu);
    return {
      systemPrompt: s.systemPrompt,
      sampling,
      thinking: Boolean(model && model.thinking && onGpu),
      vision: Boolean(setup.snapshot().vision),
      webSearch: s.webSearch,
      shareDeviceInfo: s.shareDeviceInfo,
    };
  });

  handle('settings:get', () => {
    const s = settings.get();
    return Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, s[k]]));
  });
  handle('settings:update', (patch) => {
    const clean = {};
    for (const k of EDITABLE_SETTINGS) if (patch && k in patch) clean[k] = patch[k];
    settings.update(clean);
    const s = settings.get();
    return Object.fromEntries(EDITABLE_SETTINGS.map((k) => [k, s[k]]));
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
  handle('monitor:start', (intervalMs) => monitor.start(Number(intervalMs)));
  handle('monitor:stop', () => monitor.stop());
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
