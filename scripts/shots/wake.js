// "يا بلازما": a spoken WAV (Windows voice) read by whisper and matched,
// with the quick window's answer step stubbed; then the voice window itself
// with a question (muted, so nothing is heard on the speakers).
const fs = require('node:fs');
module.exports = async ({ app, win, log, shot }) => {
  const wavFile = 'D:/Dev/blazma-ai-testdata/media/wake.wav';
  const wav = [...fs.readFileSync(wavFile)];
  const res = await app.evaluate(async (_e, { file, bytes }) => {
    const quick = process.mainModule.require(file.replace('wake.js', 'quick.js'));
    const real = quick.openVoice;
    let opened = null;
    quick.openVoice = (t) => (opened = t);
    try {
      const r = await process.mainModule.require(file).heard(new Uint8Array(bytes), 'wake');
      return { r, opened, heard: process.mainModule.require(file).status().lastHeard };
    } finally {
      quick.openVoice = real;
    }
  }, { file: 'D:\\Dev\\blazma-ai\\src\\main\\wake.js', bytes: wav });
  log('heard', JSON.stringify(res));
  // The voice window, muted.
  await app.evaluate(async (_e, file) => {
    process.mainModule.require(file).openVoice('كم الساعة الحين؟ وقل لي نكتة قصيرة');
  }, 'D:\\Dev\\blazma-ai\\src\\main\\quick.js');
  await app.evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) if (w.webContents.getURL().includes('quick.html')) w.webContents.setAudioMuted(true);
  });
  let text = '';
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    text = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quick.html'));
      return w ? w.webContents.executeJavaScript("(document.getElementById('q-copy').hidden ? '' : 'DONE ') + document.getElementById('q-answer').innerText + ' || ' + document.getElementById('q-selected').innerText") : '';
    });
    if (text.startsWith('DONE ')) break;
  }
  log('voice window', text.replace(/\n+/g, ' '));
  const png = await app.evaluate(async ({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find((x) => x.webContents.getURL().includes('quick.html'));
    return w ? (await w.webContents.capturePage()).toPNG().toString('base64') : '';
  });
  if (png) fs.writeFileSync(require('node:path').join(process.argv[3], 'wake-voice.png'), Buffer.from(png, 'base64'));
  log('shot wake-voice');
  await app.evaluate(async (_e, file) => process.mainModule.require(file).hide(), 'D:\\Dev\\blazma-ai\\src\\main\\quick.js');
};
