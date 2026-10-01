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
const lhm = require('./hardware/lhm');

const HISTORY_SEC = 300;
const BACKGROUND_MS = 10000;
const STORAGE_EVERY_MS = 30000;
// When LibreHardwareMonitor is not answering, ask again only this often.
const LHM_RETRY_MS = 10000;

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
    this.lhm = { status: 'off', tempC: null, powerW: null };
    this.lhmAt = 0;
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

  // CPU temperature and power, when LibreHardwareMonitor's web server runs.
  async readLhm() {
    const s = settings.get();
    if (!s.lhmEnabled) {
      this.lhm = { status: 'disabled', tempC: null, powerW: null };
      return;
    }
    if (this.lhm.status !== 'ok' && Date.now() - this.lhmAt < LHM_RETRY_MS) return;
    this.lhmAt = Date.now();
    this.lhm = await lhm.readCpu(s.lhmPort);
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
      await this.readLhm();
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
          tempC: this.lhm.tempC,
          powerW: this.lhm.powerW,
          sensor: this.lhm.status, // 'ok' | 'off' | 'auth' | 'no-sensor' | 'disabled'
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

  // Plain-text hardware summary for the model ("أعطِ الذكاء معلومات جهازي").
  // Hardware readings only: no computer name, user name or file paths.
  async modelSummary() {
    const nv = this.nvidia();
    const st = await system.staticInfo();
    const fresh = this.last && Date.now() - this.last.t < 15000 ? this.last : null;
    const g = fresh ? fresh.gpu : nv ? await gpu.sampleGpu(nv.best.index) : null;
    const ram = system.memory();
    const mem = system.memoryType(st.memoryModules);
    const gb = (b) => (b / 1024 ** 3).toFixed(1);
    const lines = [];
    if (nv) {
      lines.push(`GPU: ${nv.best.name}, driver ${nv.best.driver}${nv.cuda ? `, CUDA ${nv.cuda.major}.${nv.cuda.minor}` : ''}`);
      if (g) {
        const part = (label, v, unit) => (v == null ? null : `${label} ${Math.round(v)}${unit}`);
        lines.push(
          [
            part('usage', g.util, '%'),
            g.memUsed != null && g.memTotal != null ? `VRAM ${(g.memUsed / 1024).toFixed(1)}/${(g.memTotal / 1024).toFixed(1)} GB` : null,
            part('temperature', g.temp, '°C'),
            part('power', g.power, ' W'),
            g.powerLimit != null ? `power limit ${Math.round(g.powerLimit)} W` : null,
            part('fan', g.fan, '%'),
            g.pstate ? `state ${g.pstate}` : null,
          ]
            .filter(Boolean)
            .join(', '),
        );
        const reasons = Object.entries(g.reasons || {}).filter(([k, v]) => v && k !== 'gpu_idle').map(([k]) => k);
        if (reasons.length) lines.push(`GPU clock slowdown reasons active: ${reasons.join(', ')}`);
      }
      if (this.limits && this.limits.maxOperating) lines.push(`GPU max operating temperature: ${this.limits.maxOperating}°C`);
    } else {
      lines.push('No NVIDIA GPU detected; the model runs on the CPU.');
    }
    const cpu = fresh && fresh.cpu ? `, usage ${Math.round(fresh.cpu.total)}%` : '';
    const cpuTemp = fresh && fresh.cpu && fresh.cpu.tempC != null ? `, temperature ${Math.round(fresh.cpu.tempC)}°C` : '';
    const cpuNote = cpuTemp ? '' : ' CPU temperature is not available on Windows without a sensor driver.';
    lines.push(`CPU: ${st.cpu.name || 'unknown'}${st.cpu.cores ? `, ${st.cpu.cores} cores` : ''}, ${st.cpu.threads} threads${cpu}${cpuTemp}.${cpuNote}`);
    lines.push(`RAM: ${gb(ram.usedBytes)}/${gb(ram.totalBytes)} GB used${mem.type ? `, ${mem.type}` : ''}${mem.speedMTs ? ` ${mem.speedMTs} MT/s` : ''}`);
    if (st.os && st.os.caption) lines.push(`OS: ${st.os.caption}`);
    return lines.join('\n');
  }

  shutdown() {
    this.stop();
    clearInterval(this.bgTimer);
    this.sampler.stop();
  }
}

module.exports = { Monitor, HISTORY_SEC };
