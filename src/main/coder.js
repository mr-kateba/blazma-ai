'use strict';

// Code completion while typing in VS Code (Continue's "autocomplete"): a small
// coding model run by a second llama-server, only while the user wants it.
// - Model: the one llama.cpp's own "--fim-qwen-1.5b-default" preset uses
//   (common/arg.cpp): ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF,
//   qwen2.5-coder-1.5b-q8_0.gguf (Qwen2.5-Coder 1.5B, Apache-2.0), about
//   1.6 GB, downloaded by llama-server itself into the models folder.
// - Server: 127.0.0.1, a key that stays the same (it is written into
//   Continue's settings), a port that stays the same when it is free, and
//   it leaves memory after a few idle minutes (--sleep-idle-seconds).
// - Continue (provider "llama.cpp") sends the code around the cursor with the
//   Qwen coder fill-in-the-middle template; it picks that template from a
//   model name with "qwen" and "coder" in it.

const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const settings = require('./settings');
const { installedEngine } = require('./engine');
const { pickPort } = require('./server');
const { AppError } = require('./errors');

const HF_REPO = 'ggml-org/Qwen2.5-Coder-1.5B-Q8_0-GGUF';
const HF_FILE = 'qwen2.5-coder-1.5b-q8_0.gguf';
const MODEL_NAME = 'qwen2.5-coder-1.5b';
const PREFERRED_PORT = 18090;
const IDLE_SECONDS = 300;

let server = null; // { child, port, key, ready }
let starting = null;

function key() {
  let k = settings.get().coderKey;
  if (!/^[0-9a-f]{48}$/.test(k || '')) {
    k = crypto.randomBytes(24).toString('hex');
    settings.update({ coderKey: k });
  }
  return k;
}

const alive = () => Boolean(server && server.ready && server.child.exitCode === null && server.child.signalCode === null);

function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 1500 }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve(res.statusCode === 200 && body.includes('ok')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => req.destroy());
  });
}

async function startServer() {
  stop();
  const engine = installedEngine();
  if (!engine) throw new AppError('coder-failed', 'no engine');
  const port = await pickPort(PREFERRED_PORT);
  const k = key();
  // Development/testing: a local model file instead of the download.
  const source = process.env.BLAZMA_CODER_MODEL ? ['-m', process.env.BLAZMA_CODER_MODEL] : ['--hf-repo', HF_REPO, '--hf-file', HF_FILE];
  const args = [...source, '-c', '8192', '-b', '1024', '-ub', '1024', '--cache-reuse', '256', '--host', '127.0.0.1', '--port', String(port), '--no-webui', '--sleep-idle-seconds', String(IDLE_SECONDS)];
  const env = { ...process.env, LLAMA_CACHE: settings.modelsDir(), LLAMA_API_KEY: k };
  if (process.env.BLAZMA_HF_ENDPOINT) env.HF_ENDPOINT = process.env.BLAZMA_HF_ENDPOINT;
  const child = spawn(engine.exe, args, { cwd: engine.dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  let spawnError = null;
  child.on('error', (err) => (spawnError = err));
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  server = { child, port, key: k, ready: false };
  const started = Date.now();
  // The first start downloads the model, so allow time.
  while (Date.now() - started < 30 * 60 * 1000) {
    if (spawnError) throw new AppError('coder-failed', spawnError.message);
    if (child.exitCode !== null) throw new AppError('coder-failed', log.slice(-800));
    if (await health(port)) {
      server.ready = true;
      return server;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  stop();
  throw new AppError('coder-failed', 'timeout');
}

// Running server ({ port, key }), started if needed.
async function ensureServer() {
  if (alive()) return server;
  if (!starting) starting = startServer().finally(() => (starting = null));
  return starting;
}

function stop() {
  if (server && server.child.exitCode === null) server.child.kill();
  server = null;
}

const status = () => ({ enabled: Boolean(settings.get().codeComplete), running: alive(), port: alive() ? server.port : null });

module.exports = { ensureServer, stop, status, MODEL_NAME, HF_REPO, HF_FILE };
