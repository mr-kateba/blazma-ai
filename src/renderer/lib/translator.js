// Translation of many pieces of text (the paragraphs of a file) with the
// local model: pieces are sent in batches, each marked ⟦n⟧, and any piece
// missing from the answer is translated again on its own.

import { visibleText } from './toolcalls.js';

export const LANGS = [
  ['ar', 'العربية', 'Arabic'],
  ['en', 'English', 'English'],
  ['fr', 'Français', 'French'],
  ['es', 'Español', 'Spanish'],
  ['de', 'Deutsch', 'German'],
  ['it', 'Italiano', 'Italian'],
  ['tr', 'Türkçe', 'Turkish'],
  ['ru', 'Русский', 'Russian'],
  ['zh', '中文', 'Chinese (Simplified)'],
  ['fa', 'فارسی', 'Persian'],
  ['ur', 'اردو', 'Urdu'],
];

const BATCH_CHARS = 1800;
const BATCH_UNITS = 25;

async function complete(conn, messages, signal, maxTokens) {
  const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify({ messages, temperature: 0.2, top_p: 0.9, max_tokens: maxTokens, chat_template_kwargs: { enable_thinking: false } }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return visibleText(String((j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '')).trim();
}

function batches(units) {
  const out = [];
  let cur = [];
  let size = 0;
  units.forEach((text, i) => {
    if (cur.length && (size + text.length > BATCH_CHARS || cur.length >= BATCH_UNITS)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(i);
    size += text.length;
  });
  if (cur.length) out.push(cur);
  return out;
}

// units: strings; lang: an English language name. Returns the translations
// in the same order. onProgress(done, total).
export async function translateUnits(units, lang, { onProgress = () => {}, signal } = {}) {
  const conn = await window.blazma.getConnection();
  if (!conn) throw Object.assign(new Error('not ready'), { code: 'not-ready' });
  const out = new Array(units.length).fill('');
  const system = `You are a professional translator. Translate every segment into ${lang}. Each segment starts with a marker such as ⟦3⟧. Write every marker exactly once, in the same order, each followed only by the translation of its segment. Keep numbers, names, links, code and line structure. Do not add notes or explanations.`;
  let done = 0;
  for (const group of batches(units)) {
    if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
    const text = group.map((i) => `⟦${i + 1}⟧ ${units[i]}`).join('\n');
    const size = group.reduce((s, i) => s + units[i].length, 0);
    let answer = '';
    try {
      answer = await complete(conn, [{ role: 'system', content: system }, { role: 'user', content: text }], signal, Math.min(6000, 400 + size * 2));
    } catch (err) {
      if (err.name === 'AbortError') throw err;
    }
    for (const m of answer.matchAll(/⟦(\d+)⟧([\s\S]*?)(?=⟦\d+⟧|$)/g)) {
      const i = Number(m[1]) - 1;
      if (group.includes(i)) out[i] = m[2].trim();
    }
    for (const i of group) {
      if (out[i]) continue;
      if (signal && signal.aborted) throw new DOMException('aborted', 'AbortError');
      try {
        out[i] = await complete(conn, [{ role: 'system', content: `You are a professional translator. Translate the user's text into ${lang}. Output only the translation.` }, { role: 'user', content: units[i] }], signal, Math.min(4000, 300 + units[i].length * 2));
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        out[i] = units[i]; // left as it was
      }
    }
    done += group.length;
    onProgress(done, units.length);
  }
  return out;
}

// Mostly Arabic letters -> the usual target is English, otherwise Arabic.
export function defaultTarget(units) {
  const sample = units.slice(0, 40).join(' ');
  const ar = (sample.match(/[\u0600-\u06FF]/g) || []).length;
  const latin = (sample.match(/[A-Za-z]/g) || []).length;
  return ar > latin ? 'en' : 'ar';
}
