'use strict';

// "ترجم الملف": a Word or PDF file translated whole.
// - Word (.docx): every paragraph's text is replaced in the document's own
//   XML (body, tables, headers, footers, footnotes), so styles, tables,
//   pictures and page layout stay as they were. Arabic output is marked
//   right-to-left (w:bidi on the paragraph, w:rtl on the runs).
// - PDF: the text of each page (pdf.js, or Windows OCR for scanned pages) is
//   translated and printed as a new PDF, page for page. Pictures and the
//   exact layout of a PDF cannot be kept.
// The renderer translates the pieces with the local model (parse -> units,
// then build with the translations).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, dialog, shell } = require('electron');
const JSZip = require('jszip');
const { runWorker } = require('./documents');
const ocr = require('./ocr');
const { AppError } = require('./errors');

const MAX_BYTES = 50 * 1024 * 1024;
const MAX_UNITS = 6000;
const jobs = new Map(); // id -> job, the last few only
const LETTER = /[\p{L}]/u;
const RTL_LANGS = new Set(['ar', 'fa', 'ur', 'he']);

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const escapeXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeHtml = (s) => escapeXml(s).replace(/"/g, '&quot;');

function remember(job) {
  const id = crypto.randomBytes(8).toString('hex');
  jobs.set(id, job);
  while (jobs.size > 4) jobs.delete(jobs.keys().next().value);
  return id;
}

// ---------- Word ----------

const PARA = /<w:p(?:\s[^>]*)?(?<!\/)>[\s\S]*?<\/w:p>/g; // not <w:p/> (empty)
const TEXT = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:t\s*\/>/g;

function paragraphText(xml) {
  let out = '';
  for (const m of xml.matchAll(TEXT)) out += unescapeXml(m[1] || '');
  return out;
}

async function parseDocx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*|footnotes|endnotes)\.xml$/.test(n));
  if (!names.includes('word/document.xml')) throw new AppError('file-unreadable', 'no document.xml');
  names.sort((a, b) => (a === 'word/document.xml' ? -1 : b === 'word/document.xml' ? 1 : a.localeCompare(b)));
  const parts = [];
  const units = [];
  for (const name of names) {
    const xml = await zip.file(name).async('string');
    const paras = [];
    for (const m of xml.matchAll(PARA)) {
      const body = m[0];
      // A paragraph holding another one (a text box) is left as it is.
      if (/<w:p[\s>]/.test(body.slice(4))) continue;
      const text = paragraphText(body);
      if (!LETTER.test(text)) continue;
      paras.push({ start: m.index, end: m.index + body.length, unit: units.length });
      units.push(text);
    }
    parts.push({ name, xml, paras });
  }
  return { job: { kind: 'docx', zip, parts }, units };
}

// Word checks the order of these elements (ECMA-376 CT_PPr / CT_RPr), so
// w:bidi and w:rtl go before the first element that must follow them.
const AFTER_BIDI = ['adjustRightInd', 'snapToGrid', 'spacing', 'ind', 'contextualSpacing', 'mirrorIndents', 'suppressOverlap', 'jc', 'textDirection', 'textAlignment', 'textboxTightWrap', 'outlineLvl', 'divId', 'cnfStyle', 'rPr', 'sectPr', 'pPrChange'];
const AFTER_RTL = ['cs', 'em', 'lang', 'eastAsianLayout', 'specVanish', 'oMath', 'rPrChange'];

function insertOrdered(inner, tag, after) {
  const re = new RegExp(`<w:(${after.join('|')})[\\s/>]`);
  const m = re.exec(inner);
  return m ? `${inner.slice(0, m.index)}<w:${tag}/>${inner.slice(m.index)}` : `${inner}<w:${tag}/>`;
}

function setDirection(body, rtl) {
  let out = body.replace(/<w:bidi(?:\s+w:val="[^"]*")?\s*\/>/g, '').replace(/<w:rtl(?:\s+w:val="[^"]*")?\s*\/>/g, '');
  if (!rtl) return out;
  // The paragraph: w:bidi in its pPr (made when missing; pPr is the first child).
  if (/<w:pPr\s*\/>/.test(out)) out = out.replace(/<w:pPr\s*\/>/, '<w:pPr></w:pPr>');
  if (!/<w:pPr>/.test(out)) out = out.replace(/^(<w:p\b[^>]*>)/, '$1<w:pPr></w:pPr>');
  out = out.replace(/<w:pPr>([\s\S]*?)<\/w:pPr>/, (_m, inner) => `<w:pPr>${insertOrdered(inner, 'bidi', AFTER_BIDI)}</w:pPr>`);
  // Each run: w:rtl in its rPr (rPr is the run's first child).
  out = out.replace(/<w:r>(?!<w:rPr>)|<w:r\s[^>]*>(?!<w:rPr>)/g, (m) => `${m}<w:rPr></w:rPr>`);
  out = out.replace(/<w:rPr\s*\/>/g, '<w:rPr></w:rPr>');
  out = out.replace(/<w:rPr>([\s\S]*?)<\/w:rPr>/g, (_m, inner) => `<w:rPr>${insertOrdered(inner, 'rtl', AFTER_RTL)}</w:rPr>`);
  return out;
}

