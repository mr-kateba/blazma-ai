// Line diff (longest common subsequence) for showing the assistant's changes.

const MAX_CELLS = 4_000_000;

// Returns [{ type: ' ' | '+' | '-', text }].
export function diffLines(before, after) {
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  // Trim the common head and tail first; most edits are small.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ type: ' ', text }));
  const tail = a.slice(endA).map((text) => ({ type: ' ', text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  let middle;
  if (ma.length * mb.length > MAX_CELLS) {
    middle = [...ma.map((text) => ({ type: '-', text })), ...mb.map((text) => ({ type: '+', text }))];
  } else {
    const n = ma.length;
    const m = mb.length;
    const table = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i][j] = ma[i] === mb[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    middle = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (ma[i] === mb[j]) {
        middle.push({ type: ' ', text: ma[i++] });
        j++;
      } else if (table[i + 1][j] >= table[i][j + 1]) middle.push({ type: '-', text: ma[i++] });
      else middle.push({ type: '+', text: mb[j++] });
    }
    while (i < n) middle.push({ type: '-', text: ma[i++] });
    while (j < m) middle.push({ type: '+', text: mb[j++] });
  }
  return [...head, ...middle, ...tail];
}

export function diffStats(ops) {
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.type === '+') added++;
    else if (op.type === '-') removed++;
  }
  return { added, removed };
}

// Changed lines with a few lines of context around them, as hunks.
export function diffHunks(ops, context = 2) {
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, i) => {
    if (op.type === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(ops.length - 1, i + context); k++) keep[k] = 1;
  });
  const hunks = [];
  let current = null;
  let lineA = 1;
  let lineB = 1;
  ops.forEach((op, i) => {
    if (keep[i]) {
      if (!current) {
        current = { startA: lineA, startB: lineB, lines: [] };
        hunks.push(current);
      }
      current.lines.push(op);
    } else current = null;
    if (op.type !== '+') lineA++;
    if (op.type !== '-') lineB++;
  });
  return hunks;
}
