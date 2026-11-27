// "عقل جهازك": a test folder read, then a question answered from a file in
// it, and a file found by name.
module.exports = async ({ app, win, log, shot }) => {
  const DIR = 'D:\\Dev\\blazma-ai-testdata\\media';
  await win.evaluate((d) => window.blazma.updateSettings({ brainFolders: [d], agentMode: false, webSearch: false, kbInChat: false }), DIR);
  const t = Date.now();
  await win.evaluate(() => window.blazma.brainEnable(true));
  const res = await win.evaluate(() => window.blazma.brainRefresh());
  log('refresh', Math.round((Date.now() - t) / 1000) + 's', JSON.stringify(res).slice(0, 400));
  await win.click('.nav-item[data-page="settings"]');
  await win.locator('.set-toc button[data-target="brain"]').click();
  await win.waitForTimeout(800);
  await shot('brain-settings');
  for (const q of ['كم عدد مستخدمي أداة Tweak حسب التقرير اللي عندي في ملفاتي؟', 'وين ملف دليل الاستخدام بصيغة PDF؟']) {
    await win.click('.nav-item[data-page="chat"]');
    await win.click('#btn-new-chat');
    await win.fill('#chat-input', q);
    await win.press('#chat-input', 'Enter');
    for (let i = 0; i < 300; i++) {
      await win.waitForTimeout(500);
      if (i > 6 && !(await win.locator('#btn-stop-gen').isVisible())) break;
    }
    const msg = win.locator('.msg-ai').last();
    log('Q', q);
    log('  steps', (await msg.locator('.tool-steps').innerText().catch(() => '')).replace(/\n+/g, ' | '));
    log('  answer', (await msg.innerText()).replace(/\n+/g, ' | ').slice(0, 350));
  }
  await shot('brain-chat');
  await win.evaluate(() => window.blazma.brainEnable(false));
};
