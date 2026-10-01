// The programming page: VS Code (VSCodium's web server, BLAZMA_VSCODE_DIR =
// the Linux build from tests/setup.js) shown inside the app window.
// Checks: old studio projects become folders, the editor opens in the page,
// its terminal really runs commands, webviews load from the local copy (not
// Microsoft's CDN), it hides on other pages, code from the chat opens in
// it, the AI config for Continue points at the local API, and the server
// stops with the app.
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const SP = process.argv[2], root = path.resolve(__dirname, '../..');
const HOME = SP + '/vs-home';
const env = { ...process.env, HOME, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999', BLAZMA_VSCODE_DIR: SP + '/vscodium/linux' };
const USER = SP + '/e2e-home/Blazma AI';
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const ps = () => execSync('ps -eo args').toString();

(async () => {
  // A project from the old built-in studio, to be moved to a folder.
  fs.rmSync(HOME, { recursive: true, force: true });
  fs.rmSync(USER + '/vscode', { recursive: true, force: true });
  fs.mkdirSync(USER + '/studio', { recursive: true });
  fs.writeFileSync(USER + '/studio/11111111-2222-3333-4444-555555555555.json', JSON.stringify({ id: '11111111-2222-3333-4444-555555555555', name: 'لعبتي', updatedAt: Date.now(), files: { 'index.html': '<h1>مرحبا</h1>', 'js/game.js': 'console.log(1)', '../evil.txt': 'no' } }));

  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1400, height: 860 });
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));

  await win.click('.nav-item[data-page="studio"]');
  await win.waitForSelector('.code-bar', { timeout: 30000 });
  // The editor is a separate page inside the window: find it.
  let code = null;
  for (let i = 0; i < 120 && !code; i++) {
    code = app.windows().find((p) => p.url().startsWith('http://127.0.0.1:'));
    if (!code) await win.waitForTimeout(500);
  }
  check('VS Code page opened', Boolean(code), code && code.url().replace(/tkn=[0-9a-f]+/, 'tkn=…'));
  await code.waitForSelector('.monaco-workbench', { timeout: 120000 });
  // VS Code asks once per folder whether to trust it (Workspace Trust).
  const trust = async () => {
    await code.waitForTimeout(2500);
    if (await code.locator('.monaco-dialog-box').count()) {
      console.log('dialog:', (await code.locator('.monaco-dialog-box').innerText()).replace(/\s+/g, ' ').slice(0, 160));
      await code.screenshot({ path: SP + '/vscode-trust.png' });
      await code.locator('.monaco-dialog-box .monaco-button:has-text("Trust")').first().click();
      await code.waitForTimeout(800);
    }
  };
  await trust();
  check('server on 127.0.0.1 with a token file, telemetry off', /server-main\.js --host 127\.0\.0\.1 --port \d+ --connection-token-file .* --telemetry-level off/.test(ps()) && !/--connection-token [0-9a-f]/.test(ps()));

  const projects = (await win.evaluate(() => window.blazma.vscodeStatus())).projects;
  check('old studio project moved to a folder', fs.readFileSync(projects + '/لعبتي/js/game.js', 'utf8') === 'console.log(1)' && !fs.existsSync(projects + '/evil.txt') && !fs.existsSync(path.dirname(projects) + '/evil.txt'), projects);
  await code.waitForSelector('.explorer-folders-view, .explorer-viewlet', { timeout: 60000 }).catch(() => {});
  await code.waitForTimeout(2500);
  const tree = await code.locator('.monaco-list-row').allInnerTexts().catch(() => []);
  check('explorer shows "Blazma Projects"', tree.some((t) => t.includes('لعبتي')), tree.slice(0, 6).join(' | '));
  const box = await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; const v = w.contentView.children[0]; return v ? { ...v.getBounds(), visible: v.getVisible() } : null; });
  const host = await win.locator('#code-host').boundingBox();
  check('editor placed over the page area', box && box.visible && Math.abs(box.x - host.x) < 2 && Math.abs(box.y - host.y) < 2 && Math.abs(box.width - host.width) < 2, JSON.stringify(box));
  await code.screenshot({ path: SP + '/vscode-1.png' });
  await win.screenshot({ path: SP + '/vscode-0-frame.png' });

  // The terminal is real: a command writes a file on disk.
  await code.keyboard.press('Control+Backquote');
  await code.waitForSelector('.xterm', { timeout: 60000 });
  await code.waitForTimeout(4000); // the shell starts
  await trust();
  await code.click('.xterm'); await code.waitForTimeout(500);
  await code.keyboard.type(`node -e "require('fs').writeFileSync('from-terminal.txt', 'ok ' + process.version)"`);
  await code.keyboard.press('Enter');
  let written = '';
  for (let i = 0; i < 40 && !written; i++) { await code.waitForTimeout(500); try { written = fs.readFileSync(projects + '/from-terminal.txt', 'utf8'); } catch {} }
  check('terminal runs real commands', /^ok v\d+/.test(written), written);
  await code.screenshot({ path: SP + '/vscode-2-terminal.png' });

  // A webview (Markdown preview) loads its host page from the local copy.
  fs.writeFileSync(projects + '/README.md', '# تجربة المعاينة\n\nنص **عريض**.');
  const cdnHits = [];
  code.on('request', (r) => { if (r.url().includes('vscode-cdn.net')) cdnHits.push(r.url()); });
  await trust();
  await code.click('.monaco-list-row:has-text("README.md")'); await code.waitForTimeout(1500);
  await code.click('.editor-instance .view-lines'); await code.waitForTimeout(300);
  await code.keyboard.press('Control+Shift+v'); await code.waitForTimeout(6000);
  const preview = await (async () => {
    for (const f of code.frames()) {
      const t = await f.evaluate(() => document.body && document.body.innerText).catch(() => '');
      if (t && t.includes('تجربة المعاينة')) return t;
    }
    return '';
  })();
  check('webview (Markdown preview) works offline from the local copy', preview.includes('عريض') && cdnHits.length > 0, `${cdnHits.length} requests served locally`);
  await code.screenshot({ path: SP + '/vscode-3-preview.png' });

  // Leaving the page hides the editor; coming back shows the same one.
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(600);
  const hidden = await app.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0].contentView.children[0].getVisible());
  check('hidden on other pages', hidden);

  // Code from the chat opens in VS Code as a file.
  await win.evaluate(() => window.dispatchEvent(new CustomEvent('blazma:open-in-studio', { detail: { code: '<p>من المحادثة</p>', lang: 'html' } })));
  await win.waitForTimeout(4000);
  const fromChat = fs.existsSync(projects + '/من المحادثة') ? fs.readdirSync(projects + '/من المحادثة') : [];
  const snippetFile = fromChat.length ? projects + '/من المحادثة/' + fromChat[0] + '/index.html' : '';
  check('code from the chat saved and opened', snippetFile && fs.readFileSync(snippetFile, 'utf8').includes('من المحادثة') && decodeURIComponent(code.url().replace(/\+/g, ' ')).includes('من المحادثة'), decodeURIComponent(code.url()).replace(/tkn=[0-9a-f]+/, ''));

  // AI: with Continue present (stubbed here: Open VSX is not reachable in this
  // test environment), connecting turns on the API and writes Continue's config.
  fs.mkdirSync(USER + '/vscode/extensions/continue.continue-9.9.9', { recursive: true });
  await win.click('.nav-item[data-page="studio"]'); await win.waitForSelector('.code-bar');
  await win.evaluate(() => window.blazma.apiSetEnabled(false));
  const res = await win.evaluate(() => window.blazma.vscodeConnectAi());
  const cfgFile = USER + '/vscode/continue/config.yaml';
  const cfg = fs.existsSync(cfgFile) ? fs.readFileSync(cfgFile, 'utf8') : '';
  const st = await win.evaluate(() => window.blazma.getSettings());
  check('AI connect: API on, Continue config points at it', res.ok && st.apiEnabled && cfg.includes('provider: openai') && cfg.includes(`apiKey: "${st.apiKey}"`) && /apiBase: "http:\/\/127\.0\.0\.1:\d+\/v1"/.test(cfg), cfg.split('\n').slice(4, 8).join(' '));
  check('Continue settings kept in the app folder', /CONTINUE_GLOBAL_DIR/.test(execSync(`cat /proc/$(pgrep -f "server-main.js --host 127.0.0.1" | head -1)/environ | tr '\\0' '\\n' | grep CONTINUE || true`).toString()));
  await win.evaluate(() => window.blazma.apiSetEnabled(false));

  await app.close();
  await new Promise((r) => setTimeout(r, 1500));
  check('VS Code server stopped with the app', !/server-main\.js --host 127\.0\.0\.1/.test(ps()));
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
