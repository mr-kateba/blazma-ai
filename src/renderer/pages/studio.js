// "الاستوديو": a small VS Code-style workbench inside the app. Projects of
// HTML/CSS/JavaScript files, a highlighted editor with tabs, a file tree,
// search across files, a command palette, a terminal whose commands work on
// the project (never on the operating system), and a live preview that runs
// in a sandboxed iframe over studio:// with no network and no access to the
// user's files. The editor is Monaco (VS Code's editor) when it loads, with
// the simple editor as a fallback. The assistant (studio/agent.js) works like
// Claude Code: it reads, edits, runs and fixes the project through tools.

import { ar } from '../i18n/ar.js';
import { el, detectDir } from '../lib/dom.js';
import { renderMarkdown } from '../lib/markdown.js';
import { createEditor } from '../studio/editor.js';
import { loadMonaco, createMonacoEditor } from '../studio/monaco.js';
import { createAgent } from '../studio/agent.js';
import { diffLines } from '../studio/diff.js';
import { createTerminal } from '../studio/terminal.js';
import { createPalette } from '../studio/palette.js';
import { languageOf } from '../studio/highlight.js';

const S = ar.studio;
const NAME_RE = /^[A-Za-z0-9_\-./]{1,120}$/;
const RUNNABLE = /\.(html?|css|m?js|json|svg|txt|md)$/i;
const LANG_NAMES = { html: 'HTML', css: 'CSS', js: 'JavaScript', json: 'JSON', md: 'Markdown', text: S.plainText };
const LAYOUT_KEY = 'blazma.studio.layout';

// Static, trusted SVG markup only.
const SVG = {
  files: '<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z"/><path d="M14 3v5h5"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="m20 20-4.5-4.5"/>',
  ai: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/>',
  play: '<path d="M7 5v14l12-7z" class="fill"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M15 4v16"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 14h18"/>',
  preview: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M11 4v16"/>',
  newFile: '<path d="M13 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9z"/><path d="M12 11v6M9 14h6"/>',
  newFolder: '<path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M12 10v6M9 13h6"/>',
  collapse: '<path d="M4 5h16v14H4z"/><path d="M8 12h8"/>',
  more: '<circle cx="6" cy="12" r="1.2" class="fill"/><circle cx="12" cy="12" r="1.2" class="fill"/><circle cx="18" cy="12" r="1.2" class="fill"/>',
  reload: '<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  trash: '<path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13"/>',
  chevron: '<path d="m7 10 5 5 5-5"/>',
  bolt: '<path d="M13 3 5 14h6l-1 7 8-11h-6z"/>',
  error: '<circle cx="12" cy="12" r="8"/><path d="m9 9 6 6M15 9l-6 6"/>',
  warn: '<path d="M12 4 3 20h18z"/><path d="M12 10v5M12 17.5v.5"/>',
};

function icon(name, cls = '') {
  const span = el('span', { class: `ic ${cls}`, 'aria-hidden': 'true' });
  span.innerHTML = `<svg viewBox="0 0 24 24">${SVG[name]}</svg>`;
  return span;
}

const FILE_BADGES = {
  html: ['<>', 'fi-html'],
  htm: ['<>', 'fi-html'],
  css: ['#', 'fi-css'],
  js: ['JS', 'fi-js'],
  mjs: ['JS', 'fi-js'],
  json: ['{}', 'fi-json'],
  md: ['M↓', 'fi-md'],
  svg: ['◧', 'fi-svg'],
};
function fileIcon(path) {
  const [text, cls] = FILE_BADGES[path.split('.').pop().toLowerCase()] || ['≡', 'fi-text'];
  return el('span', { class: `fi ${cls}`, 'aria-hidden': 'true' }, text);
}

const baseName = (p) => p.split('/').pop();
const validName = (p) => NAME_RE.test(p) && !p.split('/').some((x) => !x || x === '.' || x === '..');

function starterFiles() {
  return {
    'index.html':
      '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8">\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>مرحباً!</h1>\n  <button id="btn">اضغط هنا</button>\n  <p id="out"></p>\n  <script src="script.js"></script>\n</body>\n</html>\n',
    'style.css': 'body {\n  font-family: system-ui, sans-serif;\n  background: #10131a;\n  color: #e8eaef;\n  padding: 24px;\n}\n\nbutton {\n  padding: 8px 16px;\n  font-size: 16px;\n}\n',
    'script.js':
      "let count = 0;\ndocument.getElementById('btn').addEventListener('click', () => {\n  count++;\n  document.getElementById('out').textContent = 'عدد الضغطات: ' + count;\n  console.log('ضغطة رقم', count);\n});\n",
  };
}

// Starting points for "New project".
const TEMPLATES = [
  { id: 'web', files: starterFiles },
  {
    id: 'blank',
    files: () => ({ 'index.html': '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8">\n  <title>مشروع جديد</title>\n</head>\n<body>\n\n</body>\n</html>\n' }),
  },
  {
    id: 'canvas',
    files: () => ({
      'index.html':
        '<!doctype html>\n<html lang="ar" dir="rtl">\n<head>\n  <meta charset="utf-8">\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <p id="score">النقاط: 0</p>\n  <canvas id="game" width="480" height="320"></canvas>\n  <p class="hint">حرّك المربع بالأسهم واجمع النقاط الصفراء</p>\n  <script src="game.js"></script>\n</body>\n</html>\n',
      'style.css':
        'body {\n  margin: 0;\n  padding: 20px;\n  display: flex;\n  flex-direction: column;\n  align-items: center;\n  background: #10131a;\n  color: #e8eaef;\n  font-family: system-ui, sans-serif;\n}\n\ncanvas {\n  background: #1b2030;\n  border-radius: 8px;\n}\n\n.hint {\n  color: #9097a6;\n}\n',
      'game.js':
        "const canvas = document.getElementById('game');\nconst ctx = canvas.getContext('2d');\nconst player = { x: 40, y: 40, size: 22, speed: 3 };\nconst keys = new Set();\nlet coin = randomCoin();\nlet score = 0;\n\nfunction randomCoin() {\n  return { x: 20 + Math.random() * (canvas.width - 40), y: 20 + Math.random() * (canvas.height - 40), r: 8 };\n}\n\naddEventListener('keydown', (e) => keys.add(e.key));\naddEventListener('keyup', (e) => keys.delete(e.key));\n\nfunction update() {\n  if (keys.has('ArrowUp')) player.y -= player.speed;\n  if (keys.has('ArrowDown')) player.y += player.speed;\n  if (keys.has('ArrowLeft')) player.x -= player.speed;\n  if (keys.has('ArrowRight')) player.x += player.speed;\n  player.x = Math.max(0, Math.min(canvas.width - player.size, player.x));\n  player.y = Math.max(0, Math.min(canvas.height - player.size, player.y));\n\n  const cx = player.x + player.size / 2;\n  const cy = player.y + player.size / 2;\n  if (Math.hypot(cx - coin.x, cy - coin.y) < coin.r + player.size / 2) {\n    score++;\n    document.getElementById('score').textContent = 'النقاط: ' + score;\n    console.log('نقطة!', score);\n    coin = randomCoin();\n  }\n}\n\nfunction draw() {\n  ctx.clearRect(0, 0, canvas.width, canvas.height);\n  ctx.fillStyle = '#5b8cff';\n  ctx.fillRect(player.x, player.y, player.size, player.size);\n  ctx.fillStyle = '#f5c542';\n  ctx.beginPath();\n  ctx.arc(coin.x, coin.y, coin.r, 0, Math.PI * 2);\n  ctx.fill();\n}\n\nfunction loop() {\n  update();\n  draw();\n  requestAnimationFrame(loop);\n}\nloop();\n",
    }),
  },
  {
    id: 'script',
    files: () => ({
      'main.js':
        "// شغّل هذا الملف بـ F5، أو من الطرفية: node main.js\n// المخرجات تظهر في الطرفية ووحدة التحكم.\n\nfunction greet(name) {\n  return `مرحباً يا ${name}!`;\n}\n\nconsole.log(greet('Blazma'));\n\nconst numbers = [3, 1, 4, 1, 5, 9, 2, 6];\nconsole.log('المجموع:', numbers.reduce((a, b) => a + b, 0));\nconsole.log('مرتبة:', [...numbers].sort((a, b) => a - b));\n",
    }),
  },
];

