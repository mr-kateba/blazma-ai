// The studio terminal. It looks and feels like a shell, but every command is
// implemented here against the project's files and the sandboxed preview:
// nothing is ever passed to the operating system.

import { el, detectDir } from '../lib/dom.js';

const BLOCKED = new Set(
  'npx yarn pnpm pip pip3 python python3 py git sudo su apt apt-get winget choco scoop powershell pwsh cmd bash sh zsh curl wget ssh scp dotnet java javac gcc g++ clang make cmake go cargo rustc deno bun php ruby perl code-server start explorer taskkill kill chmod chown'.split(' '),
);

// Splits a command line into words, keeping quoted strings together.
function words(line) {
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line))) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

export function normalizePath(cwd, p) {
  const raw = String(p || '').replace(/\\/g, '/');
  const parts = raw.startsWith('/') || raw.startsWith('~') ? [] : cwd.split('/').filter(Boolean);
  for (const part of raw.replace(/^~\/?/, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

export function createTerminal(T, ctx) {
  const out = el('div', { class: 'term-out' });
  const prompt = el('span', { class: 'term-prompt' });
  const input = el('input', { type: 'text', class: 'term-input', spellcheck: 'false', autocomplete: 'off', 'aria-label': T.inputLabel });
  const line = el('div', { class: 'term-line' }, prompt, input);
  const root = el('div', { class: 'term', dir: 'ltr' }, out, line);

  let cwd = '';
  const history = [];
  let histPos = 0;
  let attached = false; // mirror the preview console here (after run/node from the terminal)
  let busy = false;

  // The project name may be Arabic, so it is isolated to keep "name ~/dir $" in order.
  const promptNodes = () => [el('bdi', null, ctx.projectName()), ` ~${cwd ? `/${cwd}` : ''} $`];
  const updatePrompt = () => prompt.replaceChildren(...promptNodes());

  function print(text, cls = '') {
    const node = el('div', { class: `term-row ${cls}`, dir: detectDir(text) === 'rtl' ? 'rtl' : 'ltr' }, String(text));
    append(node);
  }

  function printCommand(text) {
    append(el('div', { class: 'term-row cmd', dir: 'ltr' }, el('span', { class: 'term-prompt' }, ...promptNodes()), ` ${text}`));
  }

  function append(node) {
    out.append(node);
    while (out.childElementCount > 2000) out.firstChild.remove();
    root.scrollTop = root.scrollHeight;
  }

  const files = () => ctx.files();
  const exists = (p) => files()[p] !== undefined;
  const isDir = (p) => p === '' || Object.keys(files()).some((f) => f.startsWith(`${p}/`)) || ctx.emptyFolders().has(p);
  const resolve = (p) => normalizePath(cwd, p);

  function listDir(dir) {
    const prefix = dir ? `${dir}/` : '';
    const entries = new Map();
    for (const f of Object.keys(files())) {
      if (!f.startsWith(prefix)) continue;
      const rest = f.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) entries.set(rest, 'file');
      else entries.set(rest.slice(0, slash), 'dir');
    }
    for (const d of ctx.emptyFolders()) {
      if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/')) entries.set(d.slice(prefix.length), 'dir');
    }
    return [...entries].sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'dir' ? -1 : 1));
  }

  function tree(dir, indent = '') {
    const list = listDir(dir);
    list.forEach(([name, type], i) => {
      const last = i === list.length - 1;
      print(`${indent}${last ? '└── ' : '├── '}${name}${type === 'dir' ? '/' : ''}`, type === 'dir' ? 'dir' : '');
      if (type === 'dir') tree(dir ? `${dir}/${name}` : name, indent + (last ? '    ' : '│   '));
    });
  }

  const needArg = (args, n, usage) => {
    if (args.length >= n) return false;
    print(T.usage(usage), 'error');
    return true;
  };

  const COMMANDS = {
    help: {
      help: T.help.help,
      run() {
        print(T.helpTitle, 'accent');
        for (const [name, c] of Object.entries(COMMANDS)) if (!c.alias) print(`  ${name.padEnd(12)} ${c.help}`);
        print(T.helpFooter, 'dim');
      },
    },
    ls: {
      help: T.help.ls,
      run(args) {
        const dir = resolve(args.find((a) => !a.startsWith('-')) || '.');
        if (!isDir(dir)) return print(T.noSuchDir(dir), 'error');
        const list = listDir(dir);
        if (!list.length) return print(T.emptyDir, 'dim');
        for (const [name, type] of list) print(type === 'dir' ? `${name}/` : name, type === 'dir' ? 'dir' : '');
      },
    },
    tree: {
      help: T.help.tree,
      run() {
        print(`${ctx.projectName()}/`, 'dir');
        tree('');
      },
    },
    cd: {
      help: T.help.cd,
      run(args) {
        const dir = resolve(args[0] || '~');
        if (!isDir(dir)) return print(T.noSuchDir(dir), 'error');
        cwd = dir;
      },
    },
    pwd: { help: T.help.pwd, run: () => print(`~/${cwd}`) },
    cat: {
      help: T.help.cat,
      run(args) {
        if (needArg(args, 1, 'cat <file>')) return;
        for (const a of args) {
          const p = resolve(a);
          if (!exists(p)) print(T.noSuchFile(p), 'error');
          else for (const l of files()[p].split('\n')) print(l);
        }
      },
    },
    touch: {
      help: T.help.touch,
      run(args) {
        if (needArg(args, 1, 'touch <file>')) return;
        for (const a of args) {
          const p = resolve(a);
          if (!exists(p) && !ctx.writeFile(p, '')) print(T.badName(p), 'error');
        }
      },
    },
    mkdir: {
      help: T.help.mkdir,
      run(args) {
        if (needArg(args, 1, 'mkdir <folder>')) return;
        for (const a of args.filter((x) => !x.startsWith('-'))) if (!ctx.makeFolder(resolve(a))) print(T.badName(a), 'error');
      },
    },
    rm: {
      help: T.help.rm,
      run(args) {
        const recursive = args.some((a) => /^-\w*r/i.test(a));
        const targets = args.filter((a) => !a.startsWith('-'));
        if (needArg(targets, 1, 'rm [-r] <path>')) return;
        for (const a of targets) {
          const p = resolve(a);
          if (exists(p)) ctx.deleteFile(p);
          else if (p && isDir(p)) {
            if (!recursive) print(T.isDir(p), 'error');
            else ctx.deleteFolder(p);
          } else print(T.noSuchFile(p), 'error');
        }
      },
    },
    mv: {
      help: T.help.mv,
      run(args) {
        if (needArg(args, 2, 'mv <from> <to>')) return;
        const from = resolve(args[0]);
        let to = resolve(args[1]);
        if (exists(from) && isDir(to) && to !== '' && !exists(to)) to = `${to}/${from.split('/').pop()}`;
        if (exists(from)) {
          if (!ctx.renameFile(from, to)) print(T.badName(to), 'error');
        } else if (from && isDir(from)) {
          if (!ctx.renameFolder(from, to)) print(T.badName(to), 'error');
        } else print(T.noSuchFile(from), 'error');
      },
    },
    cp: {
      help: T.help.cp,
      run(args) {
        if (needArg(args, 2, 'cp <from> <to>')) return;
        const from = resolve(args[0]);
        const to = resolve(args[1]);
        if (!exists(from)) return print(T.noSuchFile(from), 'error');
        if (!ctx.writeFile(to, files()[from])) print(T.badName(to), 'error');
      },
    },
    echo: {
      help: T.help.echo,
      run(args, raw) {
        const m = /^echo\s*(.*?)(?:\s*(>>?)\s*(\S+))?\s*$/s.exec(raw);
        const text = words(m[1] || '').join(' ');
        if (!m[2]) return print(text);
        const p = resolve(m[3]);
        const prev = m[2] === '>>' && exists(p) ? files()[p] : '';
        if (!ctx.writeFile(p, `${prev}${text}\n`)) print(T.badName(p), 'error');
      },
    },
    code: {
      help: T.help.code,
      run(args) {
        if (!args.length || args[0] === '.') return ctx.showExplorer();
        const p = resolve(args[0]);
        if (!exists(p) && !ctx.writeFile(p, '')) return print(T.badName(p), 'error');
        ctx.openFile(p);
      },
    },
    open: { alias: true, run: (args) => COMMANDS.code.run(args) },
    run: {
      help: T.help.run,
      async run() {
        attached = true;
        const ok = await ctx.run();
        print(ok ? T.running : T.nothingToRun, ok ? 'ok' : 'error');
      },
    },
    start: { alias: true, run: () => COMMANDS.run.run() },
    'live-server': { alias: true, run: () => COMMANDS.run.run() },
    node: {
      help: T.help.node,
      async run(args) {
        if (!args.length) return print(T.nodeRepl, 'dim');
        const p = resolve(args[0]);
        if (!exists(p)) return print(T.noSuchFile(p), 'error');
        if (!/\.m?js$/i.test(p)) return print(T.notJs(p), 'error');
        attached = true;
        await ctx.runScript(p);
      },
    },
    js: {
      help: T.help.js,
      async run(args, raw) {
        const code = raw.replace(/^js\s*/, '');
        if (!code) return print(T.usage('js <expression>'), 'error');
        const res = await ctx.evalInPreview(code);
        print(res.text, res.ok ? 'result' : 'error');
      },
    },
    npm: {
      help: T.help.npm,
      async run(args) {
        if (args[0] === 'start' || (args[0] === 'run' && /^(start|dev|serve)$/.test(args[1] || ''))) return COMMANDS.run.run();
        print(T.sandboxed(`npm ${args.join(' ')}`.trim()), 'error');
      },
    },
    ai: {
      help: T.help.ai,
      run(args, raw) {
        const text = raw.replace(/^(ai|اسأل)\s*/, '');
        if (!text) return print(T.usage('ai <طلبك>'), 'error');
        ctx.askAi(text);
        print(T.sentToAi, 'dim');
      },
    },
    'اسأل': { alias: true, run: (args, raw) => COMMANDS.ai.run(args, raw) },
    export: { help: T.help.export, run: () => ctx.exportProject() },
    history: { help: T.help.history, run: () => history.forEach((h, i) => print(`${String(i + 1).padStart(4)}  ${h}`)) },
    date: { help: T.help.date, run: () => print(new Date().toString()) },
    clear: { help: T.help.clear, run: () => out.replaceChildren() },
    cls: { alias: true, run: () => out.replaceChildren() },
    'مساعدة': { alias: true, run: () => COMMANDS.help.run() },
  };

  async function exec(raw) {
    const cmdLine = raw.trim();
    printCommand(cmdLine);
    if (!cmdLine) return;
    history.push(cmdLine);
    histPos = history.length;
    attached = false;
    const [name, ...args] = words(cmdLine);
    const cmd = COMMANDS[name] || COMMANDS[name.toLowerCase()];
    try {
      if (cmd) await cmd.run(args, cmdLine);
      else if (BLOCKED.has(name.toLowerCase())) print(/^py(thon3?)?$/i.test(name) ? T.noPython : T.sandboxed(cmdLine), 'error');
      else print(T.unknown(name), 'error');
    } catch (err) {
      print(String(err && err.message ? err.message : err), 'error');
    }
    updatePrompt();
  }

  function complete() {
    const v = input.value;
    const parts = v.split(/\s+/);
    const last = parts[parts.length - 1];
    let options;
    if (parts.length === 1) options = Object.keys(COMMANDS).filter((c) => !COMMANDS[c].alias && c.startsWith(last));
    else {
      const slash = last.lastIndexOf('/');
      const dirPart = slash >= 0 ? last.slice(0, slash + 1) : '';
      const dir = resolve(dirPart || '.');
      options = listDir(dir)
        .map(([n, t]) => dirPart + n + (t === 'dir' ? '/' : ''))
        .filter((n) => n.startsWith(last));
    }
    if (options.length === 1) {
      parts[parts.length - 1] = options[0];
      input.value = parts.join(' ') + (options[0].endsWith('/') ? '' : ' ');
    } else if (options.length > 1) {
      let common = options[0];
      for (const o of options) while (!o.startsWith(common)) common = common.slice(0, -1);
      if (common.length > last.length) {
        parts[parts.length - 1] = common;
        input.value = parts.join(' ');
      } else print(options.join('   '), 'dim');
    }
  }

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (busy) return;
      const v = input.value;
      input.value = '';
      busy = true;
      try {
        await exec(v);
      } finally {
        busy = false;
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (histPos > 0) input.value = history[--histPos];
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      histPos = Math.min(history.length, histPos + 1);
      input.value = history[histPos] || '';
    } else if (e.key === 'Tab') {
      e.preventDefault();
      complete();
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      out.replaceChildren();
    } else if (e.key === 'c' && e.ctrlKey && input.selectionStart === input.selectionEnd) {
      e.preventDefault();
      printCommand(`${input.value}^C`);
      input.value = '';
    }
  });
  root.addEventListener('mouseup', () => {
    if (!String(window.getSelection())) input.focus();
  });

  updatePrompt();
  print(T.welcome, 'dim');

  return {
    root,
    print,
    focus: () => input.focus(),
    // Console output of the preview, shown here when the run came from the terminal.
    console(level, text) {
      if (attached) print(text, level === 'error' ? 'error' : level === 'warn' ? 'warn' : '');
    },
    projectChanged() {
      cwd = '';
      updatePrompt();
    },
    exec,
    clear: () => out.replaceChildren(),
  };
}
