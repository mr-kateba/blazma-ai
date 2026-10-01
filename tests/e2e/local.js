const { _electron } = require('playwright-core');
const fs = require('fs'); const cp = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, OLLAMA_MODELS: SP + '/fake-ollama', XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const phase = (win) => win.evaluate(() => window.blazma.getSetupState().then(s => s.phase + ':' + s.modelId + ':vision=' + s.vision));
(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/custom-models.json', { force: true });
  { const f = SP + '/e2e-home/Blazma AI/settings.json'; const st = JSON.parse(fs.readFileSync(f, 'utf8')); st.activeModelId = 'qwen3.5-2b'; fs.writeFileSync(f, JSON.stringify(st)); }
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push('console: ' + m.text().slice(0, 200)));
  win.on('dialog', d => d.accept()); await win.evaluate(() => new MutationObserver(() => { const b = document.querySelector('.dlg-ok'); if (b) b.click(); }).observe(document.body, { childList: true })); // accept in-app confirmations (lib/dialog.js)
  for (let i = 0; i < 600 && !(await phase(win)).startsWith('ready'); i++) await win.waitForTimeout(300);
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(800);
  await win.click('.btn:has-text("موديلات Ollama على جهازي")'); await win.waitForTimeout(800);
  console.log('ollama rows:', (await win.locator('.ollama-row').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')));
  await win.click('.ollama-row:has-text("qwen-vision:2b") .btn'); await win.waitForTimeout(800);
  console.log('status:', await win.locator('.add-status').first().innerText());
  const card = '.model-card:has-text("qwen-vision:2b")';
  console.log('card:', (await win.locator(card).innerText()).replace(/\s+/g, ' ').slice(0, 220));
  await win.screenshot({ path: SP + '/local-1.png', fullPage: true });
  const localId = await win.evaluate(() => window.blazma.modelsList().then(l => l.find(m => m.source === 'ollama').id));
  await win.click(`${card} button.primary`);
  for (let i = 0; i < 400 && !(await phase(win)).startsWith('ready:' + localId); i++) await win.waitForTimeout(300);
  console.log('after use:', await phase(win));
  const full = cp.execSync("ps -eo args | grep '[l]lama-server' | head -1").toString().trim();
  console.log('ARGS:', full.replace(SP, '$SP'));
  const port = /--port (\d+)/.exec(full)[1];
  console.log('health now:', cp.execSync('curl -s -m 3 127.0.0.1:' + port + '/health || true').toString());
  const args = cp.execSync("ps -eo args | grep '[l]lama-server' | head -1").toString().trim();
  console.log('server uses -m blob:', /-m \S*sha256-a{64}/.test(args), '| --mmproj blob:', /--mmproj \S*sha256-b{64}/.test(args), '| -ctk q8_0:', /-ctk q8_0/.test(args), '| no -hf:', !/-hf /.test(args));
  await win.click('.nav-item[data-page="chat"]'); await win.click('#btn-new-chat');
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false }));
  await win.fill('#chat-input', 'ما عاصمة مصر؟ أجب بكلمة.'); await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 1500000 }); await win.waitForTimeout(400);
  console.log('answer from Ollama model:', await win.locator('.msg-ai .msg-body').last().innerText());
  // add a GGUF file via the (stubbed) dialog: 0.8B next to a 2B projector -> must NOT pair
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, SP + '/hfsrc/Qwen3.5-0.8B-Q4_K_M.gguf');
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(500);
  await win.click('.btn:has-text("إضافة ملف GGUF")'); await win.waitForTimeout(1500);
  console.log('file add status:', await win.locator('.add-status').first().innerText());
  const local = await win.evaluate(() => window.blazma.modelsList().then(l => l.filter(m => m.local).map(m => ({ name: m.name, vision: m.vision, source: m.source, downloaded: m.downloaded }))));
  console.log('local models:', JSON.stringify(local));
  // projector file rejected
  await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, SP + '/hfsrc/mmproj-BF16.gguf');
  await win.click('.btn:has-text("إضافة ملف GGUF")'); await win.waitForTimeout(800);
  console.log('projector add:', await win.locator('.add-status').first().innerText());
  // switch back to catalog 2B and remove the local entries
  await win.click('.model-card:has-text("Qwen3.5 2B") button.primary');
  for (let i = 0; i < 300 && !(await phase(win)).startsWith('ready:qwen3.5-2b'); i++) await win.waitForTimeout(300);
  for (const n of ['qwen-vision:2b', 'Qwen3.5-0.8B']) { await win.click(`.model-card:has-text("${n}") button:has-text("إزالة")`); await win.waitForTimeout(500); }
  console.log('blob still on disk after remove:', fs.existsSync(SP + '/fake-ollama/blobs/sha256-' + 'a'.repeat(64)), '| local left:', await win.evaluate(() => window.blazma.modelsList().then(l => l.filter(m => m.local).length)));
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: true }));
  console.log(logs.join('\n') || 'no errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
