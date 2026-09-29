'use strict';

// Runs system tools with fixed argument arrays and no shell, so nothing from
// the user or the model can ever be interpreted as a command.

const { execFile } = require('node:child_process');

function run(file, args, { timeoutMs = 15000, env, cwd } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', env, cwd },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error ? (typeof error.code === 'number' ? error.code : null) : 0,
          notFound: Boolean(error && error.code === 'ENOENT'),
          stdout: stdout || '',
          stderr: stderr || '',
        });
      },
    );
  });
}

module.exports = { run };
