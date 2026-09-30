// "الاستوديو": a small code editor with projects, a sandboxed run preview
// (HTML/CSS/JavaScript via studio://, no network, no access to the user's
// files) and the model writing files into the project through tools.

import { ar } from '../i18n/ar.js';
import { el, detectDir } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';

const S = ar.studio;
const $ = (id) => document.getElementById(id);

let project = null; // { id, name, files: { path: content } }
let currentFile = null;
let saveTimer = null;
let aiAbort = null;
let aiHistory = []; // this session's requests and answers for the open project
let initialized = false;

const RUNNABLE = /\.(html?|css|m?js|json|svg|txt|md)$/i;
const NAME_RE = /^[A-Za-z0-9_\-./]{1,120}$/;

function starterFiles() {
  return {
    'index.html':
      '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8">\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>مرحباً!</h1>\n  <button id="btn">اضغط هنا</button>\n  <p id="out"></p>\n  <script src="script.js"></script>\n</body>\n</html>\n',
    'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  background: #10131a;\n  color: #e8eaef;\n  padding: 24px;\n}\n\nbutton {\n  padding: 8px 16px;\n  font-size: 16px;\n}\n',
    'script.js':
      "let count = 0;\ndocument.getElementById('btn').addEventListener('click', () => {\n  count++;\n  document.getElementById('out').textContent = 'عدد الضغطات: ' + count;\n  console.log('ضغطة رقم', count);\n});\n",
  };
}

// ---------- projects ----------

async function saveNow() {
  clearTimeout(saveTimer);
  if (project) await window.blazma.studioSave(project);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 600);
}

async function renderProjectSelect() {
  const list = await window.blazma.studioList();
  $('studio-project').replaceChildren(...list.map((p) => el('option', { value: p.id, selected: project && p.id === project.id }, p.name)));
  return list;
}

async function createProject(name, files) {
  await saveNow();
  const id = crypto.randomUUID();
  await window.blazma.studioSave({ id, name, files });
  await openProject(id);
}

async function openProject(id) {
  await saveNow();
  project = await window.blazma.studioGet(id);
  if (!project) return;
  aiHistory = [];
  $('studio-ai-log').replaceChildren();
  const names = Object.keys(project.files);
  currentFile = names.includes('index.html') ? 'index.html' : names[0] || null;
  await renderProjectSelect();
  renderFiles();
  renderEditor();
  run();
}

// ---------- files & editor ----------

function renderFiles() {
  const names = Object.keys(project.files).sort();
  $('studio-file-list').replaceChildren(
    ...names.map((name) => {
      const del = el('button', { type: 'button', class: 'file-x', title: S.deleteFile, 'aria-label': S.deleteFile }, '×');
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!window.confirm(S.confirmDeleteFile(name))) return;
        delete project.files[name];
        if (currentFile === name) currentFile = Object.keys(project.files)[0] || null;
        scheduleSave();
        renderFiles();
        renderEditor();
      });
      const item = el('div', { class: 'file-item', role: 'button', tabindex: '0', 'aria-current': String(name === currentFile), dir: 'ltr' }, el('span', null, name), del);
      item.addEventListener('click', () => {
        currentFile = name;
        renderFiles();
        renderEditor();
      });
      return item;
    }),
  );
}

function addFile() {
  const input = el('input', { type: 'text', placeholder: S.newFilePlaceholder, dir: 'ltr' });
  const finish = (commit) => {
    const name = input.value.trim().replace(/^\/+/, '');
    if (commit && name) {
      if (!NAME_RE.test(name) || name.split('/').includes('..')) {
        window.alert(S.badFileName);
      } else {
        if (project.files[name] === undefined) project.files[name] = '';
        currentFile = name;
        scheduleSave();
      }
    }
    renderFiles();
    renderEditor();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
  $('studio-file-list').prepend(input);
  input.focus();
}

function updateGutter() {
  const code = $('studio-code');
  const lines = code.value.split('\n').length;
  $('studio-gutter').textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  $('studio-gutter').scrollTop = code.scrollTop;
}

function renderEditor() {
  const code = $('studio-code');
  code.disabled = !currentFile;
  code.value = currentFile ? project.files[currentFile] : '';
  updateGutter();
}

// ---------- run ----------

function logLine(level, text) {
  const box = $('studio-console');
  const empty = box.querySelector('.console-empty');
  if (empty) empty.remove();
  box.append(el('div', { class: `console-line ${level}`, dir: detectDir(text) === 'rtl' ? 'rtl' : 'ltr' }, text));
  box.scrollTop = box.scrollHeight;
}

function clearConsole() {
  $('studio-console').replaceChildren(el('div', { class: 'console-empty muted' }, S.noOutput));
}

async function run() {
  if (!project) return;
  await saveNow();
  clearConsole();
  const names = Object.keys(project.files);
  const frame = $('studio-frame');
  if (!names.some((n) => /\.(html?|m?js)$/i.test(n))) {
    frame.removeAttribute('src');
    if (names.length) logLine('warn', S.unsupported);
    return;
  }
  const runnable = Object.fromEntries(Object.entries(project.files).filter(([n]) => RUNNABLE.test(n)));
  await window.blazma.studioPreview(runnable);
  frame.src = `studio://preview/index.html?run=${Date.now()}`;
}

// ---------- the model writes the code ----------

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or replace a file of the project with its full content.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'File name, e.g. index.html, style.css, game.js' }, content: { type: 'string', description: 'The complete file content.' } },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file of the project.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file of the project.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

