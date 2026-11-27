'use strict';

// "وضع الوكيل": the model works on the user's files and programs with tools.
// Every tool that changes something runs twice: first as a plan (nothing
// touched, the chat shows it and asks), then for real, written to a journal
// so the whole request can be undone ("تراجع"). Deleting goes to the
// Recycle Bin. Windows, Program Files, ProgramData, AppData and this app's
// own data are never touched, and programs are not run (opening a file with
// an executable type is refused; open_app starts Start-menu shortcuts only).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, shell, BrowserWindow } = require('electron');
const paths = require('./paths');
const { extractFile, kindOf } = require('./documents');
const { AppError } = require('./errors');

const MAX_LIST = 300;
const MAX_WALK = 30000;
const MAX_ITEMS = 1000; // files in one change
const MAX_READ = 20000; // characters returned by read_file

// ---------- places ----------

function known() {
  const g = (n) => {
    try {
      return app.getPath(n);
    } catch {
      return null;
    }
  };
  const home = os.homedir();
  return {
    home,
    desktop: g('desktop'),
    documents: g('documents'),
    downloads: g('downloads'),
    pictures: g('pictures'),
    videos: g('videos'),
    music: g('music'),
  };
}

const ALIASES = {
  desktop: ['desktop', 'سطح المكتب', 'المكتب'],
  documents: ['documents', 'my documents', 'المستندات', 'مستنداتي', 'الوثائق'],
  downloads: ['downloads', 'download', 'التنزيلات', 'التحميلات', 'تنزيلات'],
  pictures: ['pictures', 'photos', 'الصور', 'صوري'],
  videos: ['videos', 'الفيديو', 'الفيديوهات', 'مقاطع الفيديو'],
  music: ['music', 'الموسيقى', 'الصوتيات'],
  home: ['~', 'home', 'المجلد الرئيسي'],
};

