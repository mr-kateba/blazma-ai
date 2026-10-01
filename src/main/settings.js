'use strict';

const paths = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

const DEFAULTS = Object.freeze({
  port: 18080,
  contextSize: 8192,
  gpuLayers: -1, // -1 = automatic: llama.cpp --fit keeps what fits on the card, the rest in RAM
  kvCache: 'q8_0', // conversation memory precision: f16 (full), q8_0 (half the memory), q4_0
  modelsDir: '',
  activeModelId: '',
  temperature: null, // null = use the model's recommended value
  apiEnabled: false, // other programs on this computer may use the server (fixed key below)
  apiKey: '',
  webSearch: true, // the model may search the web (tool calls run in main/web.js)
  shareDeviceInfo: false, // add a hardware summary to the system prompt (monitor.modelSummary)
  monitorIntervalMs: 2000,
  gpuTempWarn: null, // null = derived from the card's own limits (monitor.js)
  gpuTempDanger: null,
  systemPrompt:
    'أنت مساعد ذكي ومفيد. أجب باللغة العربية الفصحى بوضوح ودقة، إلا إذا طلب المستخدم لغة أخرى.',
});

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const VALIDATORS = {
  port: (v) => isInt(v, 1024, 65535),
  contextSize: (v) => isInt(v, 512, 262144),
  gpuLayers: (v) => isInt(v, -1, 999),
  kvCache: (v) => ['f16', 'q8_0', 'q4_0'].includes(v),
  modelsDir: (v) => typeof v === 'string',
  activeModelId: (v) => typeof v === 'string',
  temperature: (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 2),
  apiEnabled: (v) => typeof v === 'boolean',
  apiKey: (v) => v === '' || /^bz-[0-9a-f]{48}$/.test(v),
  systemPrompt: (v) => typeof v === 'string' && v.length <= 20000,
  webSearch: (v) => typeof v === 'boolean',
  shareDeviceInfo: (v) => typeof v === 'boolean',
  monitorIntervalMs: (v) => [1000, 2000, 5000].includes(v),
  gpuTempWarn: (v) => v === null || isInt(v, 30, 110),
  gpuTempDanger: (v) => v === null || isInt(v, 30, 110),
};

let current = null;

function load() {
  const stored = readJson(paths.settingsFile(), {});
  current = { ...DEFAULTS };
  for (const [key, valid] of Object.entries(VALIDATORS)) {
    if (stored && key in stored && valid(stored[key])) current[key] = stored[key];
  }
  return current;
}

function get() {
  return current || load();
}

function update(patch) {
  const next = { ...get() };
  for (const [key, value] of Object.entries(patch || {})) {
    if (VALIDATORS[key] && VALIDATORS[key](value)) next[key] = value;
  }
  current = next;
  writeJson(paths.settingsFile(), current);
  return current;
}

function modelsDir() {
  return get().modelsDir || paths.defaultModelsDir();
}

module.exports = { DEFAULTS, get, update, modelsDir };
