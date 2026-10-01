'use strict';

// The programming page: the full VS Code, as VSCodium (MIT, github.com/
// VSCodium/vscodium), run on this computer as a local web server
// ("vscodium-reh-web") and shown inside the app window.
// - Downloaded on first use after the user agrees, from VSCodium's GitHub
//   releases, checked by its sha256 (GitHub digest or the .sha256 file).
// - Started with fixed arguments: 127.0.0.1 only, a random connection token
//   kept in a file (not on the command line), telemetry off, its own data
//   and extension folders inside the app's data.
// - Unlike the chat, this is a real editor: its terminal and extensions run
//   on this computer with the user's rights. The page says so before install.
// - The AI: the Continue extension (Apache-2.0, Open VSX "Continue.continue")
//   talks to the model in Blazma through the local OpenAI-compatible API.
//   Its settings live in the app's folder (CONTINUE_GLOBAL_DIR), not in ~/.continue.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { app, net, shell, WebContentsView, session } = require('electron');
const paths = require('./paths');
const { downloadFile } = require('./download');
const { run } = require('./exec');
const { pickPort, killTree } = require('./server');
const { extractTarGz } = require('./untar');
const { AppError } = require('./errors');

const RELEASES_API = 'https://api.github.com/repos/VSCodium/vscodium/releases?per_page=5';
const ASSET_RE = process.platform === 'win32' ? /^vscodium-reh-web-win32-x64-([\d.]+)\.tar\.gz$/ : /^vscodium-reh-web-linux-x64-([\d.]+)\.tar\.gz$/;
const NODE_EXE = process.platform === 'win32' ? 'node.exe' : 'node';
const AI_EXTENSION = 'Continue.continue';

const root = () => path.join(paths.userData(), 'vscode');
const dataDir = () => path.join(root(), 'data');
const extDir = () => path.join(root(), 'extensions');
const continueDir = () => path.join(root(), 'continue');
const projectsDir = () => path.join(app.getPath('documents'), 'Blazma Projects');

let server = null; // { child, port, token, base }
let starting = null;
let installing = null;

// The folder that has out/server-main.js (archives may or may not wrap it).
function findServerRoot(dir, depth = 2) {
  if (fs.existsSync(path.join(dir, 'out', 'server-main.js')) && fs.existsSync(path.join(dir, NODE_EXE))) return dir;
  if (depth === 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findServerRoot(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

function installedRoot() {
  if (process.env.BLAZMA_VSCODE_DIR) return findServerRoot(process.env.BLAZMA_VSCODE_DIR); // development/testing
  const bin = path.join(root(), 'bin');
  if (!fs.existsSync(bin)) return null;
  // Newest version folder first.
  const versions = fs.readdirSync(bin).filter((v) => !v.endsWith('.partial')).sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  for (const v of versions) {
    const found = findServerRoot(path.join(bin, v));
    if (found) return found;
  }
  return null;
}

function version(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'product.json'), 'utf8')).release || JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

// Running = not exited and not killed by a signal (exitCode stays null then).
const alive = (child) => Boolean(child) && child.exitCode === null && child.signalCode === null;

function status() {
  const dir = installedRoot();
  return { installed: Boolean(dir), version: dir ? version(dir) : null, running: Boolean(server && alive(server.child)), projects: projectsDir() };
}

async function json(url) {
  let res;
  try {
    res = await net.fetch(url, { headers: { 'User-Agent': 'Blazma-AI', Accept: 'application/vnd.github+json' } });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (!res.ok) throw new AppError('vscode-install', `HTTP ${res.status} for ${url}`);
  return res.json();
}

async function text(url) {
  const res = await net.fetch(url, { headers: { 'User-Agent': 'Blazma-AI' } }).catch(() => null);
  return res && res.ok ? res.text() : '';
}

// The newest release that has the server build for this system.
async function findRelease() {
  const releases = await json(RELEASES_API);
  for (const rel of Array.isArray(releases) ? releases : []) {
    if (rel.draft || rel.prerelease) continue;
    const asset = (rel.assets || []).find((a) => ASSET_RE.test(a.name));
    if (!asset) continue;
    let sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1] || null;
    if (!sha256) {
      const sum = (rel.assets || []).find((a) => a.name === `${asset.name}.sha256`);
      sha256 = sum ? /^([a-f0-9]{64})\b/i.exec(await text(sum.browser_download_url))?.[1] || null : null;
    }
    if (!sha256) throw new AppError('vscode-install', 'no checksum published');
    return { tag: rel.tag_name, asset, sha256 };
  }
  throw new AppError('vscode-install', 'no server build in recent releases');
}

async function plan() {
  const rel = await findRelease();
  return { version: rel.tag, bytes: rel.asset.size };
}

// onProgress({ stage: 'download' | 'extract', done, total })
async function install(onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    const rel = await findRelease();
    const dl = path.join(root(), 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    const file = path.join(dl, rel.asset.name);
    await downloadFile(rel.asset.browser_download_url, file, {
      expectedSize: rel.asset.size,
      sha256: rel.sha256,
      onProgress: (done) => onProgress({ stage: 'download', done, total: rel.asset.size }),
    });
    onProgress({ stage: 'extract', done: 0, total: 0 });
    // Extracted next to its final place and renamed when complete, so an
    // interrupted extraction is never taken for an installed copy.
    const target = path.join(root(), 'bin', rel.tag.replace(/[^\w.-]/g, '_'));
    const temp = `${target}.partial`;
    fs.rmSync(temp, { recursive: true, force: true });
    try {
      await extractTarGz(file, temp);
    } catch (err) {
      fs.rmSync(temp, { recursive: true, force: true });
      throw new AppError('vscode-install', err.message);
    }
    if (!findServerRoot(temp)) throw new AppError('vscode-install', 'server not found in the archive');
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temp, target);
    fs.rmSync(file, { force: true });
    return status();
  })();
  try {
    return await installing;
  } finally {
    installing = null;
  }
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/version', timeout: 1500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

