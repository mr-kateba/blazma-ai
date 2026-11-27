'use strict';

// The quick assistant: a global shortcut (Alt+Space by default) copies the
// text selected in whatever app is in front, then opens a small window with
// translate / explain / fix / summarise / rephrase and a free question.
// The answer comes from the same local model as the chat.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { BrowserWindow, clipboard, ClipboardItem, desktopCapturer, globalShortcut, screen, nativeTheme } = require('electron');
const settings = require('./settings');
const { APP_ORIGIN } = require('./protocol');

let win = null;
let helper = null;
let helperWaiters = [];
let registered = {}; // shortcut kind (text | screen) -> accelerator
let context = { text: '' };

// One PowerShell process, started once: waits until the shortcut's keys are
// released, then sends Ctrl+C ("copy") or Ctrl+V ("paste") to the app in front.
const HELPER = `
Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'
Add-Type -AssemblyName System.Windows.Forms
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $t = 0
  while ($t -lt 60 -and ((([W.K]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x5B) -band 0x8000) -ne 0))) { Start-Sleep -Milliseconds 15; $t++ }
  if ($l -eq 'paste') { [System.Windows.Forms.SendKeys]::SendWait('^v') } else { [System.Windows.Forms.SendKeys]::SendWait('^c') }
  [Console]::Out.WriteLine('ok'); [Console]::Out.Flush()
}`;

function startHelper() {
  if (helper || process.platform !== 'win32') return;
  const encoded = Buffer.from(HELPER, 'utf16le').toString('base64');
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  helper.stdout.on('data', (d) => {
    for (const _ of String(d).split('\n').filter((l) => l.trim() === 'ok')) {
      const w = helperWaiters.shift();
      if (w) w();
    }
  });
  helper.on('exit', () => {
    helper = null;
    helperWaiters.splice(0).forEach((w) => w());
  });
}

function sendKeys(what = 'copy') {
  return new Promise((resolve) => {
    if (!helper) return resolve();
    const t = setTimeout(resolve, 1500);
    helperWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
    helper.stdin.write(`${what}\n`);
  });
}

// The selected text, without leaving it on the clipboard. Electron 44's
// clipboard is async (read/write ClipboardItem, readText/writeText promises).
async function snapshot() {
  try {
    const items = await clipboard.read();
    return await Promise.all(items.map(async (item) => {
      const data = {};
      for (const type of item.types) {
        try { data[type] = await item.getType(type); } catch { /* format gone */ }
      }
      return data;
    }));
  } catch {
    return null;
  }
}

async function restore(saved) {
  try {
    const items = (saved || []).filter((d) => Object.keys(d).length).map((d) => new ClipboardItem(d));
    if (items.length) await clipboard.write(items);
    else clipboard.clear();
  } catch { /* leave the clipboard as it is */ }
}

