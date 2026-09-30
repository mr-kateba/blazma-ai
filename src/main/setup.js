'use strict';

// Drives first-run and every start: detect hardware -> ensure engine ->
// resolve model -> start llama-server (which downloads the model) -> ready.
// Publishes a single state object that the renderer renders.

const os = require('node:os');
const { EventEmitter } = require('node:events');
const { net } = require('electron');
const settings = require('./settings');
const models = require('./models');
const { detectNvidia } = require('./hardware/gpu');
const { ensureEngine, installedEngine } = require('./engine');
const { LlamaServer, isPortFree, pickPort, cleanupOrphan } = require('./server');
const { freeBytes } = require('./download');
const { toAppError, AppError } = require('./errors');

const NETWORK_RETRY_MS = 5000;
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

  modelList() {
    const manifest = models.manifest();
    const vram = this.nvidia && this.nvidia.available ? this.nvidia.best.vramMB : 0;
    return models.getCatalog().map((m) => ({
      id: m.id,
      name: m.name,
      sizeBytes: m.sizeBytes,
      note: m.note,
      cpu: Boolean(m.cpu),
      fits: m.cpu ? true : m.minVramMB <= vram,
      downloaded: models.isComplete(manifest[m.hf]),
    }));
  }

  clearTimers() {
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

    const useGpu = this.nvidia.available && !model.cpu && engine.kind !== 'cpu';
    this.server.start({
      exe: engine.exe,
      hf: model.hf,
      modelsDir: settings.modelsDir(),
      contextSize: settings.get().contextSize,
      gpuLayers: useGpu ? settings.get().gpuLayers : 0,
      port: this.port,
      offline: complete,
      vision: Boolean(entry.vision),
      hfEndpoint: process.env.BLAZMA_HF_ENDPOINT || null,
    });
    this.update({ vision: Boolean(entry.vision) });

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

  onServerState(s) {
    if (s !== 'ready' || !this.entry) return;
    this.clearTimers();
    this.update({ phase: 'ready', progress: null, error: null, models: this.modelList() });
    if (!this.entry.verified) this.verifyInBackground(this.entry, this.runId);
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
