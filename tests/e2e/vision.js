const { _electron } = require('playwright-core');
const zlib = require('zlib'); const fs = require('fs');
const SP = process.argv[2], root = require('path').resolve(__dirname, '../..');
const env = { ...process.env, XDG_CONFIG_HOME: SP + '/e2e-home', BLAZMA_LLAMA_SERVER: SP + '/llama.cpp/build/bin/llama-server', BLAZMA_HF_ENDPOINT: 'http://127.0.0.1:18999' };
// Minimal PNG: white 256x256 with a red filled circle.
function png() {
  const W = 256, H = 256, raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; for (let x = 0; x < W; x++) { const o = y * (W * 3 + 1) + 1 + x * 3; const inC = (x - 128) ** 2 + (y - 128) ** 2 < 80 ** 2; raw[o] = 255; raw[o + 1] = inC ? 0 : 255; raw[o + 2] = inC ? 0 : 255; } }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
(async () => {
  const app = await _electron.launch({ executablePath: root + '/node_modules/electron/dist/electron', args: [root, '--no-sandbox'], cwd: root, env });
  const win = await app.firstWindow(); await win.waitForLoadState('load');
  const logs = []; win.on('pageerror', e => logs.push('pageerror: ' + e.message)); win.on('console', m => m.type() === 'error' && logs.push(m.text()));
  const seen = new Set(); let s;
  for (let i = 0; i < 1200; i++) { s = await win.evaluate(() => window.blazma.getSetupState()); if (!seen.has(s.phase)) { seen.add(s.phase); console.log('phase', s.phase, s.progress ? JSON.stringify(s.progress) : ''); } if (s.phase === 'ready' || s.phase === 'error') break; await win.waitForTimeout(500); }
  console.log('vision:', s.vision, '| attach button visible:', await win.isVisible('#btn-attach'));
  const m = JSON.parse(fs.readFileSync(SP + '/e2e-home/Blazma AI/models.json', 'utf8'));
  console.log('manifest files:', Object.values(m)[0].files.map(f => f.path).join(', '));
  await win.setInputFiles('#file-input', { name: 'circle.png', mimeType: 'image/png', buffer: png() });
  await win.waitForTimeout(500);
  console.log('preview thumbs:', await win.locator('.thumb').count());
  await win.screenshot({ path: SP + '/vision-1.png' });
  await win.fill('#chat-input', 'ما الشكل الموجود في الصورة؟ وما لونه؟');
  await win.press('#chat-input', 'Enter');
  await win.waitForTimeout(1500); await win.waitForSelector('#btn-send:not([hidden])', { timeout: 400000 });
  console.log('user msg images:', await win.locator('.msg-user .msg-images img').count());
  console.log('answer:', (await win.textContent('.msg-ai .msg-body')).slice(0, 300));
  await win.screenshot({ path: SP + '/vision-2.png' });
  console.log(logs.join('\n'));
  await app.close();
})().catch(e => { console.error('FAIL', e); process.exit(1); });
