'use strict';

const path = require('node:path');
const { run } = require('../exec');

let smiPath; // undefined = not searched yet, null = not found

function smiCandidates() {
  const list = ['nvidia-smi'];
  if (process.platform === 'win32') {
    const sysRoot = process.env.SystemRoot || 'C:\\Windows';
    const progFiles = process.env.ProgramFiles || 'C:\\Program Files';
    list.push(
      path.join(sysRoot, 'System32', 'nvidia-smi.exe'),
      path.join(progFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    );
  }
  return list;
}

async function findNvidiaSmi() {
  if (smiPath !== undefined) return smiPath;
  smiPath = null;
  for (const candidate of smiCandidates()) {
    const r = await run(candidate, ['-L'], { timeoutMs: 10000 });
    if (r.ok) {
      smiPath = candidate;
      break;
    }
  }
  return smiPath;
}

function parseCsvLine(line) {
  return line.split(',').map((s) => s.trim());
}

// Basic NVIDIA detection used for choosing the engine build and the model.
async function detectNvidia() {
  const smi = await findNvidiaSmi();
  if (!smi) return { available: false, reason: 'no-nvidia-smi' };

  const q = await run(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!q.ok) return { available: false, reason: 'query-failed' };

  const gpus = q.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine)
    .map(([name, memTotal, driver]) => ({ name, vramMB: Number.parseInt(memTotal, 10), driver }))
    .filter((g) => g.name && Number.isFinite(g.vramMB));
  if (!gpus.length) return { available: false, reason: 'no-gpus' };

  // The plain header is the only place nvidia-smi reports the highest CUDA
  // version the installed driver supports.
  const header = await run(smi, []);
  const m = /CUDA Version:\s*(\d+)\.(\d+)/.exec(header.stdout);
  const cuda = m ? { major: Number(m[1]), minor: Number(m[2]) } : null;

  const best = gpus.reduce((a, b) => (b.vramMB > a.vramMB ? b : a));
  return { available: true, gpus, best, cuda };
}

module.exports = { findNvidiaSmi, detectNvidia };
