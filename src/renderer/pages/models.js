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
let ollama = null; // last scan: { dir, found, models }
let localStatus = null;
let filter = 'all';
try {
  filter = localStorage.getItem('blazma.models.filter') || 'all';
} catch {
  /* storage unavailable: start with all */
}

const ARABIC_ORIGINS = ['sa', 'ae', 'qa'];
const FILTERS = {
  all: () => true,
  fits: (m) => m.fit === 'ok',
  cn: (m) => m.origin === 'cn',
  arabic: (m) => (m.tags || []).includes('arabic') || ARABIC_ORIGINS.includes(m.origin),
  code: (m) => (m.tags || []).includes('code'),
  vision: (m) => m.vision,
};

// Size groups by the graphics memory a model needs to run fully on the card.
function groupOf(m) {
  if (m.custom || m.local) return 'mine';
  if (m.cpu || m.minVramMB <= 6144) return 'small';
  if (m.minVramMB <= 12288) return 'mid';
  if (m.minVramMB <= 16384) return 'big';
  return 'xl';
}

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
  if ((m.tags || []).includes('code')) tags.push(el('span', { class: 'tag' }, M.code));
  if (m.source === 'ollama') tags.push(el('span', { class: 'tag' }, M.fromOllama));
  else if (m.local) tags.push(el('span', { class: 'tag' }, M.localFile));
  else if (m.custom) tags.push(el('span', { class: 'tag' }, M.custom));
  if (m.local && !m.downloaded) tags.push(el('span', { class: 'tag tag-warn' }, M.fileMissing));
  if (m.fit === 'too-big') tags.push(el('span', { class: 'tag tag-warn' }, ar.setup.tooBig));
  else if (m.fit === 'slow') tags.push(el('span', { class: 'tag tag-warn' }, state.hardware && state.hardware.nvidia ? ar.setup.usesRam : ar.setup.slowOnCpu));

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
    m.maker ? el('div', { class: 'model-maker small' }, M.maker(m.maker, M.countries[m.origin] || '')) : null,
    m.note ? el('div', { class: 'muted small' }, m.note) : null,
    el('div', { class: 'faint small', dir: 'ltr' }, m.local ? m.path : m.hf),
    m.local && m.hasTemplate === false ? el('div', { class: 'small warn-text' }, M.noTemplate) : null,
    el(
      'div',
      { class: 'faint small' },
      m.license ? M.license(m.license) : m.local ? M.localNote : M.customLicense,
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
    filterBar(),
    ...catalogGroups(),
    el('p', { class: 'faint small giants' }, M.giants),
    localSection(),
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

function filterBar() {
  return el(
    'div',
    { class: 'model-filters', role: 'tablist' },
    ...Object.keys(FILTERS).map((key) => {
      const count = state.models.filter(FILTERS[key]).length;
      const b = el('button', { type: 'button', class: `chip${filter === key ? ' on' : ''}`, role: 'tab', 'aria-selected': String(filter === key) }, M.filters[key], el('span', { class: 'chip-count' }, String(count)));
      b.addEventListener('click', () => {
        filter = key;
        try {
          localStorage.setItem('blazma.models.filter', key);
        } catch {
          /* remembered for this session only */
        }
        render();
      });
      return b;
    }),
  );
}

function catalogGroups() {
  const list = state.models.filter(FILTERS[filter] || FILTERS.all);
  if (!list.length) return [el('p', { class: 'muted' }, M.noMatch)];
  const out = [];
  for (const g of ['small', 'mid', 'big', 'xl', 'mine']) {
    const items = list.filter((m) => groupOf(m) === g).sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
    if (!items.length) continue;
    out.push(el('h3', { class: 'model-group-title' }, M.groups[g]), el('div', { class: 'model-grid' }, ...items.map(modelCard)));
  }
  return out;
}

// Models already on this computer: a GGUF file, or Ollama's downloads.
function localSection() {
  const addFile = el('button', { type: 'button', class: 'btn primary' }, M.addFile);
  addFile.addEventListener('click', async () => {
    const res = await window.blazma.modelsAddLocalFile();
    if (!res.ok) localStatus = { kind: 'error', text: (ar.errors[res.error.code] || ar.errors.unknown).title };
    else if (res.result) localStatus = { kind: 'ok', text: M.added(res.result.name) };
    refresh();
  });
  const scan = el('button', { type: 'button', class: 'btn' }, M.scanOllama);
  scan.addEventListener('click', async () => {
    scan.disabled = true;
    const res = await window.blazma.modelsScanOllama();
    ollama = res.ok ? res.result : { found: false, models: [], error: true };
    render();
  });
  let list = null;
  if (ollama) {
    if (!ollama.found) list = el('p', { class: 'muted small' }, M.ollamaNone(ollama.dir || ''));
    else if (!ollama.models.length) list = el('p', { class: 'muted small' }, M.ollamaEmpty);
    else
      list = el(
        'div',
        { class: 'ollama-list' },
        ...ollama.models.map((om) => {
          let action;
          if (om.added) action = el('span', { class: 'tag tag-ok' }, M.alreadyAdded);
          else if (!om.ok) action = el('span', { class: 'faint small' }, M.ollamaReasons[om.reason] || om.reason);
          else {
            action = el('button', { type: 'button', class: 'btn small' }, M.addOne);
            action.addEventListener('click', async () => {
              action.disabled = true;
              const res = await window.blazma.modelsAddOllama(om.key);
              if (res.ok) {
                om.added = true;
                localStatus = { kind: 'ok', text: M.added(res.result.name) };
              } else localStatus = { kind: 'error', text: (ar.errors[res.error.code] || ar.errors.unknown).title };
              refresh();
            });
          }
          return el(
            'div',
            { class: 'ollama-row' },
            el('b', { dir: 'ltr' }, om.name),
            om.ok ? el('span', { class: 'muted small' }, formatBytes(om.size)) : null,
            om.vision ? el('span', { class: 'tag' }, M.vision) : null,
            el('span', { class: 'spacer' }),
            action,
          );
        }),
      );
  }
  return el(
    'section',
    { class: 'set-card add-model' },
    el('h2', null, M.localTitle),
    el('p', { class: 'muted small' }, M.localHint),
    el('div', { class: 'row' }, addFile, scan),
    localStatus ? el('div', { class: `add-status ${localStatus.kind}` }, localStatus.text) : null,
    list,
  );
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
