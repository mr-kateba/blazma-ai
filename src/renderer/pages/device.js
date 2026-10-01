// "جهازي": live hardware readings. Every value shown is a reading from its
// source; anything missing is shown as "غير متاح" with the reason.

import { ar, formatBytes } from '../i18n/ar.js';
import { el } from '../lib/dom.js';
import { LineChart } from '../lib/chart.js';
import { store } from '../lib/store.js';

const D = ar.device;
const GB = 1024 ** 3;

let info = null;
let history = [];
let visible = false;
let running = false;
let setupState = null;
let bench = { running: false, result: null, error: null };
let charts = null;
let exportedNote = false;

const $ = (id) => document.getElementById(id);
// Why a Windows-only reading is missing: not provided on this Windows, or not Windows at all.
const winWhy = () => (info.isWindows ? D.why.notReported : D.why.windowsOnly);
const num = (v, d = 0) => (v == null || !Number.isFinite(v) ? null : v.toFixed(d));
// Shown as "62°" isolated left-to-right. Adding the Arabic "م" makes the
// bidi algorithm treat the number as right-to-left and reorder it ("م°62").
const deg = (v) => el('bdi', { dir: 'ltr' }, `${Math.round(v)}°`);

// ---------- cards ----------

function card(label, value, { sub, status, why } = {}) {
  const missing = value == null;
  return el(
    'div',
    { class: `stat${status ? ` st-${status}` : ''}` },
    el('div', { class: 'stat-label' }, label),
    el('div', { class: `stat-value${missing ? ' na' : ''}`, dir: 'rtl' }, ...(missing ? [D.unavailable] : [].concat(value))),
    missing && why ? el('div', { class: 'stat-note' }, why) : sub ? el('div', { class: 'stat-note' }, sub) : null,
  );
}

function level(value, warn, danger) {
  if (value == null) return null;
  if (value >= danger) return 'danger';
  if (value >= warn) return 'warn';
  return 'ok';
}

function section(title, ...children) {
  return el('section', { class: 'dev-section' }, el('h2', null, title), ...children);
}

// ---------- sections ----------

function gpuSection(s) {
  if (!info.gpu) {
    const names = info.videoControllers.map((v) => v.name).filter(Boolean);
    return section(
      D.gpuSection,
      el('div', { class: 'notice' }, D.why.noNvidia),
      el('div', { class: 'stats' }, card(D.otherGpus, names.length ? names.join('، ') : null, { why: winWhy() })),
    );
  }
  const g = s && s.gpu;
  const th = info.thresholds;
  const why = s ? D.why.notReported : D.why.waiting;
  const vramPct = g && g.memUsed != null && g.memTotal ? (g.memUsed / g.memTotal) * 100 : null;
  const reasons = g ? Object.entries(g.reasons || {}) : [];
  const activeReasons = reasons.filter(([k, v]) => v && k !== 'gpu_idle').map(([k]) => D.reasons[k] || k);
  const server = s && s.server;

  return section(
    D.gpuSection,
    el(
      'div',
      { class: 'dev-sub', dir: 'rtl' },
      el('bdi', { dir: 'ltr' }, info.gpu.name),
      ` · ${D.driver} `,
      el('bdi', { dir: 'ltr' }, info.gpu.driver),
      info.gpu.cuda ? ' · ' : '',
      info.gpu.cuda ? el('bdi', { dir: 'ltr' }, `CUDA ${info.gpu.cuda}`) : '',
    ),
    el(
      'div',
      { class: 'stats' },
      card(D.usage, g && num(g.util) != null ? `${num(g.util)}%` : null, { why }),
      card(D.vram, g && g.memUsed != null && g.memTotal != null ? `${num(g.memUsed / 1024, 1)} ${D.of} ${num(g.memTotal / 1024, 1)} جيجابايت` : null, {
        why,
        sub: vramPct != null ? `${num(vramPct)}%` : null,
        status: level(vramPct, 90, 97),
      }),
      card(D.power, g && g.power != null ? `${num(g.power)} واط` : null, {
        why,
        sub: g && g.powerLimit != null ? `${D.limit} ${num(g.powerLimit)} واط` : null,
      }),
      card(D.temp, g && g.temp != null ? deg(g.temp) : null, {
        why,
        status: level(g && g.temp, th.gpuTempWarn, th.gpuTempDanger),
        sub: info.gpu.limits && info.gpu.limits.maxOperating ? D.maxTempNote(info.gpu.limits.maxOperating) : null,
      }),
      card(D.fan, g && g.fan != null ? `${num(g.fan)}%` : null, { why }),
      card(D.clocks, g && g.clockGr != null ? `${num(g.clockGr)} / ${g.clockMem != null ? num(g.clockMem) : '—'} ميجاهرتز` : null, { why }),
      card(D.pstate, g && g.pstate ? g.pstate : null, { why }),
      card(D.slowdown, g && reasons.length ? (activeReasons.length ? activeReasons.join('، ') : D.slowdownNone) : null, {
        why,
        status: activeReasons.some((r) => r.includes('حرارة')) ? 'danger' : null,
      }),
      card(D.modelVram, server && server.vramMB != null ? `${num(server.vramMB / 1024, 2)} جيجابايت` : null, {
        why: !server ? D.why.waiting : !server.running ? D.why.serverOff : D.why.processVram,
      }),
    ),
    el('p', { class: 'dev-footnote' }, D.totalPowerNote),
  );
}

