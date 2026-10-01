// In-app confirmation dialog, used instead of window.confirm(): on Windows,
// after a native alert/confirm closes, Electron windows can stop taking
// keyboard input in text fields until the window loses and regains focus.
// This dialog also matches the app's look and returns focus where it was.

import { el } from './dom.js';

let open = null;

// confirmDialog({ title, text, ok, cancel, danger }) -> Promise<boolean>
export function confirmDialog({ title, text = '', ok = 'موافق', cancel = 'إلغاء', danger = false }) {
  if (open) open.finish(false);
  const back = document.activeElement;
  return new Promise((resolve) => {
    const okBtn = el('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'} dlg-ok` }, ok);
    const cancelBtn = el('button', { type: 'button', class: 'btn ghost dlg-cancel' }, cancel);
    const box = el(
      'div',
      { class: 'dlg', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': title || text },
      title ? el('h3', { class: 'dlg-title' }, title) : null,
      text ? el('p', { class: 'dlg-text' }, text) : null,
      el('div', { class: 'dlg-actions' }, okBtn, cancelBtn),
    );
    const layer = el('div', { class: 'dlg-layer' }, box);
    const finish = (value) => {
      if (!open || open.layer !== layer) return;
      open = null;
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
      resolve(value);
    };
    // While it is open no other shortcut runs (page switches, studio keys).
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Tab') {
        // Keep the focus inside the dialog.
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      } else if (!['Enter', ' '].includes(e.key) || !box.contains(document.activeElement)) {
        e.preventDefault();
      }
    };
    okBtn.addEventListener('click', () => finish(true));
    cancelBtn.addEventListener('click', () => finish(false));
    layer.addEventListener('mousedown', (e) => e.target === layer && finish(false));
    document.addEventListener('keydown', onKey, true);
    open = { layer, finish };
    document.body.append(layer);
    // A dangerous action starts on "cancel", so Enter does not delete by accident.
    (danger ? cancelBtn : okBtn).focus();
  });
}
