const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, PATH: `${SP}/fakebin:${process.env.PATH}`, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const out = (...a) => console.log(...a);
const tc = (name, args) => ({ name, args: JSON.stringify(args) });
(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => !/boom is not defined/.test(e.message) && logs.push('pageerror: ' + e.message)); // boom: a runtime error written on purpose for /fix
  win.on('dialog', d => d.accept());
  for (let i = 0; i < 600 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300);
  // Scripted model: each request takes the next reply from window.__script.
  await win.evaluate(() => {
    window.__reqs = []; window.__script = [];
    const orig = window.fetch;
    window.fetch = async (url, opts) => {
      if (!String(url).includes('/v1/chat/completions')) return orig(url, opts);
      const body = JSON.parse(opts.body); window.__reqs.push(body);
      const r = window.__script.shift() || { content: '(no script)' };
      const enc = new TextEncoder(); const ev = (o) => enc.encode('data: ' + JSON.stringify(o) + '\n\n');
      const stream = new ReadableStream({ async start(c) {
        if (r.reasoning) c.enqueue(ev({ choices: [{ delta: { reasoning_content: r.reasoning } }] }));
        if (r.content) for (const part of [r.content.slice(0, 5), r.content.slice(5)]) { c.enqueue(ev({ choices: [{ delta: { content: part } }] })); await new Promise(z => setTimeout(z, 30)); }
        (r.calls || []).forEach((t, i) => c.enqueue(ev({ choices: [{ delta: { tool_calls: [{ index: i, id: 'c' + i + Math.random().toString(36).slice(2, 6), function: { name: t.name, arguments: t.args } }] } }] })));
        c.enqueue(enc.encode('data: [DONE]\n\n')); c.close();
      } });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  });
  const script = (list) => win.evaluate((l) => { window.__script.push(...l); }, list);
  const lastReq = () => win.evaluate(() => window.__reqs[window.__reqs.length - 1]);
  const idle = async () => { await win.waitForTimeout(300); await win.waitForSelector('.ai-form .btn.primary:not([hidden])', { timeout: 60000 }); await win.waitForTimeout(300); };
  const model = (p) => win.evaluate((p) => { const m = window.require('vs/index').editor.getModels().find(m => m.uri.path === '/project/' + p); return m ? m.getValue() : null; }, p);
  const files = () => win.evaluate(async () => { const l = await window.blazma.studioList(); const p = await window.blazma.studioGet(l[0].id); return p.files; });

  await win.click('.nav-item[data-page="studio"]'); await win.waitForSelector('.monaco-editor', { timeout: 30000 });
  await win.keyboard.press('Control+Shift+N'); await win.keyboard.type('Canvas'); await win.keyboard.press('Enter'); await win.waitForTimeout(1500);
  await win.keyboard.press('Control+Alt+i'); await win.waitForTimeout(300);

  // Scenario 1: auto mode
  await script([
    { reasoning: 'I should change the color.', calls: [tc('todo_write', { todos: [{ content: 'تغيير لون المربع', status: 'in_progress' }, { content: 'التشغيل والتأكد', status: 'pending' }] }), tc('read_file', { path: 'game.js' })] },
    { calls: [tc('edit_file', { path: 'game.js', old_string: "ctx.fillStyle = '#ff6d00';", new_string: "  ctx.fillStyle = '#ff4d4d';" }), tc('edit_file', { path: 'game.js', old_string: 'this text does not exist', new_string: 'x' })] },
    { calls: [tc('run_project', {}), tc('run_command', { command: 'ls' }), tc('search_files', { query: 'fillStyle' })] },
    { calls: [tc('todo_write', { todos: [{ content: 'تغيير لون المربع', status: 'completed' }, { content: 'التشغيل والتأكد', status: 'completed' }] })] },
    { content: 'غيّرت لون المربع إلى **الأحمر** وشغّلت المشروع بدون أخطاء.' },
  ]);
  await win.fill('.ai-input', 'غيّر لون المربع إلى الأحمر'); await win.press('.ai-input', 'Enter'); await idle();
  out('cards:', (await win.locator('.tool-card').allInnerTexts()).map(t => t.replace(/\s+/g, ' ')));
  out('card states:', await win.evaluate(() => [...document.querySelectorAll('.tool-card')].map(c => c.className.replace('tool-card ', ''))));
  out('todos:', (await win.locator('.todo').allInnerTexts()), '|', await win.innerText('.ai-todos-head'));
  out('game.js has red:', (await model('game.js')).includes("  ctx.fillStyle = '#ff4d4d';"), '| original gone:', !(await model('game.js')).includes('#ff6d00'));
  out('answer:', await win.innerText('.ai-entry.assistant'));
  out('thinking block:', await win.locator('.ai-think').count());
  out('footer:', (await win.innerText('.turn-changes')).replace(/\s+/g, ' '));
  const reqs = await win.evaluate(() => window.__reqs.map(r => r.messages.filter(m => m.role === 'tool').map(m => m.content.slice(0, 90))));
  out('tool results seen by model (last request):', reqs[reqs.length - 1]);
  const first = await win.evaluate(() => window.__reqs[0]);
  out('request: stream', first.stream, '| tools', first.tools.map(t => t.function.name).join(','), '| user msg has open file:', first.messages[first.messages.length - 1].content.includes('open in the editor'));
  // expand edit card diff, then review diff window
  await win.locator('.tool-card.ok:has-text("تعديل game.js") .tc-head').click();
  out('inline diff:', await win.locator('.tool-card .diff-line.add, .tool-card .diff-line.del').allInnerTexts());
  await win.click('.tch-file'); await win.waitForTimeout(1200);
  out('diff window:', await win.locator('.diff-overlay .monaco-diff-editor').count());
  await win.screenshot({ path: SP + '/agent-1.png' });
  await win.click('.diff-modal-head .wb-icon-btn');
  // undo
  await win.click('.turn-changes .btn'); await win.waitForTimeout(800);
  out('after undo, orange back:', (await model('game.js')).includes('#ff6d00'), '| red gone:', !(await model('game.js')).includes('#ff4d4d'), '| footer:', await win.innerText('.turn-changes .btn'));

  // Scenario 2: ask mode, reject then accept
  await win.selectOption('.ai-mode', 'ask');
  await script([
    { calls: [tc('write_file', { path: 'rejected.js', content: "console.log('no')" })] },
    { calls: [tc('write_file', { path: 'accepted.js', content: "console.log('yes')" })] },
    { content: 'تم.' },
  ]);
  await win.fill('.ai-input', 'أنشئ ملفين'); await win.press('.ai-input', 'Enter');
  await win.waitForSelector('.tc-confirm'); out('confirm shown with diff:', await win.locator('.tool-card .tc-confirm').count(), await win.locator('.tool-card .diff-line.add').count() > 0);
  await win.click('.tc-confirm .btn:has-text("رفض")');
  await win.waitForSelector('.tc-confirm'); await win.click('.tc-confirm .btn:has-text("قبول")');
  await idle();
  const f2 = await files();
  out('rejected.js exists:', 'rejected.js' in f2, '| accepted.js exists:', 'accepted.js' in f2);
  const r2 = await win.evaluate(() => window.__reqs[window.__reqs.length - 2].messages.filter(m => m.role === 'tool').map(m => m.content));
  out('model told about rejection:', r2.some(t => t.includes('rejected')));
  await win.selectOption('.ai-mode', 'auto');

  // Scenario 3: slash commands and @mentions
  await script([{ content: 'شرح.' }]);
  await win.fill('.ai-input', 'اشرح @style.css باختصار'); await win.press('.ai-input', 'Enter'); await idle();
  const q = (await lastReq()).messages.slice(-1)[0].content;
  out('@mention attached:', q.includes('Content of style.css:') && q.includes('canvas {'));
  await win.fill('.ai-input', '/help'); await win.press('.ai-input', 'Enter'); await win.waitForTimeout(300);
  out('/help shown:', (await win.locator('.ai-entry.info').last().innerText()).split('\n')[0]);
  await win.fill('.term-input', 'echo "boom();" > bad.js'); await win.press('.term-input', 'Enter'); await win.waitForTimeout(300);
  await win.fill('.term-input', 'node bad.js'); await win.press('.term-input', 'Enter'); await win.waitForTimeout(1500);
  await script([{ content: 'أصلحتها.' }]);
  await win.fill('.ai-input', '/fix'); await win.press('.ai-input', 'Enter'); await idle();
  const fx = (await lastReq()).messages.slice(-1)[0].content;
  out('/fix prompt lists error:', fx.includes('boom is not defined'), '| history kept:', (await lastReq()).messages.length);
  await win.fill('.ai-input', '/clear'); await win.press('.ai-input', 'Enter'); await win.waitForTimeout(300);
  out('/clear -> welcome:', await win.locator('.ai-welcome').count(), '| cards left:', await win.locator('.tool-card').count());
  await win.screenshot({ path: SP + '/agent-2.png' });
  out(logs.join('\n') || 'no page errors');
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