function cpuSection(s) {
  const c = s && s.cpu;
  const winOnly = winWhy();
  const coreBars = c
    ? el(
        'div',
        { class: 'cores', dir: 'ltr' },
        ...c.perCore.map((v) => {
          const bar = el('div', { class: 'core', title: `${Math.round(v)}%` }, el('div', { class: 'core-fill' }));
          bar.firstChild.style.height = `${Math.max(2, v)}%`;
          return bar;
        }),
      )
    : null;
  return section(
    D.cpuSection,
    el('div', { class: 'dev-sub', dir: 'ltr' }, info.cpu.name || ''),
    el(
      'div',
      { class: 'stats' },
      card(D.usage, c ? `${num(c.total)}%` : null, { why: D.why.waiting }),
      card(D.cores, info.cpu.threads ? `${info.cpu.cores ?? '—'} / ${info.cpu.threads}` : null, { why: winOnly }),
      card(D.cpuClock, c && c.clockMHz != null ? `${num(c.clockMHz / 1000, 2)} جيجاهرتز` : null, { why: s ? winOnly : D.why.waiting }),
      card(D.cpuTemp, c && c.tempC != null ? `${num(c.tempC)}°` : null, { why: sensorWhy(c) }),
      card(D.cpuPower, c && c.powerW != null ? `${num(c.powerW)} واط` : null, { why: sensorWhy(c) }),
    ),
    coreBars && el('div', { class: 'dev-sub' }, D.perCore),
    coreBars,
  );
}

// Why the CPU temperature/power is missing (LibreHardwareMonitor's state).
function sensorWhy(c) {
  if (!c) return D.why.waiting;
  return D.why.lhm[c.sensor] || D.why.cpuSensor;
}

function ramSection(s) {
  const r = s && s.ram;
  const server = s && s.server;
  const m = info.memory;
  return section(
    D.ramSection,
    el(
      'div',
      { class: 'stats' },
      card(D.ramUsed, r ? `${num(r.usedBytes / GB, 1)} ${D.of} ${num(r.totalBytes / GB, 1)} جيجابايت` : null, {
        why: D.why.waiting,
        sub: r ? `${num(r.usedPct)}%` : null,
        status: level(r && r.usedPct, 85, 95),
      }),
      card(D.ramAvailable, r ? `${num(r.availableBytes / GB, 1)} جيجابايت` : null, { why: D.why.waiting }),
      card(D.ramType, m.type ? `${m.type}${m.speedMTs ? ` · ${m.speedMTs} MT/s` : ''}` : null, { why: winWhy() }),
      card(D.modelRam, server && server.ramBytes != null ? `${num(server.ramBytes / GB, 2)} جيجابايت` : null, {
        why: !server ? D.why.waiting : !server.running ? D.why.serverOff : winWhy(),
      }),
    ),
  );
}

function storageSection(s) {
  const st = s && s.storage;
  return section(
    D.storageSection,
    el(
      'div',
      { class: 'stats' },
      card(
        `${D.diskFree}${st && st.drive ? ` (${st.drive})` : ''}`,
        st && st.freeBytes != null ? `${formatBytes(st.freeBytes)} ${D.of} ${formatBytes(st.totalBytes)}` : null,
        { why: D.why.waiting, status: st && st.totalBytes ? level(100 - (st.freeBytes / st.totalBytes) * 100, 90, 97) : null },
      ),
      card(D.modelsSize, st ? formatBytes(st.modelsBytes) : null, { why: D.why.waiting }),
    ),
  );
}

