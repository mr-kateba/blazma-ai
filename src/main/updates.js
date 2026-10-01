'use strict';

// "التحقق من التحديثات" on the settings page. Runs only when the user asks:
// one request to GitHub for the app's latest release and one for llama.cpp's.
// Nothing is installed automatically: the engine update is a separate click
// (setup.updateEngine), and a new app version is downloaded and installed by
// electron-updater (MIT) only when the user presses "تنزيل وتثبيت". It reads
// latest.yml from the GitHub release and checks the installer's sha512; the
// app is not code-signed, so there is no publisher name to check.

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
  return { current, latest, newer: Boolean(latest) && compareVersions(latest, current) > 0, url, canInstall: appUpdateSupported() };
}

async function checkEngine(nvidia) {
  const installed = engine.installedEngine();
  if (installed && installed.kind === 'dev') return { installed: installed.tag, latest: null, newer: false, dev: true };
  const release = await engine.findRelease(nvidia);
  const newer = !installed || engine.tagNumber(release.tag) > engine.tagNumber(installed.tag);
  return { installed: installed ? installed.tag : null, variant: installed ? installed.variant : null, latest: release.tag, newer };
}

// Installing in place works for the installed Windows app only.
function appUpdateSupported() {
  return app.isPackaged && process.platform === 'win32';
}

let updater = null;
function getUpdater() {
  if (!appUpdateSupported()) throw new AppError('update-unsupported');
  if (!updater) {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = false;
    updater.autoInstallOnAppQuit = false;
  }
  return updater;
}

async function downloadApp(onProgress = () => {}) {
  const u = getUpdater();
  const check = await u.checkForUpdates();
  if (!check || !check.isUpdateAvailable) return { version: null };
  const listener = (p) => onProgress(Math.floor(p.percent || 0));
  u.on('download-progress', listener);
  try {
    await u.downloadUpdate();
  } finally {
    u.removeListener('download-progress', listener);
  }
  return { version: check.updateInfo.version };
}

// Closes the app (which stops llama-server) and runs the new installer.
function installApp() {
  getUpdater().quitAndInstall(false, true);
}

module.exports = { checkApp, checkEngine, compareVersions, APP_RELEASES_PAGE, appUpdateSupported, downloadApp, installApp };
