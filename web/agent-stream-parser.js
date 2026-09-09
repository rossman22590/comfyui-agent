// Stream only the declared root ops array. A nested "ops" key, or text that
// merely mentions one, must never become a graph mutation.
export function extractCompleteOps(buffer) {
  const match = /^\s*\{\s*"ops"\s*:\s*\[/.exec(buffer);
  if (!match) return [];
  const ops = [];
  let i = match[0].length;
  while (i < buffer.length) {
    while (/\s/.test(buffer[i] ?? "") && i < buffer.length) i++;
    if (buffer[i] !== "{") return ops;
    const start = i;
    let depth = 0, inString = false, escaped = false, end = -1;
    for (; i < buffer.length; i++) {
      const ch = buffer[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) { end = ++i; break; }
    }
    if (end < 0) return ops;
    try { ops.push(JSON.parse(buffer.slice(start, end))); } catch { return ops; }
    while (/\s/.test(buffer[i] ?? "") && i < buffer.length) i++;
    if (buffer[i] !== ",") return ops;
    i++;
  }
  return ops;
}
