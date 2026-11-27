// Chat search: Arabic spellings (diacritics, ة/ه, أ/ا), several words, and
// opening a result scrolls to the message and marks it.
module.exports = async ({ win, log, shot }) => {
  const now = Date.now();
  await win.evaluate((t) => window.blazma.chatsSave({ id: `srch${t}`, title: 'رحلة العائلة', createdAt: t, updatedAt: t, messages: [
    { role: 'user', content: 'أين نذهب في العطلة؟' },
    { role: 'assistant', content: 'أقترح زيارة المدينة القديمة أولاً، ثم السوق.' },
    { role: 'user', content: 'وماذا عن المكتبة؟' },
    { role: 'assistant', content: 'مَكتبةُ طرابلسَ المركزيّة تفتح من التاسعة صباحاً، وفيها قسم للأطفال.' },
  ] }), now);
  await win.click('.nav-item[data-page="chat"]');
  const tries = {};
  for (const q of ['مكتبه طرابلس', 'المكتبة الاطفال', 'مكتبة باريس']) {
    await win.fill('#chat-search', q);
    await win.waitForTimeout(700);
    tries[q] = await win.locator('.chat-item').evaluateAll((els) => els.map((e) => e.innerText.replace(/\n+/g, ' / ')).slice(0, 2));
  }
  log('results', JSON.stringify(tries));
  await win.fill('#chat-search', 'مكتبه طرابلس');
  await win.waitForTimeout(700);
  await win.locator('.chat-item').first().click();
  await win.waitForTimeout(700);
  log('jumped to', await win.locator('.msg.search-hit').getAttribute('data-index'), 'marks', await win.evaluate(() => (CSS.highlights.get('blazma-search') || { size: 0 }).size));
  await shot('search');
  await win.fill('#chat-search', '');
  await win.evaluate((t) => window.blazma.chatsDelete(`srch${t}`), now);
};
