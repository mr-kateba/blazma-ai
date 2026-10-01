const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const phase = (win) => win.evaluate(() => window.blazma.getSetupState().then(s => s.phase + ':' + s.modelId));
(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/custom-models.json', { force: true });
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  win.on('dialog', d => d.accept()); await win.evaluate(() => new MutationObserver(() => { const b = document.querySelector('.dlg-ok'); if (b) b.click(); }).observe(document.body, { childList: true })); // accept in-app confirmations (lib/dialog.js)
  for (let i = 0; i < 600 && !(await phase(win)).startsWith('ready'); i++) await win.waitForTimeout(300);
  console.log('start:', await phase(win));
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(800);
  const cards = async () => (await win.locator('.model-card').allInnerTexts()).map(t => t.replace(/\s+/g, ' ').slice(0, 140));
  console.log('cards:\n ' + (await cards()).join('\n '));
  await win.screenshot({ path: SP + '/models-1.png' });

  // delete active -> no delete button on active card; call directly
  console.log('delete active via IPC:', JSON.stringify(await win.evaluate(() => window.blazma.modelsDelete('qwen3.5-2b'))));

  // switch to qwen3.5-4b (mock serves the 0.8B file) and watch progress
  await win.click('.model-card:has-text("Qwen3.5 4B") button.primary');
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const p = await phase(win); seen.add(p.split(':')[0]);
    const btn = await win.locator('.model-card:has-text("Qwen3.5 4B") button').first().textContent().catch(() => '');
    if (/التنزيل \d+%/.test(btn)) seen.add(btn);
    if (p === 'ready:qwen3.5-4b') break;
    if (i === 8) await win.screenshot({ path: SP + '/models-2-dl.png' });
    await win.waitForTimeout(250);
  }
  console.log('phases/progress seen:', [...seen].join(' | '));
  console.log('now:', await phase(win));
  await win.waitForTimeout(500);
  console.log('cards:\n ' + (await cards()).join('\n '));
  // chat works on the new model without restart
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(300);
  console.log('model pill:', await win.textContent('#model-pill'));
  await win.click('.nav-item[data-page="models"]'); await win.waitForTimeout(500);

  // delete the now inactive 2B? no - delete the 4B after switching back to 2B
  await win.click('.model-card:has-text("Qwen3.5 2B") button.primary');
  for (let i = 0; i < 400 && (await phase(win)) !== 'ready:qwen3.5-2b'; i++) await win.waitForTimeout(250);
  await win.waitForTimeout(500);
  console.log('back:', await phase(win));
  await win.click('.model-card:has-text("Qwen3.5 4B") button:has-text("حذف من الجهاز")'); await win.waitForTimeout(800);
  console.log('after delete 4B:', (await cards()).find(c => c.includes('4B')));

  // custom add: invalid, not found, valid
  for (const hf of ['not a repo', 'someone/NoSuch-GGUF:Q4_K_M', 'unsloth/Qwen3.5-0.8B-GGUF:Q4_K_M', 'unsloth/TestOne-GGUF:Q4_K_M']) {
    await win.fill('#custom-hf', hf); await win.click('.add-model:has(#custom-hf) button.primary');
    await win.waitForSelector('.add-status.ok, .add-status.error', { timeout: 30000 }); 
    console.log('add', JSON.stringify(hf), '->', await win.textContent('.add-status'));
  }
  console.log('cards:\n ' + (await cards()).join('\n '));
  console.log('custom file:', fs.readFileSync(SP + '/e2e-home/Blazma AI/custom-models.json', 'utf8').slice(0, 300));
  await win.screenshot({ path: SP + '/models-3.png', fullPage: true });
  await win.click('.model-card:has-text("TestOne") button:has-text("إزالة")'); await win.waitForTimeout(600);
  console.log('after remove custom:', (await cards()).length, 'cards');
  console.log(logs.join('\n'));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
