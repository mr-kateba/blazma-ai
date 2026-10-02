// Every page, every button, in the dark and the light theme:
// - each button and field has a name (text, title, aria-label or label);
// - clicking it raises no page error (in-app dialogs and menus it opens are
//   closed again; system file dialogs and links are stubbed so nothing leaves
//   the test);
// - nothing sticks out of the window sideways.
// Buttons that download, install or restart something are listed, not clicked:
// their own tests cover them (models, voice, kb, image, vscode, api).
const { _electron } = require('playwright-core');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const SKIP = /افتراضي|تنزيل|تثبيت|إيقاف المحرك|إعادة تشغيل|تحديث المحرك|استخدم|استخدام|تشغيل|اختيار موديل|تحقق|اختبار أداء|ربط|مفتاح جديد|ارسم|رسم|إرسال|أرسل|تسجيل|ميكروفون|تحديث الفهرس|إعادة التوليد|أعد التوليد/;

(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  const errors = []; let where = 'start';
  win.on('pageerror', (e) => errors.push(`${where}: ${e.message}`));
  win.on('console', (m) => m.type() === 'error' && !/Failed to load resource/.test(m.text()) && errors.push(`${where}: ${m.text()}`));
  await app.evaluate(({ dialog, shell }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
    dialog.showSaveDialog = async () => ({ canceled: true });
    shell.openExternal = async () => {};
    shell.openPath = async () => '';
    shell.showItemInFolder = () => {};
  });
  for (let i = 0; i < 1200 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: true, webSearch: false }));

  // A short chat, so the buttons under a reply are there too.
  await win.click('.nav-item[data-page="chat"]');
  await win.fill('#chat-input', 'قل مرحبا في كلمة واحدة.');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 120 && (await win.locator('.msg.assistant .msg-actions button').count()) === 0; i++) await win.waitForTimeout(1000);

  const pageNow = () => win.evaluate(() => (document.querySelector('.nav-item.active') || {}).dataset?.page);
  const stuck = new Set(); // things that do not close with Escape
  const closeAll = async () => {
    const OPEN = '.dlg-layer, .tour-card, .model-menu, .modal, [role="menu"]';
    for (let i = 0; i < 3; i++) {
      const open = await win.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getClientRects().length).map((e) => e.className)[0] || null, OPEN);
      if (!open) return;
      if (i === 1) stuck.add(`${where} → ${open}`);
      if (i === 0) await win.keyboard.press('Escape');
      else if (await win.locator('.dlg-cancel').count()) await win.click('.dlg-cancel');
      else await win.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => e.remove()), OPEN);
      await win.waitForTimeout(250);
    }
  };
  const names = () => win.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const nameOf = (e) => (e.getAttribute('aria-label') || e.title || e.dataset.tip || e.innerText || '').trim().replace(/\s+/g, ' ');
    const buttons = [...document.querySelectorAll('#app button, .page button, main button, nav button, header button')].filter(vis);
    const fields = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')].filter(vis);
    const labelled = (f) => f.getAttribute('aria-label') || f.title || f.placeholder || (f.id && document.querySelector(`label[for="${f.id}"]`)) || f.closest('label');
    return {
      buttons: [...new Set(buttons.map(nameOf))],
      unnamed: buttons.filter((b) => !nameOf(b)).map((b) => b.outerHTML.slice(0, 120)),
      unlabelled: fields.filter((f) => !labelled(f)).map((f) => f.outerHTML.slice(0, 120)),
      overflow: Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, ...[...document.querySelectorAll('.content, .page:not([hidden])')].map((c) => c.scrollWidth - c.clientWidth)),
    };
  });
  const clickByName = (name) => win.evaluate((name) => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    const nameOf = (e) => (e.getAttribute('aria-label') || e.title || e.dataset.tip || e.innerText || '').trim().replace(/\s+/g, ' ');
    const b = [...document.querySelectorAll('#app button, .page button, main button, nav button, header button')].find((e) => vis(e) && nameOf(e) === name && !e.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, name);

  const visit = async (label, open) => {
    where = label;
    await open();
    await win.waitForTimeout(700);
    const before = await names();
    const errs = errors.length;
    const clicked = [], skipped = [];
    for (const name of before.buttons) {
      if (!name || SKIP.test(name)) { skipped.push(name); continue; }
      where = `${label} › ${name}`;
      await open(); await win.waitForTimeout(150);
      if (!(await clickByName(name))) continue;
      clicked.push(name);
      await win.waitForTimeout(350);
      await closeAll();
    }
    where = label;
    await open(); await win.waitForTimeout(300);
    check(`${label}: every button and field has a name`, before.unnamed.length === 0 && before.unlabelled.length === 0, [...before.unnamed, ...before.unlabelled].join(' ; '));
    check(`${label}: ${clicked.length} buttons clicked, no errors`, errors.length === errs, errors.slice(errs).join(' ; '));
    check(`${label}: nothing sticks out sideways`, before.overflow <= 1, `${before.overflow}px`);
    console.log(`     clicked: ${clicked.join(' | ')}`);
    if (skipped.length) console.log(`     not clicked (download/install/restart): ${skipped.join(' | ')}`);
  };

  for (const theme of ['dark', 'light']) {
    await win.evaluate((t) => window.blazma.updateSettings({ theme: t }), theme);
    await win.waitForTimeout(500);
    const T = theme === 'dark' ? 'داكن' : 'فاتح';
    for (const page of ['chat', 'studio', 'device', 'models']) {
      await visit(`${T} / ${page}`, async () => { if ((await pageNow()) !== page) await win.click(`.nav-item[data-page="${page}"]`); });
      await win.screenshot({ path: `${SP}/buttons-${theme}-${page}.png` });
    }
    for (const tab of ['general', 'chat', 'kb', 'engine', 'monitor', 'api', 'updates', 'about']) {
      const open = async () => {
        if ((await pageNow()) !== 'settings') await win.click('.nav-item[data-page="settings"]');
        await win.click(`.set-toc button[data-target="${tab}"]`);
      };
      await visit(`${T} / settings / ${tab}`, open);
      await win.evaluate((t) => window.blazma.updateSettings({ theme: t }), theme); // the theme buttons were clicked too
      await win.screenshot({ path: `${SP}/buttons-${theme}-settings-${tab}.png` });
    }
  }
  check('menus and dialogs close with Escape', stuck.size === 0, [...stuck].join(' ; '));
  await win.evaluate(() => window.blazma.updateSettings({ theme: 'dark' }));
  await app.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
