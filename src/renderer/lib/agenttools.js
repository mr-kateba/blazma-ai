// The tools of "وضع الوكيل" (files and programs) and "عقل جهازك" (finding
// things in the user's files), as offered to the model, and how a call runs:
// reading at once, a change only after the user approves the plan
// (main/agent.js plans it first, then runs it into the request's journal).

import { ui } from '../i18n/index.js';
import { confirmDialog } from './dialog.js';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });
const str = (description) => ({ type: 'string', description });
const strs = (description) => ({ type: 'array', items: { type: 'string' }, description });
const pairs = { type: 'array', description: 'What goes where.', items: { type: 'object', properties: { from: str('File or folder path.'), to: str('Destination folder (ending with \\) or full new path.') }, required: ['from', 'to'] } };

export const BRAIN_TOOLS = [
  fn('search_my_files', "Search inside the user's own files (documents, PDFs, notes, bills, contracts, pictures with text) by meaning. Use it when the user asks about something that is probably written in their files. Returns passages with the file path.", { question: str('What to look for, as a full question or phrase.') }, ['question']),
  fn('find_files', "Find files on the user's computer by name, type or date (newest first). Use plain words from the file name, not a pattern.", { query: str('Words in the file name (optional).'), type: { type: 'string', enum: ['images', 'videos', 'audio', 'documents', 'archives', 'programs', 'code', 'other'] }, extension: str('For example pdf (optional).'), folder: str('Only inside this folder (optional).'), modified_after: str('YYYY-MM-DD (optional).'), modified_before: str('YYYY-MM-DD (optional).') }),
  fn('read_file', 'Read the text of one file (documents, PDF, Word, text, code; pictures are read with OCR).', { path: str('Full path of the file.') }, ['path']),
  fn('open', 'Open a file or folder for the user with its usual program (not programs or scripts).', { path: str('Full path.') }, ['path']),
];

export const AGENT_TOOLS = [
  fn('list_folder', 'List what is in a folder: names, types, sizes, dates, and counts by type.', { path: str('Folder path; Desktop, Documents, Downloads, Pictures, Videos and Music also work as names.') }, ['path']),
  fn('find_duplicates', 'Find identical files (same content) in a folder and its subfolders. Shows which copy is kept (the oldest).', { folder: str('Folder path.') }, ['folder']),
  fn('organize_folder', 'Sort the files directly in a folder into subfolders by type (pictures, documents, videos…) or by month. One call does the whole folder.', { folder: str('Folder path.'), by: { type: 'string', enum: ['type', 'date'] } }, ['folder']),
  fn('create_folder', 'Create a folder.', { path: str('Full path of the new folder.') }, ['path']),
  fn('move', 'Move files or folders. Give all of them in one call.', { items: pairs }, ['items']),
  fn('copy', 'Copy files. Give all of them in one call.', { items: pairs }, ['items']),
  fn('rename', 'Rename one file or folder.', { path: str('Current full path.'), new_name: str('New name with its extension, no folder.') }, ['path', 'new_name']),
  fn('delete', 'Move files or folders to the Recycle Bin. Only what the user asked to delete.', { paths: strs('Full paths.') }, ['paths']),
  fn('write_text_file', 'Create or replace a text file (txt, md, csv, html, code…).', { path: str('Full path with extension.'), content: str('The whole text of the file.') }, ['path', 'content']),
  fn('images_to_pdf', 'Make one PDF from pictures, one picture per page, in the given order.', { images: strs('Full paths of the pictures.'), output: str('Full path of the PDF (optional).') }, ['images']),
  fn('open_app', 'Start an installed program by its name (Chrome, Word, Steam, Calculator…).', { name: str('The program name.') }, ['name']),
];

export const AGENT_NAMES = new Set([...BRAIN_TOOLS, ...AGENT_TOOLS].map((t) => t.function.name));

// Instructions for the system prompt.
export function agentRules({ agent, brain, places, brainFolders }) {
  const where = Object.entries(places)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
  let s = `The user's folders on this Windows computer:\n${where}`;
  if (brain) s += `\n\nThe user's files in these folders are indexed: ${brainFolders.join(', ')}. When a question is probably answered by something in their own files (a contract, a bill, notes, a document, a scanned paper), call search_my_files first; use find_files for names, types and dates. Say which file the answer came from, and offer to open it.`;
  if (agent)
    s += `\n\nYou can work on the user's computer with tools: look first (list_folder, find_files), never guess a path, then act. Sort a whole folder with organize_folder; move or copy many files in ONE call. Delete only what the user asked to delete. Every change is shown to the user, who approves or refuses it; if refused, stop and ask what to do instead. You cannot run commands or scripts. When done, say in one or two sentences what changed. All changes can be undone with the button under your reply.`;
  return s;
}

const short = (p) => String(p || '').split(/[\\/]/).slice(-2).join('\\');
const base = (p) => String(p || '').split(/[\\/]/).pop();
const dir = (p) => String(p || '').split(/[\\/]/).slice(-2, -1)[0] || '';
// Paths are isolated so Arabic and Latin names keep their order.
const iso = (s) => `\u2068${s}\u2069`;
const MAX_RESULT = 12000;

