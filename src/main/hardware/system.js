'use strict';

// CPU, memory, storage and general system readings. Windows-only details
// (RAM type, board, battery, CPU clock, per-process GPU memory) come from
// PowerShell/CIM; everything else from Node's os module.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { run } = require('../exec');

// ---------- PowerShell helpers ----------
// Scripts are fixed text passed with -EncodedCommand (files inside the app's
// asar archive cannot be read by PowerShell). The only value ever sent to a
// script is a process ID, parsed there as an integer.

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

// CIM "Win32_PerfFormattedData_*" classes use English property names on every
// Windows display language, unlike Get-Counter paths.
const STATIC_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$cs = Get-CimInstance Win32_ComputerSystem
$bb = Get-CimInstance Win32_BaseBoard
$osi = Get-CimInstance Win32_OperatingSystem
$out = [ordered]@{
  cpu = @{ name = $cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; maxClockMHz = $cpu.MaxClockSpeed }
  memoryModules = @(Get-CimInstance Win32_PhysicalMemory | ForEach-Object { @{ capacity = [double]$_.Capacity; smbiosType = $_.SMBIOSMemoryType; speed = $_.Speed; configuredSpeed = $_.ConfiguredClockSpeed } })
  system = @{ manufacturer = $cs.Manufacturer; model = $cs.Model; pcSystemType = $cs.PCSystemType }
  board = @{ manufacturer = $bb.Manufacturer; product = $bb.Product }
  os = @{ caption = $osi.Caption; version = $osi.Version; build = $osi.BuildNumber }
  videoControllers = @(Get-CimInstance Win32_VideoController | ForEach-Object { @{ name = $_.Name; driverVersion = $_.DriverVersion } })
  hasBattery = [bool](Get-CimInstance Win32_Battery)
}
$out | ConvertTo-Json -Compress -Depth 4
`;

const SAMPLER_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $procId = 0
  [void][int]::TryParse($line.Trim(), [ref]$procId)
  $out = @{}
  $pi = Get-CimInstance Win32_PerfFormattedData_Counters_ProcessorInformation -Filter "Name='_Total'"
  if ($pi) { $out.cpuPerfPct = [double]$pi.PercentProcessorPerformance }
  $bat = Get-CimInstance Win32_Battery | Select-Object -First 1
  if ($bat) { $out.batteryPct = [double]$bat.EstimatedChargeRemaining; $out.batteryStatus = [int]$bat.BatteryStatus }
  if ($procId -gt 0) {
    $p = Get-Process -Id $procId
    if ($p) { $out.serverWorkingSet = [double]$p.WorkingSet64 }
    $prefix = "pid_" + $procId + "_*"
    $g = Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUProcessMemory | Where-Object { $_.Name -like $prefix }
    if ($g) { $out.serverGpuDedicated = [double](($g | Measure-Object -Property DedicatedUsage -Sum).Sum) }
  }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress))
}
`;

let staticCache = null;

async function staticInfo() {
  if (staticCache) return staticCache;
  let data = null;
  if (process.platform === 'win32') {
    const r = await run('powershell.exe', [...PS_ARGS, encode(STATIC_SCRIPT)], { timeoutMs: 30000 });
    try {
      data = JSON.parse(r.stdout.trim());
    } catch {}
  }
  const cpus = os.cpus();
  staticCache = {
    isWindows: process.platform === 'win32',
    windows: Boolean(data),
    cpu: {
      name: (data && data.cpu && data.cpu.name ? data.cpu.name : cpus[0] && cpus[0].model || '').trim() || null,
      cores: (data && data.cpu && data.cpu.cores) || null,
      threads: cpus.length || null,
      maxClockMHz: (data && data.cpu && data.cpu.maxClockMHz) || null,
    },
    memoryModules: (data && data.memoryModules) || [],
    system: (data && data.system) || null,
    board: (data && data.board) || null,
    os: (data && data.os) || { caption: `${os.type()} ${os.release()}` },
    videoControllers: (data && data.videoControllers) || [],
    hasBattery: Boolean(data && data.hasBattery),
  };
  return staticCache;
}

