'use strict';

// A complete (non-streamed) answer from the local model, for the parts of the
// app that run without the chat page: scheduled tasks. With web search, the
// same tools as the chat (search, open a result) for up to 3 rounds.

const settings = require('./settings');
const models = require('./models');
const web = require('./web');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the internet for recent or changing information. Returns titles, links and snippets.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_url',
      description: 'Open a page from the search results and read its text.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
];

async function post(conn, body) {
  const res = await fetch(`http://127.0.0.1:${conn.port}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conn.apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!res.ok) throw new Error(`model ${res.status}`);
  return res.json();
}

async function complete(conn, { system, prompt, useWeb }) {
  const s = settings.get();
  const model = models.findModel(s.activeModelId);
  const sampling = { ...((model && model.sampling) || {}) };
  if (s.temperature !== null) sampling.temperature = s.temperature;
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
  const sources = [];
  for (let round = 0; round <= 3; round++) {
    const body = { messages, ...sampling, chat_template_kwargs: { enable_thinking: false } };
    if (useWeb && round < 3) body.tools = TOOLS;
    const out = await post(conn, body);
    const msg = (out.choices && out.choices[0] && out.choices[0].message) || {};
    const calls = msg.tool_calls || [];
    if (!calls.length) return { content: String(msg.content || '').trim(), sources };
    messages.push({ role: 'assistant', content: msg.content || '', tool_calls: calls });
    for (const call of calls) {
      let args = {};
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {}
      let result = 'Unknown tool.';
      try {
        if (call.function.name === 'web_search') {
          const r = await web.search(String(args.query || ''));
          for (const x of r.results) sources.push({ title: x.title, url: x.url });
          result = r.results.map((x, i) => `${i + 1}. ${x.title}\nURL: ${x.url}\n${x.snippet}`).join('\n\n') || 'No results.';
        } else if (call.function.name === 'open_url') {
          if (!sources.some((x) => x.url === args.url)) result = 'Only links from the search results can be opened.';
          else {
            const p = await web.openPage(String(args.url));
            result = `${p.title}\n${p.url}\n\n${p.text}`;
          }
        }
      } catch (err) {
        result = `The tool failed (${err.message}).`;
      }
      messages.push({ role: 'tool', tool_call_id: call.id, content: result });
    }
  }
  return { content: '', sources };
}

module.exports = { complete };
