// Quick assistant window, without taking over the keyboard: the window is
// opened with a text (as the shortcut does after copying the selection), then
// "translate" runs on the real model. The shortcut itself is checked as
// registered.
const fs = require('node:fs');
const path = require('node:path');

module.exports = async ({ app, win, log }) => {
  log('hotkey registered', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+Space')));
  const res = await app.evaluate((_e, file) => {
    try {
      process.mainModule.require(file).openWith('The quick assistant translates selected text from any program.');
      return 'ok';
    } catch (e) {
      return String(e.stack || e).slice(0, 400);
    }
  }, path.resolve(__dirname, '../../src/main/quick.js'));
  log('openWith', res);
  let quick = null;
  for (let i = 0; i < 40 && !quick; i++) {
    await win.waitForTimeout(250);
    quick = app.windows().find((w) => w.url().endsWith('/quick.html'));
  }
  if (!quick) throw new Error('quick window did not open');
  await quick.waitForLoadState('load');
  await quick.waitForTimeout(800);
  log('selected', (await quick.locator('#q-selected').innerText()).replace(/\n/g, ' | '));
  await quick.click('[data-action="translate"]');
  for (let i = 0; i < 60 && (await quick.locator('#q-copy').isHidden()); i++) await quick.waitForTimeout(500);
  log('answer', (await quick.locator('#q-answer').innerText()).slice(0, 200));
  const b64 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /quick\.html/.test(w.webContents.getURL())).webContents.capturePage().then((i) => i.toPNG().toString('base64')));
  fs.writeFileSync(path.join(process.argv[3], 'quick.png'), Buffer.from(b64, 'base64'));
  // a free question with the text
  await quick.fill('#q-input', 'كم كلمة في النص؟');
  await quick.press('#q-input', 'Enter');
  await quick.waitForTimeout(500);
  for (let i = 0; i < 60 && (await quick.locator('#q-copy').isHidden()); i++) await quick.waitForTimeout(500);
  log('free answer', (await quick.locator('#q-answer').innerText()).slice(0, 160));
  await quick.press('#q-input', 'Escape');
  await win.waitForTimeout(300);
  log('hidden after Esc', !(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /quick\.html/.test(w.webContents.getURL())).isVisible())));
};
