// Math and Mermaid diagrams in a reply, from the real model.
module.exports = async ({ win, shot, log }) => {
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#persona-pill');
  await win.locator('.persona-menu .model-menu-item').first().click();
  await win.fill('#chat-input', 'اكتب قانون حل المعادلة التربيعية بصيغة LaTeX بين $$ و $$، ثم ارسم مخطط mermaid (flowchart TD) لخطوات حلها في كتلة ```mermaid. باختصار.');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500);
  for (let i = 0; i < 300 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
  await win.waitForTimeout(3000);
  log('math blocks', await win.locator('.msg-ai').last().locator('.md-math-block math, .md-math math').count());
  log('math as code (failed)', await win.locator('.msg-ai').last().locator('.md-math-block code, .md-math code').count());
  log('diagrams', await win.locator('.md-diagram-frame').count(), 'height', await win.locator('.md-diagram-frame').first().evaluate((f) => f.style.height).catch(() => '-'));
  await win.locator('.md-diagram-frame').first().scrollIntoViewIfNeeded().catch(() => {});
  await shot('math-diagram');
};