function systemSection(s) {
  const p = s && s.power;
  const sys = info.system;
  const board = info.board;
  let battery = D.noBattery;
  if (info.hasBattery) {
    battery = p && p.batteryPct != null ? `${num(p.batteryPct)}% · ${p.onBattery ? D.onBattery : D.onAc}` : null;
  }
  return section(
    D.systemSection,
    el(
      'div',
      { class: 'stats' },
      card(D.osVersion, info.os && info.os.caption ? `${info.os.caption}${info.os.build ? ` (${info.os.build})` : ''}` : null, { why: winWhy() }),
      card(D.machine, sys && (sys.manufacturer || sys.model) ? `${sys.manufacturer || ''} ${sys.model || ''}`.trim() : null, { why: winWhy() }),
      card(D.board, board && (board.manufacturer || board.product) ? `${board.manufacturer || ''} ${board.product || ''}`.trim() : null, { why: winWhy() }),
      card(D.battery, battery, { why: D.why.waiting }),
    ),
  );
}

// ---------- "now running", benchmark ----------

function nowRunning() {
  const st = setupState;
  const model = st && st.models.find((m) => m.id === st.modelId);
  const phaseKey = !st ? 'busy' : st.phase === 'ready' ? 'ready' : st.phase === 'loading' ? 'loading' : st.phase === 'stopped' ? 'stopped' : st.phase === 'error' ? 'error' : 'busy';
  return el(
    'div',
    { class: 'now-running' },
    el('span', { class: 'muted' }, D.nowRunning),
    el('span', null, `${D.model}: `, el('b', { dir: 'ltr' }, model ? model.name : D.none)),
    el('span', null, `${D.server}: `, el('b', null, ar.status[phaseKey])),
    el('span', null, `${D.lastSpeed}: `, el('b', { dir: 'rtl' }, store.lastSpeed ? `${store.lastSpeed.toFixed(1)} توكن/ث` : D.none)),
  );
}

function benchView() {
  if (bench.running) return el('div', { class: 'bench' }, el('div', { class: 'spinner small' }), el('span', null, D.benchmarkRunning));
  if (bench.error) return el('div', { class: 'bench msg-error' }, bench.error);
  const r = bench.result;
  if (!r) return null;
  const item = (label, v) => el('div', { class: 'bench-item' }, el('span', { class: 'muted' }, label), el('b', { dir: 'rtl' }, ...[].concat(v ?? D.unavailable)));
  return el(
    'div',
    { class: 'bench' },
    item(D.benchGen, r.genPerSecond != null ? `${r.genPerSecond.toFixed(1)} توكن/ث` : null),
    item(D.benchPrompt, r.promptPerSecond != null ? `${r.promptPerSecond.toFixed(0)} توكن/ث` : null),
    item(D.benchMaxTemp, r.maxTempC != null ? deg(r.maxTempC) : null),
    item(D.benchMaxPower, r.maxPowerW != null ? `${Math.round(r.maxPowerW)} واط` : null),
    item(D.benchDuration, `${r.seconds.toFixed(1)} ث`),
  );
}

async function runBench() {
  if (bench.running) return;
  if (!setupState || setupState.phase !== 'ready') {
    bench = { running: false, result: null, error: D.benchmarkNeedsModel };
    renderHeader();
    return;
  }
  bench = { running: true, result: null, error: null };
  renderHeader();
  const res = await window.blazma.runBenchmark();
  bench = res.ok ? { running: false, result: res.result, error: null } : { running: false, result: null, error: D.benchmarkFailed };
  renderHeader();
}

async function exportReport() {
  const res = await window.blazma.exportReport();
  exportedNote = Boolean(res && res.saved);
  renderHeader();
}

function renderHeader() {
  const box = $('device-top');
  if (!box) return;
  box.replaceChildren(
    ...[nowRunning(), benchView(), exportedNote ? el('div', { class: 'notice ok-note' }, D.exported) : null].filter(Boolean),
  );
  $('btn-bench').disabled = bench.running;
}

// ---------- charts ----------

