const { _electron } = require('playwright-core');
const { execSync, spawn } = require('child_process');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const streams = () => execSync('pgrep -fc "nvidia-smi --query-gpu.*-lms" || true').toString().trim();
const lmsCount = () => { try { return fs.readFileSync(SP + '/fakebin/lms.log', 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } };
(async () => {
  const mock = spawn('node', [SP + '/mock-lhm.js', 'ok'], { stdio: 'ignore' });
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message)); win.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 860));
  for (let i = 0; i < 300 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.evaluate(() => window.blazma.updateSettings({ overlayEnabled: false, overlayCorner: 'top-left', monitorIntervalMs: 500, webSearch: false }));
  await win.click('.nav-item[data-page="settings"]'); await win.click('.nav-item[data-page="chat"]'); // reload overlay settings via page visit
  await win.evaluate(async () => (await import('./pages/overlay.js')).refreshOverlaySettings());
  console.log('streams before:', streams());
  await win.click('#btn-overlay'); await win.waitForTimeout(3000);
  console.log('pressed:', await win.getAttribute('#btn-overlay', 'aria-pressed'), '| visible:', await win.isVisible('.hw-overlay'));
  console.log('overlay:', (await win.innerText('.hw-overlay')).replace(/\n/g, ' | '));
  fs.writeFileSync(SP + '/fakebin/lms.log', '');
  const a = await win.innerText('.hw-overlay .ov-body'); await win.waitForTimeout(2000); const b = await win.innerText('.hw-overlay .ov-body');
  console.log('lines from nvidia-smi in 2 s:', lmsCount(), '| streams:', streams(), '| values changed:', a !== b);
  // live speed while the reply is written
  await win.click('#btn-new-chat'); await win.click('.nav-item[data-page="chat"]');
  await win.fill('#chat-input', 'اكتب فقرة من خمس جمل عن البحر.'); await win.press('#chat-input', 'Enter');
  let live = null;
  for (let i = 0; i < 100 && !live; i++) { await win.waitForTimeout(300); if (await win.locator('.hw-overlay .ov-val.live').count()) live = await win.innerText('.hw-overlay .ov-val.live'); }
  console.log('live speed during reply:', live);
  await win.screenshot({ path: SP + '/ov-1.png' });
  await win.waitForSelector('#btn-send:not([hidden])', { timeout: 600000 }); await win.waitForTimeout(800);
  console.log('after reply:', await win.locator('.hw-overlay .ov-row').last().innerText(), '| live class:', await win.locator('.hw-overlay .ov-val.live').count());
  // drag to bottom-right
  const box = await win.locator('.hw-overlay').boundingBox();
  await win.mouse.move(box.x + 40, box.y + 30); await win.mouse.down(); await win.mouse.move(1200, 760, { steps: 10 }); await win.mouse.up(); await win.waitForTimeout(500);
  console.log('corner after drag:', await win.evaluate(() => [...document.querySelector('.hw-overlay').classList].find((c) => c.startsWith('at-'))), (await win.evaluate(() => window.blazma.getSettings())).overlayCorner);
  await win.screenshot({ path: SP + '/ov-2.png' });
  // leave the chat: sampling stops
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(1500);
  console.log('streams on models page:', streams());
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(1500);
  console.log('streams back on chat:', streams());
  // device page and chat together, then device closed: overlay keeps going
  await win.click('#btn-overlay'); await win.waitForTimeout(1500);
  console.log('after turning off: streams', streams(), '| hidden:', !(await win.isVisible('.hw-overlay')));
  await win.evaluate(() => window.blazma.updateSettings({ overlayEnabled: false, overlayCorner: 'top-left', monitorIntervalMs: 2000, webSearch: true }));
  console.log(logs.join('\n') || 'no errors');
  await app.close(); mock.kill();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
