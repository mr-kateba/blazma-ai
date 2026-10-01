'use strict';

const path = require('node:path');
const settings = require('./settings');
const { app, BrowserWindow, Menu, Notification, nativeTheme, session } = require('electron');
const { registerScheme, handleAppProtocol, setServerPort, APP_ORIGIN } = require('./protocol');
const vscode = require('./vscode');
const { registerIpc } = require('./ipc');
const { Setup } = require('./setup');
const { Monitor } = require('./monitor');

// Must run before `ready` so userData resolves to "%APPDATA%\Blazma AI".
app.setName('Blazma AI');
// Windows only shows notifications for apps with an AppUserModelID.
if (process.platform === 'win32') app.setAppUserModelId('com.blazma.ai');
registerScheme();

let mainWindow = null;
const setup = new Setup();
const monitor = new Monitor(setup);

// System notifications are only for when the window is not in view; the
// page shows its own banner otherwise.
const NOTIFY_TEXT = {
  'gpu-temp': (a) => `حرارة كرت الشاشة ${Math.round(a.value)} درجة مئوية`,
  'thermal-slowdown': () => 'كرت الشاشة خفّض سرعته بسبب الحرارة',
  'hw-slowdown': () => 'كرت الشاشة خفّض سرعته',
};

function onAlerts(alerts) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('monitor:alerts', alerts);
  const visible = mainWindow && mainWindow.isVisible() && !mainWindow.isMinimized() && mainWindow.isFocused();
  if (visible || !Notification.isSupported()) return;
  const worst = alerts.find((a) => a.level === 'danger') || alerts[0];
  if (worst && NOTIFY_TEXT[worst.code]) new Notification({ title: 'Blazma AI', body: NOTIFY_TEXT[worst.code](worst) }).show();
}

function sendState(state) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('setup:state', state);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    title: 'Blazma AI',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e1014' : '#f5f6f8',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  // A reloaded page starts without the programming page shown.
  mainWindow.webContents.on('did-start-loading', () => vscode.hideView());
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function hardenWebContents() {
  app.on('web-contents-created', (_event, contents) => {
    // The app's pages stay on app://blazma; the VS Code view (vscode.js)
    // stays on its local server and keeps its own frames (webviews).
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`) && !vscode.allowsNavigation(contents, url)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.on('will-frame-navigate', (details) => {
      if (!details.isMainFrame && !vscode.ownsContents(contents)) details.preventDefault();
    });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // Only the microphone, only for the app's own page, and only audio (the
  // chat's voice input). No camera, notifications, location, etc.
  const audioOnly = (types) => Array.isArray(types) && types.length > 0 && types.every((t) => t === 'audio');
  session.defaultSession.setPermissionRequestHandler((_wc, perm, callback, details) =>
    callback(perm === 'media' && String(details.requestingUrl || '').startsWith(`${APP_ORIGIN}/`) && audioOnly(details.mediaTypes)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin, details) => perm === 'media' && origin === APP_ORIGIN && details.mediaType === 'audio');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    Menu.setApplicationMenu(null);
    hardenWebContents();
    handleAppProtocol();
    registerIpc({ setup, monitor, getWindow: () => mainWindow });

    // The CSP served with the page names the server port, so pick it first.
    setServerPort(await setup.choosePort());
    setup.on('state', sendState);
    setup.on('port-changed', (port) => {
      setServerPort(port);
      if (mainWindow) mainWindow.webContents.reload();
    });

    monitor.on('sample', (sample) => mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.send('monitor:sample', sample));
    monitor.on('alerts', onAlerts);
    monitor.startBackground();

    nativeTheme.themeSource = settings.get().theme;
    createWindow();
    setup.init();
  });

  app.on('window-all-closed', () => app.quit());

  // Never leave llama-server running (and holding GPU memory) after we exit.
  // Every helper program started by the app ends with it: the embedding
  // server (مكتبتي), whisper-server (voice), sd-server (drawing) and llama-server.
  const stopHelpers = () => {
    for (const mod of ['./knowledge', './voice', './images', './vscode']) {
      try {
        require(mod).stop();
      } catch {
        /* already stopped */
      }
    }
  };
  app.on('will-quit', () => {
    stopHelpers();
    monitor.shutdown();
    setup.shutdownSync();
  });
  process.on('exit', () => {
    stopHelpers();
    setup.shutdownSync();
  });
  process.on('uncaughtException', (err) => {
    console.error(err);
    stopHelpers();
    setup.shutdownSync();
    app.exit(1);
  });
}
