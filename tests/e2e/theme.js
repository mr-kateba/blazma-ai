// Light theme: chosen in Settings → General, applied at once (the main
// process sends it; <html data-theme>), kept after a restart, in every page
// and in Monaco.
const { _electron } = require('playwright-core');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const launch = () => _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
// Relative luminance of the page background, 0 (black) to 1 (white).
const bgLum = (win, sel = 'body') => win.evaluate((s) => {
  const [r, g, b] = getComputedStyle(document.querySelector(s)).backgroundColor.match(/\d+(\.\d+)?/g).map(Number);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}, sel);
const light = (win) => win.evaluate(() => document.documentElement.dataset.theme === 'light');
const page = async (win, name) => { await win.click(`.nav-item[data-page="${name}"]`); await win.waitForTimeout(name === 'studio' ? 2500 : 900); };

(async () => {
  let app = await launch(); let win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; const watch = (w) => { w.on('pageerror', e => logs.push('pageerror: ' + e.message)); w.on('console', m => m.type() === 'error' && logs.push(m.text())); }; watch(win);
  await win.evaluate(() => window.blazma.updateSettings({ theme: 'dark' })); await win.waitForTimeout(400);
  check('dark by default', !(await light(win)) && (await bgLum(win)) < 0.1, (await bgLum(win)).toFixed(3));

  await page(win, 'settings');
  await win.click('.set-toc button[data-target="general"]'); await win.waitForTimeout(300);
  const sel = win.locator('select:has(option[value="light"])');
  check('theme choice in settings', (await sel.count()) === 1);
  await sel.selectOption('light'); await win.waitForTimeout(800);
  check('light applied at once', (await light(win)) && (await bgLum(win)) > 0.8, (await bgLum(win)).toFixed(3));
  await win.screenshot({ path: SP + '/light-settings.png' });
  await app.close();

  app = await launch(); win = await app.firstWindow(); watch(win); await win.waitForLoadState('load'); await win.waitForTimeout(1500);
  check('light kept after restart', (await light(win)) && (await bgLum(win)) > 0.8);
  for (const name of ['chat', 'models', 'device']) {
    await page(win, name);
    await win.screenshot({ path: `${SP}/light-${name}.png` });
  }
  await page(win, 'studio');
  await win.screenshot({ path: SP + '/light-studio.png' });
  const studio = await win.evaluate(() => {
    const ed = document.querySelector('.monaco-editor');
    const wb = document.querySelector('.page-studio *');
    return { monaco: ed ? ed.className : null, bg: wb ? getComputedStyle(document.querySelector('.page-studio')).backgroundColor : null };
  });
  check('studio editor uses the light theme', !studio.monaco || (/\bvs\b/.test(studio.monaco) && !/vs-dark/.test(studio.monaco)), studio.monaco ? studio.monaco.slice(0, 80) : 'no editor open');
  check('studio side bar is light', (await bgLum(win, '.wb-side')) > 0.7);

  await win.evaluate(() => window.blazma.updateSettings({ theme: 'dark' })); await win.waitForTimeout(800);
  check('back to dark', !(await light(win)) && (await bgLum(win)) < 0.1);
  if (studio.monaco) check('studio editor back to dark', /vs-dark/.test(await win.evaluate(() => document.querySelector('.monaco-editor').className)));
  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
