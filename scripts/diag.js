#!/usr/bin/env node
'use strict';

// Windows diagnostics for contributors: `npm run diag`.
// Collects what the app depends on (nvidia-smi fields, the installed
// llama-server's options and devices) into diag-report.txt so it can be shared.
// The user name and home folder are redacted from the output.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const lines = [];
const home = os.homedir();
const user = os.userInfo().username;
const redact = (s) => String(s).split(home).join('~').split(user).join('<user>');
const log = (s = '') => {
  const text = redact(s);
  lines.push(text);
  console.log(text);
};
const section = (title) => log(`\n===== ${title} =====`);

function run(file, args, opts = {}) {
  try {
    return execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  } catch (err) {
    return `ERROR (${err.code || err.status}): ${(err.stdout || '') + (err.stderr || '') || err.message}`;
  }
}

section('System');
log(`platform: ${process.platform} ${os.release()} ${os.arch()}`);
log(`cpu: ${os.cpus()[0] && os.cpus()[0].model} x${os.cpus().length}`);
log(`ram: ${(os.totalmem() / 1024 ** 3).toFixed(1)} GiB`);
log(`node: ${process.version}`);
const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
log(`tar.exe present: ${fs.existsSync(tar)}`);

section('nvidia-smi');
const candidates = [
  'nvidia-smi',
  path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
];
let smi = null;
for (const c of candidates) {
  const out = run(c, ['-L']);
  log(`${c}: ${out.startsWith('ERROR') ? 'not usable' : 'OK'}`);
  if (!smi && !out.startsWith('ERROR')) smi = c;
}
if (smi) {
  log(run(smi, ['-L']).trim());
  log(run(smi, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']).trim());
  const header = run(smi, []);
  log(`header: ${(/CUDA Version:\s*[\d.]+/.exec(header) || ['CUDA Version not found'])[0]}`);

  // Fields phase 2 wants; report which ones this driver knows.
  const help = run(smi, ['--help-query-gpu']);
  const wanted = [
    'name', 'driver_version', 'utilization.gpu', 'memory.used', 'memory.total', 'power.draw',
    'power.draw.instant', 'power.limit', 'enforced.power.limit', 'temperature.gpu', 'fan.speed',
    'clocks.gr', 'clocks.mem', 'clocks.max.gr', 'pstate', 'clocks_event_reasons.active',
    'clocks_throttle_reasons.active', 'temperature.gpu.tlimit',
  ];
  log('query-gpu fields known by this driver:');
  for (const f of wanted) log(`  ${help.includes(`"${f}"`) ? 'yes' : 'NO '} ${f}`);
  const q = wanted.filter((f) => help.includes(`"${f}"`));
  log('sample reading:');
  log(`  ${q.join(', ')}`);
  log(`  ${run(smi, [`--query-gpu=${q.join(',')}`, '--format=csv,noheader']).trim()}`);
  const appsHelp = run(smi, ['--help-query-compute-apps']);
  log(`compute-apps fields: pid=${appsHelp.includes('"pid"')} used_memory=${appsHelp.includes('"used_memory"')} process_name=${appsHelp.includes('"process_name"')}`);
  log(run(smi, ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader']).trim() || '(no compute apps)');
}

section('Blazma AI engine');
const userData = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Blazma AI');
const current = path.join(userData, 'engine', 'current.json');
if (fs.existsSync(current)) {
  const info = JSON.parse(fs.readFileSync(current, 'utf8'));
  log(`installed: ${info.tag} ${info.variant} (fallback from: ${(info.fallbackFrom || []).join(', ') || 'none'})`);
  const exe = path.join(info.dir, 'llama-server.exe');
  log(`dlls: ${fs.readdirSync(info.dir).filter((f) => f.endsWith('.dll')).join(', ')}`);
  log(run(exe, ['--version'], { cwd: info.dir }).trim());
  log(run(exe, ['--list-devices'], { cwd: info.dir }).trim());
  const help = run(exe, ['--help'], { cwd: info.dir });
  log('options used by the app:');
  for (const o of ['-hf', '--jinja', '--no-mmproj', '-ngl', '-c,', '--host', '--port', '--no-webui', '--cors-origins', '--api-key', '--offline', '--list-devices']) {
    log(`  ${help.includes(o) ? 'yes' : 'NO '} ${o.replace(/,$/, '')}`);
  }
} else {
  log('engine not installed yet (start the app and install first)');
}
const settingsFile = path.join(userData, 'settings.json');
if (fs.existsSync(settingsFile)) log(`settings: ${fs.readFileSync(settingsFile, 'utf8').replace(/\s+/g, ' ')}`);

section('Running llama-server processes');
log(run('tasklist', ['/FI', 'IMAGENAME eq llama-server.exe', '/FO', 'CSV', '/NH']).trim());

fs.writeFileSync('diag-report.txt', lines.join('\n'), 'utf8');
console.log('\nSaved to diag-report.txt');
