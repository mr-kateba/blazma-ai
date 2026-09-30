// Chat page: setup/progress panel until the local server is ready, then a
// streaming chat against http://127.0.0.1:<port>/v1/chat/completions.

import { ar, errorText, formatBytes, formatDuration } from '../i18n/ar.js';
import { el, detectDir } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { readSse } from '../lib/sse.js';
import { store } from '../lib/store.js';

// Today's date and time in Arabic (Gregorian and Umm al-Qura Hijri), with
// Western digits to match the rest of the app.
function dateContext(webOn) {
  const now = new Date();
  const fmt = (calendar, opts) => new Intl.DateTimeFormat(`ar-SA-u-ca-${calendar}-nu-latn`, opts).format(now);
  return ar.chat.dateContext(
    fmt('gregory', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }),
    fmt('islamic-umalqura', { year: 'numeric', month: 'long', day: 'numeric' }),
    fmt('gregory', { hour: 'numeric', minute: '2-digit' }),
    webOn,
  );
}

const mdLabels = {
  copy: ar.actions.copy,
  copied: ar.actions.copied,
  code: ar.chat.code,
  saveCode: ar.chat.saveCode,
  savedCode: ar.chat.savedCode,
  save: (code, lang) => window.blazma.saveTextFile(code, lang),
};

const $ = (id) => document.getElementById(id);

let setupState = null;
let selectedModelId = null;
let messages = []; // { role, content, reasoning?, timings?, error?, stopped?, thinkStart?, thinkEnd? }
let abortController = null;
let speedSample = null; // for download speed: { t, done }
let visionEnabled = false; // the running model was started with its vision projector
let pendingImages = []; // data URLs attached to the message being written

const MAX_IMAGES = 4;
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
  const gpu = hw.nvidia
    ? `${hw.nvidia.name} · ${(hw.nvidia.vramMB / 1024).toFixed(0)} جيجابايت`
    : ar.setup.noNvidia;
  return el(
    'div',
    { class: 'hw-summary' },
    el('div', null, el('span', { class: 'muted' }, ar.setup.gpu), el('b', { dir: 'auto' }, gpu)),
    el('div', null, el('span', { class: 'muted' }, ar.setup.ram), el('b', null, `${(hw.ramMB / 1024).toFixed(0)} جيجابايت`)),
  );
}

