const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const phase = (win) => win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase));
const waitReady = async (win) => { await win.waitForTimeout(1500); for (let i = 0; i < 300 && (await phase(win)) !== 'ready'; i++) await win.waitForTimeout(300); };
const ask = async (port, key) => {
  const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify({ model: 'anything', messages: [{ role: 'user', content: 'ما عاصمة اليابان؟ أجب بكلمة واحدة.' }], max_tokens: 40, chat_template_kwargs: { enable_thinking: false } }) });
  const t = await r.text(); let c = t; try { c = JSON.parse(t).choices[0].message.content; } catch {}
  return `${r.status} ${String(c).slice(0, 80)}`;
};
(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message)); win.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 900));
  await waitReady(win);
  await win.click('.nav-item[data-page="settings"]'); await win.waitForTimeout(800);
  await win.click('.set-toc button[data-target="api"]'); await win.waitForTimeout(600);
  await win.click('#set-api .switch'); await waitReady(win); await win.waitForTimeout(800);
  const v = await win.evaluate(() => window.blazma.getSettings());
  const conn = await win.evaluate(() => window.blazma.getConnection());
  console.log('enabled:', v.apiEnabled, 'key format ok:', /^bz-[0-9a-f]{48}$/.test(v.apiKey), 'server uses it:', conn.apiKey === v.apiKey);
  console.log('ui url:', await win.locator('#set-api code.api-value').first().innerText());
  console.log('listening:', execSync(`ss -ltn | grep ':${conn.port} ' || true`).toString().trim());
  console.log('with key:', await ask(conn.port, v.apiKey));
  console.log('no key:', await ask(conn.port, null));
  console.log('wrong key:', await ask(conn.port, 'bz-wrong'));
  await win.locator('#set-api').scrollIntoViewIfNeeded(); await win.mouse.move(5, 5);
  await win.screenshot({ path: SP + '/api-1.png' });
  // key survives a restart of the engine
  await win.evaluate(() => window.blazma.restartServer ? window.blazma.restartServer() : null);
  // new key
  win.on('dialog', (d) => d.accept());
  await win.click('#set-api button:has-text("مفتاح جديد")'); await waitReady(win);
  const v2 = await win.evaluate(() => window.blazma.getSettings());
  const c2 = await win.evaluate(() => window.blazma.getConnection());
  console.log('new key differs:', v2.apiKey !== v.apiKey, '| old key now:', await ask(c2.port, v.apiKey), '| new key:', (await ask(c2.port, v2.apiKey)).slice(0, 3));
  // turn off: random key again
  await win.click('#set-api .switch'); await waitReady(win);
  const c3 = await win.evaluate(() => window.blazma.getConnection());
  console.log('off: fixed key rejected:', (await ask(c3.port, v2.apiKey)).slice(0, 3), '| ui rows:', await win.locator('#set-api .set-item').count());
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