// A path from the model: "Downloads", "التنزيلات\\pdf", "~/x", "C:\\a".
function expand(p) {
  let s = String(p || '').trim().replace(/^["']|["']$/g, '');
  if (!s) throw new AppError('agent-bad-path', 'empty');
  const k = known();
  const parts = s.split(/[\\/]+/);
  const first = parts[0].toLowerCase();
  for (const [key, names] of Object.entries(ALIASES)) {
    if (names.includes(first) && k[key]) {
      s = path.join(k[key], ...parts.slice(1));
      break;
    }
  }
  if (!path.isAbsolute(s)) s = path.join(k.home, s);
  return path.resolve(s);
}

function denied() {
  const env = process.env;
  const list = [env.SystemRoot || 'C:\\Windows', env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramData, path.join(os.homedir(), 'AppData'), paths.userData(), app.getAppPath()];
  return list.filter(Boolean).map((d) => path.resolve(d).toLowerCase());
}

const under = (p, d) => p === d || p.startsWith(d.endsWith(path.sep) ? d : d + path.sep);

function safe(p, { write = false } = {}) {
  const abs = expand(p);
  const low = abs.toLowerCase();
  if (denied().some((d) => under(low, d)) || /[\\/](\$recycle\.bin|system volume information)([\\/]|$)/i.test(abs)) throw new AppError('agent-denied', abs);
  if (write && path.parse(abs).root.toLowerCase() === low.replace(/[\\/]+$/, '') + path.sep) throw new AppError('agent-denied', abs);
  if (write && path.resolve(abs) === path.resolve(os.homedir())) throw new AppError('agent-denied', abs);
  // Nothing new straight in the Windows drive's root (C:\).
  const sysRoot = path.parse(process.env.SystemRoot || 'C:\\Windows').root.toLowerCase();
  if (write && path.dirname(low) + (path.dirname(low).endsWith(path.sep) ? '' : path.sep) === sysRoot) throw new AppError('agent-denied', abs);
  return abs;
}

const exists = (p) => fs.existsSync(p);
const stat = (p) => fs.statSync(p, { throwIfNoEntry: false });

// ---------- file types ----------

const TYPES = [
  ['images', /\.(jpe?g|png|gif|webp|bmp|heic|heif|tiff?|svg|ico|raw|cr2|nef|arw)$/i],
  ['videos', /\.(mp4|mkv|avi|mov|wmv|webm|m4v|flv|3gp|mpe?g)$/i],
  ['audio', /\.(mp3|wav|m4a|aac|ogg|opus|flac|wma)$/i],
  ['documents', /\.(pdf|docx?|odt|rtf|txt|md|xlsx?|ods|csv|pptx?|odp|epub)$/i],
  ['archives', /\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i],
  ['programs', /\.(exe|msi|msix|appx|bat|cmd|ps1|apk)$/i],
  ['code', /\.(js|ts|py|java|c|cpp|cs|go|rs|php|html?|css|json|xml|ya?ml|sql|sh)$/i],
];
const typeOf = (name) => (TYPES.find(([, re]) => re.test(name)) || ['other'])[0];
const TYPE_FOLDER = { ar: { images: 'صور', videos: 'فيديو', audio: 'صوتيات', documents: 'مستندات', archives: 'ملفات مضغوطة', programs: 'برامج', code: 'أكواد', other: 'أخرى' }, en: { images: 'Images', videos: 'Videos', audio: 'Audio', documents: 'Documents', archives: 'Archives', programs: 'Programs', code: 'Code', other: 'Other' } };
const EXECUTABLE = /\.(exe|msi|msix|appx|bat|cmd|com|ps1|vbs|vbe|js|jse|wsf|wsh|scr|pif|lnk|reg|hta|cpl|jar)$/i;

function lang() {
  try {
    return require('./settings').get().language === 'en' ? 'en' : 'ar';
  } catch {
    return 'ar';
  }
}

// ---------- reading ----------

function info(p, st = stat(p)) {
  return { name: path.basename(p), path: p, type: st && st.isDirectory() ? 'folder' : typeOf(p), size: st && st.isFile() ? st.size : undefined, modified: st ? new Date(st.mtimeMs).toISOString().slice(0, 16).replace('T', ' ') : undefined };
}

function walk(root, { depth = 8, limit = MAX_WALK, filesOnly = true } = {}) {
  const out = [];
  const go = (d, n) => {
    if (n > depth || out.length >= limit) return;
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === '$RECYCLE.BIN') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!filesOnly) out.push(p);
        go(p, n + 1);
      } else if (e.isFile()) out.push(p);
    }
  };
  go(root, 0);
  return out;
}

function listFolder({ path: p }) {
  const dir = safe(p);
  const st = stat(dir);
  if (!st || !st.isDirectory()) throw new AppError('agent-not-found', dir);
  const entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => !e.name.startsWith('.'));
  const items = entries.slice(0, MAX_LIST).map((e) => info(path.join(dir, e.name)));
  const counts = {};
  for (const e of entries) if (e.isFile()) counts[typeOf(e.name)] = (counts[typeOf(e.name)] || 0) + 1;
  return { folder: dir, total: entries.length, folders: entries.filter((e) => e.isDirectory()).length, files_by_type: counts, items, truncated: entries.length > MAX_LIST };
}

// Files by name / type / date, in one folder (default: the usual user folders).
function findFiles({ query = '', type = '', extension = '', folder = '', modified_after = '', modified_before = '', limit = 50 }) {
  const k = known();
  const roots = folder ? [safe(folder)] : [k.desktop, k.documents, k.downloads, k.pictures, k.videos, k.music].filter(Boolean);
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const ext = String(extension || '').replace(/^\./, '').toLowerCase();
  const after = modified_after ? Date.parse(modified_after) : NaN;
  const before = modified_before ? Date.parse(modified_before) : NaN;
  const brain = require('./brain');
  const pool = brain.names(roots) || roots.flatMap((r) => walk(r));
  const hits = [];
  for (const p of pool) {
    const name = path.basename(p).toLowerCase();
    if (words.length && !words.every((w) => name.includes(w) || p.toLowerCase().includes(w))) continue;
    if (ext && !name.endsWith(`.${ext}`)) continue;
    if (type && typeOf(name) !== type) continue;
    const st = stat(p);
    if (!st) continue;
    if (!Number.isNaN(after) && st.mtimeMs < after) continue;
    if (!Number.isNaN(before) && st.mtimeMs > before) continue;
    hits.push({ p, st });
  }
  hits.sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  return { searched: roots, found: hits.length, items: hits.slice(0, n).map(({ p, st }) => info(p, st)) };
}

