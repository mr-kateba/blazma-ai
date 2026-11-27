// Run with: electron scripts/clip-test.js — checks the async clipboard calls the
// quick assistant uses (save, write marker, read, restore), without key presses.
const { app, clipboard, ClipboardItem } = require('electron');
app.whenReady().then(async () => {
  try {
    const before = await clipboard.readText();
    console.log('ClipboardItem', typeof ClipboardItem, 'read', typeof clipboard.read);
    const items = await clipboard.read();
    const saved = await Promise.all(items.map(async (it) => {
      const d = {};
      for (const t of it.types) { try { d[t] = await it.getType(t); } catch {} }
      return d;
    }));
    console.log('types', JSON.stringify(items.map((i) => i.types)));
    await clipboard.writeText('\u2063blazma-test');
    console.log('marker ok', (await clipboard.readText()) === '\u2063blazma-test');
    const back = saved.filter((d) => Object.keys(d).length).map((d) => new ClipboardItem(d));
    if (back.length) await clipboard.write(back); else clipboard.clear();
    console.log('restored', (await clipboard.readText()) === before);
  } catch (e) { console.log('FAIL', e && e.stack); }
  app.quit();
});
