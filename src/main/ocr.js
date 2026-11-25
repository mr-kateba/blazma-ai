'use strict';

// Text from pictures (photos of documents, screenshots, scans) with the OCR
// that comes with Windows 10/11 (Windows.Media.Ocr), so nothing is
// downloaded. Arabic works when Windows has the Arabic language installed
// (Settings > Time & language > Language); otherwise the first language with
// OCR is used. Windows only.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { AppError } = require('./errors');

const IMAGE_EXT = /\.(png|jpe?g|bmp|gif|tiff?|webp)$/i;

// Reads every language Windows can recognise and uses Arabic and English
// when present; prints the lines found, one per line, as UTF-8.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType = WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, [Type]$t) { $task = $asTask.MakeGenericMethod($t).Invoke($null, @($op)); $task.Wait(-1) | Out-Null; $task.Result }
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($env:BLAZMA_OCR_FILE)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
$want = @($langs | Where-Object { $_.LanguageTag -like 'ar*' }) + @($langs | Where-Object { $_.LanguageTag -like 'en*' })
if (-not $want.Count) { $want = @($langs) }
if (-not $want.Count) { Write-Output '__NO_OCR__'; exit 0 }
$best = ''
foreach ($l in $want | Select-Object -First 2) {
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l)
  if (-not $engine) { continue }
  $res = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  # Windows gives the words of a line from left to right; an Arabic line is
  # read from right to left, so its words are put back in reading order.
  $text = ($res.Lines | ForEach-Object {
    $w = @($_.Words | ForEach-Object { $_.Text })
    if ($_.Text -match '[\u0600-\u06FF]') { [array]::Reverse($w) }
    $w -join ' '
  }) -join "\`n"
  if ($text.Length -gt $best.Length) { $best = $text }
}
Write-Output $best
`;

const isImage = (name) => IMAGE_EXT.test(String(name || ''));

function run(file) {
  return new Promise((resolve, reject) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
      { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, BLAZMA_OCR_FILE: file } },
      (err, stdout) => (err ? reject(new AppError('file-unreadable', `ocr: ${err.message.slice(0, 200)}`)) : resolve(String(stdout || ''))),
    );
  });
}

// bytes: the picture. Returns the text found (may be empty).
async function recognize(bytes, ext = '.png') {
  if (process.platform !== 'win32') throw new AppError('file-unsupported', 'ocr');
  const tmp = path.join(os.tmpdir(), `blazma-ocr-${crypto.randomBytes(6).toString('hex')}${ext}`);
  fs.writeFileSync(tmp, bytes);
  try {
    const out = (await run(tmp)).trim();
    if (out === '__NO_OCR__') throw new AppError('file-no-text', 'no OCR language in Windows');
    return out;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

module.exports = { recognize, isImage, IMAGE_EXT };
