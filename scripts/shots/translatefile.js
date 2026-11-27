// "ترجم الملف": a Word report and a PDF guide (English) translated into
// Arabic. The save dialog and the folder window are replaced for the test so
// nothing opens on the screen.
const path = require('node:path');
const M = 'D:/Dev/blazma-ai-testdata/media/';
module.exports = async ({ app, win, log, shot }) => {
  await app.evaluate(({ dialog, shell }, out) => {
    let n = 0;
    dialog.showSaveDialog = async (_w, o) => ({ canceled: false, filePath: `${out}translated-${++n}${(o && o.defaultPath && o.defaultPath.slice(o.defaultPath.lastIndexOf('.'))) || ''}` });
    shell.showItemInFolder = (p) => { global.__revealed = p; };
  }, M);
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  for (const f of ['report.docx', 'guide.pdf']) {
    const t = Date.now();
    await win.setInputFiles('#file-input', path.join(M, f));
    await win.locator('.file-chip-tr').last().waitFor({ timeout: 60000 });
    await win.locator('.file-chip-tr').last().click();
    await win.locator('.dlg-layer select').waitFor({ timeout: 60000 });
    log(f, 'dialog', (await win.locator('.dlg-layer').innerText()).replace(/\n+/g, ' | ').slice(0, 200), 'default', await win.locator('.dlg-layer select').inputValue());
    await shot(`translate-dialog-${f.split('.')[0]}`);
    await win.locator('.dlg-layer .btn.primary').click();
    for (let i = 0; i < 900; i++) {
      await win.waitForTimeout(1000);
      const txt = await win.locator('#attach-preview').innerText();
      if (/تم حفظ|ما قدرت|أوقفت/.test(txt)) { log(f, Math.round((Date.now() - t) / 1000) + 's', txt.replace(/\n+/g, ' | ').slice(-120)); break; }
    }
    log('revealed', await app.evaluate(() => global.__revealed));
    await win.locator('#attach-preview .file-chip-x').last().click();
  }
};
