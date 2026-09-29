'use strict';

const path = require('node:path');
const { app, BrowserWindow, Menu, session } = require('electron');
const { registerScheme, handleAppProtocol, setServerPort, APP_ORIGIN } = require('./protocol');
const { registerIpc } = require('./ipc');
const { Setup } = require('./setup');

// Must run before `ready` so userData resolves to "%APPDATA%\Blazma AI".
app.setName('Blazma AI');
registerScheme();

let mainWindow = null;
const setup = new Setup();

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
    backgroundColor: '#0e1014',
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
  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
}

function hardenWebContents() {
  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (event, url) => {
      if (!url.startsWith(`${APP_ORIGIN}/`)) event.preventDefault();
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  // The UI never needs camera, mic, notifications, etc.
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
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
    registerIpc(setup);

    // The CSP served with the page names the server port, so pick it first.
    setServerPort(await setup.choosePort());
    setup.on('state', sendState);
    setup.on('port-changed', (port) => {
      setServerPort(port);
      if (mainWindow) mainWindow.webContents.reload();
    });

    createWindow();
    setup.init();
  });

  app.on('window-all-closed', () => app.quit());

  // Never leave llama-server running (and holding GPU memory) after we exit.
  app.on('will-quit', () => setup.shutdownSync());
  process.on('exit', () => setup.shutdownSync());
  process.on('uncaughtException', (err) => {
    console.error(err);
    setup.shutdownSync();
    app.exit(1);
  });
}