async function readFile({ path: p }) {
  const file = safe(p);
  const st = stat(file);
  if (!st || !st.isFile()) throw new AppError('agent-not-found', file);
  if (!kindOf(file)) return { file, type: typeOf(file), size: st.size, text: null, note: 'This kind of file has no text to read.' };
  const { text } = await extractFile(path.basename(file), fs.readFileSync(file));
  return { file, chars: text.length, text: text.slice(0, MAX_READ), truncated: text.length > MAX_READ };
}

async function hashOf(file) {
  return new Promise((resolve) => {
    const h = crypto.createHash('sha1');
    fs.createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(null));
  });
}

async function findDuplicates({ folder }) {
  const root = safe(folder);
  const bySize = new Map();
  for (const p of walk(root)) {
    const st = stat(p);
    if (!st || st.size < 1024) continue;
    if (!bySize.has(st.size)) bySize.set(st.size, []);
    bySize.get(st.size).push(p);
  }
  const groups = [];
  for (const [size, list] of bySize) {
    if (list.length < 2) continue;
    const byHash = new Map();
    for (const p of list) {
      const h = await hashOf(p);
      if (!h) continue;
      if (!byHash.has(h)) byHash.set(h, []);
      byHash.get(h).push(p);
    }
    for (const g of byHash.values()) if (g.length > 1) groups.push({ size, files: g.sort((a, b) => stat(a).mtimeMs - stat(b).mtimeMs) });
  }
  groups.sort((a, b) => b.size * (b.files.length - 1) - a.size * (a.files.length - 1));
  const wasted = groups.reduce((n, g) => n + g.size * (g.files.length - 1), 0);
  return { folder: root, groups: groups.length, wasted_bytes: wasted, items: groups.slice(0, 100).map((g) => ({ size: g.size, keep: g.files[0], copies: g.files.slice(1) })) };
}

// ---------- changes (plan, then do) ----------

// A free name next to the target: "a.pdf" -> "a (2).pdf".
function freeName(target, taken) {
  if (!exists(target) && !taken.has(target.toLowerCase())) return target;
  const { dir, name, ext } = path.parse(target);
  for (let i = 2; i < 10000; i++) {
    const t = path.join(dir, `${name} (${i})${ext}`);
    if (!exists(t) && !taken.has(t.toLowerCase())) return t;
  }
  throw new AppError('agent-failed', 'no free name');
}

function movesPlan(pairs) {
  if (pairs.length > MAX_ITEMS) throw new AppError('agent-too-many', String(pairs.length));
  const taken = new Set();
  return pairs.map(([from, to]) => {
    const src = safe(from, { write: true });
    if (!exists(src)) throw new AppError('agent-not-found', src);
    const dest = freeName(safe(to, { write: true }), taken);
    taken.add(dest.toLowerCase());
    return { op: 'move', from: src, to: dest };
  });
}

// "to" a folder (exists or ends with a slash) or a full new path.
function targetFor(src, to) {
  const dest = safe(to, { write: true });
  const st = stat(dest);
  if ((st && st.isDirectory()) || /[\\/]$/.test(String(to))) return path.join(dest, path.basename(src));
  return dest;
}

