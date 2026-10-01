const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..'), WITH_AI = process.argv[3] === 'ai';
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const out = (...a) => console.log(...a);
(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/studio', { recursive: true, force: true });
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push('console: ' + m.text()));
  win.on('dialog', d => d.accept());
  await win.evaluate(() => localStorage.clear());
  await win.click('.nav-item[data-page="studio"]'); await win.waitForTimeout(2000);
  const val = () => win.evaluate(() => document.querySelector('.ed-input').value);
  const termText = () => win.evaluate(() => [...document.querySelectorAll('.term-row')].map(r => r.textContent));
  const frame = win.frameLocator('.pv-frame');
  const term = async (cmd) => { if (await win.evaluate(() => document.querySelector('.term-input').offsetParent === null)) await win.click('.ptab[data-tab="terminal"]'); await win.fill('.term-input', cmd); await win.press('.term-input', 'Enter'); await win.waitForTimeout(350); };

  out('tree:', await win.locator('.tree-row').allInnerTexts());
  out('tabs:', await win.locator('.tab').allInnerTexts(), '| crumbs:', await win.innerText('.wb-crumbs'));
  out('preview h1:', await frame.locator('h1').textContent());
  out('status:', (await win.innerText('.wb-status')).replace(/\s+/g, ' '));
  // highlight layer mirrors textarea exactly
  out('pre==textarea:', await win.evaluate(() => document.querySelector('.ed-code').textContent === document.querySelector('.ed-input').value + '\n'));
  out('tokens in index.html:', await win.evaluate(() => [...new Set([...document.querySelectorAll('.ed-code span')].map(s => s.className))].join(' ')));

  // typing with auto-close / auto-indent in script.js
  await win.click('.tree-row[data-file="script.js"]');
  await win.click('.ed-input'); await win.keyboard.press('Control+End');
  await win.keyboard.press('Enter');
  await win.keyboard.type('function hello(name) {');
  await win.keyboard.press('Enter');
  await win.keyboard.type("console.log('hi ' + name");
  const typed = await val();
  out('typed tail:', JSON.stringify(typed.slice(typed.indexOf('function hello'))));
  await win.keyboard.press('Control+z');
  out('after undo:', JSON.stringify((await val()).slice(-40)));
  await win.keyboard.press('Control+y');
  await win.keyboard.press('Control+/');
  out('after Ctrl+/:', JSON.stringify((await val()).split('\n').find(l => l.includes("console.log('hi"))));
  await win.keyboard.press('Control+/');
  await win.keyboard.press('Alt+ArrowUp');
  out('after Alt+Up (line moved):', JSON.stringify((await val()).split('\n').slice(-4)));
  await win.keyboard.press('Control+z');
  out('status pos:', await win.innerText('.wb-status .st-group:last-child'));

  // quick open + palette
  await win.keyboard.press('Control+p'); await win.waitForTimeout(200);
  await win.keyboard.type('sty'); await win.keyboard.press('Enter'); await win.waitForTimeout(200);
  out('quick open ->', await win.innerText('.tab.active'));
  await win.keyboard.press('Control+Shift+P'); await win.waitForTimeout(200);
  await win.keyboard.type('إخفاء اللوحة'); 
  out('palette items:', await win.locator('.pal-item').allInnerTexts());
  await win.keyboard.press('Enter'); await win.waitForTimeout(200);
  out('panel hidden after command:', await win.evaluate(() => document.querySelector('.wb-panel').hidden));
  await win.keyboard.press('Control+j'); await win.waitForTimeout(200);
  out('panel shown after Ctrl+J:', !(await win.evaluate(() => document.querySelector('.wb-panel').hidden)));
  await win.keyboard.press('Control+g'); await win.keyboard.type('5'); await win.keyboard.press('Enter'); await win.waitForTimeout(200);
  out('goto line 5 ->', await win.innerText('.wb-status .st-group:last-child'));
  await win.keyboard.press('Control+f'); await win.keyboard.type('px');
  out('find:', await win.innerText('.ed-find-count'), '| marks:', await win.locator('.ed-marks mark').count());
  await win.keyboard.press('Escape');
  await win.screenshot({ path: SP + '/vs-2-editor.png' });

  // terminal
  await win.click('.ptab[data-tab="terminal"]');
  for (const c of ['help', 'ls', 'mkdir js', 'touch js/app.js', `echo "console.log('hi from node', 6 * 7)" > js/app.js`, 'cat js/app.js', 'node js/app.js']) await term(c);
  await win.waitForTimeout(1200);
  await term('cd js'); await term('ls'); await term('mv app.js main.js'); await term('cd ..'); await term('tree');
  await term('js document.title = "عنوان"; document.querySelectorAll("*").length');
  await term('npm install lodash'); await term('python app.py'); await term('git status'); await term('foo');
  await term('rm js'); await term('rm -r js'); await term('ls');
  const tt = await termText();
  out('terminal:\n  ' + tt.filter(l => !/^  \S/.test(l) || l.includes('node')).slice(-40).join('\n  '));
  await win.screenshot({ path: SP + '/vs-3-terminal.png' });

  // runtime error -> problems -> jump to line
  await term('echo "let a = 1;" > bug.js'); await term('echo "undefinedFn(a);" >> bug.js');
  await term('node bug.js'); await win.waitForTimeout(1200);
  out('problems badge:', await win.innerText('.ptab-count'), '| status:', (await win.innerText('.wb-status .st-group')).replace(/\s+/g, ' '));
  await win.click('.ptab[data-tab="problems"]');
  out('problems:', await win.locator('.prob-row').allInnerTexts());
  await win.click('.prob-row'); await win.waitForTimeout(300);
  out('jumped to:', await win.innerText('.tab.active'), await win.innerText('.wb-status .st-group:last-child'));
  await win.screenshot({ path: SP + '/vs-4-problems.png' });
  await term('rm bug.js');

  // debug console REPL
  await win.click('.nav-item[data-page="studio"]');
  await win.keyboard.press('F5'); await win.waitForTimeout(1200);
  await win.click('.ptab[data-tab="console"]');
  await win.fill('.repl-input', 'document.querySelector("h1").textContent'); await win.press('.repl-input', 'Enter'); await win.waitForTimeout(400);
  out('repl:', await win.locator('.con-row').allInnerTexts());

  // search across files
  await win.keyboard.press('Control+Shift+F'); await win.keyboard.type('count');
  await win.waitForTimeout(400);
  out('search:', await win.innerText('.sr-summary'), '|', (await win.locator('.sr-hit').allInnerTexts()).slice(0, 3));
  await win.locator('.sr-hit').first().click(); await win.waitForTimeout(200);
  out('search click ->', await win.innerText('.tab.active'), await win.innerText('.wb-status .st-group:last-child'));
  await win.screenshot({ path: SP + '/vs-5-search.png' });

  // live preview: edit h1 in index.html
  await win.keyboard.press('Control+Shift+E');
  await win.click('.tree-row[data-file="index.html"]');
  const v = await val(); const i = v.indexOf('مرحباً!');
  await win.evaluate((i) => { const t = document.querySelector('.ed-input'); t.focus(); t.setSelectionRange(i, i + 'مرحباً!'.length); }, i);
  await win.keyboard.type('أهلاً بالتحديث المباشر');
  await win.waitForTimeout(2200);
  out('live preview h1:', await frame.locator('h1').textContent());

  // ES modules inside the sandbox
  await term('echo "export const twice = (x) => x * 2;" > lib.js');
  await term(`echo "import { twice } from './lib.js'; console.log('module ok', twice(21));" > app.mjs`);
  await term('node app.mjs'); await win.waitForTimeout(1500);
  out('module run:', (await termText()).slice(-2));

  // isolation from inside the preview
  await term(`echo "fetch('https://example.com').then(() => console.log('NET OPEN')).catch(e => console.log('net blocked', e.name)); try { parent.document; console.log('PARENT OPEN'); } catch (e) { console.log('parent blocked', e.name); } console.log('bridge', typeof window.blazma);" > iso.js`);
  await term('node iso.js'); await win.waitForTimeout(1500);
  out('isolation:', (await termText()).slice(-4));
  await term('rm iso.js'); await term('rm app.mjs'); await term('rm lib.js');

  // explorer: new file inline, rename, context menu
  await win.click('.proj-actions .wb-icon-btn >> nth=0').catch(async () => { await win.hover('.proj-head'); await win.click('.proj-actions .wb-icon-btn >> nth=0'); });
  await win.keyboard.type('notes.md'); await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  out('new file tab:', await win.innerText('.tab.active'));
  await win.keyboard.type('# عنوان\n- عنصر `code`');
  await win.click('.tree-row[data-file="notes.md"]', { button: 'right' });
  out('context menu:', await win.locator('.ctx-item').allInnerTexts());
  await win.click('.ctx-item:has-text("إعادة تسمية")');
  await win.keyboard.press('Control+a'); await win.keyboard.type('docs/readme.md'); await win.keyboard.press('Enter'); await win.waitForTimeout(300);
  out('tree after rename:', await win.locator('.tree-row').allInnerTexts());
  await win.click('.menu-btn[data-menu="file"]'); await win.waitForTimeout(150);
  out('file menu:', await win.locator('.ctx-item').allInnerTexts());
  await win.screenshot({ path: SP + '/vs-6-menu.png' });
  await win.keyboard.press('Escape');

  // persistence after reload
  await win.waitForTimeout(1200);
  const saved = JSON.parse(fs.readFileSync(fs.readdirSync(SP + '/e2e-home/Blazma AI/studio').map(f => SP + '/e2e-home/Blazma AI/studio/' + f)[0], 'utf8'));
  out('saved files:', Object.keys(saved.files).sort().join(', '));

  if (WITH_AI) {
    for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
    await win.keyboard.press('Control+Shift+N'); await win.waitForTimeout(1200);
    await win.keyboard.press('Control+Alt+i');
    await win.fill('.ai-input', 'اعمل صفحة فيها عداد: زر + يزيد الرقم وزر تصفير يرجعه صفر، واطبع الرقم في console.log عند كل تغيير. بعد الكتابة شغّل المشروع وتأكد أنه بدون أخطاء.');
    await win.press('.ai-input', 'Enter');
    await win.waitForTimeout(1500);
    await win.waitForSelector('.ai-form .btn.primary:not([hidden])', { timeout: 1200000 });
    await win.waitForTimeout(1500);
    out('AI log:', (await win.locator('.ai-entry').allInnerTexts()).map(t => t.slice(0, 140)));
    out('files after AI:', await win.locator('.tree-row').allInnerTexts());
    const btns = await frame.locator('button').allTextContents().catch(() => []);
    out('preview buttons:', btns);
    await win.click('.ptab[data-tab="console"]');
    if (btns.length) { await frame.locator('button').first().click(); await frame.locator('button').first().click(); await win.waitForTimeout(300); }
    out('console after clicks:', await win.locator('.con-row').allInnerTexts());
    out('problems:', await win.innerText('.wb-status .st-group'));
    await win.screenshot({ path: SP + '/vs-7-ai.png' });
  }
  out(logs.join('\n') || 'no page errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
