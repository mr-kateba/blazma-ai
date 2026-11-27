// The quick assistant window (src/main/quick.js): the text selected in
// another app, five one-click actions, a free question, and the answer
// streamed from the local model.

import { ui, LANG, DIR } from './i18n/index.js';
import { renderMarkdown } from './lib/markdown.js';
import { readSse } from './lib/sse.js';
import { visibleText, extractTextToolCalls } from './lib/toolcalls.js';
import { speak, stopSpeaking } from './lib/speech.js';
import { BRAIN_TOOLS, AGENT_TOOLS } from './lib/agenttools.js';

const Q = ui.v2.quick;
const $ = (id) => document.getElementById(id);
document.documentElement.lang = LANG;
document.documentElement.dir = DIR;
document.title = Q.winTitle;
$('q-title').textContent = Q.title;
$('q-input').placeholder = Q.inputPh;
$('q-copy').textContent = Q.copy;
$('q-chat').textContent = Q.openChat;
$('q-replace').textContent = Q.replace;
$('q-replace').title = Q.replaceTitle;

let selected = '';
let image = ''; // a picture of the screen (data URL), from the screen shortcut
let answer = '';
let lastPrompt = '';
let controller = null;
const md = { copy: ui.actions.copy, copied: ui.actions.copied, code: ui.chat.code };

window.blazma.getTheme().then(({ dark }) => (document.documentElement.dataset.theme = dark ? 'dark' : 'light'));

