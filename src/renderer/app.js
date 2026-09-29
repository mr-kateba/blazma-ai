import { ar } from './i18n/ar.js';
import { initChat } from './pages/chat.js';

const PAGES = ['chat', 'device', 'models', 'settings'];

function showPage(name) {
  if (!PAGES.includes(name)) name = PAGES[0];
  for (const section of document.querySelectorAll('.page')) {
    section.hidden = section.dataset.page !== name;
  }
  for (const item of document.querySelectorAll('.nav-item')) {
    if (item.dataset.page === name) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  }
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

showPage('chat');
showVersion();
initChat();
