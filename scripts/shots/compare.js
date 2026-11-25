// Compare: the same question answered by a second model, side by side.
// Uses the smallest catalog model (Qwen3.5 0.8B, downloaded once if missing).
const waitPhase = async (win, pred, ms = 900000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await win.evaluate(() => window.blazma.getSetupState());
    if (pred(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timeout in phase ${s.phase}`);
    await win.waitForTimeout(1000);
  }
};
module.exports = async ({ win, shot, log }) => {
  let s = await win.evaluate(() => window.blazma.getSetupState());
  const main = s.modelId;
  const small = s.models.find((m) => m.id === 'qwen3.5-0.8b');
  if (!small.downloaded) {
    log('downloading', small.name);
    await win.evaluate(() => window.blazma.modelsUse('qwen3.5-0.8b'));
    await waitPhase(win, (x) => x.phase === 'ready' && x.modelId === 'qwen3.5-0.8b');
    await win.evaluate((id) => window.blazma.modelsUse(id), main);
    await waitPhase(win, (x) => x.phase === 'ready' && x.modelId === main);
  }
  await win.click('.nav-item[data-page="chat"]');
  await win.click('#btn-new-chat');
  await win.click('#persona-pill');
  await win.locator('.persona-menu .model-menu-item').first().click();
  await win.fill('#chat-input', 'ما عاصمة ليبيا؟ وما أشهر معالمها؟ أجب في ثلاثة أسطر.');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500);
  for (let i = 0; i < 200 && (await win.locator('#btn-stop-gen').isVisible()); i++) await win.waitForTimeout(500);
  await win.locator('.msg-ai .msg-footer .icon-btn', { hasText: 'قارن' }).last().click();
  await win.waitForTimeout(400);
  await shot('compare-menu');
  await win.locator('.compare-menu .model-menu-item').first().click();
  // Switching models shows the loading panel, then the reply streams.
  for (let i = 0; i < 600; i++) {
    await win.waitForTimeout(1000);
    const st = await win.evaluate(() => window.blazma.getSetupState().then((s) => s.phase));
    if (st === 'ready' && !(await win.locator('#btn-stop-gen').isVisible()) && !(await win.locator('.cmp-col .pulse').count()) && (await win.locator('.cmp-col').count()) === 2) break;
  }
  await win.waitForTimeout(800);
  const cols = await win.locator('.cmp-col').allInnerTexts();
  log('columns', cols.length, JSON.stringify(cols.map((c) => c.slice(0, 90))));
  await shot('compare');
  // back to the main model
  await win.evaluate((id) => window.blazma.modelsUse(id), main);
  await waitPhase(win, (x) => x.phase === 'ready' && x.modelId === main);
  log('back on', main);
};
