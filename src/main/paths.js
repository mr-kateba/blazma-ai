'use strict';

const path = require('node:path');
const { app } = require('electron');

const userData = () => app.getPath('userData');

module.exports = {
  userData,
  engineRoot: () => path.join(userData(), 'engine'),
  defaultModelsDir: () => path.join(userData(), 'models'),
  settingsFile: () => path.join(userData(), 'settings.json'),
  modelsManifest: () => path.join(userData(), 'models.json'),
  pidFile: () => path.join(userData(), 'llama-server.pid'),
  catalogFile: () => path.join(__dirname, '..', '..', 'catalog.json'),
};