function newProjectFromTemplate() {
  palette.pick(
    S.pickTemplate,
    TEMPLATES.map((t) => ({ label: S.templates[t.id].name, detail: S.templates[t.id].detail, run: () => createProject(S.templates[t.id].projectName, t.files()) })),
  );
}

async function importFolder() {
  const res = await window.blazma.studioImportFolder();
  if (!res.ok) {
    terminal.print(S.importFailed, 'error');
    return;
  }
  if (!res.result.opened) return;
  const { name, files, skipped } = res.result;
  if (!Object.keys(files).length) {
    terminal.print(S.importEmpty, 'error');
    return;
  }
  await createProject(name, files);
  showPanel('terminal');
  terminal.print(S.imported(Object.keys(files).length, skipped), 'ok');
}

// ---------- state ----------

let W = null; // DOM references
let editor = null;
let terminal = null;
let palette = null;
let project = null; // { id, name, files: { path: content } }
let tabs = [];
let active = null;
const viewStates = new Map();
const dirty = new Set();
let emptyFolders = new Set();
let collapsed = new Set();
let newFileDir = '';
let saveTimer = null;
let liveTimer = null;
let staticProblems = []; // from the editor's language services (Monaco)
let runtimeProblems = []; // errors and warnings from the last run
let runLog = [];
let evalSeq = 0;
const evalWaiters = new Map();
let agent = null;
let modelState = null;
let initPromise = null;
let visible = false;

const layout = {
  side: 'explorer',
  sideVisible: true,
  sideWidth: 250,
  panelVisible: true,
  panelHeight: 210,
  panelTab: 'terminal',
  previewVisible: true,
  previewWidth: 0.45,
  live: true,
  fontSize: 14,
  wordWrap: false,
  minimap: true,
  agentMode: 'auto',
};

function loadLayout() {
  try {
    Object.assign(layout, JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}'));
  } catch {
    /* keep defaults */
  }
}
function saveLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* not critical */
  }
}

// ---------- projects ----------

async function saveNow() {
  clearTimeout(saveTimer);
  if (!project || !dirty.size) return;
  const res = await window.blazma.studioSave(project);
  if (res && res.ok === false) {
    terminal.print(S.saveFailed, 'error');
    return;
  }
  dirty.clear();
  renderTabs();
  updateStatus();
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

function scheduleLive() {
  if (!layout.live) return;
  clearTimeout(liveTimer);
  liveTimer = setTimeout(() => run(), 900);
}

function changed(path) {
  dirty.add(path);
  renderTabs();
  updateStatus();
  scheduleSave();
  scheduleLive();
}

async function createProject(name, files) {
  await saveNow();
  const id = crypto.randomUUID();
  await window.blazma.studioSave({ id, name, files });
  await openProject(id);
}

async function openProject(id) {
  await saveNow();
  const p = await window.blazma.studioGet(id);
  if (!p) return false;
  project = p;
  tabs = [];
  active = null;
  if (editor.reset) editor.reset();
  else editor.clear();
  viewStates.clear();
  dirty.clear();
  emptyFolders = new Set();
  collapsed = new Set();
  newFileDir = '';
  agent.newConversation();
  terminal.projectChanged();
  const names = Object.keys(project.files).sort();
  const first = names.includes('index.html') ? 'index.html' : names[0];
  if (first) openFile(first, { noFocus: true });
  renderAll();
  await run();
  return true;
}

async function pickProject() {
  const list = await window.blazma.studioList();
  palette.pick(
    S.openProjectPlaceholder,
    list.map((p) => ({ label: p.name, detail: p.id === project.id ? S.currentProject : new Date(p.updatedAt).toLocaleString('ar'), run: () => openProject(p.id) })),
  );
}

async function renameProject() {
  const name = await palette.prompt(S.renameProjectPlaceholder, project.name);
  if (!name) return;
  project.name = name.slice(0, 60);
  dirty.add('*');
  await saveNow();
  renderAll();
  terminal.projectChanged();
}

async function deleteProject() {
  if (!window.confirm(S.confirmDeleteProject(project.name))) return;
  clearTimeout(saveTimer);
  dirty.clear();
  await window.blazma.studioDelete(project.id);
  project = null;
  const list = await window.blazma.studioList();
  if (list.length) await openProject(list[0].id);
  else await createProject(S.firstProject, starterFiles());
}

async function exportProject() {
  dirty.add('*');
  await saveNow();
  const res = await window.blazma.studioExport(project.id);
  if (res.ok && res.result.saved) terminal.print(S.exported, 'ok');
}

// ---------- files ----------

function dropEmptyParents(p) {
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) emptyFolders.delete(parts.slice(0, i).join('/'));
}

function writeFile(p, content) {
  if (!validName(p)) return false;
  const isNew = project.files[p] === undefined;
  project.files[p] = content;
  dropEmptyParents(p);
  if (p === active) editor.replaceAll(content);
  else if (editor.syncFile) editor.syncFile(p, content);
  changed(p);
  if (isNew) renderExplorer();
  return true;
}

function deleteFile(p) {
  if (project.files[p] === undefined) return;
  delete project.files[p];
  closeTab(p);
  if (editor.dropModel) editor.dropModel(p);
  changed(p);
  renderExplorer();
}

function renameFile(from, to) {
  if (!validName(to) || project.files[to] !== undefined || project.files[from] === undefined) return false;
  project.files[to] = project.files[from];
  delete project.files[from];
  dropEmptyParents(to);
  tabs = tabs.map((t) => (t === from ? to : t));
  if (active === from) {
    active = to;
    editor.setDoc(project.files[to], to);
  }
  if (editor.dropModel) editor.dropModel(from);
  changed(to);
  renderAll();
  return true;
}

function filesUnder(dir) {
  return Object.keys(project.files).filter((f) => f.startsWith(`${dir}/`));
}

function deleteFolder(dir) {
  for (const f of filesUnder(dir)) {
    delete project.files[f];
    closeTab(f);
    if (editor.dropModel) editor.dropModel(f);
  }
  for (const d of [...emptyFolders]) if (d === dir || d.startsWith(`${dir}/`)) emptyFolders.delete(d);
  changed(dir);
  renderAll();
}

function renameFolder(from, to) {
  if (!validName(to) || to.startsWith(`${from}/`)) return false;
  const moves = filesUnder(from).map((f) => [f, to + f.slice(from.length)]);
  if (moves.some(([, n]) => project.files[n] !== undefined)) return false;
  for (const [o, n] of moves) {
    project.files[n] = project.files[o];
    delete project.files[o];
    tabs = tabs.map((t) => (t === o ? n : t));
    if (active === o) active = n;
    if (editor.dropModel) editor.dropModel(o);
  }
  for (const d of [...emptyFolders]) {
    if (d === from || d.startsWith(`${from}/`)) {
      emptyFolders.delete(d);
      emptyFolders.add(to + d.slice(from.length));
    }
  }
  if (active) editor.setDoc(project.files[active], active);
  changed(to);
  renderAll();
  return true;
}

function makeFolder(p) {
  if (!validName(p)) return false;
  emptyFolders.add(p);
  collapsed.delete(p);
  renderExplorer();
  return true;
}

// ---------- tabs & editor ----------

function openFile(p, { line, col, noFocus } = {}) {
  if (!project || project.files[p] === undefined) return;
  if (!tabs.includes(p)) tabs.push(p);
  if (active !== p) {
    if (active) viewStates.set(active, editor.viewState());
    active = p;
    editor.setDoc(project.files[p], p);
    editor.restoreView(viewStates.get(p));
  }
  const parts = p.split('/');
  for (let i = 1; i < parts.length; i++) collapsed.delete(parts.slice(0, i).join('/'));
  showEditor();
  renderTabs();
  renderExplorer();
  renderCrumbs();
  updateStatus();
  if (agent) agent.updateChips();
  if (line) editor.revealLine(line, col);
  else if (!noFocus) editor.focus();
}

function closeTab(p) {
  const i = tabs.indexOf(p);
  if (i < 0) return;
  tabs.splice(i, 1);
  viewStates.delete(p);
  if (active === p) {
    active = tabs[Math.min(i, tabs.length - 1)] || null;
    if (active) {
      editor.setDoc(project.files[active], active);
      editor.restoreView(viewStates.get(active));
    } else editor.clear();
  }
  showEditor();
  renderTabs();
  renderCrumbs();
  renderExplorer();
  updateStatus();
}

