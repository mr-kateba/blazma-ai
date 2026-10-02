import { ui, LANG, DIR } from './i18n/index.js';
import { initChat } from './pages/chat.js';
import { initDevice, setDeviceVisible } from './pages/device.js';
import { setSettingsVisible } from './pages/settings.js';
import { setStudioVisible, openCodeInStudio } from './pages/studio.js';
import { initModels, setModelsVisible } from './pages/models.js';
import { initOverlay, setOverlayChatVisible } from './pages/overlay.js';
import { el } from './lib/dom.js';
import { initTooltips } from './lib/tooltip.js';
import { startTour } from './lib/tour.js';

const PAGES = ['chat', 'studio', 'device', 'models', 'settings'];

// Interface language (Settings > General): writing direction and the fixed
// labels of index.html.
document.documentElement.lang = LANG;
document.documentElement.dir = DIR;
for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = ui.html[n.dataset.i18n];
for (const n of document.querySelectorAll('[data-i18n-label]')) n.setAttribute('aria-label', ui.html[n.dataset.i18nLabel]);
for (const n of document.querySelectorAll('[data-i18n-title]')) n.title = ui.html[n.dataset.i18nTitle];
for (const n of document.querySelectorAll('[data-i18n-ph]')) n.placeholder = ui.html[n.dataset.i18nPh];
// The language saved in settings wins (the page keeps a copy to know it
// before anything is drawn); reload once if the two differ.
window.blazma.getSettings().then((s) => {
  const want = s.language === 'en' ? 'en' : 'ar';
  if (want === LANG) return;
  try {
    localStorage.setItem('blazma.lang', want);
    if (localStorage.getItem('blazma.lang') === want) location.reload();
  } catch {
    /* no storage: stays in the default language */
  }
});

// Light or dark, chosen in Settings → General ("system" follows Windows).
function applyTheme({ dark }) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.dispatchEvent(new Event('blazma:theme'));
}
initTooltips();
window.blazma.getTheme().then(applyTheme);
window.blazma.onThemeChanged(applyTheme);

function showPage(name) {
  if (!PAGES.includes(name)) name = PAGES[0];
  for (const section of document.querySelectorAll('.page')) {
    section.hidden = section.dataset.page !== name;
  }
  for (const item of document.querySelectorAll('.nav-item')) {
    if (item.dataset.page === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
  document.body.classList.toggle('compact-nav', name === 'studio');
  setDeviceVisible(name === 'device');
  setStudioVisible(name === 'studio');
  setModelsVisible(name === 'models');
  setSettingsVisible(name === 'settings');
  setOverlayChatVisible(name === 'chat');
}

// Temperature / slowdown alerts appear on every page.
function showAlerts(alerts) {
  const box = document.getElementById('global-alerts');
  box.replaceChildren(
    ...alerts.map((a) => el('div', { class: `alert alert-${a.level}` }, ui.alerts[a.code] ? ui.alerts[a.code](a) : a.code)),
  );
}

async function showVersion() {
  const el = document.getElementById('app-version');
  try {
    const info = await window.blazma.getAppInfo();
    el.textContent = info.version;
  } catch {
    el.textContent = ui.versionUnknown;
  }
}

for (const item of document.querySelectorAll('.nav-item')) {
  // Tooltip (the sidebar shows icons only in the studio) with the shortcut.
  item.title = `${item.textContent.trim()} (Ctrl+${PAGES.indexOf(item.dataset.page) + 1})`;
  item.addEventListener('click', () => showPage(item.dataset.page));
}

initDevice();
initModels();
initChat();
initOverlay();
window.blazma.onAlerts(showAlerts);
// Ctrl+1 … Ctrl+5 switch pages (by key position, so any keyboard layout works).
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  const m = /^Digit([1-5])$/.exec(e.code);
  if (!m) return;
  e.preventDefault();
  showPage(PAGES[Number(m[1]) - 1]);
});

// Esc closes a drop-down menu (model switch, persona, export), like a click outside.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const menus = document.querySelectorAll('.model-menu');
  if (!menus.length) return;
  menus.forEach((m) => m.remove());
  e.stopPropagation();
});

// Links between pages (e.g. "إدارة الموديلات" in the chat's model menu).
window.addEventListener('blazma:show-page', (e) => showPage(String(e.detail)));

// Guided tour: once, the first time the chat is ready; again from settings.
function runTour() {
  showPage('chat');
  const T = ui.tour;
  startTour(T.steps, T, () => window.blazma.updateSettings({ tourDone: true }));
}
window.addEventListener('blazma:start-tour', runTour);
let tourChecked = false;
async function maybeTour(state) {
  if (tourChecked || !state || state.phase !== 'ready') return;
  tourChecked = true;
  offTourWatch();
  const st = await window.blazma.getSettings();
  if (st.tourDone) return;
  // Wait until the user is on the chat page with no dialog open, so the tour
  // never pulls them away from something or covers a question.
  const tryStart = () => {
    const onChat = !document.querySelector('.page[data-page="chat"]').hidden;
    if (onChat && !document.querySelector('.dlg-layer') && !document.querySelector('.tour-layer')) runTour();
    else setTimeout(tryStart, 1500);
  };
  setTimeout(tryStart, 600);
}
const offTourWatch = window.blazma.onSetupState(maybeTour);
window.blazma.getSetupState().then(maybeTour);
// "افتح في VS Code" on a code block in the chat (saved, then the page opens).
window.addEventListener('blazma:open-in-studio', (e) => openCodeInStudio(e.detail.code, e.detail.lang));
showPage('chat');
showVersion();
