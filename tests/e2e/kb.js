// "مكتبتي": folders added in Settings, indexed with the embedding model
// (BLAZMA_EMBED_MODEL: a local Qwen3-Embedding-0.6B file), searched by
// meaning, used in the chat with the file names shown as sources.
const { _electron } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const SP = process.argv[2], root = path.resolve(__dirname, '../..');
const KB = path.join(SP, 'kb'), DOCS = path.join(SP, 'kb-docs');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999', BLAZMA_EMBED_MODEL: SP + '/models/Qwen3-Embedding-0.6B-Q8_0.gguf' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
async function ready(win) { for (let i = 0; i < 1200 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); }
async function waitIdle(win) { await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 900000 }); await win.waitForTimeout(400); }
const top = (win, q) => win.evaluate((q) => window.blazma.kbSearch(q), q).then((r) => (r.ok ? r.result.map((x) => `${x.name}:${x.score.toFixed(2)}`) : [r.error.code]));

(async () => {
  // Copies, so the test can change a file and see it re-read.
  fs.rmSync(KB, { recursive: true, force: true }); fs.rmSync(DOCS, { recursive: true, force: true });
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'kb'), KB, { recursive: true });
  fs.cpSync(path.join(__dirname, '..', 'fixtures', 'docs'), DOCS, { recursive: true });
  fs.rmSync(SP + '/e2e-home/Blazma AI/knowledge', { recursive: true, force: true });

  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  win.on('dialog', d => d.accept());
  await ready(win);
  if (await win.evaluate(() => localStorage.getItem('blazma.persona'))) { await win.evaluate(() => localStorage.removeItem('blazma.persona')); await win.reload(); await win.waitForLoadState('load'); await ready(win); }
  if ((await win.evaluate(() => window.blazma.getSetupState())).modelId !== 'qwen3.5-2b') { await win.evaluate(() => window.blazma.modelsUse('qwen3.5-2b')); await win.waitForTimeout(800); await ready(win); }
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false, kbInChat: false }));

  // Settings → مكتبتي: add two folders (the folder picker is stubbed), update.
  await win.click('.nav-item[data-page="settings"]'); await win.waitForTimeout(800);
  for (const folder of [KB, DOCS]) {
    await app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [p] }); }, folder);
    await win.click('#set-kb button:has-text("إضافة مجلد")'); await win.waitForTimeout(600);
  }
  check('two folders listed', (await win.locator('#set-kb .kb-path').count()) === 2);
  const progress = [];
  await win.evaluate(() => { window.__kbp = []; window.blazma.onKbProgress((p) => window.__kbp.push(p)); });
  const t0 = Date.now();
  await win.click('#set-kb button:has-text("تحديث الفهرس")');
  await win.waitForSelector('#set-kb button:has-text("تحديث الفهرس"):not([disabled])', { timeout: 1800000 });
  progress.push(...(await win.evaluate(() => window.__kbp)));
  let st = await win.evaluate(() => window.blazma.kbStatus());
  // kb: 3 files; docs: code.py, guide.pdf, old-arabic.txt, policy.html, report.docx (evil.exe is skipped).
  check('all supported files indexed', st.files === 8 && st.failed === 0 && st.chunks >= 8, `${JSON.stringify(st)} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  check('progress reported per file', progress.filter((p) => p.file).length === 8);
  check('status line in settings', /8 ملف/.test(await win.locator('#kb-status').innerText()), await win.locator('#kb-status').innerText());
  await win.locator('#set-kb').scrollIntoViewIfNeeded(); await win.screenshot({ path: SP + '/kb-1-settings.png' });

  // Search by meaning, worded differently from the files.
  let r = await top(win, 'كم يوماً يحق للموظف أن يأخذ عطلة في السنة؟');
  check('leave question finds the policy', /policy\.html|guide\.pdf/.test(r[0]), r.slice(0, 3).join(' '));
  r = await top(win, 'متى لازم أبدل زيت الموتور؟');
  check('oil question finds car.txt', r[0].startsWith('car.txt'), r.slice(0, 3).join(' '));
  r = await top(win, 'كيف أطبخ رز بالدجاج؟');
  check('cooking question finds the recipe', r[0].startsWith('recipe.md'), r.slice(0, 3).join(' '));
  r = await top(win, 'what is the code to enter the meeting room?');
  check('English question finds the Arabic note', r[0].startsWith('meeting.txt'), r.slice(0, 3).join(' '));

  // Only new or changed files are read again.
  await win.evaluate(() => { window.__kbp = []; });
  await win.evaluate(() => window.blazma.kbUpdate());
  check('nothing changed -> nothing re-read', (await win.evaluate(() => window.__kbp.filter((p) => p.file).length)) === 0);
  fs.appendFileSync(path.join(KB, 'car.txt'), '\nيجب فحص البطارية كل ثلاثة أشهر.\n');
  fs.rmSync(path.join(DOCS, 'code.py'));
  await win.evaluate(() => { window.__kbp = []; });
  await win.evaluate(() => window.blazma.kbUpdate());
  const reread = await win.evaluate(() => window.__kbp.filter((p) => p.file).map((p) => p.file));
  st = await win.evaluate(() => window.blazma.kbStatus());
  check('changed file re-read, deleted file dropped', reread.join() === 'car.txt' && st.files === 7, `${reread} files=${st.files}`);

  // Chat with "مكتبتي" on: the answer uses the note, the source is shown.
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(500);
  await win.click('#btn-new-chat'); await win.waitForTimeout(300);
  await win.click('#btn-kb'); await win.waitForTimeout(300);
  check('book button on', (await win.getAttribute('#btn-kb', 'aria-pressed')) === 'true');
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.fetch = (u, o) => { if (o && o.body) window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });
  await win.fill('#chat-input', 'ما رمز الدخول إلى قاعة الاجتماعات؟'); await win.press('#chat-input', 'Enter'); await waitIdle(win);
  const answer = await win.locator('.msg-ai .msg-body').last().innerText();
  const sources = await win.locator('.msg-ai .kb-source').allTextContents();
  const sys = await win.evaluate(() => (window.__reqs.at(-1) || { messages: [{}] }).messages[0].content || '');
  check('passages sent to the model', sys.includes('4821') && sys.includes('meeting.txt'));
  check('answer uses the document', /4821|٤٨٢١/.test(answer), answer.replace(/\s+/g, ' ').slice(0, 120));
  check('file shown as a source, unrelated files left out', sources[0] === 'meeting.txt' && sources.length <= 2, sources.join(', '));
  await win.screenshot({ path: SP + '/kb-2-chat.png' });

  // A source opens the file's folder; paths outside the index are refused.
  await app.evaluate(({ shell }) => { global.__shown = []; shell.showItemInFolder = (p) => global.__shown.push(p); });
  await win.locator('.msg-ai .kb-source:has-text("meeting.txt")').first().click(); await win.waitForTimeout(300);
  await win.evaluate((p) => window.blazma.kbReveal(p), KB + '-secret/x.txt');
  await win.evaluate(() => window.blazma.kbReveal('/etc/passwd'));
  const shown = await app.evaluate(() => global.__shown);
  check('only indexed files are revealed', shown.length === 1 && shown[0].endsWith('meeting.txt'), JSON.stringify(shown));

  // Removing a folder forgets its files.
  await win.evaluate((p) => window.blazma.kbRemoveFolder(p), DOCS);
  st = await win.evaluate(() => window.blazma.kbStatus());
  check('folder removed', st.folders.length === 1 && st.files === 3, JSON.stringify(st));
  check('embedding server on 127.0.0.1 only', /--embedding.*--host 127\.0\.0\.1/.test(execSync('ps -eo args').toString()));

  await win.evaluate(() => window.blazma.updateSettings({ kbInChat: false }));
  await app.close();
  await new Promise((res) => setTimeout(res, 1500));
  check('embedding server stopped with the app', !/--embedding --pooling/.test(execSync('ps -eo args').toString()));
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
