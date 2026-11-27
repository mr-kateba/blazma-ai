// Arabic speech-to-text check: Blazma's Arabic voice (Piper) says test
// sentences, whisper.cpp reads them back with each model and language mode.
//   electron scripts/voice-test.js
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

app.setPath('userData', process.env.BLAZMA_USER_DATA || 'D:/Dev/blazma-ai-testdata');
app.on('window-all-closed', () => {});

const SENTENCES = [
  'يا بلازما افتح متصفح كروم',
  'كم درجة الحرارة في طرابلس اليوم',
  'ذكرني أن أتصل بأحمد بعد ساعتين',
  'اكتب لي رسالة إلى المدير أطلب فيها إجازة يوم الخميس',
  'ما هي عاصمة اليابان وكم عدد سكانها',
];

const norm = (s) => String(s).replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
function wer(ref, hyp) {
  const a = norm(ref).split(' ');
  const b = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] / a.length;
}

// Piper's WAV (22.05 kHz) -> 16 kHz mono WAV, by simple linear resampling.
function to16k(wav) {
  const rate = wav.readUInt32LE(24);
  let off = 12;
  while (off < wav.length && wav.toString('latin1', off, off + 4) !== 'data') off += 8 + wav.readUInt32LE(off + 4);
  const data = wav.subarray(off + 8, off + 8 + wav.readUInt32LE(off + 4));
  const n = data.length / 2;
  const outN = Math.floor((n * 16000) / rate);
  const out = Buffer.alloc(44 + outN * 2);
  for (let i = 0; i < outN; i++) {
    const x = (i * rate) / 16000;
    const k = Math.floor(x);
    const f = x - k;
    const s0 = data.readInt16LE(Math.min(k, n - 1) * 2);
    const s1 = data.readInt16LE(Math.min(k + 1, n - 1) * 2);
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * f), 44 + i * 2);
  }
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + outN * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(16000, 24);
  out.writeUInt32LE(32000, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(outN * 2, 40);
  return out;
}

app.whenReady().then(async () => {
  try {
    const tts = require('../src/main/tts');
    const voice = require('../src/main/voice');
    const settings = require('../src/main/settings');
    if (!tts.status().installed) {
      console.log('installing Blazma voice…');
      await tts.install();
    }
    const clips = [];
    for (const s of SENTENCES) clips.push(to16k(await tts.synth(s)));
    const models = (process.env.MODELS || 'small,turbo').split(',');
    const langs = (process.env.LANGS || 'auto,ar').split(',');
    for (const model of models) {
      settings.update({ voiceModel: model });
      if (!voice.status().model) {
        console.log(`downloading ${model}…`);
        await voice.install();
      }
      for (const lang of langs) {
        process.env.BLAZMA_VOICE_LANG = lang;
        voice.stop();
        let total = 0;
        const t = Date.now();
        for (let i = 0; i < SENTENCES.length; i++) {
          const t0 = Date.now();
          const text = await voice.transcribe(clips[i]);
          const took = ((Date.now() - t0) / 1000).toFixed(1);
          const e = wer(SENTENCES[i], text);
          total += e;
          console.log(`  ${model}/${lang} ${took}s ${(e * 100).toFixed(0)}% | ${text}`);
        }
        console.log(`== ${model}/${lang}: word errors ${((total / SENTENCES.length) * 100).toFixed(0)}%  ${((Date.now() - t) / SENTENCES.length / 1000).toFixed(1)} s each`);
      }
    }
    voice.stop();
  } catch (err) {
    console.log('FAIL', err && err.stack);
  }
  app.exit(0);
});
