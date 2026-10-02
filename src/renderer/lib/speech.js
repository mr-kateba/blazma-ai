// Reads a reply aloud, with one of two voices:
// - Blazma's own Arabic voice (Piper on this computer, main/tts.js), which
//   works on any Windows once downloaded;
// - the voices installed in Windows (Web Speech API, offline). Arabic text
//   needs an Arabic voice, which Windows adds with the Arabic speech pack.
// settings.ttsEngine: 'auto' (Blazma's voice for Arabic when it is there,
// Windows otherwise), 'blazma' or 'windows'.

import { detectDir } from './dom.js';

let speaking = null; // the button of the reply being read
let session = null; // Blazma voice playback: { ctx, source, stopped }

// Markdown to plain sentences: no code blocks, links read by their text.
function plain(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|#]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pieces of about `max` characters, cut after a sentence where possible, so
// the first piece is spoken while the next one is being made.
export function pieces(text, max = 350) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    const part = rest.slice(0, max);
    const cut = Math.max(part.lastIndexOf('. '), part.lastIndexOf('؟ '), part.lastIndexOf('? '), part.lastIndexOf('! '), part.lastIndexOf('، '), part.lastIndexOf('؛ '));
    const at = cut > max * 0.4 ? cut + 1 : part.lastIndexOf(' ') > 0 ? part.lastIndexOf(' ') : max;
    out.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) out.push(rest);
  return out;
}

function voices() {
  return new Promise((resolve) => {
    const list = speechSynthesis.getVoices();
    if (list.length) return resolve(list);
    // Voices load asynchronously the first time.
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1500);
  });
}

function finished(button) {
  if (speaking === button) {
    speaking = null;
    button.dispatchEvent(new Event('speech-end'));
  }
}

// Whether this button's reply is being read now.
export const isSpeaking = (button) => speaking === button;

export function stopSpeaking() {
  speechSynthesis.cancel();
  if (session) {
    session.stopped = true;
    try {
      if (session.source) session.source.stop();
    } catch {
      /* already stopped */
    }
    session.ctx.close().catch(() => {});
    session = null;
  }
  if (speaking) speaking.dispatchEvent(new Event('speech-end'));
  speaking = null;
}

async function speakWindows(clean, arabic, button) {
  const list = await voices();
  const voice = arabic ? list.find((v) => /^ar\b/i.test(v.lang)) : list.find((v) => v.default) || list[0];
  if (!voice) return { ok: false, reason: arabic ? 'no-arabic-voice' : 'no-voice' };
  const u = new SpeechSynthesisUtterance(clean);
  u.voice = voice;
  u.lang = voice.lang;
  u.onend = u.onerror = () => finished(button);
  speaking = button;
  speechSynthesis.speak(u);
  return { ok: true };
}

// Blazma's voice: each piece is made in the main process (WAV bytes) and
// played with Web Audio, one after the other.
async function speakBlazma(clean, button) {
  const ctx = new AudioContext();
  const me = { ctx, source: null, stopped: false };
  session = me;
  speaking = button;
  const parts = pieces(clean);
  let next = window.blazma.ttsSynth(parts[0]);
  for (let i = 0; i < parts.length; i++) {
    const res = await next;
    if (me.stopped) return { ok: true };
    if (i + 1 < parts.length) next = window.blazma.ttsSynth(parts[i + 1]); // made while this one plays
    if (!res.ok) {
      stopSpeaking();
      return { ok: false, reason: 'blazma-failed' };
    }
    if (!res.result || !res.result.length) continue;
    const bytes = res.result;
    const audio = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    if (me.stopped) return { ok: true };
    await new Promise((resolve) => {
      const source = ctx.createBufferSource();
      source.buffer = audio;
      source.connect(ctx.destination);
      source.onended = resolve;
      me.source = source;
      source.start();
    });
    if (me.stopped) return { ok: true };
  }
  if (session === me) {
    session = null;
    ctx.close().catch(() => {});
  }
  finished(button);
  return { ok: true };
}

// Returns { ok } or { ok: false, reason: 'no-arabic-voice' | 'no-voice' |
// 'offer-blazma' (Blazma's voice would read it but is not downloaded) |
// 'blazma-failed' }. Resolves when reading has started (Windows) or ended
// (Blazma's voice); the button gets 'speech-end' when it stops.
export async function speak(text, button) {
  if (speaking === button) {
    stopSpeaking();
    return { ok: true };
  }
  stopSpeaking();
  const clean = plain(text);
  if (!clean) return { ok: true };
  const arabic = detectDir(clean) === 'rtl';
  const [{ ttsEngine = 'auto' }, tts] = await Promise.all([window.blazma.getSettings(), window.blazma.ttsStatus()]);
  if (ttsEngine === 'windows') return speakWindows(clean, arabic, button);
  if (tts.installed && (ttsEngine === 'blazma' || arabic)) {
    speakBlazma(clean, button).then((res) => {
      if (!res.ok) button.dispatchEvent(new CustomEvent('speech-error', { detail: res.reason }));
    });
    return { ok: true };
  }
  if (ttsEngine === 'blazma') return { ok: false, reason: 'offer-blazma' };
  const res = await speakWindows(clean, arabic, button);
  return !res.ok && arabic ? { ok: false, reason: 'offer-blazma' } : res;
}