function showEditor() {
  W.editorHost.hidden = !active;
  W.welcome.hidden = Boolean(active);
}

function renderTabs() {
  W.tabs.replaceChildren(
    ...tabs.map((p) => {
      const close = el('button', { type: 'button', class: 'tab-close', title: S.closeTab, 'aria-label': S.closeTab });
      close.append(icon('close'));
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(p);
      });
      const tab = el(
        'div',
        { class: `tab${p === active ? ' active' : ''}${dirty.has(p) ? ' dirty' : ''}`, role: 'tab', title: p, dir: 'ltr' },
        fileIcon(p),
        el('span', { class: 'tab-name' }, baseName(p)),
        close,
      );
      tab.addEventListener('click', () => openFile(p));
      tab.addEventListener('auxclick', (e) => e.button === 1 && closeTab(p));
      return tab;
    }),
  );
  const current = W.tabs.querySelector('.tab.active');
  if (current) current.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderCrumbs() {
  if (!active) {
    W.crumbs.replaceChildren();
    return;
  }
  const parts = active.split('/');
  W.crumbs.replaceChildren(
    el('span', { class: 'crumb', dir: 'auto' }, project.name),
    ...parts.flatMap((part, i) => [el('span', { class: 'crumb-sep' }, '›'), el('span', { class: `crumb${i === parts.length - 1 ? ' last' : ''}` }, i === parts.length - 1 ? fileIcon(part) : null, part)]),
  );
}

// ---------- explorer ----------

function buildTree() {
  const root = { dirs: new Map(), files: [] };
  const dirNode = (path) => {
    let node = root;
    if (!path) return node;
    for (const part of path.split('/')) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    return node;
  };
  for (const f of Object.keys(project.files)) {
    const slash = f.lastIndexOf('/');
    dirNode(slash < 0 ? '' : f.slice(0, slash)).files.push(f);
  }
  for (const d of emptyFolders) dirNode(d);
  return root;
}

function treeRow(depth, children, attrs = {}) {
  const row = el('div', { class: 'tree-row', tabindex: '-1', ...attrs }, ...children);
  row.style.paddingInlineStart = `${8 + depth * 12}px`;
  return row;
}

function renderTreeNode(node, prefix, depth, out) {
  for (const name of [...node.dirs.keys()].sort()) {
    const path = prefix ? `${prefix}/${name}` : name;
    const open = !collapsed.has(path);
    const row = treeRow(depth, [icon('chevron', open ? 'chev' : 'chev closed'), el('span', { class: 'tree-name', dir: 'ltr' }, name)], { 'data-dir': path });
    row.addEventListener('click', () => {
      if (open) collapsed.add(path);
      else collapsed.delete(path);
      newFileDir = path;
      renderExplorer();
    });
    row.addEventListener('contextmenu', (e) => folderMenu(e, path));
    row.addEventListener('keydown', (e) => treeKeys(e, path, true));
    out.push(row);
    if (open) renderTreeNode(node.dirs.get(name), path, depth + 1, out);
  }
  for (const path of node.files.sort()) {
    const row = treeRow(depth, [el('span', { class: 'chev-space' }), fileIcon(path), el('span', { class: 'tree-name', dir: 'ltr' }, baseName(path))], {
      'data-file': path,
      'aria-current': String(path === active),
    });
    row.addEventListener('click', () => {
      const slash = path.lastIndexOf('/');
      newFileDir = slash < 0 ? '' : path.slice(0, slash);
      openFile(path);
    });
    row.addEventListener('contextmenu', (e) => fileMenu(e, path));
    row.addEventListener('keydown', (e) => treeKeys(e, path, false));
    out.push(row);
  }
}

function renderExplorer() {
  if (!project) return;
  W.projectTitle.textContent = project.name;
  W.center.querySelector('.cc-text').textContent = project.name;
  const rows = [];
  renderTreeNode(buildTree(), '', 0, rows);
  W.tree.replaceChildren(...rows);
  if (!rows.length) W.tree.append(el('div', { class: 'tree-empty' }, S.noFiles));
}

function treeKeys(e, path, isDir) {
  if (e.key === 'F2') {
    e.preventDefault();
    startRename(path, isDir);
  } else if (e.key === 'Delete') {
    e.preventDefault();
    if (isDir) confirmDeleteFolder(path);
    else confirmDeleteFile(path);
  }
}

// Inline name box in the tree (new file/folder, rename), like VS Code.
function inlineName({ depth, anchor, value = '', onCommit }) {
  const input = el('input', { type: 'text', class: 'tree-input', value, dir: 'ltr', spellcheck: 'false' });
  const msg = el('div', { class: 'tree-input-msg', hidden: true });
  const row = el('div', { class: 'tree-row editing' }, input, msg);
  row.style.paddingInlineStart = `${8 + depth * 12}px`;
  if (anchor) anchor.replaceWith(row);
  else W.tree.prepend(row);
  let done = false;
  const finish = (commit) => {
    if (done) return;
    const v = input.value.trim().replace(/^\/+/, '');
    if (commit && v) {
      const err = onCommit(v);
      if (err) {
        msg.textContent = err;
        msg.hidden = false;
        input.focus();
        return;
      }
    }
    done = true;
    renderExplorer();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => setTimeout(() => !done && msg.hidden && finish(Boolean(input.value.trim())), 0));
  input.focus();
  const dot = value.lastIndexOf('.');
  input.setSelectionRange(0, dot > 0 ? dot : value.length);
}

function newEntry(kind, dir = newFileDir) {
  showSide('explorer');
  if (dir && !filesUnder(dir).length && !emptyFolders.has(dir)) dir = '';
  if (dir) collapsed.delete(dir);
  renderExplorer();
  const depth = dir ? dir.split('/').length : 0;
  const anchorFolder = dir ? W.tree.querySelector(`[data-dir="${CSS.escape(dir)}"]`) : null;
  const holder = el('div');
  if (anchorFolder) anchorFolder.after(holder);
  else W.tree.prepend(holder);
  inlineName({
    depth,
    anchor: holder,
    onCommit: (name) => {
      const p = dir ? `${dir}/${name}` : name;
      if (!validName(p)) return S.badFileName;
      if (project.files[p] !== undefined || emptyFolders.has(p)) return S.exists(name);
      if (kind === 'folder') makeFolder(p);
      else {
        writeFile(p, '');
        openFile(p);
      }
      return null;
    },
  });
}

function startRename(path, isDir) {
  const row = W.tree.querySelector(isDir ? `[data-dir="${CSS.escape(path)}"]` : `[data-file="${CSS.escape(path)}"]`);
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  inlineName({
    depth: dir ? dir.split('/').length : 0,
    anchor: row,
    value: baseName(path),
    onCommit: (name) => {
      const to = dir ? `${dir}/${name}` : name;
      if (to === path) return null;
      const ok = isDir ? renameFolder(path, to) : renameFile(path, to);
      return ok ? null : validName(to) ? S.exists(name) : S.badFileName;
    },
  });
}

function confirmDeleteFile(path) {
  if (window.confirm(S.confirmDeleteFile(path))) deleteFile(path);
}
function confirmDeleteFolder(path) {
  if (window.confirm(S.confirmDeleteFolder(path))) deleteFolder(path);
}

function fileMenu(e, path) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: S.menu.open, run: () => openFile(path) },
    { label: S.menu.runThisFile, run: () => runFile(path) },
    'sep',
    { label: S.menu.rename, key: 'F2', run: () => startRename(path, false) },
    { label: S.menu.duplicate, run: () => duplicateFile(path) },
    { label: S.menu.delete, key: 'Delete', run: () => confirmDeleteFile(path) },
    'sep',
    { label: S.menu.askAiAbout, run: () => askAiAbout(path) },
  ]);
}

function folderMenu(e, path) {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [
    { label: S.cmd.newFile, run: () => newEntry('file', path) },
    { label: S.cmd.newFolder, run: () => newEntry('folder', path) },
    'sep',
    { label: S.menu.rename, key: 'F2', run: () => startRename(path, true) },
    { label: S.menu.delete, key: 'Delete', run: () => confirmDeleteFolder(path) },
  ]);
}

function duplicateFile(path) {
  const dot = path.lastIndexOf('.');
  const hasExt = dot > path.lastIndexOf('/');
  const base = hasExt ? path.slice(0, dot) : path;
  const ext = hasExt ? path.slice(dot) : '';
  let n = 1;
  while (project.files[`${base}-${n}${ext}`] !== undefined) n++;
  writeFile(`${base}-${n}${ext}`, project.files[path]);
  openFile(`${base}-${n}${ext}`);
}

