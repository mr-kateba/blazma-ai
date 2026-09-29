'use strict';

// Model catalog, recommendation, and the local view of llama.cpp's
// Hugging Face cache (LLAMA_CACHE/models--owner--name/blobs/<sha256>).

const fs = require('node:fs');
const path = require('node:path');
const { net } = require('electron');
const paths = require('./paths');
const settings = require('./settings');
const { readJson, writeJson } = require('./jsonfile');
const { sha256File } = require('./download');
const { AppError } = require('./errors');

// Development/testing only: point at a local Hugging Face mirror. The same
// value is passed to llama-server as HF_ENDPOINT.
const HF_ENDPOINT = (process.env.BLAZMA_HF_ENDPOINT || 'https://huggingface.co').replace(/\/+$/, '');

let catalog = null;

function getCatalog() {
  if (!catalog) catalog = readJson(paths.catalogFile(), { models: [] }).models;
  return catalog;
}

function findModel(id) {
  return getCatalog().find((m) => m.id === id) || null;
}

// First GPU model in catalog order (the catalog lists the preferred default
// first) that fits the card; the CPU model when there is no NVIDIA GPU or the
// card is too small for every GPU model.
function recommend(nvidia) {
  const models = getCatalog();
  const cpuModel = models.find((m) => m.cpu) || null;
  if (!nvidia || !nvidia.available) return cpuModel;
  return models.find((m) => !m.cpu && m.minVramMB <= nvidia.best.vramMB) || cpuModel;
}

function parseHf(hf) {
  const m = /^([A-Za-z0-9][\w.-]*)\/([\w.-]+):([\w.-]+)$/.exec(hf || '');
  if (!m) throw new AppError('model-invalid', hf);
  return { repo: `${m[1]}/${m[2]}`, quant: m[3] };
}

function repoDir(repo) {
  return path.join(settings.modelsDir(), `models--${repo.replace(/\//g, '--')}`);
}

// Mirrors llama.cpp's own choice of file for "repo:quant" (common/download.cpp
// find_best_model): first model .gguf whose name contains QUANT followed by
// "." or "-", taking every part of a split model.
function pickFiles(tree, quant) {
  const isModel = (p) =>
    p.endsWith('.gguf') && !/(mmproj|imatrix|mtp-|eagle3-|dflash-|dspark-)/.test(path.posix.basename(p));
  const re = new RegExp(`${quant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[.-]`, 'i');
  const first = tree.find((f) => f.type === 'file' && isModel(f.path) && re.test(f.path) && !/-0000[2-9]-of-/.test(f.path));
  if (!first) return [];
  const split = /^(.*)-00001-of-(\d{5})\.gguf$/.exec(first.path);
  if (!split) return [first];
  return tree.filter((f) => f.path.startsWith(`${split[1]}-`) && new RegExp(`-\\d{5}-of-${split[2]}\\.gguf$`).test(f.path));
}

async function resolveRemote(hf) {
  const { repo, quant } = parseHf(hf);
  let res;
  try {
    res = await net.fetch(`${HF_ENDPOINT}/api/models/${repo}/tree/main?recursive=true`, {
      headers: { 'User-Agent': 'Blazma-AI' },
    });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (res.status === 404 || res.status === 401) throw new AppError('model-not-found', hf);
  if (!res.ok) throw new AppError('network', `Hugging Face HTTP ${res.status}`);
  const tree = await res.json();
  const files = pickFiles(Array.isArray(tree) ? tree : [], quant).map((f) => ({
    path: f.path,
    size: f.lfs ? f.lfs.size : f.size,
    oid: f.lfs ? f.lfs.oid : null,
  }));
  if (!files.length || files.some((f) => !f.oid)) throw new AppError('model-not-found', hf);
  return { hf, repo, files, size: files.reduce((s, f) => s + f.size, 0) };
}

// models.json remembers what each download resolved to, so the app can start
// offline and knows which files to measure.
function manifest() {
  return readJson(paths.modelsManifest(), {});
}

function saveManifestEntry(hf, entry) {
  const all = manifest();
  if (entry) all[hf] = entry;
  else delete all[hf];
  writeJson(paths.modelsManifest(), all);
}

function blobPath(repo, oid) {
  return path.join(repoDir(repo), 'blobs', oid);
}

function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

// Where a finished file lives. Normally blobs/<sha256> with a symlink in
// snapshots/<commit>/. When symlinks are not allowed (Windows without
// Developer Mode), llama.cpp moves the file into snapshots/<commit>/ instead
// (hf-cache.cpp finalize_file), so look there too.
function finishedPath(repo, file) {
  const blob = blobPath(repo, file.oid);
  if (fileSize(blob) === file.size) return blob;
  const snapshots = path.join(repoDir(repo), 'snapshots');
  let commits = [];
  try {
    commits = fs.readdirSync(snapshots);
  } catch {}
  for (const commit of commits) {
    const candidate = path.join(snapshots, commit, ...file.path.split('/'));
    if (fileSize(candidate) === file.size) return candidate;
  }
  return null;
}

// Real progress: bytes on disk (finished files plus llama.cpp's
// ".downloadInProgress" files) against the sizes Hugging Face reported.
function localProgress(entry) {
  let done = 0;
  for (const f of entry.files) {
    done += finishedPath(entry.repo, f) ? f.size : fileSize(`${blobPath(entry.repo, f.oid)}.downloadInProgress`);
  }
  return { done: Math.min(done, entry.size), total: entry.size };
}

function isComplete(entry) {
  return Boolean(entry) && entry.files.every((f) => finishedPath(entry.repo, f) !== null);
}

// Hugging Face's LFS oid is the file's SHA-256, so the hash check is exact.
async function verify(entry) {
  for (const f of entry.files) {
    const file = finishedPath(entry.repo, f);
    if (!file || (await sha256File(file)) !== f.oid) return false;
  }
  return true;
}

function removeLocal(entry) {
  fs.rmSync(repoDir(entry.repo), { recursive: true, force: true });
}

module.exports = {
  HF_ENDPOINT,
  getCatalog,
  findModel,
  recommend,
  resolveRemote,
  manifest,
  saveManifestEntry,
  localProgress,
  isComplete,
  verify,
  removeLocal,
};