function translateParagraph(body, text, rtl) {
  let first = true;
  let out = body.replace(TEXT, () => {
    if (!first) return '<w:t></w:t>';
    first = false;
    return `<w:t xml:space="preserve">${escapeXml(text)}</w:t>`;
  });
  // The tabs and line breaks of the original would land in odd places.
  out = out.replace(/<w:tab\s*\/>/g, '').replace(/<w:br\s*\/>/g, '');
  return setDirection(out, rtl);
}

async function buildDocx(job, translations, rtl) {
  for (const part of job.parts) {
    let xml = part.xml;
    for (const p of [...part.paras].reverse()) {
      const t = translations[p.unit];
      if (typeof t !== 'string' || !t.trim()) continue;
      xml = xml.slice(0, p.start) + translateParagraph(xml.slice(p.start, p.end), t.trim(), rtl) + xml.slice(p.end);
    }
    job.zip.file(part.name, xml);
  }
  return job.zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ---------- PDF ----------

// Lines of a page into paragraphs: a paragraph ends at a blank line, after a
// line that ends a sentence, or after a clearly short line.
function paragraphs(pageText) {
  const lines = String(pageText || '').split('\n').map((l) => l.trim());
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const out = [];
  let cur = [];
  const flush = () => {
    if (cur.length) out.push(cur.join(' '));
    cur = [];
  };
  for (const line of lines) {
    if (!line) {
      flush();
      continue;
    }
    cur.push(line);
    if (/[.!?؟:։。]$/.test(line) || line.length < longest * 0.6) flush();
  }
  flush();
  return out.filter((p) => LETTER.test(p));
}

async function parsePdf(bytes) {
  const res = await runWorker('pdf', bytes);
  let pages = Array.isArray(res.pageTexts) ? res.pageTexts : [String(res.text || '')];
  if (!pages.join('').trim() && Array.isArray(res.images) && res.images.length) {
    pages = [];
    for (const img of res.images) pages.push(await ocr.recognize(Buffer.from(img), '.bmp').catch(() => ''));
  }
  const units = [];
  const layout = pages.map((p) => paragraphs(p).map((text) => units.push(text) - 1));
  if (!units.length) throw new AppError('file-no-text');
  return { job: { kind: 'pdf', layout }, units };
}

async function buildPdf(job, translations, rtl, lang) {
  const body = job.layout
    .map((page) => `<section>${page.map((u) => `<p>${escapeHtml(String(translations[u] || '').trim())}</p>`).join('')}</section>`)
    .join('');
  const css = `@page { margin: 18mm 16mm; } body { font-family: 'Segoe UI', Tahoma, Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; } section { page-break-after: always; } section:last-child { page-break-after: auto; } p { margin: 0 0 8pt; }`;
  const tmp = path.join(os.tmpdir(), `blazma-translate-${crypto.randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(tmp, `<!doctype html><html lang="${lang}" dir="${rtl ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>${css}</style></head><body>${body}</body></html>`, 'utf8');
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await printer.loadFile(tmp);
    return await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
  } finally {
    printer.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

// ---------- API ----------

async function parse(name, bytes) {
  const fileName = String(name || '').slice(0, 200);
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (!data.byteLength) throw new AppError('file-empty');
  if (data.byteLength > MAX_BYTES) throw new AppError('file-too-big', String(data.byteLength));
  let parsed;
  if (/\.docx$/i.test(fileName)) parsed = await parseDocx(data);
  else if (/\.pdf$/i.test(fileName)) parsed = await parsePdf(data);
  else throw new AppError('file-unsupported', fileName);
  if (parsed.units.length > MAX_UNITS) throw new AppError('file-too-big', `${parsed.units.length} paragraphs`);
  if (!parsed.units.length) throw new AppError('file-no-text');
  parsed.job.name = fileName;
  return { id: remember(parsed.job), kind: parsed.job.kind, units: parsed.units };
}

// lang: the target language code (ar, en, fr…), suffix: its name for the file.
async function build(win, id, translations, lang, suffix) {
  const job = jobs.get(String(id));
  if (!job) throw new AppError('file-unreadable', 'expired');
  const list = Array.isArray(translations) ? translations.map((t) => (typeof t === 'string' ? t.slice(0, 20000) : '')) : [];
  const code = /^[a-z]{2}$/.test(lang) ? lang : 'ar';
  const rtl = RTL_LANGS.has(code);
  const ext = job.kind === 'docx' ? 'docx' : 'pdf';
  const base = job.name.replace(/\.(docx|pdf)$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `${base} (${String(suffix || code).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').slice(0, 30)}).${ext}`,
    filters: [ext === 'docx' ? { name: 'Word', extensions: ['docx'] } : { name: 'PDF', extensions: ['pdf'] }],
  });
  if (canceled || !filePath) return { saved: false };
  const out = job.kind === 'docx' ? await buildDocx(job, list, rtl) : await buildPdf(job, list, rtl, code);
  fs.writeFileSync(filePath, out);
  jobs.delete(String(id));
  return { saved: true, path: filePath };
}

function reveal(file) {
  if (typeof file === 'string' && fs.existsSync(file)) shell.showItemInFolder(file);
}

module.exports = { parse, build, reveal, paragraphs, parseDocx, buildDocx };
