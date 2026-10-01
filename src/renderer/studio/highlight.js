// Syntax highlighting for the studio editor: HTML, CSS, JavaScript, JSON and
// Markdown. Returns HTML in which every piece of source text is escaped; the
// only markup added is our own <span class="t-..."> tags.

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tok = (cls, text) => (cls ? `<span class="t-${cls}">${esc(text)}</span>` : esc(text));

export function languageOf(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  if (['html', 'htm', 'svg', 'xml'].includes(ext)) return 'html';
  if (['js', 'mjs', 'cjs'].includes(ext)) return 'js';
  if (ext === 'css') return 'css';
  if (ext === 'json') return 'json';
  if (ext === 'md') return 'md';
  if (ext === 'py') return 'python';
  return 'text';
}

// ---------- JavaScript ----------

const JS_CONTROL = new Set('if else for while do switch case break continue return throw try catch finally import export from default await yield'.split(' '));
const JS_STORAGE = new Set('var let const function class extends new delete typeof instanceof in of void async static get set super debugger with as'.split(' '));
const JS_LITERAL = new Set('true false null undefined NaN Infinity this'.split(' '));

const JS_RE =
  /(\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$))|('(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?|`(?:\\[\s\S]|[^`\\])*`?)|(\b(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?n?)\b)|([A-Za-z_$][\w$]*)|(\s+)|([\s\S])/g;
const CALL_RE = /\s*\(/y;

// Bracket pairs are colored by nesting depth, like VS Code.
function bracket(text, state) {
  if ('([{'.includes(text)) return tok(`b${state.depth++ % 3}`, text);
  state.depth = Math.max(0, state.depth - 1);
  return tok(`b${state.depth % 3}`, text);
}

function highlightJs(src) {
  let out = '';
  let prev = '';
  const brackets = { depth: 0 };
  JS_RE.lastIndex = 0;
  let m;
  while ((m = JS_RE.exec(src))) {
    const [text, comment, string, number, word, space] = m;
    if (comment) out += tok('comment', text);
    else if (string) out += tok('string', text);
    else if (number) out += tok('number', text);
    else if (word) {
      let cls = 'variable';
      CALL_RE.lastIndex = JS_RE.lastIndex;
      if (prev === '.') cls = CALL_RE.test(src) ? 'function' : 'property';
      else if (JS_CONTROL.has(word)) cls = 'control';
      else if (JS_STORAGE.has(word)) cls = 'keyword';
      else if (JS_LITERAL.has(word)) cls = 'keyword';
      else if (CALL_RE.test(src)) cls = 'function';
      else if (/^[A-Z]/.test(word)) cls = 'type';
      out += tok(cls, text);
    } else if (space) out += text;
    else out += /[{}()[\]]/.test(text) ? bracket(text, brackets) : esc(text);
    if (!space) prev = text;
  }
  return out;
}

// ---------- CSS ----------

const CSS_RE =
  /(\/\*[\s\S]*?(?:\*\/|$))|('(?:\\[\s\S]|[^'\\\n])*'?|"(?:\\[\s\S]|[^"\\\n])*"?)|(@[\w-]+)|(#[\da-fA-F]{3,8}\b)|(-?(?:\d+\.?\d*|\.\d+)(?:[a-zA-Z%]+)?)|(!important)|([\w-]+)|(\s+)|([\s\S])/g;
const COLON_RE = /\s*:(?!:)/y;

function highlightCss(src) {
  let out = '';
  let depth = 0;
  let inValue = false;
  CSS_RE.lastIndex = 0;
  let m;
  while ((m = CSS_RE.exec(src))) {
    const [text, comment, string, at, hex, number, important, word] = m;
    if (comment) out += tok('comment', text);
    else if (string) out += tok('string', text);
    else if (at) out += tok('control', text);
    else if (depth > 0 && inValue && hex) out += tok('number', text);
    else if (depth > 0 && inValue && number) out += tok('number', text);
    else if (important) out += tok('control', text);
    else if (word) {
      if (depth === 0) out += tok('selector', text);
      else if (inValue) {
        CALL_RE.lastIndex = CSS_RE.lastIndex;
        out += tok(CALL_RE.test(src) ? 'function' : 'value', text);
      }
      else {
        COLON_RE.lastIndex = CSS_RE.lastIndex;
        out += tok(COLON_RE.test(src) ? 'property' : 'selector', text);
      }
    } else {
      if (text === '{') depth++;
      else if (text === '}') {
        depth = Math.max(0, depth - 1);
        inValue = false;
      } else if (text === ':' && depth > 0) inValue = true;
      else if (text === ';') inValue = false;
      out += depth === 0 && !/[{}\s]/.test(text) && text !== ',' ? tok('selector', text) : tok(/[{}]/.test(text) ? 'bracket' : null, text);
    }
  }
  return out;
}

// ---------- HTML ----------

const TAG_RE = /<!--[\s\S]*?(?:-->|$)|<![^>]*>?|<(\/?)([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"?|'[^']*'?)*)(>?)/g;
const ATTR_RE = /(\s+)|(\/)|([^\s=/>]+)(?:(\s*=\s*)("[^"]*"?|'[^']*'?|[^\s"'>]+))?/g;

function highlightAttrs(s) {
  let out = '';
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(s))) {
    if (!m[0]) {
      ATTR_RE.lastIndex++;
      continue;
    }
    if (m[1]) out += m[1];
    else if (m[2]) out += tok('punct', m[2]);
    else out += tok('attr', m[3]) + (m[4] ? tok('punct', m[4]) + tok('string', m[5] || '') : '');
  }
  return out;
}

function highlightHtml(src) {
  let out = '';
  let i = 0;
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(src))) {
    out += esc(src.slice(i, m.index));
    const [text, closing, name, attrs, end] = m;
    if (!name) {
      out += tok(text.startsWith('<!--') ? 'comment' : 'meta', text);
      i = TAG_RE.lastIndex;
      continue;
    }
    out += tok('punct', `<${closing}`) + tok('tag', name) + highlightAttrs(attrs) + tok('punct', end);
    i = TAG_RE.lastIndex;
    const lower = name.toLowerCase();
    if (!closing && end && (lower === 'script' || lower === 'style') && !/\/\s*$/.test(attrs)) {
      const stop = src.toLowerCase().indexOf(`</${lower}`, i);
      const bodyEnd = stop < 0 ? src.length : stop;
      const body = src.slice(i, bodyEnd);
      out += lower === 'script' ? highlightJs(body) : highlightCss(body);
      i = bodyEnd;
      TAG_RE.lastIndex = bodyEnd;
    }
  }
  return out + esc(src.slice(i));
}

