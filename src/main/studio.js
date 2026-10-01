'use strict';

// "الاستوديو": small code projects kept in <userData>/studio, and the
// preview that runs them. Preview files are served from memory over the
// studio:// scheme into a sandboxed iframe whose CSP blocks all network
// access; the code never touches the user's files or the rest of the app.

const fs = require('node:fs');
const path = require('node:path');
const { dialog } = require('electron');
const paths = require('./paths');
const { writeJson, readJson } = require('./jsonfile');
const { AppError } = require('./errors');

const ID_RE = /^[a-z0-9-]{8,64}$/;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 1024 * 1024;

const dir = () => path.join(paths.userData(), 'studio');
const fileFor = (id) => {
  if (!ID_RE.test(String(id))) throw new AppError('studio-bad-id');
  return path.join(dir(), `${id}.json`);
};

// Project file names: relative, forward slashes, no "..", no drive letters.
function cleanPath(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/^\.?\/+/, '').trim();
  if (!s || s.length > 200 || s.split('/').some((part) => !part || part === '.' || part === '..') || /^[a-z]:/i.test(s)) {
    throw new AppError('studio-bad-path', s);
  }
  return s;
}

function cleanFiles(files) {
  const out = {};
  const entries = Object.entries(files || {});
  if (entries.length > MAX_FILES) throw new AppError('studio-too-many');
  for (const [p, content] of entries) {
    const text = String(content ?? '');
    if (Buffer.byteLength(text, 'utf8') > MAX_FILE_BYTES) throw new AppError('studio-too-big', p);
    out[cleanPath(p)] = text;
  }
  return out;
}

function list() {
  let names = [];
  try {
    names = fs.readdirSync(dir()).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }
  return names
    .map((f) => readJson(path.join(dir(), f), null))
    .filter((p) => p && ID_RE.test(p.id))
    .map((p) => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

const get = (id) => readJson(fileFor(id), null);

function save(project) {
  const data = {
    id: project.id,
    name: String(project.name || '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'مشروع',
    files: cleanFiles(project.files),
    updatedAt: Date.now(),
  };
  writeJson(fileFor(data.id), data);
  return { id: data.id, name: data.name, updatedAt: data.updatedAt };
}

function remove(id) {
  fs.rmSync(fileFor(id), { force: true });
  return true;
}

// User-initiated: writes the project into a folder the user picks.
async function exportProject(win, id) {
  const project = get(id);
  if (!project) throw new AppError('studio-not-found');
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'اختر مكان حفظ المشروع',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (canceled || !filePaths[0]) return { saved: false };
  const safeName = project.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() || 'project';
  const base = path.join(filePaths[0], safeName);
  for (const [rel, content] of Object.entries(project.files)) {
    const full = path.join(base, ...cleanPath(rel).split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return { saved: true };
}

// User-initiated: copies the text files of a folder the user picks into a
// new project (like "Open Folder"). Read-only; the folder is not changed.
// Hidden entries, node_modules and symbolic links are skipped.
const IMPORT_EXT = /\.(html?|css|m?js|json|md|txt|svg|xml|csv|py)$/i;
const IMPORT_NAME = /^[A-Za-z0-9_\-./]{1,200}$/;
const IMPORT_TOTAL_BYTES = 8 * 1024 * 1024;

async function importFolder(win) {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: 'اختر مجلد المشروع',
    properties: ['openDirectory'],
  });
  if (canceled || !filePaths[0]) return { opened: false };
  const rootDir = filePaths[0];
  const files = {};
  let total = 0;
  let skipped = 0;
  const walk = (dir, rel, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (depth < 6) walk(full, relPath, depth + 1);
        continue;
      }
      if (!ent.isFile() || !IMPORT_EXT.test(ent.name) || !IMPORT_NAME.test(relPath)) {
        skipped++;
        continue;
      }
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        skipped++;
        continue;
      }
      if (Object.keys(files).length >= MAX_FILES || size > MAX_FILE_BYTES || total + size > IMPORT_TOTAL_BYTES) {
        skipped++;
        continue;
      }
      files[cleanPath(relPath)] = fs.readFileSync(full, 'utf8');
      total += size;
    }
  };
  walk(rootDir, '', 0);
  return { opened: true, name: path.basename(rootDir).slice(0, 60), files, skipped };
}

// ---------- preview ----------

let previewFiles = {};

function setPreview(files) {
  previewFiles = cleanFiles(files);
  return true;
}

