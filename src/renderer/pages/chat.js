// Chat page: setup/progress panel until the local server is ready, then a
// streaming chat against http://127.0.0.1:<port>/v1/chat/completions.

import { ui, errorText, formatBytes, formatDuration, LOCALE, DIR } from '../i18n/index.js';
import { el, detectDir } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { readSse } from '../lib/sse.js';
import { extractTextToolCalls, visibleText } from '../lib/toolcalls.js';
import { store } from '../lib/store.js';
import { speak, stopSpeaking, isSpeaking } from '../lib/speech.js';
import { startRecording } from '../lib/recorder.js';
import { isMedia, decodeMedia, pieces, stamp, MAX_MEDIA_BYTES, MAX_MEDIA_SECONDS } from '../lib/media.js';
import { translateUnits, defaultTarget, LANGS } from '../lib/translator.js';
import { learnFrom } from '../lib/learn.js';
import { BRAIN_TOOLS, AGENT_TOOLS, AGENT_NAMES, agentRules, runAgentTool } from '../lib/agenttools.js';
import { deepResearch } from '../lib/research.js';
import { loadPersonas, personaById, openPersonaMenu } from './personas.js';
import { confirmDialog, promptDialog, choiceDialog } from '../lib/dialog.js';
import { attachSlashMenu, parseCommand, withCommand, commandById } from '../lib/slash.js';
import { initPreview, runPreview, canRun, closePreview } from '../lib/preview.js';

// Today's date and time in Arabic (Gregorian and Umm al-Qura Hijri), with
// Western digits to match the rest of the app.
function dateContext(webOn) {
  const now = new Date();
  const fmt = (calendar, opts) => new Intl.DateTimeFormat(`${LOCALE === 'en' ? 'en' : 'ar-SA'}-u-ca-${calendar}-nu-latn`, opts).format(now);
  return ui.chat.dateContext(
    fmt('gregory', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    fmt('islamic-umalqura', { year: 'numeric', month: 'long', day: 'numeric' }),
    fmt('gregory', { hour: 'numeric', minute: '2-digit' }),
    webOn,
  );
}

const mdLabels = {
  copy: ui.actions.copy,
  copied: ui.actions.copied,
  code: ui.chat.code,
  saveCode: ui.chat.saveCode,
  savedCode: ui.chat.savedCode,
  save: (code, lang) => window.blazma.saveTextFile(code, lang),
  openInStudio: ui.studio.openInStudio,
  studio: (code, lang) => window.dispatchEvent(new CustomEvent('blazma:open-in-studio', { detail: { code, lang } })),
  runLabel: ui.v2.run,
  canRun,
  run: (code, lang) => runPreview(code, lang),
  diagram: (code) => diagramNode(code),
};
// While a reply is still being written, a half-written diagram is not drawn.
const mdLabelsLive = { ...mdLabels, diagram: null };

// Mermaid diagrams in replies (lib/markdown.js): drawn once per code in the
// sandboxed preview origin, and kept while the chat re-renders.
const diagramUrls = new Map();
const diagramHeights = new Map();
function diagramNode(code) {
  const frame = el('iframe', { class: 'md-diagram-frame', sandbox: 'allow-scripts', title: 'diagram' });
  frame.style.height = `${diagramHeights.get(code) || 120}px`;
  frame.dataset.code = code;
  const dark = document.documentElement.dataset.theme !== 'light';
  const key = `${dark}:${code}`;
  if (diagramUrls.has(key)) frame.src = diagramUrls.get(key);
  else
    window.blazma.previewDiagram(code, dark).then((res) => {
      if (!res.ok) return;
      diagramUrls.set(key, res.result.url);
      frame.src = res.result.url;
    });
  return frame;
}
window.addEventListener('message', (e) => {
  if (!e.data || !e.data.blazmaDiagram) return;
  for (const f of document.querySelectorAll('.md-diagram-frame')) {
    if (f.contentWindow !== e.source) continue;
    const h = Math.min(Math.max(Number(e.data.h) || 60, 40), 1400);
    diagramHeights.set(f.dataset.code, h);
    f.style.height = `${h}px`;
  }
});

const $ = (id) => document.getElementById(id);

let setupState = null;
let selectedModelId = null;
let messages = []; // { role, content, reasoning?, timings?, error?, stopped?, thinkStart?, thinkEnd? }
let abortController = null;
let speedSample = null; // for download speed: { t, done }
let visionEnabled = false; // the running model was started with its vision projector
let pendingImages = []; // data URLs attached to the message being written

const MAX_IMAGES = 4;
const MAX_FILES = 5;
// Rough characters per token for Arabic/English text, to keep attached files
// inside the model's context (the rest of the context is for the chat).
const CHARS_PER_TOKEN = 3;
const FILE_SHARE = 0.6;
let currentPersonaId = (() => {
  try {
    return localStorage.getItem('blazma.persona') || 'general';
  } catch {
    return 'general';
  }
})();
let pendingFiles = []; // { name, kind, text, chars, pages, truncated } or { name, reading: true }
const MAX_IMAGE_SIDE = 1536;
let speed = 0;
let currentChatId = null; // saved conversation shown now (null until the first message)
let editingIndex = null; // user message being edited

// ---------- setup panel ----------

function progressBar(done, total) {
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const bar = el('div', { class: 'progress' }, el('div', { class: 'progress-fill' }));
  bar.firstChild.style.width = `${pct.toFixed(1)}%`;
  return { bar, pct };
}

function trackSpeed(done) {
  const now = performance.now();
  if (!speedSample || done < speedSample.done) {
    speedSample = { t: now, done };
    return;
  }
  const dt = (now - speedSample.t) / 1000;
  if (dt >= 2) {
    const inst = (done - speedSample.done) / dt;
    speed = speed ? speed * 0.6 + inst * 0.4 : inst;
    speedSample = { t: now, done };
  }
}

function hardwareSummary(hw) {
  // The English card name is isolated so the Arabic line keeps its order.
  const gpu = hw.nvidia
    ? el('b', { dir: DIR }, el('bdi', { dir: 'ltr' }, hw.nvidia.name), ` · ${ui.units.gbShort((hw.nvidia.vramMB / 1024).toFixed(0))}`)
    : el('b', null, ui.setup.noNvidia);
  return el(
    'div',
    { class: 'hw-summary' },
    el('div', null, el('span', { class: 'muted' }, ui.setup.gpu), gpu),
    el('div', null, el('span', { class: 'muted' }, ui.setup.ram), el('b', null, ui.units.gbShort((hw.ramMB / 1024).toFixed(0)))),
  );
}

function modelChooser(state) {
  if (!selectedModelId || !state.models.some((m) => m.id === selectedModelId)) {
    selectedModelId = state.recommendedId;
  }
  const list = el('div', { class: 'model-list', role: 'radiogroup' });
  // The first screen shows the models we tested (and any already downloaded);
  // the full list is on the models page.
  const shown = state.models.filter((m) => m.featured || m.downloaded || m.id === selectedModelId);
  for (const m of shown) {
    const tags = [];
    if (m.id === state.recommendedId) tags.push(el('span', { class: 'tag tag-accent' }, ui.setup.recommended));
    if (m.downloaded) tags.push(el('span', { class: 'tag' }, ui.setup.downloaded));
    if (m.fit && m.fit !== 'ok') tags.push(el('span', { class: 'tag tag-warn' }, fitLabel(m, state.hardware)));
    const option = el(
      'button',
      {
        type: 'button',
        class: 'model-option',
        role: 'radio',
        'aria-checked': String(m.id === selectedModelId),
        onclick: () => {
          selectedModelId = m.id;
          renderSetup(setupState);
        },
      },
      el(
        'div',
        { class: 'model-option-head' },
        el('b', { dir: 'ltr' }, m.name),
        el('span', { class: 'muted' }, formatBytes(m.sizeBytes)),
        ...tags,
      ),
      el('div', { class: 'muted small' }, m.note),
    );
    list.append(option);
  }
  const hidden = state.models.length - shown.length;
  const chosen = state.models.find((m) => m.id === selectedModelId);
  const startBtn = el(
    'button',
    { type: 'button', class: 'btn primary big', onclick: () => window.blazma.startSetup(selectedModelId) },
    chosen && chosen.downloaded ? ui.setup.startDownloaded : ui.setup.start,
  );
  return [list, hidden > 0 ? el('p', { class: 'muted small' }, ui.setup.moreModels(hidden)) : null, startBtn];
}

// Why a model may be slow or not run on this computer (setup.fitLevel).
export function fitLabel(m, hardware) {
  if (m.fit === 'too-big') return ui.setup.tooBig;
  return hardware && hardware.nvidia ? ui.setup.usesRam : ui.setup.slowOnCpu;
}

function phaseView(state) {
  const p = state.progress || {};
  switch (state.phase) {
    case 'detecting':
      return [el('div', { class: 'spinner' }), el('p', null, ui.phase.detecting)];
    case 'choose':
      return [
        el('h2', null, ui.setup.title),
        el('p', { class: 'muted' }, ui.setup.intro),
        hardwareSummary(state.hardware),
        !state.hardware.nvidia && el('div', { class: 'notice' }, ui.setup.cpuNotice),
        ...modelChooser(state),
      ];
    case 'engine': {
      if (p.stage === 'download' && p.total) {
        const { bar, pct } = progressBar(p.done, p.total);
        return [
          el('h2', null, ui.phase.engineDownload),
          bar,
          el('p', { class: 'muted' }, `${pct.toFixed(0)}% · ${ui.units.ofSize(formatBytes(p.done), formatBytes(p.total))}`),
        ];
      }
      const text =
        p.stage === 'extract' ? ui.phase.engineExtract : p.stage === 'test' ? ui.phase.engineTest : ui.phase.engineRelease;
      return [el('div', { class: 'spinner' }), el('p', null, text)];
    }
    case 'model-resolve':
      return [el('div', { class: 'spinner' }), el('p', null, ui.phase.modelResolve)];
    case 'model-download':
    case 'waiting-network': {
      const done = p.done || 0;
      const total = p.total || 0;
      const waiting = state.phase === 'waiting-network';
      if (!waiting) trackSpeed(done);
      const { bar, pct } = progressBar(done, total);
      const model = state.models.find((m) => m.id === state.modelId);
      const parts = [`${pct.toFixed(1)}%`, ui.units.ofSize(formatBytes(done), formatBytes(total))];
      if (!waiting && speed > 0) {
        parts.push(ui.units.mbps((speed / 1024 ** 2).toFixed(1)));
        parts.push(ui.units.left(formatDuration((total - done) / speed)));
      }
      return [
        el('h2', null, waiting ? ui.phase.waitingNetwork : ui.phase.modelDownload, model ? ` (${model.name})` : ''),
        bar,
        el('p', { class: 'muted', dir: DIR }, parts.join(' · ')),
        waiting && el('div', { class: 'notice' }, ui.phase.waitingNetworkHint),
      ];
    }
    case 'loading':
      return [el('div', { class: 'spinner' }), el('p', null, ui.phase.loading), el('p', { class: 'muted' }, ui.phase.loadingHint)];
    case 'stopped':
      return [
        el('h2', null, ui.phase.stopped),
        el('p', { class: 'muted' }, ui.phase.stoppedHint),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: () => window.blazma.retrySetup() }, ui.actions.startServer),
          el('button', { type: 'button', class: 'btn', onclick: () => showChooser() }, ui.actions.chooseModel),
        ),
      ];
    case 'error': {
      const e = state.error || {};
      const text = errorText(e.code);
      return [
        el('div', { class: 'error-icon' }, '!'),
        el('h2', null, text.title),
        el('p', null, text.hint),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: () => window.blazma.retrySetup() }, ui.actions.retry),
          el('button', { type: 'button', class: 'btn', onclick: () => showChooser() }, ui.actions.chooseModel),
        ),
        e.detail &&
          el(
            'details',
            { class: 'tech' },
            el('summary', null, ui.actions.details),
            el('pre', { dir: 'ltr' }, `${e.code}\n${e.detail}`),
          ),
      ];
    }
    default:
      return [];
  }
}

