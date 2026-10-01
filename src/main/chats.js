'use strict';

// Saved conversations: one JSON file per chat in <userData>/chats. Stays on
// this computer; nothing is sent anywhere.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { writeJson, readJson } = require('./jsonfile');

const ID_RE = /^[a-z0-9-]{8,64}$/;
const MAX_TITLE = 80;

const dir = () => path.join(paths.userData(), 'chats');
const fileFor = (id) => {
  if (!ID_RE.test(String(id))) throw new Error('bad chat id');
  return path.join(dir(), `${id}.json`);
};

const MAX_BRANCHES = 20;
const MAX_BRANCH_DEPTH = 4;

// Only the fields the chat page renders are kept. Branches (earlier versions
// of the conversation from this message on) are cleaned the same way.
function cleanMessage(m, depth = 0) {
  const out = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
  if (Array.isArray(m.images) && m.images.length) out.images = m.images.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 4);
  if (m.reasoning) out.reasoning = String(m.reasoning);
  if (m.thinkStart && m.thinkEnd) Object.assign(out, { thinkStart: m.thinkStart, thinkEnd: m.thinkEnd });
  if (m.timings) out.timings = { predicted_per_second: m.timings.predicted_per_second, predicted_n: m.timings.predicted_n };
  if (Array.isArray(m.steps) && m.steps.length) out.steps = m.steps.map((s) => ({ kind: s.kind, label: String(s.label || ''), failed: Boolean(s.failed) }));
  if (Array.isArray(m.sources) && m.sources.length) out.sources = m.sources.map((s) => ({ title: String(s.title || ''), url: String(s.url || '') }));
  // Attached files keep their extracted text, so a reopened chat still has them.
  if (Array.isArray(m.files) && m.files.length) {
    out.files = m.files.slice(0, 5).map((f) => ({
      name: String(f.name || '').slice(0, 200),
      kind: ['pdf', 'docx', 'text'].includes(f.kind) ? f.kind : 'text',
      text: String(f.text || '').slice(0, 400000),
      chars: Number(f.chars) || 0,
      pages: Number(f.pages) || null,
    }));
  }
  if (typeof m.imagePrompt === 'string') out.imagePrompt = m.imagePrompt.slice(0, 2000);
  if (m.error) out.error = String(m.error);
  if (m.stopped) out.stopped = true;
  if (Array.isArray(m.alts) && m.alts.length > 1 && depth < MAX_BRANCH_DEPTH) {
    out.alts = m.alts.slice(0, MAX_BRANCHES).map((tail) => (Array.isArray(tail) ? tail.slice(0, 500).map((x) => cleanMessage(x, depth + 1)) : []));
    out.altIndex = Math.min(Math.max(0, Number(m.altIndex) || 0), out.alts.length - 1);
  }
  return out;
}

function list() {
  let files = [];
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return files
    .map((f) => readJson(path.join(dir(), f), null))
    .filter((c) => c && ID_RE.test(c.id))
    .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

function get(id) {
  return readJson(fileFor(id), null);
}

function save(chat) {
  const now = Date.now();
  const existing = get(chat.id);
  const messages = (chat.messages || []).map((m) => cleanMessage(m));
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  const title =
    (existing && existing.title) ||
    (firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '') ||
    (messages.find((m) => m.files && m.files.length) || { files: [{ name: '' }] }).files[0].name.slice(0, MAX_TITLE) ||
    String(chat.fallbackTitle || '').slice(0, MAX_TITLE);
  const personaId = typeof chat.personaId === 'string' && /^[a-z0-9-]{1,64}$/.test(chat.personaId) ? chat.personaId : undefined;
  const data = { id: chat.id, title, createdAt: (existing && existing.createdAt) || now, updatedAt: now, personaId, messages };
  writeJson(fileFor(chat.id), data);
  return { id: data.id, title: data.title, updatedAt: data.updatedAt };
}

function rename(id, title) {
  const chat = get(id);
  if (!chat) return null;
  chat.title = String(title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || chat.title;
  writeJson(fileFor(id), chat);
  return { id, title: chat.title };
}

function remove(id) {
  fs.rmSync(fileFor(id), { force: true });
  return true;
}

// Case-insensitive search in titles and message text; returns matching chats
// with a short snippet around the first hit.
function search(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return list();
  const out = [];
  for (const meta of list()) {
    const chat = get(meta.id);
    if (!chat) continue;
    if (chat.title.toLowerCase().includes(q)) {
      out.push({ ...meta, snippet: '' });
      continue;
    }
    for (const m of chat.messages) {
      const i = m.content.toLowerCase().indexOf(q);
      if (i !== -1) {
        out.push({ ...meta, snippet: m.content.slice(Math.max(0, i - 30), i + q.length + 50).replace(/\s+/g, ' ') });
        break;
      }
    }
  }
  return out;
}

module.exports = { list, get, save, rename, remove, search };
