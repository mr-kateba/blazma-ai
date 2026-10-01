// The chat's mini hardware monitor: a small panel in a corner of the chat,
// like a game overlay, with the graphics card, CPU, memory and the speed of
// the reply being written. It uses the same readings as "جهازي" and asks for
// them only while the chat is on screen and the panel is on.

import { ar } from '../i18n/ar.js';
import { el } from '../lib/dom.js';
import { store } from '../lib/store.js';

const O = ar.overlay;
const CORNERS = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];

let panel = null;
let button = null;
let enabled = false;
let corner = 'top-left';
let chatVisible = false;
let running = false;
let intervalMs = 1000;
let thresholds = null;
let gpuTotalMB = null;
let speed = { tps: null, live: false };
let lastSample = null;

const fmt = (v, d = 0) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

// Each value is isolated, so an Arabic unit stays next to its own number.
function cell(text, cls = '') {
  return el('span', { class: `ov-val ${cls}`.trim(), dir: /[\u0600-\u06FF]/.test(text) ? 'rtl' : 'ltr' }, text);
}

function tempClass(t) {
  if (t == null || !thresholds) return '';
  if (t >= thresholds.gpuTempDanger) return 'danger';
  if (t >= thresholds.gpuTempWarn) return 'warn';
  return '';
}

function row(label, ...values) {
  return el('div', { class: 'ov-row' }, el('span', { class: 'ov-label' }, label), el('span', { class: 'ov-vals', dir: 'ltr' }, ...values));
}

function render() {
  if (!panel) return;
  const s = lastSample;
  const g = s && s.gpu;
  const c = s && s.cpu;
  const r = s && s.ram;
  const rows = [];
  if (g) {
    rows.push(row(O.gpu, cell(`${fmt(g.util)}%`), cell(`${fmt(g.temp)}°`, tempClass(g.temp)), cell(O.watts(fmt(g.power)))));
    const total = g.memTotal ?? gpuTotalMB;
    rows.push(row(O.vram, cell(O.gb(fmt(g.memUsed != null ? g.memUsed / 1024 : null, 1), fmt(total != null ? total / 1024 : null, 1)))));
  } else if (s) {
    rows.push(row(O.gpu, cell(O.noGpu, 'dim')));
  }
  rows.push(row(O.cpu, cell(`${fmt(c && c.total)}%`), cell(`${fmt(c && c.tempC)}°`), cell(O.watts(fmt(c && c.powerW)))));
  if (r) rows.push(row(O.ram, cell(O.gb(fmt(r.usedBytes / 1024 ** 3, 1), fmt(r.totalBytes / 1024 ** 3, 1)))));
  rows.push(row(O.speed, cell(speed.tps ? O.tps(speed.tps.toFixed(1)) : '—', speed.live ? 'live' : 'dim')));
  panel.querySelector('.ov-body').replaceChildren(...rows);
}

function place() {
  if (!panel) return;
  for (const c of CORNERS) panel.classList.toggle(`at-${c}`, c === corner);
}

// Drag the panel; on release it snaps to the nearest corner of the chat.
function setupDrag(host) {
  let start = null;
  panel.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('button')) return;
    const box = panel.getBoundingClientRect();
    start = { x: e.clientX, y: e.clientY, left: box.left, top: box.top };
    panel.setPointerCapture(e.pointerId);
    panel.classList.add('dragging');
  });
  panel.addEventListener('pointermove', (e) => {
    if (!start) return;
    const hostBox = host.getBoundingClientRect();
    panel.style.left = `${start.left + e.clientX - start.x - hostBox.left}px`;
    panel.style.top = `${start.top + e.clientY - start.y - hostBox.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  panel.addEventListener('pointerup', () => {
    if (!start) return;
    start = null;
    panel.classList.remove('dragging');
    const hostBox = host.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    const midX = box.left + box.width / 2 - hostBox.left;
    const midY = box.top + box.height / 2 - hostBox.top;
    corner = `${midY < hostBox.height / 2 ? 'top' : 'bottom'}-${midX < hostBox.width / 2 ? 'left' : 'right'}`;
    panel.style.left = panel.style.top = panel.style.right = panel.style.bottom = '';
    place();
    window.blazma.updateSettings({ overlayCorner: corner });
  });
}

async function sync() {
  const want = enabled && chatVisible && document.visibilityState === 'visible';
  if (panel) panel.hidden = !enabled;
  if (button) button.setAttribute('aria-pressed', String(enabled));
  if (want && !running) {
    running = true;
    const info = await window.blazma.monitorInfo();
    thresholds = info.thresholds;
    gpuTotalMB = info.gpu ? info.gpu.vramMB : null;
    lastSample = await window.blazma.monitorLast();
    render();
    window.blazma.monitorStart(intervalMs, 'overlay');
  } else if (!want && running) {
    running = false;
    window.blazma.monitorStop('overlay');
  }
}

async function setEnabled(on) {
  enabled = on;
  await window.blazma.updateSettings({ overlayEnabled: on });
  sync();
}

export function setOverlayChatVisible(v) {
  chatVisible = v;
  sync();
}

// Settings page changes (on/off, corner, update speed).
export async function refreshOverlaySettings() {
  const s = await window.blazma.getSettings();
  enabled = s.overlayEnabled;
  corner = s.overlayCorner;
  const changed = intervalMs !== s.monitorIntervalMs;
  intervalMs = s.monitorIntervalMs;
  place();
  if (running && changed) window.blazma.monitorStart(intervalMs, 'overlay');
  sync();
}

export async function initOverlay() {
  const host = document.querySelector('.chat-main');
  button = document.getElementById('btn-overlay');
  const hide = el('button', { type: 'button', class: 'ov-close', title: O.hide, 'aria-label': O.hide }, '×');
  hide.addEventListener('click', () => setEnabled(false));
  panel = el(
    'div',
    { class: 'hw-overlay', role: 'status', 'aria-label': O.title, hidden: true },
    el('div', { class: 'ov-head' }, el('span', null, O.title), hide),
    el('div', { class: 'ov-body' }),
  );
  host.append(panel);
  setupDrag(host);
  button.addEventListener('click', () => setEnabled(!enabled));
  window.blazma.onMonitorSample((sample) => {
    lastSample = sample;
    if (running) render();
  });
  window.addEventListener('blazma:gen-speed', (e) => {
    speed = { tps: e.detail.tps ?? speed.tps, live: e.detail.live };
    if (running) render();
  });
  document.addEventListener('visibilitychange', sync);
  speed.tps = store.lastSpeed;
  await refreshOverlaySettings();
}
