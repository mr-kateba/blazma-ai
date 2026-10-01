'use strict';

// Drives first-run and every start: detect hardware -> ensure engine ->
// resolve model -> start llama-server (which downloads the model) -> ready.
// Publishes a single state object that the renderer renders.

const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { net } = require('electron');
const settings = require('./settings');
const models = require('./models');
const { detectNvidia } = require('./hardware/gpu');
const { ensureEngine, updateEngine, installedEngine } = require('./engine');
const { LlamaServer, isPortFree, pickPort, cleanupOrphan } = require('./server');
const { freeBytes } = require('./download');
const { toAppError, AppError } = require('./errors');

const NETWORK_RETRY_MS = 5000;
const SLEEP_CHECK_MS = 10000;
const DISK_MARGIN = 512 * 1024 * 1024;

class Setup extends EventEmitter {
  constructor() {
    super();
    this.server = new LlamaServer();
    this.nvidia = null;
    this.port = null;
    this.runId = 0;
    this.progressTimer = null;
    this.retryTimer = null;
    this.entry = null;
    this.state = {
      phase: 'detecting',
      hardware: null,
      models: [],
      recommendedId: null,
      modelId: null,
      engine: null,
      progress: null,
      error: null,
      vision: false,
      sleeping: false, // the model is unloaded after idle time (settings: idleUnloadMin)
    };

    this.server.on('state', (s) => this.onServerState(s));
    this.server.on('exit', (e) => this.onServerExit(e));
  }

  snapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  update(patch) {
    Object.assign(this.state, patch);
    this.emit('state', this.snapshot());
  }

  // Called before the window loads so the CSP can name the port.
  async choosePort() {
    this.port = await pickPort(settings.get().port);
    return this.port;
  }

  async init() {
    await cleanupOrphan();
    this.nvidia = await detectNvidia();
    const recommended = models.recommend(this.nvidia);
    this.update({
      hardware: {
        nvidia: this.nvidia.available
          ? {
              name: this.nvidia.best.name,
              vramMB: this.nvidia.best.vramMB,
              driver: this.nvidia.best.driver,
              cuda: this.nvidia.cuda ? `${this.nvidia.cuda.major}.${this.nvidia.cuda.minor}` : null,
            }
          : null,
        ramMB: Math.round(os.totalmem() / 1024 / 1024),
      },
      models: this.modelList(),
      recommendedId: recommended ? recommended.id : null,
    });

    const active = settings.get().activeModelId;
    if (active && models.findModel(active)) this.start(active);
    else this.update({ phase: 'choose' });
  }

  // How a model fits this computer: 'ok' (all on the card, or a small CPU
  // model), 'slow' (part in system memory, or on the CPU without a card), or
  // 'too-big'. The RAM share leaves room for Windows and other programs.
  fitLevel(m, vram) {
    const ramMB = Math.round(os.totalmem() / 1024 / 1024);
    const needMB = Math.round((m.sizeBytes || 0) / 1024 / 1024) + 1536;
    if (m.cpu || (vram && m.minVramMB <= vram)) return 'ok';
    return needMB <= vram + ramMB * 0.6 ? 'slow' : 'too-big';
  }

  modelList() {
    const manifest = models.manifest();
    const vram = this.nvidia && this.nvidia.available ? this.nvidia.best.vramMB : 0;
    return models.getCatalog().map((m) => ({
      id: m.id,
      name: m.name,
      hf: m.hf,
      sizeBytes: m.sizeBytes,
      note: m.note,
      license: m.license || null,
      cpu: Boolean(m.cpu),
      custom: Boolean(m.custom),
      vision: Boolean(m.vision),
      fits: this.fitLevel(m, vram) === 'ok',
      fit: this.fitLevel(m, vram),
      minVramMB: m.minVramMB || 0,
      maker: m.maker || null,
      origin: m.origin || null,
      tags: Array.isArray(m.tags) ? m.tags : [],
      featured: Boolean(m.featured),
      thinking: Boolean(m.thinking),
      draft: m.draft || null,
      downloaded: m.local ? fs.existsSync(m.path) : models.isComplete(manifest[m.hf]),
      onDisk: m.local ? 0 : models.sizeOnDisk(m.hf),
      local: Boolean(m.local),
      source: m.source || null,
      path: m.local ? m.path : null,
      hasTemplate: m.local ? m.hasTemplate : null,
    }));
  }

  refreshModels() {
    this.update({ models: this.modelList() });
    return this.state.models;
  }

  // Deleting the model that is running would pull files from under the
  // server, so that one must be switched away from first.
  async deleteModel(id) {
    const model = models.findModel(id);
    if (!model) return { ok: false, code: 'model-invalid' };
    const running = this.state.modelId === id && ['ready', 'loading', 'model-download', 'engine', 'model-resolve'].includes(this.state.phase);
    if (running) return { ok: false, code: 'model-in-use' };
    models.deleteDownload(model.hf);
    this.refreshModels();
    return { ok: true };
  }