const PLANNERS = {
  create_folder: ({ path: p }) => {
    const dir = safe(p, { write: true });
    return exists(dir) ? [] : [{ op: 'mkdir', path: dir }];
  },
  move: ({ items = [], from, to }) => {
    const list = Array.isArray(items) && items.length ? items : [{ from, to }];
    return movesPlan(list.flatMap((it) => (Array.isArray(it.from) ? it.from.map((f) => [f, it.to]) : [[it.from, it.to]])).map(([f, t]) => [f, targetFor(safe(f), t)]));
  },
  rename: ({ path: p, new_name: name }) => {
    const src = safe(p, { write: true });
    const clean = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '').trim();
    if (!clean) throw new AppError('agent-bad-path', 'name');
    return movesPlan([[src, path.join(path.dirname(src), clean)]]);
  },
  copy: ({ items = [], from, to }) => {
    const list = Array.isArray(items) && items.length ? items : [{ from, to }];
    const taken = new Set();
    return list.flatMap((it) => (Array.isArray(it.from) ? it.from.map((f) => [f, it.to]) : [[it.from, it.to]])).map(([f, t]) => {
      const src = safe(f);
      const st = stat(src);
      if (!st || !st.isFile()) throw new AppError('agent-not-found', src);
      const dest = freeName(targetFor(src, t), taken);
      taken.add(dest.toLowerCase());
      return { op: 'copy', from: src, to: dest };
    });
  },
  delete: ({ paths: list = [], path: one }) => {
    const all = (Array.isArray(list) && list.length ? list : [one]).filter(Boolean);
    if (all.length > MAX_ITEMS) throw new AppError('agent-too-many', String(all.length));
    return all.map((p) => {
      const t = safe(p, { write: true });
      if (!exists(t)) throw new AppError('agent-not-found', t);
      return { op: 'trash', path: t };
    });
  },
  write_text_file: ({ path: p, content = '' }) => {
    const file = safe(p, { write: true });
    if (EXECUTABLE.test(file)) throw new AppError('agent-denied', file);
    return [{ op: 'write', path: file, content: String(content).slice(0, 500000), overwrite: exists(file) }];
  },
  organize_folder: ({ folder, by = 'type' }) => {
    const root = safe(folder, { write: true });
    const st = stat(root);
    if (!st || !st.isDirectory()) throw new AppError('agent-not-found', root);
    const names = TYPE_FOLDER[lang()];
    const files = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isFile() && !e.name.startsWith('.') && !/^desktop\.ini$/i.test(e.name));
    const pairs = files.map((e) => {
      const p = path.join(root, e.name);
      const sub = by === 'date' ? new Date(stat(p).mtimeMs).toISOString().slice(0, 7) : names[typeOf(e.name)];
      return [p, path.join(root, sub, e.name)];
    });
    const dirs = [...new Set(pairs.map(([, t]) => path.dirname(t)))].filter((d) => !exists(d)).map((d) => ({ op: 'mkdir', path: d }));
    return [...dirs, ...movesPlan(pairs)];
  },
  images_to_pdf: ({ images = [], output }) => {
    const list = images.map((p) => safe(p));
    if (!list.length || list.length > 300) throw new AppError('agent-too-many', String(list.length));
    for (const p of list) if (!exists(p) || typeOf(p) !== 'images') throw new AppError('agent-not-found', p);
    let out = output ? safe(output, { write: true }) : path.join(path.dirname(list[0]), `${lang() === 'ar' ? 'صور' : 'images'}.pdf`);
    if (!/\.pdf$/i.test(out)) out += '.pdf';
    return [{ op: 'pdf', images: list, path: freeName(out, new Set()) }];
  },
};

// What the plan does, for the confirmation and the model.
function describe(plan) {
  const count = (op) => plan.filter((s) => s.op === op).length;
  return { moves: count('move'), copies: count('copy'), new_folders: count('mkdir'), deletes: count('trash'), writes: count('write'), pdfs: count('pdf'), steps: plan.slice(0, 40).map((s) => ({ op: s.op, from: s.from, to: s.to, path: s.path, overwrite: s.overwrite || undefined })) };
}

const plans = new Map(); // planId -> { name, plan }

function plan(name, args) {
  const make = PLANNERS[name];
  if (!make) throw new AppError('agent-unknown', name);
  const steps = make(args || {});
  const id = crypto.randomBytes(6).toString('hex');
  plans.set(id, { name, plan: steps, at: Date.now() });
  for (const [k, v] of plans) if (Date.now() - v.at > 30 * 60 * 1000) plans.delete(k);
  return { planId: id, ...describe(steps) };
}

// ---------- the journal (undo) ----------

