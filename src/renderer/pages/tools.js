// "أدوات بلازما": the rest of the Blazma family, with their GitHub page and,
// for the PowerShell tools, the one-line command that runs them.

import { ui } from '../i18n/index.js';
import { el } from '../lib/dom.js';

const T = ui.v2.tools;
const TOOLS = [
  { id: 'boost', name: 'Blazma Boost', repo: 'Blazma-Boost', cmd: 'irm mr-kateba.github.io/win | iex' },
  { id: 'tweak', name: 'Blazma Tweak', repo: 'Blazma-Tweak', cmd: 'irm mr-kateba.github.io/tweak | iex' },
  { id: 'get', name: 'Blazma Get', repo: 'Blazma-Get' },
  { id: 'cyber', name: 'Blazma Cyber', repo: 'Blazma-Cyber' },
  { id: 'sandbox', name: 'Blazma Sandbox', repo: 'Blazma-Sandbox' },
  { id: 'crosshair', name: 'Blazma Crosshair', repo: 'blazma-Crosshair' },
  { id: 'nt', name: 'blazma.nt', repo: 'blazma-nt' },
  { id: 'animation', name: 'Blazma Animation', repo: 'blazma-Animation' },
];

let built = false;

function card(t) {
  const open = el('button', { type: 'button', class: 'btn ghost small' }, T.page);
  open.addEventListener('click', () => window.blazma.openExternal(`https://github.com/mr-kateba/${t.repo}`));
  let copy = null;
  if (t.cmd) {
    copy = el('button', { type: 'button', class: 'btn primary small' }, T.copyCmd);
    copy.addEventListener('click', () =>
      navigator.clipboard.writeText(t.cmd).then(() => {
        copy.textContent = T.copied;
        setTimeout(() => (copy.textContent = T.copyCmd), 2500);
      }),
    );
  }
  return el(
    'article',
    { class: 'tool-card' },
    el('div', { class: 'tool-card-head' }, el('img', { src: `tools/${t.id}.svg`, alt: '' }), el('h3', { dir: 'ltr' }, t.name)),
    el('p', null, T.list[t.id]),
    t.cmd ? el('code', { dir: 'ltr' }, t.cmd) : null,
    el('div', { class: 'row tool-card-actions' }, copy, open),
  );
}

export function setToolsVisible(visible) {
  if (!visible || built) return;
  built = true;
  const site = el('button', { type: 'button', class: 'btn ghost' }, T.site);
  site.addEventListener('click', () => window.blazma.openExternal('https://mr-kateba.github.io'));
  document.getElementById('tools-root').replaceChildren(el('div', { class: 'tools-grid' }, ...TOOLS.map(card)), el('div', { class: 'tools-foot' }, site));
}
