// Every page of the app.
module.exports = async ({ win, shot }) => {
  for (const page of ['chat', 'device', 'models', 'settings']) {
    await win.click(`.nav-item[data-page="${page}"]`);
    await win.waitForTimeout(800);
    await shot(`page-${page}`);
  }
  await win.click('.nav-item[data-page="chat"]');
};