async function startServer() {
  killServer(); // not stop(): that would also cancel the view being opened
  const dir = installedRoot();
  if (!dir) throw new AppError('vscode-missing');
  const port = await pickPort(0);
  const token = crypto.randomBytes(24).toString('hex');
  for (const d of [dataDir(), extDir(), continueDir()]) fs.mkdirSync(d, { recursive: true });
  const tokenFile = path.join(root(), 'connection-token');
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const args = [
    path.join(dir, 'out', 'server-main.js'),
    '--host', '127.0.0.1',
    '--port', String(port),
    '--connection-token-file', tokenFile,
    '--accept-server-license-terms',
    '--telemetry-level', 'off',
    '--server-data-dir', dataDir(),
    '--extensions-dir', extDir(),
  ];
  const child = spawn(path.join(dir, NODE_EXE), args, {
    cwd: dir,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, CONTINUE_GLOBAL_DIR: continueDir() },
  });
  let log = '';
  let spawnError = null;
  // A spawn failure (antivirus blocking node.exe, no rights) is an 'error'
  // event; unhandled it would end the whole app.
  child.on('error', (err) => (spawnError = err));
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  server = { child, port, token, base: `http://127.0.0.1:${port}` };
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if (spawnError) {
      server = null;
      throw new AppError('vscode-failed', spawnError.message);
    }
    if (!alive(child)) {
      server = null;
      throw new AppError('vscode-failed', log.slice(-800));
    }
    if (await ping(port)) return server;
    await new Promise((r) => setTimeout(r, 400));
  }
  killServer();
  throw new AppError('vscode-failed', 'timeout');
}

async function ensureServer() {
  if (server && alive(server.child)) return server;
  if (!starting) starting = startServer().finally(() => (starting = null));
  return starting;
}

// The page address for a folder ("folder" is how the web workbench is told
// which folder to open; the token is exchanged for a cookie on first load).
function urlFor(s, folder) {
  const u = new URL(`${s.base}/`);
  u.searchParams.set('tkn', s.token);
  if (folder) u.searchParams.set('folder', process.platform === 'win32' ? `/${folder.replace(/\\/g, '/')}` : folder);
  return u.toString();
}

// The whole process tree: on Windows its terminals and helpers too.
function killServer() {
  if (server && alive(server.child) && server.child.pid) killTree(server.child.pid, true);
  server = null;
}

function stop() {
  hideView();
  killServer();
}

// ---------- the view inside the app window ----------

let view = null;
let viewWin = null;

function isOwnUrl(url) {
  return Boolean(server) && (url === server.base || url.startsWith(`${server.base}/`));
}