function showChooser() {
  selectedModelId = setupState.modelId || setupState.recommendedId;
  renderSetup({ ...setupState, phase: 'choose' });
}

function renderSetup(state) {
  const panel = $('setup-panel');
  panel.replaceChildren(el('div', { class: 'setup-card' }, ...phaseView(state).filter(Boolean)));
}

// Quick model switch from the chat header (downloaded models only).
function openModelMenu() {
  closeModelMenu();
  if (!setupState) return;
  const pill = $('model-pill');
  const items = setupState.models.filter((m) => m.downloaded);
  const menu = el(
    'div',
    { class: 'model-menu model-switch', role: 'menu' },
    el('div', { class: 'model-menu-head' }, ui.chat.switchModel),
    ...items.map((m) => {
      const current = m.id === setupState.modelId;
      const row = el('button', { type: 'button', class: `model-menu-item${current ? ' current' : ''}`, role: 'menuitem' }, el('span', { dir: 'ltr' }, m.name), current ? el('span', { class: 'tag tag-ok' }, ui.chat.currentModel) : m.fits ? null : el('span', { class: 'tag tag-warn' }, fitLabel(m, setupState.hardware)));
      row.addEventListener('click', () => {
        closeModelMenu();
        if (!current) window.blazma.modelsUse(m.id);
      });
      return row;
    }),
    (() => {
      const more = el('button', { type: 'button', class: 'model-menu-item more' }, ui.chat.manageModels);
      more.addEventListener('click', () => {
        closeModelMenu();
        window.dispatchEvent(new CustomEvent('blazma:show-page', { detail: 'models' }));
      });
      return more;
    })(),
  );
  const r = pill.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', outsideModelMenu), 0);
}

function outsideModelMenu(e) {
  if (!e.target.closest('.model-menu') && !e.target.closest('#model-pill')) closeModelMenu();
}

function closeModelMenu() {
  const menu = document.querySelector('.model-switch');
  if (menu) menu.remove();
  document.removeEventListener('mousedown', outsideModelMenu);
}

function renderStatus(state) {
  const model = state.models.find((m) => m.id === state.modelId);
  $('model-pill').textContent = model ? `${model.name} ▾` : '';
  $('model-pill').hidden = !model;

  const pill = $('status-pill');
  const key =
    state.phase === 'ready'
      ? 'ready'
      : state.phase === 'loading'
        ? 'loading'
        : state.phase === 'stopped'
          ? 'stopped'
          : state.phase === 'error'
            ? 'error'
            : 'busy';
  pill.dataset.status = key;
  pill.lastChild.textContent = key === 'ready' && state.sleeping ? ui.status.sleeping : ui.status[key];
  pill.title = key === 'ready' && state.sleeping ? ui.status.sleepingHint : '';

  const engineNote = $('engine-note');
  const fb = state.engine && state.engine.fallbackFrom && state.engine.fallbackFrom.length;
  engineNote.hidden = !fb || state.phase !== 'ready';
  if (fb) engineNote.textContent = ui.setup.fallbackNotice(state.engine.variant);

  $('btn-stop-server').hidden = !['ready', 'loading', 'model-download'].includes(state.phase);
}

function onState(state) {
  const prevPhase = setupState && setupState.phase;
  const wasHeld = imageHold;
  setupState = state;
  visionEnabled = Boolean(state.vision);
  if (!visionEnabled && pendingImages.length) {
    pendingImages = [];
    renderPreview();
  }
  const ready = state.phase === 'ready';
  // While a picture is drawn the chat model steps aside (main/ipc.js) and is
  // loaded again after: the conversation stays on screen meanwhile.
  if (imageHold && (ready || ['error', 'waiting-network'].includes(state.phase))) imageHold = false;
  const showChat = ready || (imageHold && ['stopped', 'engine', 'model-resolve', 'loading'].includes(state.phase));
  $('setup-panel').hidden = showChat;
  $('chat-area').hidden = !showChat;
  renderStatus(state);
  if (!showChat) {
    if (state.phase !== 'model-download') speedSample = null;
    renderSetup(state);
    if (abortController) abortController.abort();
  } else if (ready && prevPhase !== 'ready' && !wasHeld) {
    renderMessages();
    $('chat-input').focus();
  }
}

// ---------- chat ----------

function messageNode(msg, index) {
  const isUser = msg.role === 'user';
  const body = el('div', { class: 'msg-body', dir: detectDir(msg.content || msg.reasoning || '') });

  if (!isUser && (msg.reasoning || (msg.streaming && !msg.content))) {
    const thinking = el('details', { class: 'thinking' });
    const done = Boolean(msg.content) || !msg.streaming;
    const label = done && msg.thinkEnd ? ui.chat.thought(Math.max(1, Math.round((msg.thinkEnd - msg.thinkStart) / 1000))) : ui.chat.thinking;
    thinking.append(el('summary', { class: done ? '' : 'pulse' }, label));
    if (msg.reasoning) thinking.append(el('div', { class: 'thinking-body', dir: detectDir(msg.reasoning) }, msg.reasoning));
    if (msg.openThinking) thinking.open = true;
    thinking.addEventListener('toggle', () => (msg.openThinking = thinking.open));
    body.append(thinking);
  }

  if (isUser && msg.images && msg.images.length) {
    body.append(el('div', { class: 'msg-images' }, ...msg.images.map((src) => el('img', { src, alt: '' }))));
  }
  // An image made by the image model, with a save button.
  if (!isUser && msg.images && msg.images.length) {
    body.append(
      el(
        'div',
        { class: 'gen-images' },
        ...msg.images.map((src) => {
          const saveBtn = el('button', { type: 'button', class: 'btn ghost small' }, ui.chat.saveImage);
          saveBtn.addEventListener('click', () => window.blazma.imagesSave(src));
          return el('figure', { class: 'gen-image' }, el('img', { src, alt: msg.imagePrompt || '' }), saveBtn);
        }),
      ),
    );
  }
  if (!isUser && msg.generatingImage) body.append(el('p', { class: 'muted pulse' }, ui.chat.imageWorking), el('p', { class: 'muted small image-elapsed', dir: DIR }));
  if (isUser && msg.files && msg.files.length) {
    body.append(el('div', { class: 'msg-files' }, ...msg.files.map((f) => fileChip(f))));
  }
  if (isUser && editingIndex === index) {
    const box = el('textarea', { dir: 'auto' });
    box.value = msg.content;
    body.append(
      el(
        'div',
        { class: 'edit-box' },
        box,
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: () => saveEdit(index, box.value) }, ui.chat.saveEdit),
          el('button', { type: 'button', class: 'btn ghost', onclick: () => ((editingIndex = null), renderMessages()) }, ui.chat.cancel),
        ),
      ),
    );
    setTimeout(() => box.focus(), 0);
  } else if (isUser && (msg.content || msg.command)) {
    const cmd = msg.command && commandById(msg.command);
    if (cmd) body.append(el('span', { class: 'slash-chip', title: cmd.desc }, `/${cmd.name}`));
    if (msg.content) body.append(el('p', { dir: detectDir(msg.content), class: 'plain' }, msg.content));
  }
  if (!isUser && msg.steps && msg.steps.length) {
    body.append(
      el(
        'div',
        { class: 'tool-steps' },
        ...msg.steps.map((st) =>
          el(
            'div',
            { class: `tool-step${st.failed ? ' failed' : ''}`, dir: DIR },
            el('span', { class: 'tool-icon', 'aria-hidden': 'true' }, st.kind === 'search' ? '⌕' : st.kind === 'tool' ? '⚙' : '↗'),
            el('bdi', null, st.kind === 'search' ? ui.chat.stepSearch(st.label) : st.kind === 'tool' ? st.label : ui.chat.stepOpen(st.label)),
            st.failed ? el('span', { class: 'muted' }, ` · ${ui.chat.stepFailed}`) : null,
          ),
        ),
      ),
    );
  }
  if (!isUser && msg.streaming && msg.research) body.append(el('div', { class: 'research-status', dir: DIR }, el('span', { class: 'spinner', 'aria-hidden': 'true' }), msg.research));
  if (isUser && msg.research) body.prepend(el('span', { class: 'slash-chip' }, ui.v2.research.chip));
  if (!isUser && msg.compare) {
    // Side by side: this reply and the same question answered by another model.
    const close = el('button', { type: 'button', class: 'icon-btn', title: ui.v2.compare.close, 'aria-label': ui.v2.compare.close }, '✕');
    close.addEventListener('click', () => {
      delete msg.compare;
      renderMessages();
      persist();
    });
    const mine = compareColumn(msg, { model: msg.model, content: msg.content, streaming: msg.streaming }, index);
    mine.querySelector('.cmp-head').append(close);
    body.append(el('div', { class: 'compare-grid' }, mine, compareColumn(msg, msg.compare, index)));
  } else if (!isUser && msg.content) body.append(renderMarkdown(msg.streaming ? visibleText(msg.content) : msg.content, msg.streaming ? mdLabelsLive : mdLabels));
  if (!isUser && !msg.streaming && msg.sources && msg.sources.length) {
    const seen = new Set();
    const unique = msg.sources.filter((src) => !seen.has(src.url) && seen.add(src.url)).slice(0, msg.researchSources ? 15 : 6);
    body.append(
      el(
        'div',
        { class: 'sources' },
        el('span', { class: 'muted small' }, `${ui.chat.sources}:`),
        ...unique.map((src) =>
          el(
            'button',
            src.file
              ? { type: 'button', class: 'source kb-source', title: src.file, dir: 'auto', onclick: () => window.blazma.kbReveal(src.file) }
              : { type: 'button', class: 'source', title: src.url, dir: 'auto', onclick: () => window.blazma.openExternal(src.url) },
            src.title || new URL(src.url).hostname,
          ),
        ),
      ),
    );
  }

  if (!isUser && !msg.streaming && msg.changed && msg.journal) {
    const A = ui.v2.agent;
    body.append(
      el(
        'div',
        { class: 'agent-undo', dir: DIR },
        el('span', null, msg.undone ? msg.undone : A.changed(msg.changed)),
        msg.undone ? null : el('button', { type: 'button', class: 'btn ghost small', onclick: () => undoChanges(msg) }, `↶ ${A.undo}`),
      ),
    );
  }
  if (!isUser && !msg.streaming && msg.learned && msg.learned.length) {
    const L = ui.v2.memory;
    body.append(
      el(
        'div',
        { class: 'learned', dir: DIR },
        el('span', { 'aria-hidden': 'true' }, '🧠'),
        el('span', null, L.learned, ' ', ...msg.learned.map((x, k) => el('bdi', { class: 'learned-fact' }, (k ? '، ' : '') + x.text))),
        el('button', { type: 'button', class: 'link-btn', onclick: () => forgetLearned(msg) }, L.forget),
      ),
    );
  }
  if (msg.stopped) body.append(el('p', { class: 'muted small' }, ui.chat.stopped));
  if (msg.error) body.append(el('div', { class: 'msg-error' }, msg.error));

  const footer = el('div', { class: 'msg-footer' });
  if (!msg.streaming && !msg.generatingImage) {
    const copy = el('button', { type: 'button', class: 'icon-btn' }, ui.actions.copy);
    copy.addEventListener('click', () =>
      navigator.clipboard.writeText(msg.content).then(() => {
        copy.textContent = ui.actions.copied;
        setTimeout(() => (copy.textContent = ui.actions.copy), 1500);
      }),
    );
    if (msg.content) footer.append(copy);
    if (!isUser && msg.content) footer.append(listenButton(msg));
    if (!abortController && !imageBusy) {
      if (isUser) footer.append(el('button', { type: 'button', class: 'icon-btn', onclick: () => startEdit(index) }, ui.chat.edit));
      else if (index === messages.length - 1 && !msg.imagePrompt) {
        footer.append(el('button', { type: 'button', class: 'icon-btn', onclick: regenerate }, ui.chat.regenerate));
        if (msg.content && !msg.compare) footer.append(el('button', { type: 'button', class: 'icon-btn', onclick: (e) => openCompareMenu(e.currentTarget) }, ui.v2.compare.btn));
      }
    }
    if (msg.alts && msg.alts.length > 1) footer.append(branchNav(msg, index));
    if (msg.timings && msg.timings.predicted_per_second) {
      footer.append(el('span', { class: 'stats', dir: DIR }, ui.chat.speed(msg.timings.predicted_per_second, msg.timings.predicted_n)));
    }
  }

  return el('div', { class: `msg ${isUser ? 'msg-user' : 'msg-ai'}`, 'data-index': index }, body, footer);
}

