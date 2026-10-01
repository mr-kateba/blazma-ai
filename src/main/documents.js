'use strict';

// Text from files attached in the chat: plain text and code, PDF (pdf.js,
// Apache-2.0) and Word .docx (mammoth, BSD-2-Clause). The parsing runs in a
// short-lived utility process (doc-worker.js) with a time limit.

const path = require('node:path');
const { utilityProcess } = require('electron');
const { AppError } = require('./errors');

const MAX_BYTES = 25 * 1024 * 1024;
const MAX_CHARS = 400_000;
const TIMEOUT_MS = 45_000;
const TEXT_EXT =
  /\.(txt|text|md|markdown|csv|tsv|json|jsonl|xml|ya?ml|ini|toml|log|html?|css|m?js|cjs|jsx|ts|tsx|py|java|c|h|cc|cpp|hpp|cs|go|rs|rb|php|sql|sh|ps1|bat|kt|swift|dart|lua|r|tex|srt|vtt)$/i;

function kindOf(name) {
  if (/\.pdf$/i.test(name)) return 'pdf';
  if (/\.docx$/i.test(name)) return 'docx';
  if (TEXT_EXT.test(name)) return 'text';
  return null;
}

function runWorker(kind, bytes) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(path.join(__dirname, 'doc-worker.js'), [], { serviceName: 'Blazma document reader', stdio: 'ignore' });
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new AppError('file-timeout')), TIMEOUT_MS);
    child.on('message', (m) => (m && m.ok ? finish(resolve, m.result) : finish(reject, new AppError('file-unreadable', m && m.error))));
    child.on('exit', () => finish(reject, new AppError('file-unreadable', 'worker exited')));
    child.postMessage({ kind, bytes });
  });
}

async function extractFile(name, bytes) {
  const fileName = String(name || '').slice(0, 200);
  const kind = kindOf(fileName);
  if (!kind) throw new AppError('file-unsupported', fileName);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!data.byteLength) throw new AppError('file-empty');
  if (data.byteLength > MAX_BYTES) throw new AppError('file-too-big', String(data.byteLength));
  const result = await runWorker(kind, data);
  const text = String(result.text || '');
  if (!text.trim()) throw new AppError(kind === 'pdf' ? 'file-no-text' : 'file-empty');
  return {
    name: fileName,
    kind,
    text: text.slice(0, MAX_CHARS),
    chars: Math.min(text.length, MAX_CHARS),
    truncated: text.length > MAX_CHARS,
    pages: result.pages || null,
  };
}

module.exports = { extractFile, kindOf };
