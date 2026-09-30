// Command palette / quick open (Ctrl+Shift+P, Ctrl+P), like VS Code:
// typing ">" lists commands, ":" goes to a line, anything else finds files.

import { el } from '../lib/dom.js';

// Subsequence match; returns a score (lower is better) or -1.
function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const direct = t.indexOf(q);
  if (direct >= 0) return direct;
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = t.indexOf(ch, pos + 1);
    if (next < 0) return -1;
    gaps += next - pos - 1;
    pos = next;
  }
  return 100 + gaps;
}

export function createPalette(P, providers) {
  const input = el('input', { type: 'text', class: 'pal-input', spellcheck: 'false', dir: 'auto', 'aria-label': P.label });
  const list = el('div', { class: 'pal-list', role: 'listbox' });
  const box = el('div', { class: 'pal', role: 'dialog' }, input, list);
  const overlay = el('div', { class: 'pal-overlay', hidden: true }, box);

  let items = [];
  let index = 0;
  let restoreFocus = null;
  let custom = null; // { kind: 'pick', choices } | { kind: 'prompt', hint, resolve }

  function mode() {
    const v = input.value;
    if (custom && custom.kind === 'prompt') return { kind: 'prompt' };
    if (custom && custom.kind === 'pick' && !v.startsWith('>')) return { kind: 'pick', q: v.trim() };
    if (v.startsWith('>')) return { kind: 'commands', q: v.slice(1).trim() };
    if (v.startsWith(':')) return { kind: 'line', q: v.slice(1).trim() };
    return { kind: 'files', q: v.trim() };
  }

  function render() {
    const m = mode();
    if (m.kind === 'prompt') {
      items = [{ label: custom.hint, run: () => {} }];
    } else if (m.kind === 'line') {
      const n = parseInt(m.q, 10);
      const total = providers.lineCount();
      items = [
        {
          label: Number.isFinite(n) ? P.gotoLine(n, total) : P.typeLine(total),
          run: () => Number.isFinite(n) && providers.gotoLine(n),
        },
      ];
    } else {
      const source = m.kind === 'commands' ? providers.commands() : m.kind === 'pick' ? custom.choices : providers.files();
      items = source
        .map((it) => ({ it, score: Math.min(...[it.label, it.detail || '', it.id || ''].map((t) => fuzzy(m.q, t)).map((s) => (s < 0 ? Infinity : s))) }))
        .filter((x) => x.score !== Infinity)
        .sort((a, b) => a.score - b.score)
        .slice(0, 60)
        .map((x) => x.it);
      if (!items.length) items = [{ label: m.kind === 'commands' ? P.noCommands : P.noFiles, disabled: true }];
    }
    index = Math.min(index, items.length - 1);
    list.replaceChildren(
      ...items.map((it, i) => {
        const row = el(
          'div',
          { class: `pal-item${i === index ? ' active' : ''}${it.disabled ? ' disabled' : ''}`, role: 'option' },
          it.icon || null,
          el('span', { class: 'pal-label', dir: 'auto' }, it.label),
          it.detail ? el('span', { class: 'pal-detail', dir: 'auto' }, it.detail) : null,
          it.key ? el('kbd', { dir: 'ltr' }, it.key) : null,
        );
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          index = i;
          accept();
        });
        return row;
      }),
    );
    const active = list.children[index];
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function close() {
    overlay.hidden = true;
    const pending = custom;
    custom = null;
    if (restoreFocus && document.contains(restoreFocus)) restoreFocus.focus();
    if (pending && pending.kind === 'prompt') pending.resolve(null);
  }

  function accept() {
    if (custom && custom.kind === 'prompt') {
      const { resolve } = custom;
      const value = input.value.trim();
      custom = null;
      close();
      resolve(value || null);
      return;
    }
    const it = items[index];
    if (!it || it.disabled) return;
    close();
    it.run();
  }

  input.addEventListener('input', () => {
    index = 0;
    render();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      index = (index + 1) % items.length;
      render();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      index = (index - 1 + items.length) % items.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      accept();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('blur', () => setTimeout(() => !overlay.hidden && document.activeElement !== input && close(), 0));
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });

  return {
    root: overlay,
    open(prefix = '') {
      restoreFocus = document.activeElement;
      overlay.hidden = false;
      input.value = prefix;
      index = 0;
      input.placeholder = prefix === '>' ? P.commandsPlaceholder : prefix === ':' ? P.linePlaceholder : P.filesPlaceholder;
      render();
      input.focus();
    },
    // A one-off list (e.g. choosing a project).
    pick(placeholder, choices) {
      if (!overlay.hidden) close();
      custom = { kind: 'pick', choices };
      restoreFocus = document.activeElement;
      overlay.hidden = false;
      input.value = '';
      input.placeholder = placeholder;
      index = 0;
      render();
      input.focus();
    },
    // Asks for a line of text; resolves null when cancelled.
    prompt(placeholder, value = '', hint = P.pressEnter) {
      if (!overlay.hidden) close();
      return new Promise((resolve) => {
        custom = { kind: 'prompt', hint, resolve };
        restoreFocus = document.activeElement;
        overlay.hidden = false;
        input.value = value;
        input.placeholder = placeholder;
        render();
        input.focus();
        input.select();
      });
    },
    isOpen: () => !overlay.hidden,
  };
}
