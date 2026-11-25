'use strict';

// Scheduled tasks (Settings > Scheduled tasks): a prompt that runs at a set
// time on chosen days while the app is open. The answer is saved as a chat in
// the "المهام" folder and announced with a notification.

const crypto = require('node:crypto');
const { Notification } = require('electron');
const settings = require('./settings');
const chats = require('./chats');
const llm = require('./llm');
const { t: tr } = require('./i18n');

let timer = null;
let deps = null;
const running = new Set();

const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function due(task, now) {
  if (!task.enabled || !task.days.includes(now.getDay())) return false;
  const [h, m] = task.time.split(':').map(Number);
  const at = new Date(now);
  at.setHours(h, m, 0, 0);
  // Runs once a day, any time in the two hours after its time (the PC may
  // have been asleep at that minute).
  const ranToday = task.lastRun && dayKey(new Date(task.lastRun)) === dayKey(now) && task.lastRun >= at.getTime();
  return now >= at && now - at < 2 * 3600 * 1000 && !ranToday;
}

function markRun(id) {
  const tasks = settings.get().tasks.map((t) => (t.id === id ? { ...t, lastRun: Date.now() } : t));
  settings.update({ tasks });
}

async function run(id) {
  const task = settings.get().tasks.find((t) => t.id === id);
  if (!task) throw new Error('no-task');
  if (running.has(id)) throw new Error('busy');
  const conn = deps.setup.connection();
  if (!conn) throw new Error('not-ready');
  running.add(id);
  try {
    const s = settings.get();
    const now = new Date();
    let system = `${s.systemPrompt}\n\n${tr('taskDate')(now.toLocaleDateString(s.language === 'en' ? 'en' : 'ar', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }))}`;
    if (s.memoryEnabled && s.memory.length) system += `\n\n${tr('memoryContext')}\n${s.memory.map((m) => `- ${m.text}`).join('\n')}`;
    const out = await llm.complete(conn, { system, prompt: task.prompt, useWeb: Boolean(task.web) });
    if (!out.content) throw new Error('empty');
    const chatId = `task-${crypto.randomBytes(6).toString('hex')}`;
    chats.save({
      id: chatId,
      messages: [
        { role: 'user', content: task.prompt },
        { role: 'assistant', content: out.content, sources: out.sources.slice(0, 6) },
      ],
    });
    chats.rename(chatId, `${task.title} · ${now.toLocaleDateString(s.language === 'en' ? 'en' : 'ar')}`);
    chats.setMeta(chatId, { folder: tr('tasksFolder') });
    markRun(id);
    const win = deps.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('tasks:done', { chatId, title: task.title });
    if (Notification.isSupported()) {
      const n = new Notification({ title: task.title, body: out.content.replace(/[#*_`>]/g, '').slice(0, 180) });
      n.on('click', () => {
        const w = deps.getWindow();
        if (!w) return;
        w.show();
        w.focus();
        w.webContents.send('tasks:open', chatId);
      });
      n.show();
    }
    return { chatId };
  } finally {
    running.delete(id);
  }
}

function tick() {
  const now = new Date();
  for (const task of settings.get().tasks) {
    if (due(task, now) && deps.setup.connection()) run(task.id).catch(() => markRun(task.id));
  }
}

function start(d) {
  deps = d;
  clearInterval(timer);
  timer = setInterval(tick, 30 * 1000);
}

function stop() {
  clearInterval(timer);
}

module.exports = { start, stop, run, due };
