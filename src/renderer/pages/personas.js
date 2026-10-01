// Personas ("الشخصيات"): ready-made and user-made instructions for the
// model, chosen per chat from the chat header. The built-in ones are in
// ar.js; custom ones are stored by the main process (personas.js).

import { ar } from '../i18n/ar.js';
import { el } from '../lib/dom.js';

const P = ar.personas;
let custom = [];

export async function loadPersonas() {
  custom = await window.blazma.personasList();
  return allPersonas();
}

// 'general' uses the instructions from the settings page (prompt: null).
export function allPersonas() {
  return [...P.builtin.map((p) => ({ ...p, builtin: true })), ...custom.map((p) => ({ ...p, builtin: false }))];
}

export function personaById(id) {
  return allPersonas().find((p) => p.id === id) || allPersonas()[0];
}

function closeMenu() {
  const m = document.querySelector('.persona-menu');
  if (m) m.remove();
  document.removeEventListener('mousedown', outside);
}

function outside(e) {
  if (!e.target.closest('.persona-menu') && !e.target.closest('#persona-pill')) closeMenu();
}

export function openPersonaMenu(anchor, currentId, onPick) {
  if (document.querySelector('.persona-menu')) {
    closeMenu();
    return;
  }
  const items = allPersonas().map((p) => {
    const row = el(
      'button',
      { type: 'button', class: `model-menu-item${p.id === currentId ? ' current' : ''}`, role: 'menuitem' },
      el('span', { class: 'persona-row' }, el('span', { class: 'persona-icon', 'aria-hidden': 'true' }, p.icon), el('span', null, el('b', null, p.name), el('span', { class: 'muted small persona-desc' }, p.desc || P.customDesc))),
    );
    row.addEventListener('click', () => {
      closeMenu();
      onPick(p.id);
    });
    return row;
  });
  const manage = el('button', { type: 'button', class: 'model-menu-item more' }, P.manage);
  manage.addEventListener('click', () => {
    closeMenu();
    openPersonaEditor(() => onPick(currentId));
  });
  const menu = el('div', { class: 'model-menu persona-menu', role: 'menu' }, el('div', { class: 'model-menu-head' }, P.choose), ...items, manage);
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 6}px`;
  menu.style.right = `${window.innerWidth - r.right}px`;
  document.body.append(menu);
  setTimeout(() => document.addEventListener('mousedown', outside), 0);
}

// Create, edit and delete custom personas.
export function openPersonaEditor(onChange) {
  const overlay = el('div', { class: 'modal-overlay' });
  const close = () => {
    overlay.remove();
    onChange();
  };
  const name = el('input', { type: 'text', maxlength: '40', placeholder: P.namePh, dir: 'auto' });
  const icon = el('input', { type: 'text', maxlength: '4', placeholder: '🙂', class: 'persona-icon-input' });
  const prompt = el('textarea', { rows: '6', placeholder: P.promptPh, dir: 'auto' });
  const status = el('div', { class: 'muted small' });
  let editingId = null;
  const listBox = el('div', { class: 'persona-list' });

  const fill = (p) => {
    editingId = p ? p.id : null;
    name.value = p ? p.name : '';
    icon.value = p ? p.icon : '';
    prompt.value = p ? p.prompt : '';
    saveBtn.textContent = p ? P.update : P.add;
    name.focus();
  };

  const renderList = () => {
    listBox.replaceChildren(
      ...(custom.length
        ? custom.map((p) => {
            const edit = el('button', { type: 'button', class: 'btn ghost small' }, P.edit);
            edit.addEventListener('click', () => fill(p));
            const del = el('button', { type: 'button', class: 'btn ghost small' }, P.remove);
            del.addEventListener('click', async () => {
              if (!window.confirm(P.confirmRemove(p.name))) return;
              await window.blazma.personasDelete(p.id);
              await loadPersonas();
              if (editingId === p.id) fill(null);
              renderList();
            });
            return el('div', { class: 'persona-item' }, el('span', { class: 'persona-icon' }, p.icon), el('b', { dir: 'auto' }, p.name), el('span', { class: 'spacer' }), edit, del);
          })
        : [el('p', { class: 'muted small' }, P.none)]),
    );
  };

  const saveBtn = el('button', { type: 'button', class: 'btn primary' }, P.add);
  saveBtn.addEventListener('click', async () => {
    const res = await window.blazma.personasSave({ id: editingId, name: name.value, icon: icon.value, prompt: prompt.value });
    if (!res.ok) {
      status.textContent = P.invalid;
      return;
    }
    status.textContent = P.saved(res.result.name);
    await loadPersonas();
    renderList();
    fill(null);
  });
  const newBtn = el('button', { type: 'button', class: 'btn ghost' }, P.newOne);
  newBtn.addEventListener('click', () => fill(null));
  const closeBtn = el('button', { type: 'button', class: 'btn' }, P.close);
  closeBtn.addEventListener('click', close);

  const modal = el(
    'div',
    { class: 'modal', role: 'dialog', 'aria-label': P.manage },
    el('h2', null, P.manage),
    el('p', { class: 'muted small' }, P.intro),
    listBox,
    el('div', { class: 'persona-form' }, el('div', { class: 'row' }, icon, name), prompt, el('div', { class: 'row' }, saveBtn, newBtn, el('span', { class: 'spacer' }), closeBtn), status),
  );
  overlay.append(modal);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && close());
  overlay.addEventListener('keydown', (e) => e.key === 'Escape' && close());
  document.body.append(overlay);
  renderList();
  fill(null);
}
