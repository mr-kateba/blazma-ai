'use strict';

// CPU temperature and power from LibreHardwareMonitor (MPL-2.0), when the user
// runs it with its web server on: Options > Remote Web Server > Run (port 8085
// by default). Windows gives no CPU temperature without a kernel driver; this
// way the driver and admin rights belong to LibreHardwareMonitor, not to us.
//
// Format verified in LibreHardwareMonitor's source:
// - LibreHardwareMonitor.Windows.Forms/Utilities/HttpServer.cs, GenerateJsonForNode:
//   GET /data.json -> nested nodes { Text, Children[], HardwareId?, SensorId?,
//   Type? (SensorType name, e.g. "Temperature", "Power"), RawValue? (number) }.
// - LibreHardwareMonitorLib/Hardware/Cpu/GenericCpu.cs, CreateIdentifier:
//   CPU hardware ids are /intelcpu/N and /amdcpu/N.
// - Sensor names: IntelCpu.cs ("CPU Package", "Core Max"), Amd17Cpu.cs
//   ("Core (Tctl/Tdie)", power "Package").

const http = require('node:http');

const TIMEOUT_MS = 800;
const TEMP_NAMES = ['CPU Package', 'Core (Tctl/Tdie)', 'Core Max', 'Tctl', 'Tdie'];
const POWER_NAMES = ['CPU Package', 'Package'];
const CPU_ID = /^\/(intel|amd)cpu\/\d+$/;

function fetchData(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/data.json', timeout: TIMEOUT_MS }, (res) => {
      if (res.statusCode === 401) {
        res.resume();
        resolve({ status: 'auth' });
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        resolve({ status: 'off' });
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > 8 * 1024 * 1024) req.destroy();
        else chunks.push(c);
      });
      res.on('end', () => {
        try {
          resolve({ status: 'ok', tree: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch {
          resolve({ status: 'off' });
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve({ status: 'off' }));
  });
}

function findCpu(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.HardwareId === 'string' && CPU_ID.test(node.HardwareId)) return node;
  for (const child of Array.isArray(node.Children) ? node.Children : []) {
    const found = findCpu(child);
    if (found) return found;
  }
  return null;
}

function sensors(node, out = []) {
  if (node && typeof node.SensorId === 'string' && typeof node.RawValue === 'number' && Number.isFinite(node.RawValue)) out.push(node);
  for (const child of (node && Array.isArray(node.Children) && node.Children) || []) sensors(child, out);
  return out;
}

function pick(list, type, names) {
  for (const name of names) {
    const s = list.find((x) => x.Type === type && x.Text === name);
    if (s) return s.RawValue;
  }
  return null;
}

// { status: 'ok' | 'off' | 'auth' | 'no-sensor', tempC, powerW }
async function readCpu(port) {
  const res = await fetchData(port);
  if (res.status !== 'ok') return { status: res.status, tempC: null, powerW: null };
  const cpu = findCpu(res.tree);
  const list = cpu ? sensors(cpu) : [];
  const tempC = pick(list, 'Temperature', TEMP_NAMES);
  const powerW = pick(list, 'Power', POWER_NAMES);
  // Readings outside physical ranges are dropped rather than shown.
  const temp = tempC != null && tempC > 0 && tempC < 150 ? tempC : null;
  const power = powerW != null && powerW >= 0 && powerW < 1000 ? powerW : null;
  return { status: temp == null && power == null ? 'no-sensor' : 'ok', tempC: temp, powerW: power };
}

module.exports = { readCpu };