// ---------- menus ----------

let openMenuEl = null;

function closeMenu() {
  if (openMenuEl) openMenuEl.remove();
  openMenuEl = null;
  if (W) for (const b of W.menubar.querySelectorAll('.menu-btn.open')) b.classList.remove('open');
}

function showMenu(x, y, items, { alignRightTo } = {}) {
  closeMenu();
  const menu = el(
    'div',
    { class: 'ctx-menu', role: 'menu' },
    ...items.map((it) => {
      if (it === 'sep') return el('div', { class: 'ctx-sep' });
      const row = el('div', { class: `ctx-item${it.disabled ? ' disabled' : ''}`, role: 'menuitem' }, el('span', null, it.label), it.key ? el('kbd', { dir: 'ltr' }, it.key) : null);
      row.addEventListener('mousedown', (e) => e.preventDefault());
      row.addEventListener('click', () => {
        if (it.disabled) return;
        closeMenu();
        it.run();
      });
      return row;
    }),
  );
  document.body.append(menu);
  const r = menu.getBoundingClientRect();
  const left = (alignRightTo !== undefined ? alignRightTo : x) - r.width;
  menu.style.left = `${Math.max(4, Math.min(left < 4 ? x : left, window.innerWidth - r.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 4))}px`;
  openMenuEl = menu;
}

document.addEventListener('mousedown', (e) => {
  if (openMenuEl && !openMenuEl.contains(e.target) && !e.target.closest('.menu-btn')) closeMenu();
});

// ---------- commands & keys ----------

let COMMANDS = [];

function defineCommands() {
  COMMANDS = [
    { id: 'palette', label: S.cmd.palette, key: 'Ctrl+Shift+P', alt: 'F1', run: () => palette.open('>') },
    { id: 'quickOpen', label: S.cmd.quickOpen, key: 'Ctrl+P', run: () => palette.open('') },
    { id: 'gotoLine', label: S.cmd.gotoLine, key: 'Ctrl+G', needsFile: true, run: () => palette.open(':') },
    { id: 'newFile', label: S.cmd.newFile, key: 'Ctrl+N', run: () => newEntry('file') },
    { id: 'newFolder', label: S.cmd.newFolder, run: () => newEntry('folder') },
    { id: 'newProject', label: S.cmd.newProject, key: 'Ctrl+Shift+N', run: newProjectFromTemplate },
    { id: 'importFolder', label: S.cmd.importFolder, run: importFolder },
    { id: 'openProject', label: S.cmd.openProject, key: 'Ctrl+O', run: pickProject },
    { id: 'save', label: S.cmd.save, key: 'Ctrl+S', run: () => (dirty.add('*'), saveNow()) },
    { id: 'export', label: S.cmd.export, run: exportProject },
    { id: 'renameProject', label: S.cmd.renameProject, run: renameProject },
    { id: 'deleteProject', label: S.cmd.deleteProject, run: deleteProject },
    { id: 'closeTab', label: S.cmd.closeTab, key: 'Ctrl+W', needsFile: true, run: () => closeTab(active) },
    { id: 'nextTab', label: S.cmd.nextTab, key: 'Ctrl+Tab', run: () => cycleTab(1) },
    { id: 'prevTab', label: S.cmd.prevTab, key: 'Ctrl+Shift+Tab', run: () => cycleTab(-1) },
    { id: 'undo', label: S.cmd.undo, key: 'Ctrl+Z', displayOnly: true, needsFile: true, run: () => editorUndo('undo') },
    { id: 'redo', label: S.cmd.redo, key: 'Ctrl+Y', displayOnly: true, needsFile: true, run: () => editorUndo('redo') },
    { id: 'find', label: S.cmd.find, key: 'Ctrl+F', needsFile: true, run: () => editor.openFind() },
    { id: 'findInFiles', label: S.cmd.findInFiles, key: 'Ctrl+Shift+F', run: () => showSide('search', true) },
    { id: 'comment', label: S.cmd.comment, key: 'Ctrl+/', displayOnly: true, needsFile: true, run: () => editor.toggleComment() },
    // In Monaco, F2 renames the symbol under the cursor (as in VS Code).
    { id: 'renameFile', label: S.cmd.renameFile, key: 'F2', needsFile: true, yieldsToEditor: true, run: () => (showSide('explorer'), startRename(active, false)) },
    { id: 'format', label: S.cmd.format, key: 'Shift+Alt+F', needsFile: true, needsMonaco: true, run: () => editor.format() },
    { id: 'toggleWrap', label: S.cmd.toggleWrap, key: 'Alt+Z', needsMonaco: true, run: () => setEditorPref('wordWrap', !layout.wordWrap) },
    { id: 'toggleMinimap', label: S.cmd.toggleMinimap, needsMonaco: true, run: () => setEditorPref('minimap', !layout.minimap) },
    { id: 'fontUp', label: S.cmd.fontUp, key: 'Ctrl+=', needsMonaco: true, run: () => setEditorPref('fontSize', Math.min(28, layout.fontSize + 1)) },
    { id: 'fontDown', label: S.cmd.fontDown, key: 'Ctrl+-', needsMonaco: true, run: () => setEditorPref('fontSize', Math.max(10, layout.fontSize - 1)) },
    { id: 'explainSelection', label: S.cmd.explainSelection, needsFile: true, run: () => askAboutSelection('explain') },
    { id: 'fixSelection', label: S.cmd.fixSelection, needsFile: true, run: () => askAboutSelection('fix') },
    { id: 'newChat', label: S.cmd.newChat, run: () => (showSide('ai', true), agent.newConversation()) },
    { id: 'explorer', label: S.cmd.explorer, key: 'Ctrl+Shift+E', run: () => showSide('explorer', true) },
    { id: 'search', label: S.cmd.search, run: () => showSide('search', true) },
    { id: 'ai', label: S.cmd.ai, key: 'Ctrl+Alt+I', run: () => showSide('ai', true) },
    { id: 'toggleSidebar', label: S.cmd.toggleSidebar, key: 'Ctrl+B', run: () => setSideVisible(!layout.sideVisible) },
    { id: 'togglePanel', label: S.cmd.togglePanel, key: 'Ctrl+J', run: () => setPanelVisible(!layout.panelVisible) },
    { id: 'terminal', label: S.cmd.terminal, key: 'Ctrl+`', run: () => showPanel('terminal', true) },
    { id: 'console', label: S.cmd.console, key: 'Ctrl+Shift+Y', run: () => showPanel('console', true) },
    { id: 'problems', label: S.cmd.problems, key: 'Ctrl+Shift+M', run: () => showPanel('problems') },
    { id: 'togglePreview', label: S.cmd.togglePreview, key: 'Ctrl+Shift+V', run: () => setPreviewVisible(!layout.previewVisible) },
    { id: 'run', label: S.cmd.run, key: 'F5', run: () => runFromUi() },
    { id: 'runFile', label: S.cmd.runFile, key: 'Ctrl+F5', run: () => (active ? runFile(active) : runFromUi()) },
    { id: 'toggleLive', label: S.cmd.toggleLive, run: toggleLive },
    { id: 'clearConsole', label: S.cmd.clearConsole, run: clearConsole },
    { id: 'clearTerminal', label: S.cmd.clearTerminal, run: () => terminal.clear() },
    { id: 'terminalHelp', label: S.cmd.terminalHelp, run: () => (showPanel('terminal', true), terminal.exec('help')) },
    { id: 'askAi', label: S.cmd.askAi, run: () => showSide('ai', true) },
  ];
}

const isDisabled = (c) => Boolean((c.needsFile && !active) || (c.needsMonaco && editor.kind !== 'monaco'));

function editorUndo(which) {
  editor.focus();
  if (editor.kind === 'monaco') editor.trigger(which);
  else document.execCommand(which);
}

function setEditorPref(key, value) {
  layout[key] = value;
  saveLayout();
  applyEditorPrefs();
}

function applyEditorPrefs() {
  if (editor.kind !== 'monaco') return;
  editor.setOptions({ fontSize: layout.fontSize, lineHeight: Math.round(layout.fontSize * 1.45), wordWrap: layout.wordWrap ? 'on' : 'off', minimap: { enabled: layout.minimap } });
}

