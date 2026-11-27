// "يا بلازما" end to end with a fake microphone (FAKE_MIC=wake-loop.wav):
// the hidden window's voice detector, whisper and the wake word. The voice
// window is replaced by a recorder so nothing opens.
module.exports = async ({ app, win, log }) => {
  const Q = 'D:\\Dev\\blazma-ai\\src\\main\\quick.js';
  await app.evaluate((_e, file) => {
    const quick = process.mainModule.require(file);
    global.__voice = [];
    global.__openVoice = quick.openVoice;
    quick.openVoice = (t) => global.__voice.push(t);
  }, Q);
  const st = await win.evaluate(() => window.blazma.wakeEnable(true));
  log('enable', JSON.stringify(st));
  const t = Date.now();
  let got = [];
  for (let i = 0; i < 60 && !got.length; i++) {
    await win.waitForTimeout(1000);
    got = await app.evaluate(() => global.__voice);
  }
  const status = await win.evaluate(() => window.blazma.wakeStatus());
  log('after', Math.round((Date.now() - t) / 1000) + 's', 'opened', JSON.stringify(got), 'status', JSON.stringify(status));
  await win.evaluate(() => window.blazma.wakeEnable(false));
  await app.evaluate((_e, file) => (process.mainModule.require(file).openVoice = global.__openVoice), Q);
};
