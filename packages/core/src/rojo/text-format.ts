const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** A file's own line-ending and BOM style, so it can be written back unchanged apart from the edit. */
export interface TextFormat {
  bom: boolean;
  eol: 'lf' | 'crlf';
}

const hasBom = (bytes: Buffer): boolean => bytes.length >= 3 && bytes.subarray(0, 3).equals(UTF8_BOM);

/** Detects a file's BOM and line ending: `eol` is 'crlf' when CRLF breaks are the majority, else 'lf'. */
export function detectFormat(bytes: Buffer): TextFormat {
  const bom = hasBom(bytes);
  const text = (bom ? bytes.subarray(3) : bytes).toString('utf8');
  let crlf = 0;
  let lf = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '\n') continue;
    if (i > 0 && text[i - 1] === '\r') crlf += 1;
    else lf += 1;
  }
  return { bom, eol: crlf > lf ? 'crlf' : 'lf' };
}

/**
 * The text Studio sees once Rojo delivers the file: Rojo strips a UTF-8 BOM
 * and converts CRLF to LF on the way in, confirmed on the Windows run.
 */
export function toStudioText(bytes: Buffer): string {
  const body = hasBom(bytes) ? bytes.subarray(3) : bytes;
  return body.toString('utf8').replace(/\r\n/g, '\n');
}

/** The bytes to write back to a file in its own style, given the plugin's planned LF source. */
export function toFileBytes(lfText: string, format: TextFormat): Buffer {
  const text = format.eol === 'crlf' ? lfText.replace(/\n/g, '\r\n') : lfText;
  const body = Buffer.from(text, 'utf8');
  return format.bom ? Buffer.concat([UTF8_BOM, body]) : body;
}
