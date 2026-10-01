const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, HOME: SP + '/imp/lmhome', PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const phase = (win) => win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase + ':' + s.modelId));
const rows = (win) => win.locator('.ollama-row').allInnerTexts().then((a) => a.map((t) => t.replace(/\s+/g, ' ')));
(async () => {
  fs.writeFileSync(SP + '/e2e-home/Blazma AI/custom-models.json', '[]');
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', (e) => logs.push('pageerror: ' + e.message)); win.on('console', (m) => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1366, 900));
  for (let i = 0; i < 300 && !(await phase(win)).startsWith('ready'); i++) await win.waitForTimeout(300);
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(600);
  // LM Studio
  await win.click('button:has-text("موديلات LM Studio")'); await win.waitForTimeout(800);
  console.log('lmstudio rows:', await rows(win));
  await win.click('.ollama-row button:has-text("إضافة")'); await win.waitForTimeout(800);
  console.log('status:', await win.textContent('.local-models .add-status'));
  // any folder (dialog stubbed)
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, SP + '/imp/myfolder');
  await win.click('button:has-text("إضافة مجلد")'); await win.waitForTimeout(1000);
  console.log('folder rows:', await rows(win));
  await win.locator('.local-models').scrollIntoViewIfNeeded(); await win.mouse.move(5, 5);
  await win.screenshot({ path: SP + '/imp-1-folder.png' });
  const addAll = await win.locator('button:has-text("إضافة الكل")').count();
  await win.click('.ollama-row:has-text("MySplit") button:has-text("إضافة")'); await win.waitForTimeout(800);
  console.log('addAll shown:', addAll, '| status:', await win.textContent('.local-models .add-status'));
  // drag and drop a real file (from an <input>, so it has a path) and a non-GGUF file
  await win.evaluate(() => { const i = document.createElement('input'); i.type = 'file'; i.multiple = true; i.id = 'tmp-drop'; i.hidden = true; document.body.append(i); });
  const ggufPath = SP + '/imp/dropme/Dropped-Q4_K_M.gguf';
  fs.mkdirSync(SP + '/imp/dropme', { recursive: true }); try { fs.linkSync(SP + '/hfsrc/Qwen3.5-0.8B-Q4_K_M.gguf', ggufPath); } catch {}
  for (const files of [[ggufPath], [SP + '/docs/code.py']]) {
    await win.setInputFiles('#tmp-drop', files);
    await win.evaluate(() => {
      const dt = new DataTransfer(); for (const f of document.getElementById('tmp-drop').files) dt.items.add(f);
      const root = document.getElementById('models-root');
      root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    await win.waitForTimeout(1000);
    console.log('drop', files[0].split('/').pop(), '->', await win.textContent('.local-models .add-status'));
  }
  const custom = JSON.parse(fs.readFileSync(SP + '/e2e-home/Blazma AI/custom-models.json', 'utf8'));
  console.log('custom:', custom.map((m) => `${m.name} [${m.source}] ${m.sizeBytes} mmproj=${Boolean(m.mmproj)} ${m.path.split('/').slice(-2).join('/')}`));
  // run the split model
  const split = custom.find((m) => m.path.includes('MySplit'));
  await win.evaluate((id) => window.blazma.modelsUse(id), split.id);
  for (let i = 0; i < 300 && !['ready', 'error'].includes((await phase(win)).split(':')[0]); i++) await win.waitForTimeout(500);
  console.log('split phase:', await phase(win));
  console.log('args:', execSync('pgrep -af "^\\S*llama-server " || true').toString().replace(/.*llama-server/, '').trim().slice(0, 300));
  await win.click('.nav-item[data-page="chat"]'); await win.click('#btn-new-chat');
  await win.fill('#chat-input', 'ما عاصمة فرنسا؟ أجب بكلمة.'); await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 900000 }); await win.waitForTimeout(500);
  console.log('answer:', (await win.locator('.msg-ai .msg-body').last().innerText()).slice(0, 100));
  await win.evaluate(() => window.blazma.modelsUse('qwen3.5-2b'));
  for (let i = 0; i < 300 && (await phase(win)) !== 'ready:qwen3.5-2b'; i++) await win.waitForTimeout(500);
  console.log('restored:', await phase(win));
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