// ---------- compare with another model (0.2.0) ----------

// The name of the model that is loaded now (for the comparison labels).
function currentModelName() {
  const m = setupState && setupState.models && setupState.models.find((x) => x.id === setupState.modelId);
  return m ? m.name : undefined;
}

function closeCompareMenu() {
  document.querySelectorAll('.compare-menu').forEach((m) => m.remove());
  document.removeEventListener('mousedown', outsideCompareMenu);
}
function outsideCompareMenu(e) {
  if (!e.target.closest('.compare-menu')) closeCompareMenu();
}

function openCompareMenu(anchor) {
  closeCompareMenu();
  const C = ui.v2.compare;
  const others = setupState ? setupState.models.filter((m) => m.downloaded && m.id !== setupState.modelId) : [];
  const menu = el(
    'div',
    { class: 'model-menu compare-menu', role: 'menu' },
    el('div', { class: 'model-menu-head' }, others.length ? C.pick : C.none),
    ...others.map((m) => {
      const row = el('button', { type: 'button', class: 'model-menu-item', role: 'menuitem' }, el('span', { dir: 'ltr' }, m.name), m.fits ? null : el('span', { class: 'tag tag-warn' }, fitLabel(m, setupState.hardware)));
      row.addEventListener('click', () => {
        closeCompareMenu();
        compareWith(m);
      });
      return row;
    }),
  );
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${Math.max(8, r.top - 8 - 44 * (others.length + 1))}px`;
  menu.style.left = `${r.left}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', outsideCompareMenu), 0);
}

function waitReady(modelId) {
  return new Promise((resolve) => {
    const check = (s) => {
      if (s && s.modelId === modelId && s.phase === 'ready') {
        off();
        resolve(true);
      } else if (s && s.phase === 'error') {
        off();
        resolve(false);
      }
    };
    const off = window.blazma.onSetupState(check);
    window.blazma.getSetupState().then(check);
  });
}

async function compareWith(model) {
  const target = messages[messages.length - 1];
  if (!target || target.role !== 'assistant' || abortController) return;
  const C = ui.v2.compare;
  const cmp = { role: 'assistant', model: model.name, content: '', reasoning: '', streaming: true, steps: [], sources: [], status: C.switching(model.name) };
  target.compare = cmp;
  if (!target.model) target.model = currentModelName();
  // While the other model loads, the chat hides and onState would abort a
  // running reply, so the stop controller is made only once it is ready;
  // "sending" blocks new messages meanwhile.
  sending = true;
  let signal = null;
  setBusy(true);
  renderLast();
  try {
    if (!(await (window.blazma.modelsUse(model.id), waitReady(model.id)))) throw new Error('not ready');
    abortController = new AbortController();
    signal = abortController.signal;
    cmp.status = C.writing(model.name);
    renderLast();
    const conn = await window.blazma.getConnection();
    // No "thinking" here: both answers are compared as answers, and a small
    // model can spend its whole reply thinking.
    const chatSettings = { ...(await window.blazma.getChatSettings()), thinking: false };
    const persona = personaById(currentPersonaId);
    let system = `${persona.prompt || chatSettings.systemPrompt}\n\n${dateContext(false)}`;
    const memory = chatSettings.memoryEnabled ? chatSettings.memory || [] : [];
    if (memory.length) system += `\n\n${ui.v2.memory.context(memory.map((m) => `- ${m.text}`).join('\n'))}`;
    cmp.thinkStart = Date.now();
    await streamReply({ reply: cmp, system, conn, chatSettings, webOn: false, signal });
    if (!cmp.content.trim() && !cmp.error) cmp.error = C.failed;
  } catch (err) {
    if (err.name === 'AbortError') cmp.stopped = true;
    else cmp.error = C.failed;
  } finally {
    cmp.streaming = false;
    delete cmp.status;
    abortController = null;
    sending = false;
    setBusy(false);
    renderMessages();
    persist();
  }
}

function compareColumn(msg, cmpMsg, index) {
  const C = ui.v2.compare;
  const head = el('div', { class: 'cmp-head' }, el('span', { class: 'pill', dir: 'ltr' }, cmpMsg.model || '?'));
  const col = el('div', { class: 'cmp-col' }, head);
  if (cmpMsg.status) col.append(el('p', { class: 'muted pulse' }, cmpMsg.status));
  if (cmpMsg.content) col.append(renderMarkdown(cmpMsg.streaming ? visibleText(cmpMsg.content) : cmpMsg.content, mdLabels));
  if (cmpMsg.error) col.append(el('div', { class: 'msg-error' }, cmpMsg.error));
  if (cmpMsg.stopped) col.append(el('p', { class: 'muted small' }, ui.chat.stopped));
  if (cmpMsg === msg.compare && !cmpMsg.streaming && cmpMsg.content) {
    const keep = el('button', { type: 'button', class: 'btn ghost small' }, C.useThis);
    keep.addEventListener('click', () => {
      const old = { content: msg.content, model: msg.model };
      msg.content = cmpMsg.content;
      msg.reasoning = cmpMsg.reasoning;
      msg.model = cmpMsg.model;
      msg.compare = { ...cmpMsg, content: old.content, model: old.model, reasoning: '' };
      renderMessages();
      persist();
    });
    head.append(keep);
  }
  return col;
}

// Downloads Blazma's Arabic voice after the user agrees. True when it is ready.
async function offerBlazmaVoice() {
  const plan = await window.blazma.ttsPlan();
  const mb = plan.ok ? Math.round(plan.result.bytes / 1e6) : 85;
  if (!(await confirmDialog({ title: ui.chat.ttsOfferTitle, text: ui.chat.ttsOffer(mb), ok: ui.chat.ttsOfferOk, cancel: ui.chat.cancel }))) return false;
  const off = window.blazma.onTtsProgress((p) => {
    const box = $('attach-preview');
    box.hidden = false;
    box.replaceChildren(el('span', { class: 'muted small attach-note' }, ui.chat.ttsDownloading(p.total ? Math.floor((p.done / p.total) * 100) : 0)));
  });
  const res = await window.blazma.ttsInstall();
  off();
  renderPreview();
  if (!res.ok) showComposerNote(ui.chat.ttsInstallFailed, 8000);
  return res.ok;
}

// "استمع": reads the reply aloud (speech.js); a second click stops it.
function listenButton(msg) {
  const b = el('button', { type: 'button', class: 'icon-btn' }, ui.chat.listen);
  b.addEventListener('speech-end', () => (b.textContent = ui.chat.listen));
  b.addEventListener('speech-error', (e) => {
    b.textContent = ui.chat.listen;
    showComposerNote(ui.chat.noVoice[e.detail] || ui.chat.noVoice['blazma-failed'], 9000);
  });
  const start = async () => {
    const res = await speak(msg.content, b);
    if (res.ok) {
      b.textContent = isSpeaking(b) ? ui.chat.stopListen : ui.chat.listen;
      return;
    }
    b.textContent = ui.chat.listen;
    if (res.reason === 'offer-blazma') {
      if (await offerBlazmaVoice()) start();
      return;
    }
    showComposerNote(ui.chat.noVoice[res.reason], 9000);
  };
  b.addEventListener('click', start);
  return b;
}

// Welcome screen with starting suggestions; a click puts the text in the
// input so it can be edited before sending.
function welcomeView() {
  const cards = ui.chat.suggestions.map((sg) => {
    const card = el('button', { type: 'button', class: 'suggest-card' }, el('span', { class: 'suggest-icon', 'aria-hidden': 'true' }, sg.icon), el('b', null, sg.title), el('span', { class: 'muted small' }, sg.text));
    card.addEventListener('click', () => {
      const input = $('chat-input');
      input.value = sg.text;
      autoGrow(input);
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    });
    return card;
  });
  return el(
    'div',
    { class: 'chat-empty' },
    el('img', { class: 'chat-empty-mark', src: 'logo.svg', alt: '', 'aria-hidden': 'true' }),
    el('h2', null, ui.chat.emptyTitle),
    el('p', { class: 'muted' }, ui.chat.emptyHint),
    el('div', { class: 'suggest-grid' }, ...cards),
    el('p', { class: 'faint small' }, ui.chat.keysHint),
  );
}

function renderMessages() {
  const log = $('chat-log');
  if (!messages.length) {
    log.replaceChildren(welcomeView());
    return;
  }
  log.replaceChildren(...messages.map(messageNode));
  log.scrollTop = log.scrollHeight;
}

let renderPending = false;
// Appends any messages not yet on screen and re-renders the last one (the
// one being streamed). Batched to one DOM update per animation frame.
function renderLast() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    const log = $('chat-log');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    const last = messages.length - 1;
    for (let i = 0; i <= last; i += 1) {
      const old = log.querySelector(`.msg[data-index="${i}"]`);
      if (old && i < last) continue;
      const node = messageNode(messages[i], i);
      if (old) old.replaceWith(node);
      else log.append(node);
    }
    if (nearBottom) log.scrollTop = log.scrollHeight;
  });
}

function setBusy(busy) {
  $('btn-send').hidden = busy;
  $('btn-stop-gen').hidden = !busy;
  $('btn-new-chat').disabled = busy;
  if (!busy) renderMessages(); // brings back the edit / regenerate buttons
}

// Downscales to at most MAX_IMAGE_SIDE and re-encodes as JPEG, which keeps
// requests small; the model resizes to its own input size anyway.
async function prepareImage(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff'; // transparent PNGs would otherwise turn black
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.9);
}

