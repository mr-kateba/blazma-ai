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

// Only the fields the chat page renders are kept.
function cleanMessage(m) {
  const out = { role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') };
  if (Array.isArray(m.images) && m.images.length) out.images = m.images.filter((s) => typeof s === 'string' && s.startsWith('data:image/')).slice(0, 4);
  if (m.reasoning) out.reasoning = String(m.reasoning);
  if (m.thinkStart && m.thinkEnd) Object.assign(out, { thinkStart: m.thinkStart, thinkEnd: m.thinkEnd });
  if (m.timings) out.timings = { predicted_per_second: m.timings.predicted_per_second, predicted_n: m.timings.predicted_n };
  if (Array.isArray(m.steps) && m.steps.length) out.steps = m.steps.map((s) => ({ kind: s.kind, label: String(s.label || ''), failed: Boolean(s.failed) }));
  if (Array.isArray(m.sources) && m.sources.length) out.sources = m.sources.map((s) => ({ title: String(s.title || ''), url: String(s.url || '') }));
  if (m.error) out.error = String(m.error);
  if (m.stopped) out.stopped = true;
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
  const messages = (chat.messages || []).map(cleanMessage);
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  const title =
    (existing && existing.title) ||
    (firstUser ? firstUser.content.replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) : '') ||
    String(chat.fallbackTitle || '').slice(0, MAX_TITLE);
  const data = { id: chat.id, title, createdAt: (existing && existing.createdAt) || now, updatedAt: now, messages };
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
