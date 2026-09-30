// Minimal Markdown renderer that builds DOM nodes directly. Model output is
// only ever inserted as text nodes, so no HTML in it can execute or render.
// Supports: paragraphs, headings, fenced code, inline code, bold, italic,
// strikethrough, links (shown as text), lists, blockquotes, tables, rules.

import { el, detectDir } from './dom.js';

const FENCE = /^\s{0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

// ---------- inline ----------

const INLINE = [
  { re: /`([^`\n]+)`/y, make: (m) => el('code', { dir: 'ltr' }, m[1]) },
  { re: /\*\*(?=\S)([\s\S]*?\S)\*\*/y, make: (m) => el('strong', null, ...inline(m[1])) },
  { re: /__(?=\S)([\s\S]*?\S)__(?!\w)/y, make: (m) => el('strong', null, ...inline(m[1])) },
  { re: /~~(?=\S)([\s\S]*?\S)~~/y, make: (m) => el('del', null, ...inline(m[1])) },
  { re: /\*(?=[^\s*])([^*]*?[^\s*])\*/y, make: (m) => el('em', null, ...inline(m[1])) },
  { re: /(?<!\w)_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/y, make: (m) => el('em', null, ...inline(m[1])) },
  {
    // Links are not clickable (the app never navigates); the URL is shown on hover.
    re: /\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/y,
    make: (m) => el('span', { class: 'md-link', title: m[2] }, ...inline(m[1])),
  },
];

function inline(text) {
  const out = [];
  let buf = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length && /[\\`*_~[\]()#>|-]/.test(text[i + 1])) {
      buf += text[i + 1];
      i += 2;
      continue;
    }
    let matched = false;
    if ('`*_~['.includes(ch)) {
      for (const rule of INLINE) {
        rule.re.lastIndex = i;
        const m = rule.re.exec(text);
        if (m) {
          if (buf) out.push(buf);
          buf = '';
          out.push(rule.make(m));
          i = rule.re.lastIndex;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      buf += ch;
      i += 1;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ---------- blocks ----------

function codeBlock(lang, code, labels) {
  const copy = el('button', { type: 'button', class: 'md-copy' }, labels.copy);
  copy.addEventListener('click', () => {
    navigator.clipboard.writeText(code).then(() => {
      copy.textContent = labels.copied;
      setTimeout(() => (copy.textContent = labels.copy), 1500);
    });
  });
  // "حفظ كملف": the user picks where to save in a normal save dialog.
  let save = null;
  if (labels.save) {
    save = el('button', { type: 'button', class: 'md-copy' }, labels.saveCode);
    save.addEventListener('click', async () => {
      const res = await labels.save(code, lang);
      if (res && res.saved) {
        save.textContent = labels.savedCode;
        setTimeout(() => (save.textContent = labels.saveCode), 1500);
      }
    });
  }
  // Web code can run in the studio's sandboxed preview.
  let studio = null;
  if (labels.studio && /^(html?|css|js|javascript)$/i.test(lang || '')) {
    studio = el('button', { type: 'button', class: 'md-copy' }, labels.openInStudio);
    studio.addEventListener('click', () => labels.studio(code, lang));
  }
  const head = el('div', { class: 'md-code-head' }, el('span', null, lang || labels.code), el('span', { class: 'row' }, studio, save, copy));
  return el('div', { class: 'md-code', dir: 'ltr' }, head, el('pre', null, el('code', null, code)));
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
}

function table(header, rows) {
  const thead = el('thead', null, el('tr', null, ...header.map((h) => el('th', { dir: detectDir(h) }, ...inline(h)))));
  const tbody = el(
    'tbody',
    null,
    ...rows.map((r) => el('tr', null, ...header.map((_, i) => el('td', { dir: detectDir(r[i] || '') }, ...inline(r[i] || ''))))),
  );
  return el('div', { class: 'md-table' }, el('table', null, thead, tbody));
}

function isBlockStart(line, next) {
  return (
    FENCE.test(line) ||
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (line.includes('|') && next !== undefined && TABLE_SEP.test(next))
  );
}

function blocks(lines, labels) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1];
      const body = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) body.push(lines[i++]);
      i += 1; // closing fence (may be missing while streaming)
      out.push(codeBlock(fence[2], body.join('\n'), labels));
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push(el(`h${Math.min(heading[1].length + 2, 6)}`, { dir: detectDir(heading[2]) }, ...inline(heading[2])));
      i += 1;
      continue;
    }

    if (RULE.test(line)) {
      out.push(el('hr'));
      i += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) body.push(lines[i++].replace(QUOTE, ''));
      out.push(el('blockquote', { dir: detectDir(body.join(' ')) }, ...blocks(body, labels)));
      continue;
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const header = splitRow(line);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      out.push(table(header, rows));
      continue;
    }

    const item = LIST_ITEM.exec(line);
    if (item) {
      const indent = item[1].length;
      const ordered = /\d/.test(item[2]);
      const items = [];
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i]);
        if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
        const body = [m[3]];
        i += 1;
        // Continuation and nested lines are indented deeper than the marker.
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            if (i + 1 < lines.length && /^\s+/.exec(lines[i + 1])?.[0].length > indent) {
              body.push('');
              i += 1;
              continue;
            }
            break;
          }
          const lead = /^\s*/.exec(l)[0].length;
          if (lead > indent) body.push(l.slice(Math.min(lead, indent + 2)));
          else if (!LIST_ITEM.test(l) && !isBlockStart(l, lines[i + 1])) body.push(l);
          else break;
          i += 1;
        }
        items.push(body);
      }
      // One direction for the whole list keeps the bullets on one side.
      const list = el(ordered ? 'ol' : 'ul', { dir: detectDir(items.flat().join(' ')) });
      if (ordered) list.setAttribute('start', String(Number.parseInt(item[2], 10)));
      for (const body of items) {
        const li = el('li');
        const inner = blocks(body, labels);
        // Tight items render their paragraph inline.
        if (inner.length === 1 && inner[0].tagName === 'P') li.append(...inner[0].childNodes);
        else li.append(...inner);
        list.append(li);
      }
      out.push(list);
      continue;
    }

    const para = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) para.push(lines[i++]);
    const p = el('p', { dir: detectDir(para.join(' ')) });
    para.forEach((l, idx) => {
      if (idx) p.append(el('br'));
      p.append(...inline(l.trim()));
    });
    out.push(p);
  }
  return out;
}

export function renderMarkdown(text, labels) {
  const frag = document.createDocumentFragment();
  frag.append(...blocks(String(text).replace(/\r\n?/g, '\n').split('\n'), labels));
  return frag;
}