function fileChip(f, onRemove) {
  const job = translating.get(f);
  const busy = f.reading || Boolean(job);
  const meta = job ? job.note : f.reading ? f.note || ui.chat.fileReading : [f.pages ? ui.chat.filePages(f.pages) : null, ui.chat.fileChars(f.chars)].filter(Boolean).join(' · ');
  const L = ui.v2.translateFile;
  const canTranslate = onRemove && !busy && sourceFiles.has(f);
  return el(
    'div',
    { class: `file-chip${busy ? ' reading' : ''}`, title: f.name },
    el('span', { class: 'file-chip-icon', 'aria-hidden': 'true' }, f.kind === 'pdf' ? 'PDF' : f.kind === 'docx' ? 'DOC' : f.kind === 'transcript' ? '🎙' : 'TXT'),
    el('span', { class: 'file-chip-text' }, el('bdi', { class: 'file-chip-name' }, f.name), el('span', { class: 'file-chip-meta' }, meta)),
    canTranslate ? el('button', { type: 'button', class: 'file-chip-tr', title: L.button, 'aria-label': L.button, onclick: () => translateWhole(f) }, L.short) : null,
    job ? el('button', { type: 'button', class: 'file-chip-x', title: L.stop, 'aria-label': L.stop, onclick: () => job.controller.abort() }, '■') : null,
    onRemove && !job ? el('button', { type: 'button', class: 'file-chip-x', title: ui.chat.removeFile, 'aria-label': ui.chat.removeFile, onclick: onRemove }, '×') : null,
  );
}

// "ترجم الملف": the attached Word/PDF file, translated whole into a new file.
const sourceFiles = new WeakMap(); // attached file -> { name, bytes } (never saved in the chat)
const translating = new Map(); // attached file -> { note, controller }

async function translateWhole(f) {
  const L = ui.v2.translateFile;
  const src = sourceFiles.get(f);
  if (!src || translating.size) return;
  const job = { note: L.reading, controller: new AbortController() };
  translating.set(f, job);
  renderPreview();
  const setNote = (text) => {
    job.note = text;
    renderPreview();
  };
  try {
    const parsed = await window.blazma.translateParse(src.name, src.bytes);
    if (!parsed.ok) throw Object.assign(new Error('parse'), { note: ui.chat.fileErrors[parsed.error.code] ? ui.chat.fileErrors[parsed.error.code](src.name) : L.failed });
    const { id, units, kind } = parsed.result;
    translating.delete(f);
    renderPreview();
    const target = await choiceDialog({
      title: L.title,
      text: kind === 'docx' ? L.docxNote(units.length) : L.pdfNote(units.length),
      choices: LANGS.map(([value, label]) => ({ value, label })),
      value: defaultTarget(units),
      ok: L.start,
    });
    if (!target) return;
    translating.set(f, job);
    const lang = LANGS.find((x) => x[0] === target);
    setNote(L.progress(0));
    const list = await translateUnits(units, lang[2], { signal: job.controller.signal, onProgress: (d, t) => setNote(L.progress(Math.floor((d / t) * 100))) });
    setNote(L.saving);
    const res = await window.blazma.translateBuild(id, list, target, lang[1]);
    translating.delete(f);
    renderPreview();
    if (!res.ok) return showComposerNote(L.failed, 6000);
    if (res.result.saved) {
      showComposerNote(L.saved, 6000);
      window.blazma.translateReveal(res.result.path);
    }
  } catch (err) {
    translating.delete(f);
    renderPreview();
    if (err.name === 'AbortError') return showComposerNote(L.stopped, 4000);
    showComposerNote(err.code === 'not-ready' ? ui.v2.quick.notReady : err.note || L.failed, 6000);
  }
}

// Images go to the model as pictures (vision models); other files are turned
// into text in the main process (documents.js) and sent with the message.
async function addAttachments(files) {
  const media = files.filter((f) => isMedia(f));
  files = files.filter((f) => !isMedia(f));
  const images = files.filter((f) => f.type.startsWith('image/'));
  const docs = files.filter((f) => !f.type.startsWith('image/'));
  for (const file of media) await addMedia(file);
  if (images.length) {
    if (visionEnabled) await addImages(images);
    else showComposerNote(ui.chat.noVision);
  }
  for (const file of docs) {
    if (pendingFiles.length >= MAX_FILES) {
      showComposerNote(ui.chat.maxFiles);
      break;
    }
    const slot = { name: file.name, reading: true };
    pendingFiles.push(slot);
    renderPreview();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const res = await window.blazma.extractFile(file.name, bytes);
    const i = pendingFiles.indexOf(slot);
    if (i < 0) continue; // removed while reading
    if (res.ok) {
      pendingFiles[i] = res.result;
      if (/\.(pdf|docx)$/i.test(file.name)) sourceFiles.set(res.result, { name: file.name, bytes });
      renderPreview();
    } else {
      pendingFiles.splice(i, 1);
      renderPreview();
      showComposerNote(ui.chat.fileErrors[res.error.code] ? ui.chat.fileErrors[res.error.code](file.name) : ui.chat.fileErrors['file-unreadable'](file.name), 6000);
    }
  }
}

// Audio or video: whisper.cpp writes what is said, with times, and the text
// is attached like a file (its default question is a summary).
async function addMedia(file) {
  const T = ui.v2.transcribe;
  if (pendingFiles.length >= MAX_FILES) return showComposerNote(ui.chat.maxFiles);
  if (file.size > MAX_MEDIA_BYTES) return showComposerNote(T.tooBig(file.name), 6000);
  const st = await window.blazma.voiceStatus();
  if (!st.program || !st.model) {
    if (!(await confirmDialog({ text: ui.chat.micInstall(st.modelKind), ok: ui.chat.download }))) return;
    const off = window.blazma.onVoiceProgress((p) => setSlotNote(ui.chat.micDownloading(p.stage, p.total ? Math.floor((p.done / p.total) * 100) : 0)));
    const res = await window.blazma.voiceInstall();
    off();
    if (!res.ok) return showComposerNote((ui.errors[res.error.code] || ui.errors.unknown).title, 6000);
  }
  const slot = { name: file.name, kind: 'transcript', reading: true, note: T.decoding };
  pendingFiles.push(slot);
  renderPreview();
  function setSlotNote(text) {
    slot.note = text;
    renderPreview();
  }
  try {
    const { pcm, seconds } = await decodeMedia(file);
    if (seconds > MAX_MEDIA_SECONDS) throw Object.assign(new Error('long'), { note: T.tooLong(file.name) });
    const parts = pieces(pcm);
    const lines = [];
    for (let k = 0; k < parts.length; k++) {
      if (pendingFiles.indexOf(slot) < 0) return; // removed while working
      setSlotNote(T.progress(Math.floor((parts[k].start / seconds) * 100), formatDuration(seconds)));
      const res = await window.blazma.voiceSegments(parts[k].wav);
      if (!res.ok) throw Object.assign(new Error(res.error.code), { note: (ui.errors[res.error.code] || ui.errors.unknown).title });
      for (const seg of res.result) lines.push(`[${stamp(parts[k].start + seg.start)}] ${seg.text}`);
    }
    const i = pendingFiles.indexOf(slot);
    if (i < 0) return;
    if (!lines.length) {
      pendingFiles.splice(i, 1);
      renderPreview();
      return showComposerNote(T.nothing(file.name), 6000);
    }
    const text = `${T.header(file.name, stamp(seconds))}\n\n${lines.join('\n')}`;
    pendingFiles[i] = { name: T.fileName(file.name), kind: 'transcript', text, chars: text.length, truncated: false, pages: null };
    renderPreview();
  } catch (err) {
    const i = pendingFiles.indexOf(slot);
    if (i >= 0) pendingFiles.splice(i, 1);
    renderPreview();
    showComposerNote(err.note || T.failed(file.name), 6000);
  }
}

async function addImages(files) {
  if (!visionEnabled) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (pendingImages.length >= MAX_IMAGES) {
      showComposerNote(ui.chat.maxImages);
      break;
    }
    try {
      pendingImages.push(await prepareImage(file));
    } catch {
      showComposerNote(ui.chat.imageFailed);
    }
  }
  renderPreview();
}

function showComposerNote(text, ms = 3500) {
  const box = $('attach-preview');
  box.hidden = false;
  box.append(el('span', { class: 'muted small attach-note' }, text));
  setTimeout(renderPreview, ms);
}

function renderPreview() {
  const box = $('attach-preview');
  box.hidden = pendingImages.length === 0 && pendingFiles.length === 0;
  box.replaceChildren(
    ...pendingFiles.map((f) =>
      fileChip(f, () => {
        pendingFiles.splice(pendingFiles.indexOf(f), 1);
        renderPreview();
      }),
    ),
    ...pendingImages.map((src, i) =>
      el(
        'div',
        { class: 'thumb' },
        el('img', { src, alt: '' }),
        el(
          'button',
          {
            type: 'button',
            class: 'thumb-x',
            title: ui.chat.removeImage,
            'aria-label': ui.chat.removeImage,
            onclick: () => {
              pendingImages.splice(i, 1);
              renderPreview();
            },
          },
          '×',
        ),
      ),
    ),
  );
}

// Attached files go before the question, each inside <file> tags, cut to
// fit the share of the context given to files.
function withFiles(m, fileBudget) {
  const content = m.command ? withCommand(m.command, m.content || '') : m.content;
  if (!m.files || !m.files.length) return content;
  const per = Math.floor(fileBudget / m.files.length);
  const blocks = m.files.map((f) => {
    const cut = f.text.length > per;
    return `<file name="${f.name.replace(/"/g, "'")}">\n${cut ? f.text.slice(0, per) : f.text}${cut ? `\n${ui.chat.fileCutMarker}` : ''}\n</file>`;
  });
  return `${blocks.join('\n\n')}\n\n${content || ui.chat.summarizeFile}`;
}

// OpenAI-style content: plain text, or text plus image_url parts.
// Images go to the model only from the user's own messages, and only when
// the running model can see images. A drawn picture (an assistant message)
// or a photo sent earlier to a model with vision would make a model without
// vision reject every later request in the conversation.
function apiContent(m, fileBudget = Infinity) {
  const text = withFiles(m, fileBudget);
  const images = m.role === 'user' && visionEnabled ? m.images || [] : [];
  if (!images.length) {
    if (m.role === 'assistant' && m.imagePrompt && m.images && m.images.length) return `${text}\n[${ui.chat.imageInHistory}: ${m.imagePrompt}]`.trim();
    if (m.images && m.images.length && !text) return ui.chat.imageNotSeen;
    return text;
  }
  return [{ type: 'text', text: text || ui.chat.describeImage }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))];
}

// Tools the model may call when web search is on. Descriptions are for the
// model, not shown to the user.
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the internet. Use it for anything recent or changing (news, prices, weather, sports, releases), for facts you are not sure about, or when the user asks you to search. Returns titles, links and short snippets.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'The search query, in the language most likely to find good results.' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a web page (for example a search result) and read its text when the snippets are not enough.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'Full http(s) address of the page.' } },
        required: ['url'],
      },
    },
  },
];
const MAX_TOOL_ROUNDS = 3;

// MCP tools (Settings > MCP tools): offered next to the web tools; each use is
// confirmed by the user once per chat and tool.
let mcpByName = new Map();
let mcpAllowed = new Set();
// "وضع الوكيل" and "عقل جهازك" for the reply being written (lib/agenttools.js).
let agentOn = false;
let brainOn = false;
const AGENT_ROUNDS = 10;

