'use strict';

// Image generation on this computer with stable-diffusion.cpp (MIT) and
// Z-Image Turbo (Tongyi-MAI, Apache-2.0), following stable-diffusion.cpp's
// docs/z_image.md: a diffusion model, a VAE and a Qwen3 4B text encoder, run
// by sd-server ("--diffusion-model --vae --llm --diffusion-fa
// --offload-to-cpu --cfg-scale 1.0", 8 steps for the Turbo model).
// - Program: the sd-master-*-bin-win-vulkan-x64.zip (works on NVIDIA, AMD and
//   Intel cards) or ...-win-cpu-x64.zip build from github.com/leejet/
//   stable-diffusion.cpp releases, checked by GitHub's sha256 digest.
// - Models (Hugging Face, Apache-2.0, checked by sha256):
//   leejet/Z-Image-Turbo-GGUF, Comfy-Org/z_image_turbo (VAE),
//   unsloth/Qwen3-4B-Instruct-2507-GGUF.
// - The prompt goes in the JSON body of POST /v1/images/generations
//   (examples/server/api.md), never on a command line.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const settings = require('./settings');
const { downloadFile } = require('./download');
const { extractZip } = require('./extract');
const { pickPort } = require('./server');
const { AppError } = require('./errors');

const RELEASES_API = 'https://api.github.com/repos/leejet/stable-diffusion.cpp/releases?per_page=10';
const EXE = process.platform === 'win32' ? 'sd-server.exe' : 'sd-server';
const HF = (process.env.BLAZMA_HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');
const FILES = {
  diffusion: { repo: 'leejet/Z-Image-Turbo-GGUF', file: 'z_image_turbo-Q4_K.gguf' },
  vae: { repo: 'Comfy-Org/z_image_turbo', file: 'split_files/vae/ae.safetensors' },
  llm: { repo: 'unsloth/Qwen3-4B-Instruct-2507-GGUF', file: 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf' },
};
const STEPS = 8;

const dir = () => path.join(settings.modelsDir(), 'images');
const local = (key) => process.env[`BLAZMA_IMAGE_${key.toUpperCase()}`] || path.join(dir(), path.basename(FILES[key].file)); // env: development/testing

let installing = null;
let current = null; // the running sd-server, so the user can cancel

function findExe(d, depth = 3) {
  if (fs.existsSync(path.join(d, EXE))) return path.join(d, EXE);
  if (depth === 0 || !fs.existsSync(d)) return null;
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) {
      const found = findExe(path.join(d, e.name), depth - 1);
      if (found) return found;
    }
  }
  return null;
}

const installedExe = () => process.env.BLAZMA_SD_SERVER || findExe(path.join(dir(), 'bin'));

function status() {
  const missing = Object.keys(FILES).filter((k) => !fs.existsSync(local(k)));
  return { program: Boolean(installedExe()), models: missing.length === 0 };
}

