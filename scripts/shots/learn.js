// "ذاكرة تتعلم لحالها": a message with facts about the user, then the
// "تعلّمت عنك" line under the reply, and "انسَها".
module.exports = async ({ win, log, shot }) => {
  const before = (await win.evaluate(() => window.blazma.getSettings())).memory || [];
  await win.evaluate(() => window.blazma.updateSettings({ memoryEnabled: true, memoryAuto: true, agentMode: false, webSearch: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', 'أنا اسمي كاتبة، عندي استوديو اسمه نخلة في ليبيا، وأبرمج أدوات ويندوز بجافاسكربت وإلكترون. اقترح لي اسم لأداة جديدة تنظّف الرام.');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 240; i++) {
    await win.waitForTimeout(500);
    if (i > 6 && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  let learned = '';
  for (let i = 0; i < 40 && !learned; i++) {
    await win.waitForTimeout(500);
    learned = await win.locator('.learned').innerText().catch(() => '');
  }
  log('learned', learned.replace(/\n+/g, ' ') || '(nothing)');
  const after = (await win.evaluate(() => window.blazma.getSettings())).memory || [];
  log('memory', JSON.stringify(after.slice(before.length)));
  await shot('learn');
  // A second message without facts: nothing new.
  await win.fill('#chat-input', 'كم ساعة في اليوم؟');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 120; i++) {
    await win.waitForTimeout(500);
    if (i > 6 && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  await win.waitForTimeout(5000);
  log('learned on 2nd', await win.locator('.msg-ai').last().locator('.learned').count());
  const forget = win.locator('.learned .link-btn').first();
  if (await forget.count()) {
    await forget.click();
    await win.waitForTimeout(500);
    const final = (await win.evaluate(() => window.blazma.getSettings())).memory || [];
    log('after forget', final.length === before.length);
  }
};
