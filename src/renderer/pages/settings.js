// Settings page: one tab at a time (general, chat, library, model and
// performance, monitoring, developers, updates, about). Everyday options come
// first; technical ones sit under "خيارات متقدمة", and long explanations
// behind a "؟" with a tooltip. Changes are saved at once; engine settings
// apply after restarting the engine, offered in place.

import { ui } from '../i18n/index.js';
import { el } from '../lib/dom.js';
import { speak } from '../lib/speech.js';
import { refreshDeviceInfo } from './device.js';
import { refreshOverlaySettings } from './overlay.js';
import { confirmDialog } from '../lib/dialog.js';

const S = ui.settingsPage;
const $ = (id) => document.getElementById(id);

let values = null;
let engineDirty = false;
let toastTimer = null;
let updatesState = null; // last check result
let updating = false;
let appDownloading = false;
let appReady = false;
let appPct = 0;

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

// help: a longer explanation, shown in a tooltip on a "؟" next to the title.
function item(title, desc, control, extra = null, help = null) {
  // Fields get the row's title as their name (screen readers, voice control).
  const name = typeof title === 'string' ? title : '';
  for (const part of [control, extra]) {
    if (!(part instanceof Element) || !name) continue;
    const fields = part.matches('input, select, textarea') ? [part] : [...part.querySelectorAll('input, select, textarea')];
    for (const f of fields) if (!f.getAttribute('aria-label')) f.setAttribute('aria-label', name);
  }
  const head = el('div', { class: 'set-title' }, title, help ? el('span', { class: 'set-help', tabindex: '0', title: help, 'aria-label': help }, ui.common.help) : null);
  return el(
    'div',
    { class: 'set-item' },
    el('div', { class: 'set-text' }, head, desc ? el('div', { class: 'set-desc' }, desc) : null, extra),
    control ? el('div', { class: 'set-control' }, control) : null,
  );
}

function section(id, title, desc, ...items) {
  return el('section', { class: 'set-section', id: `set-${id}`, 'data-section': id, hidden: id !== currentTab }, el('h2', null, title), desc ? el('p', { class: 'set-section-desc' }, desc) : null, el('div', { class: 'set-box' }, ...items));
}

// Technical options, folded away.
function advanced(...items) {
  return el('details', { class: 'set-advanced' }, el('summary', null, S.advanced), el('div', { class: 'set-box' }, ...items));
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
    clearTimeout(promptTimer); // text typed just before must not overwrite the default
    prompt.value = values.defaults.systemPrompt;
    await save({ systemPrompt: values.defaults.systemPrompt });
  });

  // Creativity: the model's own recommendation, or a named level.
  const levels = [[0.2, S.chat.tempPrecise], [0.5, S.chat.tempBalanced], [0.7, S.chat.tempDefault], [1, S.chat.tempCreative], [1.3, S.chat.tempWild]];
  if (values.temperature !== null && !levels.some(([v]) => v === values.temperature)) levels.push([values.temperature, String(values.temperature)]);
  const temp = select(
    [['auto', S.chat.tempAuto], ...levels],
    values.temperature === null ? 'auto' : values.temperature,
    (v) => save({ temperature: v === 'auto' ? null : Number(v) }),
  );

  // Reading voice: which one, and Blazma's own voice downloaded here too.
  const ttsSelect = select([['auto', S.chat.ttsAuto], ['blazma', S.chat.ttsBlazma], ['windows', S.chat.ttsWindows]], values.ttsEngine || 'auto', (v) => save({ ttsEngine: v }));
  const ttsBox = el('div', { class: 'row' });
  const renderTts = async () => {
    const st = await window.blazma.ttsStatus();
    const tryBtn = el('button', { type: 'button', class: 'btn ghost small' }, S.chat.ttsTry);
    tryBtn.addEventListener('click', () => speak(S.chat.ttsSample, tryBtn));
    if (st.installed) return ttsBox.replaceChildren(el('span', { class: 'muted small' }, S.chat.ttsReady), tryBtn);
    const get = el('button', { type: 'button', class: 'btn small' }, S.chat.ttsInstall);
    get.addEventListener('click', async () => {
      get.disabled = true;
      const off = window.blazma.onTtsProgress((p) => (get.textContent = ui.chat.ttsDownloading(p.total ? Math.floor((p.done / p.total) * 100) : 0)));
      const res = await window.blazma.ttsInstall();
      off();
      if (!res.ok) {
        get.disabled = false;
        get.textContent = S.chat.ttsInstall;
        return toast(errorText(res.error), 'error');
      }
      renderTts();
    });
    ttsBox.replaceChildren(get, tryBtn);
  };
  renderTts();

  const backupBtn = el('button', { type: 'button', class: 'btn small' }, S.chat.backupBtn);
  backupBtn.addEventListener('click', async () => {
    const res = await window.blazma.chatsBackup();
    if (!res.ok) return toast(errorText(res.error), 'error');
    if (res.result) toast(S.chat.backupDone(res.result.count));
  });
  const restoreBtn = el('button', { type: 'button', class: 'btn ghost small' }, S.chat.restoreBtn);
  restoreBtn.addEventListener('click', async () => {
    const res = await window.blazma.chatsRestore();
    if (!res.ok) return toast(errorText(res.error), 'error');
    if (res.result) {
      toast(S.chat.restoreDone(res.result));
      window.dispatchEvent(new CustomEvent('blazma:chats-changed'));
    }
  });

  return section(
    'chat',
    S.chat.title,
    S.chat.desc,
    item(S.chat.web, S.chat.webDesc, toggle(values.webSearch, (on) => save({ webSearch: on }))),
    item(S.chat.device, S.chat.deviceDesc, toggle(values.shareDeviceInfo, (on) => save({ shareDeviceInfo: on }))),
    item(S.chat.temp, S.chat.tempDesc, temp),
    item(S.chat.prompt, S.chat.promptDesc, null, el('div', { class: 'set-stack' }, prompt, el('div', { class: 'row' }, resetPrompt))),
    item(S.chat.tts, S.chat.ttsDesc, ttsSelect, ttsBox),
    item(S.chat.backup, S.chat.backupDesc, null, el('div', { class: 'row' }, backupBtn, restoreBtn)),
  );
}

