// Screen shortcut: a picture of the screen (no key presses), opened in the
// quick assistant, then "explain" on the real vision model. Also checks the
// two shortcuts are registered and the replace button shows for a selection.
const path = require('node:path');

module.exports = async ({ app, win, log, shot }) => {
  log('keys', JSON.stringify(await app.evaluate(({ globalShortcut }) => ({ text: globalShortcut.isRegistered('Alt+Space'), screen: globalShortcut.isRegistered('Alt+Shift+Space') }))));
  const file = path.resolve(__dirname, '../../src/main/quick.js');
  const res = await app.evaluate(async (_e, f) => {
    try {
      const q = process.mainModule.require(f);
      const img = await q.captureScreen();
      q.openWith('', img);
      return `ok ${img.length}`;
    } catch (e) {
      return String(e.stack || e).slice(0, 400);
    }
  }, file);
  log('capture', res);
  let quick = null;
  for (let i = 0; i < 40 && !quick; i++) {
    await win.waitForTimeout(250);
    quick = app.windows().find((w) => w.url().endsWith('/quick.html'));
  }
  if (!quick) throw new Error('quick window did not open');
  await quick.waitForTimeout(900);
  log('shot shown', await quick.locator('.q-shot').isVisible(), 'screen actions', await quick.locator('[data-screen-action]').count());
  await quick.click('[data-screen-action="explain"]');
  for (let i = 0; i < 120 && (await quick.locator('#q-copy').isHidden()); i++) await quick.waitForTimeout(500);
  log('answer', (await quick.locator('#q-answer').innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  log('replace hidden for picture', await quick.locator('#q-replace').isHidden());
  const buf = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().endsWith('/quick.html'));
    return (await w.webContents.capturePage()).toPNG().toString('base64');
  });
  require('node:fs').writeFileSync(path.join(process.argv[3], 'quick-screen.png'), Buffer.from(buf, 'base64'));
  // A selection: the replace button appears after the answer.
  await app.evaluate((_e, f) => process.mainModule.require(f).openWith('ذهبت الى المدرسه امس'), file);
  await quick.waitForTimeout(600);
  await quick.click('[data-action="fix"]');
  for (let i = 0; i < 60 && (await quick.locator('#q-copy').isHidden()); i++) await quick.waitForTimeout(500);
  log('fixed', (await quick.locator('#q-answer').innerText()).trim(), 'replace shown', await quick.locator('#q-replace').isVisible());
  await quick.keyboard.press('Escape');
};
