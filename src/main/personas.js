'use strict';

// Custom personas ("شخصيات") made by the user: a name, an emoji and the
// instructions sent as the system prompt. Built-in personas live in the
// renderer's strings (ar.js); these are stored in <userData>/personas.json.

const path = require('node:path');
const crypto = require('node:crypto');
const paths = require('./paths');
const { readJson, writeJson } = require('./jsonfile');
const { AppError } = require('./errors');

const file = () => path.join(paths.userData(), 'personas.json');
const MAX = 50;

function list() {
  return readJson(file(), []).filter((p) => p && typeof p.id === 'string');
}

function save(persona) {
  const name = String((persona && persona.name) || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const prompt = String((persona && persona.prompt) || '').trim().slice(0, 8000);
  if (!name || !prompt) throw new AppError('persona-invalid');
  const icon = Array.from(String((persona && persona.icon) || '🙂').trim()).slice(0, 2).join('') || '🙂';
  const all = list();
  const id = persona.id && /^custom-[a-f0-9]{12}$/.test(persona.id) ? persona.id : `custom-${crypto.randomBytes(6).toString('hex')}`;
  const next = all.filter((p) => p.id !== id);
  if (next.length >= MAX) throw new AppError('persona-invalid', 'too many');
  // 0.2.0: the assistant's own library folders, and "only from its documents".
  const folders = Array.isArray(persona.folders) ? persona.folders.filter((f) => typeof f === 'string' && f.length < 1000).slice(0, 20) : [];
  const strict = Boolean(persona.strict) && folders.length > 0;
  const saved = { id, name, icon, prompt, ...(folders.length ? { folders } : {}), ...(strict ? { strict } : {}) };
  next.push(saved);
  writeJson(file(), next);
  return saved;
}

function remove(id) {
  writeJson(file(), list().filter((p) => p.id !== id));
  return true;
}

module.exports = { list, save, remove };