// Runs one tool call and returns the text given back to the model.
async function runTool(call, reply) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {}
  if (AGENT_NAMES.has(call.function.name) && (agentOn || brainOn)) return runAgentTool(call.function.name, args, reply, renderLast);
  const mcpTool = mcpByName.get(call.function.name);
  if (mcpTool) {
    const M = ui.v2.mcp;
    const key = `${mcpTool.server}/${mcpTool.tool}`;
    const step = { kind: 'tool', label: M.step(mcpTool.serverName, mcpTool.tool) };
    reply.steps.push(step);
    renderLast();
    if (!mcpAllowed.has(key)) {
      const ok = await confirmDialog({ title: M.askTitle, text: `${M.ask(mcpTool.serverName, mcpTool.tool)}\n\n\u2066${JSON.stringify(args).slice(0, 600)}\u2069`, ok: M.allow, cancel: M.deny });
      if (!ok) {
        step.failed = true;
        return M.denied;
      }
      mcpAllowed.add(key);
    }
    const res = await window.blazma.mcpCall(mcpTool.server, mcpTool.tool, args);
    if (!res.ok || res.result.isError) step.failed = true;
    return res.ok ? res.result.text || '(empty)' : `The tool failed (${res.error.detail || res.error.code}).`;
  }
  if (call.function.name === 'web_search') {
    const step = { kind: 'search', label: String(args.query || '') };
    reply.steps.push(step);
    renderLast();
    const res = await window.blazma.webSearch(args.query || '');
    if (!res.ok || !res.result.results.length) {
      step.failed = true;
      return 'The search failed or returned no results.';
    }
    for (const r of res.result.results) reply.sources.push({ title: r.title, url: r.url });
    return res.result.results.map((r, i) => `${i + 1}. ${r.title}\nURL: ${r.url}\n${r.snippet}`).join('\n\n');
  }
  if (call.function.name === 'open_url') {
    // Only links that came from search results or that the user wrote; small
    // models otherwise invent addresses.
    const norm = (u) => String(u || '').trim().replace(/\/+$/, '');
    const allowed = new Set([
      ...reply.sources.map((src) => norm(src.url)),
      ...messages.filter((m) => m.role === 'user').flatMap((m) => (m.content.match(/https?:\/\/[^\s)]+/g) || []).map(norm)),
    ]);
    if (!allowed.has(norm(args.url))) {
      return 'You can only open links that appeared in your search results or that the user wrote. Search first.';
    }
    const step = { kind: 'open', label: String(args.url || '') };
    reply.steps.push(step);
    renderLast();
    const res = await window.blazma.webOpen(args.url || '');
    if (!res.ok) {
      step.failed = true;
      return `Could not open the page (${res.error.code}).`;
    }
    step.label = res.result.title || res.result.url;
    reply.sources.push({ title: res.result.title || res.result.url, url: res.result.url });
    return `${res.result.title}\n${res.result.url}\n\n${res.result.text}${res.result.truncated ? '\n[truncated]' : ''}`;
  }
  return `Unknown tool ${call.function.name}.`;
}

// True from the moment a message is sent until its reply has started, so a
// second Enter during the first awaits cannot send another message.
let sending = false;
// "بحث معمّق" was pressed for the next message (lib/research.js).
let researchMode = false;

async function send(text, images = [], files = [], command = null) {
  if (sending || abortController) return;
  sending = true;
  try {
    await sendNow(text, images, files, command);
  } finally {
    sending = false;
  }
}

async function sendNow(text, images, files, command) {
  if (!messages.length) $('chat-log').replaceChildren();
  if (files.length) {
    const { contextSize } = await window.blazma.getChatSettings();
    const budget = contextSize * CHARS_PER_TOKEN * FILE_SHARE;
    const total = files.reduce((n, f) => n + f.chars, 0);
    if (total > budget) showComposerNote(ui.chat.fileTooLong(Math.max(1, Math.floor((budget / total) * 100))), 8000);
  }
  const research = researchMode && text.trim().length > 3;
  researchMode = false;
  window.dispatchEvent(new CustomEvent('blazma:research-done'));
  messages.push({ role: 'user', content: text, images, files, ...(command ? { command } : {}), ...(research ? { research: true } : {}) });
  renderLast();
  await generate();
}

