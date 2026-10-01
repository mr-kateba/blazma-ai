import { ar } from './i18n/ar.js';
import { initChat } from './pages/chat.js';
import { initDevice, setDeviceVisible } from './pages/device.js';
import { setSettingsVisible } from './pages/settings.js';
import { setStudioVisible, openCodeInStudio } from './pages/studio.js';
import { initModels, setModelsVisible } from './pages/models.js';
import { initOverlay, setOverlayChatVisible } from './pages/overlay.js';
import { el } from './lib/dom.js';

const PAGES = ['chat', 'studio', 'device', 'models', 'settings'];

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
    ...alerts.map((a) => el('div', { class: `alert alert-${a.level}` }, ar.alerts[a.code] ? ar.alerts[a.code](a) : a.code)),
  );
}

async function showVersion() {
  const el = document.getElementById('app-version');
  try {
    const info = await window.blazma.getAppInfo();
    el.textContent = info.version;
  } catch {
    el.textContent = ar.versionUnknown;
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

// Links between pages (e.g. "إدارة الموديلات" in the chat's model menu).
window.addEventListener('blazma:show-page', (e) => showPage(String(e.detail)));
// "فتح في الاستوديو" on a code block in the chat.
window.addEventListener('blazma:open-in-studio', (e) => {
  showPage('studio');
  openCodeInStudio(e.detail.code, e.detail.lang);
});
showPage('chat');
showVersion();
