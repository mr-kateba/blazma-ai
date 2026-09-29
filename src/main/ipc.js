'use strict';

// Every channel the renderer may call is registered here and mirrored in
// preload.js. Calls from any frame not served by app://blazma are rejected.

const { app, ipcMain } = require('electron');
const { APP_ORIGIN } = require('./protocol');
const settings = require('./settings');
const models = require('./models');
const { runBenchmark } = require('./benchmark');
const { exportReport } = require('./report');
const { toAppError } = require('./errors');

// Settings the renderer may change (more are added with the settings page).
const EDITABLE_SETTINGS = ['monitorIntervalMs', 'gpuTempWarn', 'gpuTempDanger'];

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
    return { systemPrompt: s.systemPrompt, sampling, thinking: Boolean(model && model.thinking && onGpu) };
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
