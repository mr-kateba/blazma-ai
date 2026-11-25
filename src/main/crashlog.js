'use strict';

// crash.txt in the data folder: why the app (or one of its parts) stopped,
// so the user can attach it to a bug report. No chats, no file contents.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app } = require('electron');

const MAX_BYTES = 256 * 1024;

function file() {
  return path.join(app.getPath('userData'), 'crash.txt');
}

function write(what, err) {
  try {
    const detail = err && err.stack ? err.stack : String(err == null ? '' : err);
    // The user name is not needed to understand a crash.
    const clean = detail.split(os.homedir()).join('~');
    const line = `[${new Date().toISOString()}] v${app.getVersion()} ${process.platform} ${os.release()}  ${what}\n${clean}\n\n`;
    const f = file();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    let old = '';
    try {
      old = fs.readFileSync(f, 'utf8');
    } catch {}
    const all = old + line;
    fs.writeFileSync(f, all.length > MAX_BYTES ? all.slice(all.length - MAX_BYTES) : all);
  } catch {
    /* never crash while writing the crash log */
  }
}

function exists() {
  return fs.existsSync(file());
}

module.exports = { write, file, exists };
