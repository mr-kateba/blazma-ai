// Runs the end-to-end tests one by one against tests/.work (see setup.js).
// Each test launches the real app with Playwright, a mock Hugging Face
// server and a fake nvidia-smi, and prints what it checked.
//
// Usage (Linux):  xvfb-run -a node tests/run.js [name ...]
//   no names = all tests below; "packaged" needs `npx electron-builder --linux dir` first.
//   kb, voice and image need `FEATURES=1 node tests/setup.js`; they are
//   skipped when their files are missing.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const WORK = path.join(__dirname, '.work');
const ALL = ['chat', 'chats', 'ui', 'branches', 'close-busy', 'persona', 'files', 'vision', 'models', 'catalog', 'local', 'idle', 'theme', 'kb', 'voice', 'image', 'vscode', 'import', 'api', 'lhm', 'overlay', 'device', 'buttons', 'slash'];
const NEEDS = {
  kb: ['models/Qwen3-Embedding-0.6B-Q8_0.gguf'],
  voice: ['whisper/whisper-bin-ubuntu-x64/whisper-server', 'whisper/ar-sample.wav'],
  image: ['sdcpp/sd-server', 'images/z_image_turbo-Q3_K.gguf'],
  vscode: ['vscodium/linux/out/server-main.js'],
};
const TIMEOUT_MS = 30 * 60 * 1000;

function startMockHf() {
  const log = fs.openSync(path.join(WORK, 'mock.log'), 'w');
  const child = spawn(process.execPath, [path.join(WORK, 'mock-hf.js'), path.join(WORK, 'hfsrc'), '18999'], {
    env: { ...process.env, RATE: '400000000' },
    stdio: ['ignore', log, log],
  });
  spawnSync('sleep', ['1']);
  return child;
}

function runOne(name) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(__dirname, 'e2e', `${name}.js`), WORK], { cwd: path.resolve(__dirname, '..') });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fs.writeFileSync(path.join(WORK, `result-${name}.log`), out);
      const ok = code === 0 && !/pageerror:|^FAIL/m.test(out);
      resolve({ name, ok, secs: Math.round((Date.now() - started) / 1000) });
    });
  });
}

async function main() {
  if (!fs.existsSync(path.join(WORK, 'hfsrc'))) {
    console.error('Run tests/setup.js first.');
    process.exit(1);
  }
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ALL;
  // A full run starts from a clean profile (downloaded models are kept).
  if (!process.argv.slice(2).length) {
    const home = path.join(WORK, 'e2e-home', 'Blazma AI');
    for (const f of fs.existsSync(home) ? fs.readdirSync(home) : []) if (f !== 'models') fs.rmSync(path.join(home, f), { recursive: true, force: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ activeModelId: 'qwen3.5-2b', tourDone: true }));
  }
  const mock = startMockHf();
  const results = [];
  for (const name of names) {
    process.stdout.write(`${name} … `);
    if ((NEEDS[name] || []).some((f) => !fs.existsSync(path.join(WORK, f)))) {
      console.log('skipped (run FEATURES=1 node tests/setup.js)');
      continue;
    }
    const r = await runOne(name);
    results.push(r);
    console.log(`${r.ok ? 'ok' : 'FAILED'} (${r.secs}s)${r.ok ? '' : `, see tests/.work/result-${name}.log`}`);
  }
  mock.kill();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main();
