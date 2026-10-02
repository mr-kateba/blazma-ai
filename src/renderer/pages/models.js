// "الموديلات": catalog and custom models, download/switch (via the same setup
// flow as the chat page, so progress is real), delete from disk, and adding a
// model from Hugging Face after checking it exists.

import { ui, formatBytes } from '../i18n/index.js';
import { el } from '../lib/dom.js';
import { confirmDialog } from '../lib/dialog.js';

const M = ui.modelsPage;
const $ = (id) => document.getElementById(id);

let state = null;
let visible = false;
let addStatus = null; // { kind: 'info'|'ok'|'error', text }
let notice = null;
let scan = null; // last local scan: { source: 'folder'|'lmstudio'|'ollama', dir, found, models }
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
  translate: (m) => (m.tags || []).includes('translate'),
  vision: (m) => m.vision,
};

// Size groups by the graphics memory a model needs to run fully on the card.
function groupOf(m) {
  if (m.custom || m.local) return 'mine';
  if (m.cpu || m.minVramMB <= 6144) return 'small';
  if (m.minVramMB <= 12288) return 'mid';
  if (m.minVramMB <= 16384) return 'big';
  if (m.minVramMB <= 24576) return 'xl';
  return 'giant';
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
  if (m.id === state.recommendedId) tags.push(el('span', { class: 'tag tag-accent' }, ui.setup.recommended));
  if (isActive) tags.push(el('span', { class: 'tag tag-ok' }, M.active));
  if (m.downloaded && !isActive) tags.push(el('span', { class: 'tag' }, ui.setup.downloaded));
  if (m.vision) tags.push(el('span', { class: 'tag' }, M.vision));
  if ((m.tags || []).includes('code')) tags.push(el('span', { class: 'tag' }, M.code));
  if ((m.tags || []).includes('translate')) tags.push(el('span', { class: 'tag' }, M.translate));
  if (m.source === 'ollama') tags.push(el('span', { class: 'tag' }, M.fromOllama));
  else if (m.source === 'lmstudio') tags.push(el('span', { class: 'tag' }, M.fromLmStudio));
  else if (m.local) tags.push(el('span', { class: 'tag' }, M.localFile));
  else if (m.custom) tags.push(el('span', { class: 'tag' }, M.custom));
  if (m.local && !m.downloaded) tags.push(el('span', { class: 'tag tag-warn' }, M.fileMissing));
  if (m.fit === 'too-big') tags.push(el('span', { class: 'tag tag-warn' }, ui.setup.tooBig));
  else if (m.fit === 'slow') tags.push(el('span', { class: 'tag tag-warn' }, state.hardware && state.hardware.nvidia ? ui.setup.usesRam : ui.setup.slowOnCpu));

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
            if (!(await confirmDialog({ text: M.confirmDelete(m.name), ok: M.deleteLocal, danger: true }))) return;
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
            if (!(await confirmDialog({ text: M.confirmRemoveCustom(m.name), danger: true }))) return;
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
    el('div', { class: 'faint small model-path', dir: 'ltr', title: m.local ? m.path : m.hf }, m.local ? m.path : m.hf),
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
  for (const g of ['small', 'mid', 'big', 'xl', 'giant', 'mine']) {
    const items = list.filter((m) => groupOf(m) === g).sort((a, b) => (a.sizeBytes || 0) - (b.sizeBytes || 0));
    if (!items.length) continue;
    out.push(el('h3', { class: 'model-group-title' }, M.groups[g]), el('div', { class: 'model-grid' }, ...items.map(modelCard)));
  }
  return out;
}

// Models already on this computer: a GGUF file (picked or dropped), every
// GGUF in a folder, LM Studio's models, or Ollama's downloads.
const SCANNERS = {
  folder: { scan: () => window.blazma.modelsScanFolder(), add: (key) => window.blazma.modelsAddScanned(key) },
  lmstudio: { scan: () => window.blazma.modelsScanLmStudio(), add: (key) => window.blazma.modelsAddScanned(key) },
  ollama: { scan: () => window.blazma.modelsScanOllama(), add: (key) => window.blazma.modelsAddOllama(key) },
};

function localResult(res, okText) {
  if (!res.ok) localStatus = { kind: 'error', text: (ui.errors[res.error.code] || ui.errors.unknown).title };
  else if (res.result) localStatus = { kind: 'ok', text: okText || M.added(res.result.name) };
}

