'use strict';

// Speech to text for the chat's microphone button, on this computer, with
// whisper.cpp (MIT): its whisper-server program and a multilingual model.
// - Program: "whisper-bin-x64.zip" from github.com/ggml-org/whisper.cpp
//   releases. Like llama.cpp, the Windows builds are on the bNNNN releases
//   (the vX.Y.Z ones carry only source), so the newest release that has the
//   file is used; GitHub's sha256 digest is checked when given.
// - Model: ggerganov/whisper.cpp on Hugging Face (MIT), checked by its sha256.
// - The audio arrives from the page as a 16 kHz WAV and is sent to
//   http://127.0.0.1:<port>/inference (examples/server/README.md). No ffmpeg
//   (--convert is not used). The server stops after a few idle minutes.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const { downloadFile } = require('./download');
const { extractZip } = require('./extract');
const { pickPort } = require('./server');
const { AppError } = require('./errors');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=20';
const ASSET = 'whisper-bin-x64.zip';
const EXE = process.platform === 'win32' ? 'whisper-server.exe' : 'whisper-server';
const MODELS = {
  // Sizes and hashes come from the Hugging Face file list at download time.
  small: 'ggml-small-q5_1.bin', // ~190 MB, faster
  turbo: 'ggml-large-v3-turbo-q5_0.bin', // ~574 MB, more accurate
};
const HF = (process.env.BLAZMA_HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const IDLE_MS = 5 * 60 * 1000;
const MAX_WAV_BYTES = 40 * 1024 * 1024; // about 20 minutes of 16 kHz mono audio

const root = () => path.join(paths.userData(), 'voice');

// The spoken language: Arabic by default with the Arabic interface. Left to
// detection, whisper often takes Libyan or Gulf speech for Persian or Urdu
// and writes nonsense.
function language() {
  const env = process.env.BLAZMA_VOICE_LANG;
  if (env) return env;
  const s = settings.get();
  return s.voiceLang && s.voiceLang !== 'ui' ? s.voiceLang : s.language === 'en' ? 'auto' : 'ar';
}

let server = null; // { child, port, model, ready }
let idleTimer = null;
let installing = null;
let starting = null; // the start in progress, shared by callers meanwhile

function findExe(dir, depth = 3) {
  if (fs.existsSync(path.join(dir, EXE))) return path.join(dir, EXE);
  if (depth === 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const found = findExe(path.join(dir, e.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function json(url, headers = {}) {
  let res;
  try {
    res = await net.fetch(url, { headers: { 'User-Agent': 'Blazma-AI', ...headers } });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (!res.ok) throw new AppError('voice-install', `HTTP ${res.status} for ${url}`);
  return res.json();
}

function installedExe() {
  if (process.env.BLAZMA_WHISPER_SERVER) return process.env.BLAZMA_WHISPER_SERVER; // development/testing
  return findExe(path.join(root(), 'bin'));
}

function modelFile(kind) {
  if (process.env.BLAZMA_WHISPER_MODEL) return process.env.BLAZMA_WHISPER_MODEL; // development/testing
  return path.join(root(), 'models', MODELS[kind] || MODELS.small);
}

function status() {
  const kind = settings.get().voiceModel;
  return { program: Boolean(installedExe()), model: fs.existsSync(modelFile(kind)), modelKind: kind };
}

// Downloads what is missing. onProgress({ stage: 'program' | 'model', done, total }).
async function install(onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    if (!installedExe()) {
      const releases = await json(RELEASES_API, { Accept: 'application/vnd.github+json' });
      const rel = (Array.isArray(releases) ? releases : []).find((r) => !r.draft && (r.assets || []).some((a) => a.name === ASSET));
      if (!rel) throw new AppError('voice-install', `${ASSET} not found in recent releases`);
      const asset = rel.assets.find((a) => a.name === ASSET);
      const sha256 = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1] || null;
      const dl = path.join(root(), 'downloads');
      fs.mkdirSync(dl, { recursive: true });
      const zip = path.join(dl, ASSET);
      await downloadFile(asset.browser_download_url, zip, { expectedSize: asset.size, sha256, onProgress: (done) => onProgress({ stage: 'program', done, total: asset.size }) });
      const target = path.join(root(), 'bin', rel.tag_name.replace(/[^\w.-]/g, '_'));
      fs.rmSync(target, { recursive: true, force: true });
      await extractZip(zip, target);
      fs.rmSync(zip, { force: true });
      if (!findExe(target)) throw new AppError('voice-install', `${EXE} not in ${ASSET}`);
    }
    const kind = settings.get().voiceModel;
    const file = modelFile(kind);
    if (!fs.existsSync(file)) {
      const name = MODELS[kind] || MODELS.small;
      const tree = await json(`${HF}/api/models/ggerganov/whisper.cpp/tree/main`);
      const entry = (Array.isArray(tree) ? tree : []).find((f) => f.path === name);
      if (!entry || !entry.lfs) throw new AppError('voice-install', `${name} not found`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      await downloadFile(`${HF}/ggerganov/whisper.cpp/resolve/main/${name}`, file, {
        expectedSize: entry.lfs.size,
        sha256: entry.lfs.oid,
        onProgress: (done) => onProgress({ stage: 'model', done, total: entry.lfs.size }),
      });
    }
    return status();
  })();
  try {
    return await installing;
  } finally {
    installing = null;
  }
}

async function ensureServer() {
  const model = modelFile(settings.get().voiceModel);
  if (server && server.ready && server.child.exitCode === null && server.model === model && server.lang === language()) return server;
  if (!starting) starting = startServer(model).finally(() => (starting = null));
  return starting;
}

// On NVIDIA cards whisper runs on the graphics card with the CUDA files the
// chat engine already has (no second 700 MB download): whisper's own program
// files are copied next to nothing else, and the engine folder supplies
// ggml and CUDA. About 0.1 s per sentence instead of 5-20 s on the processor.
function gpuLaunch(exe) {
  if (process.env.BLAZMA_VOICE_CPU || gpuFailed) return null;
  let engine = null;
  try {
    engine = require('./engine').installedEngine();
  } catch {}
  if (!engine || !fs.existsSync(path.join(engine.dir, 'ggml-cuda.dll'))) return null;
  const from = path.dirname(exe);
  const dir = path.join(root(), 'gpu');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (!/\.(exe|dll)$/i.test(f) || /^ggml/i.test(f) || (/\.exe$/i.test(f) && f !== path.basename(exe))) continue;
    const src = path.join(from, f);
    const dst = path.join(dir, f);
    const a = fs.statSync(src);
    const b = fs.statSync(dst, { throwIfNoEntry: false });
    if (!b || b.size !== a.size || b.mtimeMs < a.mtimeMs) fs.copyFileSync(src, dst);
  }
  return { exe: path.join(dir, path.basename(exe)), cwd: engine.dir, env: { ...process.env, PATH: `${engine.dir};${process.env.PATH || ''}` } };
}
let gpuFailed = false;

async function startServer(model, cpu = false) {
  stop();
  const exe = installedExe();
  if (!exe || !fs.existsSync(model)) throw new AppError('voice-missing');
  const port = await pickPort(0);
  const lang = language();
  const gpu = cpu ? null : gpuLaunch(exe);
  const child = spawn(gpu ? gpu.exe : exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', lang], {
    cwd: gpu ? gpu.cwd : path.dirname(exe),
    env: gpu ? gpu.env : process.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => (log = (log + d).slice(-3000)));
  server = { child, port, model, lang, gpu: Boolean(gpu) };
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if (child.exitCode !== null) {
      // The graphics-card start failed (an older card, missing files): the processor, from now on.
      if (gpu) {
        gpuFailed = true;
        return startServer(model, true);
      }
      throw new AppError('voice-failed', log.slice(-600));
    }
    const up = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
        res.resume();
        resolve(true);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => req.destroy());
    });
    if (up) {
      server.ready = true;
      return server;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  stop();
  throw new AppError('voice-failed', 'timeout');
}

function post(port, wav, format = 'json', { lang = language(), prompt = '' } = {}) {
  const boundary = `----blazma${crypto.randomBytes(12).toString('hex')}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field('response_format', format) + field('temperature', '0.0') + field('language', lang) + (prompt ? field('prompt', prompt) : ''), 'utf8'),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/inference', method: 'POST', timeout: (format === 'json' ? 5 : 30) * 60 * 1000, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

// wav: 16 kHz mono PCM WAV bytes from the page. Returns the text, or with
// { segments: true } the timed pieces: [{ start, end, text }] in seconds
// (whisper-server's verbose_json).
// lang / prompt: for one request (the wake word: the name as a hint, and a
// second try with the language detected).
async function transcribe(wav, { segments = false, lang, prompt } = {}) {
  const buf = Buffer.from(wav);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new AppError('voice-bad-audio');
  if (buf.length > MAX_WAV_BYTES) throw new AppError('voice-bad-audio', 'too long');
  const s = await ensureServer();
  clearTimeout(idleTimer);
  try {
    // Files (segments): long enough for whisper to tell the language itself,
    // and an English video must not come out translated into Arabic.
    const res = await post(s.port, buf, segments ? 'verbose_json' : 'json', { lang: lang || (segments ? 'auto' : language()), prompt });
    if (res && res.error) throw new AppError('voice-failed', String(res.error));
    if (segments) {
      const list = Array.isArray(res && res.segments) ? res.segments : [];
      const num = (v, ms) => (typeof v === 'number' ? v : typeof ms === 'number' ? ms / 1000 : 0);
      const out = list
        .map((x) => ({ start: num(x.start, x.t0 != null ? x.t0 * 10 : undefined), end: num(x.end, x.t1 != null ? x.t1 * 10 : undefined), text: String(x.text || '').replace(/\s+/g, ' ').trim() }))
        .filter((x) => x.text && !/^\[.*\]$|^\(.*\)$/.test(x.text));
      if (!out.length && res && res.text) out.push({ start: 0, end: 0, text: String(res.text).replace(/\s+/g, ' ').trim() });
      return out;
    }
    return String((res && res.text) || '').replace(/\s+/g, ' ').trim();
  } finally {
    idleTimer = setTimeout(stop, IDLE_MS);
  }
}

function stop() {
  clearTimeout(idleTimer);
  if (server && server.child.exitCode === null) server.child.kill();
  server = null;
}

module.exports = { status, install, transcribe, stop };