  clearTimers() {
    clearInterval(this.sleepTimer);
    clearInterval(this.progressTimer);
    clearTimeout(this.retryTimer);
    this.progressTimer = null;
    this.retryTimer = null;
  }

  async start(modelId) {
    const model = models.findModel(modelId);
    if (!model) return;
    const run = ++this.runId;
    this.clearTimers();
    await this.server.stop();
    if (run !== this.runId) return;

    this.update({ phase: 'engine', modelId, error: null, progress: null });
    try {
      const engine = await ensureEngine({
        nvidia: this.nvidia,
        onProgress: (p) => run === this.runId && this.update({ progress: p }),
      });
      if (run !== this.runId) return;
      this.update({
        engine: { tag: engine.tag, variant: engine.variant, kind: engine.kind, fallbackFrom: engine.fallbackFrom || [] },
        progress: null,
      });

      // A model already on this computer (a GGUF file, or Ollama's copy).
      if (model.local) {
        if (!fs.existsSync(model.path)) throw new AppError('local-missing', model.path);
        settings.update({ activeModelId: modelId });
        this.entry = null; // nothing to verify against a download
        this.localActive = true;
        await this.launch(engine, model, null, true, run);
        return;
      }

      let entry = models.manifest()[model.hf];
      if (!entry) {
        this.update({ phase: 'model-resolve' });
        entry = await models.resolveRemote(model.hf, { vision: Boolean(model.vision) });
        if (run !== this.runId) return;
        entry.verified = false;
        models.saveManifestEntry(model.hf, entry);
      } else if (model.vision && !entry.vision) {
        // Downloaded before image support: add the vision projector. Without
        // internet, keep chatting with text only rather than blocking.
        try {
          const upgraded = await models.resolveRemote(model.hf, { vision: true });
          if (run !== this.runId) return;
          entry = { ...upgraded, verified: false };
          models.saveManifestEntry(model.hf, entry);
        } catch (err) {
          if (toAppError(err).code !== 'network') throw err;
        }
      }
      this.entry = entry;
      this.localActive = false;

      const complete = models.isComplete(entry);
      if (!complete) {
        const remaining = entry.size - models.localProgress(entry).done;
        if ((await freeBytes(settings.modelsDir())) < remaining + DISK_MARGIN) {
          throw new AppError('disk-full', `need ${remaining} more bytes`);
        }
      }
      settings.update({ activeModelId: modelId });
      await this.launch(engine, model, entry, complete, run);
    } catch (err) {
      if (run !== this.runId) return;
      const e = toAppError(err);
      if (e.code === 'network') this.waitForNetwork(modelId, run);
      else this.update({ phase: 'error', error: { code: e.code, detail: e.detail } });
    }
  }

  async launch(engine, model, entry, complete, run) {
    if (!(await isPortFree(this.port))) {
      this.port = await pickPort(0);
      this.emit('port-changed', this.port);
    }
    if (run !== this.runId) return;

    const useGpu = this.nvidia.available && engine.kind !== 'cpu';
    this.server.start({
      exe: engine.exe,
      hf: model.hf,
      modelsDir: settings.modelsDir(),
      // Some models were trained on a short context (ALLaM: 4096).
      contextSize: Math.min(settings.get().contextSize, model.maxContext || Infinity),
      gpuLayers: useGpu ? settings.get().gpuLayers : 0,
      kvCache: settings.get().kvCache,
      idleUnloadMin: settings.get().idleUnloadMin,
      speculative: settings.get().speculative,
      // The helper model only when it is already downloaded, so starting
      // never needs the internet for it.
      draftHf: settings.get().speculative === 'draft' && model.draft && models.isComplete(models.manifest()[model.draft]) ? model.draft : null,
      apiKey: settings.get().apiEnabled ? settings.get().apiKey : null,
      port: this.port,
      offline: complete,
      vision: model.local ? Boolean(model.mmproj) : Boolean(entry.vision),
      modelPath: model.local ? model.path : null,
      mmprojPath: model.local && model.mmproj && fs.existsSync(model.mmproj) ? model.mmproj : null,
      hfEndpoint: process.env.BLAZMA_HF_ENDPOINT || null,
    });
    this.update({ vision: model.local ? Boolean(model.mmproj) : Boolean(entry.vision) });

    if (complete) {
      this.update({ phase: 'loading', progress: null });
      return;
    }
    this.update({ phase: 'model-download', progress: models.localProgress(entry) });
    this.progressTimer = setInterval(() => {
      if (models.isComplete(entry)) {
        clearInterval(this.progressTimer);
        this.progressTimer = null;
        this.update({ phase: 'loading', progress: null, models: this.modelList() });
      } else {
        this.update({ progress: models.localProgress(entry) });
      }
    }, 700);
  }