function engineSection(state) {
  const ctx = select(
    [2048, 4096, 8192, 16384, 32768, 65536].map((n) => [n, S.engine.ctxOption(n)]),
    values.contextSize,
    (v) => save({ contextSize: Number(v) }, { engine: true }),
  );
  const gpu = select(
    [[-1, S.engine.gpuAuto], [99, S.engine.gpuAll], [0, S.engine.gpuNone], ...[8, 16, 24, 32, 40].map((n) => [n, S.engine.gpuLayersN(n)])],
    [-1, 0, 8, 16, 24, 32, 40].includes(values.gpuLayers) ? values.gpuLayers : 99,
    (v) => save({ gpuLayers: Number(v) }, { engine: true }),
  );
  const kv = select(
    [['q8_0', S.engine.kvQ8], ['f16', S.engine.kvF16], ['q4_0', S.engine.kvQ4]],
    values.kvCache,
    (v) => save({ kvCache: v }, { engine: true }),
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
    item(
      S.engine.idle,
      S.engine.idleDesc,
      select(
        [[0, S.engine.idleNever], ...[5, 15, 30, 60].map((n) => [n, S.engine.idleAfter(n)])],
        values.idleUnloadMin,
        (v) => save({ idleUnloadMin: Number(v) }, { engine: true }),
      ),
    ),
    item(S.engine.ctx, S.engine.ctxDesc, ctx),
    item(S.engine.dir, S.engine.dirDesc, null, el('div', { class: 'set-stack' }, dirText, el('div', { class: 'row' }, choose, openDir, resetDir))),
    advanced(
      item(
        S.engine.spec,
        S.engine.specDesc,
        select(
          [['off', S.engine.specOff], ['ngram', S.engine.specNgram], ['draft', S.engine.specDraft]],
          values.speculative,
          (v) => save({ speculative: v }, { engine: true }),
        ),
        null,
        S.engine.specHelp,
      ),
      item(S.engine.kv, S.engine.kvDesc, kv, null, S.engine.kvHelp),
      item(S.engine.gpu, S.engine.gpuDesc, gpu, null, S.engine.gpuHelp),
      item(S.engine.port, S.engine.portDesc, port),
      item(S.engine.version, engineInfo, null),
    ),
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
    [[500, S.live], ...[1000, 2000, 5000].map((ms) => [ms, S.seconds(ms / 1000)])],
    values.monitorIntervalMs,
    async (v) => {
      await save({ monitorIntervalMs: Number(v) });
      await refreshDeviceInfo();
      refreshOverlaySettings();
    },
  );
  const warn = el('input', { type: 'number', min: '30', max: '110', class: 'set-number', dir: 'ltr', value: String(values.gpuTempWarn ?? info.thresholds.gpuTempWarn) });
  const danger = el('input', { type: 'number', min: '30', max: '110', class: 'set-number', dir: 'ltr', value: String(values.gpuTempDanger ?? info.thresholds.gpuTempDanger) });
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
  // Off: the two limits appear under the switch.
  const temps = el('div', { class: 'row temps-row', hidden: auto }, el('label', null, S.warnShort, warn), el('label', null, S.dangerShort, danger));
  const autoToggle = toggle(auto, async (on) => {
    temps.hidden = on;
    if (on) {
      await save({ gpuTempWarn: null, gpuTempDanger: null });
      await refreshDeviceInfo();
    } else await saveTemps();
  });
  const lhmPort = el('input', { type: 'number', min: '1', max: '65535', class: 'set-number', dir: 'ltr', value: String(values.lhmPort) });
  lhmPort.addEventListener('change', () => {
    const v = Number(lhmPort.value);
    if (!Number.isInteger(v) || v < 1 || v > 65535) toast(S.invalid, 'error');
    else save({ lhmPort: v });
  });
  return section(
    'monitor',
    S.monitorTitle,
    S.monitorDesc,
    item(S.overlay, S.overlayDesc, toggle(values.overlayEnabled, async (on) => {
      await save({ overlayEnabled: on });
      refreshOverlaySettings();
    })),
    item(S.overlayCorner, null, select(
      ['top-left', 'top-right', 'bottom-left', 'bottom-right'].map((c) => [c, S.corners[c]]),
      values.overlayCorner,
      async (v) => {
        await save({ overlayCorner: v });
        refreshOverlaySettings();
      },
    )),
    item(S.interval, S.intervalDesc, interval),
    item(S.auto, S.autoNote(info.thresholds.gpuTempWarn, info.thresholds.gpuTempDanger), autoToggle, temps),
    advanced(
      item(S.lhm, S.lhmDesc, toggle(values.lhmEnabled, (on) => save({ lhmEnabled: on })), null, S.lhmHelp),
      item(S.lhmPort, S.lhmPortDesc, lhmPort),
    ),
  );
}