function buildCharts() {
  const labels = { now: D.now, ago: D.minutesAgo };
  const windowSec = info.historySec;
  const panel = (title, legend) => {
    const canvas = el('canvas', { class: 'chart-canvas' });
    const node = el(
      'div',
      { class: 'chart' },
      el('div', { class: 'chart-head' }, el('span', null, title), legend ? el('span', { class: 'legend' }, ...legend) : null),
      canvas,
    );
    return { node, canvas };
  };
  const dot = (color, label) => el('span', { class: 'legend-item' }, el('i', { class: `dot ${color}` }), label);

  const defs = [];
  const util = panel(D.chartUtil, info.gpu ? [dot('c-gpu', D.seriesGpu), dot('c-cpu', D.seriesCpu)] : [dot('c-cpu', D.seriesCpu)]);
  defs.push({ ...util, key: 'util', yMax: 100, format: (v) => `${Math.round(v)}` });
  if (info.gpu) {
    defs.push({ ...panel(D.chartTemp), key: 'temp', yMax: 100, format: (v) => `${Math.round(v)}` });
    defs.push({ ...panel(D.chartPower), key: 'power', yMax: 'auto', format: (v) => `${Math.round(v)}` });
    defs.push({ ...panel(D.chartVram), key: 'vram', yMax: info.gpu.vramMB / 1024, format: (v) => v.toFixed(0) });
  }
  defs.push({ ...panel(D.chartRam), key: 'ram', yMax: 'auto', format: (v) => v.toFixed(0) });

  $('device-charts').replaceChildren(...defs.map((d) => d.node));
  charts = defs.map((d) => ({ key: d.key, chart: new LineChart(d.canvas, { windowSec, yMax: d.yMax, format: d.format, labels }) }));
}

const COLORS = { gpu: '#5b8cff', cpu: '#3fbf7f', temp: '#e6a23c', power: '#ef5a5a', vram: '#8a5bff', ram: '#3fbfbf' };

function updateCharts() {
  if (!charts) return;
  const pts = (fn) => history.map((s) => ({ t: s.t, v: s.gap ? null : fn(s) }));
  const g = (k) => (s) => (s.gpu ? s.gpu[k] : null);
  const series = {
    util: [
      ...(info.gpu ? [{ color: COLORS.gpu, points: pts(g('util')) }] : []),
      { color: COLORS.cpu, points: pts((s) => (s.cpu ? s.cpu.total : null)) },
    ],
    temp: [{ color: COLORS.temp, points: pts(g('temp')) }],
    power: [{ color: COLORS.power, points: pts(g('power')) }],
    vram: [{ color: COLORS.vram, points: pts((s) => (s.gpu && s.gpu.memUsed != null ? s.gpu.memUsed / 1024 : null)) }],
    ram: [{ color: COLORS.ram, points: pts((s) => (s.ram ? s.ram.usedBytes / GB : null)) }],
  };
  for (const c of charts) c.chart.setSeries(series[c.key]);
}

// ---------- lifecycle ----------

function render() {
  if (!info) return;
  const s = history.length ? history[history.length - 1] : null;
  const last = s && s.gap ? null : s;
  $('device-sections').replaceChildren(gpuSection(last), cpuSection(last), ramSection(last), storageSection(last), systemSection(last));
  renderHeader();
  updateCharts();
}

function onSample(sample) {
  if (!running) return;
  history.push(sample);
  const cutoff = Date.now() - info.historySec * 1000;
  while (history.length && history[0].t < cutoff) history.shift();
  render();
}

async function sync() {
  const shouldRun = visible && document.visibilityState === 'visible';
  if (shouldRun === running) return;
  running = shouldRun;
  if (running) {
    if (!info) {
      info = await window.blazma.monitorInfo();
      buildCharts();
    }
    const { monitorIntervalMs } = await window.blazma.getSettings();
    render();
    window.blazma.monitorStart(monitorIntervalMs);
  } else {
    window.blazma.monitorStop();
    // A gap marker so charts do not draw a line across the paused period.
    history.push({ t: Date.now(), gap: true });
  }
}

export async function refreshDeviceInfo() {
  info = await window.blazma.monitorInfo();
  if (running) {
    const { monitorIntervalMs } = await window.blazma.getSettings();
    window.blazma.monitorStart(monitorIntervalMs);
  }
  if (charts) render();
}

export function setDeviceVisible(v) {
  visible = v;
  sync();
}

export function initDevice() {
  $('btn-bench').textContent = D.benchmark;
  $('btn-export').textContent = D.exportReport;
  $('btn-bench').addEventListener('click', runBench);
  $('btn-export').addEventListener('click', exportReport);
  document.addEventListener('visibilitychange', sync);
  window.blazma.onMonitorSample(onSample);
  window.blazma.onSetupState((s) => {
    setupState = s;
    renderHeader();
  });
  window.blazma.getSetupState().then((s) => {
    setupState = s;
    renderHeader();
  });
}
