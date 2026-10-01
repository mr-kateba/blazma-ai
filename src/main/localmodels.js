'use strict';

// Models that are already on this computer: a GGUF file the user picks, or
// models downloaded by Ollama (read in place, nothing is copied). They are
// stored as custom catalog entries with `local: true` and run with -m.
//
// Ollama layout (verified from ollama/ollama: manifest/paths.go, server/images.go):
//   <models>/manifests/<host>/<namespace>/<model>/<tag>  (JSON, layers[])
//   <models>/blobs/sha256-<hex>                          (digest "sha256:<hex>")
//   layer mediaType "application/vnd.ollama.image.model"     -> the GGUF weights
//   layer mediaType "application/vnd.ollama.image.projector" -> vision projector
// <models> is OLLAMA_MODELS or ~/.ollama/models.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const { readJson, writeJson } = require('./jsonfile');
const { AppError } = require('./errors');

const MEDIA_MODEL = 'application/vnd.ollama.image.model';
const MEDIA_PROJECTOR = 'application/vnd.ollama.image.projector';
const MEDIA_TENSOR = 'application/vnd.ollama.image.tensor';

// ---------- GGUF header ----------

// Buffered reader over a file descriptor, for walking GGUF metadata (which
// can hold large token arrays) without reading the whole file.
class FileReader {
  constructor(fd) {
    this.fd = fd;
    this.pos = 0;
    this.buf = Buffer.alloc(0);
    this.bufStart = 0;
  }

  ensure(n) {
    const offset = this.pos - this.bufStart;
    if (offset + n <= this.buf.length) return offset;
    const size = Math.max(n, 1 << 20);
    const chunk = Buffer.alloc(size);
    const read = fs.readSync(this.fd, chunk, 0, size, this.pos);
    if (read < n) throw new AppError('not-gguf', 'unexpected end of file');
    this.buf = chunk.subarray(0, read);
    this.bufStart = this.pos;
    return 0;
  }

  u32() {
    const o = this.ensure(4);
    this.pos += 4;
    return this.buf.readUInt32LE(o);
  }

  u64() {
    const o = this.ensure(8);
    this.pos += 8;
    return Number(this.buf.readBigUInt64LE(o));
  }

  bytes(n) {
    if (n > 64 * 1024 * 1024) throw new AppError('not-gguf', 'string too long');
    const o = this.ensure(n);
    this.pos += n;
    return this.buf.subarray(o, o + n);
  }

  string() {
    return this.bytes(this.u64()).toString('utf8');
  }

  skip(n) {
    this.pos += n;
  }
}

const SCALAR_SIZE = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

function readValue(r, type, keep) {
  if (type === 8) return keep ? r.string() : r.skip(r.u64());
  if (type === 9) {
    const itemType = r.u32();
    const count = r.u64();
    if (itemType === 8) for (let i = 0; i < count; i++) r.skip(r.u64());
    else if (SCALAR_SIZE[itemType]) r.skip(SCALAR_SIZE[itemType] * count);
    else for (let i = 0; i < count; i++) readValue(r, itemType, false);
    return undefined;
  }
  const size = SCALAR_SIZE[type];
  if (!size) throw new AppError('not-gguf', `unknown value type ${type}`);
  if (!keep) return r.skip(size);
  const o = r.ensure(size);
  r.skip(size);
  if (type === 4) return r.buf.readUInt32LE(o);
  if (type === 5) return r.buf.readInt32LE(o);
  if (type === 7) return r.buf[o] !== 0;
  return undefined;
}

const WANTED = new Set(['general.name', 'general.architecture', 'general.size_label', 'tokenizer.chat_template', 'general.type']);

