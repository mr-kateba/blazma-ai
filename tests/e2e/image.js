// Image generation with stable-diffusion.cpp's sd-server and Z-Image Turbo
// (BLAZMA_SD_SERVER and BLAZMA_IMAGE_*: the Linux build and smaller Q3
// files from tests/setup.js). On this CPU-only machine one 512x512 picture
// takes minutes. Checks: the chat model translates the Arabic description,
// steps the chat server down and back up, the PNG shows in the chat, is
// saved with the conversation, and can be saved to a file.
const { _electron } = require('playwright-core');
const fs = require('fs');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const I = SP + '/images';
const env = {
  ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999',
  BLAZMA_SD_SERVER: SP + '/sdcpp/sd-server', BLAZMA_IMAGE_DIFFUSION: I + '/z_image_turbo-Q3_K.gguf', BLAZMA_IMAGE_VAE: I + '/ae.safetensors', BLAZMA_IMAGE_LLM: I + '/Qwen3-4B-Instruct-2507-Q3_K_M.gguf',
};
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const state = (win) => win.evaluate(() => window.blazma.getSetupState());
async function ready(win) { await win.waitForTimeout(800); for (let i = 0; i < 1200 && (await state(win)).phase !== 'ready'; i++) await win.waitForTimeout(300); }
const ps = () => execSync('ps -eo args').toString();

(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  await ready(win);
  if (await win.evaluate(() => localStorage.getItem('blazma.persona'))) { await win.evaluate(() => localStorage.removeItem('blazma.persona')); await win.reload(); await win.waitForLoadState('load'); await ready(win); }
  const st = await win.evaluate(() => window.blazma.imagesStatus());
  check('program and model files found', st.program && st.models, JSON.stringify(st));

  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.click('#btn-image-gen'); await win.waitForTimeout(400);
  check('empty box -> asks for a description', (await win.locator('#attach-preview .attach-note').allTextContents()).join(' ').length > 5);

  // Watch what is sent for translation and whether the chat server steps aside.
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });
  await win.fill('#chat-input', 'قطة برتقالية تجلس على كرسي خشبي بجانب نافذة');
  const t0 = Date.now();
  await win.click('#btn-image-gen');
  let sawSd = false, chatStopped = false, hidden = 0, elapsed = '';
  for (let i = 0; i < 1800; i++) {
    await win.waitForTimeout(1000);
    const view = await win.evaluate(() => ({ chat: !document.getElementById('chat-area').hidden, t: (document.querySelector('.image-elapsed') || {}).textContent || '' }));
    if (!view.chat) hidden++;
    if (view.t) elapsed = view.t;
    if (i === 20) await win.screenshot({ path: SP + '/image-0-working.png' });
    const p = ps();
    if (/sd-server .*--listen-ip 127\.0\.0\.1/.test(p)) sawSd = true;
    if (sawSd && !/llama-server -hf/.test(p)) chatStopped = true;
    if (i > 3 && (await win.locator('#btn-send:not([hidden])').count())) break; // finished, with a picture or an error
  }
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  const translated = await win.evaluate(() => (window.__reqs[0] && window.__reqs[0].messages[1].content) || '');
  check('description translated by the chat model', translated.includes('قطة'), translated.slice(0, 60));
  check('sd-server on 127.0.0.1, chat server stopped meanwhile', sawSd && chatStopped);
  check('conversation stays on screen while drawing', hidden === 0 && /مرّ \d+:\d\d/.test(elapsed), `hidden ${hidden}s, last timer "${elapsed}"`);
  const img = await win.evaluate(() => { const i = document.querySelector('.gen-images img'); return i ? { w: i.naturalWidth, h: i.naturalHeight, src: i.src.slice(0, 22) } : null; });
  check('picture shown in the chat', img && img.w === 512 && img.h === 512 && img.src === 'data:image/png;base64,', `${JSON.stringify(img)} after ${secs}s`);
  const err = await win.locator('.msg-ai .msg-error').allTextContents();
  if (err.length) console.log('error shown:', err.join(' | '));
  await win.screenshot({ path: SP + '/image-1-chat.png' });

  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, SP + '/image-saved.png');
  fs.rmSync(SP + '/image-saved.png', { force: true });
  await win.locator('.gen-images button').first().click(); await win.waitForTimeout(800);
  const saved = fs.existsSync(SP + '/image-saved.png') ? fs.readFileSync(SP + '/image-saved.png') : null;
  check('saved as a PNG file', saved && saved.slice(1, 4).toString() === 'PNG', saved ? `${saved.length} bytes` : 'missing');

  // Sending while the chat model is still loading again: a note, nothing lost.
  if ((await state(win)).phase !== 'ready') {
    await win.fill('#chat-input', 'مرحبا'); await win.press('#chat-input', 'Enter'); await win.waitForTimeout(400);
    check('send waits for the chat model', (await win.inputValue('#chat-input')) === 'مرحبا' && (await win.locator('#attach-preview .attach-note').count()) === 1);
    await win.fill('#chat-input', '');
  }
  await ready(win);
  check('conversation still shown when the model is back', !(await win.evaluate(() => document.getElementById('chat-area').hidden)) && (await win.locator('.gen-images img').count()) === 1);
  check('chat server back afterwards', (await state(win)).phase === 'ready' && /llama-server -hf/.test(ps()) && !/sd-server/.test(ps()));
  // Saved with the conversation: reopen it.
  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.click('.chat-item >> nth=0'); await win.waitForTimeout(800);
  check('picture kept in the saved chat', (await win.locator('.gen-images img').count()) === 1);

  // Cancelling: the stop button ends sd-server and the chat model comes back.
  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.fill('#chat-input', 'a red apple on a table');
  await win.click('#btn-image-gen');
  for (let i = 0; i < 120 && !/sd-server .*--listen-ip/.test(ps()); i++) await win.waitForTimeout(500);
  check('no regenerate or edit while drawing', (await win.locator('.msg-footer button:has-text("إعادة التوليد"), .msg-footer button:has-text("تعديل")').count()) === 0);
  await win.click('#btn-stop-gen');
  await win.waitForSelector('#btn-send:not([hidden])', { timeout: 60000 });
  check('drawing cancelled', /أُوقف/.test(await win.locator('.msg-ai').last().innerText()) && !/sd-server/.test(ps()));
  await ready(win);
  check('chat model back after cancelling', (await state(win)).phase === 'ready');
  check('no text regenerate under a picture reply', (await win.locator('.msg-ai .msg-footer button:has-text("إعادة التوليد")').count()) === 0);
  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
