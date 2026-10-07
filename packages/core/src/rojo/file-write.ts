import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sourceRevision } from './source-revision.js';
import { detectFormat, toFileBytes, toStudioText } from './text-format.js';

export type WriteOutcome = { ok: true } | { ok: false; actualRevision: string; actual: string };

/**
 * Replaces a source file only if it still holds the revision the caller
 * compared against, through a temporary file in the same folder and a rename,
 * so the file is never left half-written and a newer edit is never replaced.
 * Rojo delivers a file to Studio with its BOM stripped and CRLF folded to LF,
 * so the comparison (both before writing and on the re-check before rename)
 * is against the file normalized that same way; `content` is the plugin's
 * planned LF source, written back in the file's own BOM and line-ending
 * style. The `{ok:false}` outcome's `actualRevision`/`actual` describe the
 * file as Studio would see it, normalized the same way. Rejects with an Error
 * when the file cannot be read, stat'ed, written or renamed (for example
 * deleted meanwhile, or locked on Windows); in every case the target is left
 * as it was and no temporary file remains.
 */
export async function compareAndWrite(file: string, expectedRevision: string, content: string): Promise<WriteOutcome> {
  const refuse = (bytes: Buffer): WriteOutcome => {
    const studioText = toStudioText(bytes);
    return { ok: false, actualRevision: sourceRevision(studioText), actual: studioText };
  };
  const before = await fs.readFile(file);
  if (sourceRevision(toStudioText(before)) !== expectedRevision) return refuse(before);
  const format = detectFormat(before);
  const { mode } = await fs.stat(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.roqer-${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const handle = await fs.open(temp, 'wx', mode & 0o777);
    try {
      await handle.writeFile(toFileBytes(content, format));
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Checked again just before the rename: an editor may have saved meanwhile.
    const latest = await fs.readFile(file);
    if (sourceRevision(toStudioText(latest)) !== expectedRevision) return refuse(latest);
    await fs.rename(temp, file);
    renamed = true;
    return { ok: true };
  } finally {
    if (!renamed) await fs.rm(temp, { force: true });
  }
}