// "مكتبتي": folders of the user's documents, indexed so the chat can answer
// from them (main/knowledge.js).
let kbBusy = false;
function kbSection(kb) {
  const K = S.kb;
  const statusLine = el('div', { class: 'set-desc', id: 'kb-status' }, kb.files ? K.status(kb.files, kb.chunks, kb.updatedAt, kb.failed) : K.empty);
  const folders = kb.folders.length
    ? kb.folders.map((f) => {
        const rm = el('button', { type: 'button', class: 'btn ghost small' }, K.remove);
        rm.addEventListener('click', async () => {
          if (!(await confirmDialog({ text: K.confirmRemove, ok: K.remove, danger: true }))) return;
          await window.blazma.kbRemoveFolder(f);
          render();
        });
        return el('div', { class: 'kb-folder' }, el('span', { dir: 'ltr', class: 'kb-path' }, f), rm);
      })
    : [el('p', { class: 'muted small' }, K.noFolders)];
  const add = el('button', { type: 'button', class: 'btn' }, K.add);
  add.addEventListener('click', async () => {
    const res = await window.blazma.kbAddFolder();
    if (res.ok && res.result) {
      render();
      toast(K.added);
    }
  });
  const update = el('button', { type: 'button', class: 'btn primary', disabled: kbBusy || !kb.folders.length }, kbBusy ? K.updating : K.update);
  update.addEventListener('click', async () => {
    kbBusy = true;
    update.disabled = true;
    update.textContent = K.updating;
    const off = window.blazma.onKbProgress((p) => {
      const line = document.getElementById('kb-status');
      if (line) line.textContent = p.file ? K.progress(p.done, p.total, p.file) : K.finishing;
    });
    const res = await window.blazma.kbUpdate();
    off();
    kbBusy = false;
    if (!res.ok) toast((ui.errors[res.error.code] || ui.errors.unknown).title, 'error');
    else toast(K.updated);
    render();
  });
  return section(
    'kb',
    K.title,
    K.desc,
    item(K.folders, null, null, el('div', { class: 'kb-folders' }, ...folders)),
    item(K.index, statusLine, el('div', { class: 'row' }, add, update)),
    item(K.use, K.useDesc, toggle(values.kbInChat, (on) => save({ kbInChat: on }))),
    ...kbExtras(kb),
  );
}

// Other programs on this computer can use the running model through the
// same OpenAI-compatible server the chat uses (127.0.0.1 only).
function copyButton(text) {
  const b = el('button', { type: 'button', class: 'btn ghost small' }, ui.actions.copy);
  b.addEventListener('click', () =>
    navigator.clipboard.writeText(text).then(() => {
      b.textContent = ui.actions.copied;
      setTimeout(() => (b.textContent = ui.actions.copy), 1500);
    }),
  );
  return b;
}