// Generates an assistant reply for the conversation as it is now (its last
// message is the user's), then saves the conversation.
async function generate() {
  // One reply at a time. The busy state starts at once (before the library
  // search and the device summary), so a second Enter cannot start a second
  // reply and the stop button works from the first moment.
  if (abortController) return;
  abortController = new AbortController();
  const signal = abortController.signal;
  const reply = { role: 'assistant', content: '', reasoning: '', streaming: true, thinkStart: Date.now(), steps: [], sources: [], model: currentModelName() };
  // A regenerated reply becomes a new branch next to the earlier ones.
  if (pendingBranch && pendingBranch.index === messages.length) {
    reply.alts = pendingBranch.alts;
    reply.altIndex = pendingBranch.alts.length;
    reply.alts.push([]);
  }
  pendingBranch = null;
  messages.push(reply);
  renderLast();
  setBusy(true);

  try {
    const conn = await window.blazma.getConnection();
    if (!conn) {
      reply.error = ui.chat.errors.notReady;
      return;
    }
    const chatSettings = await window.blazma.getChatSettings();
    const webOn = Boolean(chatSettings.webSearch);
    const persona = personaById(currentPersonaId);
    let system = `${persona.prompt || chatSettings.systemPrompt}\n\n${dateContext(webOn)}`;
    const memory = chatSettings.memoryEnabled ? (chatSettings.memory || []) : [];
    if (memory.length) system += `\n\n${ui.v2.memory.context(memory.map((m) => `- ${m.text}`).join('\n'))}`;
    // "مكتبتي": the passages of the user's documents closest to the question.
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    // An assistant with its own documents always searches them (0.2.0).
    const ownDocs = persona.folders && persona.folders.length ? persona.folders : null;
    if ((chatSettings.kbInChat || ownDocs) && lastUser && lastUser.content.trim()) {
      // A library problem is reported as such; the reply goes on without it.
      const res = await window.blazma.kbSearch(lastUser.content, ownDocs).catch(() => ({ ok: false }));
      if (!res.ok) showComposerNote(ui.chat.kbFailed, 6000);
      const passages = res.ok ? res.result : [];
      if (passages.length) {
        // A file's summary (written from the library settings) goes once, before its passages.
        const sums = [...new Map(passages.filter((p) => p.summary).map((p) => [p.name, p.summary])).entries()];
        const head = sums.map(([n, t]) => `(${n}) ${ui.v2.kb2.summary}:\n${t}`).join('\n\n');
        system += `\n\n${ui.chat.kbContext((head ? `${head}\n\n` : '') + passages.map((p, i) => `[${i + 1}] (${p.name})\n${p.text}`).join('\n\n'))}`;
        reply.sources = passages.map((p) => ({ title: p.name, url: `file:${p.file}`, file: p.file }));
      }
      if (ownDocs && persona.strict) {
        if (!passages.length) {
          reply.content = ui.v2.assistant.notFound(persona.name);
          return;
        }
        system += `\n\n${ui.v2.assistant.strictRule}`;
      }
    }
    // "وضع الوكيل" / "عقل جهازك": tools on the user's files (and programs).
    const st = await window.blazma.getSettings();
    agentOn = Boolean(st.agentMode);
    brainOn = Boolean(st.brainEnabled);
    if (agentOn || brainOn) {
      reply.journal = `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
      system += `\n\n${agentRules({ agent: agentOn, brain: brainOn, places: await window.blazma.agentPlaces(), brainFolders: st.brainFolders || [] })}`;
    }
    if (chatSettings.shareDeviceInfo) {
      const summary = await window.blazma.deviceSummary().catch(() => null);
      if (summary) system += `\n\n${ui.chat.deviceContext(summary)}`;
    }
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    if ((await window.blazma.getSettings()).mcpServers.some((x) => x.enabled)) await window.blazma.mcpEnsure();
    reply.thinkStart = Date.now(); // the model starts now (after the search above)
    if (lastUser && lastUser.research) await deepResearch({ question: lastUser.content, reply, update: renderLast, signal, labels: ui.v2.research });
    else await streamReply({ reply, system, conn, chatSettings, webOn, signal });
  } catch (err) {
    if (err.name === 'AbortError') reply.stopped = true;
    else reply.error = ui.chat.errors.serverGone;
  } finally {
    if (reply.reasoning && !reply.thinkEnd) reply.thinkEnd = Date.now();
    reply.streaming = false;
    window.dispatchEvent(new CustomEvent('blazma:gen-speed', { detail: { tps: store.lastSpeed, live: false } }));
    abortController = null;
    setBusy(false);
    renderMessages();
    persist();
    if (document.activeElement === document.body) $('chat-input').focus();
    autoLearn(reply);
  }
}

// "ذاكرة تتعلم لحالها" (lib/learn.js): lasting facts from the last exchange.
async function autoLearn(reply) {
  if (reply.error || reply.stopped || !reply.content || reply.imagePrompt) return;
  const s = await window.blazma.getSettings();
  if (!s.memoryEnabled || !s.memoryAuto) return;
  const i = messages.indexOf(reply);
  const user = i > 0 ? messages[i - 1] : null;
  if (!user || user.role !== 'user' || user.command) return;
  const facts = await learnFrom(user.content, reply.content, s.memory || []);
  if (!facts.length) return;
  const now = await window.blazma.getSettings();
  const items = facts.map((text, k) => ({ id: `m${Date.now().toString(36)}${k}`, text, auto: true }));
  await window.blazma.updateSettings({ memory: [...(now.memory || []), ...items].slice(-200) });
  reply.learned = items.map(({ id, text }) => ({ id, text }));
  if (messages.includes(reply)) {
    renderMessages();
    persist();
  }
}

// "تراجع": every change of that request back as it was (agent.js journal).
async function undoChanges(msg) {
  const A = ui.v2.agent;
  if (!(await confirmDialog({ title: A.undoTitle, text: A.undoText(msg.changed), ok: A.undo, cancel: ui.common.cancel }))) return;
  const res = await window.blazma.agentUndo(msg.journal);
  if (!res.ok) return showComposerNote(A.undoFailed, 6000);
  msg.undone = A.undone(res.result.undone, res.result.inRecycleBin, res.result.failed.length);
  renderMessages();
  persist();
}

async function forgetLearned(msg) {
  const ids = new Set((msg.learned || []).map((x) => x.id));
  const s = await window.blazma.getSettings();
  await window.blazma.updateSettings({ memory: (s.memory || []).filter((m) => !ids.has(m.id)) });
  delete msg.learned;
  renderMessages();
  persist();
}

// The request to the model (with web-search tool rounds), streamed into reply.
async function streamReply({ reply, system, conn, chatSettings, webOn, signal }) {
  // Thinking text and tool traffic are not sent back as history; only the
  // user's messages and the final answers are.
  const history = messages
    .slice(0, -1)
    .filter((m) => !m.error || m.content)
    .map((m) => ({ role: m.role, content: apiContent(m, chatSettings.contextSize * CHARS_PER_TOKEN * FILE_SHARE) }));
  const apiMessages = [{ role: 'system', content: system }, ...history];
  // Web tools when search is on, plus the MCP tools of running servers.
  const mcpList = await window.blazma.mcpTools().catch(() => []);
  mcpByName = new Map(mcpList.map((m) => [m.spec.function.name, m]));
  const tools = [...(webOn ? TOOLS : []), ...(brainOn || agentOn ? BRAIN_TOOLS : []), ...(agentOn ? AGENT_TOOLS : []), ...mcpList.map((m) => m.spec)];
  const maxRounds = agentOn || brainOn ? AGENT_ROUNDS : MAX_TOOL_ROUNDS;

  for (let round = 0; round <= maxRounds; round++) {
    const payload = {
      messages: apiMessages,
      stream: true,
      // Speed in every chunk, for the live speed in the mini monitor.
      timings_per_token: true,
      ...chatSettings.sampling,
      // Gemma 4's template defaults thinking to off, Qwen3.5's to on; always say which.
      chat_template_kwargs: { enable_thinking: chatSettings.thinking },
      // Several searches in one reply are read as calls, not left as text.
      ...(tools.length ? { parallel_tool_calls: true } : {}),
    };
    // The last round has no tools, so the model must answer with what it found.
    if (tools.length && round < maxRounds) payload.tools = tools;

    const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const type = err && err.error && err.error.type;
      reply.error = type === 'exceed_context_size_error' ? ui.chat.errors.contextFull : ui.chat.errors.generic;
      break;
    }

    const toolCalls = [];
    let roundContent = '';
    for await (const chunk of readSse(res)) {
      // The engine failed in the middle of the reply: say so instead of
      // leaving an empty answer.
      if (chunk.error) {
        const type = chunk.error.type || (chunk.error.error && chunk.error.error.type);
        reply.error = type === 'exceed_context_size_error' ? ui.chat.errors.contextFull : ui.chat.errors.midStream;
        return;
      }
      const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (delta) {
        if (delta.reasoning_content) reply.reasoning += delta.reasoning_content;
        if (delta.content) {
          if (!reply.content && reply.reasoning) reply.thinkEnd = Date.now();
          reply.content += delta.content;
          roundContent += delta.content;
        }
        for (const tc of delta.tool_calls || []) {
          const slot = (toolCalls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.function.name += tc.function.name;
          if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
        }
      }
      if (chunk.timings) {
        reply.timings = chunk.timings;
        if (chunk.timings.predicted_per_second) {
          store.lastSpeed = chunk.timings.predicted_per_second;
          window.dispatchEvent(new CustomEvent('blazma:gen-speed', { detail: { tps: store.lastSpeed, live: true } }));
        }
      }
      renderLast();
    }

    // Calls the server left in the text (lib/toolcalls.js) are run too, and
    // their raw syntax is not shown.
    // Only on a round that offered tools: the last round has none, and its
    // text is the answer.
    const toolsOffered = Boolean(payload.tools);
    const leaked = toolsOffered ? extractTextToolCalls(roundContent) : { calls: [], content: roundContent.trim() };
    if (leaked.calls.length || leaked.content !== roundContent.trim()) {
      reply.content = reply.content.slice(0, reply.content.length - roundContent.length) + leaked.content;
      roundContent = leaked.content;
      for (const c of leaked.calls) toolCalls.push({ id: '', type: 'function', function: { name: c.name, arguments: c.arguments } });
    }
    const calls = toolCalls.filter(Boolean);
    if (!calls.length) break;
    calls.forEach((c, i) => {
      if (!c.id) c.id = `call_${round}_${i}`;
    });
    apiMessages.push({ role: 'assistant', content: roundContent, tool_calls: calls });
    for (const call of calls) {
      const result = await runTool(call, reply);
      if (signal.aborted) throw new DOMException('aborted', 'AbortError');
      apiMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
    renderLast();
  }
}

// ---------- image generation ----------

let imageBusy = false;
let imageHold = false; // keep the chat shown until the chat model is back (onState)

// The image model reads English best, so an Arabic description is first
// translated by the chat model (while it is still loaded).
async function englishPrompt(text) {
  if (detectDir(text) !== 'rtl') return text;
  const conn = await window.blazma.getConnection();
  if (!conn) return text;
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({
        messages: [
          { role: 'system', content: 'Translate the user\'s image description into one detailed English prompt for an image generator. Reply with the English prompt only.' },
          { role: 'user', content: text },
        ],
        max_tokens: 300,
        temperature: 0.3,
        chat_template_kwargs: { enable_thinking: false },
      }),
    });
    const json = await res.json();
    const out = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
    return out && out.trim() ? out.trim() : text;
  } catch {
    return text;
  }
}

async function makeImage(text) {
  imageBusy = true;
  imageHold = true;
  setBusy(true);
  if (!messages.length) $('chat-log').replaceChildren();
  messages.push({ role: 'user', content: `${ui.chat.imagePrefix} ${text}` });
  const reply = { role: 'assistant', content: '', generatingImage: true, imagePrompt: text };
  messages.push(reply);
  renderMessages();
  const started = Date.now();
  const tick = setInterval(() => {
    const t = document.querySelector('.image-elapsed');
    if (t) t.textContent = ui.chat.imageElapsed(Math.floor((Date.now() - started) / 1000));
  }, 1000);
  try {
    const prompt = await englishPrompt(text);
    const res = await window.blazma.imagesGenerate(prompt);
    if (res.ok) {
      reply.images = [res.result.dataUrl];
      reply.imagePrompt = prompt;
      reply.content = ui.chat.imageDone(res.result.size);
    } else if (res.error.code === 'image-cancelled') reply.stopped = true;
    else reply.error = (ui.errors[res.error.code] || ui.errors.unknown).title;
  } finally {
    clearInterval(tick);
    delete reply.generatingImage;
    imageBusy = false;
    setBusy(false);
    renderMessages();
    persist();
  }
}

// ---------- branches ----------
// Regenerating a reply or editing a message keeps the earlier version. The
// message where the versions part holds `alts` (each a copy of the
// conversation from that point on) and `altIndex` (the one shown).

let pendingBranch = null; // { index, alts } for the reply generate() is about to add

const copyTail = (tail) =>
  tail.map((m, i) => {
    const c = JSON.parse(JSON.stringify({ ...m, streaming: false }));
    if (i === 0) {
      delete c.alts;
      delete c.altIndex;
    }
    return c;
  });

// Writes what is shown back into its slot at every branch point (from the
// end, so an outer copy includes the inner branches).
function syncBranches() {
  for (let k = messages.length - 1; k >= 0; k--) {
    const m = messages[k];
    if (m.alts) m.alts[m.altIndex] = copyTail(messages.slice(k));
  }
}

function branchesAt(k) {
  syncBranches();
  return messages[k].alts || [copyTail(messages.slice(k))];
}

function switchBranch(k, to) {
  if (abortController || imageBusy) return;
  syncBranches();
  const alts = messages[k].alts;
  if (!alts || !alts[to] || !alts[to].length) return;
  const tail = JSON.parse(JSON.stringify(alts[to]));
  tail[0].alts = alts;
  tail[0].altIndex = to;
  messages = [...messages.slice(0, k), ...tail];
  renderMessages();
  persist();
}

function branchNav(msg, index) {
  const n = msg.alts.length;
  const prev = el('button', { type: 'button', class: 'icon-btn', title: ui.chat.prevBranch, 'aria-label': ui.chat.prevBranch, disabled: msg.altIndex === 0 }, DIR === 'rtl' ? '›' : '‹');
  const next = el('button', { type: 'button', class: 'icon-btn', title: ui.chat.nextBranch, 'aria-label': ui.chat.nextBranch, disabled: msg.altIndex === n - 1 }, DIR === 'rtl' ? '‹' : '›');
  prev.addEventListener('click', () => switchBranch(index, msg.altIndex - 1));
  next.addEventListener('click', () => switchBranch(index, msg.altIndex + 1));
  return el('span', { class: 'branch-nav', title: ui.chat.branchHint }, prev, el('span', { class: 'branch-count' }, `${msg.altIndex + 1}/${n}`), next);
}

// ---------- regenerate / edit ----------

function regenerate() {
  if (abortController || imageBusy || !messages.length || messages[messages.length - 1].role !== 'assistant') return;
  const index = messages.length - 1;
  pendingBranch = { index, alts: branchesAt(index) };
  messages.pop();
  renderMessages();
  generate();
}

function startEdit(index) {
  if (abortController || imageBusy) return;
  editingIndex = index;
  renderMessages();
}

function saveEdit(index, text) {
  // An edit box left open while a reply started: wait for the reply.
  if (abortController || imageBusy || sending) {
    showComposerNote(ui.chat.busySwitch, 4000);
    return;
  }
  const content = text.trim();
  const original = messages[index];
  if (!content && !(original.images && original.images.length)) return;
  editingIndex = null;
  const alts = branchesAt(index);
  const edited = { role: 'user', content, images: original.images || [], files: original.files || [], alts, altIndex: alts.length };
  alts.push([]);
  messages = [...messages.slice(0, index), edited];
  renderMessages();
  generate();
}

// ---------- saved conversations ----------

function renderPersonaPill() {
  const p = personaById(currentPersonaId);
  $('persona-pill').textContent = `${p.icon} ${p.name} ▾`;
}

function setPersona(id, { remember = true } = {}) {
  currentPersonaId = personaById(id).id;
  renderPersonaPill();
  if (remember) {
    try {
      localStorage.setItem('blazma.persona', currentPersonaId);
    } catch {
      /* not critical */
    }
    if (currentChatId && messages.length) persist();
  }
}

// ---------- export ----------

function chatTitle() {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 60) : ui.chat.untitled;
}

function exportMarkdown() {
  const lines = [`# ${chatTitle()}`, '', `_${ui.chat.exportedOn(new Date().toLocaleString(LOCALE))}_`, ''];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push(`## ${ui.chat.you}`, '');
      if (m.files && m.files.length) lines.push(`📎 ${m.files.map((f) => f.name).join(ui.common.listSep)}`, '');
      if (m.images && m.images.length) lines.push(`🖼 ${ui.chat.imagesCount(m.images.length)}`, '');
      const cmd = m.command && commandById(m.command);
      lines.push(`${cmd ? `/${cmd.name} ` : ''}${m.content || ''}`, '');
    } else if (m.content || m.error) {
      lines.push(`## ${ui.chat.assistantName}`, '', m.content || m.error, '');
      if (m.sources && m.sources.length) lines.push(`${ui.chat.sources}:`, ...m.sources.map((src) => `- [${src.title || src.url}](${src.url})`), '');
    }
  }
  return lines.join('\n');
}

function exportHtml() {
  const mdLabels = { copy: ui.actions.copy, copied: ui.actions.copied, code: ui.chat.code };
  const box = document.createElement('div');
  box.append(el('h1', null, chatTitle()), el('div', { class: 'meta' }, ui.chat.exportedOn(new Date().toLocaleString(LOCALE))));
  for (const m of messages) {
    if (m.role !== 'user' && !m.content && !m.error) continue;
    const body = el('div', { class: `msg ${m.role === 'user' ? 'user' : 'assistant'}` }, el('div', { class: 'who' }, m.role === 'user' ? ui.chat.you : ui.chat.assistantName));
    if (m.role === 'user') {
      if (m.files && m.files.length) body.append(el('div', { class: 'files' }, `📎 ${m.files.map((f) => f.name).join(ui.common.listSep)}`));
      for (const src of m.images || []) body.append(el('img', { src, alt: '' }));
      const cmd = m.command && commandById(m.command);
      body.append(el('div', { dir: 'auto' }, ...`${cmd ? `/${cmd.name} ` : ''}${m.content || ''}`.split('\n').flatMap((l, i) => (i ? [el('br'), l] : [l]))));
    } else body.append(renderMarkdown(m.content || m.error, mdLabels));
    box.append(body);
  }
  return box.innerHTML;
}

