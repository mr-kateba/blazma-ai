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

  const q = await run(smi, ['--query-gpu=index,name,memory.total,driver_version', '--format=csv,noheader,nounits']);
  if (!q.ok) return { available: false, reason: 'query-failed' };

  const gpus = q.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .map(parseCsvLine)
    .map(([index, name, memTotal, driver]) => ({ index: Number(index), name, vramMB: Number.parseInt(memTotal, 10), driver }))
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

// ---------- live readings ----------

// Readings we would like, by nvidia-smi query field. Which of these exist is
// decided at runtime from `nvidia-smi --help-query-gpu` on the user's driver;
// where two names are listed the first one available is used.
const FIELDS = {
  util: ['utilization.gpu'],
  memUtil: ['utilization.memory'],
  memUsed: ['memory.used'],
  memTotal: ['memory.total'],
  power: ['power.draw', 'power.draw.instant'],
  powerLimit: ['enforced.power.limit', 'power.limit'],
  powerMax: ['power.max_limit'],
  temp: ['temperature.gpu'],
  fan: ['fan.speed'],
  clockGr: ['clocks.gr'],
  clockMem: ['clocks.mem'],
  clockGrMax: ['clocks.max.gr'],
  clockMemMax: ['clocks.max.mem'],
  pstate: ['pstate'],
};
const REASONS = ['gpu_idle', 'sw_power_cap', 'hw_slowdown', 'hw_thermal_slowdown', 'sw_thermal_slowdown', 'hw_power_brake_slowdown'];
for (const r of REASONS) FIELDS[`reason:${r}`] = [`clocks_event_reasons.${r}`, `clocks_throttle_reasons.${r}`];

let plan; // [{ key, field }] chosen for this driver

async function queryPlan() {
  if (plan) return plan;
  const smi = await findNvidiaSmi();
  const help = smi ? await run(smi, ['--help-query-gpu']) : { ok: false, stdout: '' };
  const known = new Set([...help.stdout.matchAll(/"([a-z0-9_.]+)"/gi)].map((m) => m[1]));
  plan = [];
  for (const [key, names] of Object.entries(FIELDS)) {
    const field = names.find((n) => known.has(n));
    if (field) plan.push({ key, field });
  }
  return plan;
}

// nvidia-smi prints "[N/A]", "[Not Supported]" or "N/A" for readings the
// card or driver does not provide; those become null ("غير متاح").
function parseValue(key, raw) {
  const v = (raw || '').trim();
  if (!v || /^\[.*\]$/.test(v) || /^n\/a$/i.test(v)) return null;
  if (key.startsWith('reason:')) return /^active$/i.test(v);
  if (key === 'pstate') return v;
  const n = Number.parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function sampleGpu(index) {
  const smi = await findNvidiaSmi();
  const fields = await queryPlan();
  if (!smi || !fields.length) return null;
  const r = await run(smi, [`--query-gpu=${fields.map((f) => f.field).join(',')}`, '--format=csv,noheader,nounits', '-i', String(index)]);
  if (!r.ok) return null;
  const values = r.stdout.trim().split(/\r?\n/)[0].split(',');
  const out = { reasons: {} };
  fields.forEach((f, i) => {
    const value = parseValue(f.key, values[i]);
    if (f.key.startsWith('reason:')) out.reasons[f.key.slice(7)] = value;
    else out[f.key] = value;
  });
  return out;
}

// Official limits the driver reports for this card (nvidia-smi -q output is
// not localized). Used as default alert thresholds.
async function temperatureLimits(index) {
  const smi = await findNvidiaSmi();
  if (!smi) return {};
  const r = await run(smi, ['-q', '-d', 'TEMPERATURE', '-i', String(index)]);
  const pick = (label) => {
    const m = new RegExp(`^\\s*${label}\\s*:\\s*(\\d+)\\s*C`, 'mi').exec(r.stdout);
    return m ? Number(m[1]) : null;
  };
  return {
    maxOperating: pick('GPU Max Operating Temp'),
    slowdown: pick('GPU Slowdown Temp'),
    shutdown: pick('GPU Shutdown Temp'),
    target: pick('GPU Target Temperature'),
  };
}

// VRAM used by one process. Under Windows' default (WDDM) driver mode this is
// often "[N/A]"; the caller then falls back to Windows GPU counters.
async function processVramMB(pid) {
  const smi = await findNvidiaSmi();
  if (!smi || !pid) return null;
  const r = await run(smi, ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits']);
  if (!r.ok) return null;
  for (const line of r.stdout.split(/\r?\n/)) {
    const [p, mem] = parseCsvLine(line);
    if (Number(p) === pid) return parseValue('mem', mem);
  }
  return null;
}

module.exports = { findNvidiaSmi, detectNvidia, queryPlan, sampleGpu, temperatureLimits, processVramMB };