function apiSection(conn) {
  const A = S.api;
  const on = values.apiEnabled;
  const items = [
    item(
      A.enable,
      A.enableDesc,
      toggle(on, async (checked) => {
        values = await window.blazma.apiSetEnabled(checked);
        toast(A.restarting);
        setTimeout(render, 300);
      }),
    ),
  ];
  if (on) {
    const port = (conn && conn.port) || values.port;
    const base = `http://127.0.0.1:${port}/v1`;
    const key = values.apiKey;
    const keyText = el('code', { dir: 'ltr', class: 'api-value' }, `${key.slice(0, 7)}${'•'.repeat(20)}`);
    const show = el('button', { type: 'button', class: 'btn ghost small' }, A.show);
    show.addEventListener('click', () => {
      keyText.textContent = keyText.textContent === key ? `${key.slice(0, 7)}${'•'.repeat(20)}` : key;
      show.textContent = keyText.textContent === key ? A.hide : A.show;
    });
    const renew = el('button', { type: 'button', class: 'btn ghost small' }, A.newKey);
    renew.addEventListener('click', async () => {
      if (!(await confirmDialog({ text: A.confirmNewKey, danger: true }))) return;
      values = await window.blazma.apiNewKey();
      toast(A.restarting);
      setTimeout(render, 300);
    });
    const example = [
      'from openai import OpenAI',
      `client = OpenAI(base_url="${base}", api_key="${key}")`,
      'reply = client.chat.completions.create(',
      '    model="local",',
      `    messages=[{"role": "user", "content": "${ui.settingsPage.api.hello}"}],`,
      ')',
      'print(reply.choices[0].message.content)',
    ].join('\n');
    items.push(
      item(A.url, A.urlDesc, el('div', { class: 'row' }, el('code', { dir: 'ltr', class: 'api-value' }, base), copyButton(base))),
      item(A.key, A.keyDesc, el('div', { class: 'row' }, keyText, show, copyButton(key), renew)),
      item(A.example, A.exampleDesc, null, el('pre', { class: 'api-example', dir: 'ltr' }, example)),
    );
  }
  return section('api', A.title, A.desc, ...items);
}

function generalSection() {
  const login = values.launchAtLogin;
  const openData = el('button', { type: 'button', class: 'btn ghost small' }, S.openFolder);
  openData.addEventListener('click', () => window.blazma.openFolder('data'));
  const theme = select(
    [['dark', S.general.themeDark], ['light', S.general.themeLight], ['system', S.general.themeSystem]],
    values.theme,
    (v) => save({ theme: v }),
  );
  // Interface language: saved, then the page reloads in it. The labels of
  // this choice are in both languages so either can be found.
  const language = select([['ar', 'العربية'], ['en', 'English']], values.language || 'ar', async (v) => {
    await save({ language: v });
    try {
      localStorage.setItem('blazma.lang', v);
    } catch {
      /* the saved setting is applied on the next start */
    }
    location.reload();
  });
  return section(
    'general',
    S.general.title,
    null,
    item(S.general.language, S.general.languageDesc, language),
    item(S.general.theme, S.general.themeDesc, theme),
    item(S.general.tour, S.general.tourDesc, (() => {
      const b = el('button', { type: 'button', class: 'btn small' }, S.general.tourStart);
      b.addEventListener('click', () => window.dispatchEvent(new Event('blazma:start-tour')));
      return b;
    })()),
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
  const e = ui.errors[err && err.code];
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
    const open = el('button', { type: 'button', class: a.result.canInstall ? 'btn ghost small' : 'btn primary small' }, S.updates.openDownload);
    open.addEventListener('click', () => window.blazma.openRelease(a.result.url));
    let install = null;
    if (a.result.canInstall) {
      install = el('button', { type: 'button', class: 'btn primary small', disabled: appDownloading }, appReady ? S.updates.appInstallNow : appDownloading ? S.updates.appDownloading(appPct) : S.updates.appDownload);
      install.addEventListener('click', async () => {
        if (appReady) {
          if (await confirmDialog({ text: S.updates.appConfirmRestart, ok: S.updates.appInstallNow })) window.blazma.installAppUpdate();
          return;
        }
        appDownloading = true;
        renderUpdates();
        const off = window.blazma.onUpdateProgress((pct) => {
          appPct = pct;
          renderUpdates();
        });
        const res = await window.blazma.downloadAppUpdate();
        off();
        appDownloading = false;
        if (res.ok && res.result.version) appReady = true;
        else if (!res.ok) toast(errorText(res.error), 'error');
        renderUpdates();
      });
    }
    rows.push(el('div', { class: 'upd-row new' }, el('span', null, S.updates.appLabel, ': ', S.updates.appNew(a.result.latest, a.result.current)), el('span', { class: 'row' }, install, a.result.url ? open : null)));
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
    crashItem(),
  );
}

