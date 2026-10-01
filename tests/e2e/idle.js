// Engine options: idle unload (--sleep-idle-seconds; BLAZMA_IDLE_SECONDS
// shortens it for the test) and speculative decoding (--spec-default). The
// draft-model choice on Qwen3.5 2B, which has no draft in the catalog, falls
// back to --spec-default alone (--spec-draft-hf itself was checked by hand
// against the mock server, see CHANGELOG).
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999', BLAZMA_IDLE_SECONDS: '12' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const state = (win) => win.evaluate(() => window.blazma.getSetupState());
async function ready(win) { await win.waitForTimeout(800); for (let i = 0; i < 1200 && (await state(win)).phase !== 'ready'; i++) await win.waitForTimeout(300); }
async function waitIdle(win) { await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 900000 }); await win.waitForTimeout(400); }
const serverArgs = () => execSync('ps -eo args').toString().split('\n').find((l) => /llama-server -hf/.test(l) && !/--embedding/.test(l)) || '';
async function ask(win, text) {
  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.fill('#chat-input', text); await win.press('#chat-input', 'Enter'); await waitIdle(win);
  return { text: await win.locator('.msg-ai .msg-body').last().innerText(), stats: await win.locator('.msg-ai .stats').last().textContent().catch(() => '') };
}

(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  await ready(win);
  if (await win.evaluate(() => localStorage.getItem('blazma.persona'))) { await win.evaluate(() => localStorage.removeItem('blazma.persona')); await win.reload(); await win.waitForLoadState('load'); await ready(win); }
  if ((await state(win)).modelId !== 'qwen3.5-2b') { await win.evaluate(() => window.blazma.modelsUse('qwen3.5-2b')); await ready(win); }
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false, kbInChat: false, idleUnloadMin: 5, speculative: 'ngram' }));
  await win.evaluate(() => window.blazma.restartServer()); await ready(win);

  let args = serverArgs();
  check('idle unload argument', / --sleep-idle-seconds 12( |$)/.test(args));
  check('ngram speculative argument', / --spec-default( |$)/.test(args) && !/--spec-draft-hf/.test(args));
  let r = await ask(win, 'اكتب جملة قصيرة عن الشمس.');
  check('reply with ngram speculation', r.text.length > 5, `${r.stats} | ${r.text.slice(0, 60)}`);

  let slept = false;
  for (let i = 0; i < 40 && !slept; i++) { await win.waitForTimeout(1000); slept = (await state(win)).sleeping; }
  const pill = await win.locator('#status-pill').innerText();
  check('model unloaded after idle time', slept && pill.includes('نائم'), `pill="${pill}"`);
  await win.screenshot({ path: SP + '/idle-1.png' });
  const t0 = Date.now();
  r = await ask(win, 'ما عاصمة فرنسا؟ أجب بكلمة.');
  check('wakes up on the next message', r.text.length > 1, `${((Date.now() - t0) / 1000).toFixed(1)}s | ${r.text.slice(0, 40)}`);

  await win.evaluate(() => window.blazma.updateSettings({ speculative: 'draft' }));
  await win.evaluate(() => window.blazma.restartServer()); await ready(win);
  args = serverArgs();
  check('no draft for 2B -> text-based only', !/--spec-draft-hf/.test(args) && / --spec-default/.test(args), args.replace(/.*llama-server/, '').slice(0, 300));
  r = await ask(win, 'اكتب جملة قصيرة عن البحر.');
  check('reply after the change', r.text.length > 5 && (await state(win)).phase === 'ready', `${r.stats} | ${r.text.slice(0, 60)}`);

  await win.evaluate(() => window.blazma.updateSettings({ idleUnloadMin: 0, speculative: 'off' }));
  await win.evaluate(() => window.blazma.restartServer()); await ready(win);
  args = serverArgs();
  check('options off again', !/--sleep-idle-seconds|--spec-/.test(args));
  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
