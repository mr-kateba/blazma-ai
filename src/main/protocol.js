'use strict';

// Serves the renderer from app://blazma/ so the CSP can be sent as a
// response header that names the exact local server port (set later via
// setServerPort). index.html also carries a meta CSP; both are enforced.

const fs = require('node:fs');
const path = require('node:path');
const { protocol } = require('electron');

const SCHEME = 'app';
const HOST = 'blazma';
const APP_ORIGIN = `${SCHEME}://${HOST}`;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
// Monaco Editor (MIT), the editor of VS Code, served from the installed
// package at app://blazma/vendor/monaco/vs/... so it works offline.
const MONACO_PREFIX = '/vendor/monaco/vs/';
// (The package's "exports" map hides package.json from require.resolve, so
// the folder is located next to the app's other dependencies.)
const MONACO_DIR = path.join(__dirname, '..', '..', 'node_modules', 'monaco-editor', 'min', 'vs');
function monacoDir() {
  return fs.existsSync(MONACO_DIR) ? MONACO_DIR : null;
}

// Pyodide (MPL-2.0): CPython compiled to WebAssembly, for running Python in
// the studio offline. Only the runtime files are served; packages beyond the
// standard library are not shipped and the network is closed to them.
const PYODIDE_PREFIX = '/vendor/pyodide/';
const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
const PYODIDE_FILES = new Set(['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']);
// The Python worker and Pyodide's own files get a policy that also allows
// compiling WebAssembly and fetching Pyodide's files; the app pages do not.
const PYTHON_WORKER = '/studio/python-worker.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

let serverPort = null;

function setServerPort(port) {
  serverPort = Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

function buildCsp({ python = false } = {}) {
  const connect = python ? "'self'" : serverPort ? `http://127.0.0.1:${serverPort}` : "'none'";
  return [
    "default-src 'none'",
    python ? "script-src 'self' 'wasm-unsafe-eval'" : "script-src 'self'",
    // Monaco injects <style> elements and has no nonce support. Scripts stay
    // 'self' only, and img/font/connect sources below block any external
    // request, so injected CSS could not send data anywhere.
    "style-src 'self' 'unsafe-inline'",
    // Monaco's CSS embeds its icon font as a data: URL.
    "font-src 'self' data:",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    // The studio preview runs in a sandboxed iframe served over studio://.
    'frame-src studio:',
    // Monaco starts its helper worker from a blob: URL that imports its own files.
    "worker-src 'self' blob:",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'studio', privileges: { standard: true, secure: true } },
  ]);
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

function handleAppProtocol() {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    if (url.host !== HOST) return notFound();

    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      return notFound();
    }
    if (rel === '/' || rel === '') rel = '/index.html';

    let base = RENDERER_DIR;
    const python = rel.startsWith(PYODIDE_PREFIX) || rel === PYTHON_WORKER;
    if (rel.startsWith(PYODIDE_PREFIX)) {
      const name = rel.slice(PYODIDE_PREFIX.length);
      if (!PYODIDE_FILES.has(name) || !fs.existsSync(PYODIDE_DIR)) return notFound();
      base = PYODIDE_DIR;
      rel = `/${name}`;
    } else if (rel.startsWith(MONACO_PREFIX)) {
      base = monacoDir();
      if (!base) return notFound();
      rel = rel.slice(MONACO_PREFIX.length - 1);
    }
    const filePath = path.normalize(path.join(base, rel));
    if (!filePath.startsWith(base + path.sep)) return notFound();

    const type = MIME[path.extname(filePath).toLowerCase()];
    if (!type) return notFound();

    try {
      const body = await fs.promises.readFile(filePath);
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-security-policy': buildCsp({ python }),
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return notFound();
    }
  });
}

// studio://preview/<file> serves the studio's run preview (see studio.js).
function handleStudioProtocol(previewResponse) {
  protocol.handle('studio', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'preview') return notFound();
    return previewResponse(request.url);
  });
}

module.exports = { APP_ORIGIN, registerScheme, handleAppProtocol, handleStudioProtocol, setServerPort };