// ---------- 0.2.0: memory, quick assistant, scheduled tasks ----------

const V = ui.v2;
const newId = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function memorySection() {
  const M = V.memory;
  const list = el('div', { class: 'set-stack mem-list' });
  const draw = () => {
    const items = values.memory || [];
    list.replaceChildren(
      ...(items.length
        ? items.map((m) => {
            const del = el('button', { type: 'button', class: 'icon-btn', title: M.remove, 'aria-label': M.remove }, '✕');
            del.addEventListener('click', async () => {
              await save({ memory: (values.memory || []).filter((x) => x.id !== m.id) });
              draw();
            });
            return el('div', { class: 'mem-item' }, el('span', { dir: 'auto' }, m.text), del);
          })
        : [el('div', { class: 'set-desc' }, M.none)]),
    );
  };
  const input = el('input', { type: 'text', class: 'input', maxlength: '500', placeholder: M.placeholder, dir: 'auto' });
  const add = el('button', { type: 'button', class: 'btn' }, M.add);
  const doAdd = async () => {
    const text = input.value.trim();
    if (!text) return;
    await save({ memory: [...(values.memory || []), { id: newId('m'), text }].slice(-200) });
    input.value = '';
    draw();
  };
  add.addEventListener('click', doAdd);
  input.addEventListener('keydown', (e) => e.key === 'Enter' && doAdd());
  draw();
  return section(
    'memory',
    M.title,
    M.desc,
    item(M.enable, M.enableDesc, toggle(values.memoryEnabled, (on) => save({ memoryEnabled: on }))),
    el('div', { class: 'set-item set-item-col' }, el('div', { class: 'row mem-add' }, input, add), list),
  );
}

// Electron accelerator from a key event ("Alt+Space", "Ctrl+Shift+K").
function accelerator(e) {
  const key = e.code === 'Space' ? 'Space' : /^Key[A-Z]$/.test(e.code) ? e.code.slice(3) : /^Digit\d$/.test(e.code) ? e.code.slice(5) : /^F([1-9]|1[0-2])$/.test(e.code) ? e.code : null;
  if (!key) return null;
  const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
  if (!mods.length && !/^F/.test(key)) return null;
  return [...mods, key].join('+');
}

function quickSection() {
  const Q = V.quick;
  // kind: text (the selection) or screen (a screen picture; Backspace turns it off).
  const keyBox = (kind) => {
    const name = kind === 'screen' ? 'quickScreenKey' : 'quickKey';
    const shown = () => values[name] || Q.screenOff;
    const box = el('input', { type: 'text', class: 'input key-box', readonly: true, value: shown(), dir: 'ltr' });
    box.addEventListener('focus', () => (box.value = Q.keyPress));
    box.addEventListener('blur', () => (box.value = shown()));
    box.addEventListener('keydown', async (e) => {
      e.preventDefault();
      const off = kind === 'screen' && (e.key === 'Backspace' || e.key === 'Delete');
      const acc = off ? '' : accelerator(e);
      if (!acc && !off) return;
      const res = await window.blazma.quickSetKey(acc, kind);
      if (!res.ok) return toast(Q.keyTaken, 'error');
      values = await window.blazma.getSettings();
      toast(S.saved);
      box.blur();
    });
    return box;
  };
  const box = keyBox('text');
  return section(
    'quick',
    Q.title,
    Q.desc,
    item(Q.enable, Q.enableDesc, toggle(values.quickEnabled, async (on) => {
      await window.blazma.quickSetEnabled(on);
      values = await window.blazma.getSettings();
      toast(S.saved);
    })),
    item(Q.key, Q.keyDesc, box),
    item(Q.screenKey, Q.screenKeyDesc, keyBox('screen')),
  );
}

