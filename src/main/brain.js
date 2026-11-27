'use strict';

// "عقل جهازك": the user's folders (Desktop, Documents, Downloads, Pictures by
// default) are read once and kept up to date, so the chat can find a file by
// what is inside it ("the contract with Ahmed's name", "last month's bill").
// - Names: every file under the folders (name, place, date), in memory and in
//   <userData>/brain/names.json, for find_files.
// - Contents: the folders are library folders (knowledge.js): documents,
//   PDFs and pictures (Windows OCR) are split into passages with meaning
//   vectors, for search_my_files.
// The folders are watched; new and changed files are read when the computer
// has been idle for a minute (not while the user plays or works).

const fs = require('node:fs');
const path = require('node:path');
const { powerMonitor } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const knowledge = require('./knowledge');

const IDLE_SECONDS = 60;
const FULL_EVERY_MS = 6 * 60 * 60 * 1000;
const MAX_NAMES = 300000;

const file = () => path.join(paths.userData(), 'brain', 'names.json');
let names = null; // [path]
let watchers = [];
let dirty = true;
let lastFull = 0;
let timer = null;
let running = null;
let progress = null; // { done, total, file }
let lastError = null;
let onChange = () => {};

function folders() {
  const s = settings.get();
  return (s.brainFolders || []).filter((d) => fs.existsSync(d));
}

function defaultFolders() {
  const a = require('./agent').places();
  return [a.desktop, a.documents, a.downloads, a.pictures].filter(Boolean);
}

function loadNames() {
  try {
    const j = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (Array.isArray(j.names)) names = j.names;
  } catch {
    names = null;
  }
}

function buildNames() {
  const { walk } = require('./agent');
  const list = [];
  for (const d of folders()) for (const p of walk(d, { depth: 10, limit: MAX_NAMES - list.length })) list.push(p);
  names = list;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ at: Date.now(), names }));
}

// Files under these roots, or null when the name index is not built.
function namesUnder(roots) {
  if (!settings.get().brainEnabled || !names) return null;
  const low = roots.map((r) => String(r).toLowerCase().replace(/[\\/]+$/, '') + path.sep);
  const covered = (r) => folders().some((d) => (String(r).toLowerCase() + path.sep).startsWith(d.toLowerCase().replace(/[\\/]+$/, '') + path.sep));
  if (!roots.every(covered)) return null; // a folder outside the brain: walk it instead
  return names.filter((p) => low.some((r) => p.toLowerCase().startsWith(r)));
}

function watch() {
  for (const w of watchers) w.close();
  watchers = [];
  for (const d of folders()) {
    try {
      const w = fs.watch(d, { recursive: true }, (_ev, name) => {
        if (name && /(^|[\\/])(\.|~\$)|\.(tmp|crdownload|part)$/i.test(name)) return;
        dirty = true;
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      /* a folder that cannot be watched is read on the 6-hour pass */
    }
  }
}

async function refresh(force = false) {
  const background = !force;
  if (running) return running;
  running = (async () => {
    try {
      // Library folders: exactly the brain's ones are added (the user's own library folders stay).
      const st = knowledge.status();
      for (const d of folders()) if (!st.folders.includes(path.resolve(d))) knowledge.addFolder(d);
      buildNames();
      dirty = false;
      progress = { done: 0, total: 0, file: null };
      onChange(status());
      await knowledge.update(
        (p) => {
          progress = p;
          onChange(status());
        },
        // In the background: stop as soon as the user is using the computer again.
        { stopWhen: background ? () => powerMonitor.getSystemIdleTime() < 5 : null },
      );
      if (background && powerMonitor.getSystemIdleTime() < 5) dirty = true; // not finished: next idle time
      else lastFull = Date.now();
      lastError = null;
    } catch (err) {
      lastError = err.code || err.message;
      if (force) throw err;
    } finally {
      progress = null;
      running = null;
      knowledge.stop(); // the graphics card memory goes back to the chat model
      onChange(status());
    }
  })();
  return running;
}

function tick() {
  if (!settings.get().brainEnabled || running) return;
  const idle = powerMonitor.getSystemIdleTime();
  if ((dirty || Date.now() - lastFull > FULL_EVERY_MS) && idle >= IDLE_SECONDS) refresh().catch(() => {});
}

function start(notify) {
  if (notify) onChange = notify;
  stop();
  if (!settings.get().brainEnabled) return;
  if (!names) loadNames();
  watch();
  timer = setInterval(tick, 30 * 1000);
}

function stop() {
  clearInterval(timer);
  timer = null;
  for (const w of watchers) w.close();
  watchers = [];
}

// Turned on (with the default folders when none) or off. Off removes the
// brain's folders from the library and forgets the names.
async function enable(on) {
  const s = settings.get();
  if (on) {
    const list = s.brainFolders && s.brainFolders.length ? s.brainFolders : defaultFolders();
    settings.update({ brainEnabled: true, brainFolders: list });
    start();
    refresh().catch(() => {});
  } else {
    stop();
    for (const d of s.brainFolders || []) knowledge.removeFolder(path.resolve(d));
    settings.update({ brainEnabled: false });
    names = null;
    fs.rmSync(file(), { force: true });
  }
  return status();
}

function setFolders(list) {
  const before = settings.get().brainFolders || [];
  const next = [...new Set(list.map((d) => path.resolve(String(d))))].filter((d) => fs.existsSync(d)).slice(0, 20);
  for (const d of before) if (!next.includes(path.resolve(d))) knowledge.removeFolder(path.resolve(d));
  settings.update({ brainFolders: next });
  dirty = true;
  if (settings.get().brainEnabled) {
    start();
    refresh().catch(() => {});
  }
  return status();
}

function status() {
  const s = settings.get();
  const kb = knowledge.status();
  const mine = folders().map((d) => path.resolve(d).toLowerCase());
  const read = knowledge.files().filter((f) => mine.some((d) => f.file.toLowerCase().startsWith(d + path.sep)));
  return {
    enabled: Boolean(s.brainEnabled),
    folders: s.brainFolders || [],
    known: names ? names.length : 0,
    read: read.filter((f) => !f.error).length,
    passages: read.reduce((n, f) => n + f.chunks, 0),
    updatedAt: kb.updatedAt,
    running: Boolean(running),
    progress,
    error: lastError,
  };
}

module.exports = { start, stop, enable, setFolders, status, refresh, names: namesUnder, defaultFolders };
