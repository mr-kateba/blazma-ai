// Reads a reply aloud with the voices installed in Windows (Web Speech API,
// offline; Chromium uses the system's speech voices). Arabic text needs an
// Arabic voice, which Windows adds with the Arabic speech pack.

import { detectDir } from './dom.js';

let speaking = null; // the button of the reply being read

// Markdown to plain sentences: no code blocks, links read by their text.
function plain(markdown) {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

export function stopSpeaking() {
  speechSynthesis.cancel();
  if (speaking) speaking.dispatchEvent(new Event('speech-end'));
  speaking = null;
}

// Returns { ok } or { ok: false, reason: 'no-arabic-voice' | 'no-voice' }.
export async function speak(text, button) {
  if (speaking === button) {
    stopSpeaking();
    return { ok: true };
  }
  stopSpeaking();
  const clean = plain(text);
  if (!clean) return { ok: true };
  const arabic = detectDir(clean) === 'rtl';
  const list = await voices();
  const voice = arabic ? list.find((v) => /^ar\b/i.test(v.lang)) : list.find((v) => v.default) || list[0];
  if (!voice) return { ok: false, reason: arabic ? 'no-arabic-voice' : 'no-voice' };
  const u = new SpeechSynthesisUtterance(clean);
  u.voice = voice;
  u.lang = voice.lang;
  u.onend = u.onerror = () => {
    if (speaking === button) {
      speaking = null;
      button.dispatchEvent(new Event('speech-end'));
    }
  };
  speaking = button;
  speechSynthesis.speak(u);
  return { ok: true };
}
