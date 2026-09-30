'use strict';

// "التحقق من التحديثات" on the settings page. Runs only when the user asks:
// one request to GitHub for the app's latest release and one for llama.cpp's.
// Nothing is installed automatically; the engine update is a separate click
// (setup.updateEngine), and a new app version opens its GitHub page.

const { app, net } = require('electron');
const engine = require('./engine');
const { AppError } = require('./errors');

const APP_REPO = 'mr-kateba/blazma-ai';
const APP_RELEASES_PAGE = `https://github.com/${APP_REPO}/releases/`;

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

async function checkApp() {
  const current = app.getVersion();
  let res;
  try {
    res = await net.fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Blazma-AI' },
    });
  } catch (err) {
    throw new AppError('network', err.message);
  }
  // 404: the repository has no published release yet.
  if (res.status === 404) return { current, latest: null, newer: false, url: null };
  if (!res.ok) throw new AppError('update-check', `GitHub HTTP ${res.status}`);
  const json = await res.json();
  const latest = String(json.tag_name || '');
  const url = typeof json.html_url === 'string' && json.html_url.startsWith(APP_RELEASES_PAGE) ? json.html_url : null;
  return { current, latest, newer: Boolean(latest) && compareVersions(latest, current) > 0, url };
}

async function checkEngine(nvidia) {
  const installed = engine.installedEngine();
  if (installed && installed.kind === 'dev') return { installed: installed.tag, latest: null, newer: false, dev: true };
  const release = await engine.findRelease(nvidia);
  const newer = !installed || engine.tagNumber(release.tag) > engine.tagNumber(installed.tag);
  return { installed: installed ? installed.tag : null, variant: installed ? installed.variant : null, latest: release.tag, newer };
}

module.exports = { checkApp, checkEngine, compareVersions, APP_RELEASES_PAGE };