// ---------- JSON / Markdown ----------

const JSON_RE = /("(?:\\[\s\S]|[^"\\\n])*"?)(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b|\bnull\b)|([{}[\]])/g;

function highlightJson(src) {
  let out = '';
  let i = 0;
  JSON_RE.lastIndex = 0;
  let m;
  while ((m = JSON_RE.exec(src))) {
    out += esc(src.slice(i, m.index));
    if (m[1]) out += tok(m[2] ? 'property' : 'string', m[1]) + (m[2] ? esc(m[2]) : '');
    else if (m[3]) out += tok('number', m[3]);
    else if (m[4]) out += tok('keyword', m[4]);
    else out += tok('bracket', m[5]);
    i = JSON_RE.lastIndex;
  }
  return out + esc(src.slice(i));
}

function highlightMd(src) {
  return src
    .split('\n')
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return tok('heading', line);
      if (/^\s*([-*+]|\d+\.)\s/.test(line)) {
        const [, bullet, rest] = /^(\s*(?:[-*+]|\d+\.)\s)(.*)$/.exec(line);
        return tok('control', bullet) + esc(rest);
      }
      return esc(line).replace(/`[^`]+`/g, (c) => `<span class="t-string">${c}</span>`);
    })
    .join('\n');
}

const MAX_HIGHLIGHT = 200 * 1024;

export function highlight(src, lang) {
  const text = String(src);
  if (text.length > MAX_HIGHLIGHT) return esc(text);
  switch (lang) {
    case 'html':
      return highlightHtml(text);
    case 'js':
      return highlightJs(text);
    case 'css':
      return highlightCss(text);
    case 'json':
      return highlightJson(text);
    case 'md':
      return highlightMd(text);
    default:
      return esc(text);
  }
}

export { esc };
