// "بحث معمّق": a big question researched on the web into a report.
// 1. The model plans 4-6 searches (in the languages that find the most).
// 2. The results are searched, the best pages opened, and from each page the
//    model takes notes that answer the question (with numbers and dates).
// 3. It looks for what is still missing and searches once more.
// 4. It writes the report from the notes, citing [n], streamed into the reply.

import { complete, readJson } from './llm.js';
import { readSse } from './sse.js';

const MAX_PAGES = 12;
const PAGE_CHARS = 7000;
const NOTES_CHARS = 11000;

const today = () => new Date().toISOString().slice(0, 10);

async function plan(question, signal) {
  const out = await complete(
    [
      { role: 'system', content: `Today is ${today()}. Plan web research for the user's question. Write 4 to 6 search queries that together cover it: different sides, recent data, comparisons, numbers. Use the language that finds the best sources for each (often English for technology, products and science; the local language for local matters). Reply with JSON only: {"queries": ["..."]}` },
      { role: 'user', content: question },
    ],
    { maxTokens: 300, temperature: 0.2, signal },
  );
  const j = readJson(out);
  const list = j && Array.isArray(j.queries) ? j.queries.filter((q) => typeof q === 'string' && q.trim()) : [];
  return list.length ? list.slice(0, 6) : [question];
}

async function notesFrom(question, page, signal) {
  const out = await complete(
    [
      { role: 'system', content: `Today is ${today()}. You take research notes. From the web page, write the facts that help answer the question: names, numbers, prices, dates, results, pros and cons. Short bullet points, in the language of the question, nothing else. If the page has nothing useful, reply NONE.` },
      { role: 'user', content: `QUESTION: ${question}\n\nPAGE: ${page.title}\n${page.url}\n\n${page.text.slice(0, PAGE_CHARS)}` },
    ],
    { maxTokens: 450, temperature: 0.1, signal },
  );
  return /^\s*NONE\b/i.test(out) || out.length < 20 ? '' : out.trim();
}

async function gaps(question, notes, signal) {
  const out = await complete(
    [
      { role: 'system', content: `Today is ${today()}. Read the research notes for the question. If something important is still missing or unclear, write up to 3 new search queries for it. Reply with JSON only: {"queries": [...]} (empty when the notes are enough).` },
      { role: 'user', content: `QUESTION: ${question}\n\nNOTES:\n${notes.slice(0, NOTES_CHARS)}` },
    ],
    { maxTokens: 200, temperature: 0.2, signal },
  );
  const j = readJson(out);
  return j && Array.isArray(j.queries) ? j.queries.filter((q) => typeof q === 'string' && q.trim()).slice(0, 3) : [];
}

// question: the user's text. reply: the assistant message (steps, sources,
// content). update(): redraw. labels: ui.v2.research.
export async function deepResearch({ question, reply, update, signal, labels: L }) {
  const conn = await window.blazma.getConnection();
  if (!conn) throw Object.assign(new Error('not ready'), { code: 'not-ready' });
  const status = (text) => {
    reply.research = text;
    update();
  };
  const abort = () => {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  };
  const seen = new Set();
  const pages = []; // { n, title, url, notes }

  const round = async (queries, pageLimit) => {
    const found = [];
    for (const q of queries) {
      abort();
      const step = { kind: 'search', label: q };
      reply.steps.push(step);
      update();
      const res = await window.blazma.webSearch(q).catch(() => ({ ok: false }));
      if (!res.ok || !res.result.results.length) {
        step.failed = true;
        continue;
      }
      // The first results of each search, taken in turn so each side is covered.
      res.result.results.slice(0, 4).forEach((r, i) => found.push({ ...r, rank: i }));
    }
    found.sort((a, b) => a.rank - b.rank);
    const todo = found.filter((r) => {
      const key = r.url.replace(/[#?].*$/, '').replace(/\/+$/, '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    let opened = 0;
    for (const r of todo) {
      if (opened >= pageLimit || pages.length >= MAX_PAGES) break;
      abort();
      const step = { kind: 'open', label: r.title || r.url };
      reply.steps.push(step);
      update();
      const res = await window.blazma.webOpen(r.url).catch(() => ({ ok: false }));
      if (!res.ok || !res.result.text || res.result.text.length < 300) {
        step.failed = true;
        continue;
      }
      opened++;
      status(L.reading(pages.length + 1));
      const notes = await notesFrom(question, res.result, signal).catch((err) => {
        if (err.name === 'AbortError') throw err;
        return '';
      });
      if (!notes) {
        step.failed = true;
        continue;
      }
      pages.push({ n: pages.length + 1, title: res.result.title || r.title || r.url, url: res.result.url || r.url, notes });
    }
  };

  status(L.planning);
  const queries = await plan(question, signal);
  await round(queries, 8);
  abort();
  if (pages.length) {
    status(L.checking);
    const more = await gaps(question, pages.map((p) => `[${p.n}] ${p.notes}`).join('\n\n'), signal).catch(() => []);
    if (more.length) await round(more, 4);
  }
  abort();
  if (!pages.length) {
    reply.research = '';
    reply.content = L.nothing;
    return;
  }

  // The report, streamed.
  status(L.writing(pages.length));
  let notes = '';
  for (const p of pages) {
    const block = `[${p.n}] ${p.title} (${p.url})\n${p.notes}\n\n`;
    if (notes.length + block.length > NOTES_CHARS) break;
    notes += block;
  }
  const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify({
      stream: true,
      timings_per_token: true,
      temperature: 0.3,
      max_tokens: 3000,
      chat_template_kwargs: { enable_thinking: false },
      stop: ['<channel|><|channel>'],
      messages: [
        {
          role: 'system',
          content: `Today is ${today()}. Write a research report that answers the user's question, using ONLY the numbered notes. Write in the language of the question. Start with a short direct answer (2-3 sentences), then sections with headings, a comparison table when things are compared, and a short conclusion or recommendation. Put the source number after each fact, like [2]. If sources disagree, say so. Do not invent facts or numbers, and do not write a source list (it is added after).`,
        },
        { role: 'user', content: `QUESTION: ${question}\n\nNOTES:\n${notes}` },
      ],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  reply.research = '';
  for await (const chunk of readSse(res)) {
    if (chunk.error) throw new Error('stream');
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (delta && delta.content) reply.content += delta.content;
    if (chunk.timings) reply.timings = chunk.timings;
    update();
  }
  reply.sources = pages.map((p) => ({ title: `[${p.n}] ${p.title}`, url: p.url }));
  reply.researchSources = pages.length;
}
