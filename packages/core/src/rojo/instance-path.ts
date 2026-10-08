const ESCAPES: Record<string, string> = { '\\': '\\', n: '\n', r: '\r', t: '\t', '"': '"' };

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
