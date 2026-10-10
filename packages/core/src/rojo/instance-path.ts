const ESCAPES: Record<string, string> = { '\\': '\\', n: '\n', r: '\r', t: '\t', '"': '"' };
const LUAU_KEYWORDS = new Set([
  'and', 'break', 'continue', 'do', 'else', 'elseif', 'end', 'export',
  'false', 'for', 'function', 'if', 'in', 'local', 'nil', 'not', 'or',
  'repeat', 'return', 'then', 'true', 'type', 'until', 'while',
]);

/** The path the plugin would print (getInstancePath) for these name segments; parseInstancePath reverses it. */
export function formatInstancePath(segments: string[]): string {
  let text = 'game';
  for (const segment of segments) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment) && !LUAU_KEYWORDS.has(segment)) {
      text += `.${segment}`;
    } else {
      const escaped = segment.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/"/g, '\\"');
      text += `["${escaped}"]`;
    }
  }
  return text;
}

/**
 * The name segments of a path the plugin printed (getInstancePath): `game`,
 * then `.Name` for simple names and `["..."]` for the rest. Undefined when the
 * text is not such a path, so a caller never matches a guessed segment.
 */
export function parseInstancePath(path: string): string[] | undefined {
  if (!path.startsWith('game')) return undefined;
  const segments: string[] = [];
  let index = 4;
  while (index < path.length) {
    if (path[index] === '.') {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(path.slice(index + 1));
      if (!match) return undefined;
      segments.push(match[0]);
      index += 1 + match[0].length;
    } else if (path.startsWith('["', index)) {
      let cursor = index + 2;
      let name = '';
      for (;;) {
        if (cursor >= path.length) return undefined;
        const char = path[cursor];
        if (char === '\\') {
          const escaped = ESCAPES[path[cursor + 1]];
          if (escaped === undefined) return undefined;
          name += escaped;
          cursor += 2;
        } else if (char === '"') {
          break;
        } else {
          name += char;
          cursor += 1;
        }
      }
      if (path[cursor + 1] !== ']') return undefined;
      segments.push(name);
      index = cursor + 2;
    } else {
      return undefined;
    }
  }
  return segments;
}
