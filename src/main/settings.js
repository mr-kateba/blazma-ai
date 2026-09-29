'use strict';

const paths = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

const DEFAULTS = Object.freeze({
  port: 18080,
  contextSize: 8192,
  gpuLayers: 99,
  modelsDir: '',
  activeModelId: '',
  temperature: null, // null = use the model's recommended value
  systemPrompt:
    'أنت مساعد ذكي ومفيد. أجب باللغة العربية الفصحى بوضوح ودقة، إلا إذا طلب المستخدم لغة أخرى.',
});

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const VALIDATORS = {
  port: (v) => isInt(v, 1024, 65535),
  contextSize: (v) => isInt(v, 512, 262144),
  gpuLayers: (v) => isInt(v, 0, 999),
  modelsDir: (v) => typeof v === 'string',
  activeModelId: (v) => typeof v === 'string',
  temperature: (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 2),
  systemPrompt: (v) => typeof v === 'string' && v.length <= 20000,
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
