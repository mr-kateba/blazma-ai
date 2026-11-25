// Library extras: a picture and a scanned PDF read with OCR, a web page
// added by link, "what did it read?", a summary, and an answer that uses them.
module.exports = async ({ win, shot, log }) => {
  await win.click('.nav-item[data-page="settings"]');
  await win.click('.set-toc button[data-target="kb"]');
  await win.waitForTimeout(500);
  await win.fill('.kb-web .input', 'https://ar.wikipedia.org/wiki/طرابلس_(ليبيا)');
  await win.click('.kb-web .btn');
  for (let i = 0; i < 60 && (await win.locator('.kb-web .btn').isDisabled()); i++) await win.waitForTimeout(500);
  log('web added', JSON.stringify(await win.evaluate(() => window.blazma.kbStatus())).slice(0, 220));
  const t0 = Date.now();
  const up = await win.evaluate(() => window.blazma.kbUpdate());
  log('index', Math.round((Date.now() - t0) / 1000), 's', JSON.stringify(up).slice(0, 160));
  const files = await win.evaluate(() => window.blazma.kbFiles());
  log('files', JSON.stringify(files.map((f) => [f.name, f.chunks, f.error])));
  for (const f of files.filter((x) => /brochure|scanned/.test(x.name))) {
    const t = await win.evaluate((p) => window.blazma.kbFileText(p), f.file);
    log('read', f.name, JSON.stringify((t || '').slice(0, 160)));
  }
  // summary of the web page
  const page = files.find((f) => /wikipedia/.test(f.name));
  if (page) {
    const s0 = Date.now();
    const res = await win.evaluate((p) => window.blazma.kbSummarize(p), page.file);
    log('summary', Math.round((Date.now() - s0) / 1000), 's', JSON.stringify(res).slice(0, 300));
  }
  await win.click('.nav-item[data-page="chat"]');
  await win.click('.nav-item[data-page="settings"]');
  await win.click('.set-toc button[data-target="kb"]');
  await win.waitForTimeout(1200);
  await win.locator('.kb-files').scrollIntoViewIfNeeded();
  await shot('kb-files');
  const scanned = files.find((f) => /scanned/.test(f.name));
  if (scanned) {
    await win.locator('.kb-file', { hasText: 'scanned' }).locator('.btn', { hasText: /وش قرأ|What did/ }).click();
    await win.waitForTimeout(600);
    await shot('kb-read');
    await win.locator('.kb-text-modal .btn').click();
  }
  // a question answered from the library
  await win.evaluate(() => window.blazma.updateSettings({ kbInChat: true }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#persona-pill');
  await win.locator('.persona-menu .model-menu-item').first().click();
  await win.fill('#chat-input', 'من مكتبتي: وش أداة بلازما اللي تنزّل الفيديو؟ ومتى تأسست طرابلس؟');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500);
  for (let i = 0; i < 300 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
  log('answer', (await win.locator('.msg-ai').last().innerText()).replace(/\n+/g, ' | ').slice(0, 400));
  await win.evaluate(() => window.blazma.updateSettings({ kbInChat: false }));
};
