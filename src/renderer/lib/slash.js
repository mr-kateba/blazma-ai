// Quick commands in the chat box: "/ترجم النص" sends the text with a fixed
// instruction in front of it (ui.chat.slash). Typing "/" opens a list of the
// commands; arrows or the mouse pick one, Enter or Tab puts it in the box.

import { ui } from '../i18n/index.js';
import { el } from './dom.js';

// Arabic written with or without marks and hamza forms matches the same command.
function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}

const commands = () => ui.chat.slash;

export function commandById(id) {
  return commands().find((c) => c.id === id) || null;
}

// The command a message starts with: "/name rest". Names with a space
// ("أعد الصياغة") are matched before shorter ones.
export function parseCommand(text) {
  const t = String(text || '');
  if (!t.startsWith('/')) return null;
  const body = norm(t.slice(1));
  const names = commands()
    .flatMap((c) => [c.name, ...c.aliases].map((n) => ({ c, n: norm(n) })))
    .sort((a, b) => b.n.length - a.n.length);
  for (const { c, n } of names) {
    if (body === n || body.startsWith(`${n} `) || body.startsWith(`${n}\n`)) {
      // Cut the same number of characters from the original text: norm()
      // removes marks, so count them back in.
      let i = 1;
      let seen = 0;
      while (i < t.length && seen < n.length) {
        if (norm(t[i])) seen++;
        i++;
      }
      while (i < t.length && /[ً-ْـ]/.test(t[i])) i++;
      return { command: c.id, rest: t.slice(i).trim() };
    }
  }
  return null;
}

// The instruction for the model, in front of the user's text.
export function withCommand(command, text) {
  const c = commandById(command);
  return c ? `${c.prompt}\n\n${text}` : text;
}

// The list under/above the chat box. Returns nothing; works on its own.
export function attachSlashMenu(input) {
  let menu = null;
  let items = [];
  let active = 0;

  const close = () => {
    if (menu) menu.remove();
    menu = null;
    items = [];
  };
  const pick = (c) => {
    input.value = `/${c.name} `;
    input.dispatchEvent(new Event('input'));
    close();
    input.focus();
  };
  const paint = () => {
    if (!menu) return;
    [...menu.querySelectorAll('.slash-item')].forEach((b, i) => {
      b.classList.toggle('active', i === active);
      b.setAttribute('aria-selected', i === active ? 'true' : 'false');
      if (i === active) b.scrollIntoView({ block: 'nearest' });
    });
  };
  const open = (list) => {
    close();
    items = list;
    active = 0;
    menu = el(
      'div',
      { class: 'slash-menu', role: 'listbox', 'aria-label': ui.chat.slashTitle },
      el('div', { class: 'slash-head' }, ui.chat.slashTitle),
      ...list.map((c) => {
        const b = el('button', { type: 'button', class: 'slash-item', role: 'option' }, el('b', null, `/${c.name}`), el('span', { class: 'muted small' }, c.desc));
        b.addEventListener('mousedown', (e) => e.preventDefault()); // keep the caret in the box
        b.addEventListener('click', () => pick(c));
        return b;
      }),
    );
    input.closest('.composer').append(menu);
    paint();
  };
  const update = () => {
    const v = input.value;
    // Only while the first word is being typed.
    if (!v.startsWith('/') || /\s/.test(v)) return close();
    const q = norm(v.slice(1));
    const list = commands().filter((c) => [c.name, ...c.aliases].some((n) => norm(n).startsWith(q)));
    if (!list.length) return close();
    open(list);
  };

  input.addEventListener('input', update);
  // Closed when the focus moves to something else on the page (not when the
  // whole window loses focus, e.g. switching to another program and back).
  input.addEventListener('blur', () => setTimeout(() => document.activeElement !== input && close(), 100));
  // Registered before the chat's own Enter handler, so Enter picks instead of sending.
  input.addEventListener('keydown', (e) => {
    if (!menu) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
      paint();
    } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      pick(items[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
}
