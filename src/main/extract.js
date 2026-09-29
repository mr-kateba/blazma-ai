'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { run } = require('./exec');
const { AppError } = require('./errors');

// Uses tools that ship with Windows 10 (1803+) / 11: tar.exe (bsdtar reads
// zip), falling back to PowerShell's Expand-Archive. Paths are passed through
// environment variables, never spliced into the command text.
async function extractZip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });

  if (process.platform === 'win32') {
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    const t = await run(tar, ['-xf', zip, '-C', dest], { timeoutMs: 10 * 60 * 1000 });
    if (t.ok) return;

    const ps = await run(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:BLAZMA_ZIP -DestinationPath $env:BLAZMA_DEST -Force',
      ],
      { timeoutMs: 10 * 60 * 1000, env: { ...process.env, BLAZMA_ZIP: zip, BLAZMA_DEST: dest } },
    );
    if (ps.ok) return;
    throw new AppError('engine-extract', `${t.stderr}\n${ps.stderr}`.trim());
  }

  const u = await run('unzip', ['-o', '-q', zip, '-d', dest], { timeoutMs: 10 * 60 * 1000 });
  if (!u.ok) throw new AppError('engine-extract', u.stderr);
}

module.exports = { extractZip };