function lines(plan) {
  const A = ui.v2.agent;
  return plan.steps.map((s) => {
    const to = (s) => (base(s.from) === base(s.to) ? iso(dir(s.to)) : iso(short(s.to)));
    if (s.op === 'move') return `${A.op.move} ${iso(base(s.from))} ${A.op.to} ${to(s)}`;
    if (s.op === 'copy') return `${A.op.copy} ${iso(base(s.from))} ${A.op.to} ${to(s)}`;
    if (s.op === 'mkdir') return `${A.op.mkdir} ${iso(base(s.path))}`;
    if (s.op === 'trash') return `${A.op.trash} ${iso(short(s.path))}`;
    if (s.op === 'write') return `${s.overwrite ? A.op.overwrite : A.op.write} ${iso(short(s.path))}`;
    return `${A.op.pdf} ${iso(short(s.path))}`;
  });
}

function summary(plan) {
  const A = ui.v2.agent;
  const parts = [];
  if (plan.moves) parts.push(A.count.moves(plan.moves));
  if (plan.copies) parts.push(A.count.copies(plan.copies));
  if (plan.new_folders) parts.push(A.count.folders(plan.new_folders));
  if (plan.deletes) parts.push(A.count.deletes(plan.deletes));
  if (plan.writes) parts.push(A.count.writes(plan.writes));
  if (plan.pdfs) parts.push(A.count.pdfs(plan.pdfs));
  return parts.join('، ');
}

// Runs one agent/brain call; returns the text for the model.
export async function runAgentTool(name, args, reply, renderLast) {
  const A = ui.v2.agent;
  const step = { kind: 'tool', label: A.step[name] ? A.step[name](args) : name };
  reply.steps.push(step);
  renderLast();
  const fail = (res) => {
    step.failed = true;
    const code = res && res.error ? res.error.code : 'failed';
    return `Failed: ${code}${res && res.error && res.error.detail ? ` (${res.error.detail})` : ''}. ${code === 'agent-denied' ? 'That place is protected (Windows, programs, app data); choose a user folder.' : ''}`;
  };
  if (name === 'search_my_files') {
    const res = await window.blazma.kbSearch(String(args.question || ''), null).catch(() => ({ ok: false }));
    if (!res.ok) return fail(res);
    if (!res.result.length) return 'Nothing in the indexed files matches. Try find_files with words from the file name, or other words.';
    for (const p of res.result) reply.sources.push({ title: p.name, url: `file:${p.file}`, file: p.file });
    return res.result.map((p, i) => `[${i + 1}] ${p.file}\n${p.text}`).join('\n\n').slice(0, MAX_RESULT);
  }
  if (!window.blazma.agentRead || !AGENT_NAMES.has(name)) return `Unknown tool ${name}.`;
  const changing = !['list_folder', 'find_files', 'read_file', 'find_duplicates', 'open', 'open_app'].includes(name);
  if (!changing) {
    const res = await window.blazma.agentRead(name, args);
    if (!res.ok) return fail(res);
    // No file name matches: look inside the files too ("دليل الاستخدام" in guide.pdf).
    if (name === 'find_files' && !res.result.found && args.query) {
      const kb = await window.blazma.kbSearch(String(args.query), null).catch(() => ({ ok: false }));
      if (kb.ok && kb.result.length) {
        for (const p of kb.result) reply.sources.push({ title: p.name, url: `file:${p.file}`, file: p.file });
        res.result.note = 'No file NAME matched, but these files have matching CONTENT:';
        res.result.by_content = [...new Map(kb.result.map((p) => [p.file, { path: p.file, passage: p.text.slice(0, 300) }])).values()];
      } else res.result.note = 'No file name matched. Try other words (names are often in English), an extension, or search_my_files.';
    }
    if (name === 'read_file' && res.result.file) reply.sources.push({ title: res.result.file.split(/[\\/]/).pop(), url: `file:${res.result.file}`, file: res.result.file });
    return JSON.stringify(res.result).slice(0, MAX_RESULT);
  }
  const planned = await window.blazma.agentPlan(name, args);
  if (!planned.ok) return fail(planned);
  const plan = planned.result;
  const total = plan.moves + plan.copies + plan.new_folders + plan.deletes + plan.writes + plan.pdfs;
  if (!total) return 'Nothing to change (already done).';
  const more = total > plan.steps.length ? [A.more(total - plan.steps.length)] : [];
  const ok = await confirmDialog({ title: A.askTitle, text: summary(plan), list: [...lines(plan), ...more], ok: plan.deletes ? A.doDelete : A.doIt, cancel: A.no, danger: Boolean(plan.deletes) });
  if (!ok) {
    step.failed = true;
    step.label = `${step.label} · ${A.refused}`;
    return 'The user refused this change. Nothing was changed. Ask what they want instead.';
  }
  const res = await window.blazma.agentRun(plan.planId, reply.journal);
  if (!res.ok) return fail(res);
  reply.changed = (reply.changed || 0) + res.result.done;
  if (res.result.failed.length) step.failed = true;
  return JSON.stringify({ files_moved: plan.moves, files_copied: plan.copies, folders_created: plan.new_folders, moved_to_recycle_bin: plan.deletes, files_written: plan.writes, pdfs_made: plan.pdfs, failed: res.result.failed.slice(0, 20), created: res.result.created });
}
