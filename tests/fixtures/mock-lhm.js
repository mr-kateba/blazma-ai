// Mimics LibreHardwareMonitor's /data.json (shape from HttpServer.cs GenerateJsonForNode).
const http = require('http');
const mode = process.argv[2] || 'ok';
const s = (Text, Type, RawValue, id) => ({ id: 0, Text, Min: '', Value: `${RawValue}`, Max: '', SensorId: id, Type, RawMin: RawValue, RawValue, RawMax: RawValue, ImageURL: 'images/transparent.png', Children: [] });
const tree = { id: 0, Text: 'Sensor', Min: 'Min', Value: 'Value', Max: 'Max', Children: [{ id: 1, Text: 'DESKTOP', Children: [
  { id: 2, Text: 'Intel Core i7-13700K', HardwareId: '/intelcpu/0', ImageURL: 'images_icon/cpu.png', Children: [
    { id: 3, Text: 'Temperatures', Children: [s('CPU Core #1', 'Temperature', 55, '/intelcpu/0/temperature/0'), s('CPU Package', 'Temperature', 61.5, '/intelcpu/0/temperature/16'), s('Core Max', 'Temperature', 64, '/intelcpu/0/temperature/17')] },
    { id: 4, Text: 'Powers', Children: [s('CPU Package', 'Power', 87.25, '/intelcpu/0/power/0'), s('CPU Cores', 'Power', 70, '/intelcpu/0/power/1')] },
  ] },
  { id: 5, Text: 'NVIDIA GeForce RTX 5070', HardwareId: '/gpu-nvidia/0', Children: [{ id: 6, Text: 'Temperatures', Children: [s('GPU Core', 'Temperature', 99, '/gpu-nvidia/0/temperature/0')] }] },
] }] };
http.createServer((req, res) => {
  if (mode === 'auth') { res.writeHead(401); return res.end(); }
  if (req.url !== '/data.json') { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(tree));
}).listen(8085, '127.0.0.1', () => console.log('mock lhm', mode));
