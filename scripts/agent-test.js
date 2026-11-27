// Agent engine and wake word, tested without the window or the model:
//   electron scripts/agent-test.js
// Works in D:/Dev/blazma-agent-sandbox (made fresh each run).
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', process.env.BLAZMA_USER_DATA || 'D:/Dev/blazma-ai-testdata');
const box = 'D:\\Dev\\blazma-agent-sandbox';
let failed = 0;
const check = (name, ok, extra = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? ` ${extra}` : ''}`);
};

app.on('window-all-closed', () => {}); // the PDF step closes a hidden window
app.whenReady().then(async () => {
  try {
    const agent = require('../src/main/agent');
    const J = `jtest${Date.now()}`;
    const wake = require('../src/main/wake');
    fs.rmSync(box, { recursive: true, force: true });
    fs.mkdirSync(path.join(box, 'sub'), { recursive: true });
    const files = { 'a.pdf': 'pdf', 'b.jpg': 'jpg', 'c.jpg': 'jpg', 'd.mp4': 'mp4', 'notes.txt': 'hello agent', 'dup1.txt': 'x'.repeat(5000), 'sub/dup2.txt': 'x'.repeat(5000), 'setup.exe': 'MZ' };
    for (const [n, c] of Object.entries(files)) fs.writeFileSync(path.join(box, n), c);

    const list = await agent.read('list_folder', { path: box });
    check('list_folder', list.total === 8 && list.files_by_type.images === 2, JSON.stringify(list.files_by_type));
    const found = await agent.read('find_files', { query: 'notes', folder: box });
    check('find_files by name', found.found === 1);
    const imgs = await agent.read('find_files', { type: 'images', folder: box });
    check('find_files by type', imgs.found === 2);
    const read = await agent.read('read_file', { path: path.join(box, 'notes.txt') });
    check('read_file', read.text === 'hello agent');
    const dups = await agent.read('find_duplicates', { folder: box });
    check('find_duplicates', dups.groups === 1 && dups.items[0].copies.length === 1);

    // Protected places
    for (const p of ['C:\\Windows\\System32', process.env.ProgramFiles, path.join(require('node:os').homedir(), 'AppData', 'Roaming'), 'C:\\']) {
      let denied = false;
      try {
        agent.plan('create_folder', { path: path.join(p, 'blazma-x') });
      } catch (err) {
        denied = err.code === 'agent-denied';
      }
      check(`denied ${p}`, denied);
    }
    let exe = false;
    try {
      await agent.read('open', { path: path.join(box, 'setup.exe') });
    } catch (err) {
      exe = err.code === 'agent-denied';
    }
    check('open refuses programs', exe);

    // Organize, then undo
    const plan = agent.plan('organize_folder', { folder: box, by: 'type' });
    check('organize plan', plan.moves === 7 && plan.new_folders >= 4, `moves ${plan.moves} folders ${plan.new_folders}`);
    const run = await agent.run(plan.planId, J);
    check('organize run', run.done === plan.moves + plan.new_folders && !run.failed.length, JSON.stringify(run.failed));
    check('files moved', fs.existsSync(path.join(box, 'صور', 'b.jpg')) && !fs.existsSync(path.join(box, 'b.jpg')));
    // A move with a name clash gets "(2)"
    fs.writeFileSync(path.join(box, 'sub', 'notes.txt'), 'other');
    const mv = agent.plan('move', { items: [{ from: path.join(box, 'sub', 'notes.txt'), to: path.join(box, 'مستندات') + '\\' }] });
    check('clash renamed', /notes \(2\)\.txt$/.test(mv.steps[0].to), mv.steps[0].to);
    await agent.run(mv.planId, J);
    // Write, overwrite, pdf
    const w = agent.plan('write_text_file', { path: path.join(box, 'مستندات', 'notes.txt'), content: 'new text' });
    check('overwrite flagged', w.steps[0].overwrite === true);
    await agent.run(w.planId, J);
    const pdf = agent.plan('images_to_pdf', { images: [path.join(box, 'صور', 'b.jpg')], output: path.join(box, 'album.pdf') });
    check('pdf plan', pdf.pdfs === 1);
    // (b.jpg is not a real picture; the PDF still prints an empty page)
    const pr = await agent.run(pdf.planId, J);
    check('pdf made', fs.existsSync(path.join(box, 'album.pdf')), JSON.stringify(pr.failed));
    console.log('deleting');
    const del = agent.plan('delete', { paths: [path.join(box, 'sub', 'dup2.txt')] });
    await agent.run(del.planId, J);
    check('deleted to bin', !fs.existsSync(path.join(box, 'sub', 'dup2.txt')));
    check('journal count', agent.changes(J) > 10, String(agent.changes(J)));

    const undo = await agent.undo(J);
    check('undo', !undo.failed.length && undo.inRecycleBin === 1, JSON.stringify(undo));
    check('back in place', fs.existsSync(path.join(box, 'b.jpg')) && fs.readFileSync(path.join(box, 'notes.txt'), 'utf8') === 'hello agent' && fs.readFileSync(path.join(box, 'sub', 'notes.txt'), 'utf8') === 'other');
    check('folders removed', !fs.existsSync(path.join(box, 'صور')) && !fs.existsSync(path.join(box, 'album.pdf')));

    // Wake word
    const cases = [
      ['يا بلازما افتح كروم', true, 'افتح كروم'],
      ['يا بلازما، كم الساعة؟', true, 'كم الساعة؟'],
      ['بلازما.', true, ''],
      ['Hey Plasma, open Steam.', true, 'open Steam.'],
      ['آه يا بلازمة شغل الموسيقى', true, 'شغل الموسيقى'],
      ['البلازما في الفيزياء حالة رابعة', false, ''],
      ['قلت لك افتح الباب', false, ''],
    ];
    for (const [text, wakeOk, rest] of cases) {
      const m = wake.match(text);
      check(`wake "${text}"`, m.wake === wakeOk && (!wakeOk || m.rest === rest), JSON.stringify(m));
    }
  } catch (err) {
    failed++;
    console.log('FAIL crashed', err && err.stack);
  }
  console.log(failed ? `${failed} FAILED` : 'all passed');
  app.exit(failed ? 1 : 0);
});