const journalDir = () => path.join(paths.userData(), 'agent');
const journalFile = (id) => path.join(journalDir(), `${String(id).replace(/[^\w-]/g, '')}.json`);

function journalRead(id) {
  try {
    return JSON.parse(fs.readFileSync(journalFile(id), 'utf8'));
  } catch {
    return { id, done: [] };
  }
}

function journalWrite(j) {
  fs.mkdirSync(journalDir(), { recursive: true });
  fs.writeFileSync(journalFile(j.id), JSON.stringify(j));
}

function moveFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

async function imagesToPdf(images, out) {
  const tmp = path.join(os.tmpdir(), `blazma-pdf-${crypto.randomBytes(6).toString('hex')}.html`);
  const pages = images.map((p) => `<div class="pg"><img src="${require('node:url').pathToFileURL(p).href}"></div>`).join('');
  fs.writeFileSync(tmp, `<!doctype html><html><head><meta charset="utf-8"><style>@page{size:A4;margin:0}body{margin:0}.pg{width:210mm;height:297mm;display:flex;align-items:center;justify-content:center;page-break-after:always;overflow:hidden}.pg:last-child{page-break-after:auto}img{max-width:200mm;max-height:287mm;object-fit:contain}</style></head><body>${pages}</body></html>`);
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({ pageSize: 'A4', printBackground: true, margins: { marginType: 'none' } });
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, pdf);
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
}

// Runs an approved plan; journalId groups the changes of one request.
async function run(planId, journalId) {
  const p = plans.get(String(planId));
  if (!p) throw new AppError('agent-expired');
  plans.delete(String(planId));
  const j = journalRead(journalId);
  let ok = 0;
  const failed = [];
  for (const s of p.plan) {
    try {
      if (s.op === 'mkdir') {
        fs.mkdirSync(s.path, { recursive: true });
        j.done.push({ op: 'mkdir', path: s.path });
      } else if (s.op === 'move') {
        if (exists(s.to)) throw new Error('target exists');
        moveFile(s.from, s.to);
        j.done.push({ op: 'move', from: s.from, to: s.to });
      } else if (s.op === 'copy') {
        fs.mkdirSync(path.dirname(s.to), { recursive: true });
        fs.copyFileSync(s.from, s.to, fs.constants.COPYFILE_EXCL);
        j.done.push({ op: 'copy', path: s.to });
      } else if (s.op === 'trash') {
        await shell.trashItem(s.path);
        j.done.push({ op: 'trash', path: s.path });
      } else if (s.op === 'write') {
        let backup = null;
        if (exists(s.path)) {
          backup = path.join(journalDir(), `${j.id}-${crypto.randomBytes(4).toString('hex')}.bak`);
          fs.mkdirSync(journalDir(), { recursive: true });
          fs.copyFileSync(s.path, backup);
        }
        fs.mkdirSync(path.dirname(s.path), { recursive: true });
        fs.writeFileSync(s.path, s.content, 'utf8');
        j.done.push({ op: 'write', path: s.path, backup });
      } else if (s.op === 'pdf') {
        await imagesToPdf(s.images, s.path);
        j.done.push({ op: 'copy', path: s.path });
      }
      ok++;
    } catch (err) {
      failed.push({ step: s.op, path: s.path || s.from, error: err.code || err.message });
    }
  }
  journalWrite(j);
  return { done: ok, failed, created: p.plan.filter((s) => s.op === 'pdf' || s.op === 'write').map((s) => s.path) };
}

// Undoes a request's changes, newest first. Deleted files are in the Recycle Bin.
async function undo(journalId) {
  const j = journalRead(journalId);
  let undone = 0;
  const failed = [];
  let trashed = 0;
  for (const s of [...j.done].reverse()) {
    try {
      if (s.op === 'move') {
        if (exists(s.from)) throw new Error('place taken');
        moveFile(s.to, s.from);
      } else if (s.op === 'copy') {
        if (exists(s.path)) await shell.trashItem(s.path);
      } else if (s.op === 'mkdir') {
        if (exists(s.path) && !fs.readdirSync(s.path).length) fs.rmdirSync(s.path);
      } else if (s.op === 'write') {
        if (s.backup && exists(s.backup)) {
          fs.copyFileSync(s.backup, s.path);
          fs.rmSync(s.backup, { force: true });
        } else if (exists(s.path)) await shell.trashItem(s.path);
      } else if (s.op === 'trash') {
        trashed++;
        continue;
      }
      undone++;
    } catch (err) {
      failed.push({ path: s.from || s.path, error: err.message });
    }
  }
  j.done = j.done.filter((s) => s.op === 'trash');
  j.undone = true;
  journalWrite(j);
  return { undone, failed, inRecycleBin: trashed };
}