async function exportChat(format) {
  if (!messages.length) return;
  const res = await window.blazma.exportChat({ title: chatTitle(), format, markdown: format === 'md' ? exportMarkdown() : '', html: format === 'pdf' ? exportHtml() : '' });
  if (res.ok && res.result.saved) showComposerNote(ui.chat.exported);
}

function openExportMenu() {
  const old = document.querySelector('.export-menu');
  if (old) {
    old.remove();
    return;
  }
  const btn = $('btn-export-chat');
  const item = (label, format) => {
    const b = el('button', { type: 'button', class: 'model-menu-item' }, label);
    b.addEventListener('click', () => {
      menu.remove();
      exportChat(format);
    });
    return b;
  };
  const menu = el('div', { class: 'model-menu export-menu', role: 'menu' }, item(ui.chat.exportMd, 'md'), item(ui.chat.exportPdf, 'pdf'));
  const r = btn.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.left = `${r.left}px`;
  document.body.append(menu);
  const off = (e) => {
    if (!e.target.closest('.export-menu') && !e.target.closest('#btn-export-chat')) {
      menu.remove();
      document.removeEventListener('mousedown', off);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

async function persist() {
  if (!messages.some((m) => m.role === 'user')) return;
  syncBranches();
  if (!currentChatId) currentChatId = crypto.randomUUID();
  await window.blazma.chatsSave({ id: currentChatId, messages, personaId: currentPersonaId, fallbackTitle: ui.chat.untitled });
  refreshList();
}

function newChat() {
  closePreview();
  mcpAllowed = new Set();
  stopSpeaking();
  if (abortController) abortController.abort();
  if (imageBusy) window.blazma.imagesCancel();
  currentChatId = null;
  editingIndex = null;
  messages = [];
  renderMessages();
  highlightCurrent();
  $('chat-input').focus();
}

async function loadChat(id) {
  closePreview();
  mcpAllowed = new Set();
  // Not while a reply or a picture is on its way: it belongs to this chat.
  if (abortController || imageBusy || sending) {
    showComposerNote(ui.chat.busySwitch, 4000);
    return;
  }
  stopSpeaking();
  const chat = await window.blazma.chatsGet(id);
  if (!chat) return;
  currentChatId = chat.id;
  editingIndex = null;
  messages = chat.messages;
  setPersona(chat.personaId || 'general', { remember: false });
  renderMessages();
  highlightCurrent();
}

// From a search result: scroll to the message with the first hit and mark
// the words found in it for a few seconds.
function jumpToMessage(index, query) {
  const node = index >= 0 ? $('chat-log').querySelector(`.msg[data-index="${index}"]`) : null;
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('search-hit');
  setTimeout(() => node.classList.remove('search-hit'), 4000);
  const fold = (s) => s.replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[\u0622\u0623\u0625\u0671]/g, '\u0627').replace(/\u0649/g, '\u064A').replace(/\u0629/g, '\u0647').toLowerCase();
  const words = fold(query).split(/\s+/).filter((w) => w.length > 1).map((w) => (w.length > 4 && w.startsWith('\u0627\u0644') ? w.slice(2) : w));
  if (!words.length || !window.CSS || !CSS.highlights) return;
  const ranges = [];
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const raw = t.nodeValue;
    // positions in the folded text map back through the kept characters
    const keep = [];
    for (let i = 0; i < raw.length; i++) if (!/[\u064B-\u065F\u0670\u0640]/.test(raw[i])) keep.push(i);
    const f = fold(raw);
    for (const w of words) {
      for (let at = f.indexOf(w); at !== -1; at = f.indexOf(w, at + w.length)) {
        const r = new Range();
        r.setStart(t, keep[at]);
        r.setEnd(t, keep[at + w.length - 1] + 1);
        ranges.push(r);
      }
    }
  }
  CSS.highlights.set('blazma-search', new Highlight(...ranges));
  setTimeout(() => CSS.highlights.delete('blazma-search'), 6000);
}

function highlightCurrent() {
  for (const item of document.querySelectorAll('.chat-item')) item.setAttribute('aria-current', String(item.dataset.id === currentChatId));
}

function startRename(item, chat) {
  const input = el('input', { type: 'text', value: chat.title, dir: 'auto', 'aria-label': ui.chat.rename });
  const done = async (commit) => {
    if (commit && input.value.trim()) await window.blazma.chatsRename(chat.id, input.value.trim());
    refreshList();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  item.replaceChildren(input);
  input.focus();
  input.select();
}

// The folder shown in the list ('' = all chats), kept between starts.
let folderFilter = (() => {
  try {
    return localStorage.getItem('blazma.chatFolder') || '';
  } catch {
    return '';
  }
})();

function setFolderFilter(f) {
  folderFilter = f;
  try {
    localStorage.setItem('blazma.chatFolder', f);
  } catch {
    /* not kept */
  }
  refreshList();
}

// "All" plus one chip per folder that has chats.
function renderFolders(items) {
  const bar = $('chat-folders');
  const folders = [...new Set(items.map((c) => c.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b, LOCALE));
  if (folderFilter && !folders.includes(folderFilter)) folderFilter = '';
  bar.hidden = !folders.length;
  const chip = (label, value) => {
    const b = el('button', { type: 'button', class: `folder-chip${folderFilter === value ? ' active' : ''}`, 'aria-pressed': String(folderFilter === value) }, label);
    b.addEventListener('click', () => setFolderFilter(value));
    return b;
  };
  bar.setAttribute('aria-label', ui.chat.foldersLabel);
  bar.replaceChildren(chip(ui.chat.allChats, ''), ...folders.map((f) => chip(`📁 ${f}`, f)));
  return folders;
}

// "Move to folder": the folders there are, no folder, or a new one.
function openFolderMenu(anchor, chat, folders) {
  document.querySelectorAll('.folder-menu').forEach((m) => m.remove());
  const move = async (folder) => {
    menu.remove();
    await window.blazma.chatsSetMeta(chat.id, { folder });
    refreshList();
  };
  const row = (label, folder, current) => {
    const b = el('button', { type: 'button', class: `model-menu-item${current ? ' current' : ''}`, role: 'menuitem' }, label);
    b.addEventListener('click', () => move(folder));
    return b;
  };
  const add = el('button', { type: 'button', class: 'model-menu-item more', role: 'menuitem' }, ui.chat.newFolder);
  add.addEventListener('click', async () => {
    menu.remove();
    const name = await promptDialog({ title: ui.chat.newFolderTitle, placeholder: ui.chat.newFolderPh, maxLength: 40, ok: ui.chat.moveToFolder, cancel: ui.chat.cancel });
    if (name) {
      await window.blazma.chatsSetMeta(chat.id, { folder: name });
      refreshList();
    }
  });
  const menu = el(
    'div',
    { class: 'model-menu folder-menu', role: 'menu' },
    el('div', { class: 'model-menu-head' }, ui.chat.moveToFolder),
    row(ui.chat.noFolder, '', !chat.folder),
    ...folders.map((f) => row(`📁 ${f}`, f, chat.folder === f)),
    add,
  );
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  document.body.append(menu);
  const off = (e) => {
    if (!menu.contains(e.target)) {
      menu.remove();
      document.removeEventListener('mousedown', off);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', off), 0);
}

function renderList(allItems, query) {
  const box = $('chat-items');
  const folders = renderFolders(allItems);
  const items = !query && folderFilter ? allItems.filter((c) => c.folder === folderFilter) : allItems;
  if (!items.length) {
    box.replaceChildren(el('div', { class: 'chat-list-empty' }, query ? ui.chat.noResults : ui.chat.noChats));
    return;
  }
  // Pinned chats first, then by date when not searching: today, yesterday, this week, older.
  const dayStart = new Date().setHours(0, 0, 0, 0);
  const groupOf = (t) => (t >= dayStart ? 'today' : t >= dayStart - 864e5 ? 'yesterday' : t >= dayStart - 7 * 864e5 ? 'week' : t >= dayStart - 30 * 864e5 ? 'month' : 'older');
  let lastGroup = null;
  box.replaceChildren(
    ...items.flatMap((chat) => {
      const group = query ? null : chat.pinned ? 'pinned' : chat.updatedAt ? groupOf(chat.updatedAt) : null;
      const header = group && group !== lastGroup ? el('div', { class: 'chat-group' }, group === 'pinned' ? `📌 ${ui.chat.pinnedGroup}` : ui.chat.groups[group]) : null;
      lastGroup = group || lastGroup;
      const item = el(
        'div',
        { class: `chat-item${chat.pinned ? ' pinned' : ''}`, role: 'button', tabindex: '0', 'data-id': chat.id, 'aria-current': String(chat.id === currentChatId) },
        el('span', { class: 'chat-item-title', dir: 'auto' }, chat.title || ui.chat.untitled),
        chat.snippet ? el('span', { class: 'chat-item-snippet', dir: 'auto' }, chat.snippet) : null,
        chat.folder && !folderFilter ? el('span', { class: 'chat-item-folder' }, `📁 ${chat.folder}`) : null,
      );
      const pinLabel = chat.pinned ? ui.chat.unpin : ui.chat.pin;
      const actions = el(
        'span',
        { class: 'chat-item-actions' },
        el('button', { type: 'button', title: pinLabel, 'aria-label': pinLabel, 'aria-pressed': String(Boolean(chat.pinned)) }, '📌'),
        el('button', { type: 'button', title: ui.chat.moveToFolder, 'aria-label': ui.chat.moveToFolder }, '📁'),
        el('button', { type: 'button', title: ui.chat.rename, 'aria-label': ui.chat.rename }, '✎'),
        el('button', { type: 'button', title: ui.chat.remove, 'aria-label': ui.chat.remove }, '🗑'),
      );
      const [pinBtn, folderBtn, renameBtn, deleteBtn] = actions.children;
      pinBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        await window.blazma.chatsSetMeta(chat.id, { pinned: !chat.pinned });
        refreshList();
      });
      folderBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openFolderMenu(folderBtn, chat, folders);
      });
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(item, chat);
      });
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog({ text: ui.chat.confirmDelete(chat.title || ui.chat.untitled), danger: true }))) return;
        await window.blazma.chatsDelete(chat.id);
        if (chat.id === currentChatId) newChat();
        refreshList();
      });
      item.append(actions);
      const open = () => loadChat(chat.id).then(() => query && jumpToMessage(chat.messageIndex, query));
      item.addEventListener('click', open);
      item.addEventListener('keydown', (e) => e.target === item && e.key === 'Enter' && open());
      return header ? [header, item] : [item];
    }),
  );
}

