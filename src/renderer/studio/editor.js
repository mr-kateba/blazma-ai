// The studio's code editor: a <textarea> for input with a highlighted <pre>
// drawn over it (same font and metrics, pointer-events off), a line-number
// gutter, current-line highlight, a find widget and VS Code-style keys.
// Edits go through execCommand('insertText') so Ctrl+Z keeps working.

import { el } from '../lib/dom.js';
import { highlight, languageOf, esc } from './highlight.js';

const LINE = 20; // px, must match .ed-* line-height in styles.css
const PAD = 8; // px, top padding of the text layers
const INDENT = '  ';
const PAIRS = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`' };
const CLOSERS = new Set([')', ']', '}']);
const COMMENT = { js: ['// ', ''], css: ['/* ', ' */'], html: ['<!-- ', ' -->'], md: ['<!-- ', ' -->'] };

export function createEditor(labels, { onChange, onCursor, onKey } = {}) {
  const gutter = el('div', { class: 'ed-gutter', 'aria-hidden': 'true' });
  const gutterInner = el('div', { class: 'ed-gutter-inner' });
  gutter.append(gutterInner);
  const lineHl = el('div', { class: 'ed-line-hl' });
  const marks = el('pre', { class: 'ed-marks', 'aria-hidden': 'true' });
  const input = el('textarea', { class: 'ed-input', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': labels.code });
  const code = el('pre', { class: 'ed-code', 'aria-hidden': 'true' });
  // Keeps the highlighted text off the textarea's scrollbars.
  const codeClip = el('div', { class: 'ed-clip' }, code);
  const body = el('div', { class: 'ed-body' }, lineHl, marks, input, codeClip);

  const findInput = el('input', { type: 'text', class: 'ed-find-input', placeholder: labels.find, dir: 'auto' });
  const findCount = el('span', { class: 'ed-find-count' });
  const findPrev = el('button', { type: 'button', class: 'ed-find-btn', title: labels.findPrev }, '↑');
  const findNext = el('button', { type: 'button', class: 'ed-find-btn', title: labels.findNext }, '↓');
  const findClose = el('button', { type: 'button', class: 'ed-find-btn', title: labels.close }, '×');
  const findBox = el('div', { class: 'ed-find', hidden: true }, findInput, findCount, findPrev, findNext, findClose);

  const root = el('div', { class: 'ed', dir: 'ltr' }, gutter, body, findBox);

  let lang = 'text';
  let lineCount = 0;
  let activeLine = 0;
  let frame = 0;
  let readOnly = false;
  let matches = [];
  let matchIndex = -1;

  // ---------- rendering ----------

  function paint() {
    frame = 0;
    const text = input.value;
    code.innerHTML = `${highlight(text, lang)}\n`;
    const count = text.split('\n').length;
    if (count !== lineCount) {
      lineCount = count;
      let nums = '';
      for (let i = 1; i <= count; i++) nums += `<div>${i}</div>`;
      gutterInner.innerHTML = nums;
      activeLine = 0;
    }
    if (findBox.hidden) marks.textContent = '';
    else computeMatches(false);
    cursorMoved();
  }

  function schedulePaint() {
    if (!frame) frame = requestAnimationFrame(paint);
  }

  function syncScroll() {
    const x = input.scrollLeft;
    const y = input.scrollTop;
    code.style.transform = `translate(${-x}px, ${-y}px)`;
    marks.style.transform = `translate(${-x}px, ${-y}px)`;
    gutterInner.style.transform = `translateY(${-y}px)`;
    lineHl.style.transform = `translateY(${(activeLine - 1) * LINE + PAD - y}px)`;
  }

  function position() {
    const upto = input.value.slice(0, input.selectionStart);
    const line = upto.split('\n').length;
    const col = input.selectionStart - upto.lastIndexOf('\n');
    return { line, col, selected: Math.abs(input.selectionEnd - input.selectionStart) };
  }

  function cursorMoved() {
    const pos = position();
    if (pos.line !== activeLine) {
      const nums = gutterInner.children;
      if (nums[activeLine - 1]) nums[activeLine - 1].classList.remove('active');
      activeLine = pos.line;
      if (nums[activeLine - 1]) nums[activeLine - 1].classList.add('active');
    }
    syncScroll();
    if (onCursor) onCursor(pos);
  }

  // ---------- editing helpers ----------

  function replace(start, end, text, selStart, selEnd) {
    input.focus();
    input.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      input.setRangeText(text, start, end, 'end');
      input.dispatchEvent(new Event('input'));
    }
    if (selStart !== undefined) input.setSelectionRange(selStart, selEnd ?? selStart);
  }

  // Start/end offsets of the full lines touched by the selection.
  function lineRange() {
    const v = input.value;
    const start = v.lastIndexOf('\n', input.selectionStart - 1) + 1;
    let endPos = input.selectionEnd;
    if (endPos > input.selectionStart && v[endPos - 1] === '\n') endPos--;
    let end = v.indexOf('\n', endPos);
    if (end < 0) end = v.length;
    return { start, end };
  }

  function indentLines(outdent) {
    const { start, end } = lineRange();
    const lines = input.value.slice(start, end).split('\n');
    const next = lines.map((l) => (outdent ? l.replace(/^( {1,2}|\t)/, '') : INDENT + l));
    const text = next.join('\n');
    replace(start, end, text, start, start + text.length);
  }

  function toggleComment() {
    const [open, close] = COMMENT[lang] || COMMENT.js;
    const { start, end } = lineRange();
    const lines = input.value.slice(start, end).split('\n');
    const content = lines.filter((l) => l.trim());
    const commented = content.length && content.every((l) => l.trimStart().startsWith(open.trim()));
    const next = lines.map((l) => {
      if (!l.trim()) return l;
      const ind = /^\s*/.exec(l)[0];
      const rest = l.slice(ind.length);
      if (commented) {
        let r = rest.slice(rest.startsWith(open) ? open.length : open.trim().length);
        if (close && r.endsWith(close)) r = r.slice(0, -close.length);
        else if (close && r.endsWith(close.trim())) r = r.slice(0, -close.trim().length);
        return ind + r;
      }
      return ind + open + rest + close;
    });
    const text = next.join('\n');
    replace(start, end, text, start, start + text.length);
  }

  function moveLines(dir, copy) {
    const v = input.value;
    const { start, end } = lineRange();
    const block = v.slice(start, end);
    const offS = input.selectionStart - start;
    const offE = input.selectionEnd - start;
    if (copy) {
      const at = dir > 0 ? end : start;
      const insert = dir > 0 ? `\n${block}` : `${block}\n`;
      replace(at, at, insert);
      const base = dir > 0 ? end + 1 : start;
      input.setSelectionRange(base + offS, base + offE);
      return;
    }
    if (dir < 0) {
      if (start === 0) return;
      const prevStart = v.lastIndexOf('\n', start - 2) + 1;
      const prev = v.slice(prevStart, start - 1);
      replace(prevStart, end, `${block}\n${prev}`, prevStart + offS, prevStart + offE);
    } else {
      if (end >= v.length) return;
      let nextEnd = v.indexOf('\n', end + 1);
      if (nextEnd < 0) nextEnd = v.length;
      const nextLine = v.slice(end + 1, nextEnd);
      const base = start + nextLine.length + 1;
      replace(start, nextEnd, `${nextLine}\n${block}`, base + offS, base + offE);
    }
  }

  function newline() {
    const v = input.value;
    const s = input.selectionStart;
    const lineStart = v.lastIndexOf('\n', s - 1) + 1;
    const indent = /^[ \t]*/.exec(v.slice(lineStart, s))[0];
    const before = v.slice(lineStart, s).trimEnd();
    const after = v[input.selectionEnd];
    const opens = /[{[(]$/.test(before) || (lang === 'html' && /<([a-zA-Z][\w-]*)(?:\s[^<>]*)?>$/.test(before) && !/<\/[^>]*>$/.test(before) && !/\/>$/.test(before) && !/<(br|hr|img|input|meta|link|source|area|base|col|embed|wbr)\b[^>]*>$/i.test(before));
    if (opens) {
      const closesNext = (after && CLOSERS.has(after)) || (lang === 'html' && v.slice(input.selectionEnd, input.selectionEnd + 2) === '</');
      if (closesNext) {
        replace(s, input.selectionEnd, `\n${indent}${INDENT}\n${indent}`, s + 1 + indent.length + INDENT.length);
        return;
      }
      replace(s, input.selectionEnd, `\n${indent}${INDENT}`);
      return;
    }
    replace(s, input.selectionEnd, `\n${indent}`);
  }

  // ---------- keys ----------

  input.addEventListener('keydown', (e) => {
    if (onKey && onKey(e)) return;
    const mod = e.ctrlKey || e.metaKey;
    const s = input.selectionStart;
    const end = input.selectionEnd;
    const v = input.value;
    if (mod && (e.key === 'f' || e.key === 'F') && !e.shiftKey) {
      e.preventDefault();
      openFind();
      return;
    }
    if (e.key === 'Escape' && !findBox.hidden) {
      e.preventDefault();
      closeFind();
      return;
    }
    if (readOnly) return;
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey || v.slice(s, end).includes('\n')) indentLines(e.shiftKey);
      else replace(s, end, INDENT);
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      newline();
      return;
    }
    if (mod && e.key === '/') {
      e.preventDefault();
      toggleComment();
      return;
    }
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      moveLines(e.key === 'ArrowUp' ? -1 : 1, e.shiftKey);
      return;
    }
    if (mod && e.key === ']') {
      e.preventDefault();
      indentLines(false);
      return;
    }
    if (mod && e.key === '[') {
      e.preventDefault();
      indentLines(true);
      return;
    }
    if (e.key === 'Backspace' && s === end && s > 0 && PAIRS[v[s - 1]] && PAIRS[v[s - 1]] === v[s]) {
      e.preventDefault();
      replace(s - 1, s + 1, '');
      return;
    }
    if (mod || e.altKey || e.isComposing || e.key.length !== 1) return;
    // Typing a closer that is already there just steps over it.
    if ((CLOSERS.has(e.key) || e.key === '"' || e.key === "'" || e.key === '`') && s === end && v[s] === e.key) {
      e.preventDefault();
      input.setSelectionRange(s + 1, s + 1);
      cursorMoved();
      return;
    }
    const close = PAIRS[e.key];
    if (!close) return;
    const next = v[end] || '';
    const prev = v[s - 1] || '';
    const isQuote = close === e.key;
    if (s !== end) {
      e.preventDefault();
      replace(s, end, e.key + v.slice(s, end) + close, s + 1, end + 1);
      return;
    }
    if (next && !/[\s)\]},;:>]/.test(next)) return;
    if (isQuote && /[\w؀-ۿ]/.test(prev)) return;
    e.preventDefault();
    replace(s, end, e.key + close, s + 1);
  });

  input.addEventListener('input', () => {
    schedulePaint();
    if (onChange) onChange(input.value);
  });
  input.addEventListener('scroll', syncScroll);
  for (const ev of ['keyup', 'mouseup', 'focus']) input.addEventListener(ev, cursorMoved);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === input) cursorMoved();
  });

  // ---------- find ----------

  function computeMatches(select) {
    const q = findInput.value;
    matches = [];
    if (q) {
      const hay = input.value.toLowerCase();
      const needle = q.toLowerCase();
      for (let i = hay.indexOf(needle); i >= 0 && matches.length < 5000; i = hay.indexOf(needle, i + needle.length)) matches.push(i);
    }
    if (select) {
      matchIndex = matches.findIndex((m) => m >= input.selectionStart);
      if (matchIndex < 0) matchIndex = matches.length ? 0 : -1;
    } else if (matchIndex >= matches.length) matchIndex = matches.length - 1;
    // Transparent copy of the text with the matches marked, under the textarea.
    let html = '';
    let last = 0;
    matches.forEach((m, i) => {
      html += `${esc(input.value.slice(last, m))}<mark${i === matchIndex ? ' class="current"' : ''}>${esc(input.value.slice(m, m + q.length))}</mark>`;
      last = m + q.length;
    });
    marks.innerHTML = matches.length ? `${html}${esc(input.value.slice(last))}\n` : '';
    findCount.textContent = q ? (matches.length ? labels.findCount(matchIndex + 1, matches.length) : labels.noResults) : '';
    findBox.classList.toggle('none', Boolean(q) && !matches.length);
  }

  function gotoMatch(step) {
    if (!matches.length) return;
    matchIndex = (matchIndex + step + matches.length) % matches.length;
    const at = matches[matchIndex];
    input.setSelectionRange(at, at + findInput.value.length);
    revealOffset(at);
    computeMatches(false);
    cursorMoved();
  }

  function openFind() {
    findBox.hidden = false;
    const sel = input.value.slice(input.selectionStart, input.selectionEnd);
    if (sel && !sel.includes('\n')) findInput.value = sel;
    computeMatches(true);
    findInput.focus();
    findInput.select();
  }

  function closeFind() {
    findBox.hidden = true;
    marks.textContent = '';
    input.focus();
  }

  findInput.addEventListener('input', () => {
    computeMatches(true);
    if (matchIndex >= 0) {
      const at = matches[matchIndex];
      input.setSelectionRange(at, at + findInput.value.length);
      revealOffset(at);
      computeMatches(false);
    }
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    }
  });
  findNext.addEventListener('click', () => gotoMatch(1));
  findPrev.addEventListener('click', () => gotoMatch(-1));
  findClose.addEventListener('click', closeFind);

  // ---------- public ----------

  function revealOffset(offset) {
    const line = input.value.slice(0, offset).split('\n').length;
    const top = (line - 1) * LINE;
    if (top < input.scrollTop || top > input.scrollTop + input.clientHeight - LINE * 2) {
      input.scrollTop = Math.max(0, top - input.clientHeight / 3);
    }
    syncScroll();
  }

  return {
    root,
    setDoc(text, path) {
      lang = languageOf(path);
      readOnly = false;
      input.readOnly = false;
      input.value = text;
      input.setSelectionRange(0, 0);
      input.scrollTop = 0;
      input.scrollLeft = 0;
      lineCount = 0;
      paint();
    },
    // Replace the whole text keeping undo history (used when the model writes the open file).
    replaceAll(text) {
      if (input.value === text) return;
      const pos = input.selectionStart;
      const top = input.scrollTop;
      if (document.activeElement === input) replace(0, input.value.length, text, Math.min(pos, text.length));
      else {
        input.value = text;
        input.setSelectionRange(Math.min(pos, text.length), Math.min(pos, text.length));
      }
      input.scrollTop = top;
      paint();
    },
    viewState: () => ({ s: input.selectionStart, e: input.selectionEnd, top: input.scrollTop, left: input.scrollLeft }),
    restoreView(v) {
      if (!v) return;
      const n = input.value.length;
      input.setSelectionRange(Math.min(v.s, n), Math.min(v.e, n));
      input.scrollTop = v.top;
      input.scrollLeft = v.left;
      cursorMoved();
    },
    clear() {
      lang = 'text';
      input.value = '';
      readOnly = true;
      input.readOnly = true;
      lineCount = 0;
      paint();
    },
    value: () => input.value,
    focus: () => input.focus(),
    position,
    language: () => lang,
    revealLine(line, col = 1) {
      const lines = input.value.split('\n');
      const n = Math.min(Math.max(1, line), lines.length);
      let offset = 0;
      for (let i = 0; i < n - 1; i++) offset += lines[i].length + 1;
      offset += Math.min(Math.max(0, col - 1), lines[n - 1].length);
      input.focus();
      input.setSelectionRange(offset, offset);
      input.scrollTop = Math.max(0, (n - 1) * LINE - input.clientHeight / 3);
      cursorMoved();
    },
    openFind,
    toggleComment: () => !readOnly && toggleComment(),
    lineCount: () => lineCount,
  };
}
