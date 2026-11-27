// One non-streamed request to the local model, for work done behind the
// scenes (memory, research notes, plans). Thinking is off so short answers
// are not spent on reasoning.

import { visibleText } from './toolcalls.js';

// The model's recommended sampling when it has one (Gemma 4: temperature 1,
// top_k 64). Gemma at a low temperature can loop on an empty "thought" block
// and never answer; temperature is only used for models without advice.
const modelSampling = () =>
  window.blazma
    .getChatSettings()
    .then((cs) => (cs && cs.sampling) || {})
    .catch(() => ({}));

const EMPTY_THOUGHT = /<\|channel>thought\s*(?:<channel\|>)?/g;

export async function complete(messages, { maxTokens = 800, temperature = 0.3, signal, thinking = false } = {}) {
  const conn = await window.blazma.getConnection();
  if (!conn) throw Object.assign(new Error('not ready'), { code: 'not-ready' });
  const s = await modelSampling();
  const ask = async (extra) => {
    const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
      body: JSON.stringify({ messages, temperature, top_p: 0.9, ...s, ...extra, max_tokens: maxTokens, stop: ['<channel|><|channel>'], chat_template_kwargs: { enable_thinking: thinking } }),
      signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
    return visibleText(String(msg.content || '').replace(EMPTY_THOUGHT, '')).trim();
  };
  const out = await ask({});
  // Only empty thoughts: once more, with more freedom.
  return out || (await ask({ temperature: 1, top_p: 0.95, top_k: 64, seed: Math.floor(Math.random() * 1e9) }));
}

// The first JSON object in a reply (models sometimes wrap it in ``` or text).
export function readJson(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
