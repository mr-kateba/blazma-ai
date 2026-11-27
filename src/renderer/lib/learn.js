// "ذاكرة تتعلم لحالها": after a reply, the model reads the last exchange and
// picks out lasting facts about the user (name, work, projects, tools, how
// they like answers). New facts go to the memory marked auto, and the reply
// shows what was learned with an undo.

import { complete, readJson } from './llm.js';

const SYSTEM = `You maintain a memory of facts about the USER of a chat assistant.
Read the exchange and list facts about the user that will still be true in months and will help future conversations: their name, work or studies, city or country, projects, tools and programming languages they use, family details they share, goals, and how they like answers (language, length, style).
Do NOT include: what they asked about this time, temporary states, facts about the assistant, guesses, passwords, card numbers or other secrets, health or religion unless the user asked to remember it.
Do not repeat facts already in the memory below, even in other words.
Write each fact as one short sentence in the language the user writes in, about the user in the third person (Arabic: "اسمه أحمد", "يعمل مبرمجاً"; English: "Name is Ahmed").
Reply with JSON only: {"facts": ["..."]}. Usually there is nothing new: then reply {"facts": []}.`;

let busy = false;

// user: the user's message text, answer: the reply, memory: [{text}].
// Returns the new facts (strings), at most 3.
export async function learnFrom(user, answer, memory) {
  const text = String(user || '').trim();
  if (busy || text.length < 12) return [];
  busy = true;
  try {
    const known = memory.length ? memory.map((m) => `- ${m.text}`).join('\n') : '(empty)';
    const out = await complete(
      [
        { role: 'system', content: `${SYSTEM}\n\nMemory now:\n${known}` },
        { role: 'user', content: `USER: ${text.slice(0, 3000)}\n\nASSISTANT: ${String(answer || '').slice(0, 1500)}` },
      ],
      { maxTokens: 250, temperature: 0.1 },
    );
    const j = readJson(out);
    const facts = j && Array.isArray(j.facts) ? j.facts : [];
    const seen = new Set(memory.map((m) => norm(m.text)));
    return facts
      .filter((f) => typeof f === 'string')
      .map((f) => f.trim().replace(/^[-•]\s*/, ''))
      .filter((f) => f.length >= 4 && f.length <= 300 && !seen.has(norm(f)) && !/password|كلمة السر|كلمة المرور|\b\d{12,}\b/i.test(f))
      .slice(0, 3);
  } catch {
    return [];
  } finally {
    busy = false;
  }
}

const norm = (s) => String(s).replace(/[\s.،,:؛]+/g, ' ').trim().toLowerCase();
