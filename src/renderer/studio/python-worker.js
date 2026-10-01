// Runs the project's Python in a Web Worker with Pyodide (CPython compiled
// to WebAssembly, MPL-2.0), loaded from the app's own files: no network, no
// access to the computer's files. The project is copied into a virtual
// folder (/project) for each run, and files the script writes there are sent
// back so the studio can save them.

import { loadPyodide } from '/vendor/pyodide/pyodide.mjs';

const PROJECT = '/project';
const MAX_BACK_BYTES = 1024 * 1024;

let pyodide = null;
let runId = 0;

function post(type, data) {
  self.postMessage({ type, runId, ...data });
}

async function ready() {
  if (pyodide) return pyodide;
  post('loading');
  pyodide = await loadPyodide({ indexURL: new URL('/vendor/pyodide/', self.location.href).href });
  pyodide.setStdout({ batched: (text) => post('out', { stream: 'stdout', text }) });
  pyodide.setStderr({ batched: (text) => post('out', { stream: 'stderr', text }) });
  // No keyboard input: input() gets end-of-file (EOFError).
  pyodide.setStdin({ stdin: () => null });
  return pyodide;
}

// Python helpers, defined once per runtime.
const PRELUDE = `
import os, sys, shutil, runpy, traceback

def __blazma_reset(project):
    for name, mod in list(sys.modules.items()):
        f = getattr(mod, '__file__', None) or ''
        if f.startswith(project + '/'):
            del sys.modules[name]
    shutil.rmtree(project, ignore_errors=True)
    os.makedirs(project, exist_ok=True)

def __blazma_run(project, cwd, entry, argv):
    os.chdir(os.path.join(project, cwd))
    folder = os.path.dirname(os.path.join(project, entry))
    sys.path[:] = [p for p in sys.path if not p.startswith(project)]
    sys.path.insert(0, folder)
    if os.getcwd() != folder:
        sys.path.insert(1, os.getcwd())
    sys.argv = argv
    try:
        runpy.run_path(os.path.join(project, entry), run_name='__main__')
        return 0
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        if isinstance(code, int):
            return code
        print(code, file=sys.stderr)
        return 1
    except BaseException as e:
        # Hide runpy's own frames; keep the user's.
        tb = traceback.TracebackException.from_exception(e)
        tb.stack = traceback.StackSummary.from_list([f for f in tb.stack if f.filename.startswith((project, '/tmp/blazma'))])
        print(''.join(tb.format()), end='', file=sys.stderr)
        return 1
    finally:
        sys.stdout.flush()
        sys.stderr.flush()

def __blazma_files(project, limit):
    out = {}
    for root, dirs, files in os.walk(project):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for name in files:
            full = os.path.join(root, name)
            if os.path.getsize(full) > limit:
                continue
            try:
                with open(full, encoding='utf-8') as fh:
                    out[os.path.relpath(full, project).replace(os.sep, '/')] = fh.read()
            except (UnicodeDecodeError, OSError):
                pass
    return out
`;

let preludeDone = false;

self.onmessage = async (e) => {
  const { files, entry, code, cwd = '', args = [] } = e.data;
  runId = e.data.runId;
  try {
    const py = await ready();
    if (!preludeDone) {
      py.runPython(PRELUDE);
      preludeDone = true;
    }
    py.globals.get('__blazma_reset')(PROJECT);
    for (const [path, content] of Object.entries(files)) {
      const full = `${PROJECT}/${path}`;
      py.FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
      py.FS.writeFile(full, content);
    }
    // python -c "code" runs a temporary file outside the project folder.
    let target = entry;
    if (code != null) {
      py.FS.mkdirTree('/tmp/blazma');
      py.FS.writeFile('/tmp/blazma/__main__.py', code);
      target = '/tmp/blazma/__main__.py'; // os.path.join keeps an absolute second part
    }
    const argv = py.toPy(code != null ? ['-c', ...args] : [entry, ...args]);
    const exit = py.globals.get('__blazma_run')(PROJECT, cwd, target, argv);
    argv.destroy();
    const after = py.globals.get('__blazma_files')(PROJECT, MAX_BACK_BYTES).toJs({ dict_converter: Object.fromEntries });
    const changed = {};
    for (const [path, content] of Object.entries(after)) if (files[path] !== content) changed[path] = content;
    post('done', { exit, changed });
  } catch (err) {
    post('done', { exit: 1, changed: {}, error: String((err && err.message) || err) });
  }
};
