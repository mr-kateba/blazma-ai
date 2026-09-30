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

// Built-in catalog (catalog.json) followed by models the user added.
function getCatalog() {
  if (!catalog) catalog = readJson(paths.catalogFile(), { models: [] }).models;
  return [...catalog, ...readJson(paths.customModels(), [])];
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

// Quantization bits from a GGUF file name's last tag: Q4_K_M -> 4, F16 -> 16
// (llama.cpp get_gguf_split_info + extract_quant_bits).
function quantBits(file) {
  const base = file.replace(/\.gguf$/i, '').replace(/-\d{5}-of-\d{5}$/i, '');
  const tag = (/[-.]([A-Z0-9_]+)$/i.exec(base) || [])[1] || '';
  const m = /\d+/.exec(tag);
  return m ? Number(m[0]) : 0;
}

// Mirrors llama.cpp's choice of vision projector for -hf (download.cpp
// find_best_sibling with keyword "mmproj"): same folder as the model, closest
// quantization bits to the model's, first in listing order on a tie.
function pickMmproj(tree, modelPath) {
  const dir = path.posix.dirname(modelPath);
  const bits = quantBits(modelPath);
  let best = null;
  let bestDiff = Infinity;
  for (const f of tree) {
    if (f.type !== 'file' || !f.path.endsWith('.gguf') || !f.path.includes('mmproj')) continue;
    if (path.posix.dirname(f.path) !== dir) continue;
    const diff = Math.abs(quantBits(f.path) - bits);
    if (diff < bestDiff) {
      best = f;
      bestDiff = diff;
    }
  }
  return best;
}

async function resolveRemote(hf, { vision = false } = {}) {
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
  const list = Array.isArray(tree) ? tree : [];
  const picked = pickFiles(list, quant);
  const mmproj = vision && picked.length ? pickMmproj(list, picked[0].path) : null;
  const files = [...picked, ...(mmproj ? [mmproj] : [])].map((f) => ({
    path: f.path,
    size: f.lfs ? f.lfs.size : f.size,
    oid: f.lfs ? f.lfs.oid : null,
  }));
  if (!files.length || files.some((f) => !f.oid)) throw new AppError('model-not-found', hf);
  return { hf, repo, files, vision: Boolean(mmproj), size: files.reduce((s, f) => s + f.size, 0) };
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

// "إضافة موديل مخصص": checks on Hugging Face that repo:quant resolves to a
// GGUF file (and whether it has a vision projector) before adding it.
async function addCustom(hf) {
  const clean = String(hf || '').trim();
  const withVision = await resolveRemote(clean, { vision: true });
  const modelFiles = withVision.files.filter((f) => !f.path.includes('mmproj'));
  const size = modelFiles.reduce((sum, f) => sum + f.size, 0);
  const id = `custom-${clean.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 64);
  const custom = readJson(paths.customModels(), []).filter((m) => m.id !== id);
  const entry = {
    id,
    name: withVision.repo.split('/')[1].replace(/-GGUF$/i, ''),
    hf: clean,
    sizeBytes: size,
    // Rough fit: weights plus about 1.5 GB for context and buffers.
    minVramMB: Math.round(size / 1024 / 1024 + 1536),
    custom: true,
    vision: withVision.vision,
    thinking: true,
    sampling: {},
    note: '',
  };
  custom.push(entry);
  writeJson(paths.customModels(), custom);
  return entry;
}

function removeCustom(id) {
  writeJson(
    paths.customModels(),
    readJson(paths.customModels(), []).filter((m) => m.id !== id),
  );
}

// Bytes of this model's files on disk (finished or partial).
function sizeOnDisk(hf) {
  const entry = manifest()[hf];
  return entry ? localProgress(entry).done : 0;
}

function deleteDownload(hf) {
  const entry = manifest()[hf];
  if (entry) removeLocal(entry);
  saveManifestEntry(hf, null);
}

module.exports = {
  addCustom,
  removeCustom,
  sizeOnDisk,
  deleteDownload,
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
