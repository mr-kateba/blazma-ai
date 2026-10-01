// Interface: first-run guided tour, styled tooltips, in-app confirmation
// dialog (typing works after it), one reply at a time (a second Enter while
// busy is ignored), and the settings page shown one tab at a time.
const { _electron } = require('playwright-core');
const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${info ? ' | ' + info : ''}`); if (!ok) failed++; };
const ready = async (win) => { for (let i = 0; i < 1200 && (await win.evaluate(() => window.blazma.getSetupState().then(s => s.phase))) !== 'ready'; i++) await win.waitForTimeout(300); };
const overlaps = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

(async () => {
  fs.rmSync(SP + '/e2e-home/Blazma AI/chats', { recursive: true, force: true });
  fs.rmSync(SP + '/e2e-home/Blazma AI/knowledge', { recursive: true, force: true }); // an empty library
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  await win.setViewportSize({ width: 1280, height: 820 });
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  await ready(win);

  // ---- guided tour, as on a first run ----
  await win.evaluate(() => window.blazma.updateSettings({ tourDone: false, webSearch: false, kbInChat: false, shareDeviceInfo: false }));
  await win.reload(); await win.waitForLoadState('load');
  await win.waitForSelector('.tour-card', { timeout: 20000 });
  const titles = [];
  let litMic = false;
  for (let i = 0; i < 40 && (await win.locator('.tour-card').count()); i++) {
    const title = await win.locator('.tour-card h3').innerText();
    titles.push(title);
    if (title === 'الميكروفون') {
      litMic = overlaps(await win.locator('.tour-hole').boundingBox(), await win.locator('#btn-mic').boundingBox());
      await win.screenshot({ path: SP + '/ui-1-tour-mic.png' });
    }
    if (i === 0) await win.screenshot({ path: SP + '/ui-0-tour-welcome.png' });
    await win.click('.tour-next'); await win.waitForTimeout(250);
  }
  check('tour walks through the app', titles.length >= 15 && titles[0].includes('أهلاً') && titles.at(-1) === 'جاهز!', `${titles.length} steps: ${titles.join(' › ')}`);
  check('tour lights up the right button', litMic);
  check('tour remembered as done', (await win.evaluate(() => window.blazma.getSettings())).tourDone === true);
  await win.reload(); await win.waitForLoadState('load'); await win.waitForTimeout(2500);
  check('no tour on the next start', (await win.locator('.tour-card').count()) === 0);
  // Esc ends it; it can be started again from settings.
  await win.click('.nav-item[data-page="settings"]'); await win.waitForTimeout(600);
  await win.click('.set-toc button[data-target="general"]');
  await win.click('#set-general button:has-text("ابدأ الجولة")'); await win.waitForSelector('.tour-card');
  await win.keyboard.press('Escape'); await win.waitForTimeout(200);
  check('tour from settings, Esc closes it', (await win.locator('.tour-card').count()) === 0);

  // ---- settings: one tab at a time ----
  await win.click('.nav-item[data-page="settings"]'); await win.waitForTimeout(600);
  const shownSections = () => win.evaluate(() => [...document.querySelectorAll('.set-section')].filter((s) => !s.hidden).map((s) => s.dataset.section));
  const tabs = await win.locator('.set-toc button').evaluateAll((bs) => bs.map((b) => b.dataset.target));
  let tabsOk = true;
  for (const t of tabs) {
    await win.click(`.set-toc button[data-target="${t}"]`); await win.waitForTimeout(150);
    const shown = await shownSections();
    if (shown.join() !== t) tabsOk = false;
    await win.screenshot({ path: `${SP}/ui-set-${t}.png` });
  }
  check('settings tabs show one section each', tabsOk && tabs.length === 8, tabs.join(','));
  await win.click('.set-toc button[data-target="engine"]');
  const adv = win.locator('#set-engine details.set-advanced');
  check('technical options folded away', (await adv.count()) === 1 && !(await adv.evaluate((d) => d.open)) && !(await win.locator('#set-engine .set-number').isVisible()));
  await adv.locator('summary').click(); await win.waitForTimeout(150);
  check('advanced options open', await win.locator('#set-engine .set-number').isVisible());
  // Tooltip on the "؟" with the long explanation.
  await win.hover('#set-engine .set-help >> nth=0'); await win.waitForTimeout(450);
  const helpTip = await win.locator('.tooltip:not([hidden])').innerText().catch(() => '');
  check('"؟" explains in a styled tooltip', helpTip.length > 40, helpTip.slice(0, 60));
  await win.screenshot({ path: SP + '/ui-set-engine-advanced.png' });
  await win.mouse.move(5, 400);
  await win.setViewportSize({ width: 820, height: 820 }); await win.waitForTimeout(300);
  check('tabs still reachable in a narrow window', await win.locator('.set-toc button[data-target="api"]').isVisible());
  await win.screenshot({ path: SP + '/ui-set-narrow.png' });
  await win.setViewportSize({ width: 1280, height: 820 });

  // ---- tooltips in the chat ----
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(400);
  await win.hover('#btn-web'); await win.waitForTimeout(450);
  const tip = await win.evaluate(() => { const t = document.querySelector('.tooltip'); return t && !t.hidden ? { text: t.textContent, bg: getComputedStyle(t).backgroundColor } : null; });
  const nativeOff = await win.evaluate(() => !document.getElementById('btn-web').hasAttribute('title'));
  check('styled tooltip on hover, native one suppressed', tip && tip.text.includes('البحث') && nativeOff, JSON.stringify(tip));
  await win.screenshot({ path: SP + '/ui-2-tooltip.png' });
  await win.mouse.move(600, 300); await win.waitForTimeout(150);
  check('tooltip hides and title comes back', (await win.evaluate(() => document.querySelector('.tooltip').hidden && document.getElementById('btn-web').hasAttribute('title'))));

  // ---- library button with an empty library opens its settings tab ----
  await win.click('#btn-kb'); await win.waitForTimeout(800);
  check('empty library -> settings at "مكتبتي"', (await shownSections()).join() === 'kb' && (await win.locator('.page[data-page="settings"]').isVisible()));
  await win.click('.nav-item[data-page="chat"]'); await win.waitForTimeout(300);

  // ---- one reply at a time ----
  await win.click('#btn-new-chat'); await win.waitForTimeout(200);
  await win.fill('#chat-input', 'اكتب قصيدة طويلة عن البحر.'); await win.press('#chat-input', 'Enter');
  await win.fill('#chat-input', 'رسالة ثانية'); await win.press('#chat-input', 'Enter'); await win.waitForTimeout(300);
  check('second Enter while busy is ignored', (await win.locator('.msg-user').count()) === 1 && (await win.inputValue('#chat-input')) === 'رسالة ثانية' && (await win.locator('#btn-stop-gen').isVisible()));
  await win.waitForTimeout(1500);
  await win.click('#btn-stop-gen');
  await win.waitForSelector('#btn-send:not([hidden])', { timeout: 60000 });
  check('stop ends the reply and frees the box', (await win.locator('.msg-ai').count()) === 1 && /أُوقف/.test(await win.locator('.msg-ai').innerText()));
  await win.fill('#chat-input', '');

  // ---- in-app confirmation dialog, and typing afterwards ----
  await win.hover('.chat-item >> nth=0'); await win.click('.chat-item >> nth=0 >> button[title="حذف"]');
  await win.waitForSelector('.dlg');
  check('delete asks in an in-app dialog, cancel focused', (await win.evaluate(() => document.activeElement.classList.contains('dlg-cancel'))));
  await win.screenshot({ path: SP + '/ui-3-dialog.png' });
  await win.keyboard.press('Escape'); await win.waitForTimeout(200);
  check('Esc cancels', (await win.locator('.dlg').count()) === 0 && (await win.locator('.chat-item').count()) === 1);
  await win.hover('.chat-item >> nth=0'); await win.click('.chat-item >> nth=0 >> button[title="حذف"]');
  await win.click('.dlg-ok'); await win.waitForTimeout(500);
  check('confirm deletes', (await win.locator('.chat-item').count()) === 0);
  await win.click('#chat-input'); await win.keyboard.type('أكتب بعد الحذف');
  check('typing works after the dialog', (await win.inputValue('#chat-input')) === 'أكتب بعد الحذف');


  // ---- a chat with a drawn picture keeps working ----
  // (a picture in history used to be sent to a model without vision, which
  // then refused every later message in that chat)
  const png = 'data:image/png;base64,' + fs.readFileSync(require('path').join(root, 'build', 'icon.png')).toString('base64');
  const id = 'c' + Date.now().toString(36);
  fs.mkdirSync(SP + '/e2e-home/Blazma AI/chats', { recursive: true });
  fs.writeFileSync(`${SP}/e2e-home/Blazma AI/chats/${id}.json`, JSON.stringify({ id, title: 'صورة قطة', updatedAt: Date.now(), messages: [
    { role: 'user', content: '🎨 ارسم: قطة' },
    { role: 'assistant', content: 'هذه الصورة (512x512).', images: [png], imagePrompt: 'an orange cat' },
  ] }));
  await win.reload(); await win.waitForLoadState('load'); await ready(win);
  await win.click('.chat-item:has-text("صورة قطة")'); await win.waitForTimeout(500);
  await win.evaluate(() => { window.__reqs = []; const f = window.fetch; window.__realFetch = f; window.fetch = (u, o) => { if (o && o.body) window.__reqs.push(JSON.parse(o.body)); return f(u, o); }; });
  await win.fill('#chat-input', 'ما لون القطة في الصورة؟ أجب بكلمة.'); await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1200); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 300000 });
  const sent = await win.evaluate(() => JSON.stringify(window.__reqs.at(-1).messages));
  const after = await win.locator('.msg-ai').last().innerText();
  check('picture not sent back to the chat model', !sent.includes('image_url') && sent.includes('an orange cat'));
  check('the chat still answers after a picture', !(await win.locator('.msg-ai .msg-error').count()) && after.length > 1, after.replace(/\s+/g, ' ').slice(0, 60));

  // ---- the engine failing in the middle of a reply is explained ----
  await win.evaluate(() => {
    window.fetch = async (u, o) => {
      if (!String(u).includes('/v1/chat/completions')) return window.__realFetch(u, o);
      const enc = new TextEncoder();
      const body = new ReadableStream({ start(c) {
        c.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"بداية"}}]}\n\n'));
        c.enqueue(enc.encode('data: {"error":{"code":500,"message":"slot failed","type":"server_error"}}\n\n'));
        c.close();
      } });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    };
  });
  await win.fill('#chat-input', 'سؤال'); await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(800); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 30000 });
  const errText = await win.locator('.msg-ai .msg-error').last().innerText().catch(() => '');
  check('engine error mid-reply is shown, box free again', errText.includes('توقف المحرك'), errText);
  await win.evaluate(() => (window.fetch = window.__realFetch));

  await app.close();
  console.log(logs.join('\n'));
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
