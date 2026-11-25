// The live preview pane next to the chat: runs HTML/SVG/JS from a reply in a
// sandboxed iframe served from app://preview (see src/main/preview.js), shows
// the errors it reports, and offers to send them back to the model.

import { ui, DIR } from '../i18n/index.js';
import { el } from './dom.js';

const P = ui.v2.preview;
let pane = null;
let frameBox = null;
let status = null;
let fixBtn = null;
let frame = null;
let last = null; // { code, lang }
let errors = [];
let fixHandler = null;

export function canRun(code, lang) {
  const l = String(lang || '').toLowerCase();
  if (/^(html?|svg|xhtml)$/.test(l)) return true;
  if (/^(js|javascript)$/.test(l)) return /\b(document|window|canvas|requestAnimationFrame|alert)\b/.test(code) && !/\brequire\(|process\./.test(code);
  return !l && /^\s*(<!doctype html|<html|<svg)/i.test(code);
}

function renderStatus() {
  if (!status) return;
  status.className = `preview-status ${errors.length ? 'bad' : 'good'}`;
  status.replaceChildren(el('span', null, errors.length ? P.errors(errors.length) : P.noErrors));
  if (errors.length) status.append(el('pre', { class: 'preview-errors', dir: 'ltr' }, errors.slice(0, 8).join('\n')));
  fixBtn.hidden = !errors.length || !fixHandler;
}

function onMessage(e) {
  if (!frame || e.source !== frame.contentWindow || !e.data || !e.data.blazmaPreview) return;
  const text = String(e.data.text || '').slice(0, 600);
  if (!errors.includes(text) && errors.length < 30) errors.push(text);
  renderStatus();
}

function build() {
  const reload = el('button', { type: 'button', class: 'btn ghost small' }, P.reload);
  reload.addEventListener('click', () => last && runPreview(last.code, last.lang));
  const close = el('button', { type: 'button', class: 'btn ghost small', 'aria-label': P.close, title: P.close }, '✕');
  close.addEventListener('click', closePreview);
  fixBtn = el('button', { type: 'button', class: 'btn primary small', hidden: true }, P.askFix);
  fixBtn.addEventListener('click', () => {
    if (fixHandler && errors.length) fixHandler(P.fixPrompt(errors.join('\n')));
  });
  status = el('div', { class: 'preview-status' });
  frameBox = el('div', { class: 'preview-frame' });
  pane = el(
    'aside',
    { class: 'preview-pane', dir: DIR, 'aria-label': P.title, hidden: true },
    el('header', { class: 'preview-head' }, el('div', null, el('strong', null, P.title), el('span', { class: 'muted small' }, P.note)), el('div', { class: 'row' }, reload, close)),
    frameBox,
    el('footer', { class: 'preview-foot' }, status, fixBtn),
  );
  window.addEventListener('message', onMessage);
  return pane;
}

export function initPreview(container, onFix) {
  fixHandler = onFix;
  container.append(build());
}

export async function runPreview(code, lang) {
  if (!pane) return;
  last = { code, lang };
  errors = [];
  const res = await window.blazma.previewSet(code, lang);
  if (!res.ok) {
    errors = [P.failed];
    renderStatus();
    return;
  }
  frame = el('iframe', { sandbox: 'allow-scripts allow-modals allow-pointer-lock', src: res.result.url, title: P.title });
  frameBox.replaceChildren(frame);
  pane.hidden = false;
  document.body.classList.add('previewing');
  renderStatus();
}

export function closePreview() {
  if (!pane) return;
  pane.hidden = true;
  frameBox.replaceChildren();
  frame = null;
  document.body.classList.remove('previewing');
}