function tasksSection() {
  const K = V.tasks;
  const list = el('div', { class: 'set-stack' });
  let editing = null;
  const saveTasks = (tasks) => save({ tasks });
  const form = (t) => {
    const name = el('input', { type: 'text', class: 'input', maxlength: '80', value: t.title, dir: 'auto' });
    const prompt = el('textarea', { class: 'input', rows: '3', maxlength: '4000', placeholder: K.promptPh, dir: 'auto' });
    prompt.value = t.prompt;
    const time = el('input', { type: 'time', class: 'input', value: t.time, dir: 'ltr' });
    const days = K.dayNames.map((d, i) => {
      const cb = el('input', { type: 'checkbox', checked: t.days.includes(i) });
      return { i, cb, node: el('label', { class: 'day-chip' }, cb, d) };
    });
    const web = el('input', { type: 'checkbox', checked: Boolean(t.web) });
    const ok = el('button', { type: 'button', class: 'btn primary' }, K.save);
    const cancel = el('button', { type: 'button', class: 'btn ghost' }, K.cancel);
    ok.addEventListener('click', async () => {
      const next = { ...t, title: name.value.trim() || K.title, prompt: prompt.value.trim(), time: time.value || '08:00', days: days.filter((d) => d.cb.checked).map((d) => d.i), web: web.checked };
      if (!next.prompt || !next.days.length) return;
      const all = (values.tasks || []).filter((x) => x.id !== t.id);
      await saveTasks([...all, next]);
      editing = null;
      draw();
    });
    cancel.addEventListener('click', () => ((editing = null), draw()));
    return el(
      'div',
      { class: 'task-form' },
      el('label', null, K.name, name),
      el('label', null, K.prompt, prompt),
      el('div', { class: 'row' }, el('label', null, K.time, time), el('label', { class: 'row web-chip' }, web, K.web)),
      el('div', null, el('div', { class: 'set-desc' }, K.days), el('div', { class: 'row days' }, ...days.map((d) => d.node))),
      el('div', { class: 'row' }, ok, cancel),
    );
  };
  const draw = () => {
    const tasks = values.tasks || [];
    const rows = tasks.map((t) => {
      if (editing === t.id) return form(t);
      const run = el('button', { type: 'button', class: 'btn small' }, K.runNow);
      run.addEventListener('click', async () => {
        run.disabled = true;
        run.textContent = K.running;
        const res = await window.blazma.tasksRun(t.id);
        run.disabled = false;
        run.textContent = K.runNow;
        toast(res.ok ? K.done : K.failed, res.ok ? 'ok' : 'error');
        values = await window.blazma.getSettings();
        draw();
      });
      const edit = el('button', { type: 'button', class: 'btn ghost small' }, K.edit);
      edit.addEventListener('click', () => ((editing = t.id), draw()));
      const del = el('button', { type: 'button', class: 'btn ghost small' }, K.remove);
      del.addEventListener('click', async () => {
        await saveTasks((values.tasks || []).filter((x) => x.id !== t.id));
        draw();
      });
      const days = t.days.length === 7 ? '' : ` · ${t.days.map((d) => K.dayNames[d]).join(ui.common.listSep)}`;
      return el(
        'div',
        { class: 'task-row' },
        el(
          'div',
          { class: 'task-text' },
          el('div', { class: 'row' }, toggle(t.enabled, async (on) => saveTasks((values.tasks || []).map((x) => (x.id === t.id ? { ...x, enabled: on } : x)))), el('strong', { dir: 'auto' }, t.title)),
          el('div', { class: 'set-desc' }, el('bdi', { dir: 'ltr' }, t.time), days, t.web ? ` · ${K.web}` : ''),
          el('div', { class: 'set-desc task-prompt', dir: 'auto' }, t.prompt),
          t.lastRun ? el('div', { class: 'set-desc' }, K.last(new Date(t.lastRun).toLocaleString())) : null,
        ),
        el('div', { class: 'row' }, run, edit, del),
      );
    });
    if (editing === 'new') rows.push(form({ id: newId('t'), title: '', prompt: '', time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], web: false, enabled: true }));
    list.replaceChildren(...(rows.length ? rows : [el('div', { class: 'set-desc' }, K.none)]));
  };
  const add = el('button', { type: 'button', class: 'btn' }, `+ ${K.add}`);
  add.addEventListener('click', () => ((editing = 'new'), draw()));
  const examples = el(
    'div',
    { class: 'row task-examples' },
    ...K.examples.map(([title, prompt, web]) => {
      const b = el('button', { type: 'button', class: 'chip' }, `+ ${title}`);
      b.addEventListener('click', async () => {
        await saveTasks([...(values.tasks || []), { id: newId('t'), title, prompt, time: '08:00', days: [0, 1, 2, 3, 4, 5, 6], web, enabled: true }]);
        draw();
      });
      return b;
    }),
  );
  draw();
  return section('tasks', K.title, K.desc, el('div', { class: 'set-item set-item-col' }, el('div', { class: 'row' }, add, examples), list));
}

