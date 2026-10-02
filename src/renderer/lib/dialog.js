// In-app dialogs, used instead of window.confirm()/prompt(): on Windows,
// after a native alert/confirm closes, Electron windows can stop taking
// keyboard input in text fields until the window loses and regains focus.
// These dialogs also match the app's look and return focus where it was.

import { el } from './dom.js';

let open = null;

// field: null for a yes/no question, or { value, placeholder, maxLength } for
// a short text. Resolves with true/false, or with the text / null.
function showDialog({ title, text = '', ok = 'موافق', cancel = 'إلغاء', danger = false, field = null }) {
  if (open) open.finish(null);
  const back = document.activeElement;
  return new Promise((resolve) => {
    const okBtn = el('button', { type: 'button', class: `btn ${danger ? 'danger' : 'primary'} dlg-ok` }, ok);
    const cancelBtn = el('button', { type: 'button', class: 'btn ghost dlg-cancel' }, cancel);
    const input = field ? el('input', { type: 'text', class: 'dlg-input', dir: 'auto', maxlength: String(field.maxLength || 60), placeholder: field.placeholder || '', 'aria-label': title || text }) : null;
    if (input) input.value = field.value || '';
    const box = el(
      'div',
      { class: 'dlg', role: field ? 'dialog' : 'alertdialog', 'aria-modal': 'true', 'aria-label': title || text },
      title ? el('h3', { class: 'dlg-title' }, title) : null,
      text ? el('p', { class: 'dlg-text' }, text) : null,
      input,
      el('div', { class: 'dlg-actions' }, okBtn, cancelBtn),
    );
    const layer = el('div', { class: 'dlg-layer' }, box);
    const finish = (value) => {
      if (!open || open.layer !== layer) return;
      open = null;
      document.removeEventListener('keydown', onKey, true);
      layer.remove();
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
      resolve(field ? (value === true ? input.value.trim() : null) : value === true);
    };
    const order = [input, okBtn, cancelBtn].filter(Boolean);
    // While it is open no other shortcut runs (page switches, studio keys).
    const onKey = (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Tab') {
        // Keep the focus inside the dialog.
        e.preventDefault();
        const i = order.indexOf(document.activeElement);
        order[(i + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
      } else if (input && document.activeElement === input) {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true);
        }
        // Other keys type into the field.
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
    if (input) {
      input.focus();
      input.select();
    } else {
      // A dangerous action starts on "cancel", so Enter does not delete by accident.
      (danger ? cancelBtn : okBtn).focus();
    }
  });
}

// confirmDialog({ title, text, ok, cancel, danger }) -> Promise<boolean>
export function confirmDialog(opts) {
  return showDialog({ ...opts, field: null });
}

// promptDialog({ title, text, value, placeholder, maxLength, ok, cancel }) -> Promise<string|null>
export function promptDialog({ value = '', placeholder = '', maxLength = 60, ...opts }) {
  return showDialog({ ...opts, field: { value, placeholder, maxLength } });
}
