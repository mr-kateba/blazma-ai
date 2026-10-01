const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const setTemp = (t, thermal = 'Not Active') => { fs.writeFileSync(SP + '/fakebin/temp', String(t)); fs.writeFileSync(SP + '/fakebin/thermal', thermal); };
(async () => {
  setTemp(62);
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('console', m => logs.push(m.type() + ': ' + m.text())); win.on('pageerror', e => logs.push('pageerror: ' + e.message));
  await win.evaluate(() => { window.__samples = 0; window.blazma.onMonitorSample(() => window.__samples++); });
  for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); console.log('phase:', await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase)));
  await win.click('.nav-item[data-page="device"]');
  await win.waitForTimeout(7000);
  await win.screenshot({ path: SP + '/dev-1.png', fullPage: true });
  const cards = await win.evaluate(() => [...document.querySelectorAll('.stat')].map(s => s.querySelector('.stat-label').textContent + ' = ' + s.querySelector('.stat-value').textContent + (s.querySelector('.stat-note') ? ' (' + s.querySelector('.stat-note').textContent + ')' : '') + (s.className.includes('st-') ? ' [' + s.className.replace('stat ', '') + ']' : '')));
  console.log(cards.join('\n'));
  console.log('now running:', await win.textContent('.now-running'));
  // alerts
  setTemp(83); await win.waitForTimeout(4500);
  console.log('alert @83:', await win.textContent('#global-alerts'));
  setTemp(86, 'Active'); await win.waitForTimeout(4500);
  console.log('alert @86+thermal:', await win.textContent('#global-alerts'));
  await win.screenshot({ path: SP + '/dev-2-alert.png' });
  setTemp(60); await win.waitForTimeout(4500);
  console.log('alert cleared:', JSON.stringify(await win.textContent('#global-alerts')));
  // sampling stops off-page
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(500);
  const n1 = await win.evaluate(() => window.__samples); await win.waitForTimeout(5000);
  console.log('samples while on chat page (should be 0):', (await win.evaluate(() => window.__samples)) - n1);
  // benchmark
  await win.click('.nav-item[data-page="device"]'); await win.waitForTimeout(1000);
  await win.click('#btn-bench'); await win.waitForSelector('.bench-item', { timeout: 300000 });
  console.log('bench:', await win.textContent('.bench'));
  // report export with the save dialog stubbed
  await app.evaluate(({ dialog }, p) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: p }); }, SP + '/report.json');
  await win.click('#btn-export'); await win.waitForTimeout(1500);
  const rep = fs.readFileSync(SP + '/report.json', 'utf8');
  console.log('report keys:', Object.keys(JSON.parse(rep)).join(','), '| has username/home/hostname:', /root|\/home\/|scratchpad/.test(rep) || rep.includes(require('os').hostname()));
  await win.screenshot({ path: SP + '/dev-3-bench.png' });
  // manual thresholds (as the settings page saves them)
  await win.evaluate(() => window.blazma.updateSettings({ gpuTempWarn: 55, gpuTempDanger: 65 }));
  await win.click('.nav-item[data-page="chat"]'); await win.click('.nav-item[data-page="device"]'); await win.waitForTimeout(4500);
  console.log('alert @60 with warn=55,danger=65:', await win.textContent('#global-alerts'));
  await win.evaluate(() => window.blazma.updateSettings({ gpuTempWarn: null, gpuTempDanger: null }));
  console.log(logs.join('\n'));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
