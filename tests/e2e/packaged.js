const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], exe = require('path').resolve(__dirname, '../../dist/linux-unpacked/blazma-ai');
(async () => {
  const app = await _electron.launch({ executablePath: exe, args: ['--no-sandbox'], env: { ...process.env, XDG_CONFIG_HOME: SP + '/pkg-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' } });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  console.log('packaged:', await app.evaluate(({ app }) => app.isPackaged), '| version:', await win.evaluate(() => window.blazma.getAppInfo().then(i => i.version)));
  for (const f of ['guide.pdf', 'report.docx']) {
    const b64 = fs.readFileSync(SP + '/docs/' + f).toString('base64');
    const res = await win.evaluate(async ({ f, b64 }) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return window.blazma.extractFile(f, u); }, { f, b64 });
    console.log(f, res.ok ? 'OK: ' + res.result.text.split('\n')[1] : 'ERROR ' + JSON.stringify(res.error));
  }
  await win.click('.nav-item[data-page="studio"]');
  // Without VSCodium downloaded the page offers to install it.
  const codePage = await win.waitForSelector('.code-install, .code-bar', { timeout: 30000 }).then(() => true).catch(() => false);
  console.log('VS Code page in packaged app:', codePage);
  await win.screenshot({ path: SP + '/packaged.png' });
  console.log('catalog models:', (await win.evaluate(() => window.blazma.getSetupState().then(s => s.models.map(m => m.id)))).join(','));
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
