// "وضع الوكيل": sort a sandbox folder by type through the chat, approve the
// plan in the dialog, then undo it from the button under the reply.
const fs = require('node:fs');
const path = require('node:path');
const BOX = 'D:\\Dev\\blazma-agent-sandbox';
module.exports = async ({ win, log, shot }) => {
  fs.rmSync(BOX, { recursive: true, force: true });
  fs.mkdirSync(BOX, { recursive: true });
  for (const n of ['report.pdf', 'trip1.jpg', 'trip2.jpg', 'clip.mp4', 'song.mp3', 'notes.txt', 'tool.zip']) fs.writeFileSync(path.join(BOX, n), n);
  await win.evaluate(() => window.blazma.updateSettings({ agentMode: true, webSearch: false, kbInChat: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.fill('#chat-input', `رتّب الملفات اللي في المجلد ${BOX} حسب النوع`);
  await win.press('#chat-input', 'Enter');
  const t = Date.now();
  let dialogs = 0;
  for (let i = 0; i < 400; i++) {
    await win.waitForTimeout(500);
    if (await win.locator('.dlg-layer').count()) {
      dialogs++;
      log('dialog', (await win.locator('.dlg').innerText()).replace(/\n+/g, ' | ').slice(0, 400));
      if (dialogs === 1) await shot('agent-confirm');
      await win.locator('.dlg-layer .dlg-ok').click();
      continue;
    }
    if (i > 6 && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  log('time', Math.round((Date.now() - t) / 1000) + 's', 'dialogs', dialogs);
  log('steps', (await win.locator('.msg-ai').last().locator('.tool-steps').innerText().catch(() => '')).replace(/\n+/g, ' | '));
  log('answer', (await win.locator('.msg-ai').last().locator('.md, p').first().innerText().catch(() => '')).slice(0, 300));
  log('folders now', JSON.stringify(fs.readdirSync(BOX)));
  await shot('agent-done');
  const undo = win.locator('.agent-undo button');
  if (await undo.count()) {
    await undo.click();
    await win.locator('.dlg-layer .dlg-ok').click();
    await win.waitForTimeout(1500);
    log('after undo', JSON.stringify(fs.readdirSync(BOX)), (await win.locator('.agent-undo').innerText()).replace(/\n+/g, ' '));
  } else log('no undo button');
  await win.evaluate(() => window.blazma.updateSettings({ agentMode: false }));
};
