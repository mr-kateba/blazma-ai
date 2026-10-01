'use strict';

// "تصدير المحادثة": saves the open chat as Markdown, or as PDF printed from
// HTML the renderer built (its own escaped markdown output). The PDF is
// printed in a hidden window with JavaScript disabled, from a temporary file.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { BrowserWindow, dialog } = require('electron');

const safeName = (title) => String(title || 'محادثة').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'محادثة';

const PDF_CSS = `
  @page { margin: 18mm 16mm; }
  body { font-family: 'Segoe UI', Tahoma, 'Noto Naskh Arabic', 'Noto Sans Arabic', Arial, sans-serif; font-size: 12pt; line-height: 1.8; color: #111; direction: rtl; }
  h1 { font-size: 18pt; margin: 0 0 4pt; }
  .meta { color: #666; font-size: 9.5pt; margin-bottom: 14pt; }
  .msg { margin: 0 0 12pt; padding: 8pt 12pt; border-radius: 6pt; page-break-inside: avoid; }
  .msg.user { background: #f1f4fa; border: 1px solid #dde3ee; }
  .msg.assistant { border-inline-start: 3pt solid #5b8cff; }
  .who { font-weight: 700; font-size: 10pt; color: #44506a; margin-bottom: 2pt; }
  pre { direction: ltr; text-align: left; background: #f6f8fa; border: 1px solid #e1e4e8; border-radius: 4pt; padding: 8pt; white-space: pre-wrap; word-break: break-word; font-size: 10pt; }
  code { font-family: Consolas, 'Courier New', monospace; }
  img { max-width: 60%; border-radius: 4pt; }
  table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 3pt 6pt; }
  .files { color: #555; font-size: 10pt; }
  button, .md-code-head { display: none !important; }
`;

async function exportChat(win, { title, format, markdown, html }) {
  const ext = format === 'pdf' ? 'pdf' : 'md';
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'تصدير المحادثة',
    defaultPath: `${safeName(title)}.${ext}`,
    filters: [format === 'pdf' ? { name: 'PDF', extensions: ['pdf'] } : { name: 'Markdown', extensions: ['md'] }],
  });
  if (canceled || !filePath) return { saved: false };
  if (format !== 'pdf') {
    fs.writeFileSync(filePath, String(markdown || ''), 'utf8');
    return { saved: true };
  }
  const tmp = path.join(os.tmpdir(), `blazma-export-${crypto.randomBytes(6).toString('hex')}.html`);
  fs.writeFileSync(tmp, `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><style>${PDF_CSS}</style></head><body>${String(html || '')}</body></html>`, 'utf8');
  const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await printer.loadFile(tmp);
    const pdf = await printer.webContents.printToPDF({ printBackground: true, pageSize: 'A4' });
    fs.writeFileSync(filePath, pdf);
  } finally {
    printer.destroy();
    fs.rmSync(tmp, { force: true });
  }
  return { saved: true };
}

module.exports = { exportChat };
