// Tiny DOM helper. Strings become text nodes, never HTML.
export function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v === null || v === undefined) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const RTL_CHARS = /[֐-ࣿיִ-﷿ﹰ-﻿]/g;
const LTR_CHARS = /[A-Za-zÀ-ɏ]/g;

// Direction for a block of mixed text. dir="auto" only looks at the first
// strong character, so an Arabic sentence that starts with "Python" would
// render left-to-right; counting letters handles that.
export function detectDir(text) {
  const rtl = (String(text).match(RTL_CHARS) || []).length;
  const ltr = (String(text).match(LTR_CHARS) || []).length;
  if (!rtl && !ltr) return 'auto';
  return rtl / (rtl + ltr) >= 0.3 ? 'rtl' : 'ltr';
}
