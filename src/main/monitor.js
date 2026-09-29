'use strict';

// Live hardware readings for the "جهازي" page. Sampling runs only while the
// page is open and visible (the renderer calls start/stop). While the model
// server is running, a light background check (GPU temperature and slowdown
// reasons every 10 s) keeps alerts working when the page is closed.

const { EventEmitter } = require('node:events');
const { powerMonitor } = require('electron');
const settings = require('./settings');
const gpu = require('./hardware/gpu');
const system = require('./hardware/system');

const HISTORY_SEC = 300;
const BACKGROUND_MS = 10000;
const STORAGE_EVERY_MS = 30000;

class Monitor extends EventEmitter {
  constructor(setup) {
    super();
    this.setup = setup;
    this.sampler = new system.WindowsSampler();
    this.timer = null;
    this.bgTimer = null;
    this.intervalMs = 2000;
    this.busy = false;
    this.last = null;
    this.limits = null;
    this.storageCache = null;
    this.storageAt = 0;
    this.alertState = {};
    this.gpuIndex = null;
  }

  nvidia() {
    const n = this.setup.nvidia;
    return n && n.available ? n : null;
  }

  async info() {
    const nv = this.nvidia();
    if (nv && !this.limits) this.limits = await gpu.temperatureLimits(nv.best.index);
    const st = await system.staticInfo();
    return {
      ...st,
      memory: system.memoryType(st.memoryModules),
      gpu: nv
        ? { name: nv.best.name, vramMB: nv.best.vramMB, driver: nv.best.driver, cuda: nv.cuda ? `${nv.cuda.major}.${nv.cuda.minor}` : null, limits: this.limits }
        : null,
      historySec: HISTORY_SEC,
      thresholds: this.thresholds(),
    };
  }

  // User values win; otherwise derive from the card's own maximum operating
  // temperature, falling back to 80/88 °C when the driver reports none.
  thresholds() {
    const s = settings.get();
    const max = (this.limits && (this.limits.maxOperating || this.limits.slowdown)) || null;
    const danger = s.gpuTempDanger ?? max ?? 88;
    const warn = s.gpuTempWarn ?? (max ? max - 5 : 80);
    return { gpuTempWarn: warn, gpuTempDanger: danger, source: s.gpuTempDanger != null ? 'user' : max ? 'card' : 'default' };
  }

  start(intervalMs) {
    this.intervalMs = [1000, 2000, 5000].includes(intervalMs) ? intervalMs : settings.get().monitorIntervalMs;
    this.stop();
    const loop = async () => {
      await this.tick();
      if (this.timer) this.timer = setTimeout(loop, this.intervalMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  serverPid() {
    const child = this.setup.server.child;
    return child && child.pid ? child.pid : null;
  }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try {
      const nv = this.nvidia();
      const pid = this.serverPid();
      const [g, winSample, vramByNvsmi] = await Promise.all([
        nv ? gpu.sampleGpu(nv.best.index) : null,
        this.sampler.sample(pid),
        nv && pid ? gpu.processVramMB(pid) : null,
      ]);
      const cpu = system.cpuUsage();
      const st = await system.staticInfo();
      if (Date.now() - this.storageAt > STORAGE_EVERY_MS) {
        this.storageCache = await system.storage(settings.modelsDir());
        this.storageAt = Date.now();
      }
      const w = winSample || {};
      const sample = {
        t: Date.now(),
        gpu: g,
        cpu: cpu && {
          ...cpu,
          // Current clock as Task Manager computes it: % Processor Performance x base clock.
          clockMHz: w.cpuPerfPct != null && st.cpu.maxClockMHz ? (w.cpuPerfPct / 100) * st.cpu.maxClockMHz : null,
        },
        ram: system.memory(),
        server: {
          running: Boolean(pid),
          ramBytes: w.serverWorkingSet ?? null,
          vramMB: vramByNvsmi ?? (w.serverGpuDedicated != null ? w.serverGpuDedicated / 1024 / 1024 : null),
          vramSource: vramByNvsmi != null ? 'nvidia-smi' : w.serverGpuDedicated != null ? 'windows' : null,
        },
        storage: this.storageCache,
        power: {
          onBattery: st.hasBattery ? powerMonitor.isOnBatteryPower() : null,
          batteryPct: w.batteryPct ?? null,
        },
      };
      this.last = sample;
      this.emit('sample', sample);
      this.checkAlerts(g);
    } finally {
      this.busy = false;
    }
  }

  // ---------- alerts ----------

  checkAlerts(g) {
    if (!g) return;
    const th = this.thresholds();
    const next = {};
    if (g.temp != null && g.temp >= th.gpuTempDanger) next['gpu-temp'] = { level: 'danger', value: g.temp };
    else if (g.temp != null && g.temp >= th.gpuTempWarn) next['gpu-temp'] = { level: 'warn', value: g.temp };
    const r = g.reasons || {};
    if (r.hw_thermal_slowdown || r.sw_thermal_slowdown) next['thermal-slowdown'] = { level: 'danger' };
    else if (r.hw_slowdown || r.hw_power_brake_slowdown) next['hw-slowdown'] = { level: 'warn' };

    const changed = Object.keys({ ...next, ...this.alertState }).some(
      (k) => (next[k] && next[k].level) !== (this.alertState[k] && this.alertState[k].level),
    );
    this.alertState = next;
    if (changed) this.emit('alerts', Object.entries(next).map(([code, a]) => ({ code, ...a })));
  }

  startBackground() {
    clearInterval(this.bgTimer);
    this.bgTimer = setInterval(async () => {
      if (this.timer || !this.serverPid() || !this.nvidia()) return;
      this.checkAlerts(await gpu.sampleGpu(this.nvidia().best.index));
    }, BACKGROUND_MS);
  }

  shutdown() {
    this.stop();
    clearInterval(this.bgTimer);
    this.sampler.stop();
  }
}

module.exports = { Monitor, HISTORY_SEC };
