'use strict';

// The live preview: code from a reply (HTML, SVG or JS) runs in an iframe at
// app://preview/<id>. That is another origin than the app, the iframe is
// sandboxed without allow-same-origin, it has no preload, and its CSP allows
// no network at all. Errors reach the chat through postMessage only.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Libraries the preview pages may load (diagrams): app://preview/vendor/<file>.
const VENDOR_DIR = path.join(__dirname, '..', 'renderer', 'vendor');
const VENDOR = new Set(['mermaid.min.js']);

const HOST = 'preview';
const MAX_BYTES = 2 * 1024 * 1024;
const KEEP = 80;
const pages = new Map();

// Sent before the user's code: reports errors and console.error to the chat.
const REPORTER = `<script>(function(){var send=function(t){try{parent.postMessage({blazmaPreview:1,text:String(t).slice(0,2000)},'*')}catch(e){}};
window.addEventListener('error',function(e){send((e.message||'Error')+(e.lineno?' (line '+e.lineno+')':''))});
window.addEventListener('unhandledrejection',function(e){send('Unhandled promise rejection: '+(e.reason&&e.reason.message||e.reason))});
var ce=console.error;console.error=function(){send([].map.call(arguments,String).join(' '));return ce.apply(console,arguments)};})();</script>`;

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' data: blob: app://preview",
  "style-src 'unsafe-inline' data:",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  'frame-ancestors app://blazma',
].join('; ');

// Turns what the model wrote into a full page.
function toPage(code, lang) {
  const l = String(lang || '').toLowerCase();
  let html;
  if (l === 'svg' || /^\s*<svg[\s>]/i.test(code)) html = `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh">${code}</body></html>`;
  else if (/^(js|javascript|mjs)$/.test(l)) html = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${code.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
  else html = /<html[\s>]/i.test(code) || /<!doctype/i.test(code) ? code : `<!doctype html><html><head><meta charset="utf-8"></head><body>${code}</body></html>`;
  // The reporter goes first so it sees errors from the first line.
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}<meta charset="utf-8">${REPORTER}`);
  return REPORTER + html;
}

// A Mermaid diagram: drawn by mermaid.js inside the sandbox, which reports
// its height so the frame in the reply fits it.
function diagramPage(code, dark) {
  const src = String(code).replace(/</g, '&lt;');
  return `<!doctype html><html><head><meta charset="utf-8">${REPORTER}<meta name="color-scheme" content="${dark ? 'dark' : 'light'}"><style>html,body{margin:0;overflow:hidden;background:${dark ? '#14171e' : '#ffffff'}}body{display:flex;justify-content:center;padding:12px}</style></head><body><pre class="mermaid">${src}</pre>
<script src="app://preview/vendor/mermaid.min.js"></script><script>
mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:${dark ? "'dark'" : "'default'"},fontFamily:'Segoe UI, Tahoma, sans-serif'});
mermaid.run().then(function(){var s=document.querySelector('svg');parent.postMessage({blazmaDiagram:1,h:Math.ceil((s?s.getBoundingClientRect().height:document.body.scrollHeight)+28)},'*')}).catch(function(e){parent.postMessage({blazmaDiagram:1,h:60,error:String(e&&e.message||e)},'*')});
</script></body></html>`;
}

function setDiagram(code, dark) {
  const id = crypto.randomBytes(12).toString('hex');
  pages.set(id, diagramPage(String(code).slice(0, 50000), Boolean(dark)));
  while (pages.size > KEEP) pages.delete(pages.keys().next().value);
  return { id, url: `app://${HOST}/${id}` };
}

function set(code, lang) {
  const page = toPage(String(code), lang);
  if (Buffer.byteLength(page) > MAX_BYTES) throw new Error('too-large');
  const id = crypto.randomBytes(12).toString('hex');
  pages.set(id, page);
  while (pages.size > KEEP) pages.delete(pages.keys().next().value);
  return { id, url: `app://${HOST}/${id}` };
}

function response(url) {
  const vendor = /^\/vendor\/([\w.-]+)$/.exec(url.pathname);
  if (vendor && VENDOR.has(vendor[1])) {
    return new Response(fs.readFileSync(path.join(VENDOR_DIR, vendor[1])), { headers: { 'content-type': 'text/javascript; charset=utf-8', 'x-content-type-options': 'nosniff' } });
  }
  const page = pages.get(url.pathname.replace(/^\//, ''));
  if (!page) return new Response('Not found', { status: 404 });
  return new Response(page, {
    headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': CSP, 'x-content-type-options': 'nosniff' },
  });
}

module.exports = { HOST, set, setDiagram, response, toPage };
