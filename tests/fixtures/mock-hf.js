// Local stand-in for huggingface.co, used only for testing in the sandbox.
// Serves unsloth/<Name>-GGUF repos from files in DIR named <Name>-Q4_K_M.gguf
// (falling back to the 0.8B file), supports HEAD/Range/ETag, throttles
// bandwidth, and simulates a network cut via GET /__cut?seconds=N.
// Any other repo is served from DIR/repos/<owner>/<repo>/<path> (file list
// and resolve), and plain files from DIR/files/<name> (program archives).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const DIR = process.argv[2]; const PORT = +process.argv[3] || 18999;
const RATE = +(process.env.RATE || 40e6);
const COMMIT = '6ab461498e2023f6e3c1baea90a8f0fe38ab64d0';
const FALLBACK = 'Qwen3.5-0.8B-Q4_K_M.gguf';
const shaCache = {};
// A repo's own projector when DIR has <Name>-mmproj-BF16.gguf, else the shared one.
const mmFor = (base) => (fs.existsSync(path.join(DIR, `${base}-mmproj-BF16.gguf`)) ? `${base}-mmproj-BF16.gguf` : 'mmproj-BF16.gguf');
function info(name) {
  const file = fs.existsSync(path.join(DIR, name)) ? name : FALLBACK;
  const full = fs.realpathSync(path.join(DIR, file));
  if (!shaCache[full]) shaCache[full] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  return { full, size: fs.statSync(full).size, oid: shaCache[full] };
}
let cutUntil = 0; const sockets = new Set();
const json = (res, o) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
const srv = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  console.log(new Date().toISOString(), req.method, req.url, req.headers.range || '');
  if (u.pathname === '/__cut') { cutUntil = Date.now() + (+u.searchParams.get('seconds') || 10) * 1000; res.end('cut'); for (const s of sockets) s.destroy(); return; }
  if (Date.now() < cutUntil) { req.socket.destroy(); return; }
  // Plain files and generic repos (see the header).
  const plainFile = /^\/files\/([\w.-]+)$/.exec(u.pathname);
  const tree = /^\/api\/models\/([\w.-]+\/[\w.-]+)\/tree\/[^/]+\/?(.*)$/.exec(u.pathname);
  const resolve = /^\/([\w.-]+\/[\w.-]+)\/resolve\/[^/]+\/(.+)$/.exec(u.pathname);
  const repoDir = (r) => path.join(DIR, 'repos', r);
  if (tree && fs.existsSync(repoDir(tree[1]))) {
    const dir = path.join(repoDir(tree[1]), tree[2]);
    if (!fs.existsSync(dir)) { res.writeHead(404); return res.end('{"error":"not found"}'); }
    return json(res, fs.readdirSync(dir).map((n) => {
      const full = path.join(dir, n), st = fs.statSync(full), rel = path.posix.join(tree[2], n);
      if (st.isDirectory()) return { type: 'directory', oid: 'f'.repeat(40), size: 0, path: rel };
      const lfs = st.size > 1e6 ? { oid: crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex'), size: st.size, pointerSize: 134 } : undefined;
      return { type: 'file', oid: '1'.repeat(40), size: st.size, path: rel, ...(lfs ? { lfs } : {}) };
    }));
  }
  const served = plainFile ? path.join(DIR, 'files', plainFile[1]) : resolve && fs.existsSync(repoDir(resolve[1])) ? path.join(repoDir(resolve[1]), resolve[2]) : null;
  if (served) {
    if (!fs.existsSync(served) || !served.startsWith(DIR)) { res.writeHead(404); return res.end('not found'); }
    const size = fs.statSync(served).size;
    res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(served).pipe(res);
  }
  const m = /^\/(api\/models\/)?(unsloth\/([\w.-]+)-GGUF)(\/.*)?$/.exec(u.pathname);
  if (!m) { res.writeHead(404); return res.end('{"error":"not found"}'); }
  const [, api, repo, base, rest = ''] = m; const name = `${base}-Q4_K_M.gguf`;
  if (api) {
    if (rest === '/refs') return json(res, { tags: [], branches: [{ name: 'main', ref: 'refs/heads/main', targetCommit: COMMIT }], converts: [] });
    if (rest.startsWith('/tree/')) {
      const f = info(name), mm = info(mmFor(base));
      const entry = (p, x) => ({ type: 'file', oid: 'e'.repeat(40), size: x.size, lfs: { oid: x.oid, size: x.size, pointerSize: 134 }, path: p });
      // Same listing order as Hugging Face (alphabetical); only BF16 is downloadable here.
      return json(res, [entry(name, f), entry('mmproj-BF16.gguf', mm), { type: 'file', oid: 'a'.repeat(40), size: 1, lfs: { oid: 'b'.repeat(64), size: 668227264, pointerSize: 134 }, path: 'mmproj-F16.gguf' }, { type: 'file', oid: 'c'.repeat(40), size: 1, lfs: { oid: 'd'.repeat(64), size: 1325684416, pointerSize: 134 }, path: 'mmproj-F32.gguf' }].sort((a, b) => a.path < b.path ? -1 : 1));
    }
    if (rest === '') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ id: repo })); }
  }
  const fileReq = /^\/resolve\/[^/]+\/(.+)$/.exec(rest);
  if (fileReq && (fileReq[1] === name || fileReq[1] === 'mmproj-BF16.gguf')) {
    const f = info(fileReq[1] === 'mmproj-BF16.gguf' ? mmFor(base) : fileReq[1]);
    const headers = { ETag: `"${f.oid}"`, 'Accept-Ranges': 'bytes', 'Content-Type': 'application/octet-stream' };
    let start = 0, end = f.size - 1, status = 200;
    const r = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (r) { start = +r[1]; if (r[2]) end = +r[2]; status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${f.size}`; }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    (async () => {
      const fd = await fs.promises.open(f.full, 'r'); const buf = Buffer.alloc(256 * 1024); let pos = start; const t0 = Date.now(); let sent = 0;
      try {
        while (pos <= end && !res.destroyed) {
          const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, end - pos + 1), pos);
          if (!bytesRead) break; pos += bytesRead; sent += bytesRead;
          if (!res.write(buf.subarray(0, bytesRead))) await new Promise(r2 => res.once('drain', r2));
          const wait = sent / RATE * 1000 - (Date.now() - t0); if (wait > 0) await new Promise(r2 => setTimeout(r2, wait));
        }
      } catch {} finally { await fd.close(); if (!res.destroyed) res.end(); }
    })();
    return;
  }
  res.writeHead(404); res.end('{"error":"not found"}');
});
srv.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
srv.listen(PORT, '127.0.0.1', () => console.log('mock-hf on', PORT));