  // While idle unloading is on, asks llama-server whether the model is
  // asleep (GET /props "is_sleeping"; it does not wake the model).
  watchSleep() {
    clearInterval(this.sleepTimer);
    if (!settings.get().idleUnloadMin) return;
    this.sleepTimer = setInterval(() => {
      if (this.state.phase !== 'ready' || !this.server.apiKey) return;
      const req = http.get(
        { host: '127.0.0.1', port: this.server.port, path: '/props', timeout: 2000, headers: { Authorization: `Bearer ${this.server.apiKey}` } },
        (res) => {
          let body = '';
          res.on('data', (d) => (body += d));
          res.on('end', () => {
            try {
              const sleeping = Boolean(JSON.parse(body).is_sleeping);
              if (sleeping !== this.state.sleeping) this.update({ sleeping });
            } catch {
              /* not JSON: leave as is */
            }
          });
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => {});
    }, SLEEP_CHECK_MS);
  }

  onServerState(s) {
    // A downloaded model has an entry (checked in the background once it
    // runs); a model from a local file has none.
    if (s !== 'ready' || (!this.entry && !this.localActive)) return;
    this.clearTimers();
    this.update({ phase: 'ready', progress: null, error: null, sleeping: false, models: this.modelList() });
    this.watchSleep();
    if (this.entry && !this.entry.verified) this.verifyInBackground(this.entry, this.runId);
  }

  async verifyInBackground(entry, run) {
    const ok = await models.verify(entry).catch(() => false);
    if (run !== this.runId) return;
    if (ok) {
      models.saveManifestEntry(entry.hf, { ...entry, verified: true });
      return;
    }
    await this.server.stop();
    models.removeLocal(entry);
    models.saveManifestEntry(entry.hf, null);
    this.update({ phase: 'error', error: { code: 'verify-failed', detail: entry.hf } });
  }

  onServerExit(e) {
    if (e.expected) return;
    clearInterval(this.progressTimer);
    this.progressTimer = null;
    const run = this.runId;
    if (e.errorCode === 'network' && this.state.modelId) {
      this.waitForNetwork(this.state.modelId, run);
      return;
    }
    if (e.errorCode === 'port-in-use' && this.state.modelId) {
      pickPort(0).then((p) => {
        this.port = p;
        this.emit('port-changed', p);
        this.start(this.state.modelId);
      });
      return;
    }
    this.update({ phase: 'error', progress: null, error: { code: e.errorCode, detail: e.log } });
  }

  // Keeps the partial download and restarts once the internet is back;
  // llama.cpp resumes the file with an HTTP Range request.
  waitForNetwork(modelId, run) {
    this.update({ phase: 'waiting-network', error: null });
    const probe = async () => {
      if (run !== this.runId) return;
      const url = installedEngine() ? `${models.HF_ENDPOINT}/api/models/${models.findModel(modelId).hf.split(':')[0]}` : 'https://api.github.com/';
      const online = await net
        .fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(5000) })
        .then((r) => r.status < 500)
        .catch(() => false);
      if (run !== this.runId) return;
      if (online) this.start(modelId);
      else this.retryTimer = setTimeout(probe, NETWORK_RETRY_MS);
    };
    this.retryTimer = setTimeout(probe, NETWORK_RETRY_MS);
  }

  async stopServer() {
    this.runId++;
    this.clearTimers();
    await this.server.stop();
    this.update({ phase: 'stopped', progress: null });
  }

  // Settings > updates: install the newest engine, then start the model again
  // (with the old engine if the update failed).
  async updateEngine() {
    const modelId = this.state.modelId || settings.get().activeModelId;
    this.runId++;
    this.clearTimers();
    await this.server.stop();
    const run = this.runId;
    this.update({ phase: 'engine', error: null, progress: null });
    let result;
    let failure = null;
    try {
      result = await updateEngine({ nvidia: this.nvidia, onProgress: (p) => run === this.runId && this.update({ progress: p }) });
    } catch (err) {
      failure = toAppError(err);
    }
    if (run === this.runId) {
      if (modelId) this.start(modelId);
      else this.update({ phase: 'stopped', progress: null });
    }
    if (failure) throw failure;
    return result;
  }

  // Settings > engine: apply context size, GPU layers or port.
  async restart() {
    // A port changed in the settings is taken here (the page is reloaded so
    // its CSP names the new port).
    const wanted = settings.get().port;
    if (wanted !== this.port && this.state.phase !== 'model-download') {
      const p = await pickPort(wanted);
      if (p !== this.port) {
        this.port = p;
        this.emit('port-changed', p);
      }
    }
    const id = this.state.modelId || settings.get().activeModelId;
    if (id) this.start(id);
  }

  retry() {
    const id = this.state.modelId || this.state.recommendedId;
    if (id) this.start(id);
  }

  connection() {
    if (this.state.phase !== 'ready' || !this.server.apiKey) return null;
    return { port: this.server.port, apiKey: this.server.apiKey };
  }

  shutdownSync() {
    this.runId++;
    this.clearTimers();
    this.server.stopSync();
  }
}

module.exports = { Setup };
