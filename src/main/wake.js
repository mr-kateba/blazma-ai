'use strict';

// "يا بلازما": while turned on, a hidden window (renderer/wake.js) listens to
// the microphone and sends each utterance here. whisper.cpp (voice.js) reads
// it; when it starts with the wake word ("يا بلازما", "بلازما", "Hey
// Blazma"), the rest is the request: the quick assistant window opens
// without taking the focus, answers in a few spoken sentences and can open
// programs and files (quick.js voice mode). "يا بلازما" alone: a short tone,
// then the next sentence is the request.

const path = require('node:path');
const { BrowserWindow } = require('electron');
const settings = require('./settings');
const { APP_ORIGIN } = require('./protocol');

let win = null;
let state = { listening: false, error: null };
let onChange = () => {};
let lastHeard = '';

// Spellings whisper writes for the wake word, Arabic and Latin.
const WAKE = /^(?:\s*(?:يا|ياه|هاي|hey|hi|ok|okay|اوكي|أوكي)[\s,،]*)?(?:بلازما|بلازمة|بلازمه|بلاسما|بلاسمه|بلازم|بلزما|blazma|blasma|plasma|plazma)(?=$|[\s,،.!؟?])[\s,،.!؟?]*/i;

function strip(text) {
  return String(text || '')
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/^[\s"'«(\-–—.…]+/, '')
    .trim();
}

// { wake, rest } for one utterance.
function match(text) {
  const t = strip(text);
  // The wake word may come after a word or two of noise ("آه يا بلازما").
  const words = t.split(/\s+/);
  for (let skip = 0; skip <= 2 && skip < words.length; skip++) {
    const part = words.slice(skip).join(' ');
    const m = WAKE.exec(part);
    if (m) return { wake: true, rest: part.slice(m[0].length).replace(/^[\s,،.]+/, '').trim() };
  }
  return { wake: false, rest: '' };
}

function set(patch) {
  state = { ...state, ...patch };
  onChange(state);
}

function start(notify) {
  if (notify) onChange = notify;
  if (!settings.get().wakeEnabled) return stop();
  const voice = require('./voice');
  if (!voice.status().program || !voice.status().model) return set({ listening: false, error: 'voice-missing' });
  if (win) return;
  win = new BrowserWindow({
    show: false,
    width: 200,
    height: 100,
    skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
  });
  win.on('closed', () => {
    win = null;
    set({ listening: false });
  });
  win.loadURL(`${APP_ORIGIN}/wake.html`);
}

function stop() {
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  set({ listening: false });
}

function ready(ok, error) {
  set({ listening: Boolean(ok), error: ok ? null : error || 'mic-failed' });
}

// The wake window pauses while the answer is spoken (so it does not hear itself).
function pause(on) {
  if (win && !win.isDestroyed()) win.webContents.send('wake:command', on ? 'pause' : 'resume');
}

// One utterance (16 kHz WAV). mode: 'wake' or 'command' (after the wake word alone).
async function heard(wav, mode) {
  const voice = require('./voice');
  let text = '';
  try {
    // In the spoken language first; when the wake word is not there, once
    // more with the language detected ("Hey Blazma" in English is otherwise
    // translated into Arabic and the name is lost). No prompt with the name:
    // whisper repeats a prompt on unclear sound, which would wake it by itself.
    text = await voice.transcribe(wav);
    if (mode === 'wake' && !match(text).wake) {
      const again = await voice.transcribe(wav, { lang: 'auto' });
      if (match(again).wake) text = again;
    }
  } catch {
    return { handled: false };
  }
  lastHeard = text;
  if (mode === 'command') {
    const t = strip(text);
    if (t.length < 2 || /^\[.*\]$|^\(.*\)$/.test(t)) return { handled: false };
    command(match(t).wake ? match(t).rest || t : t);
    return { handled: true };
  }
  const m = match(text);
  if (!m.wake) return { handled: false };
  if (m.rest.length >= 2) {
    command(m.rest);
    return { handled: true };
  }
  return { listen: true };
}

// The last requests (not other speech), for "what did it hear?" when
// something goes wrong: <userData>/voice-log.txt, newest 100 lines.
function note(line) {
  try {
    const fs = require('node:fs');
    const file = path.join(require('./paths').userData(), 'voice-log.txt');
    const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).slice(-99) : [];
    fs.writeFileSync(file, [...old, `${new Date().toISOString()} ${line}`].join('\n') + '\n');
  } catch {}
}

function command(text) {
  note(`heard: ${lastHeard} -> request: ${text}`);
  pause(true);
  setTimeout(() => pause(false), 45000); // in case the answer never says it ended
  require('./quick').openVoice(text);
}

const status = () => ({ enabled: Boolean(settings.get().wakeEnabled), ...state, lastHeard });

module.exports = { start, stop, ready, heard, pause, match, status };