function scanButton(source, label) {
  const b = el('button', { type: 'button', class: 'btn' }, label);
  b.addEventListener('click', async () => {
    b.disabled = true;
    const res = await SCANNERS[source].scan();
    b.disabled = false;
    if (res.ok && res.result === null) return; // folder dialog cancelled
    scan = res.ok ? { source, ...res.result } : { source, found: false, models: [], error: true };
    render();
  });
  return b;
}

function scanList() {
  if (!scan) return null;
  if (!scan.found) return el('p', { class: 'muted small' }, M.scanNone[scan.source](scan.dir || ''));
  if (!scan.models.length) return el('p', { class: 'muted small' }, M.scanEmpty[scan.source]);
  const addable = scan.models.filter((m) => m.ok && !m.added);
  const addOne = async (item) => {
    const res = await SCANNERS[scan.source].add(item.key);
    if (res.ok) item.added = true;
    localResult(res);
    return res.ok;
  };
  const rows = scan.models.map((item) => {
    let action;
    if (item.added) action = el('span', { class: 'tag tag-ok' }, M.alreadyAdded);
    else if (!item.ok) action = el('span', { class: 'faint small' }, M.ollamaReasons[item.reason] || item.reason);
    else {
      action = el('button', { type: 'button', class: 'btn small' }, M.addOne);
      action.addEventListener('click', async () => {
        action.disabled = true;
        await addOne(item);
        refresh();
      });
    }
    return el(
      'div',
      { class: 'ollama-row' },
      el('span', { class: 'scan-name' }, el('b', { dir: 'ltr' }, item.name), item.rel && item.rel !== item.name ? el('span', { class: 'faint small', dir: 'ltr' }, item.rel) : null),
      item.ok ? el('span', { class: 'muted small' }, formatBytes(item.size)) : null,
      item.vision ? el('span', { class: 'tag' }, M.vision) : null,
      el('span', { class: 'spacer' }),
      action,
    );
  });
  let addAll = null;
  if (addable.length > 1) {
    addAll = el('button', { type: 'button', class: 'btn small primary' }, M.addAll(addable.length));
    addAll.addEventListener('click', async () => {
      addAll.disabled = true;
      let n = 0;
      for (const item of addable) if (await addOne(item)) n++;
      localStatus = { kind: n ? 'ok' : 'error', text: M.addedMany(n) };
      refresh();
    });
  }
  return el('div', { class: 'ollama-list' }, el('div', { class: 'scan-head' }, el('span', { class: 'faint small', dir: 'ltr' }, scan.dir), el('span', { class: 'spacer' }), addAll), ...rows);
}

function localSection() {
  const addFile = el('button', { type: 'button', class: 'btn primary' }, M.addFile);
  addFile.addEventListener('click', async () => {
    localResult(await window.blazma.modelsAddLocalFile());
    refresh();
  });
  return el(
    'section',
    { class: 'set-card add-model local-models' },
    el('h2', null, M.localTitle),
    el('p', { class: 'muted small' }, M.localHint),
    el('div', { class: 'row wrap' }, addFile, scanButton('folder', M.scanFolder), scanButton('lmstudio', M.scanLmStudio), scanButton('ollama', M.scanOllama)),
    el('p', { class: 'faint small' }, M.dropHint),
    localStatus ? el('div', { class: `add-status ${localStatus.kind}` }, localStatus.text) : null,
    scanList(),
  );
}

// Drop .gguf files anywhere on the models page to add them.
function setupDrop(root) {
  root.dataset.drop = M.dropHere;
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  root.addEventListener('dragover', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    root.classList.add('drop-on');
  });
  root.addEventListener('dragleave', (e) => {
    if (!root.contains(e.relatedTarget)) root.classList.remove('drop-on');
  });
  root.addEventListener('drop', async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    root.classList.remove('drop-on');
    const files = [...e.dataTransfer.files];
    const gguf = files.filter((f) => /\.gguf$/i.test(f.name));
    if (!gguf.length) {
      localStatus = { kind: 'error', text: ui.errors['not-gguf'].title };
      render();
      return;
    }
    let n = 0;
    let last = null;
    for (const f of gguf) {
      last = await window.blazma.modelsAddDropped(f);
      if (last.ok) n++;
    }
    if (gguf.length === 1) localResult(last);
    else localStatus = { kind: n ? 'ok' : 'error', text: M.addedMany(n) };
    refresh();
  });
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
  setupDrop($('models-root'));
  window.blazma.onSetupState((s) => {
    state = s;
    render();
  });
  window.blazma.getSetupState().then((s) => {
    state = s;
    render();
  });
}
