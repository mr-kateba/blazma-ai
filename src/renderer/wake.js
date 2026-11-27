// "يا بلازما": a hidden window that listens to the microphone (main/wake.js).
// A simple voice detector cuts the sound into utterances (speech between
// pauses); each one goes to the main process, which reads it with whisper.cpp
// and looks for the wake word. Nothing is kept or sent anywhere.

import { toWav } from './lib/media.js';

const RATE = 16000;
const FRAME = 1024; // 64 ms
const PRE = 5; // frames kept from before the speech started
const START = 3; // loud frames to start
const END_QUIET = 12; // quiet frames (~0.8 s) to end
const MIN_FRAMES = 6; // ~0.4 s
const MAX_FRAMES = { wake: 110, command: 160 }; // ~7 s / ~10 s

let mode = 'wake'; // 'wake' | 'command' (after the wake word alone)
let paused = false;
let busy = false;

function beep(ctx, up = true) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.frequency.setValueAtTime(up ? 660 : 520, ctx.currentTime);
  o.frequency.linearRampToValueAtTime(up ? 990 : 380, ctx.currentTime + 0.15);
  g.gain.setValueAtTime(0.0001, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.22);
  o.connect(g).connect(ctx.destination);
  o.start();
  o.stop(ctx.currentTime + 0.25);
}

async function main() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const ctx = new AudioContext({ sampleRate: RATE });
  const src = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(FRAME, 1, 1);
  const mute = ctx.createGain();
  mute.gain.value = 0;
  src.connect(proc);
  proc.connect(mute).connect(ctx.destination);

  let floor = 0.004;
  let ring = [];
  let speech = null; // frames of the utterance
  let loud = 0;
  let quiet = 0;
  let commandUntil = 0;

  window.blazma.onWakeCommand((m) => {
    if (m === 'pause') paused = true;
    else if (m === 'resume') paused = false;
  });

  proc.onaudioprocess = async (e) => {
    const data = new Float32Array(e.inputBuffer.getChannelData(0));
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i] * data[i];
    const rms = Math.sqrt(sum / data.length);
    if (mode === 'command' && Date.now() > commandUntil && !speech) mode = 'wake';
    if (paused) {
      speech = null;
      ring = [];
      return;
    }
    const threshold = Math.max(floor * 3.5, 0.012);
    if (!speech) {
      ring.push(data);
      if (ring.length > PRE) ring.shift();
      if (rms > threshold) loud++;
      else {
        loud = 0;
        floor = floor * 0.97 + rms * 0.03; // the room's own noise
      }
      if (loud >= START) {
        speech = [...ring];
        quiet = 0;
      }
      return;
    }
    speech.push(data);
    quiet = rms < threshold * 0.6 ? quiet + 1 : 0;
    if (quiet < END_QUIET && speech.length < MAX_FRAMES[mode]) return;
    const frames = speech;
    speech = null;
    loud = 0;
    if (frames.length - quiet < MIN_FRAMES || busy) return;
    const pcm = new Float32Array(frames.length * FRAME);
    frames.forEach((f, i) => pcm.set(f, i * FRAME));
    busy = true;
    try {
      const res = await window.blazma.wakeHeard(toWav(pcm), mode);
      if (res && res.listen) {
        beep(ctx, true);
        mode = 'command';
        commandUntil = Date.now() + 6000;
      } else if (res && res.handled) {
        mode = 'wake';
      } else if (mode === 'command') {
        mode = 'wake';
        beep(ctx, false);
      }
    } finally {
      busy = false;
    }
  };
  window.blazma.wakeReady(true);
}

main().catch((err) => window.blazma.wakeReady(false, String((err && err.name) || err)));