async function grabSelection() {
  const saved = await snapshot();
  const marker = `\u2063blazma-${Date.now()}`;
  await clipboard.writeText(marker);
  await sendKeys('copy');
  let text = '';
  for (let i = 0; i < 10; i++) {
    text = await clipboard.readText();
    if (text !== marker) break;
    await new Promise((r) => setTimeout(r, 40));
  }
  if (text === marker) text = '';
  await restore(saved);
  return String(text || '').trim().slice(0, 20000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 520,
    minWidth: 420,
    minHeight: 300,
    show: false,
    frame: false,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1014' : '#f5f6f8',
    title: 'Blazma AI',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.on('blur', () => win && !win.webContents.isDevToolsOpened() && win.hide());
  win.on('closed', () => (win = null));
  win.loadURL(`${APP_ORIGIN}/quick.html`);
}

// The window opens even when copying the selection fails (empty text).
async function open() {
  let text = '';
  try {
    text = await grabSelection();
  } catch (err) {
    require('./crashlog').write('quick assistant: selection', err);
  }
  return openWith(text);
}

// The screen under the mouse as a JPEG data URL, at most 1600 px wide (the
// model sees pictures smaller than that anyway).
async function captureScreen() {
  const point = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(point);
  const scale = display.scaleFactor || 1;
  const size = { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const src = sources.find((x) => x.display_id === String(display.id)) || sources[0];
  if (!src || src.thumbnail.isEmpty()) throw new Error('no screen picture');
  let img = src.thumbnail;
  if (img.getSize().width > 1600) img = img.resize({ width: 1600, quality: 'best' });
  return `data:image/jpeg;base64,${img.toJPEG(85).toString('base64')}`;
}

async function openScreen() {
  if (win && win.isVisible()) {
    win.hide();
    await new Promise((r) => setTimeout(r, 150));
  }
  let image = '';
  try {
    image = await captureScreen();
  } catch (err) {
    require('./crashlog').write('quick assistant: screen', err);
  }
  return openWith('', image);
}

// Puts the answer in place of the selected text in the app it came from:
// the window hides (Windows gives the focus back to that app), the answer
// goes on the clipboard, Ctrl+V is sent, and the clipboard is put back.
async function replaceSelection(text) {
  const value = String(text || '');
  if (!value || !context.text || !helper) return false;
  hide();
  await new Promise((r) => setTimeout(r, 200));
  const saved = await snapshot();
  await clipboard.writeText(value);
  await sendKeys('paste');
  await new Promise((r) => setTimeout(r, 400));
  await restore(saved);
  return true;
}

// Shows the window with this text (open() passes the selection; tests pass text).
function openWith(text, image = '') {
  context = { text: String(text || ''), image: /^data:image\/(png|jpeg);base64,/.test(image) ? image : '', at: Date.now() };
  if (!win) createWindow();
  const p = screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(p).workArea;
  const [w, h] = win.getSize();
  win.setPosition(Math.round(Math.min(Math.max(p.x - w / 2, area.x + 8), area.x + area.width - w - 8)), Math.round(Math.min(Math.max(p.y + 16, area.y + 8), area.y + area.height - h - 8)));
  // The page asks for the context when it loads (quick:context), and is told
  // again here when it is already open.
  if (!win.webContents.isLoading()) win.webContents.send('quick:context', context);
  win.show();
  win.focus();
}

// "يا بلازما" (wake.js): the window shows what was heard and answers aloud,
// in the corner of the screen and without taking the focus from the game or
// program in front. It hides itself after the answer.
function openVoice(heard) {
  context = { text: '', image: '', voice: String(heard || '').slice(0, 2000), at: Date.now() };
  if (!win) createWindow();
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = win.getSize();
  win.setPosition(area.x + area.width - w - 16, area.y + area.height - h - 16);
  if (!win.webContents.isLoading()) win.webContents.send('quick:context', context);
  win.showInactive();
}

const ACTIONS = { text: () => open(), screen: () => openScreen() };
const SETTING = { text: 'quickKey', screen: 'quickScreenKey' };

function register(key, kind = 'text') {
  if (registered[kind]) globalShortcut.unregister(registered[kind]);
  delete registered[kind];
  if (!key) return true;
  const ok = globalShortcut.register(key, () => ACTIONS[kind]().catch((err) => require('./crashlog').write('quick assistant', err)));
  if (ok) registered[kind] = key;
  return ok;
}

function apply() {
  const s = settings.get();
  if (s.quickEnabled) {
    startHelper();
    const a = register(s.quickKey, 'text');
    const b = register(s.quickScreenKey, 'screen');
    return a && b;
  }
  register(null, 'text');
  register(null, 'screen');
  return true;
}

// kind: text (the selection) or screen (a picture of the screen).
function setKey(key, kind = 'text') {
  const name = SETTING[kind];
  if (!name) return false;
  const other = kind === 'text' ? settings.get().quickScreenKey : settings.get().quickKey;
  if (key && key === other) return false;
  const old = settings.get()[name];
  if (!register(key, kind)) {
    register(settings.get().quickEnabled ? old : null, kind);
    return false;
  }
  settings.update({ [name]: key });
  if (!settings.get().quickEnabled) register(null, kind);
  return true;
}

function setEnabled(on) {
  settings.update({ quickEnabled: Boolean(on) });
  return apply();
}

function hide() {
  if (win) win.hide();
}

function stop() {
  register(null, 'text');
  register(null, 'screen');
  if (helper) helper.kill();
  helper = null;
}

module.exports = { apply, setKey, setEnabled, hide, stop, open, openWith, openScreen, openVoice, captureScreen, replaceSelection, getContext: () => context };
