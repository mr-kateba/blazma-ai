// Reads an OpenAI-style server-sent event stream and yields each JSON
// payload. Stops at "data: [DONE]".

export async function* readSse(response) {
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const event = buffer.slice(0, sep);
      buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, '');
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore malformed events rather than breaking the whole reply.
      }
    }
  }
}