function modelChooser(state) {
  if (!selectedModelId || !state.models.some((m) => m.id === selectedModelId)) {
    selectedModelId = state.recommendedId;
  }
  const list = el('div', { class: 'model-list', role: 'radiogroup' });
  for (const m of state.models) {
    const tags = [];
    if (m.id === state.recommendedId) tags.push(el('span', { class: 'tag tag-accent' }, ar.setup.recommended));
    if (m.downloaded) tags.push(el('span', { class: 'tag' }, ar.setup.downloaded));
    if (!m.fits) tags.push(el('span', { class: 'tag tag-warn' }, state.hardware.nvidia ? ar.setup.notFit : ar.setup.slowOnCpu));
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
  const chosen = state.models.find((m) => m.id === selectedModelId);
  const startBtn = el(
    'button',
    { type: 'button', class: 'btn primary big', onclick: () => window.blazma.startSetup(selectedModelId) },
    chosen && chosen.downloaded ? ar.setup.startDownloaded : ar.setup.start,
  );
  return [list, startBtn];
}

function phaseView(state) {
  const p = state.progress || {};
  switch (state.phase) {
    case 'detecting':
      return [el('div', { class: 'spinner' }), el('p', null, ar.phase.detecting)];
    case 'choose':
      return [
        el('h2', null, ar.setup.title),
        el('p', { class: 'muted' }, ar.setup.intro),
        hardwareSummary(state.hardware),
        !state.hardware.nvidia && el('div', { class: 'notice' }, ar.setup.cpuNotice),
        ...modelChooser(state),
      ];
    case 'engine': {
      if (p.stage === 'download' && p.total) {
        const { bar, pct } = progressBar(p.done, p.total);
        return [
          el('h2', null, ar.phase.engineDownload),
          bar,
          el('p', { class: 'muted' }, `${pct.toFixed(0)}% · ${formatBytes(p.done)} من ${formatBytes(p.total)}`),
        ];
      }
      const text =
        p.stage === 'extract' ? ar.phase.engineExtract : p.stage === 'test' ? ar.phase.engineTest : ar.phase.engineRelease;
      return [el('div', { class: 'spinner' }), el('p', null, text)];
    }
    case 'model-resolve':
      return [el('div', { class: 'spinner' }), el('p', null, ar.phase.modelResolve)];
    case 'model-download':
    case 'waiting-network': {
      const done = p.done || 0;
      const total = p.total || 0;
      const waiting = state.phase === 'waiting-network';
      if (!waiting) trackSpeed(done);
      const { bar, pct } = progressBar(done, total);
      const model = state.models.find((m) => m.id === state.modelId);
      const parts = [`${pct.toFixed(1)}%`, `${formatBytes(done)} من ${formatBytes(total)}`];
      if (!waiting && speed > 0) {
        parts.push(`${(speed / 1024 ** 2).toFixed(1)} ميجابايت/ث`);
        parts.push(`متبقٍّ ${formatDuration((total - done) / speed)}`);
      }
      return [
        el('h2', null, waiting ? ar.phase.waitingNetwork : ar.phase.modelDownload, model ? ` (${model.name})` : ''),
        bar,
        el('p', { class: 'muted', dir: 'rtl' }, parts.join(' · ')),
        waiting && el('div', { class: 'notice' }, ar.phase.waitingNetworkHint),
      ];
    }
    case 'loading':
      return [el('div', { class: 'spinner' }), el('p', null, ar.phase.loading), el('p', { class: 'muted' }, ar.phase.loadingHint)];
    case 'stopped':
      return [
        el('h2', null, ar.phase.stopped),
        el('p', { class: 'muted' }, ar.phase.stoppedHint),
        el(
          'div',
          { class: 'row' },
          el('button', { type: 'button', class: 'btn primary', onclick: () => window.blazma.retrySetup() }, ar.actions.startServer),
          el('button', { type: 'button', class: 'btn', onclick: () => showChooser() }, ar.actions.chooseModel),
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
          el('button', { type: 'button', class: 'btn primary', onclick: () => window.blazma.retrySetup() }, ar.actions.retry),
          el('button', { type: 'button', class: 'btn', onclick: () => showChooser() }, ar.actions.chooseModel),
        ),
        e.detail &&
          el(
            'details',
            { class: 'tech' },
            el('summary', null, ar.actions.details),
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

function renderStatus(state) {
  const model = state.models.find((m) => m.id === state.modelId);
  $('model-pill').textContent = model ? model.name : '';
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
  pill.lastChild.textContent = ar.status[key];

  const engineNote = $('engine-note');
  const fb = state.engine && state.engine.fallbackFrom && state.engine.fallbackFrom.length;
  engineNote.hidden = !fb || state.phase !== 'ready';
  if (fb) engineNote.textContent = ar.setup.fallbackNotice(state.engine.variant);

  $('btn-stop-server').hidden = !['ready', 'loading', 'model-download'].includes(state.phase);
}

function onState(state) {
  const prevPhase = setupState && setupState.phase;
  setupState = state;
  visionEnabled = Boolean(state.vision);
  $('btn-attach').hidden = !visionEnabled;
  if (!visionEnabled && pendingImages.length) {
    pendingImages = [];
    renderPreview();
  }
  const ready = state.phase === 'ready';
  $('setup-panel').hidden = ready;
  $('chat-area').hidden = !ready;
  renderStatus(state);
  if (!ready) {
    if (state.phase !== 'model-download') speedSample = null;
    renderSetup(state);
    if (abortController) abortController.abort();
  } else if (prevPhase !== 'ready') {
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
    const label = done && msg.thinkEnd ? ar.chat.thought(Math.max(1, Math.round((msg.thinkEnd - msg.thinkStart) / 1000))) : ar.chat.thinking;
    thinking.append(el('summary', { class: done ? '' : 'pulse' }, label));
    if (msg.reasoning) thinking.append(el('div', { class: 'thinking-body', dir: detectDir(msg.reasoning) }, msg.reasoning));
    if (msg.openThinking) thinking.open = true;
    thinking.addEventListener('toggle', () => (msg.openThinking = thinking.open));
    body.append(thinking);
  }

  if (isUser && msg.images && msg.images.length) {
    body.append(el('div', { class: 'msg-images' }, ...msg.images.map((src) => el('img', { src, alt: '' }))));
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
          el('button', { type: 'button', class: 'btn primary', onclick: () => saveEdit(index, box.value) }, ar.chat.saveEdit),
          el('button', { type: 'button', class: 'btn ghost', onclick: () => ((editingIndex = null), renderMessages()) }, ar.chat.cancel),
        ),
      ),
    );
    setTimeout(() => box.focus(), 0);
  } else if (isUser && msg.content) body.append(el('p', { dir: detectDir(msg.content), class: 'plain' }, msg.content));
  if (!isUser && msg.steps && msg.steps.length) {
    body.append(
      el(
        'div',
        { class: 'tool-steps' },
        ...msg.steps.map((st) =>
          el(
            'div',
            { class: `tool-step${st.failed ? ' failed' : ''}`, dir: 'rtl' },
            el('span', { class: 'tool-icon', 'aria-hidden': 'true' }, st.kind === 'search' ? '⌕' : '↗'),
            el('bdi', null, st.kind === 'search' ? ar.chat.stepSearch(st.label) : ar.chat.stepOpen(st.label)),
            st.failed ? el('span', { class: 'muted' }, ` · ${ar.chat.stepFailed}`) : null,
          ),
        ),
      ),
    );
  }
  if (!isUser && msg.content) body.append(renderMarkdown(msg.content, mdLabels));
  if (!isUser && !msg.streaming && msg.sources && msg.sources.length) {
    const seen = new Set();
    const unique = msg.sources.filter((src) => !seen.has(src.url) && seen.add(src.url)).slice(0, 6);
    body.append(
      el(
        'div',
        { class: 'sources' },
        el('span', { class: 'muted small' }, `${ar.chat.sources}:`),
        ...unique.map((src) =>
          el(
            'button',
            { type: 'button', class: 'source', title: src.url, dir: 'auto', onclick: () => window.blazma.openExternal(src.url) },
            src.title || new URL(src.url).hostname,
          ),
        ),
      ),
    );
  }

  if (msg.stopped) body.append(el('p', { class: 'muted small' }, ar.chat.stopped));
  if (msg.error) body.append(el('div', { class: 'msg-error' }, msg.error));

  const footer = el('div', { class: 'msg-footer' });
  if (!msg.streaming) {
    const copy = el('button', { type: 'button', class: 'icon-btn' }, ar.actions.copy);
    copy.addEventListener('click', () =>
      navigator.clipboard.writeText(msg.content).then(() => {
        copy.textContent = ar.actions.copied;
        setTimeout(() => (copy.textContent = ar.actions.copy), 1500);
      }),
    );
    if (msg.content) footer.append(copy);
    if (!abortController) {
      if (isUser) footer.append(el('button', { type: 'button', class: 'icon-btn', onclick: () => startEdit(index) }, ar.chat.edit));
      else if (index === messages.length - 1) footer.append(el('button', { type: 'button', class: 'icon-btn', onclick: regenerate }, ar.chat.regenerate));
    }
    if (msg.timings && msg.timings.predicted_per_second) {
      footer.append(el('span', { class: 'stats', dir: 'rtl' }, ar.chat.speed(msg.timings.predicted_per_second, msg.timings.predicted_n)));
    }
  }

  return el('div', { class: `msg ${isUser ? 'msg-user' : 'msg-ai'}`, 'data-index': index }, body, footer);
}

function renderMessages() {
  const log = $('chat-log');
  if (!messages.length) {
    log.replaceChildren(
      el('div', { class: 'chat-empty' }, el('h2', null, ar.chat.emptyTitle), el('p', { class: 'muted' }, ar.chat.emptyHint)),
    );
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

async function addImages(files) {
  if (!visionEnabled) return;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (pendingImages.length >= MAX_IMAGES) {
      showComposerNote(ar.chat.maxImages);
      break;
    }
    try {
      pendingImages.push(await prepareImage(file));
    } catch {
      showComposerNote(ar.chat.imageFailed);
    }
  }
  renderPreview();
}

function showComposerNote(text) {
  const box = $('attach-preview');
  box.hidden = false;
  box.append(el('span', { class: 'muted small attach-note' }, text));
  setTimeout(renderPreview, 3000);
}

function renderPreview() {
  const box = $('attach-preview');
  box.hidden = pendingImages.length === 0;
  box.replaceChildren(
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
            title: ar.chat.removeImage,
            'aria-label': ar.chat.removeImage,
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

// OpenAI-style content: plain text, or text plus image_url parts.
function apiContent(m) {
  if (!m.images || !m.images.length) return m.content;
  return [{ type: 'text', text: m.content || ar.chat.describeImage }, ...m.images.map((url) => ({ type: 'image_url', image_url: { url } }))];
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

// Runs one tool call and returns the text given back to the model.
async function runTool(call, reply) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {}
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

async function send(text, images = []) {
  if (!messages.length) $('chat-log').replaceChildren();
  messages.push({ role: 'user', content: text, images });
  renderLast();
  await generate();
}

// Generates an assistant reply for the conversation as it is now (its last
// message is the user's), then saves the conversation.
async function generate() {
  const conn = await window.blazma.getConnection();
  if (!conn) return;
  const chatSettings = await window.blazma.getChatSettings();
  const webOn = Boolean(chatSettings.webSearch);
  let system = `${chatSettings.systemPrompt}\n\n${dateContext(webOn)}`;
  if (chatSettings.shareDeviceInfo) {
    const summary = await window.blazma.deviceSummary().catch(() => null);
    if (summary) system += `\n\n${ar.chat.deviceContext(summary)}`;
  }

  const reply = { role: 'assistant', content: '', reasoning: '', streaming: true, thinkStart: Date.now(), steps: [], sources: [] };
  messages.push(reply);
  renderLast();
  setBusy(true);

  // Thinking text and tool traffic are not sent back as history; only the
  // user's messages and the final answers are.
  const history = messages
    .slice(0, -1)
    .filter((m) => !m.error || m.content)
    .map((m) => ({ role: m.role, content: apiContent(m) }));
  const apiMessages = [{ role: 'system', content: system }, ...history];

  abortController = new AbortController();
  try {
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const payload = {
        messages: apiMessages,
        stream: true,
        ...chatSettings.sampling,
        // Gemma 4's template defaults thinking to off, Qwen3.5's to on; always say which.
        chat_template_kwargs: { enable_thinking: chatSettings.thinking },
      };
      // The last round has no tools, so the model must answer with what it found.
      if (webOn && round < MAX_TOOL_ROUNDS) payload.tools = TOOLS;

      const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
        body: JSON.stringify(payload),
        signal: abortController.signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        const type = err && err.error && err.error.type;
        reply.error = type === 'exceed_context_size_error' ? ar.chat.errors.contextFull : ar.chat.errors.generic;
        break;
      }

      const toolCalls = [];
      let roundContent = '';
      for await (const chunk of readSse(res)) {
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
          if (chunk.timings.predicted_per_second) store.lastSpeed = chunk.timings.predicted_per_second;
        }
        renderLast();
      }

      const calls = toolCalls.filter(Boolean);
      if (!calls.length) break;
      calls.forEach((c, i) => {
        if (!c.id) c.id = `call_${round}_${i}`;
      });
      apiMessages.push({ role: 'assistant', content: roundContent, tool_calls: calls });
      for (const call of calls) {
        const result = await runTool(call, reply);
        if (abortController.signal.aborted) throw new DOMException('aborted', 'AbortError');
        apiMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
      renderLast();
    }
  } catch (err) {
    if (err.name === 'AbortError') reply.stopped = true;
    else reply.error = ar.chat.errors.serverGone;
  } finally {
    if (reply.reasoning && !reply.thinkEnd) reply.thinkEnd = Date.now();
    reply.streaming = false;
    abortController = null;
    setBusy(false);
    renderMessages();
    persist();
  }
}

// ---------- regenerate / edit ----------

function regenerate() {
  if (abortController || !messages.length || messages[messages.length - 1].role !== 'assistant') return;
  messages.pop();
  renderMessages();
  generate();
}

function startEdit(index) {
  if (abortController) return;
  editingIndex = index;
  renderMessages();
}

function saveEdit(index, text) {
  const content = text.trim();
  const original = messages[index];
  if (!content && !(original.images && original.images.length)) return;
  editingIndex = null;
  messages = [...messages.slice(0, index), { role: 'user', content, images: original.images || [] }];
  renderMessages();
  generate();
}

// ---------- saved conversations ----------

async function persist() {
  if (!messages.some((m) => m.role === 'user')) return;
  if (!currentChatId) currentChatId = crypto.randomUUID();
  await window.blazma.chatsSave({ id: currentChatId, messages, fallbackTitle: ar.chat.untitled });
  refreshList();
}

function newChat() {
  if (abortController) abortController.abort();
  currentChatId = null;
  editingIndex = null;
  messages = [];
  renderMessages();
  highlightCurrent();
  $('chat-input').focus();
}

async function loadChat(id) {
  if (abortController) return;
  const chat = await window.blazma.chatsGet(id);
  if (!chat) return;
  currentChatId = chat.id;
  editingIndex = null;
  messages = chat.messages;
  renderMessages();
  highlightCurrent();
}

function highlightCurrent() {
  for (const item of document.querySelectorAll('.chat-item')) item.setAttribute('aria-current', String(item.dataset.id === currentChatId));
}

function startRename(item, chat) {
  const input = el('input', { type: 'text', value: chat.title, dir: 'auto', 'aria-label': ar.chat.rename });
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

function renderList(items, query) {
  const box = $('chat-items');
  if (!items.length) {
    box.replaceChildren(el('div', { class: 'chat-list-empty' }, query ? ar.chat.noResults : ar.chat.noChats));
    return;
  }
  box.replaceChildren(
    ...items.map((chat) => {
      const item = el(
        'div',
        { class: 'chat-item', role: 'button', tabindex: '0', 'data-id': chat.id, 'aria-current': String(chat.id === currentChatId) },
        el('span', { class: 'chat-item-title', dir: 'auto' }, chat.title || ar.chat.untitled),
        chat.snippet ? el('span', { class: 'chat-item-snippet', dir: 'auto' }, chat.snippet) : null,
      );
      const actions = el(
        'span',
        { class: 'chat-item-actions' },
        el('button', { type: 'button', title: ar.chat.rename, 'aria-label': ar.chat.rename }, '✎'),
        el('button', { type: 'button', title: ar.chat.remove, 'aria-label': ar.chat.remove }, '🗑'),
      );
      actions.children[0].addEventListener('click', (e) => {
        e.stopPropagation();
        startRename(item, chat);
      });
      actions.children[1].addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!window.confirm(ar.chat.confirmDelete(chat.title || ar.chat.untitled))) return;
        await window.blazma.chatsDelete(chat.id);
        if (chat.id === currentChatId) newChat();
        refreshList();
      });
      item.append(actions);
      item.addEventListener('click', () => loadChat(chat.id));
      item.addEventListener('keydown', (e) => e.key === 'Enter' && loadChat(chat.id));
      return item;
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
  input.placeholder = ar.chat.placeholder;
  input.addEventListener('input', () => autoGrow(input));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('composer').requestSubmit();
    }
  });
  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if ((!text && !pendingImages.length) || abortController) return;
    const images = pendingImages;
    pendingImages = [];
    renderPreview();
    input.value = '';
    autoGrow(input);
    send(text, images);
  });

  // Web search on/off, remembered in settings.
  const webBtn = $('btn-web');
  const showWeb = (on) => {
    webBtn.setAttribute('aria-pressed', String(on));
    webBtn.title = on ? ar.chat.webToggleOn : ar.chat.webToggleOff;
    webBtn.setAttribute('aria-label', webBtn.title);
  };
  window.blazma.getSettings().then((st) => showWeb(st.webSearch));
  webBtn.addEventListener('click', async () => {
    const st = await window.blazma.updateSettings({ webSearch: webBtn.getAttribute('aria-pressed') !== 'true' });
    showWeb(st.webSearch);
  });

  // Images: button, paste, or drag and drop onto the chat.
  $('btn-attach').title = ar.chat.attach;
  $('btn-attach').setAttribute('aria-label', ar.chat.attach);
  $('btn-attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', (e) => {
    addImages([...e.target.files]);
    e.target.value = '';
  });
  input.addEventListener('paste', (e) => {
    const files = [...e.clipboardData.items].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length && visionEnabled) {
      e.preventDefault();
      addImages(files);
    }
  });
  const area = $('chat-area');
  area.addEventListener('dragover', (e) => {
    if (visionEnabled) e.preventDefault();
  });
  area.addEventListener('drop', (e) => {
    if (!visionEnabled) return;
    e.preventDefault();
    addImages([...e.dataTransfer.files]);
  });
  $('btn-stop-gen').addEventListener('click', () => abortController && abortController.abort());
  $('btn-new-chat').addEventListener('click', newChat);
  let searchTimer = null;
  $('chat-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(refreshList, 250);
  });
  refreshList();

  // "أعطِ الذكاء معلومات جهازي": off by default, remembered in settings.
  const devBtn = $('btn-device-info');
  const showDev = (on) => {
    devBtn.setAttribute('aria-pressed', String(on));
    devBtn.title = on ? ar.chat.deviceInfoOn : ar.chat.deviceInfoOff;
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
