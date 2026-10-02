'use strict';

// Saved conversations: one JSON file per chat in <userData>/chats. Stays on
// this computer; nothing is sent anywhere.

const fs = require('node:fs');
const path = require('node:path');
const paths = require('./paths');
const { writeJson, readJson } = require('./jsonfile');

const ID_RE = /^[a-z0-9-]{8,64}$/;
const MAX_TITLE = 80;
const MAX_FOLDER = 40;

// A folder name: one line, no control characters, short.
const cleanFolder = (f) => String(f || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_FOLDER);

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
  if (Array.isArray(m.sources) && m.sources.length) out.sources = m.sources.map((s) => ({ title: String(s.title || ''), url: String(s.url || ''), ...(typeof s.file === 'string' && s.file ? { file: s.file } : {}) }));
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
  if (out.role === 'user' && typeof m.command === 'string' && /^[a-z]{1,20}$/.test(m.command)) out.command = m.command;
  if (m.error) out.error = String(m.error);
  if (m.stopped) out.stopped = true;
  if (Array.isArray(m.alts) && m.alts.length > 1 && depth < MAX_BRANCH_DEPTH) {
    out.alts = m.alts.slice(0, MAX_BRANCHES).map((tail) => (Array.isArray(tail) ? tail.slice(0, 500).map((x) => cleanMessage(x, depth + 1)) : []));
    out.altIndex = Math.min(Math.max(0, Number(m.altIndex) || 0), out.alts.length - 1);
  }
  return out;
}

// Title and date of each chat, read again only when its file changed (chat
// files can be large with pictures in them, and the list is asked for after
// every save).
const listCache = new Map(); // file -> { mtimeMs, size, meta }

function list() {
  let files = [];
  try {
    files = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const file = path.join(dir(), f);
    const st = fs.statSync(file, { throwIfNoEntry: false });
    if (!st) continue;
    let hit = listCache.get(file);
    if (!hit || hit.mtimeMs !== st.mtimeMs || hit.size !== st.size) {
      const c = readJson(file, null);
      hit = { mtimeMs: st.mtimeMs, size: st.size, meta: c && ID_RE.test(c.id) ? { id: c.id, title: c.title, updatedAt: c.updatedAt, pinned: Boolean(c.pinned), folder: cleanFolder(c.folder) } : null };
      listCache.set(file, hit);
    }
    if (hit.meta) out.push(hit.meta);
  }
  for (const file of listCache.keys()) if (!files.includes(path.basename(file))) listCache.delete(file);
  // Pinned chats first, then the newest.
  return out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
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
  // Pin and folder are set from the list (setMeta), and kept when the chat is saved.
  if (existing && existing.pinned) data.pinned = true;
  if (existing && cleanFolder(existing.folder)) data.folder = cleanFolder(existing.folder);
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

// Pin / unpin, or move to a folder ('' = no folder). The date is kept, so the
// chat does not jump to the top of "today".
function setMeta(id, { pinned, folder } = {}) {
  const chat = get(id);
  if (!chat) return null;
  if (pinned !== undefined) {
    if (pinned) chat.pinned = true;
    else delete chat.pinned;
  }
  if (folder !== undefined) {
    const f = cleanFolder(folder);
    if (f) chat.folder = f;
    else delete chat.folder;
  }
  writeJson(fileFor(id), chat);
  return { id, pinned: Boolean(chat.pinned), folder: chat.folder || '' };
}

// Every chat in one file, for a backup or another computer.
function exportAll() {
  const chats = list()
    .map((m) => get(m.id))
    .filter(Boolean);
  return { app: 'Blazma AI', kind: 'chats-backup', version: 1, exportedAt: Date.now(), chats };
}

// Chats from a backup file. Each one is cleaned like a saved chat; a chat
// that is already here is replaced only by a newer copy.
function importAll(data) {
  if (!data || data.kind !== 'chats-backup' || !Array.isArray(data.chats)) throw new Error('not a Blazma chats backup');
  const res = { added: 0, updated: 0, skipped: 0 };
  for (const c of data.chats.slice(0, 20000)) {
    if (!c || !ID_RE.test(String(c.id)) || !Array.isArray(c.messages)) {
      res.skipped++;
      continue;
    }
    const existing = get(c.id);
    const updatedAt = Number(c.updatedAt) || Date.now();
    if (existing && (Number(existing.updatedAt) || 0) >= updatedAt) {
      res.skipped++;
      continue;
    }
    const messages = c.messages.slice(0, 5000).map((m) => cleanMessage(m || {}));
    const out = {
      id: c.id,
      title: String(c.title || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE) || require('./i18n').t('untitled'),
      createdAt: Number(c.createdAt) || updatedAt,
      updatedAt,
      personaId: typeof c.personaId === 'string' && /^[a-z0-9-]{1,64}$/.test(c.personaId) ? c.personaId : undefined,
      messages,
    };
    if (c.pinned) out.pinned = true;
    if (cleanFolder(c.folder)) out.folder = cleanFolder(c.folder);
    writeJson(fileFor(c.id), out);
    res[existing ? 'updated' : 'added']++;
  }
  return res;
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

module.exports = { list, get, save, rename, remove, search, setMeta, exportAll, importAll };
