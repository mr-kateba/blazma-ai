import { ar } from './i18n/ar.js';
import { initChat } from './pages/chat.js';
import { initDevice, setDeviceVisible } from './pages/device.js';
import { setSettingsVisible } from './pages/settings.js';
import { setStudioVisible, openCodeInStudio } from './pages/studio.js';
import { initModels, setModelsVisible } from './pages/models.js';
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
  setDeviceVisible(name === 'device');
  setStudioVisible(name === 'studio');
  setModelsVisible(name === 'models');
  setSettingsVisible(name === 'settings');
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
  item.addEventListener('click', () => showPage(item.dataset.page));
}

initDevice();
initModels();
initChat();
window.blazma.onAlerts(showAlerts);
// "فتح في الاستوديو" on a code block in the chat.
window.addEventListener('blazma:open-in-studio', (e) => {
  showPage('studio');
  openCodeInStudio(e.detail.code, e.detail.lang);
});
showPage('chat');
showVersion();