function aiEntry(kind, text) {
  const log = $('studio-ai-log');
  const node =
    kind === 'assistant'
      ? el('div', { class: 'ai-entry assistant msg-body', dir: detectDir(text) }, renderMarkdown(text, { copy: ar.actions.copy, copied: ar.actions.copied, code: ar.chat.code }))
      : el('div', { class: `ai-entry ${kind}`, dir: 'auto' }, text);
  log.append(node);
  log.scrollTop = log.scrollHeight;
  return node;
}

function runStudioTool(call) {
  let args = {};
  try {
    args = JSON.parse(call.function.arguments || '{}');
  } catch {
    return 'Invalid arguments (JSON).';
  }
  const name = String(args.path || '').trim().replace(/^\.?\/+/, '');
  if (!NAME_RE.test(name) || name.split('/').includes('..')) return `Invalid file name "${name}". Use names like index.html or js/app.js.`;
  if (call.function.name === 'write_file') {
    project.files[name] = String(args.content ?? '');
    currentFile = name;
    renderFiles();
    renderEditor();
    scheduleSave();
    aiEntry('step', S.aiWrote(name));
    return `Wrote ${name} (${project.files[name].length} characters).`;
  }
  if (call.function.name === 'read_file') {
    aiEntry('step', S.aiRead(name));
    return project.files[name] ?? `No file named ${name}.`;
  }
  if (call.function.name === 'delete_file') {
    delete project.files[name];
    if (currentFile === name) currentFile = Object.keys(project.files)[0] || null;
    renderFiles();
    renderEditor();
    scheduleSave();
    aiEntry('step', S.aiDeleted(name));
    return `Deleted ${name}.`;
  }
  return `Unknown tool ${call.function.name}.`;
}

function setAiBusy(busy) {
  $('studio-ai-send').hidden = busy;
  $('studio-ai-stop').hidden = !busy;
  $('studio-ai-input').disabled = busy;
}

async function askAi(text) {
  const conn = await window.blazma.getConnection();
  if (!conn) {
    aiEntry('error', S.aiNotReady);
    return;
  }
  const settings = await window.blazma.getChatSettings();
  aiEntry('user', text);
  const working = aiEntry('working', S.aiWorking);
  setAiBusy(true);
  aiAbort = new AbortController();

  const fileList = Object.keys(project.files)
    .map((n) => `${n} (${project.files[n].length} chars)`)
    .join('، ');
  const messages = [{ role: 'system', content: S.system(fileList) }, ...aiHistory, { role: 'user', content: text }];
  let answer = '';
  try {
    for (let round = 0; round < 8; round++) {
      const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
        body: JSON.stringify({
          messages,
          stream: false,
          ...settings.sampling,
          chat_template_kwargs: { enable_thinking: settings.thinking },
          ...(round < 7 ? { tools: TOOLS } : {}),
        }),
        signal: aiAbort.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const msg = (await res.json()).choices[0].message;
      const calls = msg.tool_calls || [];
      if (!calls.length) {
        answer = msg.content || '';
        break;
      }
      messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
      for (const call of calls) messages.push({ role: 'tool', tool_call_id: call.id, content: runStudioTool(call) });
    }
    aiHistory.push({ role: 'user', content: text }, { role: 'assistant', content: answer || '…' });
    if (answer) aiEntry('assistant', answer);
    await run();
  } catch (err) {
    if (err.name !== 'AbortError') aiEntry('error', S.aiFailed);
  } finally {
    working.remove();
    aiAbort = null;
    setAiBusy(false);
  }
}

