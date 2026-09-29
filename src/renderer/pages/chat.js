// Chat page: setup/progress panel until the local server is ready, then a
// streaming chat against http://127.0.0.1:<port>/v1/chat/completions.

import { ar, errorText, formatBytes, formatDuration } from '../i18n/ar.js';
import { el, detectDir } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { readSse } from '../lib/sse.js';

const mdLabels = { copy: ar.actions.copy, copied: ar.actions.copied, code: ar.chat.code };

const $ = (id) => document.getElementById(id);

let setupState = null;
let selectedModelId = null;
let messages = []; // { role, content, reasoning?, timings?, error?, stopped?, thinkStart?, thinkEnd? }
let abortController = null;
let speedSample = null; // for download speed: { t, done }
let speed = 0;

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

  if (isUser) body.append(el('p', { dir: detectDir(msg.content), class: 'plain' }, msg.content));
  else if (msg.content) body.append(renderMarkdown(msg.content, mdLabels));

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
}

async function send(text) {
  const conn = await window.blazma.getConnection();
  if (!conn) return;
  const chatSettings = await window.blazma.getChatSettings();

  if (!messages.length) $('chat-log').replaceChildren();
  messages.push({ role: 'user', content: text });
  renderLast();
  const reply = { role: 'assistant', content: '', reasoning: '', streaming: true, thinkStart: Date.now() };
  messages.push(reply);
  renderLast();
  setBusy(true);

  // Thinking text is not sent back as history; only final answers are.
  const history = messages
    .slice(0, -1)
    .filter((m) => !m.error || m.content)
    .map((m) => ({ role: m.role, content: m.content }));
  const payload = {
    messages: [{ role: 'system', content: chatSettings.systemPrompt }, ...history],
    stream: true,
    ...chatSettings.sampling,
    // Gemma 4's template defaults thinking to off, Qwen3.5's to on; always say which.
    chat_template_kwargs: { enable_thinking: chatSettings.thinking },
  };

  abortController = new AbortController();
  try {
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
    } else {
      for await (const chunk of readSse(res)) {
        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
        if (delta) {
          if (delta.reasoning_content) reply.reasoning += delta.reasoning_content;
          if (delta.content) {
            if (!reply.content && reply.reasoning) reply.thinkEnd = Date.now();
            reply.content += delta.content;
          }
        }
        if (chunk.timings) reply.timings = chunk.timings;
        renderLast();
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') reply.stopped = true;
    else reply.error = ar.chat.errors.serverGone;
  } finally {
    if (reply.reasoning && !reply.thinkEnd) reply.thinkEnd = Date.now();
    reply.streaming = false;
    abortController = null;
    setBusy(false);
    renderLast();
  }
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
    if (!text || abortController) return;
    input.value = '';
    autoGrow(input);
    send(text);
  });
  $('btn-stop-gen').addEventListener('click', () => abortController && abortController.abort());
  $('btn-new-chat').addEventListener('click', () => {
    messages = [];
    renderMessages();
    input.focus();
  });
  $('btn-stop-server').addEventListener('click', () => window.blazma.stopServer());

  window.blazma.onSetupState(onState);
  window.blazma.getSetupState().then(onState);
}
