// "يا بلازما" through the whole path (fake mic -> whisper -> wake word ->
// voice window -> model -> open_app). open_app is recorded, not run.
module.exports = async ({ app, win, log }) => {
  // Programs are found for real; only the last step (opening) is recorded.
  await app.evaluate(({ shell }) => {
    global.__apps = [];
    shell.openPath = async (p) => (global.__apps.push(p), '');
    shell.openExternal = async (p) => void global.__apps.push(p);
  });
  await app.evaluate(({ BrowserWindow }) => {
    global.__mute = setInterval(() => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('quick.html')) w.webContents.setAudioMuted(true);
    }, 100);
  });
  await win.evaluate(() => window.blazma.wakeEnable(true));
  const t = Date.now();
  let text = '';
  for (let i = 0; i < 90; i++) {
    await win.waitForTimeout(1000);
    text = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quick.html'));
      return w && w.isVisible() ? w.webContents.executeJavaScript("(document.getElementById('q-copy').hidden ? '' : 'DONE ') + document.getElementById('q-selected').innerText + ' => ' + document.getElementById('q-answer').innerText") : '';
    });
    if (text.startsWith('DONE ')) break;
  }
  log('after', Math.round((Date.now() - t) / 1000) + 's', text.replace(/\n+/g, ' '));
  log('apps', JSON.stringify(await app.evaluate(() => global.__apps)));
  log('wake', JSON.stringify(await win.evaluate(() => window.blazma.wakeStatus())));
  await win.evaluate(() => window.blazma.wakeEnable(false));
};