// Webviews (Markdown preview, extension panels such as Continue's chat) are
// loaded by the web workbench from https://<uuid>.vscode-cdn.net/…/pre/ (its
// product.json default). Those few files are in the downloaded server, so
// they are served from disk: each webview keeps its own origin, and nothing
// is fetched from Microsoft's CDN (works offline).
const WEBVIEW_PRE = '/out/vs/workbench/contrib/webview/browser/pre/';
const PRE_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function serveWebviewHost(ses) {
  ses.protocol.handle('https', async (request) => {
    const url = new URL(request.url);
    const at = url.pathname.indexOf(WEBVIEW_PRE);
    if (url.hostname.endsWith('.vscode-cdn.net') && at >= 0) {
      const name = url.pathname.slice(at + WEBVIEW_PRE.length);
      const dir = installedRoot();
      const type = PRE_TYPES[path.extname(name)];
      if (!dir || !type || !/^[\w.-]+$/.test(name)) return new Response('Not found', { status: 404 });
      try {
        const body = await fs.promises.readFile(path.join(dir, 'out', 'vs', 'workbench', 'contrib', 'webview', 'browser', 'pre', name));
        // The service worker must be allowed to control the whole webview origin.
        return new Response(body, { headers: { 'content-type': type, 'service-worker-allowed': '/', 'cache-control': 'no-cache' } });
      } catch {
        return new Response('Not found', { status: 404 });
      }
    }
    if (url.hostname.endsWith('.vscode-cdn.net')) return new Response('Not found', { status: 404 });
    // Everything else (e.g. the Open VSX extension gallery) goes out as usual.
    return ses.fetch(request, { bypassCustomProtocolHandlers: true });
  });
}

let sessionReady = false;

function makeView() {
  const ses = session.fromPartition('persist:vscode');
  if (!sessionReady) {
    serveWebviewHost(ses);
    sessionReady = true;
  }
  // Clipboard for copy/paste from the menus; nothing else (camera, location…).
  ses.setPermissionRequestHandler((_wc, perm, cb) => cb(['clipboard-read', 'clipboard-sanitized-write'].includes(perm)));
  ses.setPermissionCheckHandler((_wc, perm) => ['clipboard-read', 'clipboard-sanitized-write'].includes(perm));
  const v = new WebContentsView({ webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false } });
  const wc = v.webContents;
  // Links leave to the browser; the page itself stays on the local server.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) && !isOwnUrl(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!isOwnUrl(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  return v;
}

const ownsContents = (contents) => Boolean(view) && contents === view.webContents;

// Whether a navigation inside this web contents is allowed (main.js asks,
// since its global rules only allow the app's own pages).
function allowsNavigation(contents, url) {
  return Boolean(view) && contents === view.webContents && isOwnUrl(url);
}

let wantVisible = false; // the page wants the view (false once it is left)

// folder: open this folder; null = keep what is open (the user may have
// opened another folder inside VS Code), or "Blazma Projects" the first time.
async function showView(win, bounds, folder) {
  wantVisible = true;
  const s = await ensureServer();
  if (!wantVisible) return { base: s.base }; // the page was left meanwhile
  if (!view) view = makeView();
  if (viewWin !== win) {
    if (viewWin && !viewWin.isDestroyed()) viewWin.contentView.removeChildView(view);
    win.contentView.addChildView(view);
    viewWin = win;
  }
  setBounds(bounds);
  const current = view.webContents.getURL();
  const onServer = Boolean(current) && current.startsWith(`${s.base}/`);
  if (folder || !onServer) {
    view.setVisible(false);
    await view.webContents.loadURL(urlFor(s, folder || projectsDir())).catch(() => {});
  }
  if (!wantVisible) {
    view.setVisible(false);
    return { base: s.base };
  }
  view.setVisible(true);
  view.webContents.focus();
  return { base: s.base };
}

// The folder open in the editor now (from its address), for the page's toolbar.
function currentFolder() {
  if (!view) return null;
  try {
    const f = new URL(view.webContents.getURL()).searchParams.get('folder');
    return f ? (process.platform === 'win32' ? f.replace(/^\//, '').replace(/\//g, '\\') : f) : null;
  } catch {
    return null;
  }
}

function setBounds(b) {
  if (!view || !b) return;
  const r = { x: Math.round(b.x), y: Math.round(b.y), width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height)) };
  view.setBounds(r);
}

function hideView() {
  wantVisible = false;
  if (view) view.setVisible(false);
  // Keyboard focus back to the app's page, not the hidden editor.
  if (viewWin && !viewWin.isDestroyed()) viewWin.webContents.focus();
}

function reloadView() {
  if (view) view.webContents.reload();
}

// ---------- folders ----------


function safeName(name) {
  return String(name || 'project').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 80) || 'project';
}

