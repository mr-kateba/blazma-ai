// Monaco Editor (MIT), the editor of VS Code, served locally from
// app://blazma/vendor/monaco/vs (see src/main/protocol.js). Exposes the same
// interface as editor.js so the studio can fall back to the simple editor
// if Monaco fails to load. One Monaco model per project file keeps undo
// history and lets the language services see all files.

import { el } from '../lib/dom.js';
import { languageOf } from './highlight.js';

const BASE = 'vendor/monaco/vs';
const MONACO_LANG = { html: 'html', js: 'javascript', css: 'css', json: 'json', md: 'markdown', text: 'plaintext' };
const FONT = "'Cascadia Mono', Consolas, 'Plex Arabic Code', 'Courier New', monospace";

let loading = null;

export function loadMonaco(timeoutMs = 20000) {
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('monaco-timeout')), timeoutMs);
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = `${BASE}/editor/editor.main.css`;
    document.head.append(css);
    const script = document.createElement('script');
    script.src = `${BASE}/loader.js`;
    script.onerror = () => {
      clearTimeout(timer);
      reject(new Error('monaco-loader'));
    };
    script.onload = () => {
      window.require.config({ paths: { vs: BASE } });
      window.require(
        ['vs/index'],
        (monaco) => {
          clearTimeout(timer);
          resolve(monaco);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    };
    document.head.append(script);
  });
  return loading;
}