const changes = (journalId) => journalRead(journalId).done.length;

// ---------- opening things ----------

function openPath({ path: p }) {
  const target = safe(p);
  if (!exists(target)) throw new AppError('agent-not-found', target);
  const st = stat(target);
  if (st.isFile() && EXECUTABLE.test(target)) throw new AppError('agent-denied', 'executable');
  return shell.openPath(target).then((err) => (err ? { opened: false, error: err } : { opened: true, path: target }));
}

const BUILTIN_APPS = [
  [['calculator', 'calc', 'الحاسبة', 'آلة حاسبة', 'حاسبة'], 'calculator:'],
  [['settings', 'الإعدادات', 'اعدادات', 'إعدادات ويندوز'], 'ms-settings:'],
  [['file explorer', 'explorer', 'مستكشف الملفات', 'المستكشف', 'ملفاتي'], 'explorer'],
  [['notepad', 'المفكرة', 'نوت باد', 'مفكرة'], 'notepad'],
  [['paint', 'الرسام', 'رسام'], 'mspaint'],
  [['task manager', 'مدير المهام'], 'taskmgr'],
  [['camera', 'الكاميرا'], 'microsoft.windows.camera:'],
  [['store', 'microsoft store', 'المتجر'], 'ms-windows-store:'],
];
const APP_ALIASES = { بريف: 'brave', براف: 'brave', برايف: 'brave', 'بريف براوزر': 'brave', اوبرا: 'opera', أوبرا: 'opera', يوتيوب: 'youtube', 'ابيك': 'epic games', 'إيبك': 'epic games', فالورانت: 'valorant', 'ماين كرافت': 'minecraft', روبلوكس: 'roblox', فورتنايت: 'fortnite', بلازما: 'blazma', 'كاونتر سترايك': 'counter-strike', نفيديا: 'nvidia', انفيديا: 'nvidia', كروم: 'chrome', 'جوجل كروم': 'chrome', فايرفوكس: 'firefox', ايدج: 'edge', إيدج: 'edge', وورد: 'word', اكسل: 'excel', إكسل: 'excel', بوربوينت: 'powerpoint', ستيم: 'steam', ديسكورد: 'discord', سبوتيفاي: 'spotify', واتساب: 'whatsapp', تيليجرام: 'telegram', تلقرام: 'telegram', 'في اس كود': 'visual studio code', فوتوشوب: 'photoshop', 'أو بي إس': 'obs', زووم: 'zoom', تيمز: 'teams' };

function startMenuShortcuts() {
  const dirs = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs'), known().desktop].filter(Boolean);
  const out = [];
  for (const d of dirs) for (const f of walk(d, { depth: 4, limit: 3000 })) if (/\.(lnk|url)$/i.test(f) && !/uninstall|إزالة|readme|help/i.test(f)) out.push(f);
  return out;
}

