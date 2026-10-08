/**
 * The plugin's script revision (studio-plugin/src/modules/SourceRevision.ts),
 * computed on the host over a file's bytes, so a file on disk and a script in
 * Studio can be compared without asking Studio.
 */
export function sourceRevision(source: string | Uint8Array): string {
  const bytes = typeof source === 'string' ? Buffer.from(source, 'utf8') : source;
  let hashA = 5381;
  let hashB = 0;
  for (const byte of bytes) {
    hashA = (hashA * 33 + byte) % 4294967296;
    hashB = (hashB * 65599 + byte) % 4294967296;
  }
  return `sr1:${bytes.length}:${hashA.toString(16).padStart(8, '0')}${hashB.toString(16).padStart(8, '0')}`;
}
