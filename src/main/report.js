'use strict';

// "تصدير تقرير الجهاز": specifications and the latest readings as JSON.
// Deliberately excludes anything identifying: no computer name, user name or
// file paths (only the drive letter of the models folder).

const fs = require('node:fs');
const { app, dialog } = require('electron');

function buildReport({ info, last, bench, setupState }) {
  const model = setupState.models.find((m) => m.id === setupState.modelId);
  return {
    generatedAt: new Date().toISOString(),
    app: { name: app.getName(), version: app.getVersion() },
    engine: setupState.engine ? { tag: setupState.engine.tag, variant: setupState.engine.variant } : null,
    model: model ? { id: model.id, name: model.name } : null,
    serverPhase: setupState.phase,
    specs: {
      os: info.os,
      system: info.system,
      board: info.board,
      cpu: info.cpu,
      memory: info.memory,
      gpu: info.gpu,
      otherVideoControllers: info.videoControllers,
    },
    thresholds: info.thresholds,
    latestReading: last
      ? {
          at: new Date(last.t).toISOString(),
          gpu: last.gpu,
          cpu: last.cpu && { totalPct: last.cpu.total, perCorePct: last.cpu.perCore, clockMHz: last.cpu.clockMHz },
          ram: last.ram,
          server: last.server,
          storage: last.storage && { drive: last.storage.drive, freeBytes: last.storage.freeBytes, modelsBytes: last.storage.modelsBytes },
          power: last.power,
        }
      : null,
    lastBenchmark: bench || null,
    notAvailable: {
      cpuTemperature: 'Windows has no standard interface for CPU temperature without a hardware sensor driver.',
      cpuPower: 'Windows has no standard interface for CPU power without a hardware sensor driver.',
      totalSystemPower: 'Not measurable without external hardware; only GPU board power is reported.',
    },
  };
}

async function exportReport(win, data) {
  const stamp = new Date().toISOString().slice(0, 10);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'تصدير تقرير الجهاز',
    defaultPath: `blazma-device-report-${stamp}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, JSON.stringify(buildReport(data), null, 2), 'utf8');
  return { saved: true };
}

module.exports = { exportReport, buildReport };