async function json(url, headers = {}) {
  let res;
  try {
    res = await net.fetch(url, { headers: { 'User-Agent': 'Blazma-AI', ...headers } });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (!res.ok) throw new AppError('image-install', `HTTP ${res.status} for ${url}`);
  return res.json();
}

// Total download size, for the confirmation before the first image.
async function plan() {
  let bytes = 0;
  for (const [key, f] of Object.entries(FILES)) {
    if (fs.existsSync(local(key))) continue;
    const tree = await json(`${HF}/api/models/${f.repo}/tree/main?recursive=true`);
    const entry = (Array.isArray(tree) ? tree : []).find((t) => t.path === f.file);
    bytes += entry && entry.lfs ? entry.lfs.size : 0;
  }
  return { bytes, program: !installedExe() };
}

async function install({ gpu }, onProgress = () => {}) {
  if (installing) return installing;
  installing = (async () => {
    fs.mkdirSync(dir(), { recursive: true });
    if (!installedExe()) {
      const releases = await json(RELEASES_API, { Accept: 'application/vnd.github+json' });
      const want = gpu ? /^sd-master-.+-bin-win-vulkan-x64\.zip$/ : /^sd-master-.+-bin-win-cpu-x64\.zip$/;
      const rel = (Array.isArray(releases) ? releases : []).find((r) => !r.draft && (r.assets || []).some((a) => want.test(a.name)));
      if (!rel) throw new AppError('image-install', 'no Windows build in recent releases');
      const asset = rel.assets.find((a) => want.test(a.name));
      const zip = path.join(dir(), asset.name);
      await downloadFile(asset.browser_download_url, zip, {
        expectedSize: asset.size,
        sha256: /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1] || null,
        onProgress: (done) => onProgress({ stage: 'program', done, total: asset.size }),
      });
      const target = path.join(dir(), 'bin', rel.tag_name.replace(/[^\w.-]/g, '_'));
      fs.rmSync(target, { recursive: true, force: true });
      await extractZip(zip, target);
      fs.rmSync(zip, { force: true });
      if (!findExe(target)) throw new AppError('image-install', `${EXE} not in ${asset.name}`);
    }
    for (const [key, f] of Object.entries(FILES)) {
      const dest = local(key);
      if (fs.existsSync(dest)) continue;
      const tree = await json(`${HF}/api/models/${f.repo}/tree/main?recursive=true`);
      const entry = (Array.isArray(tree) ? tree : []).find((t) => t.path === f.file);
      if (!entry || !entry.lfs) throw new AppError('image-install', `${f.repo}/${f.file} not found`);
      await downloadFile(`${HF}/${f.repo}/resolve/main/${f.file}`, dest, {
        expectedSize: entry.lfs.size,
        sha256: entry.lfs.oid,
        onProgress: (done) => onProgress({ stage: key, done, total: entry.lfs.size }),
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

function call(port, method, route, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      { host: '127.0.0.1', port, path: route, method, timeout: timeoutMs, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode, json: JSON.parse(text) });
          } catch {
            resolve({ status: res.statusCode, json: null, text });
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// One image. The server is started for it and stopped right after, so its
// memory is free again for the chat model. Returns a PNG data URL.
async function generate({ prompt, size }) {
  const exe = installedExe();
  if (!exe || !status().models) throw new AppError('image-missing');
  const text = String(prompt || '').replace(/<\/?sd_cpp_extra_args>/gi, ' ').trim().slice(0, 2000);
  if (!text) throw new AppError('image-failed', 'empty prompt');
  const dims = ['512x512', '768x768', '1024x1024'].includes(size) ? size : '768x768';
  const port = await pickPort(0);
  const args = ['--diffusion-model', local('diffusion'), '--vae', local('vae'), '--llm', local('llm'), '--diffusion-fa', '--offload-to-cpu', '--cfg-scale', '1.0', '--steps', String(STEPS), '--listen-ip', '127.0.0.1', '--listen-port', String(port)];
  const child = spawn(exe, args, { cwd: path.dirname(exe), windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, LD_LIBRARY_PATH: path.dirname(exe) } });
  let log = '';
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  current = child;
  try {
    const started = Date.now();
    for (;;) {
      if (child.cancelled) throw new AppError('image-cancelled');
      if (child.exitCode !== null) throw new AppError('image-failed', log.slice(-800));
      const r = await call(port, 'GET', '/v1/models', null, 2000).catch(() => null);
      if (r && r.status === 200) break;
      if (Date.now() - started > 10 * 60 * 1000) throw new AppError('image-failed', 'server did not start');
      await new Promise((res) => setTimeout(res, 1000));
    }
    const extra = JSON.stringify({ sample_params: { sample_steps: STEPS } });
    const res = await call(port, 'POST', '/v1/images/generations', { prompt: `${text} <sd_cpp_extra_args>${extra}</sd_cpp_extra_args>`, n: 1, size: dims, output_format: 'png' }, 60 * 60 * 1000).catch((err) => {
      throw child.cancelled ? new AppError('image-cancelled') : err;
    });
    const b64 = res.json && Array.isArray(res.json.data) && res.json.data[0] && res.json.data[0].b64_json;
    if (!b64) throw new AppError('image-failed', (res.text || JSON.stringify(res.json) || '').slice(0, 400));
    return { dataUrl: `data:image/png;base64,${b64}`, size: dims };
  } finally {
    current = null;
    if (child.exitCode === null) child.kill();
  }
}

function cancel() {
  if (!current) return;
  current.cancelled = true;
  current.kill();
}

module.exports = { status, plan, install, generate, cancel };