async function refreshList() {
  const query = $('chat-search').value.trim();
  const items = query ? await window.blazma.chatsSearch(query) : await window.blazma.chatsList();
  renderList(items, query);
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`;
}

export function initChat() {
  const input = $('chat-input');
  initPreview(document.querySelector('.page-chat'), (text) => {
    if (abortController || imageBusy || sending) return;
    send(text);
  });
  // From the quick assistant: the same question, continued in a new chat.
  window.blazma.onQuickToChat((text) => {
    window.dispatchEvent(new CustomEvent('blazma:show-page', { detail: 'chat' }));
    if (abortController || imageBusy || sending || !text) return;
    newChat();
    send(text);
  });
  // Scheduled tasks: a finished task appears in the list; its notification opens it.
  window.blazma.onTaskOpen((id) => {
    refreshList();
    if (!id) return;
    window.dispatchEvent(new CustomEvent('blazma:show-page', { detail: 'chat' }));
    if (!abortController) loadChat(id);
  });
  $('model-pill').addEventListener('click', () => (document.querySelector('.model-switch') ? closeModelMenu() : openModelMenu()));
  $('persona-pill').addEventListener('click', (e) => openPersonaMenu(e.currentTarget, currentPersonaId, (id) => setPersona(id)));
  $('btn-export-chat').title = ui.chat.exportTitle;
  $('btn-export-chat').addEventListener('click', openExportMenu);
  loadPersonas().then(renderPersonaPill);
  input.placeholder = ui.chat.placeholder;
  input.addEventListener('input', () => autoGrow(input));
  attachSlashMenu(input); // before the Enter handler: Enter picks a command while the list is open
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if ((!text && !pendingImages.length && !pendingFiles.length) || abortController || imageBusy || sending) return;
    // "/تذكر …": saved to the memory (settings), not sent to the model.
    const remember = text.match(/^\/(?:تذكر|تذكّر|remember)(?:\s+([\s\S]*))?$/i);
    if (remember) {
      const fact = (remember[1] || '').trim().slice(0, 500);
      if (!fact) return showComposerNote(ui.v2.memory.empty, 5000);
      window.blazma.getSettings().then((s) => {
        const memory = [...(s.memory || []), { id: `m${Date.now().toString(36)}`, text: fact }].slice(-200);
        return window.blazma.updateSettings({ memory, memoryEnabled: true });
      }).then(() => {
        input.value = '';
        autoGrow(input);
        showComposerNote(ui.v2.memory.saved, 3000);
      });
      return;
    }
    if (setupState && setupState.phase !== 'ready') {
      showComposerNote(ui.chat.waitModel, 5000);
      return;
    }
    if (pendingFiles.some((f) => f.reading)) {
      showComposerNote(ui.chat.fileStillReading);
      return;
    }
    const slash = parseCommand(text);
    if (slash && !slash.rest && !pendingFiles.length) {
      showComposerNote(ui.chat.slashNeedText);
      return;
    }
    const images = pendingImages;
    const files = pendingFiles;
    pendingImages = [];
    pendingFiles = [];
    renderPreview();
    input.value = '';
    autoGrow(input);
    if (slash) send(slash.rest, images, files, slash.command);
    else send(text, images, files);
  });

  // Web search on/off, remembered in settings.
  // "وضع الوكيل": the model may work on files and open programs.
  const agentBtn = $('btn-agent');
  const showAgent = (on) => {
    agentBtn.setAttribute('aria-pressed', String(on));
    agentBtn.title = on ? ui.v2.agent.toggleOn : ui.v2.agent.toggleOff;
    agentBtn.setAttribute('aria-label', agentBtn.title);
  };
  window.blazma.getSettings().then((st) => showAgent(st.agentMode));
  agentBtn.addEventListener('click', async () => {
    const on = agentBtn.getAttribute('aria-pressed') !== 'true';
    const st = await window.blazma.updateSettings({ agentMode: on });
    showAgent(st.agentMode);
    showComposerNote(on ? ui.v2.agent.onNote : ui.v2.agent.offNote, 5000);
  });
  // "بحث معمّق": the next message is researched on the web into a report.
  const researchBtn = $('btn-research');
  const showResearch = (on) => {
    researchBtn.setAttribute('aria-pressed', String(on));
    researchBtn.title = ui.v2.research.toggle;
    researchBtn.setAttribute('aria-label', researchBtn.title);
    $('chat-input').placeholder = on ? ui.v2.research.placeholder : ui.chat.placeholder;
  };
  showResearch(false);
  researchBtn.addEventListener('click', () => {
    researchMode = researchBtn.getAttribute('aria-pressed') !== 'true';
    showResearch(researchMode);
    $('chat-input').focus();
  });
  window.addEventListener('blazma:research-done', () => showResearch(false));

  const webBtn = $('btn-web');
  const showWeb = (on) => {
    webBtn.setAttribute('aria-pressed', String(on));
    webBtn.title = on ? ui.chat.webToggleOn : ui.chat.webToggleOff;
    webBtn.setAttribute('aria-label', webBtn.title);
  };
  window.blazma.getSettings().then((st) => showWeb(st.webSearch));
  webBtn.addEventListener('click', async () => {
    const st = await window.blazma.updateSettings({ webSearch: webBtn.getAttribute('aria-pressed') !== 'true' });
    showWeb(st.webSearch);
  });

  // Image generation: the text in the box describes the picture.
  const imgBtn = $('btn-image-gen');
  imgBtn.title = ui.chat.imageGen;
  imgBtn.setAttribute('aria-label', ui.chat.imageGen);
  imgBtn.addEventListener('click', async () => {
    const text = input.value.trim();
    if (abortController || imageBusy) return;
    if (!text) return showComposerNote(ui.chat.imageNeedText, 5000);
    const st = await window.blazma.imagesStatus();
    if (!st.program || !st.models) {
      const plan = await window.blazma.imagesPlan();
      const gb = plan.ok ? (plan.result.bytes / 1e9).toFixed(1) : '6.5';
      if (!(await confirmDialog({ text: ui.chat.imageInstall(gb), ok: ui.chat.download }))) return;
      imgBtn.disabled = true;
      const off = window.blazma.onImagesProgress((p) => {
        const box = $('attach-preview');
        box.hidden = false;
        box.replaceChildren(el('span', { class: 'muted small attach-note' }, ui.chat.imageDownloading(p.stage, p.total ? Math.floor((p.done / p.total) * 100) : 0)));
      });
      const res = await window.blazma.imagesInstall();
      off();
      imgBtn.disabled = false;
      renderPreview();
      if (!res.ok) return showComposerNote((ui.errors[res.error.code] || ui.errors.unknown).title, 6000);
    }
    input.value = '';
    autoGrow(input);
    await makeImage(text);
  });

  // Voice input: record, then whisper.cpp turns it into text in the input box.
  const micBtn = $('btn-mic');
  micBtn.title = ui.chat.mic;
  micBtn.setAttribute('aria-label', ui.chat.mic);
  let recording = null;
  let micNote = null;
  const setMicNote = (text) => {
    if (micNote) micNote.remove();
    micNote = null;
    if (!text) return renderPreview();
    const box = $('attach-preview');
    box.hidden = false;
    micNote = el('span', { class: 'muted small attach-note' }, text);
    box.append(micNote);
  };
  micBtn.addEventListener('click', async () => {
    if (recording) {
      const rec = recording;
      recording = null;
      micBtn.classList.remove('recording');
      micBtn.setAttribute('aria-pressed', 'false');
      setMicNote(ui.chat.micConverting);
      try {
        const { wav, seconds } = await rec.stop();
        if (seconds < 0.4) return setMicNote(null);
        const res = await window.blazma.voiceTranscribe(wav);
        setMicNote(null);
        if (!res.ok) return showComposerNote((ui.errors[res.error.code] || ui.errors.unknown).title, 6000);
        if (!res.result) return showComposerNote(ui.chat.micNothing, 4000);
        const at = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, at);
        input.value = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${res.result}${input.value.slice(at)}`;
        autoGrow(input);
        input.focus();
      } catch {
        setMicNote(null);
        showComposerNote(ui.chat.micFailed, 5000);
      }
      return;
    }
    const st = await window.blazma.voiceStatus();
    if (!st.program || !st.model) {
      if (!(await confirmDialog({ text: ui.chat.micInstall(st.modelKind), ok: ui.chat.download }))) return;
      micBtn.disabled = true;
      const off = window.blazma.onVoiceProgress((p) => setMicNote(ui.chat.micDownloading(p.stage, p.total ? Math.floor((p.done / p.total) * 100) : 0)));
      const res = await window.blazma.voiceInstall();
      off();
      micBtn.disabled = false;
      setMicNote(null);
      if (!res.ok) return showComposerNote((ui.errors[res.error.code] || ui.errors.unknown).title, 6000);
    }
    try {
      recording = await startRecording();
    } catch {
      return showComposerNote(ui.chat.micDenied, 6000);
    }
    micBtn.classList.add('recording');
    micBtn.setAttribute('aria-pressed', 'true');
    setMicNote(ui.chat.micRecording);
  });

  // "مكتبتي" on/off, remembered in settings; without indexed files it opens
  // the settings section where folders are added.
  const kbBtn = $('btn-kb');
  const showKb = (on) => {
    kbBtn.setAttribute('aria-pressed', String(on));
    kbBtn.title = on ? ui.chat.kbOn : ui.chat.kbOff;
    kbBtn.setAttribute('aria-label', kbBtn.title);
  };
  window.blazma.getSettings().then((st) => showKb(st.kbInChat));
  kbBtn.addEventListener('click', async () => {
    const on = kbBtn.getAttribute('aria-pressed') !== 'true';
    if (on && !(await window.blazma.kbStatus()).chunks) {
      showComposerNote(ui.chat.kbEmpty, 6000);
      window.dispatchEvent(new CustomEvent('blazma:settings-tab', { detail: 'kb' }));
      window.dispatchEvent(new CustomEvent('blazma:show-page', { detail: 'settings' }));
      return;
    }
    const st = await window.blazma.updateSettings({ kbInChat: on });
    showKb(st.kbInChat);
  });

  // Images: button, paste, or drag and drop onto the chat.
  $('btn-attach').title = ui.chat.attach;
  $('btn-attach').setAttribute('aria-label', ui.chat.attach);
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addAttachments([...e.target.files]);
    e.target.value = '';
  });
  input.addEventListener('paste', (e) => {
    const files = [...e.clipboardData.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) {
      e.preventDefault();
      addAttachments(files);
    }
  });
  const area = $('chat-area');
  area.addEventListener('dragover', (e) => e.preventDefault());
  area.addEventListener('drop', (e) => {
    e.preventDefault();
    addAttachments([...e.dataTransfer.files]);
  });
  $('btn-stop-gen').addEventListener('click', () => {
    if (abortController) abortController.abort();
    else if (imageBusy) window.blazma.imagesCancel();
  });
  $('btn-new-chat').addEventListener('click', newChat);
  let searchTimer = null;
  window.addEventListener('blazma:chats-changed', () => refreshList());
  $('chat-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshList, 250);
  });
  refreshList();

  // "أعطِ الذكاء معلومات جهازي": off by default, remembered in settings.
  const devBtn = $('btn-device-info');
  const showDev = (on) => {
    devBtn.setAttribute('aria-pressed', String(on));
    devBtn.title = on ? ui.chat.deviceInfoOn : ui.chat.deviceInfoOff;
    devBtn.setAttribute('aria-label', devBtn.title);
  };
  window.blazma.getSettings().then((st) => showDev(st.shareDeviceInfo));
  devBtn.addEventListener('click', async () => {
    const st = await window.blazma.updateSettings({ shareDeviceInfo: devBtn.getAttribute('aria-pressed') !== 'true' });
    showDev(st.shareDeviceInfo);
  });
  $('btn-stop-server').addEventListener('click', () => window.blazma.stopServer());

  window.blazma.onSetupState(onState);
  window.blazma.getSetupState().then(onState);
}
