// Blazma's own reading voice (Piper, main/tts.js). The mock serves Piper's
// Linux build (the app's pinned sha256 is checked) and, in place of the Arabic
// voice, Piper's small English test voice under the same Hugging Face path.
// Checks: "استمع" offers the download when no voice can read Arabic; the
// download from settings; speech made on this computer is understood by
// whisper.cpp (so the WAV is real speech); odd text cannot reach the command
// line; the reply's "استمع" plays and stops.
const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const W = SP + '/whisper';
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999', BLAZMA_PIPER_BASE: 'http://127.0.0.1:18999/files', BLAZMA_WHISPER_SERVER: W + '/whisper-bin-ubuntu-x64/whisper-server', BLAZMA_WHISPER_MODEL: W + '/ggml-small-q5_1.bin' };
const USER = SP + '/e2e-home/Blazma AI';
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };

(async () => {
  fs.rmSync(USER + '/tts', { recursive: true, force: true });
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox', '--autoplay-policy=no-user-gesture-required'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message)); win.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text()));
  for (let i = 0; i < 1200 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: true, webSearch: false, ttsEngine: 'blazma' }));

  // A reply to read.
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', 'قل جملة واحدة قصيرة عن القهوة.');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 240; i++) { if ((await win.locator('.msg-ai').count()) && !(await win.locator('#btn-stop-gen').isVisible())) break; await win.waitForTimeout(500); }

  // Not downloaded yet: "استمع" offers it (with its size), Cancel leaves it.
  await win.click('.msg-ai .msg-footer button:has-text("استمع")');
  await win.waitForSelector('.dlg', { timeout: 15000 });
  const offer = await win.locator('.dlg').innerText();
  check('"استمع" offers the Arabic voice with its size', offer.includes('صوت عربي') && /\d+ ميجابايت/.test(offer), offer.replace(/\s+/g, ' ').slice(0, 140));
  await win.click('.dlg-cancel');

  // Download from settings.
  await win.click('.nav-item[data-page="settings"]'); await win.click('.set-toc button[data-target="chat"]');
  await win.click('button:has-text("تنزيل صوت Blazma")');
  for (let i = 0; i < 120 && !(await win.locator('text=صوت Blazma العربي منزّل').count()); i++) await win.waitForTimeout(500);
  const st = await win.evaluate(() => window.blazma.ttsStatus());
  check('voice downloaded and checked (pinned sha256 of the program)', st.installed && fs.existsSync(USER + '/tts/bin/piper/piper') && fs.existsSync(USER + '/tts/voices/ar_JO-kareem-medium.onnx'));
  await win.screenshot({ path: SP + '/tts-1-settings.png' });

  // Real speech: whisper.cpp hears the sentence back.
  // (Bytes cross to the test as a plain array.)
  const synth = (t) => win.evaluate((t) => window.blazma.ttsSynth(t).then((r) => (r.ok ? { ok: true, bytes: Array.from(r.result) } : r)), t);
  const res = await synth('Hello, this is a test of the reading voice.');
  const wav = res.ok ? Buffer.from(res.bytes) : Buffer.alloc(0);
  const seconds = wav.length > 44 ? (wav.length - 44) / (wav.readUInt32LE(28)) : 0;
  check('speech made on this computer (WAV)', wav.toString('latin1', 0, 4) === 'RIFF' && seconds > 1, `${seconds.toFixed(1)} s ${res.ok ? '' : JSON.stringify(res.error)}`);
  const heard = await win.evaluate((b) => window.blazma.voiceTranscribe(new Uint8Array(b)), [...wav]);
  check('whisper.cpp understands it', heard.ok && /test/i.test(heard.result) && /voice/i.test(heard.result), heard.ok ? heard.result : JSON.stringify(heard.error));

  // Text that looks like options or has line breaks is only spoken.
  const odd = await synth('--model /etc/passwd\n--output_file /tmp/x "quoted" `tick` ; rm -rf /');
  check('odd text is only read, never a command', odd.ok && Buffer.from(odd.bytes).toString('latin1', 0, 4) === 'RIFF' && !fs.existsSync('/tmp/x'));
  const arabic = await synth('مرحباً، هذه تجربة للصوت.');
  check('Arabic text is read without errors', arabic.ok && arabic.bytes.length > 44);

  // The reply's "استمع": plays, and a second click stops it.
  await win.click('.nav-item[data-page="chat"]');
  const listen = win.locator('.msg-ai .msg-footer button').filter({ hasText: /استمع|إيقاف الصوت/ }).first();
  await listen.click();
  await win.waitForTimeout(1500);
  const playing = await listen.innerText();
  const note = await win.locator('.attach-note').allInnerTexts();
  await listen.click();
  await win.waitForTimeout(300);
  check('"استمع" plays the reply and stops on a second click', playing === 'إيقاف الصوت' && (await listen.innerText()) === 'استمع', `${playing} ${note.join(' ')}`);

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed || logs.length ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
