// An assistant with its own documents in strict mode: answers from them
// (with the file as source), and refuses a question they don't cover.
const path = require('node:path');
module.exports = async ({ app, win, shot, log }) => {
  const folder = 'D:\\Dev\\blazma-ai-testdata\\docs-shop';
  // Add the folder to "مكتبتي" without the folder dialog, then index (the
  // embedding model is downloaded once).
  const added = await app.evaluate((_e, [file, f]) => {
    const kb = process.mainModule.require(file);
    return kb.addFolder(f);
  }, [path.resolve(__dirname, '../../src/main/knowledge.js'), folder]);
  const already = await win.evaluate(() => window.blazma.kbStatus());
  log('kb before', JSON.stringify(already).slice(0, 160));
  log('added', JSON.stringify(added).slice(0, 200));
  const t0 = Date.now();
  const up = await win.evaluate(() => window.blazma.kbUpdate());
  log('index', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(up).slice(0, 200));
  // the assistant, through the editor
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#persona-pill');
  await win.waitForTimeout(300);
  await win.locator('.model-menu-item').last().click();
  await win.waitForTimeout(600);
  await win.locator('.persona-templates .chip', { hasText: 'خدمة العملاء' }).click();
  await win.fill('.persona-form input[maxlength="40"]', 'متجر نخلة');
  await win.click('.persona-docs-wrap summary');
  await win.waitForTimeout(300);
  await win.locator('.persona-folder input').first().check();
  await win.locator('.persona-strict input').check();
  await shot('assistant-editor');
  await win.click('.persona-form .btn.primary');
  await win.waitForTimeout(600);
  const list = await win.evaluate(() => window.blazma.personasList());
  const shop = list.find((p) => p.name === 'متجر نخلة');
  log('saved', JSON.stringify(shop).slice(0, 300));
  await win.locator('.modal .btn', { hasText: /إغلاق|Close/ }).last().click();
  await win.waitForTimeout(300);
  await win.click('#persona-pill');
  await win.locator('.model-menu-item', { hasText: 'متجر نخلة' }).click();
  const ask = async (q) => {
    await win.fill('#chat-input', q);
    await win.press('#chat-input', 'Enter');
    await win.waitForTimeout(1500);
    for (let i = 0; i < 200 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
    const t = await win.locator('.msg-ai').last().innerText();
    log('Q', q, '=>', t.replace(/\n+/g, ' | ').slice(0, 260));
  };
  await ask('كم مدة ضمان كرت الشاشة؟ وكم سعر التوصيل لبنغازي؟');
  await ask('من فاز بكأس العالم 2022؟');
  await shot('assistant-chat');
};
