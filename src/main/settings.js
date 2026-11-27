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
  voiceModel: 'turbo', // speech to text: 'small' (faster) or 'turbo' (more accurate; needed for Arabic)
  voiceLang: 'ui', // the spoken language: 'ui' (Arabic with the Arabic interface), 'auto', 'ar', 'en'
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
  memoryEnabled: true, // facts about the user added to every chat
  memory: [], // [{ id, text, auto? }] (auto: learned from a chat, lib/learn.js)
  memoryAuto: true, // learn lasting facts about the user from the chats
  agentMode: false, // "وضع الوكيل": the model may work on files and open programs (agent.js)
  brainEnabled: false, // "عقل جهازك": the user's folders read and kept up to date (brain.js)
  brainFolders: [],
  wakeEnabled: false, // "يا بلازما": listen for the wake word (wake.js)
  quickEnabled: true, // the quick assistant on a global shortcut (quick.js)
  quickKey: 'Alt+Space',
  quickScreenKey: 'Alt+Shift+Space', // a picture of the screen for the quick assistant
  mcpServers: [], // MCP tool servers (mcp.js): [{ id, name, command, args: [], enabled }]
  tasks: [], // scheduled prompts (tasks.js): [{ id, title, prompt, time: 'HH:MM', days: [0-6], web, enabled, lastRun }]
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
  voiceLang: (v) => ['ui', 'auto', 'ar', 'en'].includes(v),
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
  memoryEnabled: (v) => typeof v === 'boolean',
  memoryAuto: (v) => typeof v === 'boolean',
  agentMode: (v) => typeof v === 'boolean',
  brainEnabled: (v) => typeof v === 'boolean',
  brainFolders: (v) => Array.isArray(v) && v.length <= 20 && v.every((d) => typeof d === 'string' && d.length <= 400),
  wakeEnabled: (v) => typeof v === 'boolean',
  memory: (v) => Array.isArray(v) && v.length <= 200 && v.every((m) => m && typeof m.id === 'string' && typeof m.text === 'string' && m.text.length <= 500),
  quickEnabled: (v) => typeof v === 'boolean',
  mcpServers: (v) =>
    Array.isArray(v) &&
    v.length <= 20 &&
    v.every((s) => s && typeof s.id === 'string' && typeof s.name === 'string' && s.name.length <= 60 && typeof s.command === 'string' && s.command.length > 0 && s.command.length <= 500 && Array.isArray(s.args) && s.args.length <= 40 && s.args.every((a) => typeof a === 'string' && a.length <= 1000) && typeof s.enabled === 'boolean'),
  quickKey: (v) => typeof v === 'string' && /^((Ctrl|Alt|Shift|Super)\+){1,3}([A-Z0-9]|Space|F([1-9]|1[0-2]))$/.test(v),
  quickScreenKey: (v) => v === '' || (typeof v === 'string' && /^((Ctrl|Alt|Shift|Super)\+){1,3}([A-Z0-9]|Space|F([1-9]|1[0-2]))$/.test(v)),
  tasks: (v) =>
    Array.isArray(v) &&
    v.length <= 30 &&
    v.every(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        typeof t.title === 'string' &&
        t.title.length <= 80 &&
        typeof t.prompt === 'string' &&
        t.prompt.length <= 4000 &&
        /^([01]\d|2[0-3]):[0-5]\d$/.test(t.time) &&
        Array.isArray(t.days) &&
        t.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) &&
        typeof t.enabled === 'boolean',
    ),
};

let current = null;

function load() {
  const stored = readJson(paths.settingsFile(), {});
  current = { ...DEFAULTS };
  for (const [key, valid] of Object.entries(VALIDATORS)) {
    if (stored && key in stored && valid(stored[key])) current[key] = stored[key];
  }
  // 0.2.0: the small speech model writes Arabic badly; everyone moves to
  // turbo once (there was no setting to choose it before).
  if (stored && stored.voiceModel === 'small' && !('voiceLang' in stored)) current.voiceModel = 'turbo';
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
