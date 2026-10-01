'use strict';

// Web access for the model's tools (search and reading a page). Runs in the
// main process only; the renderer's CSP still allows no internet access.
// Search uses DuckDuckGo's HTML endpoint, which needs no account or key.

const dns = require('node:dns').promises;
const net = require('node:net');
const { net: electronNet } = require('electron');
const { AppError } = require('./errors');

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Blazma-AI';
const MAX_PAGE_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_CHARS = 6000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'" };

function decodeEntities(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z0-9#]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

const stripTags = (s) => decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

async function fetchText(url, { timeoutMs = 12000, method = 'GET' } = {}) {
  let res;
  try {
    res = await electronNet.fetch(url, {
      method,
      headers: { 'User-Agent': UA, 'Accept-Language': 'ar,en;q=0.8' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  return res;
}

// ---------- search ----------

function parseResults(html) {
  const results = [];
  // Each organic result: <a class="result__a" href="//duckduckgo.com/l/?uddg=<url>&...">title</a>
  // followed by <a class="result__snippet" ...>snippet</a>. Ads carry "result--ad".
  const blocks = html.split(/<div class="result results_links/).slice(1);
  for (const block of blocks) {
    if (/result--ad/.test(block.slice(0, 200))) continue;
    const a = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    let url = decodeEntities(a[1]);
    const uddg = /[?&]uddg=([^&]+)/.exec(url);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith('//')) url = `https:${url}`;
    if (!/^https?:\/\//i.test(url)) continue;
    const snip = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    results.push({ title: stripTags(a[2]), url, snippet: snip ? stripTags(snip[1]) : '' });
    if (results.length >= 6) break;
  }
  return results;
}

async function search(query) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw new AppError('web-bad-query');
  const res = await fetchText(`${SEARCH_URL}?q=${encodeURIComponent(q)}&kl=xa-ar`);
  if (!res.ok) throw new AppError('web-search-failed', `HTTP ${res.status}`);
  const results = parseResults(await res.text());
  return { query: q, results };
}

// ---------- open a page ----------

// IPv6 text (any form: "::1", "::ffff:127.0.0.1", "::ffff:7f00:1") to its
// eight 16-bit groups.
function ipv6Groups(ip) {
  let v = ip.toLowerCase().split('%')[0];
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  if (dotted) {
    const [a, b, c, d] = dotted[1].split('.').map(Number);
    v = `${v.slice(0, -dotted[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = v.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const fill = v.includes('::') ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(Math.max(0, fill)).fill('0'), ...t].map((g) => parseInt(g || '0', 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const g = ipv6Groups(ip);
  if (!g) return true; // unreadable: refuse
  const v4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  // IPv4 inside IPv6: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::a.b.c.d).
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return g[6] === 0 && g[7] <= 1 && g[5] === 0 ? true : isPrivateAddress(v4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b) return isPrivateAddress(v4(g[6], g[7]));
  return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xff00) === 0xff00;
}

// The URL comes from the model, so only public http(s) hosts are allowed:
// nothing on this computer or the local network (router, the llama-server).
async function assertPublicUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new AppError('web-bad-url', raw);
  }
  if (!['http:', 'https:'].includes(u.protocol)) throw new AppError('web-bad-url', raw);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) throw new AppError('web-blocked', host);
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true }).catch(() => []);
  if (!addrs.length) throw new AppError('web-bad-url', host);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new AppError('web-blocked', host);
  return u;
}

function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  const body = html
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|br|section|article)>/gi, '\n');
  const text = decodeEntities(body.replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1)
    .join('\n');
  return { title: title ? stripTags(title) : '', text };
}

async function openPage(rawUrl) {
  let url = String(rawUrl || '').trim();
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(url);
    const res = await fetchText(u.href);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.get('location')) {
      url = new URL(res.headers.get('location'), u).href; // re-checked on the next hop
      continue;
    }
    if (!res.ok) throw new AppError('web-open-failed', `HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/text\/html|text\/plain|application\/xhtml/i.test(type)) throw new AppError('web-unsupported', type);
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_PAGE_BYTES);
    const raw = buf.toString('utf8');
    const { title, text } = /html/i.test(type) ? htmlToText(raw) : { title: '', text: raw };
    return { url: u.href, title, text: text.slice(0, MAX_PAGE_CHARS), truncated: text.length > MAX_PAGE_CHARS };
  }
  throw new AppError('web-open-failed', 'too many redirects');
}

module.exports = { search, openPage, parseResults, assertPublicUrl, htmlToText };