const MENUS = [
  ['file', ['newFile', 'newFolder', 'sep', 'newProject', 'openProject', 'importFolder', 'sep', 'save', 'export', 'sep', 'renameProject', 'deleteProject', 'sep', 'closeTab']],
  ['edit', ['undo', 'redo', 'sep', 'find', 'findInFiles', 'sep', 'comment', 'format', 'renameFile']],
  ['view', ['palette', 'quickOpen', 'gotoLine', 'sep', 'explorer', 'search', 'ai', 'sep', 'toggleSidebar', 'togglePanel', 'togglePreview', 'sep', 'toggleWrap', 'toggleMinimap', 'fontUp', 'fontDown', 'sep', 'console', 'problems']],
  ['run', ['run', 'runFile', 'toggleLive', 'sep', 'clearConsole']],
  ['terminal', ['terminal', 'clearTerminal', 'terminalHelp']],
  ['ai', ['askAi', 'newChat', 'sep', 'explainSelection', 'fixSelection']],
  ['help', ['palette', 'terminalHelp']],
];

const command = (id) => COMMANDS.find((c) => c.id === id);

function menuItems(ids) {
  return ids.map((id) => {
    if (id === 'sep') return 'sep';
    const c = command(id);
    return { label: c.label, key: c.key, run: c.run, disabled: isDisabled(c) };
  });
}

const CODE_KEYS = { Backquote: '`', Slash: '/', Tab: 'Tab', BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-' };

// Uses e.code so shortcuts work with an Arabic keyboard layout too.
function comboOf(e) {
  let key = null;
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (CODE_KEYS[e.code]) key = CODE_KEYS[e.code];
  else if (/^F\d{1,2}$/.test(e.key)) key = e.key;
  if (!key) return null;
  return [e.ctrlKey || e.metaKey ? 'Ctrl' : '', e.shiftKey ? 'Shift' : '', e.altKey ? 'Alt' : '', key].filter(Boolean).join('+');
}

function onGlobalKey(e) {
  if (!visible || !project || !W) return;
  if (e.key === 'Escape' && openMenuEl) {
    closeMenu();
    return;
  }
  if (palette.isOpen()) return;
  const combo = comboOf(e);
  if (!combo) return;
  // F2 on a tree row renames that row.
  if (combo === 'F2' && e.target.closest && e.target.closest('.tree-row')) return;
  const cmd = COMMANDS.find((c) => !c.displayOnly && (c.key === combo || c.alt === combo));
  if (!cmd) return;
  if (cmd.yieldsToEditor && e.target.closest && e.target.closest('.monaco-editor')) return;
  e.preventDefault();
  e.stopPropagation();
  if (!isDisabled(cmd)) cmd.run();
}

function cycleTab(step) {
  if (tabs.length < 2) return;
  const i = tabs.indexOf(active);
  openFile(tabs[(i + step + tabs.length) % tabs.length]);
}

// ---------- layout ----------

function showSide(view, focus) {
  if (focus === 'toggle' && layout.side === view && layout.sideVisible) {
    setSideVisible(false);
    return;
  }
  layout.side = view;
  for (const v of W.side.querySelectorAll('.side-view')) v.hidden = v.dataset.view !== view;
  setSideVisible(true);
  if (focus === true) {
    if (view === 'search') W.searchInput.focus();
    if (view === 'ai') agent.focus();
  }
}

function setSideVisible(v) {
  layout.sideVisible = v;
  W.side.hidden = !v;
  W.sideSash.hidden = !v;
  for (const b of W.activity.querySelectorAll('.act-btn')) b.classList.toggle('active', v && b.dataset.view === layout.side);
  W.side.style.width = `${layout.sideWidth}px`;
  saveLayout();
}

function setPanelVisible(v) {
  layout.panelVisible = v;
  W.panel.hidden = !v;
  W.panelSash.hidden = !v;
  W.panel.style.height = `${layout.panelHeight}px`;
  W.togglePanelBtn.classList.toggle('on', v);
  saveLayout();
}

function showPanel(tab, focus) {
  layout.panelTab = tab;
  setPanelVisible(true);
  for (const b of W.panelTabs.querySelectorAll('.ptab')) b.classList.toggle('active', b.dataset.tab === tab);
  for (const v of W.panel.querySelectorAll('.panel-view')) v.hidden = v.dataset.tab !== tab;
  if (focus && tab === 'terminal') terminal.focus();
  if (focus && tab === 'console') W.replInput.focus();
  saveLayout();
}

function setPreviewVisible(v) {
  layout.previewVisible = v;
  W.preview.hidden = !v;
  W.previewSash.hidden = !v;
  W.preview.style.width = `${Math.round(layout.previewWidth * 100)}%`;
  W.togglePreviewBtn.classList.toggle('on', v);
  saveLayout();
}

function toggleLive() {
  layout.live = !layout.live;
  saveLayout();
  updateStatus();
  if (layout.live) run();
}

// Drag handles. Sizes are computed from the pointer against fixed edges, so
// they work in the right-to-left layout.
function sash(handle, onMove) {
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('dragging');
    W.root.classList.add('resizing');
    const move = (ev) => onMove(ev);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.classList.remove('dragging');
      W.root.classList.remove('resizing');
      saveLayout();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });
}

// ---------- run & preview ----------

function clearConsole() {
  W.consoleOut.replaceChildren();
}

const allProblems = () => [...staticProblems, ...runtimeProblems];

function setRuntimeProblems(list) {
  runtimeProblems = list;
  renderProblems();
  updateStatus();
}

function setStaticProblems(list) {
  staticProblems = list;
  renderProblems();
  updateStatus();
}

const locationText = (p) => (p.file ? `${p.file}${p.line ? `:${p.line}` : ''}` : '');

function consoleLine(level, text, where) {
  const loc = where && where.file ? el('button', { type: 'button', class: 'loc', dir: 'ltr' }, locationText(where)) : null;
  if (loc) loc.addEventListener('click', () => gotoProblem(where));
  const row = el(
    'div',
    { class: `con-row ${level}`, dir: detectDir(text) === 'rtl' ? 'rtl' : 'ltr' },
    level === 'error' ? icon('error') : level === 'warn' ? icon('warn') : null,
    el('span', { class: 'con-text' }, text),
    loc,
  );
  W.consoleOut.append(row);
  while (W.consoleOut.childElementCount > 1500) W.consoleOut.firstChild.remove();
  W.consoleOut.scrollTop = W.consoleOut.scrollHeight;
}

function gotoProblem(p) {
  if (p.file && project.files[p.file] !== undefined) openFile(p.file, { line: p.line || 1, col: p.col || 1 });
}

function renderProblems() {
  const problems = allProblems();
  W.problemCount.textContent = problems.length ? String(problems.length) : '';
  W.problemCount.hidden = !problems.length;
  if (!problems.length) {
    W.problemsView.replaceChildren(el('div', { class: 'panel-empty' }, S.noProblems));
    return;
  }
  W.problemsView.replaceChildren(
    ...problems.map((p) => {
      const row = el(
        'div',
        { class: `prob-row ${p.level}` },
        icon(p.level === 'error' ? 'error' : 'warn'),
        el('span', { dir: 'auto' }, p.text),
        p.file ? el('span', { class: 'prob-loc', dir: 'ltr' }, `${p.file} [${p.line || 1}, ${p.col || 1}]`) : null,
      );
      row.addEventListener('click', () => gotoProblem(p));
      return row;
    }),
  );
}

async function preparePreview() {
  if (!project) return false;
  const runnable = Object.fromEntries(Object.entries(project.files).filter(([n]) => RUNNABLE.test(n)));
  if (!Object.keys(runnable).some((n) => /\.(html?|m?js)$/i.test(n))) return false;
  const res = await window.blazma.studioPreview(runnable);
  return !res || res.ok !== false;
}

function loadFrame(src, label) {
  // A run started now replaces any pending live reload.
  clearTimeout(liveTimer);
  clearConsole();
  setRuntimeProblems([]);
  runLog = [];
  W.address.textContent = label;
  W.frame.src = src;
}

async function run() {
  clearTimeout(liveTimer);
  if (!(await preparePreview())) {
    W.frame.removeAttribute('src');
    W.address.textContent = '';
    clearConsole();
    if (project && Object.keys(project.files).length) consoleLine('warn', S.unsupported);
    return false;
  }
  loadFrame(`studio://preview/index.html?run=${Date.now()}`, 'index.html');
  return true;
}

