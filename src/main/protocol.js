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

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

function buildCsp() {
  const connect = serverPort ? `http://127.0.0.1:${serverPort}` : "'none'";
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "font-src 'self'",
    "img-src 'self' data:",
    `connect-src ${connect}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
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

    const filePath = path.normalize(path.join(RENDERER_DIR, rel));
    if (!filePath.startsWith(RENDERER_DIR + path.sep)) return notFound();

    const type = MIME[path.extname(filePath).toLowerCase()];
    if (!type) return notFound();

    try {
      const body = await fs.promises.readFile(filePath);
      return new Response(body, {
        headers: {
          'content-type': type,
          'content-security-policy': buildCsp(),
          'x-content-type-options': 'nosniff',
        },
      });
    } catch {
      return notFound();
    }
  });
}

module.exports = { APP_ORIGIN, registerScheme, handleAppProtocol, setServerPort };
