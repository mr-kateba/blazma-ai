// MCP: a local test server added in settings, started and listed; the model
// calls its tool from the chat, the user allows it, and the answer uses it.
const path = require('node:path');
module.exports = async ({ win, shot, log }) => {
  const server = path.resolve(__dirname, '..', 'test-mcp-server.js');
  await win.evaluate((srv) => window.blazma.updateSettings({ mcpServers: [{ id: 'stest', name: 'متجر نخلة (تجربة)', command: 'node', args: [srv], enabled: true }], webSearch: false }), server);
  await win.click('.nav-item[data-page="settings"]');
  await win.click('.set-toc button[data-target="mcp"]');
  await win.waitForTimeout(4000);
  log('settings state', (await win.locator('#set-mcp .task-row').innerText()).replace(/\n+/g, ' | '));
  await shot('mcp-settings');
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#persona-pill');
  await win.locator('.persona-menu .model-menu-item').first().click();
  await win.fill('#chat-input', 'كم قطعة RTX 5070 متوفرة في متجر نخلة؟ استخدم الأداة.');
  await win.press('#chat-input', 'Enter');
  let asked = false;
  for (let i = 0; i < 240; i++) {
    await win.waitForTimeout(500);
    if (!asked && (await win.locator('.dlg-layer').count())) {
      asked = true;
      log('dialog', (await win.locator('.dlg-layer').innerText()).replace(/\n+/g, ' | ').slice(0, 220));
      await shot('mcp-ask');
      await win.locator('.dlg-layer .btn.primary').click();
    }
    if (asked && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  await win.waitForTimeout(800);
  log('answer', (await win.locator('.msg-ai').last().innerText()).replace(/\n+/g, ' | ').slice(0, 300));
  await shot('mcp-chat');
  await win.evaluate(() => window.blazma.updateSettings({ mcpServers: [] }));
};