async function runFromUi() {
  if (!layout.previewVisible) setPreviewVisible(true);
  const ok = await run();
  if (!ok) showPanel('console');
}

async function runScript(path) {
  if (!(await preparePreview())) return false;
  loadFrame(`studio://preview/__blazma__/node.html?file=${encodeURIComponent(path)}&run=${Date.now()}`, `node ${path}`);
  return true;
}

async function runFile(path) {
  if (/\.m?js$/i.test(path)) {
    showPanel('terminal');
    return terminal.exec(`node ${path}`);
  }
  if (/\.html?$/i.test(path)) {
    if (!(await preparePreview())) return false;
    if (!layout.previewVisible) setPreviewVisible(true);
    loadFrame(`studio://preview/${path.split('/').map(encodeURIComponent).join('/')}?run=${Date.now()}`, path);
    return true;
  }
  return runFromUi();
}

function evalInPreview(code) {
  return new Promise((resolve) => {
    const win = W.frame.contentWindow;
    if (!W.frame.getAttribute('src') || !win) {
      resolve({ ok: false, text: S.noPreview });
      return;
    }
    const id = ++evalSeq;
    const timer = setTimeout(() => {
      evalWaiters.delete(id);
      resolve({ ok: false, text: S.evalTimeout });
    }, 3000);
    evalWaiters.set(id, (res) => {
      clearTimeout(timer);
      resolve(res);
    });
    win.postMessage({ blazma: 'eval', id, code: String(code) }, 'studio://preview');
  });
}

function onPreviewMessage(e) {
  if (!W || e.source !== W.frame.contentWindow) return;
  const d = e.data;
  if (!d || typeof d !== 'object') return;
  if (d.blazma === 'eval-result' && evalWaiters.has(d.id)) {
    const done = evalWaiters.get(d.id);
    evalWaiters.delete(d.id);
    done({ ok: Boolean(d.ok), text: String(d.text).slice(0, 5000) });
    return;
  }
  if (d.blazma !== 'console' || typeof d.text !== 'string') return;
  const level = ['warn', 'error'].includes(d.level) ? d.level : 'log';
  const text = d.text.slice(0, 2000);
  const where = typeof d.file === 'string' && d.file ? { file: d.file.slice(0, 200), line: Number(d.line) || 0, col: Number(d.col) || 0 } : null;
  consoleLine(level, text, where);
  terminal.console(level, where ? `${text}  (${locationText(where)})` : text);
  runLog.push(`[${level}] ${text}${where ? ` (${locationText(where)})` : ''}`);
  if (runLog.length > 200) runLog.shift();
  if (level !== 'log') setRuntimeProblems([...runtimeProblems, { level, text, ...(where || {}) }].slice(-200));
}

// ---------- search view ----------

let searchTimer = null;

function runSearch() {
  const q = W.searchInput.value;
  if (!q || !project) {
    W.searchResults.replaceChildren();
    W.searchSummary.textContent = '';
    return;
  }
  const needle = q.toLowerCase();
  const groups = [];
  let total = 0;
  for (const path of Object.keys(project.files).sort()) {
    const hits = [];
    project.files[path].split('\n').forEach((line, i) => {
      const at = line.toLowerCase().indexOf(needle);
      if (at >= 0 && total < 500) {
        hits.push({ line: i + 1, col: at + 1, text: line, at });
        total++;
      }
    });
    if (hits.length) groups.push({ path, hits });
  }
  W.searchSummary.textContent = total ? S.searchSummary(total, groups.length) : S.noResults;
  W.searchResults.replaceChildren(
    ...groups.map(({ path, hits }) =>
      el(
        'div',
        { class: 'sr-group' },
        el(
          'div',
          { class: 'sr-file', dir: 'ltr' },
          fileIcon(path),
          el('span', null, baseName(path)),
          el('span', { class: 'sr-dir' }, path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''),
          el('span', { class: 'sr-count' }, String(hits.length)),
        ),
        ...hits.map((h) => {
          const start = Math.max(0, h.at - 24);
          const row = el(
            'div',
            { class: 'sr-hit', dir: 'ltr' },
            (start ? '…' : '') + h.text.slice(start, h.at).trimStart(),
            el('mark', null, h.text.slice(h.at, h.at + q.length)),
            h.text.slice(h.at + q.length, h.at + q.length + 60),
          );
          row.addEventListener('click', () => openFile(path, { line: h.line, col: h.col }));
          return row;
        }),
      ),
    ),
  );
}

// ---------- the assistant (see studio/agent.js) ----------

function askAi(text) {
  showSide('ai');
  return agent.ask(text);
}

function askAiAbout(path) {
  showSide('ai', true);
  agent.prefill(S.agent.aboutFile(path));
}

function askAboutSelection(kind) {
  showSide('ai', true);
  const sel = editor.selectionText ? editor.selectionText() : '';
  if (!sel) {
    agent.prefill(active ? S.agent.aboutFile(active) : '');
    return;
  }
  agent.ask(kind === 'fix' ? S.agent.fixSelection : S.agent.explainSelection);
}

// Runs the project for the assistant and reports output and problems.
async function runForAgent() {
  const ok = await run();
  if (!ok) return { text: 'Nothing to run: add index.html (or a .js file).', problems: [] };
  await new Promise((r) => setTimeout(r, 1800));
  const all = [...staticProblems, ...runtimeProblems];
  const lines = [];
  lines.push(runLog.length ? `Console output:\n${runLog.join('\n')}` : 'Console: no output.');
  const editorErrors = staticProblems.filter((p) => p.level === 'error');
  if (editorErrors.length) lines.push(`Problems found by the editor:\n${editorErrors.map((p) => `${p.file}:${p.line}: ${p.text}`).join('\n')}`);
  if (!all.some((p) => p.level === 'error')) lines.push('No errors.');
  return { text: lines.join('\n\n'), problems: all };
}

// Side-by-side style diff of one file, opened from the assistant's change list.
function showDiff(path, before, after) {
  closeDiff();
  const body = el('div', { class: 'diff-modal-body', dir: 'ltr' });
  const close = iconBtn('close', S.close, closeDiff);
  const modal = el('div', { class: 'diff-modal' }, el('div', { class: 'diff-modal-head' }, el('span', null, S.agent.diffTitle(path)), close), body);
  const overlay = el('div', { class: 'diff-overlay' }, modal);
  overlay.addEventListener('mousedown', (e) => e.target === overlay && closeDiff());
  W.root.append(overlay);
  let dispose = null;
  if (editor.showDiff) dispose = editor.showDiff(body, before, after, path);
  else {
    const ops = diffLines(before, after);
    body.classList.add('plain');
    body.append(
      ...ops.map((o) => el('div', { class: `diff-line ${o.type === '+' ? 'add' : o.type === '-' ? 'del' : ''}` }, el('span', { class: 'diff-sign' }, o.type), o.text || ' ')),
    );
  }
  W.diff = { overlay, dispose };
}

function closeDiff() {
  if (!W || !W.diff) return;
  if (W.diff.dispose) W.diff.dispose();
  W.diff.overlay.remove();
  W.diff = null;
}

// ---------- status bar ----------

function updateStatus() {
  if (!W) return;
  const problems = allProblems();
  const errors = problems.filter((p) => p.level === 'error').length;
  const warns = problems.length - errors;
  W.stProblems.replaceChildren(icon('error'), el('span', null, String(errors)), icon('warn'), el('span', null, String(warns)));
  W.stLive.replaceChildren(icon('bolt'), el('span', null, layout.live ? S.liveOn : S.liveOff));
  W.stLive.classList.toggle('off', !layout.live);
  W.stSaved.textContent = dirty.size ? S.unsaved : S.saved;
  for (const node of [W.stPos, W.stLang, W.stIndent]) node.hidden = !active;
  if (active) {
    const pos = editor.position();
    W.stPos.textContent = S.position(pos.line, pos.col, pos.selected);
    W.stLang.textContent = LANG_NAMES[languageOf(active)];
  }
  const s = modelState;
  const model = s && s.models && s.models.find((m) => m.id === s.modelId);
  const ready = Boolean(s && s.phase === 'ready' && model);
  W.stModel.textContent = ready ? S.modelReady(model.name) : S.modelOff;
  W.stModel.classList.toggle('off', !ready);
}

