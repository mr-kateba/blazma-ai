// Development check on Windows: starts the app from source with a separate
// data folder (BLAZMA_USER_DATA), waits for the model, and saves a
// screenshot of each page. Usage: node scripts/shots.js <data dir> <out dir> [step ...]
const { _electron } = require('playwright-core');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const [dataDir, outDir, ...steps] = process.argv.slice(2);
if (!dataDir || !outDir) {
  console.error('usage: node scripts/shots.js <data dir> <out dir> [step ...]');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

(async () => {
  const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
  // FAKE_MIC=<wav>: Chromium plays that file as the microphone (wake word test).
  const mic = process.env.FAKE_MIC ? ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${process.env.FAKE_MIC}`] : [];
  const app = await _electron.launch({ executablePath: exe, args: [...mic, root], cwd: root, env: { ...process.env, BLAZMA_USER_DATA: dataDir } });
  const win = await app.firstWindow();
  await win.waitForLoadState('load');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 880));
  const logs = [];
  win.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  win.on('console', (m) => m.type() === 'error' && logs.push(`console: ${m.text()}`));
  const shot = async (name) => {
    await win.waitForTimeout(400);
    // capturePage (not page.screenshot): it also draws the sandboxed preview frame.
    const b64 = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => /index\.html/.test(w.webContents.getURL())).webContents.capturePage().then((i) => i.toPNG().toString('base64')));
    fs.writeFileSync(path.join(outDir, `${name}.png`), Buffer.from(b64, 'base64'));
    console.log('shot', name);
  };
  const ctx = { app, win, shot, log: (...a) => console.log(...a) };
  for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase))) !== 'ready'; i++) await win.waitForTimeout(500);
  console.log('phase', await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase)));
  const list = steps.length ? steps : ['pages'];
  for (const s of list) {
    const file = path.join(__dirname, 'shots', `${s}.js`);
    if (!fs.existsSync(file)) {
      console.log('no step', s);
      continue;
    }
    try {
      await require(file)(ctx);
    } catch (err) {
      console.log(`FAIL ${s}: ${err.stack || err}`);
      await shot(`fail-${s}`).catch(() => {});
    }
  }
  if (logs.length) console.log(logs.join('\n'));
  await app.close();
})();
