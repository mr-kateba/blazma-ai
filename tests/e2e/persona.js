const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const launch = () => _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
const ready = async (win) => { for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); };
const idle = async (win) => { await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 600000 }); await win.waitForTimeout(400); };
(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/personas.json', { force: true });
  let app = await launch(); let win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  win.on('dialog', d => d.accept()); await win.evaluate(() => new MutationObserver(() => { const b = document.querySelector('.dlg-ok'); if (b) b.click(); }).observe(document.body, { childList: true })); // accept in-app confirmations (lib/dialog.js)
  await ready(win);
  await win.evaluate(() => { localStorage.removeItem('blazma.persona'); window.blazma.updateSettings({ webSearch: false }); });
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });
  await win.click('#btn-new-chat');
  console.log('pill:', await win.innerText('#persona-pill'));
  await win.click('#persona-pill'); await win.waitForTimeout(200);
  console.log('menu:', (await win.locator('.persona-menu .model-menu-item').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')));
  await win.screenshot({ path: SP + '/persona-1.png' });
  await win.click('.persona-menu .model-menu-item:has-text("مترجم")');
  console.log('pill now:', await win.innerText('#persona-pill'));
  await win.setInputFiles('#file-input', [SP + '/docs/code.py']); await win.waitForTimeout(1500);
  await win.fill('#chat-input', 'صباح الخير يا أصدقائي، كيف حالكم اليوم؟'); await win.press('#chat-input', 'Enter'); await idle(win);
  const sys = await win.evaluate(() => window.__reqs[window.__reqs.length - 1].messages[0].content);
  console.log('system is translator:', sys.startsWith('أنت مترجم محترف'));
  console.log('answer:', (await win.locator('.msg-ai .msg-body').last().innerText()).slice(0, 200));
  // custom persona
  await win.click('#persona-pill'); await win.click('.persona-menu .model-menu-item.more'); await win.waitForTimeout(200);
  await win.fill('.persona-icon-input', '🍳'); await win.fill('.persona-form input[type=text]:not(.persona-icon-input)', 'طباخ');
  await win.fill('.persona-form textarea', 'أنت طباخ سعودي. أجب بوصفة قصيرة.'); await win.click('.persona-form .btn.primary'); await win.waitForTimeout(400);
  console.log('custom list:', await win.locator('.persona-item').allInnerTexts());
  await win.click('.modal .btn:has-text("إغلاق")');
  await win.click('#persona-pill'); console.log('menu has custom:', await win.locator('.persona-menu .model-menu-item:has-text("طباخ")').count()); await win.keyboard.press('Escape'); await win.click('#chat-input');
  // export md + pdf
  for (const [fmt, label] of [['md', 'Markdown'], ['pdf', 'PDF']]) {
    const out = `${SP}/export-test.${fmt}`; fs.rmSync(out, { force: true });
    await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, out);
    await win.click('#btn-export-chat'); await win.click(`.export-menu .model-menu-item:has-text("${label}")`); await win.waitForTimeout(2500);
    console.log(`export ${fmt}:`, fs.existsSync(out) ? `${fs.statSync(out).size} bytes` : 'missing');
  }
  console.log('md content:\n' + fs.readFileSync(SP + '/export-test.md', 'utf8').slice(0, 300));
  await app.close();
  // reopen: persona and attached file restored
  app = await launch(); win = await app.firstWindow(); await win.waitForLoadState('load'); await ready(win);
  await win.locator('.chat-item').first().click(); await win.waitForTimeout(600);
  console.log('after restart pill:', await win.innerText('#persona-pill'), '| file chip:', await win.locator('.msg-user .file-chip').allInnerTexts());
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: true }));
  // Leave the general persona for the tests that follow.
  await win.evaluate(() => localStorage.removeItem('blazma.persona'));
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