function renderAll() {
  renderExplorer();
  renderTabs();
  renderCrumbs();
  showEditor();
  updateStatus();
}

// ---------- building the workbench ----------

function actBtn(view, iconName, title) {
  const b = el('button', { type: 'button', class: 'act-btn', 'data-view': view, title, 'aria-label': title }, icon(iconName));
  b.addEventListener('click', () => showSide(view, 'toggle'));
  return b;
}

function iconBtn(iconName, title, onClick, cls = '') {
  const b = el('button', { type: 'button', class: `wb-icon-btn ${cls}`, title, 'aria-label': title }, icon(iconName));
  b.addEventListener('click', onClick);
  return b;
}

function build(host) {
  W = {};
  // Title bar: menus, command center, layout toggles, run.
  W.menubar = el('div', { class: 'wb-menubar' });
  for (const [id, ids] of MENUS) {
    const b = el('button', { type: 'button', class: 'menu-btn', 'data-menu': id }, S.menus[id]);
    const openIt = () => {
      const r = b.getBoundingClientRect();
      showMenu(r.right, r.bottom + 2, menuItems(ids), { alignRightTo: r.right });
      b.classList.add('open');
    };
    b.addEventListener('click', () => (b.classList.contains('open') ? closeMenu() : openIt()));
    b.addEventListener('mouseenter', () => openMenuEl && W.menubar.querySelector('.menu-btn.open') && !b.classList.contains('open') && openIt());
    W.menubar.append(b);
  }
  W.center = el('button', { type: 'button', class: 'wb-command-center', title: `${S.cmd.quickOpen} (Ctrl+P)` }, icon('search'), el('span', { class: 'cc-text', dir: 'auto' }));
  W.center.addEventListener('click', () => palette.open(''));
  W.togglePanelBtn = iconBtn('panel', S.cmd.togglePanel, () => setPanelVisible(!layout.panelVisible), 'toggle');
  W.togglePreviewBtn = iconBtn('preview', S.cmd.togglePreview, () => setPreviewVisible(!layout.previewVisible), 'toggle');
  const runBtn = el('button', { type: 'button', class: 'wb-run', title: `${S.cmd.run} (F5)` }, icon('play'), el('span', null, S.runLabel));
  runBtn.addEventListener('click', runFromUi);
  const title = el(
    'div',
    { class: 'wb-title' },
    el('div', { class: 'wb-title-start' }, el('span', { class: 'wb-logo', 'aria-hidden': 'true' }, 'B'), W.menubar),
    W.center,
    el('div', { class: 'wb-title-end' }, iconBtn('sidebar', S.cmd.toggleSidebar, () => setSideVisible(!layout.sideVisible), 'toggle on'), W.togglePanelBtn, W.togglePreviewBtn, runBtn),
  );

  // Activity bar.
  W.aiBadge = el('span', { class: 'act-badge', hidden: true });
  const aiBtn = actBtn('ai', 'ai', S.cmd.ai);
  aiBtn.append(W.aiBadge);
  W.activity = el('nav', { class: 'wb-activity' }, actBtn('explorer', 'files', S.cmd.explorer), actBtn('search', 'search', S.cmd.findInFiles), aiBtn);

  // Explorer view.
  W.projectTitle = el('span', { class: 'proj-name', dir: 'auto' });
  const projMore = iconBtn('more', S.projectActions, (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu(r.right, r.bottom + 2, menuItems(['newProject', 'openProject', 'importFolder', 'sep', 'renameProject', 'export', 'sep', 'deleteProject']), { alignRightTo: r.right });
  });
  W.tree = el('div', { class: 'tree', role: 'tree' });
  const explorer = el(
    'div',
    { class: 'side-view', 'data-view': 'explorer' },
    el('div', { class: 'side-head' }, el('span', null, S.explorerTitle)),
    el(
      'div',
      { class: 'proj-head' },
      W.projectTitle,
      el(
        'div',
        { class: 'proj-actions' },
        iconBtn('newFile', S.cmd.newFile, () => newEntry('file', '')),
        iconBtn('newFolder', S.cmd.newFolder, () => newEntry('folder', '')),
        iconBtn('collapse', S.collapseAll, () => {
          for (const r of W.tree.querySelectorAll('[data-dir]')) collapsed.add(r.dataset.dir);
          renderExplorer();
        }),
        projMore,
      ),
    ),
    W.tree,
  );
  W.tree.addEventListener('contextmenu', (e) => {
    if (e.target === W.tree) {
      e.preventDefault();
      showMenu(e.clientX, e.clientY, menuItems(['newFile', 'newFolder']));
    }
  });

  // Search view.
  W.searchInput = el('input', { type: 'search', class: 'side-input', placeholder: S.searchPlaceholder, dir: 'auto' });
  W.searchSummary = el('div', { class: 'sr-summary' });
  W.searchResults = el('div', { class: 'sr-results' });
  W.searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(runSearch, 150);
  });
  const search = el(
    'div',
    { class: 'side-view', 'data-view': 'search', hidden: true },
    el('div', { class: 'side-head' }, el('span', null, S.searchTitle)),
    el('div', { class: 'side-pad' }, W.searchInput, W.searchSummary),
    W.searchResults,
  );

  // Assistant view (studio/agent.js).
  const aiView = agent.root;

  W.side = el('aside', { class: 'wb-side' }, explorer, search, aiView);
  W.sideSash = el('div', { class: 'sash sash-v' });

  // Editor group.
  W.tabs = el('div', { class: 'wb-tabs', role: 'tablist' });
  W.crumbs = el('div', { class: 'wb-crumbs', dir: 'ltr' });
  W.editorHost = el('div', { class: 'wb-editor-host' }, editor.root);
  W.welcome = el(
    'div',
    { class: 'wb-welcome' },
    el('div', { class: 'wb-welcome-logo', 'aria-hidden': 'true' }, 'B'),
    el(
      'dl',
      null,
      ...['palette', 'quickOpen', 'newFile', 'run', 'terminal', 'ai'].flatMap((id) => {
        const c = command(id);
        return [el('dt', null, c.label), el('dd', { dir: 'ltr' }, el('kbd', null, c.key))];
      }),
    ),
  );
  const group = el('div', { class: 'wb-group' }, el('div', { class: 'wb-tabs-row' }, W.tabs), W.crumbs, W.editorHost, W.welcome);

  // Preview.
  W.address = el('span', { class: 'pv-address', dir: 'ltr' });
  // allow-same-origin gives the preview its own origin (studio://preview),
  // which is still cross-origin to the app (app://blazma): it cannot reach
  // the app or window.blazma, and its CSP blocks all network access. With
  // an opaque origin instead, the browser hides error messages and lines
  // from the project's own scripts ("Script error.").
  W.frame = el('iframe', { class: 'pv-frame', sandbox: 'allow-scripts allow-modals allow-same-origin', title: S.preview });
  W.preview = el(
    'div',
    { class: 'wb-preview' },
    el('div', { class: 'pv-head' }, el('span', { class: 'pv-title' }, S.preview), W.address, iconBtn('reload', S.reload, runFromUi), iconBtn('close', S.closePreview, () => setPreviewVisible(false))),
    W.frame,
  );
  W.previewSash = el('div', { class: 'sash sash-v' });
  const editors = el('div', { class: 'wb-editors' }, group, W.previewSash, W.preview);

  // Panel: terminal, debug console, problems.
  W.problemCount = el('span', { class: 'ptab-count', hidden: true });
  W.panelTabs = el('div', { class: 'ptabs' });
  for (const [tab, label] of [
    ['terminal', S.terminal],
    ['console', S.console],
    ['problems', S.problems],
  ]) {
    const b = el('button', { type: 'button', class: 'ptab', 'data-tab': tab }, label, tab === 'problems' ? W.problemCount : null);
    b.addEventListener('click', () => showPanel(tab, true));
    W.panelTabs.append(b);
  }
  W.consoleOut = el('div', { class: 'con-out', dir: 'ltr' });
  W.replInput = el('input', { type: 'text', class: 'repl-input', dir: 'ltr', spellcheck: 'false', placeholder: S.replPlaceholder });
  W.replInput.addEventListener('keydown', async (e) => {
    if (e.key !== 'Enter' || !W.replInput.value.trim()) return;
    const code = W.replInput.value;
    W.replInput.value = '';
    consoleLine('input', `› ${code}`);
    const res = await evalInPreview(code);
    consoleLine(res.ok ? 'result' : 'error', res.text);
  });
  const consoleView = el(
    'div',
    { class: 'panel-view con', 'data-tab': 'console', hidden: true },
    W.consoleOut,
    el('div', { class: 'repl', dir: 'ltr' }, el('span', { class: 'repl-prompt' }, '›'), W.replInput),
  );
  W.problemsView = el('div', { class: 'panel-view probs', 'data-tab': 'problems', hidden: true });
  const termView = el('div', { class: 'panel-view', 'data-tab': 'terminal' }, terminal.root);
  W.panel = el(
    'div',
    { class: 'wb-panel' },
    el(
      'div',
      { class: 'panel-head' },
      W.panelTabs,
      el(
        'div',
        { class: 'panel-actions' },
        iconBtn('trash', S.clear, () => (layout.panelTab === 'terminal' ? terminal.clear() : clearConsole())),
        iconBtn('close', S.closePanel, () => setPanelVisible(false)),
      ),
    ),
    termView,
    consoleView,
    W.problemsView,
  );
  W.panelSash = el('div', { class: 'sash sash-h' });
  const centerCol = el('div', { class: 'wb-center' }, editors, W.panelSash, W.panel);

  // Status bar.
  W.stProblems = el('button', { type: 'button', class: 'st-item', title: S.problems });
  W.stProblems.addEventListener('click', () => showPanel('problems'));
  W.stLive = el('button', { type: 'button', class: 'st-item', title: S.cmd.toggleLive });
  W.stLive.addEventListener('click', toggleLive);
  W.stSaved = el('span', { class: 'st-item plain' });
  W.stPos = el('button', { type: 'button', class: 'st-item', title: S.cmd.gotoLine });
  W.stPos.addEventListener('click', () => active && palette.open(':'));
  W.stIndent = el('span', { class: 'st-item plain' }, S.spaces(2));
  W.stLang = el('span', { class: 'st-item plain' });
  W.stModel = el('button', { type: 'button', class: 'st-item', title: S.cmd.ai });
  W.stModel.addEventListener('click', () => showSide('ai', true));
  const status = el(
    'footer',
    { class: 'wb-status' },
    el('div', { class: 'st-group' }, W.stProblems, W.stLive, W.stSaved),
    el('div', { class: 'st-group' }, W.stPos, W.stIndent, el('span', { class: 'st-item plain', dir: 'ltr' }, 'UTF-8'), W.stLang, W.stModel),
  );

  W.root = el('div', { class: 'wb' }, title, el('div', { class: 'wb-main' }, W.activity, W.side, W.sideSash, centerCol), status, palette.root);
  host.replaceChildren(W.root);

  // Resizing (RTL: the side bar is on the right, the preview on the left).
  sash(W.sideSash, (e) => {
    const right = W.activity.getBoundingClientRect().left;
    layout.sideWidth = Math.max(170, Math.min(520, right - e.clientX));
    W.side.style.width = `${layout.sideWidth}px`;
  });
  sash(W.previewSash, (e) => {
    const box = editors.getBoundingClientRect();
    layout.previewWidth = Math.max(0.2, Math.min(0.75, (e.clientX - box.left) / box.width));
    W.preview.style.width = `${Math.round(layout.previewWidth * 100)}%`;
  });
  sash(W.panelSash, (e) => {
    const box = centerCol.getBoundingClientRect();
    layout.panelHeight = Math.max(90, Math.min(box.height - 120, box.bottom - e.clientY));
    W.panel.style.height = `${layout.panelHeight}px`;
  });
}

