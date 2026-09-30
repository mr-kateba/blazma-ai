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

// ---------- preview ----------

let previewFiles = {};

function setPreview(files) {
  previewFiles = cleanFiles(files);
  return true;
}

// Forwards console output and errors from the preview to the studio page.
const CONSOLE_BRIDGE = `(() => {
  const fmt = (a) => { if (typeof a === 'string') return a; try { return JSON.stringify(a); } catch { return String(a); } };
  const send = (level, args) => { try { parent.postMessage({ blazma: 'console', level, text: args.map(fmt).join(' ') }, '*'); } catch {} };
  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level];
    console[level] = (...a) => { send(level, a); orig.apply(console, a); };
  }
  addEventListener('error', (e) => send('error', [e.message + (e.lineno ? ' (' + String(e.filename).split('/').pop() + ':' + e.lineno + ')' : '')]));
  addEventListener('unhandledrejection', (e) => send('error', [String(e.reason)]));
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
  const headers = (type) => ({ 'content-type': type, 'content-security-policy': PREVIEW_CSP, 'x-content-type-options': 'nosniff' });
  if (rel === '__blazma__/console.js') return new Response(CONSOLE_BRIDGE, { headers: headers(MIME.js) });
  if (rel === '' || rel === 'index.html') return new Response(entryHtml(), { headers: headers(MIME.html) });
  if (previewFiles[rel] === undefined) return new Response('Not found', { status: 404, headers: headers(MIME.txt) });
  const ext = rel.split('.').pop().toLowerCase();
  const body = MIME[ext] === MIME.html ? withBridge(previewFiles[rel]) : previewFiles[rel];
  return new Response(body, { headers: headers(MIME[ext] || MIME.txt) });
}

module.exports = { list, get, save, remove, exportProject, setPreview, previewResponse, cleanPath };
