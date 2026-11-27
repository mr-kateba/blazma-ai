// Audio and video in the chat: a short mp3 and a 10.6-minute mp4 (two
// pieces), transcribed with whisper.cpp, then a question about the video.
const path = require('node:path');
const M = 'D:/Dev/blazma-ai-testdata/media/';
module.exports = async ({ win, log, shot }) => {
  await win.evaluate(() => window.blazma.updateSettings({ voiceModel: 'small', kbEnabled: false, webSearch: false }));
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  for (const f of ['speech.mp3', 'meeting.mp4']) {
    const t = Date.now();
    await win.setInputFiles('#file-input', path.join(M, f));
    let note = '';
    for (let i = 0; i < 1200; i++) {
      await win.waitForTimeout(1000);
      const chips = await win.locator('#attach-preview .file-chip').evaluateAll((els) => els.map((e) => e.innerText.replace(/\n+/g, ' / ')));
      const last = chips[chips.length - 1] || '';
      if (last !== note) { note = last; if (/٪|%/.test(last) && i % 15) continue; log(' ', f, Math.round((Date.now() - t) / 1000) + 's', last); }
      if (/نص الكلام|transcript/.test(last) && !/أفرّغ|أقرأ/.test(last)) break;
      if (!chips.length && i > 3) { log('chip gone', await win.locator('#attach-preview').innerText()); break; }
    }
    log('done', f, Math.round((Date.now() - t) / 1000) + 's');
  }
  await shot('transcribe-chips');
  await win.fill('#chat-input', 'من الملف الثاني فقط: متى سيختبر أحمد ملف التثبيت، وما مهمة سارة؟ أجب في سطرين.');
  await win.press('#chat-input', 'Enter');
  for (let i = 0; i < 240; i++) {
    await win.waitForTimeout(500);
    if (i > 4 && !(await win.locator('#btn-stop-gen').isVisible())) break;
  }
  log('answer', (await win.locator('.msg-ai').last().innerText()).replace(/\n+/g, ' | ').slice(0, 400));
  await shot('transcribe-answer');
};
