// Tool calls that reach us as text instead of as tool_calls. llama-server
// turns a model's own tool-call syntax into tool_calls, but when it cannot
// (for example a second call in one reply, or a call after some text) the
// raw syntax ends up in the content, the tool never runs and the assistant
// stops. Two syntaxes are read here:
// - Gemma 4: <|tool_call>call:NAME{key:<|"|>text<|"|>,n:1}<tool_call|>
//   (keys unquoted, strings between <|"|>, as in llama.cpp's
//   common/parsers/gemma4.cpp);
// - Hermes/Qwen style: <tool_call>{"name": "...", "arguments": {...}}</tool_call>.

const GEMMA_OPEN = '<|tool_call>call:';
const GEMMA_CLOSE = '<tool_call|>';
const Q = '<|"|>';

// A Gemma 4 value starting at s[i]; returns [value, nextIndex].
function gemmaValue(s, i) {
  while (/\s/.test(s[i] || '')) i++;
  if (s.startsWith(Q, i)) {
    const end = s.indexOf(Q, i + Q.length);
    if (end < 0) throw new Error('unterminated string');
    return [s.slice(i + Q.length, end), end + Q.length];
  }
  if (s[i] === '"') {
    // Plain JSON string, in case the model used normal quotes.
    let j = i + 1;
    while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
    return [JSON.parse(s.slice(i, j + 1)), j + 1];
  }
  if (s[i] === '{') {
    const obj = {};
    i++;
    for (;;) {
      while (/[\s,]/.test(s[i] || '')) i++;
      if (s[i] === '}') return [obj, i + 1];
      if (i >= s.length) throw new Error('unterminated object');
      let key;
      if (s.startsWith(Q, i) || s[i] === '"') [key, i] = gemmaValue(s, i);
      else {
        const colon = s.indexOf(':', i);
        if (colon < 0) throw new Error('missing colon');
        key = s.slice(i, colon).trim();
        i = colon;
      }
      while (/\s/.test(s[i] || '')) i++;
      if (s[i] !== ':') throw new Error('missing colon');
      [obj[key], i] = gemmaValue(s, i + 1);
    }
  }
  if (s[i] === '[') {
    const arr = [];
    i++;
    for (;;) {
      while (/[\s,]/.test(s[i] || '')) i++;
      if (s[i] === ']') return [arr, i + 1];
      if (i >= s.length) throw new Error('unterminated array');
      let v;
      [v, i] = gemmaValue(s, i);
      arr.push(v);
    }
  }
  const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i));
  if (!m) throw new Error('bad value');
  return [JSON.parse(m[1]), i + m[1].length];
}

// { content: text without the calls, calls: [{ name, arguments: JSON string }] }
export function extractTextToolCalls(content) {
  const calls = [];
  let text = String(content || '');
  // Gemma 4
  for (let at = text.indexOf(GEMMA_OPEN); at >= 0; at = text.indexOf(GEMMA_OPEN)) {
    const brace = text.indexOf('{', at);
    const name = text.slice(at + GEMMA_OPEN.length, brace).trim();
    let end;
    try {
      if (brace < 0 || !/^[\w.-]+$/.test(name)) throw new Error('bad name');
      const [args, next] = gemmaValue(text, brace);
      end = text.indexOf(GEMMA_CLOSE, next);
      end = end < 0 ? next : end + GEMMA_CLOSE.length;
      calls.push({ name, arguments: JSON.stringify(args) });
    } catch {
      // Unreadable (often cut off): hide it up to its end marker, or to the end.
      const close = text.indexOf(GEMMA_CLOSE, at);
      end = close < 0 ? text.length : close + GEMMA_CLOSE.length;
    }
    text = text.slice(0, at) + text.slice(end);
  }
  // Hermes / Qwen style
  text = text.replace(/<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/g, (whole, json) => {
    try {
      const o = JSON.parse(json);
      if (o && typeof o.name === 'string') {
        calls.push({ name: o.name, arguments: JSON.stringify(o.arguments || o.parameters || {}) });
        return '';
      }
    } catch {
      /* not a call: leave the text as it was */
    }
    return whole;
  });
  // Stray markers the model sometimes leaves around.
  text = text.replace(/<\|?(?:channel|turn)\|?>|<channel\|>|<turn\|>/g, '');
  return { content: text.trim(), calls };
}

// What to show while a reply is still streaming: a call being written is hidden.
export function visibleText(content) {
  const s = String(content || '');
  const cut = [s.indexOf('<|tool_call>'), s.indexOf('<tool_call>')].filter((i) => i >= 0);
  return cut.length ? s.slice(0, Math.min(...cut)) : s;
}