// Arabic or Latin name -> a rough consonant skeleton, so "بريف" finds Brave
// and "ديسكورد" finds Discord.
const AR_SOUNDS = { ب: 'b', پ: 'b', ت: 't', ث: 't', ج: 'k', ح: 'h', خ: 'h', د: 't', ذ: 't', ر: 'r', ز: 's', س: 's', ش: 's', ص: 's', ض: 't', ط: 't', ظ: 't', غ: 'k', ف: 'f', ڤ: 'f', ق: 'k', ك: 'k', گ: 'k', ل: 'l', م: 'm', ن: 'n', ه: 'h', ة: '' };
const DIGITS = ['صفر', 'واحد', 'اثنين', 'ثلاث', 'اربع', 'خمس', 'ست', 'سبع', 'ثمان', 'تسع'];
function skeleton(s) {
  // whisper sometimes writes a syllable as a digit ("ستيم" -> "6 من").
  const t = String(s).toLowerCase().replace(/[0-9]/g, (d) => DIGITS[d]);
  let out = '';
  for (const ch of t) {
    if (AR_SOUNDS[ch] !== undefined) out += AR_SOUNDS[ch];
    else if (/[bp]/.test(ch)) out += 'b';
    else if (/[fv]/.test(ch)) out += 'f';
    else if (/[kcqgj]/.test(ch)) out += 'k';
    else if (/[szx]/.test(ch)) out += 's';
    else if (/[td]/.test(ch)) out += 't';
    else if (/[rlmnh]/.test(ch)) out += ch;
    else if (ch === ' ') out += ' ';
  }
  return out.replace(/\s+/g, '').replace(/(.)\1+/g, '$1');
}
// Words around the name in a spoken request ("متصفح بريف", "برنامج ستيم").
const FILLER = /^(?:ال)?(?:متصفح|متصفخ|برنامج|تطبيق|لعبة|لعبه|موقع|app|browser|program|the)\s+/i;

function appNames() {
  return [...new Set(startMenuShortcuts().map((f) => path.basename(f).replace(/\.(lnk|url)$/i, '')))].sort();
}

async function openApp({ name }) {
  let raw = String(name || '').trim().toLowerCase().replace(/[.؟?!،,]+$/, '');
  for (let i = 0; i < 2; i++) raw = raw.replace(FILLER, '');
  if (!raw) throw new AppError('agent-bad-path', 'name');
  const builtin = BUILTIN_APPS.find(([names]) => names.includes(raw));
  if (builtin) {
    const target = builtin[1];
    if (target.endsWith(':')) await shell.openExternal(target);
    else require('node:child_process').spawn(target, [], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
    return { opened: true, app: builtin[0][0] };
  }
  const want = (APP_ALIASES[raw] || raw).toLowerCase();
  const list = startMenuShortcuts().map((f) => ({ f, n: path.basename(f).replace(/\.(lnk|url)$/i, '').toLowerCase() }));
  // Programs before their helpers ("Brave" before "Brave Uninstall"), shorter names first.
  list.sort((a, b) => a.n.length - b.n.length);
  const sk = skeleton(want);
  const pick =
    list.find((x) => x.n === want) ||
    list.find((x) => x.n.startsWith(want)) ||
    list.find((x) => x.n.includes(want)) ||
    list.find((x) => want.split(/\s+/).every((w) => x.n.includes(w))) ||
    // By sound, only when it is close: same skeleton, or one extra sound at the end.
    (sk.length >= 3
      ? list.find((x) => skeleton(x.n) === sk) ||
        list.find((x) => skeleton(x.n.split(/\s+/)[0]) === sk) ||
        list.find((x) => {
          const a = skeleton(x.n.split(/\s+/)[0]);
          return a.length >= 3 && Math.abs(a.length - sk.length) === 1 && (sk.startsWith(a) || a.startsWith(sk));
        })
      : null);
  if (!pick) return { opened: false, error: 'not found', installed: [...new Set(list.map((x) => x.n))].slice(0, 120) };
  const err = await shell.openPath(pick.f);
  return err ? { opened: false, error: err } : { opened: true, app: path.basename(pick.f).replace(/\.(lnk|url)$/i, '') };
}

// ---------- the tool calls ----------

const READERS = { list_folder: listFolder, find_files: findFiles, read_file: readFile, find_duplicates: findDuplicates, open: openPath, open_app: openApp };
const isChange = (name) => Object.prototype.hasOwnProperty.call(PLANNERS, name);

async function read(name, args) {
  const fn = READERS[name];
  if (!fn) throw new AppError('agent-unknown', name);
  return fn(args || {});
}

function places() {
  const k = known();
  return Object.fromEntries(Object.entries(k).filter(([, v]) => v));
}

module.exports = { read, plan, run, undo, changes, isChange, places, expand, safe, typeOf, walk, appNames, skeleton };