// Projects from the earlier built-in studio (<userData>/studio/*.json) are
// written once as normal folders under "Blazma Projects", so nothing is lost.
function migrateStudioProjects() {
  const marker = path.join(root(), 'studio-migrated');
  if (fs.existsSync(marker)) return 0;
  const src = path.join(paths.userData(), 'studio');
  let count = 0;
  if (fs.existsSync(src)) {
    for (const f of fs.readdirSync(src).filter((n) => n.endsWith('.json'))) {
      try {
        const p = JSON.parse(fs.readFileSync(path.join(src, f), 'utf8'));
        if (!p || typeof p.files !== 'object') continue;
        let dir = path.join(projectsDir(), safeName(p.name));
        for (let i = 2; fs.existsSync(dir); i++) dir = path.join(projectsDir(), `${safeName(p.name)} (${i})`);
        for (const [rel, content] of Object.entries(p.files)) {
          const clean = String(rel).replace(/\\/g, '/');
          if (!clean || clean.split('/').some((part) => !part || part === '.' || part === '..') || /^[a-z]:/i.test(clean)) continue;
          const full = path.join(dir, ...clean.split('/'));
          if (!full.startsWith(dir + path.sep)) continue;
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, String(content ?? ''));
        }
        count++;
      } catch {
        /* a broken project file is skipped */
      }
    }
  }
  fs.mkdirSync(projectsDir(), { recursive: true });
  fs.mkdirSync(root(), { recursive: true });
  fs.writeFileSync(marker, String(count));
  return count;
}

// Code from the chat ("افتح في VS Code"): saved as a file in its own folder.
function saveSnippet(code, lang) {
  const ext = { html: 'html', htm: 'html', css: 'css', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', python: 'py', py: 'py', json: 'json', md: 'md' }[String(lang || '').toLowerCase()] || 'txt';
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dir = path.join(projectsDir(), 'من المحادثة', stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, ext === 'html' ? 'index.html' : `main.${ext}`), String(code || ''));
  return dir;
}

// ---------- the AI in VS Code (Continue) ----------

// Continue's config (packages/config-yaml schema v1): the running model
// through Blazma's OpenAI-compatible API. Written once; later only the port
// and key are updated in place (when they change), so the user's own
// additions to the file are kept.
function syncContinueConfig({ port, apiKey, modelName }) {
  const file = path.join(continueDir(), 'config.yaml');
  const metaFile = path.join(continueDir(), 'blazma.json');
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  } catch {
    meta = null;
  }
  if (fs.existsSync(file) && meta) {
    if (meta.port === port && meta.apiKey === apiKey) return;
    let text = fs.readFileSync(file, 'utf8');
    text = text.split(`http://127.0.0.1:${meta.port}/v1`).join(`http://127.0.0.1:${port}/v1`);
    if (meta.apiKey) text = text.split(meta.apiKey).join(apiKey);
    fs.writeFileSync(file, text, { mode: 0o600 });
  } else writeContinueConfig({ port, apiKey, modelName });
  fs.writeFileSync(metaFile, JSON.stringify({ port, apiKey }), { mode: 0o600 });
}

function writeContinueConfig({ port, apiKey, modelName }) {
  fs.mkdirSync(continueDir(), { recursive: true });
  const q = (s) => JSON.stringify(String(s)); // YAML accepts JSON strings
  const yaml = [
    'name: Blazma AI',
    'version: 1.0.0',
    'schema: v1',
    'models:',
    `  - name: ${q(`Blazma AI (${modelName || 'local'})`)}`,
    '    provider: openai',
    '    model: local',
    `    apiBase: ${q(`http://127.0.0.1:${port}/v1`)}`,
    `    apiKey: ${q(apiKey)}`,
    '    roles:',
    '      - chat',
    '      - edit',
    '      - apply',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(continueDir(), 'config.yaml'), yaml, { mode: 0o600 });
}

function aiInstalled() {
  try {
    return fs.readdirSync(extDir()).some((n) => n.toLowerCase().startsWith('continue.continue-'));
  } catch {
    return false;
  }
}

// Installs Continue from Open VSX with the server's own command line.
async function installAi() {
  const dir = installedRoot();
  if (!dir) throw new AppError('vscode-missing');
  if (aiInstalled()) return true;
  fs.mkdirSync(extDir(), { recursive: true });
  const r = await run(path.join(dir, NODE_EXE), [path.join(dir, 'out', 'server-main.js'), '--install-extension', AI_EXTENSION, '--extensions-dir', extDir(), '--server-data-dir', dataDir(), '--accept-server-license-terms'], {
    timeoutMs: 10 * 60 * 1000,
    cwd: dir,
  });
  if (!aiInstalled()) throw new AppError('vscode-ai-install', `${r.stdout || ''}\n${r.stderr || ''}`.trim().slice(-800));
  return true;
}

module.exports = {
  status,
  plan,
  install,
  ensureServer,
  stop,
  showView,
  setBounds,
  hideView,
  reloadView,
  allowsNavigation,
  currentFolder,
  ownsContents,
  migrateStudioProjects,
  saveSnippet,
  projectsDir,
  syncContinueConfig,
  aiInstalled,
  installAi,
};
