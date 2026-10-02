// Quick commands in the chat box ("/ترجم …"): the list opens on "/", filters
// as you type (with or without Arabic marks), arrows + Enter pick, Esc closes;
// a command without text is not sent; the model gets the instruction while
// the chat shows the command as a tag; it is saved and survives a reopen.
const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
// Until the n-th reply is finished (the stop button is gone again).
const replies = async (win, n) => { for (let i = 0; i < 240; i++) { if ((await win.locator('.msg-ai').count()) >= n && !(await win.locator('#btn-stop-gen').isVisible())) return; await win.waitForTimeout(500); } };

(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message));
  for (let i = 0; i < 1200 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: true, webSearch: false, kbInChat: false, shareDeviceInfo: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat').catch(() => {});
  // What the chat sends to the engine.
  await win.evaluate(() => {
    window.__bodies = [];
    const f = window.fetch;
    window.fetch = (url, opts) => { if (opts && typeof opts.body === 'string') window.__bodies.push(opts.body); return f(url, opts); };
  });

  await win.click('#chat-input');
  await win.keyboard.type('/');
  const all = await win.locator('.slash-menu .slash-item').count();
  const box = await win.locator('.slash-menu').boundingBox({ timeout: 2000 }).catch(() => null);
  await win.screenshot({ path: SP + '/slash-1-menu.png' });
  const seen = await win.evaluate(() => { const m = document.querySelector('.slash-menu'); const r = m.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + 30); return Boolean(top && m.contains(top)); });
  check('"/" opens the list of commands, visible on top', all >= 8 && seen, `${all} commands ${JSON.stringify(box)}`);
  await win.keyboard.type('لخ');
  const filtered = await win.locator('.slash-menu .slash-item').allInnerTexts();
  check('typing filters the list', filtered.length === 1 && filtered[0].includes('/لخّص'), filtered.join(' | '));
  await win.keyboard.press('Escape');
  check('Esc closes the list', (await win.locator('.slash-menu').count()) === 0);

  await win.fill('#chat-input', '');
  await win.keyboard.type('/');
  await win.keyboard.press('ArrowDown');
  await win.keyboard.press('Enter');
  const picked = await win.inputValue('#chat-input');
  check('arrow + Enter puts the command in the box (not sent)', picked === '/لخّص ' && (await win.locator('.msg-user').count()) === 0, JSON.stringify(picked));

  await win.fill('#chat-input', '/ترجم');
  await win.keyboard.press('Escape');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(500);
  check('a command without text is not sent', (await win.locator('.msg-user').count()) === 0 && (await win.locator('.attach-note').allInnerTexts()).join(' ').includes('اكتب النص بعد الأمر'));

  await win.fill('#chat-input', '/ترجم صباح الخير يا أصدقائي');
  await win.press('#chat-input', 'Enter');
  await replies(win, 1);
  const chip = await win.locator('.msg-user .slash-chip').innerText().catch(() => '');
  const shown = await win.locator('.msg-user .plain').innerText().catch(() => '');
  check('the chat shows the command as a tag and the text', chip === '/ترجم' && shown === 'صباح الخير يا أصدقائي', `${chip} | ${shown}`);
  const sent = await win.evaluate(() => window.__bodies.map((b) => JSON.parse(b)).filter((b) => Array.isArray(b.messages)).pop());
  const lastUser = sent && [...sent.messages].reverse().find((m) => m.role === 'user');
  const userText = lastUser && (typeof lastUser.content === 'string' ? lastUser.content : lastUser.content.map((p) => p.text || '').join(''));
  check('the model gets the instruction before the text', /^ترجم النص التالي/.test(userText || '') && userText.endsWith('صباح الخير يا أصدقائي'), (userText || '').slice(0, 80));
  const answer = await win.locator('.msg-ai .msg-body').last().innerText();
  check('the reply is a translation', /morning|good/i.test(answer), answer.slice(0, 120));
  await win.screenshot({ path: SP + '/slash-2-reply.png' });

  // Written without the mark (لخص instead of لخّص) still matches.
  await win.fill('#chat-input', '/لخص الذكاء الاصطناعي برامج تتعلم من البيانات وتساعد الناس في أعمال كثيرة مثل الترجمة والكتابة.');
  await win.press('#chat-input', 'Enter');
  await replies(win, 2);
  check('works without Arabic marks', (await win.locator('.msg-user .slash-chip').last().innerText()) === '/لخّص');

  // An unknown command is plain text.
  await win.fill('#chat-input', '/ابحث_عن شيء');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(800);
  check('an unknown "/word" is sent as plain text', (await win.locator('.msg-user').last().locator('.slash-chip').count()) === 0 && (await win.locator('.msg-user .plain').last().innerText()) === '/ابحث_عن شيء');
  await win.click('#btn-stop-gen').catch(() => {});
  for (let i = 0; i < 60 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);

  // Saved with the chat, shown again when reopened.
  const dir = SP + '/e2e-home/Blazma AI/chats';
  const saved = fs.readdirSync(dir).map((f) => JSON.parse(fs.readFileSync(`${dir}/${f}`, 'utf8'))).find((c) => c.messages.some((m) => m.command === 'translate'));
  check('the command is saved with the chat', Boolean(saved));
  await win.reload(); await win.waitForLoadState('load');
  await win.click('.nav-item[data-page="chat"]');
  await win.click('.chat-item >> nth=0');
  await win.waitForTimeout(800);
  check('reopened chat still shows the tag', (await win.locator('.msg-user .slash-chip').count()) >= 2);

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
