// Organizing chats: pin to the top, folders (new folder by name, filter by
// folder), both kept when the chat is saved again; a backup of every chat in
// one file and restoring it (a deleted chat comes back, nothing is lost); a
// file that is not a backup is refused with a clear message.
const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const CHATS = SP + '/e2e-home/Blazma AI/chats';
const BACKUP = SP + '/chats-backup.json';

(async () => {
  fs.rmSync(CHATS, { recursive: true, force: true });
  fs.rmSync(BACKUP, { force: true });
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  await win.evaluate(() => { try { localStorage.removeItem('blazma.chatFolder'); } catch {} });
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: true }));
  const ids = ['aaaaaaaa-0001', 'aaaaaaaa-0002', 'aaaaaaaa-0003'];
  for (const [i, id] of ids.entries()) {
    await win.evaluate(({ id, i }) => window.blazma.chatsSave({ id, messages: [{ role: 'user', content: ['وصفة كبسة', 'مراجعة الفيزياء', 'خطة رحلة'][i] }, { role: 'assistant', content: 'تمام' }] }), { id, i });
    await win.waitForTimeout(30);
  }
  await win.reload(); await win.waitForLoadState('load');
  await win.click('.nav-item[data-page="chat"]');
  await win.waitForSelector('.chat-item');
  const titles = () => win.locator('.chat-item .chat-item-title').allInnerTexts();

  // Pin the oldest chat: it goes to the top under "مثبّتة".
  const physics = win.locator('.chat-item:has-text("مراجعة الفيزياء")');
  await physics.hover(); await physics.locator('button[title="تثبيت في الأعلى"]').click(); await win.waitForTimeout(400);
  const afterPin = await titles();
  check('pinned chat goes to the top', afterPin[0] === 'مراجعة الفيزياء' && (await win.locator('.chat-group').first().innerText()).includes('مثبّتة'), afterPin.join(' | '));

  // New folder by name (the in-app text box takes typing), then filter by it.
  const trip = win.locator('.chat-item:has-text("خطة رحلة")');
  await trip.hover(); await trip.locator('button[title="نقل إلى مجلد"]').click();
  await win.click('.folder-menu button:has-text("مجلد جديد")');
  await win.waitForSelector('.dlg-input');
  await win.keyboard.type('السفر');
  await win.keyboard.press('Enter'); await win.waitForTimeout(400);
  check('new folder from the menu, chat tagged with it', (await win.locator('.folder-chip').allInnerTexts()).some((t) => t.includes('السفر')) && (await trip.locator('.chat-item-folder').innerText()).includes('السفر'));
  const kabsa = win.locator('.chat-item:has-text("وصفة كبسة")');
  await kabsa.hover(); await kabsa.locator('button[title="نقل إلى مجلد"]').click();
  check('folder menu lists existing folders, Esc closes it', (await win.locator('.folder-menu').innerText()).includes('السفر'));
  await win.keyboard.press('Escape');
  check('… and Esc closes it', (await win.locator('.folder-menu').count()) === 0);
  await win.click('.folder-chip:has-text("السفر")'); await win.waitForTimeout(300);
  check('filter by folder shows only its chats', (await titles()).join('|') === 'خطة رحلة', (await titles()).join(' | '));
  await win.screenshot({ path: SP + '/organize-1-folder.png' });
  await win.click('.folder-chip:has-text("الكل")'); await win.waitForTimeout(300);
  check('"الكل" shows every chat again', (await titles()).length === 3);

  // Saving a chat again (a new message) keeps its pin and folder.
  await win.evaluate(() => window.blazma.chatsSave({ id: 'aaaaaaaa-0002', messages: [{ role: 'user', content: 'مراجعة الفيزياء' }, { role: 'assistant', content: 'تمام' }, { role: 'user', content: 'والكيمياء؟' }] }));
  await win.evaluate(() => window.blazma.chatsSave({ id: 'aaaaaaaa-0003', messages: [{ role: 'user', content: 'خطة رحلة' }, { role: 'assistant', content: 'تمام' }, { role: 'user', content: 'وأين أنام؟' }] }));
  const list = await win.evaluate(() => window.blazma.chatsList());
  check('pin and folder kept when the chat is saved again', list.find((c) => c.id === 'aaaaaaaa-0002').pinned === true && list.find((c) => c.id === 'aaaaaaaa-0003').folder === 'السفر');

  // Backup to a file (the save dialog is answered by the test).
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, BACKUP);
  await win.click('.nav-item[data-page="settings"]'); await win.click('.set-toc button[data-target="chat"]');
  await win.click('button:has-text("حفظ نسخة احتياطية")'); await win.waitForTimeout(600);
  const backup = fs.existsSync(BACKUP) ? JSON.parse(fs.readFileSync(BACKUP, 'utf8')) : null;
  check('backup file has every chat', backup && backup.kind === 'chats-backup' && backup.chats.length === 3 && (await win.locator('.set-toast').innerText()).includes('3'), backup ? `${backup.chats.length} chats` : 'no file');

  // Delete one, then restore: it comes back with its pin; the others are untouched.
  await win.evaluate(() => window.blazma.chatsDelete('aaaaaaaa-0002'));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, BACKUP);
  await win.click('button:has-text("استعادة من ملف")'); await win.waitForTimeout(600);
  const toast = await win.locator('.set-toast').innerText();
  const restored = await win.evaluate(() => window.blazma.chatsList());
  check('restore brings the deleted chat back, others kept', restored.length === 3 && restored.find((c) => c.id === 'aaaaaaaa-0002').pinned === true && toast.includes('أُضيفت 1'), toast);
  await win.screenshot({ path: SP + '/organize-2-restore.png' });

  // A file that is not a backup.
  fs.writeFileSync(SP + '/not-backup.json', JSON.stringify({ hello: 'world' }));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, SP + '/not-backup.json');
  await win.click('button:has-text("استعادة من ملف")'); await win.waitForTimeout(600);
  check('a file that is not a backup is refused clearly', (await win.locator('.set-toast').innerText()).includes('ليس نسخة احتياطية'));

  // A chat file with hostile content in the backup is cleaned (bad id skipped).
  fs.writeFileSync(SP + '/odd-backup.json', JSON.stringify({ kind: 'chats-backup', chats: [{ id: '../../evil', messages: [] }, { id: 'bbbbbbbb-0001', title: 'x'.repeat(500), folder: 'a\nb', messages: [{ role: 'system', content: 'hi', extra: 1 }] }] }));
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, SP + '/odd-backup.json');
  await win.click('button:has-text("استعادة من ملف")'); await win.waitForTimeout(600);
  const odd = JSON.parse(fs.readFileSync(CHATS + '/bbbbbbbb-0001.json', 'utf8'));
  check('restored chats are cleaned; bad ids skipped', !fs.existsSync(SP + '/e2e-home/evil.json') && odd.title.length <= 80 && odd.folder === 'a b' && odd.messages[0].role === 'user' && !('extra' in odd.messages[0]));

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed || logs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