function showContext(ctx) {
  if (controller) controller.abort();
  if (ctx && ctx.voice) return showVoice(ctx.voice);
  voiceMode = false;
  stopSpeaking();
  selected = (ctx && ctx.text) || '';
  image = (ctx && ctx.image) || '';
  answer = '';
  $('q-answer').replaceChildren();
  $('q-copy').hidden = $('q-chat').hidden = $('q-replace').hidden = true;
  const box = $('q-selected');
  $('q-input').placeholder = image ? Q.screenPh : Q.inputPh;
  if (image) {
    const label = document.createElement('span');
    label.className = 'muted small';
    label.textContent = Q.screen;
    const pic = document.createElement('img');
    pic.className = 'q-shot';
    pic.src = image;
    pic.alt = Q.screen;
    box.replaceChildren(label, pic);
  } else if (selected) {
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
  $('q-screen-actions').hidden = !image;
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
for (const [id, [label, instruction]] of Object.entries(Q.screenActions)) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'chip';
  b.textContent = label;
  b.dataset.screenAction = id;
  b.addEventListener('click', () => ask(instruction));
  $('q-screen-actions').append(b);
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
  // A screen picture needs a model that sees pictures.
  if (image) {
    const st = await window.blazma.getSetupState();
    if (!st || !st.vision) {
      out.textContent = Q.noVision;
      return;
    }
  }
  out.classList.add('pulse');
  const cs = await window.blazma.getChatSettings();
  const user = image ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: image } }] : prompt;
  let system = cs.systemPrompt;
  if (cs.memoryEnabled && cs.memory && cs.memory.length) system += `\n\n${ui.v2.memory.context(cs.memory.map((m) => `- ${m.text}`).join('\n'))}`;
  try {
    const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({ messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: true, ...cs.sampling, chat_template_kwargs: { enable_thinking: false } }),
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
    $('q-copy').hidden = !answer;
    // A screen picture cannot go to the chat as text, and only a selection can be replaced.
    $('q-chat').hidden = !answer || Boolean(image);
    $('q-replace').hidden = !answer || !selected;
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
$('q-replace').addEventListener('click', () => {
  const text = visibleText(answer).trim();
  if (text) window.blazma.quickReplace(text);
});
$('q-close').addEventListener('click', () => {
  stopSpeaking();
  if (voiceMode) window.blazma.wakeSpoken();
  window.blazma.quickHide();
});

// ---------- "يا بلازما": a spoken request (main/wake.js) ----------

let voiceMode = false;
let hideTimer = null;
const VOICE_TOOLS = new Set(['open_app', 'open', 'find_files', 'search_my_files']);

// "افتح بريف" / "شغّل ستيم" / "open Steam": opened at once, without the model
// (the model sometimes answered "I opened it" without opening anything).
const OPEN_RE = /^(?:(?:يا|طيب|لو سمحت|please)\s+)?(?:افتح|إفتح|أفتح|فتح|افتحلي|شغل|شغّل|شغلي|شغّلي|ابدأ|ابدا|open|launch|start|run)\s+(?:لي\s+|ليا\s+|me\s+|up\s+)?(.{2,60}?)\s*[.؟?!،]*$/i;
const FOLDER_WORDS = /^(?:مجلد\s+|فولدر\s+|folder\s+|my\s+)?(التنزيلات|التحميلات|المستندات|سطح المكتب|الصور|الفيديو|الموسيقى|downloads|documents|desktop|pictures|videos|music)(?:\s+folder)?$/i;
function openIntent(text) {
  const m = OPEN_RE.exec(String(text || '').replace(/[\u064B-\u065F]/g, '').trim());
  if (!m) return null;
  const what = m[1].trim();
  if (/ملف|file|صورة|picture|رابط|موقع|site|http/i.test(what)) return null; // needs a search first
  const folder = FOLDER_WORDS.exec(what);
  return folder ? { tool: 'open', args: { path: folder[1] }, label: what } : { tool: 'open_app', args: { name: what }, label: what };
}

function showVoice(heard) {
  voiceMode = true;
  clearTimeout(hideTimer);
  stopSpeaking();
  selected = '';
  image = '';
  answer = '';
  const V = ui.v2.wake;
  const label = document.createElement('span');
  label.className = 'muted small';
  label.textContent = V.heard;
  const t = document.createElement('div');
  t.className = 'q-sel-text';
  t.dir = 'auto';
  t.textContent = heard;
  $('q-selected').replaceChildren(label, t);
  $('q-actions').hidden = $('q-screen-actions').hidden = true;
  $('q-copy').hidden = $('q-chat').hidden = $('q-replace').hidden = true;
  $('q-input').value = '';
  voiceAnswer(heard);
}

async function voiceAnswer(heard) {
  const V = ui.v2.wake;
  controller = new AbortController();
  const signal = controller.signal;
  lastPrompt = heard;
  const out = $('q-answer');
  out.replaceChildren();
  out.classList.add('pulse');
  const done = () => {
    out.classList.remove('pulse');
    $('q-copy').hidden = !answer;
    $('q-chat').hidden = !answer;
  };
  const conn = await window.blazma.getConnection();
  if (!conn) {
    out.textContent = Q.notReady;
    done();
    return finishVoice(Q.notReady);
  }
  const [cs, st] = await Promise.all([window.blazma.getChatSettings(), window.blazma.getSettings()]);
  const places = await window.blazma.agentPlaces();
  const tools = [...BRAIN_TOOLS, ...AGENT_TOOLS].filter((t) => VOICE_TOOLS.has(t.function.name) && (t.function.name !== 'search_my_files' || st.brainEnabled));
  if (cs.webSearch) tools.push({ type: 'function', function: { name: 'web_search', description: 'Search the internet for anything recent or that you do not know.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } });
  const where = Object.entries(places)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  const now = new Date();
  const off = -now.getTimezoneOffset();
  const zone = `UTC${off >= 0 ? '+' : '-'}${String(Math.floor(Math.abs(off) / 60)).padStart(2, '0')}:${String(Math.abs(off) % 60).padStart(2, '0')}`;
  // The UTC time too, so "what time is it in London" can be worked out without the web.
  const clock = `${now.toLocaleString(LANG === 'en' ? 'en' : 'ar')} (${zone}; UTC now ${now.toISOString().slice(11, 16)})`;
  let system = `${cs.systemPrompt}\n\n${V.system(clock, where)}`;
  if (cs.memoryEnabled && cs.memory && cs.memory.length) system += `\n\n${ui.v2.memory.context(cs.memory.map((m) => `- ${m.text}`).join('\n'))}`;
  const msgs = [
    { role: 'system', content: system },
    { role: 'user', content: heard },
  ];
  const direct = openIntent(heard);
  if (direct) {
    out.textContent = ui.v2.agent.step[direct.tool](direct.args);
    const r = await window.blazma.agentRead(direct.tool, direct.args).catch(() => ({ ok: false }));
    if (r.ok && r.result.opened) {
      answer = V.opened(r.result.app || direct.label);
      done();
      out.textContent = answer;
      return finishVoice(answer);
    }
    // A program that is not installed: said at once (the model tends to loop here).
    if (r.ok && r.result.error === 'not found' && direct.tool === 'open_app') {
      answer = V.notInstalled(direct.label.replace(/^(?:ال)?(?:متصفح|برنامج|تطبيق|لعبة)\s+/, ''));
      done();
      out.textContent = answer;
      return finishVoice(answer);
    }
  }
  const said = []; // text written next to tool calls (the start of the answer)
  let think = false;
  try {
    for (let round = 0; round < 5; round++) {
      const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
        // The model's own sampling (Gemma 4: temperature 1, top_k 64): at a low
        // temperature with tools it repeats an empty "thought" forever.
        // stop: two empty thought blocks in a row never happen in a real answer.
        // A loop like that is retried once with thinking on.
        body: JSON.stringify({ messages: msgs, temperature: 0.7, ...cs.sampling, max_tokens: think ? 1200 : 400, stop: ['<channel|><|channel>'], chat_template_kwargs: { enable_thinking: think }, ...(round < 4 ? { tools } : {}) }),
        signal,
      });
      const j = await res.json();
      const m = (j.choices && j.choices[0] && j.choices[0].message) || {};
      let calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      let content = String(m.content || '').replace(/<\|channel>thought\s*(?:<channel\|>)?/g, '');
      if (!calls.length) {
        const leaked = extractTextToolCalls(content);
        content = leaked.content;
        calls = leaked.calls.map((c, i) => ({ id: `v${round}_${i}`, type: 'function', function: c }));
      }
      if (!calls.length && !visibleText(content).trim() && !think) {
        think = true;
        round--;
        continue;
      }
      if (!calls.length) {
        answer = [...said, visibleText(content).trim()].filter(Boolean).join(' ');
        break;
      }
      // Text next to a call is kept (an answer can start before a tool), but
      // not "I will search now…".
      const before = visibleText(content).trim();
      if (before && !/^(سأ|سوف|لحظة|جاري|دعني|حسناً،? سأ|I will|I'll|Let me|One moment)/i.test(before)) said.push(before);
      msgs.push({ role: 'assistant', content, tool_calls: calls });
      for (const c of calls) {
        let args = {};
        try {
          args = JSON.parse(c.function.arguments || '{}');
        } catch {}
        const name = c.function.name;
        out.textContent = ui.v2.agent.step[name] ? ui.v2.agent.step[name](args) : name === 'web_search' ? ui.chat.stepSearch(args.query || '') : '…';
        let result = 'Unknown tool.';
        if (name === 'web_search') {
          const r = await window.blazma.webSearch(String(args.query || ''));
          result = r.ok ? r.result.results.slice(0, 5).map((x, i) => `${i + 1}. ${x.title}\n${x.snippet}`).join('\n\n') : 'The search failed.';
        } else if (name === 'search_my_files') {
          const r = await window.blazma.kbSearch(String(args.question || ''), null);
          result = r.ok && r.result.length ? r.result.map((p, i) => `[${i + 1}] ${p.file}\n${p.text}`).join('\n\n').slice(0, 8000) : 'Nothing found.';
        } else if (VOICE_TOOLS.has(name)) {
          const r = await window.blazma.agentRead(name, args);
          result = r.ok ? JSON.stringify(r.result).slice(0, 8000) : `Failed: ${r.error.code}`;
        }
        msgs.push({ role: 'tool', tool_call_id: c.id || `v${round}`, content: result });
      }
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    answer = '';
  }
  done();
  if (!answer) {
    out.textContent = ui.chat.errors.generic;
    return finishVoice('');
  }
  out.replaceChildren(renderMarkdown(answer, md));
  out.dir = 'auto';
  finishVoice(answer);
}

// Says the answer, then lets the wake word listen again and hides the window.
async function finishVoice(text) {
  const resume = () => {
    window.blazma.wakeSpoken();
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (voiceMode && !document.hasFocus()) window.blazma.quickHide();
    }, 9000);
  };
  if (!text) return resume();
  const tag = document.createElement('span');
  tag.addEventListener('speech-end', resume, { once: true });
  tag.addEventListener('speech-error', resume, { once: true });
  const res = await speak(text, tag).catch(() => ({ ok: false }));
  if (!res.ok) resume();
}

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  stopSpeaking();
  if (voiceMode) window.blazma.wakeSpoken();
  window.blazma.quickHide();
});
window.blazma.onQuickContext(showContext);
window.blazma.quickContext().then(showContext);