// SMBIOS type 17 "Memory Type" codes (SMBIOS spec, DSP0134).
const SMBIOS_MEMORY_TYPES = { 20: 'DDR', 21: 'DDR2', 24: 'DDR3', 26: 'DDR4', 27: 'LPDDR', 28: 'LPDDR2', 29: 'LPDDR3', 30: 'LPDDR4', 34: 'DDR5', 35: 'LPDDR5' };

function memoryType(modules) {
  const types = [...new Set(modules.map((m) => SMBIOS_MEMORY_TYPES[m.smbiosType]).filter(Boolean))];
  const speeds = [...new Set(modules.map((m) => m.configuredSpeed || m.speed).filter((v) => v > 0))];
  return { type: types.join('/') || null, speedMTs: speeds.length ? Math.max(...speeds) : null, modules: modules.length || null };
}

// ---------- persistent sampler ----------

class WindowsSampler {
  constructor() {
    this.child = null;
    this.pending = [];
    this.buffer = '';
  }

  ensure() {
    if (process.platform !== 'win32') return false;
    if (this.child) return true;
    this.child = spawn('powershell.exe', [...PS_ARGS, encode(SAMPLER_SCRIPT)], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', (d) => {
      this.buffer += d.toString('utf8');
      let i;
      while ((i = this.buffer.indexOf('\n')) !== -1) {
        const line = this.buffer.slice(0, i).trim();
        this.buffer = this.buffer.slice(i + 1);
        const resolve = this.pending.shift();
        if (!resolve) continue;
        try {
          resolve(JSON.parse(line));
        } catch {
          resolve(null);
        }
      }
    });
    this.child.once('exit', () => {
      this.child = null;
      for (const resolve of this.pending.splice(0)) resolve(null);
    });
    return true;
  }

  sample(serverPid) {
    if (!this.ensure()) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), 8000);
      this.pending.push((v) => {
        clearTimeout(timer);
        resolve(v);
      });
      this.child.stdin.write(`${Number.isInteger(serverPid) ? serverPid : 0}\n`);
    });
  }

  stop() {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    this.child = null;
  }
}

// ---------- CPU usage from os.cpus() deltas ----------

let prevTimes = null;

function cpuUsage() {
  const now = os.cpus().map((c) => c.times);
  let result = null;
  if (prevTimes && prevTimes.length === now.length) {
    const perCore = now.map((t, i) => {
      const p = prevTimes[i];
      const busy = t.user + t.nice + t.sys + t.irq - (p.user + p.nice + p.sys + p.irq);
      const total = busy + (t.idle - p.idle);
      return total > 0 ? (busy / total) * 100 : 0;
    });
    result = { total: perCore.reduce((a, b) => a + b, 0) / perCore.length, perCore };
  }
  prevTimes = now;
  return result;
}

function memory() {
  const total = os.totalmem();
  const available = os.freemem();
  return { totalBytes: total, availableBytes: available, usedBytes: total - available, usedPct: ((total - available) / total) * 100 };
}

async function dirSize(dir) {
  let total = 0;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.promises.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

async function storage(modelsDir) {
  let free = null;
  let total = null;
  try {
    fs.mkdirSync(modelsDir, { recursive: true });
    const s = await fs.promises.statfs(modelsDir);
    free = s.bavail * s.bsize;
    total = s.blocks * s.bsize;
  } catch {}
  return {
    drive: process.platform === 'win32' ? path.parse(modelsDir).root.replace(/\\$/, '') : null,
    freeBytes: free,
    totalBytes: total,
    modelsBytes: await dirSize(modelsDir),
  };
}

module.exports = { staticInfo, memoryType, WindowsSampler, cpuUsage, memory, storage };
