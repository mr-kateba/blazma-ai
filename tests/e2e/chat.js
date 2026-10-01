const { _electron } = require('playwright-core');
const { execSync } = require('child_process');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
const shot = (win, n) => win.screenshot({ path: `${SP}/e2e-${n}.png` });
const phase = (win) => win.evaluate(() => window.blazma.getSetupState().then(s => s.phase));
async function waitPhase(win, want, ms = 120000) { const t0 = Date.now(); let p; while (Date.now() - t0 < ms) { p = await phase(win); if ([].concat(want).includes(p)) return p; await win.waitForTimeout(300); } throw new Error(`timeout ${want}, last=${p}`); }
(async () => {
  const t0 = Date.now();
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); const logs = [];
  win.on('console', m => logs.push(m.type() + ': ' + m.text())); win.on('pageerror', e => logs.push('pageerror: ' + e.message));
  await waitPhase(win, 'ready', 60000); console.log('ready offline in', ((Date.now() - t0) / 1000).toFixed(1), 's');
  await win.fill('#chat-input', 'مرحبا، عرّف بنفسك في جملتين.');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 60; i++) {
    await win.waitForTimeout(3000);
    const s = await win.evaluate(() => { const m = [...document.querySelectorAll('.msg-ai')].pop(); return { users: document.querySelectorAll('.msg-user').length, reasoning: m?.querySelector('.thinking-body')?.textContent.length || 0, content: m?.querySelector('.msg-body')?.innerText.length, busy: !document.getElementById('btn-stop-gen').hidden }; });
    if (i % 5 === 0 || !s.busy) console.log(`t=${(i + 1) * 3}s`, JSON.stringify(s));
    if (i === 3) await shot(win, '7-streaming');
    if (!s.busy) break;
  }
  await win.evaluate(() => document.querySelector('.thinking') && (document.querySelector('.thinking').open = true));
  await win.waitForTimeout(300); await shot(win, '8-done');
  const ai = await win.evaluate(() => { const m = [...document.querySelectorAll('.msg-ai')].pop(); return { summary: m.querySelector('.thinking summary')?.textContent, answer: [...m.querySelectorAll('.msg-body > p, .msg-body > ul, .msg-body > ol, .msg-body > .md-code')].map(e => e.innerText).join(' | ').slice(0, 300), stats: m.querySelector('.stats')?.textContent }; });
  console.log('ai:', JSON.stringify(ai));
  // crash test: SIGKILL electron main process, then check llama-server orphan
  const epid = app.process().pid; process.kill(epid, 'SIGKILL'); await new Promise(r => setTimeout(r, 2000));
  console.log('after SIGKILL of app, llama-server still running:', execSync(`pgrep -f "build/bin/llama-server -hf" || echo NONE`).toString().trim());
  console.log(logs.join('\n'));
  process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
