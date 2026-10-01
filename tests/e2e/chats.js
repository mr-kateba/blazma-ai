const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const launch = () => _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
async function ready(win) { for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); }
async function waitIdle(win) { await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 600000 }); await win.waitForTimeout(400); }
(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/chats', { recursive: true, force: true });
  let app = await launch(); let win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  await ready(win);
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false }));
  // record requests to check the system prompt
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.fetch = (u, o) => { window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });

  await win.fill('#chat-input', 'اكتب دالة بايثون صغيرة تجمع رقمين.'); await win.press('#chat-input', 'Enter'); await waitIdle(win);
  console.log('list after 1st chat:', await win.locator('.chat-item-title').allTextContents());
  console.log('code block buttons:', await win.locator('.md-code-head button').allTextContents());
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, SP + '/saved-code.py');
  if (await win.locator('.md-code-head button').count()) { await win.locator('.md-code-head button').first().click(); await win.waitForTimeout(500); console.log('saved file:', fs.existsSync(SP + '/saved-code.py') ? fs.readFileSync(SP + '/saved-code.py', 'utf8').slice(0, 80) : 'missing'); }

  // regenerate
  const before = await win.locator('.msg-ai .msg-body').last().innerText();
  await win.click('.msg-ai .msg-footer button:has-text("إعادة التوليد")'); await waitIdle(win);
  console.log('regenerated: msgs', await win.locator('.msg').count(), '| changed:', before !== (await win.locator('.msg-ai .msg-body').last().innerText()));

  // edit user message
  await win.click('.msg-user .msg-footer button:has-text("تعديل")'); await win.waitForTimeout(300);
  await win.fill('.edit-box textarea', 'ما عاصمة اليابان؟ أجب بكلمة.'); await win.click('.edit-box .btn.primary'); await waitIdle(win);
  console.log('after edit: msgs', await win.locator('.msg').count(), '| user:', await win.locator('.msg-user .msg-body').innerText(), '| ai:', (await win.locator('.msg-ai .msg-body').innerText()).slice(0, 60));

  // device info toggle -> system prompt contains the summary
  await win.click('#btn-device-info'); await win.waitForTimeout(300);
  console.log('device toggle:', await win.getAttribute('#btn-device-info', 'aria-pressed'));
  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.fill('#chat-input', 'ما اسم كرت الشاشة عندي وكم حرارته؟'); await win.press('#chat-input', 'Enter'); await waitIdle(win);
  const sys = await win.evaluate(() => window.__reqs[window.__reqs.length - 1].messages[0].content);
  console.log('system has device info:', sys.includes('RTX 5070'), '| leaks user/host/path:', /root|scratchpad|\/home\//.test(sys));
  console.log('device answer:', (await win.locator('.msg-ai .msg-body').innerText()).slice(0, 150));
  await win.click('#btn-device-info');

  // list, search, rename, delete, reload after restart
  console.log('list now:', await win.locator('.chat-item-title').allTextContents());
  await win.fill('#chat-search', 'اليابان'); await win.waitForTimeout(600);
  console.log('search "اليابان":', await win.locator('.chat-item-title').allTextContents());
  await win.fill('#chat-search', ''); await win.waitForTimeout(600);
  await win.hover('.chat-item >> nth=1'); await win.click('.chat-item >> nth=1 >> button[title="إعادة تسمية"]');
  await win.fill('.chat-item input', 'عواصم'); await win.press('.chat-item input', 'Enter'); await win.waitForTimeout(500);
  console.log('after rename:', await win.locator('.chat-item-title').allTextContents());
  await app.close();

  app = await launch(); win = await app.firstWindow(); await win.waitForLoadState('load'); await ready(win);
  console.log('after restart list:', await win.locator('.chat-item-title').allTextContents());
  await win.click('.chat-item:has-text("عواصم")'); await win.waitForTimeout(500);
  console.log('loaded chat msgs:', await win.locator('.msg').count(), '|', (await win.locator('.msg-user .msg-body').first().innerText()));
  await win.screenshot({ path: SP + '/chats-1.png' });
  win.on('dialog', d => d.accept()); await win.evaluate(() => new MutationObserver(() => { const b = document.querySelector('.dlg-ok'); if (b) b.click(); }).observe(document.body, { childList: true })); // accept in-app confirmations (lib/dialog.js)
  await win.hover('.chat-item >> nth=0'); await win.click('.chat-item >> nth=0 >> button[title="حذف"]'); await win.waitForTimeout(600);
  console.log('after delete:', await win.locator('.chat-item-title').allTextContents());
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: true }));
  console.log(logs.join('\n'));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
