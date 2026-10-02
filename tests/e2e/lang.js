// Interface language: Arabic by default; switching to English in Settings >
// General reloads the page left-to-right with English labels everywhere (no
// Arabic left on any page or settings section, the language choice aside),
// English catalog notes and default instructions; it survives a restart;
// switching back restores Arabic. Both dictionaries have the same keys.
const { _electron } = require('playwright-core');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const ARABIC = /[؀-ۿ]/;

const launch = async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  return { app, win };
};

(async () => {
  // Same keys in both dictionaries (and the same kinds of values).
  const keys = await import(root + '/src/renderer/i18n/ar.js').then(async ({ ar }) => {
    const { en } = await import(root + '/src/renderer/i18n/en.js');
    const out = [];
    const cmp = (a, b, p) => {
      const ta = Array.isArray(a) ? 'array' : typeof a, tb = Array.isArray(b) ? 'array' : typeof b;
      if (ta !== tb) return out.push(`${p}: ${ta}/${tb}`);
      if (ta === 'array') { if (a.length !== b.length) out.push(`${p}: ${a.length}/${b.length}`); return a.forEach((x, i) => cmp(x, b[i], `${p}[${i}]`)); }
      if (ta === 'object' && a) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { if (!(k in a) || !(k in b)) out.push(`${p}.${k}`); else cmp(a[k], b[k], `${p}.${k}`); } }
    };
    cmp(ar, en, 'ui');
    return out;
  });
  check('Arabic and English dictionaries have the same keys', keys.length === 0, keys.slice(0, 5).join(', '));

  let { app, win } = await launch();
  const logs = []; const watch = (w) => w.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  watch(win);
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: true, language: 'ar' }));
  await win.evaluate(() => { try { localStorage.setItem('blazma.lang', 'ar'); } catch {} });
  await win.reload(); await win.waitForLoadState('load');
  check('Arabic by default: right-to-left, Arabic labels', (await win.evaluate(() => document.documentElement.dir)) === 'rtl' && (await win.locator('.nav-item[data-page="chat"]').innerText()).includes('المحادثة'));

  // Switch to English from Settings > General.
  await win.click('.nav-item[data-page="settings"]');
  await win.click('.set-toc button[data-target="general"]');
  await Promise.all([win.waitForEvent('load'), win.locator('select').first().selectOption('en')]);
  await win.waitForTimeout(800);
  const dir = await win.evaluate(() => document.documentElement.dir);
  check('English: left-to-right, English labels', dir === 'ltr' && (await win.locator('.nav-item[data-page="chat"]').innerText()).trim() === 'Chat' && (await win.getAttribute('#chat-input', 'placeholder')) === 'Type your message…', dir);
  const st = await win.evaluate(() => window.blazma.getSettings());
  check('default instructions switch to English', st.language === 'en' && /^You are a helpful/.test(st.systemPrompt), st.systemPrompt.slice(0, 40));

  // No Arabic left on any page or settings section (chat contents aside).
  const arabicOn = (label) => win.evaluate((label) => {
    // Chat contents and names the user typed (chats, folders) are not interface text.
    const skip = (n) => n.closest('#chat-log, #chat-items, #chat-folders, select, .chat-item, code');
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const hits = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const p = n.parentElement;
      if (!p || skip(p) || !p.getClientRects().length || getComputedStyle(p).visibility === 'hidden') continue;
      if (/[؀-ۿ]/.test(n.textContent)) hits.push(n.textContent.trim().slice(0, 50));
    }
    for (const e of document.querySelectorAll('[title], [aria-label], [placeholder]')) {
      if (!e.getClientRects().length || skip(e)) continue;
      for (const a of ['title', 'aria-label', 'placeholder']) if (/[؀-ۿ]/.test(e.getAttribute(a) || '')) hits.push(`${a}: ${e.getAttribute(a).slice(0, 50)}`);
    }
    return hits;
  }, label);
  const allHits = [];
  for (const page of ['chat', 'studio', 'device', 'models']) {
    await win.click(`.nav-item[data-page="${page}"]`); await win.waitForTimeout(900);
    for (const h of await arabicOn(page)) allHits.push(`${page}: ${h}`);
    await win.screenshot({ path: `${SP}/lang-en-${page}.png` });
  }
  await win.click('.nav-item[data-page="settings"]');
  for (const tab of ['general', 'chat', 'kb', 'engine', 'monitor', 'api', 'updates', 'about']) {
    await win.click(`.set-toc button[data-target="${tab}"]`); await win.waitForTimeout(400);
    for (const h of await arabicOn(tab)) allHits.push(`settings/${tab}: ${h}`);
  }
  await win.screenshot({ path: `${SP}/lang-en-settings.png` });
  // The language label shows both names so either reader finds it.
  const leftover = allHits.filter((h) => !/اللغة|العربية/.test(h));
  check('no Arabic left in the English interface', leftover.length === 0, leftover.slice(0, 8).join(' ; '));
  const list = await win.evaluate(() => window.blazma.getSetupState().then((s) => s.models.slice(0, 3).map((m) => m.note)));
  check('catalog notes in English', list.every((n) => n && !ARABIC_TEST(n)), list.join(' | ').slice(0, 120));

  // Kept after a restart.
  await app.close();
  ({ app, win } = await launch()); watch(win);
  await win.waitForTimeout(800);
  check('English kept after restart', (await win.evaluate(() => document.documentElement.dir)) === 'ltr' && (await win.locator('.nav-item[data-page="chat"]').innerText()).trim() === 'Chat');

  // And back to Arabic.
  await win.click('.nav-item[data-page="settings"]');
  await win.click('.set-toc button[data-target="general"]');
  await Promise.all([win.waitForEvent('load'), win.locator('select').first().selectOption('ar')]);
  await win.waitForTimeout(800);
  const back = await win.evaluate(() => window.blazma.getSettings());
  check('back to Arabic: right-to-left, Arabic instructions', (await win.evaluate(() => document.documentElement.dir)) === 'rtl' && back.language === 'ar' && back.systemPrompt.startsWith('أنت مساعد'));

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed || logs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });

function ARABIC_TEST(s) { return ARABIC.test(s); }
