// Chat branches (regenerate and edit keep the earlier versions, saved with
// the chat) and the "استمع" button (Web Speech: no voice on this machine,
// then a stubbed Arabic voice to check what would be read).
const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const launch = () => _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
async function ready(win) { for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); }
async function waitIdle(win) { await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 900000 }); await win.waitForTimeout(400); }
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const lastAi = (win) => win.locator('.msg-ai .msg-body').last().innerText();
const navOf = (win, sel) => win.locator(`${sel} .branch-count`).allTextContents();

(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/chats', { recursive: true, force: true });
  let app = await launch(); let win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; const watch = (w) => { w.on('pageerror', e => logs.push('pageerror: ' + e.message)); w.on('console', m => m.type() === 'error' && logs.push(m.text())); }; watch(win);
  await ready(win);
  if (await win.evaluate(() => localStorage.getItem('blazma.persona'))) { await win.evaluate(() => localStorage.removeItem('blazma.persona')); await win.reload(); await win.waitForLoadState('load'); await ready(win); }
  if ((await win.evaluate(() => window.blazma.getSetupState())).modelId !== 'qwen3.5-2b') { await win.evaluate(() => window.blazma.modelsUse('qwen3.5-2b')); await win.waitForTimeout(800); await ready(win); }
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false, kbInChat: false }));

  await win.fill('#chat-input', 'اذكر اسم لون واحد فقط بكلمة واحدة.'); await win.press('#chat-input', 'Enter'); await waitIdle(win);
  const a1 = await lastAi(win);
  check('no branch nav before regenerate', (await win.locator('.branch-nav').count()) === 0);

  await win.click('.msg-ai .msg-footer button:has-text("إعادة التوليد")'); await waitIdle(win);
  const a2 = await lastAi(win);
  check('regenerate keeps both replies', (await navOf(win, '.msg-ai')).join() === '2/2', (await navOf(win, '.msg-ai')).join());
  await win.click('.msg-ai .branch-nav button >> nth=0'); await win.waitForTimeout(300);
  check('previous version shows the first reply', (await navOf(win, '.msg-ai')).join() === '1/2' && (await lastAi(win)) === a1, `${a1.slice(0, 40)} / ${a2.slice(0, 40)}`);
  await win.click('.msg-ai .branch-nav button >> nth=1'); await win.waitForTimeout(300);
  check('next version shows the second reply', (await navOf(win, '.msg-ai')).join() === '2/2' && (await lastAi(win)) === a2);

  await win.click('.msg-user .msg-footer button:has-text("تعديل")'); await win.waitForTimeout(300);
  await win.fill('.edit-box textarea', 'ما عاصمة مصر؟ أجب بكلمة.'); await win.click('.edit-box .btn.primary'); await waitIdle(win);
  check('edit adds a branch on the question', (await navOf(win, '.msg-user')).join() === '2/2', (await navOf(win, '.msg-user')).join());
  check('edited branch has one reply', (await win.locator('.msg').count()) === 2 && (await win.locator('.msg-ai .branch-nav').count()) === 0);
  const a3 = await lastAi(win);
  await win.click('.msg-user .branch-nav button >> nth=0'); await win.waitForTimeout(300);
  const userText = await win.locator('.msg-user .msg-body').innerText();
  check('first question comes back with its two replies', userText.includes('لون') && (await navOf(win, '.msg-ai')).join() === '2/2' && (await lastAi(win)) === a2, userText);

  // Saved with the chat: restart and open it again.
  await win.waitForTimeout(800);
  await app.close();
  app = await launch(); win = await app.firstWindow(); watch(win); await win.waitForLoadState('load'); await ready(win);
  await win.click('.chat-item >> nth=0'); await win.waitForTimeout(600);
  check('branches survive a restart', (await navOf(win, '.msg-user')).join() === '1/2' && (await navOf(win, '.msg-ai')).join() === '2/2', `${await navOf(win, '.msg-user')} ${await navOf(win, '.msg-ai')}`);
  await win.click('.msg-user .branch-nav button >> nth=1'); await win.waitForTimeout(300);
  check('second question still has its reply', (await lastAi(win)) === a3);
  await win.screenshot({ path: SP + '/branches-1.png' });

  // "استمع": this machine has no speech voices, so the note explains it.
  const voices = await win.evaluate(() => speechSynthesis.getVoices().length);
  await win.click('.msg-ai .msg-footer button:has-text("استمع")'); await win.waitForTimeout(2200);
  const note = await win.locator('#attach-preview .attach-note').allTextContents();
  check('no voice -> explained', voices > 0 || note.join(' ').length > 10, `voices=${voices} note=${note.join(' ').slice(0, 90)}`);

  // Stubbed Arabic voice: picks it, reads plain text, button toggles to stop.
  await win.evaluate(() => {
    window.__spoken = [];
    const fake = [{ lang: 'en-US', name: 'English', default: true }, { lang: 'ar-SA', name: 'Arabic' }];
    speechSynthesis.getVoices = () => fake;
    speechSynthesis.speak = (u) => { window.__spoken.push({ text: u.text, lang: u.lang }); window.__utter = u; };
    speechSynthesis.cancel = () => {};
  });
  await win.locator('.msg-ai .msg-footer button:has-text("استمع")').click(); await win.waitForTimeout(300);
  const spoken = await win.evaluate(() => window.__spoken);
  check('Arabic reply read with the Arabic voice', spoken.length === 1 && spoken[0].lang === 'ar-SA', JSON.stringify(spoken).slice(0, 120));
  check('button turns into stop', (await win.locator('.msg-ai .msg-footer button:has-text("إيقاف")').count()) === 1);
  await win.evaluate(() => window.__utter.onend());
  await win.waitForTimeout(200);
  check('button returns after the end', (await win.locator('.msg-ai .msg-footer button:has-text("استمع")').count()) === 1);

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
