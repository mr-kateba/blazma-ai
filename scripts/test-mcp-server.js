// A tiny MCP server for testing the app's MCP client (stdio, JSON-RPC 2.0):
// two tools, add_numbers and shop_stock.
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const STOCK = { 'RTX 5070': 4, 'RTX 5080': 0, 'Ryzen 7 9800X3D': 12 };
rl.on('line', (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test-shop', version: '1.0.0' } } });
  else if (m.method === 'tools/list')
    send({
      jsonrpc: '2.0',
      id: m.id,
      result: {
        tools: [
          { name: 'add_numbers', description: 'Add two numbers.', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] } },
          { name: 'shop_stock', description: 'How many units of a product are in stock in the Nakhla shop.', inputSchema: { type: 'object', properties: { product: { type: 'string' } }, required: ['product'] } },
        ],
      },
    });
  else if (m.method === 'tools/call') {
    const { name, arguments: a } = m.params;
    const text = name === 'add_numbers' ? String(Number(a.a) + Number(a.b)) : `${a.product}: ${STOCK[Object.keys(STOCK).find((k) => k.toLowerCase() === String(a.product).toLowerCase())] ?? 'unknown product'} in stock`;
    send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text }] } });
  } else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'unknown' } });
});