// 0.2.0: web pages, the files read (and what was read), summaries.
function kbExtras(kb) {
  const K2 = V.kb2;
  const url = el('input', { type: 'url', class: 'input', placeholder: K2.webPh, dir: 'ltr' });
  const addUrl = el('button', { type: 'button', class: 'btn' }, K2.webAdd);
  addUrl.addEventListener('click', async () => {
    if (!/^https?:\/\//i.test(url.value.trim())) return;
    addUrl.disabled = true;
    addUrl.textContent = K2.webAdding;
    const res = await window.blazma.kbAddUrl(url.value.trim());
    addUrl.disabled = false;
    addUrl.textContent = K2.webAdd;
    if (!res.ok) return toast((ui.errors[res.error.code] || ui.errors.unknown).title, 'error');
    url.value = '';
    toast(K2.webAdded);
    render();
  });
  const list = el('div', { class: 'kb-files' }, el('p', { class: 'muted small' }, '…'));
  window.blazma.kbFiles().then((files) => {
    if (!files.length) return list.replaceChildren(el('p', { class: 'muted small' }, K2.noFiles));
    list.replaceChildren(
      ...files.map((f) => {
        const read = el('button', { type: 'button', class: 'btn ghost small', disabled: !f.chunks }, K2.read);
        read.addEventListener('click', async () => showFileText(f.name, await window.blazma.kbFileText(f.file)));
        const sum = el('button', { type: 'button', class: 'btn ghost small', disabled: !f.chunks }, K2.summarize);
        const sumBox = el('div', { class: 'kb-summary', dir: 'auto', hidden: !f.summary }, f.summary);
        sum.addEventListener('click', async () => {
          sum.disabled = true;
          sum.textContent = K2.summarizing;
          const res = await window.blazma.kbSummarize(f.file);
          sum.disabled = false;
          sum.textContent = K2.summarize;
          if (!res.ok) return toast((ui.errors[res.error.code] || ui.errors.unknown).title, 'error');
          sumBox.textContent = res.result;
          sumBox.hidden = false;
        });
        return el(
          'div',
          { class: 'kb-file' },
          el('div', { class: 'kb-file-row' }, el('span', { class: 'kb-file-name', dir: 'auto', title: f.file }, f.name), f.error ? el('span', { class: 'tag tag-warn' }, K2.failed) : null, el('span', { class: 'row' }, read, sum)),
          sumBox,
        );
      }),
    );
  });
  return [
    item(K2.web, K2.webDesc, null, el('div', { class: 'row kb-web' }, url, addUrl)),
    item(K2.files, `${K2.filesDesc} ${K2.types}`, null, list),
  ];
}

function showFileText(name, text) {
  const K2 = V.kb2;
  const close = el('button', { type: 'button', class: 'btn' }, K2.close);
  const overlay = el('div', { class: 'modal-overlay' });
  close.addEventListener('click', () => overlay.remove());
  overlay.addEventListener('mousedown', (e) => e.target === overlay && overlay.remove());
  overlay.append(el('div', { class: 'modal kb-text-modal', role: 'dialog' }, el('h2', null, K2.textTitle(name)), el('pre', { class: 'kb-text', dir: 'auto' }, text || ''), el('div', { class: 'row' }, close)));
  document.body.append(overlay);
}

function mcpSection() {
  const M = V.mcp;
  const list = el('div', { class: 'set-stack' });
  let editing = false;
  const states = new Map();
  const saveServers = (mcpServers) => save({ mcpServers });
  const form = () => {
    const name = el('input', { type: 'text', class: 'input', maxlength: '60', dir: 'auto' });
    const command = el('input', { type: 'text', class: 'input', placeholder: M.commandPh, dir: 'ltr' });
    const args = el('textarea', { class: 'input', rows: '4', placeholder: M.argsPh, dir: 'ltr' });
    const ok = el('button', { type: 'button', class: 'btn primary' }, M.save);
    const cancel = el('button', { type: 'button', class: 'btn ghost' }, M.cancel);
    ok.addEventListener('click', async () => {
      if (!name.value.trim() || !command.value.trim()) return;
      const entry = { id: newId('s'), name: name.value.trim(), command: command.value.trim(), args: args.value.split('\n').map((a) => a.trim()).filter(Boolean), enabled: true };
      await saveServers([...(values.mcpServers || []), entry]);
      editing = false;
      draw();
      test(entry.id);
    });
    cancel.addEventListener('click', () => ((editing = false), draw()));
    return el('div', { class: 'task-form' }, el('p', { class: 'set-desc' }, M.warn), el('label', null, M.name, name), el('label', null, M.command, command), el('label', null, M.args, args), el('div', { class: 'row' }, ok, cancel));
  };
  const test = async () => {
    for (const s of values.mcpServers || []) states.set(s.id, M.testing);
    draw();
    const res = await window.blazma.mcpEnsure();
    if (res.ok) for (const s of res.result) states.set(s.id, s.ready ? M.ok(s.tools.length) : M.failed(s.error || '?'));
    draw();
  };
  const draw = () => {
    const rows = (values.mcpServers || []).map((s) => {
      const run = el('button', { type: 'button', class: 'btn small' }, M.test);
      run.addEventListener('click', () => test(s.id));
      const del = el('button', { type: 'button', class: 'btn ghost small' }, M.remove);
      del.addEventListener('click', async () => {
        await saveServers((values.mcpServers || []).filter((x) => x.id !== s.id));
        states.delete(s.id);
        draw();
        window.blazma.mcpEnsure();
      });
      const st = states.get(s.id);
      return el(
        'div',
        { class: 'task-row' },
        el(
          'div',
          { class: 'task-text' },
          el('div', { class: 'row' }, toggle(s.enabled, async (on) => {
            await saveServers((values.mcpServers || []).map((x) => (x.id === s.id ? { ...x, enabled: on } : x)));
            test();
          }), el('strong', { dir: 'auto' }, s.name)),
          el('div', { class: 'set-desc task-prompt', dir: 'ltr' }, [s.command, ...s.args].join(' ')),
          st ? el('div', { class: `set-desc ${/^(يعمل|Running)/.test(st) ? 'ok-text' : ''}` }, st) : null,
        ),
        el('div', { class: 'row' }, run, del),
      );
    });
    if (editing) rows.push(form());
    list.replaceChildren(...(rows.length ? rows : [el('div', { class: 'set-desc' }, M.none)]));
  };
  const add = el('button', { type: 'button', class: 'btn' }, `+ ${M.add}`);
  add.addEventListener('click', () => ((editing = true), draw()));
  draw();
  if ((values.mcpServers || []).some((s) => s.enabled)) test();
  return section('mcp', M.title, M.desc, el('div', { class: 'set-item set-item-col' }, el('div', { class: 'row' }, add), list));
}

function crashItem() {
  const C = V.crash;
  const btn = el('button', { type: 'button', class: 'btn ghost' }, C.open);
  const note = el('span', { class: 'set-desc' });
  window.blazma.crashStatus().then((has) => {
    btn.hidden = !has;
    note.textContent = has ? '' : C.none;
  });
  btn.addEventListener('click', () => window.blazma.crashOpen());
  return item(C.title, C.desc, el('div', { class: 'row' }, btn, note));
}

// ---------- page ----------

const SECTIONS = ['general', 'chat', 'memory', 'quick', 'tasks', 'mcp', 'kb', 'engine', 'monitor', 'api', 'updates', 'about'];
let currentTab = (() => {
  try {
    return SECTIONS.includes(localStorage.getItem('blazma.settingsTab')) ? localStorage.getItem('blazma.settingsTab') : 'general';
  } catch {
    return 'general';
  }
})();

function showTab(id) {
  if (!SECTIONS.includes(id)) return;
  currentTab = id;
  try {
    localStorage.setItem('blazma.settingsTab', id);
  } catch {
    /* not kept */
  }
  for (const sec of document.querySelectorAll('.set-section')) sec.hidden = sec.dataset.section !== id;
  for (const b of document.querySelectorAll('.set-toc button')) {
    b.classList.toggle('active', b.dataset.target === id);
    if (b.dataset.target === id) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  const content = document.querySelector('.content');
  if (content) content.scrollTop = 0;
}

// Other pages open a tab directly (e.g. the library button in the chat).
window.addEventListener('blazma:settings-tab', (e) => showTab(e.detail));

async function render() {
  const [v, info, state, appInfo, conn, kb] = await Promise.all([window.blazma.getSettings(), window.blazma.monitorInfo(), window.blazma.getSetupState(), window.blazma.getAppInfo(), window.blazma.getConnection(), window.blazma.kbStatus()]);
  values = v;
  const toc = el(
    'nav',
    { class: 'set-toc', 'aria-label': S.tocLabel },
    ...SECTIONS.map((id) => {
      const b = el('button', { type: 'button', 'data-target': id }, el('span', { class: 'set-toc-icon', 'aria-hidden': 'true' }, S.tocIcons[id] || { memory: '🧠', quick: '⌨', tasks: '⏰', mcp: '🧩' }[id]), S.toc[id] || V[id].title);
      b.addEventListener('click', () => showTab(id));
      return b;
    }),
  );
  const body = el('div', { class: 'set-body' }, generalSection(), chatSection(), memorySection(), quickSection(), tasksSection(), mcpSection(), kbSection(kb), engineSection(state), monitorSection(info), apiSection(conn), updatesSection(), aboutSection(appInfo));
  $('settings-root').replaceChildren(el('div', { class: 'set-layout' }, toc, body));
  renderEngineBanner();
  renderUpdates();
  showTab(currentTab);
}

export function setSettingsVisible(v) {
  if (v) render();
}

