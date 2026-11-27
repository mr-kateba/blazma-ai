// The voice window with typed requests (no microphone): opening is recorded.
module.exports = async ({ app, log }) => {
  await app.evaluate(({ shell, BrowserWindow }) => {
    global.__apps = [];
    shell.openPath = async (p) => (global.__apps.push(p), '');
    shell.openExternal = async (p) => void global.__apps.push(p);
    global.__mute = setInterval(() => {
      for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('quick.html')) w.webContents.setAudioMuted(true);
    }, 100);
  });
  for (const said of (process.env.SAY ? process.env.SAY.split('|') : ['افتح كروم', 'شغل لي ديسكورد', 'افتح مجلد التنزيلات', 'وش الفرق بين الرام والهارديسك باختصار'])) {
    await app.evaluate((_e, t) => process.mainModule.require('D:\\Dev\\blazma-ai\\src\\main\\quick.js').openVoice(t), said);
    let text = '';
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      text = await app.evaluate(({ BrowserWindow }) => {
        const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quick.html'));
        return w ? w.webContents.executeJavaScript("(document.getElementById('q-copy').hidden ? '' : 'DONE ') + document.getElementById('q-answer').innerText") : '';
      });
      if (text.startsWith('DONE ') || i > 3 && /^فتحت/.test(text)) break;
    }
    log('vlog', await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quick.html'));
      return w.webContents.executeJavaScript("JSON.stringify((window.__vlog || []).splice(0))");
    }));
    log(said, '=>', text.replace(/\n+/g, ' ').slice(0, 200), '| opened', JSON.stringify(await app.evaluate(() => global.__apps.splice(0))));
  }
};