// Called from the chat page ("فتح في الاستوديو" on a code block).
const FILE_FOR_LANG = { html: 'index.html', htm: 'index.html', css: 'style.css', js: 'script.js', javascript: 'script.js' };

export async function openCodeInStudio(code, lang) {
  if (!initialized) await initStudio();
  const name = FILE_FOR_LANG[String(lang || '').toLowerCase()] || 'script.js';
  if (!project) await createProject(S.newProjectName, {});
  project.files[name] = code;
  currentFile = name;
  renderFiles();
  renderEditor();
  await run();
}

export async function initStudio() {
  if (initialized) return;
  initialized = true;
  $('studio-intro').textContent = S.intro;
  $('studio-new').textContent = S.newProject;
  $('studio-rename').title = S.renameProject;
  $('studio-delete').title = S.deleteProject;
  $('studio-export').textContent = S.exportProject;
  $('studio-run').textContent = S.run;
  $('studio-files-title').textContent = S.files;
  $('studio-new-file').textContent = S.newFile;
  $('studio-preview-title').textContent = S.preview;
  $('studio-console-title').textContent = S.console;
  $('studio-clear').textContent = S.clearConsole;
  $('studio-ai-input').placeholder = S.aiPlaceholder;
  $('studio-ai-send').textContent = S.aiSend;
  $('studio-ai-stop').textContent = S.aiStop;

  const code = $('studio-code');
  code.addEventListener('input', () => {
    if (!currentFile) return;
    project.files[currentFile] = code.value;
    updateGutter();
    scheduleSave();
  });
  code.addEventListener('scroll', () => ($('studio-gutter').scrollTop = code.scrollTop));
  code.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      code.setRangeText('  ', code.selectionStart, code.selectionEnd, 'end');
      code.dispatchEvent(new Event('input'));
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      saveNow();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      run();
    }
  });

  $('studio-run').addEventListener('click', run);
  $('studio-clear').addEventListener('click', clearConsole);
  $('studio-new-file').addEventListener('click', addFile);
  $('studio-project').addEventListener('change', (e) => openProject(e.target.value));
  $('studio-new').addEventListener('click', () => createProject(S.newProjectName, starterFiles()));
  $('studio-rename').addEventListener('click', () => {
    const select = $('studio-project');
    const input = el('input', { type: 'text', value: project.name, dir: 'auto', class: 'studio-rename-input' });
    const done = async (commit) => {
      if (commit && input.value.trim()) project.name = input.value.trim();
      input.replaceWith(select);
      await saveNow();
      renderProjectSelect();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(true));
    select.replaceWith(input);
    input.focus();
    input.select();
  });
  $('studio-delete').addEventListener('click', async () => {
    if (!project || !window.confirm(S.confirmDeleteProject(project.name))) return;
    clearTimeout(saveTimer);
    await window.blazma.studioDelete(project.id);
    project = null;
    const list = await window.blazma.studioList();
    if (list.length) await openProject(list[0].id);
    else await createProject(S.firstProject, starterFiles());
  });
  $('studio-export').addEventListener('click', async () => {
    await saveNow();
    const res = await window.blazma.studioExport(project.id);
    if (res.ok && res.result.saved) logLine('info', S.exported);
  });

  // Console output from the sandboxed preview (only from our iframe).
  window.addEventListener('message', (e) => {
    if (e.source !== $('studio-frame').contentWindow) return;
    const d = e.data;
    if (d && d.blazma === 'console' && typeof d.text === 'string') logLine(['warn', 'error'].includes(d.level) ? d.level : 'log', d.text.slice(0, 2000));
  });

  const aiInput = $('studio-ai-input');
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('studio-ai-form').requestSubmit();
    }
  });
  $('studio-ai-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = aiInput.value.trim();
    if (!text || aiAbort) return;
    aiInput.value = '';
    askAi(text);
  });
  $('studio-ai-stop').addEventListener('click', () => aiAbort && aiAbort.abort());

  const list = await window.blazma.studioList();
  if (list.length) await openProject(list[0].id);
  else await createProject(S.firstProject, starterFiles());
}

export function setStudioVisible(v) {
  if (v) initStudio();
  else saveNow();
}