// Reads the few metadata keys we use. Throws 'not-gguf' for other files.
// quick: stop after the general.* keys (they come first), skipping the large
// tokenizer arrays; hasTemplate is then unknown (null).
function ggufInfo(file, { quick = false } = {}) {
  const fd = fs.openSync(file, 'r');
  try {
    const r = new FileReader(fd);
    if (r.bytes(4).toString('latin1') !== 'GGUF') throw new AppError('not-gguf', file);
    const version = r.u32();
    if (version < 2) throw new AppError('not-gguf', `version ${version}`);
    r.u64(); // tensor count
    const kvCount = r.u64();
    const info = {};
    let complete = true;
    for (let i = 0; i < kvCount; i++) {
      const key = r.string();
      if (quick && !key.startsWith('general.')) {
        complete = false;
        break;
      }
      const type = r.u32();
      const keep = WANTED.has(key) && key !== 'tokenizer.chat_template';
      const value = readValue(r, type, keep);
      if (key === 'tokenizer.chat_template') info.hasTemplate = true;
      else if (keep) info[key] = value;
    }
    return {
      name: info['general.name'] || null,
      architecture: info['general.architecture'] || null,
      sizeLabel: info['general.size_label'] || null,
      hasTemplate: complete ? Boolean(info.hasTemplate) : null,
      isProjector: info['general.architecture'] === 'clip' || info['general.type'] === 'mmproj',
    };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------- catalog entries ----------

const idFor = (key) => `local-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`;

function saveEntry(entry) {
  const list = readJson(paths.customModels(), []).filter((m) => m.id !== entry.id);
  list.push(entry);
  writeJson(paths.customModels(), list);
  return entry;
}

function entryFor({ key, name, file, mmproj, source, info }) {
  const size = fs.statSync(file).size;
  return {
    id: idFor(key),
    name: String(name).slice(0, 80),
    hf: `local:${key}`,
    local: true,
    source, // 'file' | 'ollama'
    path: file,
    mmproj: mmproj || null,
    sizeBytes: size,
    // Rough fit: weights plus about 1.5 GB for context and buffers.
    minVramMB: Math.round(size / 1024 / 1024 + 1536),
    custom: true,
    vision: Boolean(mmproj),
    thinking: true,
    sampling: {},
    hasTemplate: info.hasTemplate,
    note: '',
  };
}

// A vision projector next to the file (mmproj*.gguf), only when its
// general.name matches the model's: a projector made for another model fails
// to load ("mismatch between text model and mmproj"), so without a match the
// model runs text-only.
function siblingProjector(file, modelName) {
  if (!modelName) return null;
  let names = [];
  try {
    names = fs.readdirSync(path.dirname(file)).filter((n) => /mmproj.*\.gguf$/i.test(n));
  } catch {
    return null;
  }
  const matches = names
    .map((n) => path.join(path.dirname(file), n))
    .filter((p) => {
      if (p === file) return false;
      try {
        const info = ggufInfo(p, { quick: true });
        return info.isProjector && info.name && info.name.toLowerCase() === modelName.toLowerCase();
      } catch {
        return false;
      }
    });
  return matches.length === 1 ? matches[0] : null;
}

function addFile(file) {
  if (!/\.gguf$/i.test(file)) throw new AppError('not-gguf', file);
  const info = ggufInfo(file);
  if (info.isProjector) throw new AppError('gguf-projector', file);
  const mmproj = siblingProjector(file, info.name);
  const name = info.name || path.basename(file, path.extname(file));
  return saveEntry(entryFor({ key: path.resolve(file), name, file, mmproj, source: 'file', info }));
}

// ---------- Ollama ----------

function ollamaDir() {
  return process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');
}

const blobFor = (dir, digest) => path.join(dir, 'blobs', String(digest).replace(':', '-'));

function listDirs(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// Every model Ollama has downloaded, with whether we can run it.
function scanOllama() {
  const dir = ollamaDir();
  const manifests = path.join(dir, 'manifests');
  if (!fs.existsSync(manifests)) return { dir, found: false, models: [] };
  const added = new Set(readJson(paths.customModels(), []).map((m) => m.id));
  const models = [];
  for (const host of listDirs(manifests)) {
    for (const ns of listDirs(path.join(manifests, host))) {
      for (const model of listDirs(path.join(manifests, host, ns))) {
        let tags = [];
        try {
          tags = fs.readdirSync(path.join(manifests, host, ns, model));
        } catch {
          continue;
        }
        for (const tag of tags) {
          const key = `${host}/${ns}/${model}:${tag}`;
          const name = host === 'registry.ollama.ai' && ns === 'library' ? `${model}:${tag}` : `${ns}/${model}:${tag}`;
          const item = { key, name, id: idFor(`ollama:${key}`), ok: false, reason: null, size: 0, vision: false, added: false };
          item.added = added.has(item.id);
          const manifest = readJson(path.join(manifests, host, ns, model, tag), null);
          const layers = (manifest && Array.isArray(manifest.layers) && manifest.layers) || [];
          const weights = layers.find((l) => l.mediaType === MEDIA_MODEL);
          if (!weights) {
            item.reason = layers.some((l) => l.mediaType === MEDIA_TENSOR) ? 'safetensors' : 'no-weights';
            models.push(item);
            continue;
          }
          const file = blobFor(dir, weights.digest);
          try {
            const info = ggufInfo(file, { quick: true });
            if (info.isProjector) throw new AppError('not-gguf', 'projector');
            item.size = fs.statSync(file).size;
            item.ok = true;
            const projector = layers.find((l) => l.mediaType === MEDIA_PROJECTOR);
            item.vision = Boolean(projector && fs.existsSync(blobFor(dir, projector.digest)));
          } catch (err) {
            item.reason = err.code === 'not-gguf' ? 'not-gguf' : 'missing';
          }
          models.push(item);
        }
      }
    }
  }
  models.sort((a, b) => a.name.localeCompare(b.name));
  return { dir, found: true, models };
}

function addOllama(key) {
  const scan = scanOllama();
  const item = scan.models.find((m) => m.key === key);
  if (!item || !item.ok) throw new AppError('model-invalid', key);
  const [host, ns, rest] = key.split('/');
  const [model, tag] = rest.split(':');
  const manifest = readJson(path.join(scan.dir, 'manifests', host, ns, model, tag), null);
  const weights = manifest.layers.find((l) => l.mediaType === MEDIA_MODEL);
  const projector = manifest.layers.find((l) => l.mediaType === MEDIA_PROJECTOR);
  const file = blobFor(scan.dir, weights.digest);
  const mmproj = projector && fs.existsSync(blobFor(scan.dir, projector.digest)) ? blobFor(scan.dir, projector.digest) : null;
  return saveEntry(entryFor({ key: `ollama:${key}`, name: item.name, file, mmproj, source: 'ollama', info: ggufInfo(file) }));
}

module.exports = { ggufInfo, addFile, scanOllama, addOllama, ollamaDir };
