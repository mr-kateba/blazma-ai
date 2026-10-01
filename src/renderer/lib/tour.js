// A guided tour: a dimmed screen with a lit-up hole around one button or
// area at a time, and a card explaining it. Steps whose element is missing
// or hidden are skipped. Keys: → / ← move (in RTL "next" is to the left),
// Esc ends it.

import { el } from './dom.js';

let active = null;

// steps: [{ target?: selector, title, text }]
// labels: { next, prev, skip, done, step(n, total) }
export function startTour(steps, labels, onEnd = () => {}) {
  if (active) active.end(false);
  const layer = el('div', { class: 'tour-layer' });
  const hole = el('div', { class: 'tour-hole' });
  const card = el('div', { class: 'tour-card', role: 'dialog', 'aria-modal': 'true' });
  layer.append(hole, card);
  document.body.append(layer);

  let index = -1;
  let shown = null; // element currently lit

  const visible = (node) => node && node.isConnected && node.getClientRects().length > 0 && !node.closest('[hidden]');

  function position() {
    const step = steps[index];
    const target = step && step.target ? document.querySelector(step.target) : null;
    if (!visible(target)) {
      hole.hidden = true;
      card.classList.add('centered');
      card.style.left = '';
      card.style.top = '';
      return;
    }
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.hidden = false;
    Object.assign(hole.style, { left: `${r.left - pad}px`, top: `${r.top - pad}px`, width: `${r.width + pad * 2}px`, height: `${r.height + pad * 2}px` });
    card.classList.remove('centered');
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    // Below the element if it fits, else above; horizontally near it.
    let top = r.bottom + 14;
    if (top + ch > window.innerHeight - 8) top = r.top - 14 - ch;
    if (top < 8) top = Math.min(window.innerHeight - ch - 8, Math.max(8, r.top));
    let left = r.left + r.width / 2 - cw / 2;
    // Tall side elements (the page list): put the card beside them.
    if (r.height > window.innerHeight * 0.5) {
      left = r.left - cw - 16 > 8 ? r.left - cw - 16 : r.right + 16;
      top = Math.max(8, Math.min(window.innerHeight - ch - 8, r.top));
    }
    left = Math.max(8, Math.min(left, window.innerWidth - cw - 8));
    card.style.left = `${Math.round(left)}px`;
    card.style.top = `${Math.round(top)}px`;
  }

  function go(to) {
    // Skip steps whose element is not on screen (e.g. a hidden button).
    let i = to;
    const dir = to >= index ? 1 : -1;
    while (i >= 0 && i < steps.length) {
      const s = steps[i];
      if (!s.target || visible(document.querySelector(s.target))) break;
      i += dir;
    }
    if (i >= steps.length) return end(true);
    if (i < 0) return;
    index = i;
    const step = steps[index];
    const last = index === steps.length - 1;
    const prev = el('button', { type: 'button', class: 'btn ghost small', disabled: index === 0 }, labels.prev);
    const next = el('button', { type: 'button', class: 'btn primary small tour-next' }, last ? labels.done : labels.next);
    const skip = el('button', { type: 'button', class: 'tour-skip' }, labels.skip);
    prev.addEventListener('click', () => go(index - 1));
    next.addEventListener('click', () => go(index + 1));
    skip.addEventListener('click', () => end(true));
    card.replaceChildren(
      el('div', { class: 'tour-head' }, el('span', { class: 'tour-count' }, labels.step(index + 1, steps.length)), last ? null : skip),
      el('h3', null, step.title),
      el('p', null, step.text),
      el('div', { class: 'tour-actions' }, next, prev),
    );
    shown = step.target ? document.querySelector(step.target) : null;
    if (visible(shown)) shown.scrollIntoView({ block: 'nearest' });
    position();
    next.focus();
  }

  // Keys stay with the tour: nothing reaches the page behind it.
  const onKey = (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') end(true);
    else if (e.key === 'ArrowLeft') go(index + 1);
    else if (e.key === 'ArrowRight' && index > 0) go(index - 1);
    else if (e.key === 'Tab') {
      const buttons = [...card.querySelectorAll('button:not([disabled])')];
      const at = buttons.indexOf(document.activeElement);
      buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    } else if (['Enter', ' '].includes(e.key) && card.contains(document.activeElement)) return;
    e.preventDefault();
  };
  const onResize = () => position();

  function end(finished) {
    if (!active || active.layer !== layer) return;
    active = null;
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', onResize);
    layer.remove();
    onEnd(finished);
  }

  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  active = { layer, end };
  go(0);
}
