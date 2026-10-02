// The interface language: Arabic (default) or English, chosen in Settings >
// General. Read once when the page loads (the page reloads after a change),
// so every module gets the same strings.

import { ar } from './ar.js';
import { en } from './en.js';

export const LANG = (() => {
  try {
    return localStorage.getItem('blazma.lang') === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
})();

export const ui = LANG === 'en' ? en : ar;

// For dates and numbers written by the page, and the writing direction.
export const LOCALE = LANG === 'en' ? 'en' : 'ar';
export const DIR = LANG === 'en' ? 'ltr' : 'rtl';

export function errorText(code) {
  return ui.errors[code] || ui.errors.unknown;
}

export function formatBytes(bytes) {
  const u = ui.units;
  if (!Number.isFinite(bytes) || bytes <= 0) return u.mb(0);
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return u.gb(gb.toFixed(2));
  return u.mb(Math.round(bytes / 1024 ** 2));
}

export function formatDuration(seconds) {
  const u = ui.units;
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return u.sec(Math.ceil(seconds));
  const min = Math.ceil(seconds / 60);
  if (min < 60) return u.min(min);
  return u.hourMin(Math.floor(min / 60), min % 60);
}
