'use strict';

// "مكتبتي": answers from the user's own documents. The user picks folders;
// their text files, PDFs and Word files are split into passages, and each
// passage is turned into a meaning vector by a small embedding model
// (Qwen3-Embedding-0.6B, Apache-2.0, 100+ languages) run by a second
// llama-server. A question is matched against those vectors and the closest
// passages go to the chat model with their file names.
//
// Verified in the model card (Qwen/Qwen3-Embedding-0.6B-GGUF): llama-server
// "--embedding --pooling last", and queries written as
// "Instruct: <task>\nQuery:<question>" (documents without an instruction).
// Everything stays on this computer: <userData>/knowledge/index.json.

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const paths = require('./paths');
const settings = require('./settings');
const { readJson, writeJson } = require('./jsonfile');
const { extractFile, kindOf } = require('./documents');
const { installedEngine } = require('./engine');
const { pickPort } = require('./server');
const { AppError } = require('./errors');

const EMBED_HF = 'Qwen/Qwen3-Embedding-0.6B-GGUF:Q8_0';
const QUERY_TASK = 'Given a question, retrieve passages from the user\'s documents that answer it';
const CHUNK_CHARS = 1200;
const CHUNK_OVERLAP = 200;
const BATCH = 16;
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_DEPTH = 8;
const IDLE_SECONDS = 300; // the embedding model leaves memory after 5 idle minutes
const MIN_SCORE = 0.35;
const SCORE_GAP = 0.12;

const dir = () => path.join(paths.userData(), 'knowledge');
const indexFile = () => path.join(dir(), 'index.json');

// ---------- the embedding server ----------

let server = null; // { child, port, key, ready }

async function ensureServer() {
  if (server && server.ready && server.child.exitCode === null) return server;
  const engine = installedEngine();
  if (!engine) throw new AppError('kb-no-engine');
  const port = await pickPort(0);
  const key = crypto.randomBytes(24).toString('hex');
  // Development/testing: a local embedding model file instead of the download.
  const source = process.env.BLAZMA_EMBED_MODEL ? ['-m', process.env.BLAZMA_EMBED_MODEL] : ['-hf', EMBED_HF];
  const args = [...source, '--embedding', '--pooling', 'last', '-c', '8192', '-ub', '8192', '--host', '127.0.0.1', '--port', String(port), '--no-webui', '--sleep-idle-seconds', String(IDLE_SECONDS)];
  const env = { ...process.env, LLAMA_CACHE: settings.modelsDir(), LLAMA_API_KEY: key };
  if (process.env.BLAZMA_HF_ENDPOINT) env.HF_ENDPOINT = process.env.BLAZMA_HF_ENDPOINT;
  const child = spawn(engine.exe, args, { cwd: engine.dir, env, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let log = '';
  child.stderr.on('data', (d) => (log = (log + d).slice(-4000)));
  server = { child, port, key, ready: false };
  const started = Date.now();
  // The first start downloads the model (about 640 MB), so allow time.
  while (Date.now() - started < 30 * 60 * 1000) {
    if (child.exitCode !== null) throw new AppError('kb-engine-failed', log.slice(-800));
    if ((await request('GET', '/health').catch(() => null))?.status === 'ok') {
      server.ready = true;
      return server;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new AppError('kb-engine-failed', 'timeout');
}

function request(method, route, body) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port: server.port,
        path: route,
        method,
        timeout: 10 * 60 * 1000,
        headers: { Authorization: `Bearer ${server.key}`, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}) },
      },
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
    if (data) req.write(data);
    req.end();
  });
}

async function embed(texts) {
  await ensureServer();
  const res = await request('POST', '/v1/embeddings', { input: texts });
  if (!res || !Array.isArray(res.data)) throw new AppError('kb-engine-failed', JSON.stringify(res).slice(0, 300));
  return res.data.sort((a, b) => a.index - b.index).map((d) => normalize(d.embedding));
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / n);
}

const toB64 = (vec) => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
const fromB64 = (s) => {
  const b = Buffer.from(s, 'base64');
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
};

function stop() {
  if (server && server.child.exitCode === null) server.child.kill();
  server = null;
}

// ---------- index ----------

function load() {
  const idx = readJson(indexFile(), null);
  return idx && Array.isArray(idx.folders) && idx.files ? idx : { version: 1, folders: [], files: {} };
}

function save(idx) {
  fs.mkdirSync(dir(), { recursive: true });
  writeJson(indexFile(), idx);
}

