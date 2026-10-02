'use strict';

const paths = require('./paths');
const { readJson, writeJson } = require('./jsonfile');

// The default instructions for the model, in the interface language.
const DEFAULT_PROMPTS = Object.freeze({
  ar: 'أنت مساعد ذكي ومفيد. أجب باللغة العربية الفصحى بوضوح ودقة، إلا إذا طلب المستخدم لغة أخرى.',
  en: 'You are a helpful, knowledgeable assistant. Answer clearly and accurately, in the language the user writes in.',
});

const DEFAULTS = Object.freeze({
  port: 18080,
  contextSize: 8192,
  gpuLayers: -1, // -1 = automatic: llama.cpp --fit keeps what fits on the card, the rest in RAM
  kvCache: 'q8_0', // conversation memory precision: f16 (full), q8_0 (half the memory), q4_0
  idleUnloadMin: 0, // minutes without use before the model leaves memory (0 = never)
  speculative: 'off', // 'off' | 'ngram' (no extra model) | 'draft' (a small helper model when there is one)
  modelsDir: '',
  activeModelId: '',
  temperature: null, // null = use the model's recommended value
  apiEnabled: false, // other programs on this computer may use the server (fixed key below)
  apiKey: '',
  webSearch: true, // the model may search the web (tool calls run in main/web.js)
  kbInChat: false, // answer from the user's documents (knowledge.js)
  tourDone: false, // the first-run guided tour was finished or skipped
  voiceModel: 'small', // speech to text: 'small' (faster) or 'turbo' (more accurate)
  codeComplete: false, // code completion in VS Code with a small coding model (coder.js)
  coderKey: '', // that server's key, kept so Continue's settings stay valid
  ttsEngine: 'auto', // reading aloud: 'auto' (Blazma's Arabic voice when downloaded), 'blazma' or 'windows'
  shareDeviceInfo: false, // add a hardware summary to the system prompt (monitor.modelSummary)
  monitorIntervalMs: 2000,
  theme: 'dark', // 'dark' | 'light' | 'system' (follows Windows)
  overlayEnabled: false, // the mini hardware monitor in the chat
  overlayCorner: 'top-left',
  lhmEnabled: true, // read CPU temperature/power from LibreHardwareMonitor's web server (127.0.0.1)
  lhmPort: 8085,
  gpuTempWarn: null, // null = derived from the card's own limits (monitor.js)
  gpuTempDanger: null,
  language: 'ar', // interface language: 'ar' | 'en'
  systemPrompt: DEFAULT_PROMPTS.ar,
});

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

const VALIDATORS = {
  port: (v) => isInt(v, 1024, 65535),
  contextSize: (v) => isInt(v, 512, 262144),
  gpuLayers: (v) => isInt(v, -1, 999),
  kvCache: (v) => ['f16', 'q8_0', 'q4_0'].includes(v),
  idleUnloadMin: (v) => [0, 5, 15, 30, 60].includes(v),
  speculative: (v) => ['off', 'ngram', 'draft'].includes(v),
  modelsDir: (v) => typeof v === 'string',
  activeModelId: (v) => typeof v === 'string',
  temperature: (v) => v === null || (typeof v === 'number' && v >= 0 && v <= 2),
  apiEnabled: (v) => typeof v === 'boolean',
  apiKey: (v) => v === '' || /^bz-[0-9a-f]{48}$/.test(v),
  systemPrompt: (v) => typeof v === 'string' && v.length <= 20000,
  webSearch: (v) => typeof v === 'boolean',
  kbInChat: (v) => typeof v === 'boolean',
  tourDone: (v) => typeof v === 'boolean',
  voiceModel: (v) => ['small', 'turbo'].includes(v),
  ttsEngine: (v) => ['auto', 'blazma', 'windows'].includes(v),
  codeComplete: (v) => typeof v === 'boolean',
  coderKey: (v) => v === '' || /^[0-9a-f]{48}$/.test(v),
  shareDeviceInfo: (v) => typeof v === 'boolean',
  monitorIntervalMs: (v) => [500, 1000, 2000, 5000].includes(v),
  theme: (v) => ['dark', 'light', 'system'].includes(v),
  overlayEnabled: (v) => typeof v === 'boolean',
  overlayCorner: (v) => ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(v),
  lhmEnabled: (v) => typeof v === 'boolean',
  lhmPort: (v) => isInt(v, 1, 65535),
  gpuTempWarn: (v) => v === null || isInt(v, 30, 110),
  gpuTempDanger: (v) => v === null || isInt(v, 30, 110),
  language: (v) => ['ar', 'en'].includes(v),
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
  // A new language brings its default instructions, unless they were edited.
  const before = get();
  if (next.language !== before.language && before.systemPrompt === DEFAULT_PROMPTS[before.language]) next.systemPrompt = DEFAULT_PROMPTS[next.language];
  current = next;
  writeJson(paths.settingsFile(), current);
  return current;
}

function modelsDir() {
  return get().modelsDir || paths.defaultModelsDir();
}

const defaultPrompt = () => DEFAULT_PROMPTS[get().language] || DEFAULT_PROMPTS.ar;

module.exports = { DEFAULTS, get, update, modelsDir, defaultPrompt };
