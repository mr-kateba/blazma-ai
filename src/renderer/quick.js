// The quick assistant window (src/main/quick.js): the text selected in
// another app, five one-click actions, a free question, and the answer
// streamed from the local model.

import { ui, LANG, DIR } from './i18n/index.js';
import { renderMarkdown } from './lib/markdown.js';
import { readSse } from './lib/sse.js';
import { visibleText } from './lib/toolcalls.js';

const Q = ui.v2.quick;
const $ = (id) => document.getElementById(id);
document.documentElement.lang = LANG;
document.documentElement.dir = DIR;
document.title = Q.winTitle;
$('q-title').textContent = Q.title;
$('q-input').placeholder = Q.inputPh;
$('q-copy').textContent = Q.copy;
$('q-chat').textContent = Q.openChat;

let selected = '';
let answer = '';
let lastPrompt = '';
let controller = null;
const md = { copy: ui.actions.copy, copied: ui.actions.copied, code: ui.chat.code };

window.blazma.getTheme().then(({ dark }) => (document.documentElement.dataset.theme = dark ? 'dark' : 'light'));

function showContext(ctx) {
  if (controller) controller.abort();
  selected = (ctx && ctx.text) || '';
  answer = '';
  $('q-answer').replaceChildren();
  $('q-copy').hidden = $('q-chat').hidden = true;
  const box = $('q-selected');
  if (selected) {
    const t = document.createElement('div');
    t.className = 'q-sel-text';
    t.dir = 'auto';
    t.textContent = selected.length > 600 ? `${selected.slice(0, 600)}…` : selected;
    const label = document.createElement('span');
    label.className = 'muted small';
    label.textContent = Q.selected;
    box.replaceChildren(label, t);
  } else {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.textContent = Q.noText;
    box.replaceChildren(p);
  }
  $('q-actions').hidden = !selected;
  $('q-input').value = '';
  setTimeout(() => $('q-input').focus(), 30);
}

for (const [id, [label, instruction]] of Object.entries(Q.actions)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.dataset.action = id;
  b.addEventListener('click', () => ask(`${instruction}\n\n${selected}`));
  $('q-actions').append(b);
}

async function ask(prompt) {
  if (controller) controller.abort();
  controller = new AbortController();
  const signal = controller.signal;
  lastPrompt = prompt;
  answer = '';
  const out = $('q-answer');
  out.replaceChildren();
  const conn = await window.blazma.getConnection();
  if (!conn) {
    out.textContent = Q.notReady;
    return;
  }
  out.classList.add('pulse');
  const cs = await window.blazma.getChatSettings();
  let system = cs.systemPrompt;
  if (cs.memoryEnabled && cs.memory && cs.memory.length) system += `\n\n${ui.v2.memory.context(cs.memory.map((m) => `- ${m.text}`).join('\n'))}`;
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], stream: true, ...cs.sampling, chat_template_kwargs: { enable_thinking: false } }),
      signal,
    });
    for await (const chunk of readSse(res)) {
      const d = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
      if (d && d.content) {
        answer += d.content;
        out.classList.remove('pulse');
        out.replaceChildren(renderMarkdown(visibleText(answer), md));
        out.dir = 'auto';
        out.scrollTop = out.scrollHeight;
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') out.textContent = ui.chat.errors.generic;
  } finally {
    out.classList.remove('pulse');
    $('q-copy').hidden = $('q-chat').hidden = !answer;
  }
}

$('q-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = $('q-input').value.trim();
  if (!q) return;
  ask(selected ? `${q}\n\n«${selected}»` : q);
});
$('q-copy').addEventListener('click', () =>
  navigator.clipboard.writeText(answer).then(() => {
    $('q-copy').textContent = Q.copied;
    setTimeout(() => ($('q-copy').textContent = Q.copy), 1500);
  }),
);
$('q-chat').addEventListener('click', () => window.blazma.quickToChat(lastPrompt));
$('q-close').addEventListener('click', () => window.blazma.quickHide());
document.addEventListener('keydown', (e) => e.key === 'Escape' && window.blazma.quickHide());
window.blazma.onQuickContext(showContext);
window.blazma.quickContext().then(showContext);