// Runs inside the preview. Forwards console output and errors (with file and
// line) to the studio page, and evaluates expressions the studio terminal
// sends ("js ..."), which is no more than the preview's own code can do.
const CONSOLE_BRIDGE = `(() => {
  const fmt = (a) => {
    if (typeof a === 'string') return a;
    if (a === undefined) return 'undefined';
    if (typeof a === 'function') return String(a);
    if (a instanceof Error) return a.name + ': ' + a.message;
    if (typeof Node !== 'undefined' && a instanceof Node) return a.outerHTML || a.nodeName;
    try { const s = JSON.stringify(a); return s === undefined ? String(a) : s; } catch { return String(a); }
  };
  const send = (level, args, where) => { try { parent.postMessage(Object.assign({ blazma: 'console', level, text: args.map(fmt).join(' ') }, where || {}), 'app://blazma'); } catch {} };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = (...a) => { send(level === 'debug' ? 'log' : level, a); orig.apply(console, a); };
  }
  const fileOf = (u) => String(u || '').replace(/^studio:\\/\\/preview\\//, '').split('?')[0];
  addEventListener('error', (e) => send('error', [e.message], { file: fileOf(e.filename), line: e.lineno || 0, col: e.colno || 0 }));
  addEventListener('unhandledrejection', (e) => send('error', [e.reason instanceof Error ? e.reason.name + ': ' + e.reason.message : String(e.reason)]));
  addEventListener('message', (e) => {
    if (e.source !== parent || !e.data || e.data.blazma !== 'eval') return;
    const reply = (ok, v) => parent.postMessage({ blazma: 'eval-result', id: e.data.id, ok, text: fmt(v) }, 'app://blazma');
    let value;
    try { value = (0, eval)(String(e.data.code)); } catch (err) { return reply(false, err); }
    Promise.resolve(value).then((v) => reply(true, v), (err) => reply(false, err));
  });
})();`;

const BRIDGE_TAG = '<script src="/__blazma__/console.js"></script>';

function withBridge(html) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${BRIDGE_TAG}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${BRIDGE_TAG}</head>`);
  return `${BRIDGE_TAG}${html}`;
}

// The page shown for a project: index.html if present, otherwise a wrapper
// that loads the project's CSS and JavaScript files.
function entryHtml() {
  if (previewFiles['index.html'] !== undefined) return withBridge(previewFiles['index.html']);
  const css = Object.keys(previewFiles).filter((p) => p.endsWith('.css'));
  const js = Object.keys(previewFiles).filter((p) => p.endsWith('.js'));
  return withBridge(
    `<!doctype html><html><head><meta charset="utf-8">${css.map((c) => `<link rel="stylesheet" href="${c}">`).join('')}</head>` +
      `<body>${js.map((j) => `<script src="${j}"></script>`).join('')}</body></html>`,
  );
}

const MIME = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
};

// Strict: scripts may run, but nothing can be fetched from the network or
// the app; only files of the project itself (studio:) and inline data.
const PREVIEW_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' studio:",
  "style-src 'unsafe-inline' studio:",
  'img-src data: blob: studio:',
  'font-src data: studio:',
  'media-src data: blob: studio:',
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ');

function previewResponse(url) {
  let rel;
  try {
    rel = decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '');
  } catch {
    rel = '';
  }
  const headers = (type) => ({
    'content-type': type,
    'content-security-policy': PREVIEW_CSP,
    'x-content-type-options': 'nosniff',
    // Every run must load the files as they are now, not a cached copy.
    'cache-control': 'no-store',
  });
  if (rel === '__blazma__/console.js') return new Response(CONSOLE_BRIDGE, { headers: headers(MIME.js) });
  // "node file.js" in the studio terminal: a blank page that runs one script.
  if (rel === '__blazma__/node.html') {
    let file = '';
    try {
      file = cleanPath(new URL(url).searchParams.get('file'));
    } catch {
      file = '';
    }
    if (!file || previewFiles[file] === undefined || !/\.m?js$/i.test(file)) return new Response('Not found', { status: 404, headers: headers(MIME.txt) });
    const type = file.endsWith('.mjs') ? ' type="module"' : '';
    const html = `<!doctype html><html><head><meta charset="utf-8">${BRIDGE_TAG}</head><body><script src="/${encodeURI(file)}"${type}></script></body></html>`;
    return new Response(html, { headers: headers(MIME.html) });
  }
  if (rel === '' || rel === 'index.html') return new Response(entryHtml(), { headers: headers(MIME.html) });
  if (previewFiles[rel] === undefined) return new Response('Not found', { status: 404, headers: headers(MIME.txt) });
  const ext = rel.split('.').pop().toLowerCase();
  const body = MIME[ext] === MIME.html ? withBridge(previewFiles[rel]) : previewFiles[rel];
  return new Response(body, { headers: headers(MIME[ext] || MIME.txt) });
}

module.exports = { list, get, save, remove, exportProject, importFolder, setPreview, previewResponse, cleanPath };
