'use strict';

// Every channel the renderer may call is registered here and mirrored in
// preload.js. Calls from any frame not served by app://blazma are rejected.

const { app, ipcMain } = require('electron');
const { APP_ORIGIN } = require('./protocol');
const settings = require('./settings');
const models = require('./models');

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

function registerIpc(setup) {
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
}

module.exports = { registerIpc };
