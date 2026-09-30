'use strict';

// Finds, downloads, verifies and tests a Windows build of llama.cpp from the
// latest GitHub release. Asset names are read from the release at runtime and
// matched by pattern; see docs/PLAN.md for the naming this relies on.

const fs = require('node:fs');
const path = require('node:path');
const { net } = require('electron');
const paths = require('./paths');
const { run } = require('./exec');
const { readJson, writeJson } = require('./jsonfile');
const { downloadFile, freeBytes } = require('./download');
const { extractZip } = require('./extract');
const { AppError } = require('./errors');

const RELEASES_API = 'https://api.github.com/repos/ggml-org/llama.cpp/releases';
const EXE_NAME = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';

const currentFile = () => path.join(paths.engineRoot(), 'current.json');

async function githubJson(url) {
  let res;
  try {
    res = await net.fetch(url, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Blazma-AI' } });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  if (!res.ok) throw new AppError('engine-release', `GitHub API HTTP ${res.status} for ${url}`);
  return res.json();
}

function toRelease(json) {
  return {
    tag: String(json.tag_name || ''),
    assets: (json.assets || []).map((a) => ({
      name: a.name,
      size: a.size,
      url: a.browser_download_url,
      sha256: /^sha256:([a-f0-9]{64})$/i.exec(a.digest || '')?.[1] || null,
    })),
  };
}

// Windows builds are published as prereleases named bNNNN (release.yml,
// `prerelease: true`), while the release GitHub marks "latest" is a
// versioned one (e.g. v0.5.0, make-release.yml) without Windows archives.
// So take the newest non-draft release that has usable Windows assets.
async function findRelease(nvidia) {
  const recent = await githubJson(`${RELEASES_API}?per_page=15`);
  const releases = (Array.isArray(recent) ? recent : []).filter((r) => !r.draft).map(toRelease);
  const usable = releases.find((r) => planVariants(r.assets, nvidia).length);
  if (usable) return usable;
  throw new AppError(
    'engine-no-asset',
    releases.map((r) => `${r.tag}: ${r.assets.filter((a) => /win/i.test(a.name)).length} windows assets`).join('\n') || 'no releases',
  );
}

// Ordered list of builds to try: newest CUDA the driver supports, older CUDA,
// then Vulkan, then CPU. Without an NVIDIA GPU only the CPU build is used.
function planVariants(assets, nvidia) {
  const variants = [];

  if (nvidia && nvidia.available) {
    const cudaBuilds = [];
    for (const a of assets) {
      const m = /^llama-.+-bin-win-cuda-(\d+)\.(\d+)-x64\.zip$/.exec(a.name);
      if (!m) continue;
      const runtime = assets.find((r) => r.name === `cudart-llama-bin-win-cuda-${m[1]}.${m[2]}-x64.zip`);
      if (!runtime) continue;
      const major = Number(m[1]);
      // CUDA minor-version compatibility: a driver supporting CUDA X.y runs
      // any X.z build, but never a newer major version.
      if (nvidia.cuda && major > nvidia.cuda.major) continue;
      cudaBuilds.push({ id: `cuda-${m[1]}.${m[2]}`, kind: 'cuda', major, minor: Number(m[2]), files: [a, runtime] });
    }
    cudaBuilds.sort((x, y) => y.major - x.major || y.minor - x.minor);
    variants.push(...cudaBuilds);

    const vulkan = assets.find((a) => /^llama-.+-bin-win-vulkan-x64\.zip$/.test(a.name));
    if (vulkan) variants.push({ id: 'vulkan', kind: 'vulkan', files: [vulkan] });
  }

  const cpu = assets.find((a) => /^llama-.+-bin-win-cpu-x64\.zip$/.test(a.name));
  if (cpu) variants.push({ id: 'cpu', kind: 'cpu', files: [cpu] });
  return variants;
}

function findExeDir(root, depth = 2) {
  if (fs.existsSync(path.join(root, EXE_NAME))) return root;
  if (depth === 0) return null;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findExeDir(path.join(root, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function installVariant(tag, variant, onProgress) {
  const root = paths.engineRoot();
  const target = path.join(root, `${tag}-${variant.id}`);
  const existing = fs.existsSync(target) ? findExeDir(target) : null;
  if (existing) return existing;

  const total = variant.files.reduce((s, f) => s + f.size, 0);
  const needed = total * 3; // archives + extracted files + margin
  if ((await freeBytes(root)) < needed) throw new AppError('disk-full', `need ${needed} bytes for engine`);

  const dlDir = path.join(root, 'downloads');
  fs.mkdirSync(dlDir, { recursive: true });
  let before = 0;
  for (const file of variant.files) {
    const dest = path.join(dlDir, file.name);
    if (!fs.existsSync(dest)) {
      await downloadFile(file.url, dest, {
        expectedSize: file.size,
        sha256: file.sha256,
        onProgress: (done) => onProgress({ stage: 'download', done: before + done, total }),
      });
    }
    before += file.size;
  }

  onProgress({ stage: 'extract', done: total, total });
  const tmp = `${target}.tmp`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const [main, ...runtimes] = variant.files;
  await extractZip(path.join(dlDir, main.name), tmp);
  const exeDir = findExeDir(tmp);
  if (!exeDir) throw new AppError('engine-extract', `${EXE_NAME} not found in ${main.name}`);
  // CUDA runtime DLLs (cudart, cublas) must sit next to llama-server.exe.
  for (const rt of runtimes) await extractZip(path.join(dlDir, rt.name), exeDir);

  fs.renameSync(tmp, target);
  for (const file of variant.files) fs.rmSync(path.join(dlDir, file.name), { force: true });
  return findExeDir(target);
}

// Asks the build which devices it can use. A CUDA build that cannot load its
// backend (old driver, missing DLL) lists no CUDA device.
async function testVariant(exeDir, variant) {
  const r = await run(path.join(exeDir, EXE_NAME), ['--list-devices'], { cwd: exeDir, timeoutMs: 60000 });
  const out = `${r.stdout}\n${r.stderr}`;
  let ok = r.ok;
  if (variant.kind === 'cuda') ok = ok && /^\s*CUDA\d+:/m.test(out);
  if (variant.kind === 'vulkan') ok = ok && /^\s*Vulkan\d+:/m.test(out);
  return { ok, output: out.trim() };
}

function installedEngine() {
  if (process.env.BLAZMA_LLAMA_SERVER) {
    // Development only: use a locally built llama-server instead of a release.
    const exe = process.env.BLAZMA_LLAMA_SERVER;
    return { exe, dir: path.dirname(exe), tag: 'dev', variant: 'dev', kind: 'dev' };
  }
  const cur = readJson(currentFile(), null);
  if (!cur || typeof cur.dir !== 'string') return null;
  const exe = path.join(cur.dir, EXE_NAME);
  return fs.existsSync(exe) ? { ...cur, exe } : null;
}

// Downloads and tests the builds of one release in order, keeping the first
// that works. current.json changes only after a build passes its test.
async function installRelease(release, nvidia, onProgress) {
  const variants = planVariants(release.assets, nvidia);
  const failures = [];
  for (const variant of variants) {
    onProgress({ stage: 'download', variant: variant.id, done: 0, total: 0 });
    const dir = await installVariant(release.tag, variant, (p) => onProgress({ ...p, variant: variant.id }));
    onProgress({ stage: 'test', variant: variant.id });
    const test = await testVariant(dir, variant);
    if (test.ok) {
      const info = {
        tag: release.tag,
        variant: variant.id,
        kind: variant.kind,
        dir,
        fallbackFrom: failures.map((f) => f.variant),
      };
      writeJson(currentFile(), info);
      return { ...info, exe: path.join(dir, EXE_NAME) };
    }
    failures.push({ variant: variant.id, output: test.output.slice(-2000) });
    fs.rmSync(path.join(paths.engineRoot(), `${release.tag}-${variant.id}`), { recursive: true, force: true });
  }
  throw new AppError('engine-test-failed', failures.map((f) => `[${f.variant}]\n${f.output}`).join('\n\n'));
}

async function ensureEngine({ nvidia, onProgress }) {
  const installed = installedEngine();
  if (installed) return installed;
  if (process.platform !== 'win32') throw new AppError('unsupported-os', process.platform);

  onProgress({ stage: 'release' });
  const release = await findRelease(nvidia);
  return installRelease(release, nvidia, onProgress);
}

// Release tags are bNNNN; a larger number is newer.
const tagNumber = (tag) => Number(/^b(\d+)$/.exec(String(tag))?.[1] || 0);

// User-initiated from the settings page. The old build is removed only after
// the new one passed its test.
async function updateEngine({ nvidia, onProgress }) {
  const installed = installedEngine();
  if (installed && installed.kind === 'dev') throw new AppError('engine-dev');
  if (process.platform !== 'win32') throw new AppError('unsupported-os', process.platform);
  onProgress({ stage: 'release' });
  const release = await findRelease(nvidia);
  if (installed && tagNumber(release.tag) <= tagNumber(installed.tag)) return { updated: false, tag: installed.tag };
  const info = await installRelease(release, nvidia, onProgress);
  if (installed && installed.dir) {
    const oldTop = path.join(paths.engineRoot(), `${installed.tag}-${installed.variant}`);
    if (oldTop !== path.join(paths.engineRoot(), `${info.tag}-${info.variant}`)) fs.rmSync(oldTop, { recursive: true, force: true });
  }
  return { updated: true, tag: info.tag, variant: info.variant };
}

module.exports = { ensureEngine, updateEngine, installedEngine, planVariants, findRelease, tagNumber };
