// "الموديلات": catalog and custom models, download/switch (via the same setup
// flow as the chat page, so progress is real), delete from disk, and adding a
// model from Hugging Face after checking it exists.

import { ar, formatBytes } from '../i18n/ar.js';
import { el } from '../lib/dom.js';

const M = ar.modelsPage;
const $ = (id) => document.getElementById(id);

let state = null;
let visible = false;
let addStatus = null; // { kind: 'info'|'ok'|'error', text }
let notice = null;

function progressFor(m) {
  if (!state || state.modelId !== m.id) return null;
  if (state.phase === 'model-download' && state.progress && state.progress.total) {
    return Math.floor((state.progress.done / state.progress.total) * 100);
  }
  return null;
}

function modelCard(m) {
  const isActive = state.modelId === m.id && state.phase === 'ready';
  const isStarting = state.modelId === m.id && ['engine', 'model-resolve', 'model-download', 'waiting-network', 'loading'].includes(state.phase);
  const pct = progressFor(m);

  const tags = [];
  if (m.id === state.recommendedId) tags.push(el('span', { class: 'tag tag-accent' }, ar.setup.recommended));
  if (isActive) tags.push(el('span', { class: 'tag tag-ok' }, M.active));
  if (m.downloaded && !isActive) tags.push(el('span', { class: 'tag' }, ar.setup.downloaded));
  if (m.vision) tags.push(el('span', { class: 'tag' }, M.vision));
  if (m.custom) tags.push(el('span', { class: 'tag' }, M.custom));
  if (!m.fits) tags.push(el('span', { class: 'tag tag-warn' }, state.hardware && state.hardware.nvidia ? ar.setup.notFit : ar.setup.slowOnCpu));

  const actions = el('div', { class: 'row' });
  if (isActive) {
    actions.append(el('button', { type: 'button', class: 'btn', disabled: true }, M.active));
  } else if (isStarting) {
    actions.append(el('button', { type: 'button', class: 'btn', disabled: true }, state.phase === 'waiting-network' ? M.waitingNetwork : pct != null ? M.downloading(pct) : M.starting));
  } else {
    actions.append(
      el('button', { type: 'button', class: 'btn primary', onclick: () => window.blazma.modelsUse(m.id) }, m.downloaded ? M.use : M.download),
    );
  }
  if (m.onDisk > 0 && !isActive && !isStarting) {
    actions.append(
      el(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            if (!window.confirm(M.confirmDelete(m.name))) return;
            const res = await window.blazma.modelsDelete(m.id);
            notice = res.ok ? null : M.inUse;
            refresh();
          },
        },
        M.deleteLocal,
      ),
    );
  }
  if (m.custom && !isActive && !isStarting) {
    actions.append(
      el(
        'button',
        {
          type: 'button',
          class: 'btn ghost',
          onclick: async () => {
            if (!window.confirm(M.confirmRemoveCustom(m.name))) return;
            const res = await window.blazma.modelsRemoveCustom(m.id);
            notice = res.ok ? null : M.inUse;
            refresh();
          },
        },
        M.removeCustom,
      ),
    );
  }

  const bar = pct != null ? el('div', { class: 'progress' }, el('div', { class: 'progress-fill' })) : null;
  if (bar) bar.firstChild.style.width = `${pct}%`;

  return el(
    'div',
    { class: `model-card${isActive ? ' active' : ''}` },
    el('div', { class: 'model-option-head' }, el('b', { dir: 'ltr' }, m.name), el('span', { class: 'muted' }, formatBytes(m.sizeBytes)), ...tags),
    m.note ? el('div', { class: 'muted small' }, m.note) : null,
    el('div', { class: 'faint small', dir: 'ltr' }, m.hf),
    el(
      'div',
      { class: 'faint small' },
      m.license ? M.license(m.license) : M.customLicense,
      m.onDisk > 0 ? ` · ${m.downloaded ? M.onDisk(formatBytes(m.onDisk)) : M.partial(formatBytes(m.onDisk))}` : '',
    ),
    bar,
    actions,
  );
}

function render() {
  if (!state || !visible) return;
  const hw = state.hardware;
  const gpu = hw && hw.nvidia;
  const input = el('input', { type: 'text', id: 'custom-hf', dir: 'ltr', placeholder: 'unsloth/Qwen3.5-4B-GGUF:Q4_K_M' });
  const add = el('button', { type: 'button', class: 'btn primary' }, M.addButton);
  add.addEventListener('click', async () => {
    const hf = input.value.trim();
    if (!hf) return;
    addStatus = { kind: 'info', text: M.checking };
    render();
    const res = await window.blazma.modelsAddCustom(hf);
    addStatus = res.ok ? { kind: 'ok', text: M.added(res.result.name) } : { kind: 'error', text: M.addFailed[res.error.code] || M.addFailed['model-not-found'] };
    refresh();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && add.click());

  const hwLine = gpu
    ? el('p', { class: 'muted' }, M.gpuLabel, el('bdi', { dir: 'ltr' }, gpu.name), ` · ${M.vram((gpu.vramMB / 1024).toFixed(0))}`)
    : el('p', { class: 'muted' }, M.noGpu);
  const children = [
    hwLine,
    notice ? el('div', { class: 'notice' }, notice) : null,
    el('h2', { class: 'section-title' }, M.catalog),
    el('div', { class: 'model-grid' }, ...state.models.map(modelCard)),
    el(
      'section',
      { class: 'set-card add-model' },
      el('h2', null, M.addTitle),
      el('p', { class: 'muted small' }, M.addHint),
      el('div', { class: 'row' }, input, add),
      addStatus ? el('div', { class: `add-status ${addStatus.kind}` }, addStatus.text) : null,
    ),
  ];
  $('models-root').replaceChildren(...children.filter(Boolean));
}

async function refresh() {
  if (state) state.models = await window.blazma.modelsList();
  render();
}

export function setModelsVisible(v) {
  visible = v;
  if (v) {
    notice = null;
    refresh();
  }
}

export function initModels() {
  window.blazma.onSetupState((s) => {
    state = s;
    render();
  });
  window.blazma.getSetupState().then((s) => {
    state = s;
    render();
  });
}
