// The studio assistant, modelled on how Claude Code works: it streams its
// reply, uses tools to read, search, edit (exact string replacement), write
// and run the project, keeps a task list, shows every step as a card with the
// exact diff, can ask before changing files, and each turn can be undone.
// All tools act on the project in memory and on the sandboxed preview; the
// terminal tool runs the studio's own commands, never the operating system.

import { el, detectDir } from '../lib/dom.js';
import { readSse } from '../lib/sse.js';
import { extractTextToolCalls, visibleText } from '../lib/toolcalls.js';
import { diffLines, diffStats, diffHunks } from './diff.js';
import { confirmDialog } from '../lib/dialog.js';

const MAX_ROUNDS = 16;
const READ_LIMIT_LINES = 400;
const READ_LIMIT_CHARS = 16000;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List all files of the project with their line counts.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file of the project. For long files, pass offset (first line, 1-based) and limit (number of lines).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Change part of an existing file by replacing old_string with new_string. old_string must match the current file text exactly (including spaces and indentation) and must be unique in the file unless replace_all is true. Prefer this over write_file for changes to existing files.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string', description: 'The exact text to replace.' },
          new_string: { type: 'string', description: 'The new text.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file, or replace a whole file, with the given content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'e.g. index.html, style.css, js/game.js' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'delete_file', description: 'Delete a file of the project.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search all project files for text (or a regular expression when regex is true). Returns matching lines as path:line: text.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, regex: { type: 'boolean' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_project',
      description: 'Run the project in the preview. Returns console output and errors with file and line, plus problems found by the editor. Run it after changes and fix any errors.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        "Run a command in the studio terminal and return its output. The terminal works only on the project files and the sandboxed preview (not the operating system). Commands: ls, tree, cat, touch, mkdir, rm, mv, cp, echo, node <file.js> (runs a script and shows its console output), python <file.py> or python -c 'code' (CPython with the standard library only, no pip, no network, no input()), js <expression> (evaluates inside the running page).",
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'todo_write',
      description: 'Write the task list for a multi-step request and update it as you work. Send the whole list each time. Keep exactly one task in_progress while working.',
      parameters: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            items: {
              type: 'object',
              properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
  },
];

const NAME_RE = /^[A-Za-z0-9_\-./]{1,120}$/;
const validName = (p) => NAME_RE.test(p) && !p.split('/').some((x) => !x || x === '.' || x === '..');
const cleanPath = (p) => String(p || '').trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');

// When old_string does not match exactly, small models are usually off by
// indentation or trailing spaces. Find a unique region whose lines match
// after trimming, and return its exact [start, end) offsets.
function looseFind(text, needle) {
  const lines = text.split('\n');
  const want = needle.split('\n').map((l) => l.trim());
  while (want.length && !want[want.length - 1]) want.pop();
  while (want.length && !want[0]) want.shift();
  if (!want.length) return null;
  const offsets = [];
  let pos = 0;
  for (const l of lines) {
    offsets.push(pos);
    pos += l.length + 1;
  }
  const found = [];
  for (let i = 0; i + want.length <= lines.length; i++) {
    let ok = true;
    for (let k = 0; k < want.length; k++) {
      if (lines[i + k].trim() !== want[k]) {
        ok = false;
        break;
      }
    }
    if (ok) found.push(i);
  }
  if (found.length !== 1) return found.length ? { many: found.length } : null;
  const i = found[0];
  const last = i + want.length - 1;
  return { start: offsets[i], end: offsets[last] + lines[last].length };
}

export function createAgent(A, ctx) {
  // ---------- DOM ----------
  const log = el('div', { class: 'ai-log', 'aria-live': 'polite' });
  const todoBox = el('div', { class: 'ai-todos', hidden: true });
  const input = el('textarea', { class: 'ai-input', rows: '3', dir: 'auto', placeholder: A.placeholder });
  const send = el('button', { type: 'submit', class: 'btn primary' }, A.send);
  const stop = el('button', { type: 'button', class: 'btn danger', hidden: true }, A.stop);
  const fileChip = el('button', { type: 'button', class: 'ai-chip on', title: A.chipFileTitle });
  const selChip = el('button', { type: 'button', class: 'ai-chip on', hidden: true, title: A.chipSelTitle });
  const modeSelect = el(
    'select',
    { class: 'ai-mode', title: A.modeTitle },
    el('option', { value: 'auto' }, A.modeAuto),
    el('option', { value: 'ask' }, A.modeAsk),
  );
  const newBtn = el('button', { type: 'button', class: 'wb-icon-btn', title: A.newChat, 'aria-label': A.newChat }, '+');
  const form = el(
    'form',
    { class: 'ai-form' },
    el('div', { class: 'ai-chips' }, fileChip, selChip),
    input,
    el('div', { class: 'ai-form-row' }, el('span', { class: 'ai-hint' }, A.hint), send, stop),
  );
  const root = el(
    'div',
    { class: 'side-view ai-view', 'data-view': 'ai', hidden: true },
    el('div', { class: 'side-head ai-head' }, el('span', null, A.title), el('div', { class: 'ai-head-actions' }, modeSelect, newBtn)),
    todoBox,
    log,
    form,
  );

  let history = []; // compact: user requests and final answers
  let busy = false;
  let abort = null;
  let includeFile = true;
  let includeSel = true;
  let pendingConfirm = null;
  const turns = [];

  function scroll() {
    log.scrollTop = log.scrollHeight;
  }

  function welcome() {
    log.replaceChildren(el('div', { class: 'ai-welcome' }, el('div', { class: 'ai-welcome-mark' }, '✦'), el('p', null, A.welcome), el('p', { class: 'ai-welcome-cmds' }, A.slashList)));
  }

  function entry(kind, text) {
    const w = log.querySelector('.ai-welcome');
    if (w) w.remove();
    const node = el('div', { class: `ai-entry ${kind}`, dir: detectDir(text) }, text);
    log.append(node);
    scroll();
    return node;
  }

  function updateChips() {
    const f = ctx.activeFile();
    fileChip.hidden = !f;
    fileChip.textContent = f ? `📄 ${f}` : '';
    fileChip.classList.toggle('on', includeFile);
    const sel = ctx.selection();
    const lines = sel ? sel.split('\n').length : 0;
    selChip.hidden = !sel;
    selChip.textContent = sel ? A.chipSel(lines) : '';
    selChip.classList.toggle('on', includeSel);
  }

  // ---------- tool cards ----------

  function card(icon, title) {
    const meta = el('span', { class: 'tc-meta' });
    const head = el('button', { type: 'button', class: 'tc-head' }, el('span', { class: 'tc-icon' }, icon), el('span', { class: 'tc-title', dir: 'auto' }, title), meta);
    const body = el('div', { class: 'tc-body', hidden: true });
    const node = el('div', { class: 'tool-card running' }, head, body);
    head.addEventListener('click', () => {
      if (body.childElementCount) body.hidden = !body.hidden;
    });
    const w = log.querySelector('.ai-welcome');
    if (w) w.remove();
    log.append(node);
    scroll();
    return {
      node,
      body,
      done(status, metaText) {
        node.classList.remove('running');
        node.classList.add(status);
        meta.replaceChildren(...(Array.isArray(metaText) ? metaText : [metaText || '']));
      },
      setBody(...children) {
        body.replaceChildren(...children);
      },
      open() {
        body.hidden = false;
        scroll();
      },
    };
  }

  function statNodes({ added, removed }) {
    return [el('span', { class: 'st-add' }, `+${added}`), ' ', el('span', { class: 'st-del' }, `−${removed}`)];
  }

  function diffView(before, after) {
    const hunks = diffHunks(diffLines(before, after), 2);
    if (!hunks.length) return el('div', { class: 'tc-note' }, A.noChange);
    return el(
      'div',
      { class: 'diff', dir: 'ltr' },
      ...hunks.flatMap((h, i) => [
        i ? el('div', { class: 'diff-gap' }, '⋯') : null,
        ...h.lines.map((l) => el('div', { class: `diff-line ${l.type === '+' ? 'add' : l.type === '-' ? 'del' : ''}` }, el('span', { class: 'diff-sign' }, l.type === ' ' ? ' ' : l.type), l.text || ' ')),
      ]),
    );
  }

  function outputView(text) {
    return el('pre', { class: 'tc-out', dir: 'ltr' }, text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text);
  }

  // "Ask before editing": show the diff and wait for the user.
  function confirmChange(c, before, after) {
    return new Promise((resolve) => {
      const yes = el('button', { type: 'button', class: 'btn primary' }, A.accept);
      const no = el('button', { type: 'button', class: 'btn' }, A.reject);
      const row = el('div', { class: 'tc-confirm' }, el('span', null, A.confirmQ), yes, no);
      c.setBody(diffView(before, after), row);
      c.open();
      const finish = (ok) => {
        row.remove();
        pendingConfirm = null;
        resolve(ok);
      };
      pendingConfirm = finish;
      yes.addEventListener('click', () => finish(true));
      no.addEventListener('click', () => finish(false));
    });
  }

  function renderTodos(todos) {
    todoBox.hidden = !todos.length;
    todoBox.replaceChildren(
      el('div', { class: 'ai-todos-head' }, A.todosTitle, el('span', null, `${todos.filter((t) => t.status === 'completed').length}/${todos.length}`)),
      ...todos.map((t) => el('div', { class: `todo ${t.status}`, dir: 'auto' }, el('span', { class: 'todo-box' }, t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : ''), t.content)),
    );
  }

  // ---------- tools ----------

  async function execTool(call, mode) {
    let args = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      const c = card('⚠', A.tool.badArgs(call.function.name));
      c.done('error');
      return 'Error: the arguments were not valid JSON. Try again with valid JSON.';
    }
    const files = ctx.files();
    const fn = call.function.name;

    if (fn === 'list_files') {
      const names = Object.keys(files).sort();
      const c = card('📁', A.tool.list);
      c.setBody(outputView(names.join('\n') || '—'));
      c.done('ok', A.count(names.length));
      return names.map((n) => `${n} (${files[n].split('\n').length} lines)`).join('\n') || '(no files)';
    }

    if (fn === 'todo_write') {
      const todos = (Array.isArray(args.todos) ? args.todos : [])
        .slice(0, 30)
        .map((t) => ({ content: String(t.content || '').slice(0, 200), status: ['pending', 'in_progress', 'completed'].includes(t.status) ? t.status : 'pending' }));
      renderTodos(todos);
      const c = card('☰', A.tool.todos);
      c.done('ok', `${todos.filter((t) => t.status === 'completed').length}/${todos.length}`);
      return 'Task list updated.';
    }

    if (fn === 'search_files') {
      const q = String(args.query || '');
      const c = card('🔍', A.tool.search(q));
      let re = null;
      if (args.regex) {
        try {
          re = new RegExp(q, 'i');
        } catch {
          c.done('error');
          return 'Error: invalid regular expression.';
        }
      }
      const hits = [];
      for (const path of Object.keys(files).sort()) {
        files[path].split('\n').forEach((line, i) => {
          if (hits.length < 80 && (re ? re.test(line) : line.toLowerCase().includes(q.toLowerCase()))) hits.push(`${path}:${i + 1}: ${line.trim().slice(0, 200)}`);
        });
      }
      c.setBody(outputView(hits.join('\n') || '—'));
      c.done('ok', A.count(hits.length));
      return hits.join('\n') || 'No matches.';
    }

    if (fn === 'run_project') {
      const c = card('▶', A.tool.run);
      const res = await ctx.runProject();
      const errors = res.problems.filter((p) => p.level === 'error').length;
      c.setBody(outputView(res.text));
      c.done(errors ? 'error' : 'ok', errors ? A.errors(errors) : A.noErrors);
      return res.text;
    }

    if (fn === 'run_command') {
      const cmd = String(args.command || '').trim().slice(0, 500);
      const c = card('$', cmd || '—');
      const out = cmd ? await ctx.runCommand(cmd) : 'Error: empty command.';
      c.setBody(outputView(out));
      c.done('ok');
      return out;
    }

    // File tools below need a valid path.
    const path = cleanPath(args.path);
    if (!validName(path)) {
      const c = card('⚠', A.tool.badPath(path));
      c.done('error');
      return `Error: invalid path "${path}". Use relative names like index.html or js/app.js (English letters, digits, - _ . /).`;
    }

    if (fn === 'read_file') {
      const c = card('📄', A.tool.read(path));
      if (files[path] === undefined) {
        c.done('error', A.notFound);
        return `Error: no file named ${path}. Existing files: ${Object.keys(files).join(', ') || 'none'}.`;
      }
      const lines = files[path].split('\n');
      const offset = Math.max(1, parseInt(args.offset, 10) || 1);
      const limit = Math.max(1, Math.min(READ_LIMIT_LINES, parseInt(args.limit, 10) || READ_LIMIT_LINES));
      let text = lines.slice(offset - 1, offset - 1 + limit).join('\n');
      if (text.length > READ_LIMIT_CHARS) text = `${text.slice(0, READ_LIMIT_CHARS)}\n…`;
      const end = Math.min(lines.length, offset - 1 + limit);
      c.done('ok', A.lines(lines.length));
      const range = offset > 1 || end < lines.length ? ` (lines ${offset}-${end} of ${lines.length}; use offset/limit for more)` : '';
      return `${path}${range}:\n${text}`;
    }

    if (fn === 'delete_file') {
      const c = card('🗑', A.tool.del(path));
      if (files[path] === undefined) {
        c.done('error', A.notFound);
        return `Error: no file named ${path}.`;
      }
      if (mode === 'ask' && !(await confirmChange(c, files[path], ''))) {
        c.done('rejected', A.rejected);
        return 'The user rejected this change. Ask what they want instead, or continue without it.';
      }
      const before = files[path];
      ctx.deleteFile(path);
      c.done('ok', statNodes({ added: 0, removed: before.split('\n').length }));
      return `Deleted ${path}.`;
    }

    if (fn === 'write_file' || fn === 'edit_file') {
      const before = files[path];
      let after;
      if (fn === 'write_file') {
        after = String(args.content ?? '');
      } else {
        if (before === undefined) {
          card('✎', A.tool.edit(path)).done('error', A.notFound);
          return `Error: no file named ${path}. Use write_file to create it.`;
        }
        const oldS = String(args.old_string ?? '');
        const newS = String(args.new_string ?? '');
        if (!oldS) {
          card('✎', A.tool.edit(path)).done('error');
          return 'Error: old_string is empty. To replace the whole file use write_file.';
        }
        const count = before.split(oldS).length - 1;
        if (count === 1 || (count > 1 && args.replace_all)) {
          after = args.replace_all ? before.split(oldS).join(newS) : before.replace(oldS, () => newS);
        } else if (count > 1) {
          card('✎', A.tool.edit(path)).done('error', A.ambiguous);
          return `Error: old_string was found ${count} times in ${path}. Include more surrounding lines to make it unique, or set replace_all to true.`;
        } else {
          const loose = looseFind(before, oldS);
          if (loose && loose.start !== undefined) {
            after = before.slice(0, loose.start) + newS + before.slice(loose.end);
          } else {
            card('✎', A.tool.edit(path)).done('error', A.notMatched);
            return loose && loose.many
              ? `Error: old_string matched ${loose.many} places (ignoring indentation). Include more surrounding lines.`
              : `Error: old_string was not found in ${path}. Read the file again with read_file and copy the exact text.`;
          }
        }
      }
      const isNew = before === undefined;
      const c = card(isNew ? '＋' : '✎', isNew ? A.tool.create(path) : A.tool.edit(path));
      if (mode === 'ask' && !(await confirmChange(c, before || '', after))) {
        c.done('rejected', A.rejected);
        return 'The user rejected this change. Ask what they want instead, or continue without it.';
      }
      ctx.writeFile(path, after);
      const stats = diffStats(diffLines(before || '', after));
      c.setBody(diffView(before || '', after));
      c.done('ok', statNodes(stats));
      return `${isNew ? 'Created' : 'Updated'} ${path} (+${stats.added} -${stats.removed} lines).`;
    }

    card('⚠', fn).done('error');
    return `Error: unknown tool ${fn}.`;
  }

  // ---------- turns ----------

  function changesSince(snapshot) {
    const now = ctx.files();
    const paths = new Set([...Object.keys(snapshot), ...Object.keys(now)]);
    const list = [];
    for (const p of [...paths].sort()) {
      if (snapshot[p] === now[p]) continue;
      list.push({ path: p, before: snapshot[p], after: now[p] });
    }
    return list;
  }

  function turnFooter(snapshot) {
    const changes = changesSince(snapshot);
    if (!changes.length) return;
    const undo = el('button', { type: 'button', class: 'btn ghost small' }, A.undoTurn);
    const node = el(
      'div',
      { class: 'turn-changes' },
      el('div', { class: 'tch-head' }, A.changedFiles(changes.length), undo),
      ...changes.map((ch) => {
        const stats = diffStats(diffLines(ch.before || '', ch.after || ''));
        const view = el('button', { type: 'button', class: 'tch-file', dir: 'ltr' }, ch.after === undefined ? '🗑 ' : ch.before === undefined ? '＋ ' : '', ch.path, ' ', ...statNodes(stats));
        view.addEventListener('click', () => ctx.showDiff(ch.path, ch.before || '', ch.after || ''));
        return view;
      }),
    );
    undo.addEventListener('click', async () => {
      const now = ctx.files();
      const touchedLater = changes.some((ch) => now[ch.path] !== ch.after);
      if (touchedLater && !(await confirmDialog({ text: A.undoConfirm }))) return;
      ctx.restore(changes.map((ch) => ({ path: ch.path, content: ch.before })));
      node.classList.add('undone');
      undo.disabled = true;
      undo.textContent = A.undone;
    });
    turns.push({ node, undo });
    log.append(node);
    scroll();
  }

  function contextBlock(text) {
    const files = ctx.files();
    const parts = [];
    // @file mentions attach the file's content, like in Claude Code.
    const mentioned = [...new Set((text.match(/@([A-Za-z0-9_\-./]+)/g) || []).map((m) => m.slice(1)))].filter((p) => files[p] !== undefined);
    for (const p of mentioned) parts.push(`Content of ${p}:\n\`\`\`\n${files[p].slice(0, READ_LIMIT_CHARS)}\n\`\`\``);
    const active = ctx.activeFile();
    if (includeFile && active) parts.push(`The user has ${active} open in the editor (cursor at line ${ctx.cursorLine()}).`);
    const sel = ctx.selection();
    if (includeSel && sel) parts.push(`Selected code in ${active}:\n\`\`\`\n${sel.slice(0, 8000)}\n\`\`\``);
    return parts.length ? `\n\n---\n${parts.join('\n\n')}` : '';
  }

  // Slash commands, like Claude Code's.
  function expandSlash(text) {
    const [cmd, ...rest] = text.split(/\s+/);
    const extra = rest.join(' ');
    switch (cmd) {
      case '/clear':
        newConversation();
        return null;
      case '/help':
        entry('info', A.slashHelp);
        return null;
      case '/undo': {
        const last = [...turns].reverse().find((t) => !t.undo.disabled);
        if (last) last.undo.click();
        else entry('info', A.nothingToUndo);
        return null;
      }
      case '/fix': {
        const problems = ctx.problems();
        const list = problems.length ? problems.map((p) => `- ${p.file ? `${p.file}:${p.line || 1}: ` : ''}${p.text}`).join('\n') : '(none reported; run the project to find errors)';
        return { shown: text, prompt: A.fixPrompt(list, extra) };
      }
      case '/explain':
        return { shown: text, prompt: A.explainPrompt(extra) };
      case '/review':
        return { shown: text, prompt: A.reviewPrompt(extra) };
      default:
        if (cmd.startsWith('/')) {
          entry('info', A.unknownSlash(cmd));
          return null;
        }
        return { shown: text, prompt: text };
    }
  }

  function setBusy(b) {
    busy = b;
    send.hidden = b;
    stop.hidden = !b;
    input.disabled = b;
    ctx.onBusy(b);
  }

  async function ask(raw) {
    const text = String(raw || '').trim();
    if (!text || busy) return;
    const expanded = expandSlash(text);
    if (!expanded) return;
    const conn = await window.blazma.getConnection();
    if (!conn) {
      entry('user', expanded.shown);
      entry('error', A.notReady);
      return;
    }
    const settings = await window.blazma.getChatSettings();
    const mode = modeSelect.value;
    const snapshot = { ...ctx.files() };
    entry('user', expanded.shown);
    const status = el('div', { class: 'ai-status' }, el('span', { class: 'ai-spinner' }), el('span', null, A.working));
    log.append(status);
    const t0 = Date.now();
    const timer = setInterval(() => (status.lastChild.textContent = A.workingFor(Math.round((Date.now() - t0) / 1000))), 1000);
    setBusy(true);
    abort = new AbortController();

    const userMsg = { role: 'user', content: expanded.prompt + contextBlock(expanded.prompt) };
    const messages = [{ role: 'system', content: A.system(Object.keys(ctx.files()).sort().join('، '), ctx.activeFile()) }, ...history, userMsg];
    let final = '';
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
          body: JSON.stringify({
            messages,
            stream: true,
            // Several tool calls in one reply are read as calls, not left as text.
            parallel_tool_calls: true,
            ...settings.sampling,
            chat_template_kwargs: { enable_thinking: settings.thinking },
            ...(round < MAX_ROUNDS - 1 ? { tools: TOOLS } : {}),
          }),
          signal: abort.signal,
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          const type = err && err.error && err.error.type;
          entry('error', type === 'exceed_context_size_error' ? A.contextFull : A.failed);
          break;
        }
        let content = '';
        let reasoning = '';
        let bubble = null;
        let think = null;
        let frame = 0;
        const calls = [];
        const paint = () => {
          frame = 0;
          if (reasoning && !content) {
            if (!think) {
              think = el('details', { class: 'ai-think' }, el('summary', null, A.thinking), el('div', { class: 'ai-think-body', dir: 'auto' }));
              log.insertBefore(think, status);
            }
            think.lastChild.textContent = reasoning;
          }
          const shown = visibleText(content);
          if (shown.trim()) {
            if (!bubble) {
              bubble = el('div', { class: 'ai-entry assistant msg-body' });
              log.insertBefore(bubble, status);
            }
            bubble.dir = detectDir(shown);
            bubble.replaceChildren(ctx.renderMarkdown(shown));
          }
          scroll();
        };
        for await (const chunk of readSse(res)) {
          // The engine failed mid-reply (see lib/sse.js): shown as a failure.
          if (chunk.error) throw new Error(String(chunk.error.message || 'stream error'));
          const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
          if (!delta) continue;
          if (delta.reasoning_content) reasoning += delta.reasoning_content;
          if (delta.content) content += delta.content;
          for (const tc of delta.tool_calls || []) {
            const slot = (calls[tc.index ?? 0] ||= { id: '', type: 'function', function: { name: '', arguments: '' } });
            if (tc.id) slot.id = tc.id;
            if (tc.function && tc.function.name) slot.function.name += tc.function.name;
            if (tc.function && tc.function.arguments) slot.function.arguments += tc.function.arguments;
          }
          if (!frame) frame = requestAnimationFrame(paint);
        }
        cancelAnimationFrame(frame);
        // Calls the server left in the text (see lib/toolcalls.js).
        const leaked = extractTextToolCalls(content);
        if (leaked.calls.length) {
          content = leaked.content;
          for (const c of leaked.calls) calls.push({ id: '', type: 'function', function: { name: c.name, arguments: c.arguments } });
        }
        paint();
        if (bubble && !visibleText(content).trim()) bubble.remove();
        if (think) think.firstChild.textContent = A.thought;
        const list = calls.filter(Boolean);
        if (!list.length) {
          final = content;
          break;
        }
        list.forEach((c, i) => {
          if (!c.id) c.id = `call_${round}_${i}`;
        });
        messages.push({ role: 'assistant', content, tool_calls: list });
        for (const call of list) {
          log.append(status);
          const result = await execTool(call, mode);
          if (abort.signal.aborted) throw new DOMException('aborted', 'AbortError');
          messages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
        }
        log.append(status);
      }
      history.push({ role: 'user', content: expanded.prompt }, { role: 'assistant', content: final || '…' });
      if (history.length > 16) history = history.slice(-16);
    } catch (err) {
      if (err.name === 'AbortError') entry('info', A.stopped);
      else entry('error', A.failed);
    } finally {
      clearInterval(timer);
      status.remove();
      if (pendingConfirm) pendingConfirm(false);
      abort = null;
      setBusy(false);
      turnFooter(snapshot);
      ctx.afterTurn();
    }
  }

  function newConversation() {
    if (busy) return;
    history = [];
    turns.length = 0;
    renderTodos([]);
    welcome();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value;
    if (!v.trim() || busy) return;
    input.value = '';
    ask(v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('focus', updateChips);
  stop.addEventListener('click', () => {
    if (abort) abort.abort();
    if (pendingConfirm) pendingConfirm(false);
  });
  fileChip.addEventListener('click', () => {
    includeFile = !includeFile;
    updateChips();
  });
  selChip.addEventListener('click', () => {
    includeSel = !includeSel;
    updateChips();
  });
  newBtn.addEventListener('click', newConversation);
  modeSelect.addEventListener('change', () => ctx.setMode(modeSelect.value));

  welcome();

  return {
    root,
    ask,
    newConversation,
    focus: () => input.focus(),
    prefill(text) {
      input.value = text;
      input.focus();
    },
    updateChips,
    setMode(m) {
      modeSelect.value = m === 'ask' ? 'ask' : 'auto';
    },
    isBusy: () => busy,
  };
}
