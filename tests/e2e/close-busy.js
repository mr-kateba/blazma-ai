// Closing the app while a reply is being written must quit quickly and stop llama-server.
const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  for (let i = 0; i < 300 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', 'اكتب قصة طويلة جداً عن رحلة في الصحراء، في عشرين فقرة.'); await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(4000);
  const t0 = Date.now();
  await Promise.race([app.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('app.close() took more than 20 s')), 20000))]);
  console.log('closed in ms:', Date.now() - t0);
  await new Promise((r) => setTimeout(r, 1000));
  const left = execSync('pgrep -f "^\\S*llama-server " || true').toString().trim();
  console.log('llama-server left running:', left ? 'yes' : 'no');
  if (left) process.exit(1);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
