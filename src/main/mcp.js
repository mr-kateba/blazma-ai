'use strict';

// MCP (Model Context Protocol) client: programs the user adds in Settings >
// Tools (for example a file-system or database server) give the model extra
// tools. Each server is a local program spoken to over stdin/stdout with
// JSON-RPC 2.0 (MCP stdio transport). The model's calls are confirmed by the
// user in the chat before they run (chat.js).

const { spawn } = require('node:child_process');
const settings = require('./settings');
const { app } = require('electron');

const PROTOCOL = '2025-06-18';
const servers = new Map(); // id -> { proc, tools, pending, nextId, buf, ready, error, log }

function launch(cfg) {
  const isWin = process.platform === 'win32';
  // npx, npm, uvx… are .cmd files on Windows and need the command shell.
  const viaShell = isWin && !/\.(exe|com)$/i.test(cfg.command) && !/[\\/]/.test(cfg.command);
  const quote = (a) => (/[\s"&|<>^]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a);
  const proc = viaShell
    ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', [cfg.command, ...cfg.args].map(quote).join(' ')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], windowsVerbatimArguments: true })
    : spawn(cfg.command, cfg.args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return proc;
}

function request(s, method, params, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = s.nextId++;
    const timer = setTimeout(() => {
      s.pending.delete(id);
      reject(new Error(`${method}: no answer`));
    }, timeoutMs);
    s.pending.set(id, { resolve, reject, timer });
    s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

function onData(s, chunk) {
  s.buf += chunk;
  let nl;
  while ((nl = s.buf.indexOf('\n')) >= 0) {
    const line = s.buf.slice(0, nl).trim();
    s.buf = s.buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id !== undefined && s.pending.has(msg.id)) {
      const p = s.pending.get(msg.id);
      s.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error.message || 'error'));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined && msg.method) {
      // Requests from the server (sampling, roots…) are not offered.
      s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'not supported' } })}\n`);
    }
  }
}

async function start(cfg) {
  stopOne(cfg.id);
  const s = { cfg, proc: launch(cfg), tools: [], pending: new Map(), nextId: 1, buf: '', ready: false, error: null, log: '' };
  servers.set(cfg.id, s);
  s.proc.stdout.setEncoding('utf8');
  s.proc.stdout.on('data', (d) => onData(s, d));
  s.proc.stderr.on('data', (d) => (s.log = (s.log + d).slice(-4000)));
  s.proc.on('error', (err) => (s.error = err.message));
  s.proc.on('exit', (code) => {
    s.ready = false;
    if (!s.error) s.error = `exited (${code})${s.log ? `: ${s.log.trim().split('\n').pop()}` : ''}`;
    for (const p of s.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(s.error));
    }
    s.pending.clear();
  });
  try {
    await request(s, 'initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'Blazma AI', version: app.getVersion() } }, 60000);
    s.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const res = await request(s, 'tools/list', {});
    s.tools = (res.tools || []).slice(0, 64).map((t) => ({ name: String(t.name), description: String(t.description || '').slice(0, 1000), inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
    s.ready = true;
  } catch (err) {
    s.error = s.error || err.message;
  }
  return summary(s);
}

function summary(s) {
  return { id: s.cfg.id, name: s.cfg.name, ready: s.ready, error: s.ready ? null : s.error, tools: s.tools.map((t) => ({ name: t.name, description: t.description })) };
}

// Starts every enabled server that is not running; returns their state.
async function ensure() {
  const list = settings.get().mcpServers.filter((c) => c.enabled);
  for (const id of [...servers.keys()]) if (!list.some((c) => c.id === id)) stopOne(id);
  await Promise.all(list.filter((c) => !(servers.get(c.id) && servers.get(c.id).ready)).map((c) => start(c).catch(() => null)));
  return list.map((c) => (servers.get(c.id) ? summary(servers.get(c.id)) : { id: c.id, name: c.name, ready: false, error: 'not started', tools: [] }));
}

// The tools of the running servers, in the chat's OpenAI tool format.
// Names: mcp_<n>_<tool>, 64 characters at most (the server index n keeps them unique).
function chatTools() {
  const out = [];
  const enabled = settings.get().mcpServers.filter((c) => c.enabled);
  enabled.forEach((c, n) => {
    const s = servers.get(c.id);
    if (!s || !s.ready) return;
    for (const t of s.tools) {
      out.push({
        server: c.id,
        serverName: c.name,
        tool: t.name,
        spec: { type: 'function', function: { name: `mcp_${n}_${t.name}`.replace(/[^\w-]/g, '_').slice(0, 64), description: `[${c.name}] ${t.description}`.slice(0, 1024), parameters: t.inputSchema } },
      });
    }
  });
  return out;
}

async function call(serverId, tool, args) {
  const s = servers.get(serverId);
  if (!s || !s.ready) throw new Error('server not running');
  const res = await request(s, 'tools/call', { name: tool, arguments: args || {} }, 120000);
  const text = (res.content || [])
    .map((c) => (c.type === 'text' ? c.text : c.type === 'resource' && c.resource && c.resource.text ? c.resource.text : `[${c.type}]`))
    .join('\n')
    .slice(0, 60000);
  return { text, isError: Boolean(res.isError) };
}

function stopOne(id) {
  const s = servers.get(id);
  if (!s) return;
  servers.delete(id);
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(s.proc.pid), '/t', '/f'], { windowsHide: true });
    else s.proc.kill();
  } catch {}
}

function stop() {
  for (const id of [...servers.keys()]) stopOne(id);
}

module.exports = { ensure, chatTools, call, stop, start };
