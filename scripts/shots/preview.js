// Live preview: the model writes HTML with a deliberate error, the preview
// runs it, shows the error, and "ask for a fix" sends it back.
const waitIdle = async (win) => {
  await win.waitForTimeout(1500);
  for (let i = 0; i < 400 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
};
module.exports = async ({ win, shot, log }) => {
  await win.evaluate(() => window.blazma.updateSettings({ webSearch: false, kbInChat: false }));
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', 'اكتب صفحة HTML كاملة في كتلة كود واحدة: زر برتقالي مكتوب عليه "اضغط" وعداد يزيد عند الضغط. وفي السكربت استدعِ في آخره دالة غير موجودة اسمها startGame() بدون تعريفها.');
  await win.press('#chat-input', 'Enter');
  await waitIdle(win);
  const runs = win.locator('.md-run');
  log('run buttons', await runs.count());
  await runs.last().click();
  await win.waitForTimeout(2500);
  log('status', await win.locator('.preview-status').innerText());
  await shot('preview-error');
  const frame = win.frameLocator('.preview-frame iframe');
  await frame.locator('button').first().click({ timeout: 5000 }).catch((e) => log('click fail', e.message));
  await frame.locator('button').first().click({ timeout: 5000 }).catch(() => {});
  log('frame text', (await frame.locator('body').innerText({ timeout: 5000 }).catch(() => '?')).slice(0, 120));
  if (await win.locator('.preview-foot .btn.primary').isVisible()) {
    await win.click('.preview-foot .btn.primary');
    await waitIdle(win);
    await win.locator('.md-run').last().click();
    await win.waitForTimeout(2500);
    log('status after fix', await win.locator('.preview-status').innerText());
    await shot('preview-fixed');
  }
};
