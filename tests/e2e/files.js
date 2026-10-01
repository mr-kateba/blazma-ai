const { _electron } = require('playwright-core');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false }));
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });
  await win.click('#btn-new-chat');
  await win.setInputFiles('#file-input', [SP + '/docs/guide.pdf', SP + '/docs/report.docx', SP + '/docs/evil.exe']);
  await win.waitForTimeout(2500);
  console.log('chips:', (await win.locator('#attach-preview .file-chip').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')));
  console.log('notes:', await win.locator('#attach-preview .attach-note').allInnerTexts());
  await win.screenshot({ path: SP + '/files-1.png' });
  // remove the docx
  await win.locator('#attach-preview .file-chip:has-text("report.docx") .file-chip-x').click();
  await win.fill('#chat-input', 'كم عدد أيام الإجازة السنوية؟ وما رقم الدعم الفني؟ أجب باختصار.');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 600000 }); await win.waitForTimeout(500);
  const req = await win.evaluate(() => window.__reqs[window.__reqs.length - 1]);
  const user = req.messages[req.messages.length - 1].content;
  console.log('sent to model starts with:', JSON.stringify(user.slice(0, 120)));
  console.log('answer:', await win.locator('.msg-ai .msg-body').last().innerText());
  console.log('message file chips:', (await win.locator('.msg-user .file-chip').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')));
  // image without vision? (vision on for 2B) -> skip; follow-up keeps file in history
  await win.fill('#chat-input', 'ما كلمة مرور الواي فاي المذكورة؟');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 600000 }); await win.waitForTimeout(500);
  console.log('follow-up answer:', await win.locator('.msg-ai .msg-body').last().innerText());
  await win.screenshot({ path: SP + '/files-2.png' });
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: true }));
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
