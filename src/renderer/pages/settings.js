// Settings page. Phase 2 covers the "جهازي" options; the rest come in phase 3.

import { ar } from '../i18n/ar.js';
import { el } from '../lib/dom.js';
import { refreshDeviceInfo } from './device.js';

const S = ar.settingsPage;
const $ = (id) => document.getElementById(id);

async function render() {
  const [values, info] = await Promise.all([window.blazma.getSettings(), window.blazma.monitorInfo()]);
  const auto = values.gpuTempWarn === null && values.gpuTempDanger === null;

  const interval = el(
    'select',
    { id: 'set-interval' },
    ...[1000, 2000, 5000].map((ms) => el('option', { value: String(ms), selected: values.monitorIntervalMs === ms }, S.seconds(ms / 1000))),
  );
  const autoBox = el('input', { type: 'checkbox', id: 'set-auto', checked: auto });
  const warn = el('input', { type: 'number', id: 'set-warn', min: '30', max: '110', value: String(values.gpuTempWarn ?? info.thresholds.gpuTempWarn) });
  const danger = el('input', { type: 'number', id: 'set-danger', min: '30', max: '110', value: String(values.gpuTempDanger ?? info.thresholds.gpuTempDanger) });
  const syncDisabled = () => {
    warn.disabled = autoBox.checked;
    danger.disabled = autoBox.checked;
  };
  autoBox.addEventListener('change', syncDisabled);
  syncDisabled();

  const status = el('span', { class: 'muted', id: 'set-status' });
  const save = el('button', { type: 'button', class: 'btn primary' }, S.save);
  save.addEventListener('click', async () => {
    const patch = { monitorIntervalMs: Number(interval.value) };
    if (autoBox.checked) {
      patch.gpuTempWarn = null;
      patch.gpuTempDanger = null;
    } else {
      const w = Number(warn.value);
      const d = Number(danger.value);
      if (!Number.isInteger(w) || !Number.isInteger(d) || w < 30 || d > 110 || w >= d) {
        status.textContent = S.invalid;
        return;
      }
      patch.gpuTempWarn = w;
      patch.gpuTempDanger = d;
    }
    await window.blazma.updateSettings(patch);
    await refreshDeviceInfo();
    status.textContent = S.saved;
    render();
  });

  const row = (label, control) => el('label', { class: 'set-row' }, el('span', null, label), control);
  $('settings-root').replaceChildren(
    el(
      'div',
      { class: 'set-card' },
      el('h2', null, S.monitorTitle),
      row(S.interval, interval),
      el('label', { class: 'set-row check' }, autoBox, el('span', null, S.auto)),
      el('p', { class: 'muted small' }, S.autoNote(info.thresholds.gpuTempWarn, info.thresholds.gpuTempDanger)),
      row(S.warn, warn),
      row(S.danger, danger),
      el('div', { class: 'row' }, save, status),
    ),
    el('p', { class: 'muted' }, S.more),
  );
}

export function setSettingsVisible(v) {
  if (v) render();
}