export function createMonacoEditor(monaco, labels, { onChange, onCursor, onMarkers, onKey } = {}) {
  const host = el('div', { class: 'mon-host' });
  const root = el('div', { class: 'ed mon', dir: 'ltr' }, host);
  const models = new Map(); // path -> model
  let active = null;
  let silent = false;

  // Suggestions and hovers live outside the editor so panels do not clip
  // them; they need a left-to-right container (the app itself is RTL).
  const overflow = el('div', { class: 'monaco-editor mon-overflow', dir: 'ltr' });
  document.body.append(overflow);

  const editor = monaco.editor.create(host, {
    model: null,
    theme: 'vs-dark',
    fontFamily: FONT,
    fontSize: 14,
    lineHeight: 20,
    tabSize: 2,
    insertSpaces: true,
    automaticLayout: true,
    minimap: { enabled: true },
    wordWrap: 'off',
    smoothScrolling: true,
    cursorBlinking: 'smooth',
    cursorSmoothCaretAnimation: 'on',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: 'active', indentation: true },
    stickyScroll: { enabled: true },
    fixedOverflowWidgets: true,
    overflowWidgetsDomNode: overflow,
    // The EditContext input mode did not accept suggestions with Enter in our
    // tests; the textarea mode works, and handles Arabic input well.
    editContext: false,
    // Arabic text is normal here; do not flag it as unusual characters.
    unicodeHighlight: { ambiguousCharacters: false, nonBasicASCII: false, invisibleCharacters: true },
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    padding: { top: 8 },
  });

  const uriFor = (path) => monaco.Uri.from({ scheme: 'file', path: `/project/${path}` });
  const pathOf = (uri) => (uri.path.startsWith('/project/') ? uri.path.slice('/project/'.length) : null);

  function modelFor(path, text) {
    let model = models.get(path);
    if (!model) {
      model = monaco.editor.createModel(text, MONACO_LANG[languageOf(path)], uriFor(path));
      model.onDidChangeContent(() => {
        if (!silent && model === editor.getModel() && onChange) onChange(model.getValue());
      });
      models.set(path, model);
    } else if (model.getValue() !== text) {
      silent = true;
      model.setValue(text);
      silent = false;
    }
    return model;
  }

  editor.onDidChangeCursorSelection(() => onCursor && onCursor(position()));
  if (onKey) editor.onKeyDown((e) => onKey(e.browserEvent));

  function reportMarkers() {
    if (!onMarkers) return;
    const list = [];
    for (const [path, model] of models) {
      for (const m of monaco.editor.getModelMarkers({ resource: model.uri })) {
        if (m.severity < monaco.MarkerSeverity.Warning) continue;
        list.push({
          level: m.severity >= monaco.MarkerSeverity.Error ? 'error' : 'warn',
          text: m.message,
          file: path,
          line: m.startLineNumber,
          col: m.startColumn,
          source: 'editor',
        });
      }
    }
    onMarkers(list);
  }
  monaco.editor.onDidChangeMarkers((uris) => {
    if (uris.some((u) => pathOf(u) !== null)) reportMarkers();
  });

  function position() {
    const pos = editor.getPosition() || { lineNumber: 1, column: 1 };
    const sel = editor.getSelection();
    const model = editor.getModel();
    const selected = sel && model ? model.getValueInRange(sel).length : 0;
    return { line: pos.lineNumber, col: pos.column, selected };
  }

  return {
    root,
    kind: 'monaco',
    setDoc(text, path) {
      active = path;
      const model = modelFor(path, text);
      editor.setModel(model);
      editor.updateOptions({ readOnly: false });
    },
    // Replace the text keeping undo history (used when the model or terminal writes the open file).
    replaceAll(text) {
      const model = editor.getModel();
      if (!model || model.getValue() === text) return;
      silent = true;
      editor.pushUndoStop();
      editor.executeEdits('blazma', [{ range: model.getFullModelRange(), text }]);
      editor.pushUndoStop();
      silent = false;
    },
    // Keep a background file's model in sync (not open in the editor).
    syncFile(path, text) {
      if (models.has(path) && path !== active) modelFor(path, text);
    },
    dropModel(path) {
      const model = models.get(path);
      if (!model) return;
      if (editor.getModel() === model) editor.setModel(null);
      model.dispose();
      models.delete(path);
      reportMarkers();
    },
    reset() {
      editor.setModel(null);
      for (const m of models.values()) m.dispose();
      models.clear();
      active = null;
      reportMarkers();
    },
    viewState: () => editor.saveViewState(),
    restoreView(v) {
      if (v) editor.restoreViewState(v);
    },
    clear() {
      active = null;
      editor.setModel(null);
    },
    value: () => (editor.getModel() ? editor.getModel().getValue() : ''),
    focus: () => editor.focus(),
    position,
    language: () => (active ? languageOf(active) : 'text'),
    revealLine(line, col = 1) {
      editor.setPosition({ lineNumber: line, column: col });
      editor.revealLineInCenter(line);
      editor.focus();
    },
    trigger(id) {
      editor.focus();
      editor.trigger('blazma', id, null);
    },
    // Adds an entry to the editor's right-click menu.
    addContextAction(id, label, run, order = 1) {
      editor.addAction({ id, label, contextMenuGroupId: '0_blazma', contextMenuOrder: order, run: () => run() });
    },
    openFind: () => {
      editor.focus();
      editor.trigger('blazma', 'actions.find', null);
    },
    toggleComment: () => {
      editor.focus();
      editor.trigger('blazma', 'editor.action.commentLine', null);
    },
    format: () => {
      editor.focus();
      return editor.getAction('editor.action.formatDocument')?.run();
    },
    selectionText() {
      const sel = editor.getSelection();
      const model = editor.getModel();
      return sel && model ? model.getValueInRange(sel) : '';
    },
    setOptions(opts) {
      editor.updateOptions(opts);
    },
    lineCount: () => (editor.getModel() ? editor.getModel().getLineCount() : 0),
    // A read-only side-by-side diff (used to review the assistant's changes).
    showDiff(container, before, after, path) {
      const lang = MONACO_LANG[languageOf(path)];
      const original = monaco.editor.createModel(before, lang);
      const modified = monaco.editor.createModel(after, lang);
      const diff = monaco.editor.createDiffEditor(container, {
        theme: 'vs-dark',
        readOnly: true,
        automaticLayout: true,
        fontFamily: FONT,
        fontSize: 13,
        renderSideBySide: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
      });
      diff.setModel({ original, modified });
      return () => {
        diff.dispose();
        original.dispose();
        modified.dispose();
      };
    },
  };
}
