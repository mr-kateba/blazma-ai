// Audio and video files for transcription: decoded by Chromium (mp3, m4a,
// wav, ogg, flac, opus, mp4, webm, mov…), mixed to 16 kHz mono and cut into
// pieces of about 10 minutes at a quiet moment, each one a 16-bit WAV that
// whisper.cpp reads without ffmpeg.

export const MEDIA_EXT = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|wma|mp4|m4v|webm|mov|mkv)$/i;
export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024; // 1 GB
export const MAX_MEDIA_SECONDS = 2 * 60 * 60; // 2 hours (the decoded sound stays in memory)

const RATE = 16000;
const PIECE = 10 * 60 * RATE; // about 10 minutes
const LOOK = 15 * RATE; // look back up to 15 s for a quiet place to cut

export function isMedia(file) {
  return /^(audio|video)\//.test(file.type || '') || MEDIA_EXT.test(file.name || '');
}

export async function decodeMedia(file) {
  const ctx = new AudioContext({ sampleRate: RATE });
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    const n = decoded.length;
    if (decoded.numberOfChannels === 1) return { pcm: decoded.getChannelData(0), seconds: n / RATE };
    const mono = new Float32Array(n);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < n; i++) mono[i] += ch[i] / decoded.numberOfChannels;
    }
    return { pcm: mono, seconds: n / RATE };
  } finally {
    ctx.close();
  }
}

// [{ start (seconds), wav (Uint8Array) }]
export function pieces(pcm) {
  const out = [];
  let at = 0;
  while (at < pcm.length) {
    let end = Math.min(pcm.length, at + PIECE);
    if (end < pcm.length) end = quietPoint(pcm, end - LOOK, end);
    out.push({ start: at / RATE, wav: toWav(pcm.subarray(at, end)) });
    at = end;
  }
  return out;
}

// The quietest 50 ms window between from and to.
function quietPoint(pcm, from, to) {
  const win = RATE / 20;
  let best = to;
  let bestEnergy = Infinity;
  for (let s = Math.max(0, from); s + win <= to; s += win) {
    let e = 0;
    for (let i = s; i < s + win; i++) e += pcm[i] * pcm[i];
    if (e < bestEnergy) {
      bestEnergy = e;
      best = s + win / 2;
    }
  }
  return Math.round(best);
}

function toWav(pcm) {
  const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  out.setUint32(4, 36 + pcm.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, RATE, true);
  out.setUint32(28, RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  str(36, 'data');
  out.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
  return new Uint8Array(out.buffer);
}

export function stamp(seconds) {
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const two = (x) => String(x).padStart(2, '0');
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`;
}