// Called from the chat page ("فتح في الاستوديو" on a code block).
const FILE_FOR_LANG = { html: 'index.html', htm: 'index.html', css: 'style.css', js: 'script.js', javascript: 'script.js' };

// Always a new project, so code from the chat never overwrites the user's files.
export async function openCodeInStudio(code, lang) {
  await initStudio();
  const name = FILE_FOR_LANG[String(lang || '').toLowerCase()] || 'script.js';
  await createProject(S.fromChatName, { [name]: String(code) });
  openFile(name);
}

async function setup() {
  loadLayout();
  const host = document.getElementById('studio-root');
  host.replaceChildren(el('div', { class: 'studio-loading' }, S.loadingEditor));
  const editorEvents = {
    onChange(value) {
      if (!active || project.files[active] === value) return;
      project.files[active] = value;
      changed(active);
    },
    onCursor: () => {
      updateStatus();
      if (agent) agent.updateChips();
    },
    onMarkers: (list) => setStaticProblems(list),
  };
  let editorNote = null;
  try {
    const monaco = await loadMonaco();
    editor = createMonacoEditor(monaco, S.editor, editorEvents);
  } catch (err) {
    // Fall back to the simple editor; the studio keeps working.
    editor = createEditor(S.editor, editorEvents);
    editorNote = S.monacoFailed;
  }
  terminal = createTerminal(S.term, {
    files: () => (project ? project.files : {}),
    projectName: () => (project ? project.name.replace(/\s+/g, '-') : ''),
    emptyFolders: () => emptyFolders,
    writeFile,
    deleteFile,
    renameFile,
    deleteFolder,
    renameFolder,
    makeFolder,
    openFile: (p) => openFile(p),
    showExplorer: () => showSide('explorer'),
    run: async () => {
      if (!layout.previewVisible) setPreviewVisible(true);
      return run();
    },
    runScript,
    evalInPreview,
    exportProject,
    askAi: (text) => askAi(text),
  });
  agent = createAgent(S.agent, {
    files: () => (project ? project.files : {}),
    writeFile: (p, content) => {
      writeFile(p, content);
      openFile(p, { noFocus: true });
    },
    deleteFile,
    restore(list) {
      for (const { path, content } of list) {
        if (content === undefined) deleteFile(path);
        else writeFile(path, content);
      }
      renderAll();
      run();
    },
    activeFile: () => active,
    cursorLine: () => (active ? editor.position().line : 0),
    selection: () => (active && editor.selectionText ? editor.selectionText() : ''),
    problems: allProblems,
    runProject: runForAgent,
    runCommand: (cmd) => {
      showPanel('terminal');
      return terminal.runForAssistant(cmd);
    },
    showDiff,
    renderMarkdown: (text) => renderMarkdown(text, { copy: ar.actions.copy, copied: ar.actions.copied, code: ar.chat.code }),
    onBusy: (b) => (W.aiBadge.hidden = !b),
    setMode: (m) => {
      layout.agentMode = m;
      saveLayout();
    },
    afterTurn: async () => {
      dirty.add('*');
      await saveNow();
    },
  });
  agent.setMode(layout.agentMode);
  defineCommands();
  palette = createPalette(S.palette, {
    commands: () => COMMANDS.filter((c) => !isDisabled(c)).map((c) => ({ id: c.id, label: c.label, key: c.key, run: c.run })),
    files: () =>
      project
        ? Object.keys(project.files)
            .sort()
            .map((p) => ({ label: baseName(p), detail: p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '', icon: fileIcon(p), run: () => openFile(p) }))
        : [],
    lineCount: () => editor.lineCount(),
    gotoLine: (n) => editor.revealLine(n),
  });

  build(host);
  applyEditorPrefs();
  if (editor.addContextAction) {
    editor.addContextAction('blazma.explain', S.cmd.explainSelection, () => askAboutSelection('explain'), 1);
    editor.addContextAction('blazma.fix', S.cmd.fixSelection, () => askAboutSelection('fix'), 2);
  }
  if (editorNote) terminal.print(editorNote, 'warn');
  showSide(layout.side);
  setSideVisible(layout.sideVisible);
  setPanelVisible(layout.panelVisible);
  showPanel(layout.panelTab);
  setPreviewVisible(layout.previewVisible);
  renderProblems();

  window.addEventListener('message', onPreviewMessage);
  document.addEventListener('keydown', onGlobalKey, true);
  window.blazma.onSetupState((s) => {
    modelState = s;
    updateStatus();
  });
  modelState = await window.blazma.getSetupState();

  const list = await window.blazma.studioList();
  if (list.length) await openProject(list[0].id);
  else await createProject(S.firstProject, starterFiles());
}

export function initStudio() {
  if (!initPromise) initPromise = setup();
  return initPromise;
}

export function setStudioVisible(v) {
  visible = v;
  if (v) initStudio();
  else if (W) {
    closeMenu();
    saveNow();
  }
}
