// "بحث معمّق": a comparison question researched into a report.
module.exports = async ({ win, log, shot }) => {
  await win.evaluate(() => window.blazma.updateSettings({ agentMode: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#btn-research');
  log('placeholder', await win.locator('#chat-input').getAttribute('placeholder'));
  await win.fill('#chat-input', 'قارن بين كرت RTX 5070 وكرت RX 9070 XT للألعاب: الأداء والسعر والاستهلاك، وأيهم أنصح فيه؟');
  await win.press('#chat-input', 'Enter');
  const t = Date.now();
  let last = '';
  for (let i = 0; i < 1200; i++) {
    await win.waitForTimeout(1000);
    const s = await win.locator('.research-status').innerText().catch(() => '');
    if (s && s !== last) {
      last = s;
      log('  ', Math.round((Date.now() - t) / 1000) + 's', s);
      if (/أكتب/.test(s)) await shot('research-progress');
    }
    if (i > 8 && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  const msg = win.locator('.msg-ai').last();
  log('time', Math.round((Date.now() - t) / 1000) + 's');
  log('steps', await msg.locator('.tool-step').count(), 'failed', await msg.locator('.tool-step.failed').count());
  log('sources', await msg.locator('.sources .source').count());
  const text = await msg.locator('.md').first().innerText().catch(() => '');
  log('report chars', text.length, 'citations', (text.match(/\[\d+\]/g) || []).length, 'table', await msg.locator('table').count());
  log('start', text.slice(0, 500).replace(/\n+/g, ' | '));
  await shot('research');
};
