// Python for the studio: one Web Worker running Pyodide (see python-worker.js).
// The first run loads the runtime (a few seconds); later runs reuse it. A run
// that does not finish in time is stopped by ending the worker.

const TIMEOUT_MS = 60000;

export function createPythonRunner() {
  let worker = null;
  let current = null; // { runId, resolve, onOutput, onLoading, timer }
  let nextId = 1;

  function start() {
    worker = new Worker(new URL('./python-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (!current || msg.runId !== current.runId) return;
      if (msg.type === 'loading') current.onLoading();
      else if (msg.type === 'out') current.onOutput(msg.stream, msg.text);
      else if (msg.type === 'done') finish({ exit: msg.exit, changed: msg.changed || {}, error: msg.error || null });
    };
    worker.onerror = (e) => {
      e.preventDefault();
      kill();
      finish({ exit: 1, changed: {}, error: e.message || 'worker error' });
    };
  }

  function kill() {
    if (worker) worker.terminate();
    worker = null;
  }

  function finish(result) {
    if (!current) return;
    clearTimeout(current.timer);
    const { resolve } = current;
    current = null;
    resolve(result);
  }

  // job: { files, entry } or { files, code }, plus cwd and args.
  // Resolves { exit, changed, error, timedOut }.
  function run(job, { onOutput = () => {}, onLoading = () => {} } = {}) {
    if (current) stop();
    if (!worker) start();
    return new Promise((resolve) => {
      const runId = nextId++;
      current = {
        runId,
        resolve,
        onOutput,
        onLoading,
        timer: setTimeout(() => {
          kill();
          finish({ exit: 1, changed: {}, error: null, timedOut: true });
        }, TIMEOUT_MS),
      };
      worker.postMessage({ runId, ...job });
    });
  }

  // Stops a running script (the runtime is loaded again next time).
  function stop() {
    if (!current) return false;
    kill();
    finish({ exit: 1, changed: {}, error: null, stopped: true });
    return true;
  }

  return { run, stop, running: () => Boolean(current) };
}
