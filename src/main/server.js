'use strict';

// Owns the llama-server child process: start, health polling, stop, and
// cleanup of a server left behind by a previous crash of the app.

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const paths = require('./paths');
const { run } = require('./exec');

const LOG_LINES = 300;

function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

function randomFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function pickPort(preferred) {
  return (await isPortFree(preferred)) ? preferred : randomFreePort();
}

// Maps llama-server's log to an error code. Patterns are taken from the
// llama.cpp sources (download.cpp, hf-cache.cpp, ggml-cuda, server-http.cpp).
function classifyLog(log, { gpu }) {
  if (/couldn't bind HTTP server socket/.test(log)) return 'port-in-use';
  if (/No space left on device|not enough space|ENOSPC/i.test(log)) return 'disk-full';
  if (/cudaMalloc failed|out of memory|failed to allocate|unable to allocate/i.test(log)) {
    return gpu ? 'vram-insufficient' : 'ram-insufficient';
  }
  if (/failed to download model|download failed|get_repo_commit: error|failed to resolve commit/.test(log)) {
    return 'network';
  }
  if (/error loading model|failed to load model/.test(log)) return 'model-load-failed';
  return 'server-crashed';
}

class LlamaServer extends EventEmitter {
  constructor() {
    super();
    this.child = null;
    this.state = 'stopped'; // stopped | starting | loading | ready
    this.port = null;
    this.apiKey = null;
    this.log = [];
    this.stopping = false;
    this.healthTimer = null;
    this.options = null;
  }

  logTail(n = 60) {
    return this.log.slice(-n).join('\n');
  }

  setState(state) {
    if (this.state === state) return;
    this.state = state;
    this.emit('state', state);
  }

  // options: { exe, hf, modelsDir, contextSize, gpuLayers, port, offline, vision }
  start(options) {
    if (this.child) throw new Error('llama-server already running');
    this.options = options;
    this.port = options.port;
    this.apiKey = crypto.randomBytes(24).toString('hex');
    this.log = [];
    this.stopping = false;

    const args = [
      '-hf', options.hf,
      '--jinja',
      '-ngl', String(options.gpuLayers),
      '-c', String(options.contextSize),
      '--host', '127.0.0.1',
      '--port', String(options.port),
      '--no-webui',
      '--cors-origins', 'app://blazma',
    ];
    // Without --no-mmproj, -hf also fetches and loads the model's vision
    // projector (mmproj) so the chat can take images.
    if (!options.vision) args.push('--no-mmproj');
    if (options.offline) args.push('--offline');

    const env = {
      ...process.env,
      LLAMA_CACHE: options.modelsDir,
      // Passed by environment so the key never shows up in the process list.
      LLAMA_API_KEY: this.apiKey,
    };
    if (options.hfEndpoint) env.HF_ENDPOINT = options.hfEndpoint;

    fs.mkdirSync(options.modelsDir, { recursive: true });
    const child = spawn(options.exe, args, {
      cwd: path.dirname(options.exe),
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        this.log.push(line);
        if (this.log.length > LOG_LINES) this.log.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.once('error', (err) => {
      this.log.push(`spawn error: ${err.message}`);
    });
    child.once('exit', (code, signal) => {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
      this.child = null;
      removePidFile();
      const expected = this.stopping;
      const tail = this.logTail();
      this.setState('stopped');
      this.emit('exit', {
        code,
        signal,
        expected,
        errorCode: expected ? null : classifyLog(tail, { gpu: options.gpuLayers > 0 }),
        log: tail,
      });
    });

    writePidFile(child.pid, options.exe);
    this.setState('starting');
    this.healthTimer = setInterval(() => this.pollHealth(), 500);
  }

  async pollHealth() {
    if (!this.child) return;
    try {
      const res = await fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) });
      if (res.status === 200) this.setState('ready');
      else if (res.status === 503) this.setState('loading');
    } catch {
      // Not listening yet (still downloading) or already gone.
    }
  }

  stop() {
    const child = this.child;
    if (!child) return Promise.resolve();
    this.stopping = true;
    return new Promise((resolve) => {
      child.once('exit', () => resolve());
      killTree(child.pid);
      setTimeout(() => {
        if (this.child === child) killTree(child.pid, true);
      }, 3000);
    });
  }

  // Synchronous variant for app shutdown paths where awaiting is not possible.
  stopSync() {
    if (!this.child) return;
    this.stopping = true;
    killTree(this.child.pid, true);
    removePidFile();
  }
}

function killTree(pid, force = false) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
    }
  } catch {
    // Already exited.
  }
}

function writePidFile(pid, exe) {
  try {
    fs.writeFileSync(paths.pidFile(), JSON.stringify({ pid, exe }), 'utf8');
  } catch {}
}

function removePidFile() {
  try {
    fs.rmSync(paths.pidFile(), { force: true });
  } catch {}
}

// If the app crashed last time, its llama-server may still be running and
// holding GPU memory. Kill it, but only after confirming the PID still
// belongs to llama-server (PIDs get reused).
async function cleanupOrphan() {
  let info;
  try {
    info = JSON.parse(fs.readFileSync(paths.pidFile(), 'utf8'));
  } catch {
    return false;
  }
  removePidFile();
  const pid = Number(info && info.pid);
  if (!Number.isInteger(pid) || pid <= 0) return false;

  let isOurs = false;
  if (process.platform === 'win32') {
    const r = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    isOurs = r.ok && /"llama-server\.exe"/i.test(r.stdout);
  } else {
    try {
      isOurs = fs.readlinkSync(`/proc/${pid}/exe`) === info.exe;
    } catch {}
  }
  if (isOurs) killTree(pid, true);
  return isOurs;
}

module.exports = { LlamaServer, pickPort, isPortFree, cleanupOrphan, classifyLog };
