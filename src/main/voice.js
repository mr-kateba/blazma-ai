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
  if (server && server.ready && server.child.exitCode === null && server.model === model) return server;
  if (!starting) starting = startServer(model).finally(() => (starting = null));
  return starting;
}

async function startServer(model) {
  stop();
  const exe = installedExe();
  if (!exe || !fs.existsSync(model)) throw new AppError('voice-missing');
  const port = await pickPort(0);
  // -l auto: the spoken language is detected (Arabic or any other).
  const child = spawn(exe, ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-l', 'auto'], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let log = '';
  child.stderr.on('data', (d) => (log = (log + d).slice(-3000)));
  server = { child, port, model };
  const started = Date.now();
  while (Date.now() - started < 120000) {
    if (child.exitCode !== null) throw new AppError('voice-failed', log.slice(-600));
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

function post(port, wav) {
  const boundary = `----blazma${crypto.randomBytes(12).toString('hex')}`;
  const field = (name, value) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const body = Buffer.concat([
    Buffer.from(field('response_format', 'json') + field('temperature', '0.0') + field('language', 'auto')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    wav,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/inference', method: 'POST', timeout: 5 * 60 * 1000, headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length } },
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

// wav: 16 kHz mono PCM WAV bytes from the page. Returns the text.
async function transcribe(wav) {
  const buf = Buffer.from(wav);
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new AppError('voice-bad-audio');
  if (buf.length > MAX_WAV_BYTES) throw new AppError('voice-bad-audio', 'too long');
  const s = await ensureServer();
  clearTimeout(idleTimer);
  try {
    const res = await post(s.port, buf);
    if (res && res.error) throw new AppError('voice-failed', String(res.error));
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
