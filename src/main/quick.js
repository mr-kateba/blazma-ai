'use strict';

// The quick assistant: a global shortcut (Alt+Space by default) copies the
// text selected in whatever app is in front, then opens a small window with
// translate / explain / fix / summarise / rephrase and a free question.
// The answer comes from the same local model as the chat.

const path = require('node:path');
const { spawn } = require('node:child_process');
const { BrowserWindow, clipboard, ClipboardItem, globalShortcut, screen, nativeTheme } = require('electron');
const settings = require('./settings');
const { APP_ORIGIN } = require('./protocol');

let win = null;
let helper = null;
let helperWaiters = [];
let registered = null;
let context = { text: '' };

// One PowerShell process, started once: waits until the shortcut's keys are
// released, then sends Ctrl+C to the app in front.
const HELPER = `
Add-Type -Name K -Namespace W -MemberDefinition '[DllImport("user32.dll")] public static extern short GetAsyncKeyState(int k);'
Add-Type -AssemblyName System.Windows.Forms
while (($l = [Console]::In.ReadLine()) -ne $null) {
  $t = 0
  while ($t -lt 60 -and ((([W.K]::GetAsyncKeyState(0x12) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x11) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x10) -band 0x8000) -ne 0) -or (([W.K]::GetAsyncKeyState(0x5B) -band 0x8000) -ne 0))) { Start-Sleep -Milliseconds 15; $t++ }
  [System.Windows.Forms.SendKeys]::SendWait('^c')
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

function sendCopy() {
  return new Promise((resolve) => {
    if (!helper) return resolve();
    const t = setTimeout(resolve, 1500);
    helperWaiters.push(() => {
      clearTimeout(t);
      resolve();
    });
    helper.stdin.write('copy\n');
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
  await sendCopy();
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
    height: 460,
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

// Shows the window with this text (open() passes the selection; tests pass text).
function openWith(text) {
  context = { text: String(text || ''), at: Date.now() };
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

function register(key) {
  if (registered) globalShortcut.unregister(registered);
  registered = null;
  if (!key) return true;
  const ok = globalShortcut.register(key, () => open().catch((err) => require('./crashlog').write('quick assistant', err)));
  if (ok) registered = key;
  return ok;
}

function apply() {
  const s = settings.get();
  if (s.quickEnabled) {
    startHelper();
    return register(s.quickKey);
  }
  register(null);
  return true;
}

function setKey(key) {
  const old = settings.get().quickKey;
  if (!register(key)) {
    register(settings.get().quickEnabled ? old : null);
    return false;
  }
  settings.update({ quickKey: key });
  if (!settings.get().quickEnabled) register(null);
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
  register(null);
  if (helper) helper.kill();
  helper = null;
}

module.exports = { apply, setKey, setEnabled, hide, stop, open, openWith, getContext: () => context };
