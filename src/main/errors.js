'use strict';

// Errors carry a stable code that the renderer maps to an Arabic message
// (src/renderer/i18n/ar.js). `detail` is technical text for the support box.
class AppError extends Error {
  constructor(code, detail = '') {
    super(`${code}${detail ? `: ${detail}` : ''}`);
    this.code = code;
    this.detail = String(detail || '');
  }
}

function toAppError(err, fallbackCode = 'unknown') {
  if (err instanceof AppError) return err;
  if (err && err.code === 'ENOSPC') return new AppError('disk-full', err.message);
  return new AppError(fallbackCode, err && err.message ? err.message : String(err));
}

module.exports = { AppError, toAppError };
