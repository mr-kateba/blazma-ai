// Programming page: the full VS Code (VSCodium), run on this computer by the
// main process (main/vscode.js) and shown in a view placed over #code-host.
// This page only draws the frame around it: install card, toolbar, and the
// place the view goes. The view is a native layer, so anything this page
// shows on top of it (a dialog) hides the view first.

import { ar } from '../i18n/ar.js';
import { el } from '../lib/dom.js';
import { confirmDialog } from '../lib/dialog.js';

const C = ar.code;
const $ = (id) => document.getElementById(id);

let visible = false;
let shown = false; // the view is on screen
let busy = false;
let observer = null;

function errorTitle(res) {
  const e = res && res.error && ar.errors[res.error.code];
  return e ? e.title : C.failed;
}

function bounds() {
  const host = $('code-host');
  if (!host) return null;
  const r = host.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function sendBounds() {
  if (shown && visible) window.blazma.vscodeBounds(bounds());
}

async function hideView() {
  shown = false;
  await window.blazma.vscodeHide();
}

// A dialog over VS Code: the native view would cover it, so it steps aside.
async function ask(opts) {
  const wasShown = shown;
  if (wasShown) await hideView();
  const ok = await confirmDialog(opts);
  if (wasShown && visible) await showView();
  return ok;
}

function note(text, kind = '') {
  const box = $('code-note');
  if (!box) return;
  box.textContent = text || '';
  box.className = `code-note ${kind}`;
  box.hidden = !text;
}

async function showView() {
  const host = $('code-host');
  if (!host || !visible) return;
  $('code-loading').hidden = false;
  const res = await window.blazma.vscodeShow(bounds());
  $('code-loading').hidden = true;
  if (!res.ok) {
    note(`${errorTitle(res)} ${C.retryHint}`, 'error');
    return;
  }
  shown = visible;
  if (!visible) window.blazma.vscodeHide();
  else sendBounds();
}

// ---------- not installed yet ----------

function installCard() {
  const progress = el('div', { class: 'code-progress', hidden: true }, el('div', { class: 'code-progress-bar' }), el('span', { class: 'muted small' }));
  const btn = el('button', { type: 'button', class: 'btn primary big' }, C.install);
  const sizeLine = el('p', { class: 'muted small' }, C.sizeUnknown);
  window.blazma.vscodePlan().then((r) => {
    if (r.ok) sizeLine.textContent = C.size(Math.round(r.result.bytes / 1e6), r.result.version);
  });
  btn.addEventListener('click', async () => {
    if (busy) return;
    busy = true;
    btn.disabled = true;
    progress.hidden = false;
    const off = window.blazma.onVscodeProgress((p) => {
      const pct = p.total ? Math.floor((p.done / p.total) * 100) : 0;
      progress.firstChild.style.width = `${p.stage === 'extract' ? 100 : pct}%`;
      progress.lastChild.textContent = p.stage === 'extract' ? C.extracting : C.downloading(pct);
    });
    const res = await window.blazma.vscodeInstall();
    off();
    busy = false;
    if (!res.ok) {
      btn.disabled = false;
      progress.hidden = true;
      note(errorTitle(res), 'error');
      return;
    }
    render();
  });
  return el(
    'div',
    { class: 'code-install' },
    el('div', { class: 'code-logo', 'aria-hidden': 'true' }, '</>'),
    el('h2', null, C.title),
    el('p', null, C.intro),
    el('ul', { class: 'code-points' }, ...C.points.map((p) => el('li', null, p))),
    el('div', { class: 'code-warn', role: 'note' }, el('b', null, C.warnTitle), el('span', null, C.warn)),
    el('p', { class: 'muted small' }, C.noMicrosoft),
    sizeLine,
    btn,
    progress,
    el('div', { id: 'code-note', class: 'code-note', hidden: true }),
  );
}

// ---------- installed: toolbar + the view ----------

function toolbar(st) {
  const folder = el('span', { class: 'code-folder', dir: 'ltr', title: st.folder }, st.folder);
  const open = el('button', { type: 'button', class: 'btn small' }, C.openFolder);
  open.addEventListener('click', async () => {
    const wasShown = shown;
    if (wasShown) await hideView(); // the folder picker is a separate window, but keep focus simple
    const dir = await window.blazma.vscodeOpenFolder();
    if (dir) folder.textContent = dir;
    if (visible) await showView();
  });
  const projects = el('button', { type: 'button', class: 'btn ghost small' }, C.projects);
  projects.addEventListener('click', async () => {
    folder.textContent = await window.blazma.vscodeOpenProjects();
    await showView();
  });
  const restart = el('button', { type: 'button', class: 'btn ghost small', title: C.restartHint }, C.restart);
  restart.addEventListener('click', async () => {
    await hideView();
    await window.blazma.vscodeRestart();
    await showView();
  });
  let ai;
  if (st.aiReady) {
    ai = el('button', { type: 'button', class: 'btn primary small', title: C.aiOnHint }, C.aiOn);
    ai.addEventListener('click', () => window.blazma.vscodeAskAi());
  }
  else {
    ai = el('button', { type: 'button', class: 'btn primary small' }, C.aiConnect);
    ai.addEventListener('click', async () => {
      if (!(await ask({ title: C.aiConnect, text: C.aiConfirm, ok: C.aiConnectOk }))) return;
      ai.disabled = true;
      ai.textContent = C.aiConnecting;
      const res = await window.blazma.vscodeConnectAi();
      if (!res.ok) {
        ai.disabled = false;
        ai.textContent = C.aiConnect;
        note(errorTitle(res), 'error');
        return;
      }
      note(C.aiDone, 'ok');
      render();
    });
  }
  return el('div', { class: 'code-bar' }, el('span', { class: 'code-bar-title' }, 'VS Code'), folder, el('span', { class: 'code-bar-gap' }), ai, open, projects, restart);
}

async function render() {
  const rootEl = $('studio-root');
  if (!rootEl) return;
  const st = await window.blazma.vscodeStatus();
  if (!st.installed) {
    shown = false;
    window.blazma.vscodeHide();
    rootEl.replaceChildren(installCard());
    return;
  }
  const host = el('div', { id: 'code-host', class: 'code-host' }, el('div', { id: 'code-loading', class: 'code-loading' }, el('span', { class: 'ai-spinner' }), el('span', null, C.opening)));
  rootEl.replaceChildren(toolbar(st), el('div', { id: 'code-note', class: 'code-note', hidden: true }), host);
  if (observer) observer.disconnect();
  observer = new ResizeObserver(sendBounds);
  observer.observe(host);
  await showView();
}

window.addEventListener('resize', sendBounds);

export async function setStudioVisible(v) {
  visible = v;
  if (v) await render();
  // Always, also while VS Code is still opening: the main process then does
  // not show it over the page that is now in front.
  else await hideView();
}

// "افتح في VS Code" on a code block in the chat: saved as a file in its own
// folder under "Blazma Projects", then opened here.
export async function openCodeInStudio(code, lang) {
  await window.blazma.vscodeSnippet(code, lang);
  window.dispatchEvent(new CustomEvent('blazma:show-page', { detail: 'studio' }));
}