// Paragraph-aware pieces of about CHUNK_CHARS, overlapping a little so an
// answer that crosses a boundary is still found whole in one piece.
function chunk(text) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim();
  const out = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(clean.length, start + CHUNK_CHARS);
    if (end < clean.length) {
      const para = clean.lastIndexOf('\n\n', end);
      const line = clean.lastIndexOf('\n', end);
      const stopAt = clean.lastIndexOf('. ', end);
      const cut = [para, line, stopAt].find((p) => p > start + CHUNK_CHARS / 2);
      if (cut) end = cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) out.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return out;
}

function listFiles(folder) {
  const out = [];
  const walk = (d, depth) => {
    if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.isFile() && kindOf(e.name)) out.push(p);
      if (out.length >= MAX_FILES) return;
    }
  };
  walk(folder, 0);
  return out;
}

function status() {
  const idx = load();
  const files = Object.values(idx.files);
  return {
    folders: idx.folders,
    files: files.length,
    chunks: files.reduce((n, f) => n + f.chunks.length, 0),
    updatedAt: idx.updatedAt || null,
    failed: files.filter((f) => f.error).length,
  };
}

const isIndexed = (file) => Object.prototype.hasOwnProperty.call(load().files, file);

function addFolder(folder) {
  const idx = load();
  const abs = path.resolve(folder);
  if (!idx.folders.includes(abs)) idx.folders.push(abs);
  save(idx);
  return status();
}

function removeFolder(folder) {
  const idx = load();
  idx.folders = idx.folders.filter((f) => f !== folder);
  for (const file of Object.keys(idx.files)) if (file.startsWith(folder + path.sep)) delete idx.files[file];
  save(idx);
  return status();
}

let indexing = null;

// Reads new and changed files (by size and modification time), forgets
// deleted ones, and embeds the passages. onProgress({ done, total, file }).
async function update(onProgress = () => {}) {
  if (indexing) return indexing;
  indexing = (async () => {
    const idx = load();
    const wanted = new Set(idx.folders.flatMap(listFiles));
    for (const file of Object.keys(idx.files)) if (!wanted.has(file)) delete idx.files[file];
    const todo = [...wanted].filter((file) => {
      const st = fs.statSync(file, { throwIfNoEntry: false });
      const known = idx.files[file];
      return st && st.size <= MAX_FILE_BYTES && (!known || known.mtime !== st.mtimeMs || known.size !== st.size);
    });
    let done = 0;
    for (const file of todo) {
      onProgress({ done, total: todo.length, file: path.basename(file) });
      const st = fs.statSync(file);
      try {
        const { text } = await extractFile(path.basename(file), fs.readFileSync(file));
        const pieces = chunk(text);
        const vectors = [];
        for (let i = 0; i < pieces.length; i += BATCH) vectors.push(...(await embed(pieces.slice(i, i + BATCH))));
        idx.files[file] = { mtime: st.mtimeMs, size: st.size, chunks: pieces.map((t, i) => ({ text: t, vec: toB64(vectors[i]) })) };
      } catch (err) {
        if (err.code === 'kb-engine-failed' || err.code === 'kb-no-engine') throw err;
        idx.files[file] = { mtime: st.mtimeMs, size: st.size, chunks: [], error: err.code || 'file-unreadable' };
      }
      done++;
      if (done % 10 === 0) save(idx);
    }
    idx.updatedAt = Date.now();
    save(idx);
    onProgress({ done, total: todo.length, file: null });
    return status();
  })();
  try {
    return await indexing;
  } finally {
    indexing = null;
  }
}

// The passages closest in meaning to the question, best first.
async function search(question, limit = 5) {
  const idx = load();
  const all = [];
  for (const [file, f] of Object.entries(idx.files)) for (const c of f.chunks) all.push({ file, c });
  if (!all.length) return [];
  const [q] = await embed([`Instruct: ${QUERY_TASK}\nQuery:${String(question).slice(0, 4000)}`]);
  const scored = all.map(({ file, c }) => {
    const v = fromB64(c.vec);
    let s = 0;
    for (let i = 0; i < v.length; i++) s += v[i] * q[i];
    return { file, name: path.basename(file), text: c.text, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  // Passages far below the best match are about something else, so they are
  // not sent or shown as sources. Measured on the test documents
  // (tests/e2e/kb.js): matches scored 0.53-0.70, unrelated passages 0.23-0.42.
  const best = scored[0].score;
  return scored.filter((p) => p.score >= MIN_SCORE && p.score >= best - SCORE_GAP).slice(0, limit);
}

module.exports = { status, addFolder, removeFolder, update, search, stop, chunk, isIndexed };
