// Settings page: chat, engine, "جهازي", general, updates and about.
// Changes are saved as soon as they are made. Engine settings (context,
// GPU layers, port) apply after restarting the engine, offered in place.

import { ar } from '../i18n/ar.js';
import { el } from '../lib/dom.js';
import { refreshDeviceInfo } from './device.js';

const S = ar.settingsPage;
const $ = (id) => document.getElementById(id);

let values = null;
let engineDirty = false;
let toastTimer = null;
let updatesState = null; // last check result
let updating = false;

// ---------- small building blocks ----------

function toast(text, kind = 'ok') {
  let node = document.querySelector('.set-toast');
  if (!node) {
    node = el('div', { class: 'set-toast', role: 'status' });
    document.body.append(node);
  }
  node.textContent = text;
  node.className = `set-toast ${kind} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 1800);
}

async function save(patch, { engine = false } = {}) {
  values = await window.blazma.updateSettings(patch);
  if (engine) {
    engineDirty = true;
    renderEngineBanner();
  }
  toast(S.saved);
  return values;
}

function toggle(checked, onChange, { disabled = false } = {}) {
  const input = el('input', { type: 'checkbox', role: 'switch', checked, disabled });
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: `switch${disabled ? ' disabled' : ''}` }, input, el('span', { class: 'switch-track' }, el('span', { class: 'switch-thumb' })));
}

function item(title, desc, control, extra = null) {
  return el(
    'div',
    { class: 'set-item' },
    el('div', { class: 'set-text' }, el('div', { class: 'set-title' }, title), desc ? el('div', { class: 'set-desc' }, desc) : null, extra),
    control ? el('div', { class: 'set-control' }, control) : null,
  );
}

function section(id, title, desc, ...items) {
  return el('section', { class: 'set-section', id: `set-${id}`, 'data-section': id }, el('h2', null, title), desc ? el('p', { class: 'set-section-desc' }, desc) : null, el('div', { class: 'set-box' }, ...items));
}

function select(options, value, onChange) {
  const node = el('select', null, ...options.map(([v, label]) => el('option', { value: String(v), selected: String(v) === String(value) }, label)));
  node.addEventListener('change', () => onChange(node.value));
  return node;
}

// ---------- sections ----------

function chatSection() {
  const prompt = el('textarea', { class: 'set-textarea', rows: '4', dir: 'auto' });
  prompt.value = values.systemPrompt;
  let promptTimer = null;
  prompt.addEventListener('input', () => {
    clearTimeout(promptTimer);
    promptTimer = setTimeout(() => save({ systemPrompt: prompt.value.slice(0, 20000) }), 700);
  });
  const resetPrompt = el('button', { type: 'button', class: 'btn ghost small' }, S.restoreDefault);
  resetPrompt.addEventListener('click', async () => {
    prompt.value = values.defaults.systemPrompt;
    await save({ systemPrompt: values.defaults.systemPrompt });
  });

  const auto = values.temperature === null;
  const range = el('input', { type: 'range', min: '0', max: '2', step: '0.1', value: String(values.temperature ?? 0.7), disabled: auto, dir: 'ltr' });
  const rangeValue = el('span', { class: 'range-value', dir: 'ltr' }, auto ? '—' : String(values.temperature));
  range.addEventListener('input', () => (rangeValue.textContent = range.value));
  range.addEventListener('change', () => save({ temperature: Number(range.value) }));
  const tempAuto = toggle(auto, async (on) => {
    range.disabled = on;
    rangeValue.textContent = on ? '—' : range.value;
    await save({ temperature: on ? null : Number(range.value) });
  });

  return section(
    'chat',
    S.chat.title,
    S.chat.desc,
    item(S.chat.prompt, S.chat.promptDesc, null, el('div', { class: 'set-stack' }, prompt, el('div', { class: 'row' }, resetPrompt))),
    item(S.chat.tempAuto, S.chat.tempAutoDesc, tempAuto),
    item(S.chat.temp, S.chat.tempDesc, el('div', { class: 'range-row' }, range, rangeValue)),
    item(S.chat.web, S.chat.webDesc, toggle(values.webSearch, (on) => save({ webSearch: on }))),
    item(S.chat.device, S.chat.deviceDesc, toggle(values.shareDeviceInfo, (on) => save({ shareDeviceInfo: on }))),
  );
}

function engineSection(state) {
  const ctx = select(
    [2048, 4096, 8192, 16384, 32768, 65536].map((n) => [n, S.engine.ctxOption(n)]),
    values.contextSize,
    (v) => save({ contextSize: Number(v) }, { engine: true }),
  );
  const gpu = select(
    [[99, S.engine.gpuAll], [0, S.engine.gpuNone], ...[8, 16, 24, 32, 40].map((n) => [n, S.engine.gpuLayersN(n)])],
    [0, 8, 16, 24, 32, 40].includes(values.gpuLayers) ? values.gpuLayers : 99,
    (v) => save({ gpuLayers: Number(v) }, { engine: true }),
  );
  const port = el('input', { type: 'number', min: '1024', max: '65535', value: String(values.port), dir: 'ltr', class: 'set-number' });
  port.addEventListener('change', () => {
    const n = Number(port.value);
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      toast(S.engine.portInvalid, 'error');
      port.value = String(values.port);
      return;
    }
    save({ port: n }, { engine: true });
  });

  const dirText = el('code', { class: 'set-path', dir: 'ltr' }, values.modelsDir);
  const choose = el('button', { type: 'button', class: 'btn small' }, S.engine.chooseDir);
  choose.addEventListener('click', async () => {
    const res = await window.blazma.chooseModelsDir();
    if (res.error) toast(S.engine.notWritable, 'error');
    else if (res.modelsDir !== values.modelsDir) toast(S.engine.dirChanged);
    values = res;
    dirText.textContent = values.modelsDir;
    resetDir.hidden = !values.modelsDirCustom;
  });
  const resetDir = el('button', { type: 'button', class: 'btn ghost small', hidden: !values.modelsDirCustom }, S.restoreDefault);
  resetDir.addEventListener('click', async () => {
    values = await window.blazma.resetModelsDir();
    dirText.textContent = values.modelsDir;
    resetDir.hidden = true;
    toast(S.saved);
  });
  const openDir = el('button', { type: 'button', class: 'btn ghost small' }, S.openFolder);
  openDir.addEventListener('click', () => window.blazma.openFolder('models'));

  const eng = state && state.engine;
  const engineInfo = eng ? S.engine.installed(eng.tag, eng.variant) : S.engine.notInstalled;

  return section(
    'engine',
    S.engine.title,
    S.engine.desc,
    el('div', { id: 'engine-banner' }),
    item(S.engine.ctx, S.engine.ctxDesc, ctx),
    item(S.engine.gpu, S.engine.gpuDesc, gpu),
    item(S.engine.port, S.engine.portDesc, port),
    item(S.engine.dir, S.engine.dirDesc, null, el('div', { class: 'set-stack' }, dirText, el('div', { class: 'row' }, choose, openDir, resetDir))),
    item(S.engine.version, engineInfo, null),
  );
}

function renderEngineBanner() {
  const box = $('engine-banner');
  if (!box) return;
  if (!engineDirty) {
    box.replaceChildren();
    return;
  }
  const restart = el('button', { type: 'button', class: 'btn primary small' }, S.engine.restartNow);
  restart.addEventListener('click', async () => {
    await window.blazma.restartServer();
    engineDirty = false;
    renderEngineBanner();
    toast(S.engine.restarting);
  });
  box.replaceChildren(el('div', { class: 'set-banner' }, el('span', null, S.engine.needsRestart), restart));
}

function monitorSection(info) {
  const auto = values.gpuTempWarn === null && values.gpuTempDanger === null;
  const interval = select(
    [1000, 2000, 5000].map((ms) => [ms, S.seconds(ms / 1000)]),
    values.monitorIntervalMs,
    async (v) => {
      await save({ monitorIntervalMs: Number(v) });
      await refreshDeviceInfo();
    },
  );
  const warn = el('input', { type: 'number', min: '30', max: '110', class: 'set-number', dir: 'ltr', value: String(values.gpuTempWarn ?? info.thresholds.gpuTempWarn), disabled: auto });
  const danger = el('input', { type: 'number', min: '30', max: '110', class: 'set-number', dir: 'ltr', value: String(values.gpuTempDanger ?? info.thresholds.gpuTempDanger), disabled: auto });
  const saveTemps = async () => {
    const w = Number(warn.value);
    const d = Number(danger.value);
    if (!Number.isInteger(w) || !Number.isInteger(d) || w < 30 || d > 110 || w >= d) {
      toast(S.invalid, 'error');
      return;
    }
    await save({ gpuTempWarn: w, gpuTempDanger: d });
    await refreshDeviceInfo();
  };
  warn.addEventListener('change', saveTemps);
  danger.addEventListener('change', saveTemps);
  const autoToggle = toggle(auto, async (on) => {
    warn.disabled = on;
    danger.disabled = on;
    if (on) {
      await save({ gpuTempWarn: null, gpuTempDanger: null });
      await refreshDeviceInfo();
    } else await saveTemps();
  });
  return section(
    'monitor',
    S.monitorTitle,
    null,
    item(S.interval, S.intervalDesc, interval),
    item(S.auto, S.autoNote(info.thresholds.gpuTempWarn, info.thresholds.gpuTempDanger), autoToggle),
    item(S.warn, null, warn),
    item(S.danger, null, danger),
  );
}

function generalSection() {
  const login = values.launchAtLogin;
  const openData = el('button', { type: 'button', class: 'btn ghost small' }, S.openFolder);
  openData.addEventListener('click', () => window.blazma.openFolder('data'));
  return section(
    'general',
    S.general.title,
    null,
    item(
      S.general.login,
      login.supported ? S.general.loginDesc : S.general.loginUnsupported,
      toggle(login.enabled, async (on) => {
        values = await window.blazma.setLaunchAtLogin(on);
        toast(S.saved);
      }, { disabled: !login.supported }),
    ),
    item(S.general.data, S.general.dataDesc, openData),
  );
}

function updatesSection() {
  const box = el('div', { id: 'updates-result', class: 'set-stack' });
  const check = el('button', { type: 'button', class: 'btn', id: 'updates-check' }, S.updates.check);
  check.addEventListener('click', async () => {
    check.disabled = true;
    check.textContent = S.updates.checking;
    updatesState = await window.blazma.checkUpdates();
    check.disabled = false;
    check.textContent = S.updates.check;
    renderUpdates();
  });
  return section('updates', S.updates.title, S.updates.desc, item(S.updates.checkTitle, S.updates.checkDesc, check, box));
}

function errorText(err) {
  const e = ar.errors[err && err.code];
  return e ? e.title : S.updates.failed;
}

function renderUpdates() {
  const box = $('updates-result');
  if (!box || !updatesState) return;
  const rows = [];
  const a = updatesState.app;
  if (!a.ok) rows.push(el('div', { class: 'upd-row error' }, S.updates.appLabel, ': ', errorText(a.error)));
  else if (!a.result.latest) rows.push(el('div', { class: 'upd-row' }, S.updates.appLabel, ': ', S.updates.noReleases(a.result.current)));
  else if (a.result.newer) {
    const open = el('button', { type: 'button', class: 'btn primary small' }, S.updates.openDownload);
    open.addEventListener('click', () => window.blazma.openRelease(a.result.url));
    rows.push(el('div', { class: 'upd-row new' }, el('span', null, S.updates.appLabel, ': ', S.updates.appNew(a.result.latest, a.result.current)), a.result.url ? open : null));
  } else rows.push(el('div', { class: 'upd-row ok' }, S.updates.appLabel, ': ', S.updates.upToDate(a.result.current)));

  const e = updatesState.engine;
  if (!e.ok) rows.push(el('div', { class: 'upd-row error' }, S.updates.engineLabel, ': ', errorText(e.error)));
  else if (e.result.dev) rows.push(el('div', { class: 'upd-row' }, S.updates.engineLabel, ': ', S.updates.engineDev));
  else if (e.result.newer && e.result.installed) {
    const upd = el('button', { type: 'button', class: 'btn primary small', disabled: updating }, updating ? S.updates.engineUpdating : S.updates.engineUpdate);
    upd.addEventListener('click', async () => {
      updating = true;
      renderUpdates();
      const res = await window.blazma.updateEngine();
      updating = false;
      if (res.ok) {
        toast(res.result.updated ? S.updates.engineDone(res.result.tag) : S.updates.upToDate(res.result.tag));
        updatesState = await window.blazma.checkUpdates();
      } else toast(errorText(res.error), 'error');
      renderUpdates();
    });
    rows.push(el('div', { class: 'upd-row new' }, el('span', null, S.updates.engineLabel, ': ', S.updates.engineNew(e.result.latest, e.result.installed)), upd));
  } else rows.push(el('div', { class: 'upd-row ok' }, S.updates.engineLabel, ': ', e.result.installed ? S.updates.upToDate(e.result.installed) : S.updates.engineLater));
  box.replaceChildren(...rows);
}

function aboutSection(appInfo) {
  const repo = el('button', { type: 'button', class: 'btn ghost small' }, S.about.source);
  repo.addEventListener('click', () => window.blazma.openRelease('https://github.com/mr-kateba/blazma-ai/releases/'));
  return section(
    'about',
    S.about.title,
    null,
    item('Blazma AI', S.about.version(appInfo.version), repo),
    item(S.about.privacy, S.about.privacyDesc, null),
    item(S.about.credits, S.about.creditsDesc, null),
  );
}

// ---------- page ----------

const SECTIONS = ['chat', 'engine', 'monitor', 'general', 'updates', 'about'];

async function render() {
  const [v, info, state, appInfo] = await Promise.all([window.blazma.getSettings(), window.blazma.monitorInfo(), window.blazma.getSetupState(), window.blazma.getAppInfo()]);
  values = v;
  const toc = el(
    'nav',
    { class: 'set-toc', 'aria-label': S.tocLabel },
    ...SECTIONS.map((id) => {
      const b = el('button', { type: 'button', 'data-target': id }, S.toc[id]);
      b.addEventListener('click', () => $(`set-${id}`).scrollIntoView({ behavior: 'smooth', block: 'start' }));
      return b;
    }),
  );
  const body = el('div', { class: 'set-body' }, chatSection(), engineSection(state), monitorSection(info), generalSection(), updatesSection(), aboutSection(appInfo));
  $('settings-root').replaceChildren(el('div', { class: 'set-layout' }, toc, body));
  renderEngineBanner();
  renderUpdates();

  // Highlight the section in view.
  const buttons = toc.querySelectorAll('button');
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        for (const b of buttons) b.classList.toggle('active', b.dataset.target === entry.target.dataset.section);
      }
    },
    { root: document.querySelector('.content'), rootMargin: '-10% 0px -70% 0px' },
  );
  for (const s of body.querySelectorAll('.set-section')) observer.observe(s);
}

export function setSettingsVisible(v) {
  if (v) render();
}

