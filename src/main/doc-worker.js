'use strict';

// Runs in a separate utility process (see documents.js): turns an attached
// file into plain text. Parsing PDFs and Word files from the internet is kept
// out of the main process, so a malformed or hostile file can at worst crash
// or hang this process, which is then killed.

const path = require('node:path');
const { pathToFileURL } = require('node:url');

const MAX_PDF_PAGES = 500;

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (buf[0] === 0xfe && buf[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  const utf8 = new TextDecoder('utf-8').decode(buf);
  // Older Arabic text files are often Windows-1256, which is not valid UTF-8.
  const bad = (utf8.match(/�/g) || []).length;
  if (bad > 3 && bad > utf8.length / 2000) {
    try {
      return new TextDecoder('windows-1256').decode(buf);
    } catch {
      return utf8;
    }
  }
  return utf8;
}

const RTL_CHAR = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
const STRONG_LTR = /[A-Za-z0-9\u00C0-\u024F]/;
const LTR_LETTER = /[A-Za-z\u00C0-\u024F]/; // digits do not decide a line's direction

// PDFs store text by position, often one glyph per item and in visual
// (left-to-right) order, which turns Arabic into reversed, spaced-out
// letters if the items are simply joined. Rebuild each line from positions:
// sort by x, add spaces at real gaps, and for right-to-left lines put the
// runs back in reading order (Latin letters and digits keep their order).
function layoutPage(items) {
  const glyphs = items
    .filter((it) => typeof it.str === 'string' && it.str.length)
    .map((it) => ({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 10 }));
  glyphs.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const g of glyphs) {
    const line = lines.length ? lines[lines.length - 1] : null;
    if (line && Math.abs(line.y - g.y) <= Math.max(2, g.h * 0.5)) line.items.push(g);
    else lines.push({ y: g.y, items: [g] });
  }
  return lines
    .map((line) => {
      const items = line.items.sort((a, b) => a.x - b.x);
      // Visual runs: text of one direction, separated by gaps (spaces).
      const tokens = [];
      let prev = null;
      for (const g of items) {
        if (prev && g.x - (prev.x + prev.w) > Math.min(prev.h, g.h) * 0.2) tokens.push({ space: true });
        if (/^\s+$/.test(g.str)) tokens.push({ space: true });
        else tokens.push({ str: g.str, rtl: RTL_CHAR.test(g.str) && !STRONG_LTR.test(g.str), ltr: STRONG_LTR.test(g.str) });
        prev = g;
      }
      const text = tokens.map((t) => (t.space ? ' ' : t.str)).join('');
      const rtlCount = (text.match(new RegExp(RTL_CHAR.source, 'g')) || []).length;
      const ltrCount = (text.match(new RegExp(LTR_LETTER.source, 'g')) || []).length;
      // Mostly Arabic letters (digits are neutral); on a tie, the strong
      // character furthest right decides, as it starts a right-to-left line.
      const strong = [...text].filter((c) => RTL_CHAR.test(c) || LTR_LETTER.test(c));
      const rightmostRtl = strong.length > 0 && RTL_CHAR.test(strong[strong.length - 1]);
      if (rtlCount < ltrCount || (rtlCount === ltrCount && !rightmostRtl) || !rtlCount) return text.replace(/ {2,}/g, ' ').trim();
      // Right-to-left line: group consecutive non-RTL tokens (Latin, digits and
      // the spaces/punctuation between them) into runs that keep their order,
      // then read everything from right to left.
      const runs = [];
      for (const t of tokens) {
        const isLtr = !t.space && !t.rtl && t.ltr;
        const last = runs[runs.length - 1];
        if (isLtr && last && last.ltr) last.parts.push(t);
        else if (t.space && last && last.ltr) last.pendingSpace = (last.pendingSpace || 0) + 1;
        else {
          if (last && last.ltr && last.pendingSpace) runs.push({ parts: [{ space: true }] });
          runs.push({ ltr: isLtr, parts: [t] });
        }
      }
      return (
        runs
          .reverse()
          // Sentence punctuation drawn on the left of a number or Latin word
          // in a right-to-left line belongs after it in reading order.
          .map((r) => {
            const txt = r.parts.map((t) => (t.space ? ' ' : t.str)).join('');
            return r.ltr ? txt.replace(/^([.,،؛:!?]+)(.+)$/, '$2$1') : txt;
          })
          .join('')
          .replace(/ {2,}/g, ' ')
          // Arabic diacritics (tanween, shadda…) attach to the letter before them.
          .replace(/ +([\u064B-\u065F\u0670])/g, '$1')
          // A diacritic can land before its letter at the start of a word.
          .replace(/(^|\s)([\u064B-\u065F\u0670]+)([^\s\u064B-\u065F\u0670])/g, '$1$3$2')
          .trim()
      );
    })
    .join('\n');
}

async function pdfText(buf) {
  const base = path.dirname(require.resolve('pdfjs-dist/package.json'));
  const pdfjs = await import(pathToFileURL(path.join(base, 'legacy', 'build', 'pdf.mjs')).href);
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(base, 'legacy', 'build', 'pdf.worker.mjs')).href;
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf),
    cMapUrl: `${pathToFileURL(path.join(base, 'cmaps')).href}/`,
    cMapPacked: true,
    standardFontDataUrl: `${pathToFileURL(path.join(base, 'standard_fonts')).href}/`,
    // No code generation from font data (the path of CVE-2024-4367).
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  });
  const doc = await task.promise;
  const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
  const out = [];
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    out.push(layoutPage(content.items));
    page.cleanup();
  }
  await task.destroy();
  return { text: out.join('\n\n'), pages: doc.numPages, pagesRead: pages };
}

async function docxText(buf) {
  const mammoth = require('mammoth');
  const result = await mammoth.extractRawText({ buffer: Buffer.from(buf) });
  return { text: result.value };
}

async function extract({ kind, bytes }) {
  const buf = Buffer.from(bytes);
  let result;
  if (kind === 'pdf') result = await pdfText(buf);
  else if (kind === 'docx') result = await docxText(buf);
  else result = { text: decodeText(buf) };
  // NFKC turns Arabic presentation forms (common in PDFs) into normal letters.
  result.text = result.text.normalize('NFKC').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n');
  return result;
}

process.parentPort.on('message', async (e) => {
  try {
    process.parentPort.postMessage({ ok: true, result: await extract(e.data) });
  } catch (err) {
    process.parentPort.postMessage({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
});
