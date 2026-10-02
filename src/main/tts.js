'use strict';

// Reading replies aloud with a voice that ships with the app, so it works on
// any Windows (the Windows voices need the Arabic speech pack installed).
// - Program: Piper (MIT, github.com/rhasspy/piper), release 2023.11.14-2, the
//   last one under MIT. Its archive also holds espeak-ng's data and
//   libtashkeel, which adds the Arabic diacritics before speaking. The file's
//   size and sha256 are fixed here (computed from the official release).
// - Voice: ar_JO "kareem" (medium) from rhasspy/piper-voices on Hugging Face,
//   pinned to its v1.0.0 tag and checked by the sha256 Hugging Face lists.
// - Speaking: piper.exe with fixed arguments; the text goes in on stdin (one
//   line), the WAV comes back on stdout. Nothing from the text reaches the
//   command line.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const paths = require('./paths');
const { downloadFile } = require('./download');
const { extractZip } = require('./extract');
const { extractTarGz } = require('./untar');
const { AppError } = require('./errors');

const RELEASE = (process.env.BLAZMA_PIPER_BASE || 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2').replace(/\/+$/, '');
const PROGRAM =
  process.platform === 'win32'
    ? { name: 'piper_windows_amd64.zip', size: 22477236, sha256: 'f3c58906402b24f3a96d92145f58acba6d86c9b5db896d207f78dc80811efcea' }
    : { name: 'piper_linux_x86_64.tar.gz', size: 26460462, sha256: 'a50cb45f355b7af1f6d758c1b360717877ba0a398cc8cbe6d2a7a3a26e225992' };
const EXE = process.platform === 'win32' ? 'piper.exe' : 'piper';
const HF = (process.env.BLAZMA_HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const VOICE_REPO = 'rhasspy/piper-voices';
const VOICE_REV = 'v1.0.0';
const VOICE_DIR = 'ar/ar_JO/kareem/medium';
const VOICE = 'ar_JO-kareem-medium.onnx';
const MAX_CHARS = 2000; // one call; the page sends a long reply in pieces
const TIMEOUT_MS = 120000;

const root = () => path.join(paths.userData(), 'tts');
const voiceFile = () => path.join(root(), 'voices', VOICE);

let installing = null;

function findExe(dir, depth = 3) {
  // A file, not the "piper" folder that holds it in the Linux archive.
  const here = path.join(dir, EXE);
  if (fs.statSync(here, { throwIfNoEntry: false })?.isFile()) return here;
  if (depth === 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findExe(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

const installedExe = () => findExe(path.join(root(), 'bin'));

function status() {
  return { installed: Boolean(installedExe()) && fs.existsSync(voiceFile()) && fs.existsSync(`${voiceFile()}.json`) };
}

async function voiceFiles() {
  let res;
  try {
    res = await net.fetch(`${HF}/api/models/${VOICE_REPO}/tree/${VOICE_REV}/${VOICE_DIR}`, { headers: { 'User-Agent': 'Blazma-AI' } });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (!res.ok) throw new AppError('tts-install', `HTTP ${res.status} for the voice list`);
  const list = await res.json();
  const find = (name) => (Array.isArray(list) ? list : []).find((f) => f.path === `${VOICE_DIR}/${name}`);
  const model = find(VOICE);
  const config = find(`${VOICE}.json`);
  if (!model || !model.lfs || !config) throw new AppError('tts-install', 'voice files not found');
  return { model, config };
}

// What the download would be, in bytes (for the consent text).
async function plan() {
  const { model, config } = await voiceFiles();
  return { bytes: PROGRAM.size + model.lfs.size + config.size };
}

// onProgress({ stage: 'program' | 'voice', done, total })
async function install(onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    const dl = path.join(root(), 'downloads');
    fs.mkdirSync(dl, { recursive: true });
    if (!installedExe()) {
      const file = path.join(dl, PROGRAM.name);
      await downloadFile(`${RELEASE}/${PROGRAM.name}`, file, { expectedSize: PROGRAM.size, sha256: PROGRAM.sha256, onProgress: (done) => onProgress({ stage: 'program', done, total: PROGRAM.size }) });
      const target = path.join(root(), 'bin');
      const temp = `${target}.partial`;
      fs.rmSync(temp, { recursive: true, force: true });
      if (PROGRAM.name.endsWith('.zip')) await extractZip(file, temp);
      else await extractTarGz(file, temp);
      if (!findExe(temp)) throw new AppError('tts-install', `${EXE} not in ${PROGRAM.name}`);
      fs.rmSync(target, { recursive: true, force: true });
      fs.renameSync(temp, target);
      fs.rmSync(file, { force: true });
    }
    if (!fs.existsSync(voiceFile()) || !fs.existsSync(`${voiceFile()}.json`)) {
      const { model, config } = await voiceFiles();
      fs.mkdirSync(path.dirname(voiceFile()), { recursive: true });
      const base = `${HF}/${VOICE_REPO}/resolve/${VOICE_REV}/${VOICE_DIR}`;
      await downloadFile(`${base}/${VOICE}.json`, `${voiceFile()}.json`, { expectedSize: config.size });
      try {
        JSON.parse(fs.readFileSync(`${voiceFile()}.json`, 'utf8'));
      } catch {
        fs.rmSync(`${voiceFile()}.json`, { force: true });
        throw new AppError('tts-install', 'voice settings file is not JSON');
      }
      await downloadFile(`${base}/${VOICE}`, voiceFile(), { expectedSize: model.lfs.size, sha256: model.lfs.oid, onProgress: (done) => onProgress({ stage: 'voice', done, total: model.lfs.size }) });
    }
    return status();
  })();
  try {
    return await installing;
  } finally {
    installing = null;
  }
}

// Text -> WAV bytes. One line in, one WAV out (Piper writes a WAV per line).
function synth(text) {
  const exe = installedExe();
  if (!exe || !status().installed) return Promise.reject(new AppError('tts-missing'));
  const line = String(text || '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHARS);
  if (!line) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const child = spawn(exe, ['--model', voiceFile(), '--output_file', '-', '--quiet'], {
      cwd: path.dirname(exe),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LD_LIBRARY_PATH: path.dirname(exe) },
    });
    const out = [];
    let err = '';
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new AppError('tts-failed', e.message));
    });
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    child.on('close', (code) => {
      clearTimeout(timer);
      const wav = Buffer.concat(out);
      if (code !== 0 || wav.length < 44 || wav.toString('latin1', 0, 4) !== 'RIFF') return reject(new AppError('tts-failed', err || `exit ${code}`));
      resolve(wav);
    });
    child.stdin.on('error', () => {}); // a crash before reading is reported by 'close'
    child.stdin.end(`${line}\n`, 'utf8');
  });
}

module.exports = { status, plan, install, synth };
