// The new 0.2.0 pages and settings: tools page, memory (and /تذكر in the
// chat, then a reply that uses it), quick assistant settings, tasks (with a
// real run), crash log.
module.exports = async ({ app, win, shot, log }) => {
  await win.click('.nav-item[data-page="tools"]');
  await win.waitForTimeout(600);
  log('tool cards', await win.locator('.tool-card').count());
  await shot('tools');

  // memory from the chat
  await win.evaluate(() => window.blazma.updateSettings({ memory: [], webSearch: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.evaluate(() => document.querySelector('.preview-head .btn[aria-label]') && document.querySelector('.preview-head .btn[aria-label]').click());
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', '/تذكر اسمي كاتبة وعندي كرت RTX 5070');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(800);
  log('memory', JSON.stringify((await win.evaluate(() => window.blazma.getSettings())).memory));
  await win.fill('#chat-input', 'وش اسمي ووش كرت شاشتي؟ جاوب بسطر واحد.');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500);
  for (let i = 0; i < 200 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
  log('answer', (await win.locator('.msg-ai').last().innerText()).slice(0, 200));
  await shot('memory-chat');

  await win.click('.nav-item[data-page="settings"]');
  for (const tab of ['memory', 'quick', 'tasks', 'about']) {
    await win.click(`.set-toc button[data-target="${tab}"]`);
    await win.waitForTimeout(500);
    await shot(`settings-${tab}`);
  }
  // a task, run now
  await win.click('.set-toc button[data-target="tasks"]');
  await win.locator('.task-examples .chip').last().click();
  await win.waitForTimeout(600);
  const t0 = Date.now();
  await win.locator('.task-row .btn.small').first().click();
  for (let i = 0; i < 240 && (await win.locator('.task-row .btn.small').first().isDisabled()); i++) await win.waitForTimeout(500);
  log('task run secs', Math.round((Date.now() - t0) / 1000));
  await shot('settings-tasks-ran');
  const list = await win.evaluate(() => window.blazma.chatsList());
  log('task chats', JSON.stringify(list.filter((c) => c.folder).map((c) => [c.title, c.folder])));
  log('quick key', (await win.evaluate(() => window.blazma.getSettings())).quickKey, 'registered', await app.evaluate(({ globalShortcut }) => globalShortcut.isRegistered('Alt+Space')));
};
