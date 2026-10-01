// Voice input with whisper.cpp (BLAZMA_WHISPER_SERVER / BLAZMA_WHISPER_MODEL:
// the Linux whisper-server and ggml-small-q5_1.bin from tests/setup.js).
// 1) audio files sent straight to the main process, Arabic and English;
// 2) the microphone button, with Chromium's fake microphone playing the
//    Arabic sample (the speech of a real person, CC BY 4.0).
const { _electron } = require('playwright-core');
const fs = require('fs');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const W = SP + '/whisper';
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999', BLAZMA_WHISPER_SERVER: W + '/whisper-bin-ubuntu-x64/whisper-server', BLAZMA_WHISPER_MODEL: W + '/ggml-small-q5_1.bin' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const transcribe = (win, file) => win.evaluate((b) => window.blazma.voiceTranscribe(new Uint8Array(b)), [...fs.readFileSync(file)]);

(async () => {
  const app = await _electron.launch({
    executablePath: root + '/node_modules/electron/dist/electron',
    args: [root, '--no-sandbox', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${W}/ar-sample.wav`],
    cwd: root, env,
  });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  await win.waitForTimeout(1500);

  const st = await win.evaluate(() => window.blazma.voiceStatus());
  check('program and model found', st.program && st.model, JSON.stringify(st));

  let t0 = Date.now();
  let r = await transcribe(win, W + '/ar-sample.wav');
  check('Arabic speech to text', r.ok && /البرازيل/.test(r.result) && /كأس العالم/.test(r.result), `${((Date.now() - t0) / 1000).toFixed(1)}s | ${r.ok ? r.result : r.error.code}`);
  t0 = Date.now();
  r = await transcribe(win, W + '/jfk.wav');
  check('English speech to text', r.ok && /ask not what your country/i.test(r.result), `${((Date.now() - t0) / 1000).toFixed(1)}s | ${r.ok ? r.result : r.error.code}`);
  r = await win.evaluate(() => window.blazma.voiceTranscribe(new TextEncoder().encode('not a wav file at all, just text')));
  check('non-WAV data refused', !r.ok && r.error.code === 'voice-bad-audio', JSON.stringify(r.error));
  check('server on 127.0.0.1 only', /whisper-server .*--host 127\.0\.0\.1/.test(execSync('ps -eo args').toString()));

  // The microphone button: record about 19 s of the fake microphone, stop, convert.
  await win.fill('#chat-input', 'سؤالي:');
  await win.click('#btn-mic'); await win.waitForTimeout(800);
  const rec = { pressed: await win.getAttribute('#btn-mic', 'aria-pressed'), note: await win.locator('#attach-preview .attach-note').allTextContents() };
  check('recording state shown', rec.pressed === 'true' && rec.note.join(' ').length > 3, JSON.stringify(rec));
  await win.screenshot({ path: SP + '/voice-1-recording.png' });
  await win.waitForTimeout(19000);
  await win.click('#btn-mic');
  let value = '';
  for (let i = 0; i < 120 && !/البرازيل|منتخبات/.test(value); i++) { await win.waitForTimeout(1000); value = await win.inputValue('#chat-input'); }
  check('microphone text added after what was typed', value.startsWith('سؤالي: ') && /البرازيل|منتخبات/.test(value), value.slice(0, 140));
  check('recording stopped', (await win.getAttribute('#btn-mic', 'aria-pressed')) === 'false');
  await win.screenshot({ path: SP + '/voice-2-text.png' });

  await app.close();
  await new Promise((res) => setTimeout(res, 1500));
  check('whisper-server stopped with the app', !/whisper-server -m/.test(execSync('ps -eo args').toString()));
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
