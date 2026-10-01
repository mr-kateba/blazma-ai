'use strict';

// Extracts a .tar.gz with Node only (zlib + a small tar reader), streaming.
// Used instead of Windows' tar.exe, which takes its arguments in the ANSI
// code page and so cannot open paths under a user folder with letters
// outside it (an Arabic user name on an English Windows, for example).
// Handles ustar names (prefix + name), pax "path"/"linkpath" records and
// GNU long names; regular files, folders and symbolic links. Every path is
// checked to stay inside the destination.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { Writable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

const BLOCK = 512;

function cstr(buf, start, len) {
  const end = buf.indexOf(0, start);
  return buf.toString('utf8', start, end < 0 || end > start + len ? start + len : end);
}

function octal(buf, start, len) {
  const s = cstr(buf, start, len).trim();
  return s ? parseInt(s, 8) : 0;
}

function parsePax(text) {
  const out = {};
  let i = 0;
  while (i < text.length) {
    const sp = text.indexOf(' ', i);
    if (sp < 0) break;
    const len = parseInt(text.slice(i, sp), 10);
    if (!len) break;
    const rec = text.slice(sp + 1, i + len - 1); // without the trailing \n
    const eq = rec.indexOf('=');
    if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
    i += len;
  }
  return out;
}

async function extractTarGz(file, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const root = path.resolve(dest);
  const inside = (rel) => {
    const clean = String(rel).replace(/\\/g, '/').replace(/^\.\/+/, '');
    if (!clean || clean.split('/').some((p) => p === '..') || path.isAbsolute(clean) || /^[a-z]:/i.test(clean)) return null;
    const full = path.resolve(root, clean);
    return full === root || full.startsWith(root + path.sep) ? full : null;
  };

  let buf = Buffer.alloc(0);
  let header = null; // current entry { type, name, size, mode, link }
  let remaining = 0; // bytes of data left for the entry
  let padding = 0;
  let out = null; // open file descriptor
  let longName = null;
  let pax = {};
  let collect = null; // Buffer chunks for pax / GNU long name data
  let done = false;

  const startEntry = (h) => {
    const typeflag = String.fromCharCode(h[156] || 48);
    const size = octal(h, 124, 12);
    let name = cstr(h, 0, 100);
    const prefix = h.toString('latin1', 257, 263).startsWith('ustar') ? cstr(h, 345, 155) : '';
    if (prefix) name = `${prefix}/${name}`;
    const entry = { type: typeflag, size, mode: octal(h, 100, 8), name, link: cstr(h, 157, 100) };
    if (typeflag === 'x' || typeflag === 'g' || typeflag === 'L') {
      collect = [];
    } else {
      if (longName) entry.name = longName;
      if (pax.path) entry.name = pax.path;
      if (pax.linkpath) entry.link = pax.linkpath;
      longName = null;
      pax = {};
      const full = inside(entry.name);
      if (full && (typeflag === '0' || typeflag === '\0' || typeflag === '7')) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        out = fs.openSync(full, 'w', entry.mode & 0o777 || 0o644);
      } else if (full && typeflag === '5') {
        fs.mkdirSync(full, { recursive: true });
      } else if (full && typeflag === '2' && entry.link && inside(path.join(path.dirname(entry.name), entry.link))) {
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.rmSync(full, { force: true });
        try {
          fs.symlinkSync(entry.link, full);
        } catch {
          /* no symlink rights (Windows without developer mode): skipped */
        }
      }
    }
    header = entry;
    remaining = size;
    padding = (BLOCK - (size % BLOCK)) % BLOCK;
  };

  const endEntry = () => {
    if (out !== null) {
      fs.closeSync(out);
      out = null;
    }
    if (collect) {
      const data = Buffer.concat(collect);
      if (header.type === 'L') longName = cstr(data, 0, data.length);
      else if (header.type === 'x') pax = parsePax(data.toString('utf8'));
      collect = null;
    }
    header = null;
  };

  const sink = new Writable({
    write(chunk, _enc, cb) {
      try {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        let at = 0;
        while (!done) {
          if (header) {
            if (remaining > 0) {
              const take = Math.min(remaining, buf.length - at);
              if (take === 0) break;
              const part = buf.subarray(at, at + take);
              if (out !== null) fs.writeSync(out, part);
              else if (collect) collect.push(Buffer.from(part));
              remaining -= take;
              at += take;
              if (remaining > 0) break;
            }
            if (buf.length - at < padding) {
              padding -= buf.length - at;
              at = buf.length;
              break;
            }
            at += padding;
            padding = 0;
            endEntry();
            continue;
          }
          if (buf.length - at < BLOCK) break;
          const h = buf.subarray(at, at + BLOCK);
          at += BLOCK;
          if (h.every((b) => b === 0)) {
            done = true; // end-of-archive marker
            break;
          }
          startEntry(h);
        }
        buf = buf.subarray(at);
        cb();
      } catch (err) {
        cb(err);
      }
    },
    final(cb) {
      if (out !== null) fs.closeSync(out);
      cb();
    },
  });

  await pipeline(fs.createReadStream(file), zlib.createGunzip(), sink);
}

module.exports = { extractTarGz };
