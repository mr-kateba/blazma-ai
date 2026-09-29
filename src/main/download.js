'use strict';

// Resumable HTTP download for engine archives (models are downloaded by
// llama-server itself via -hf). Runs in the main process only.

const fs = require('node:fs');
const crypto = require('node:crypto');
const { once } = require('node:events');
const { net } = require('electron');
const { AppError } = require('./errors');

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function freeBytes(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const s = await fs.promises.statfs(dir);
  return s.bavail * s.bsize;
}

async function downloadFile(url, dest, { expectedSize = 0, sha256 = null, onProgress } = {}) {
  const part = `${dest}.part`;
  let start = 0;
  try {
    start = fs.statSync(part).size;
  } catch {}
  if (expectedSize && start > expectedSize) {
    fs.rmSync(part, { force: true });
    start = 0;
  }

  if (!(expectedSize && start === expectedSize)) {
    const headers = { 'User-Agent': 'Blazma-AI' };
    if (start > 0) headers.Range = `bytes=${start}-`;

    let res;
    try {
      res = await net.fetch(url, { headers });
    } catch (err) {
      throw new AppError('network', err.message);
    }
    if (res.status === 200 && start > 0) start = 0; // server ignored Range
    else if (!res.ok) throw new AppError('network', `HTTP ${res.status} for ${url}`);

    const out = fs.createWriteStream(part, { flags: start > 0 ? 'a' : 'w' });
    let writeError = null;
    out.on('error', (e) => {
      writeError = e;
    });

    let done = start;
    const total = expectedSize || start + Number(res.headers.get('content-length') || 0);
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        if (writeError) throw writeError;
        if (!out.write(value)) await once(out, 'drain');
        done += value.length;
        if (onProgress) onProgress(done, total);
      }
    } catch (err) {
      out.destroy();
      if (err && err.code === 'ENOSPC') throw new AppError('disk-full', err.message);
      throw new AppError('network', err.message);
    }
    await new Promise((resolve, reject) => out.end((e) => (e ? reject(e) : resolve())));
    if (writeError) throw new AppError(writeError.code === 'ENOSPC' ? 'disk-full' : 'io', writeError.message);
  }

  const size = fs.statSync(part).size;
  if (expectedSize && size !== expectedSize) {
    throw new AppError('verify-failed', `size ${size} != expected ${expectedSize}`);
  }
  if (sha256) {
    const actual = await sha256File(part);
    if (actual !== sha256.toLowerCase()) {
      fs.rmSync(part, { force: true });
      throw new AppError('verify-failed', `sha256 ${actual} != expected ${sha256}`);
    }
  }
  fs.renameSync(part, dest);
}

module.exports = { downloadFile, sha256File, freeBytes };
