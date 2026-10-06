import { randomBytes } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { sourceRevision } from './source-revision.js';

export type WriteOutcome = { ok: true } | { ok: false; actualRevision: string; actual: string };

/**
 * Replaces a source file only if it still holds the revision the caller
 * compared against, through a temporary file in the same folder and a rename,
 * so the file is never left half-written and a newer edit is never replaced.
 */
export async function compareAndWrite(file: string, expectedRevision: string, content: string): Promise<WriteOutcome> {
  const refuse = (bytes: Buffer): WriteOutcome => ({ ok: false, actualRevision: sourceRevision(bytes), actual: bytes.toString('utf8') });
  const before = await fs.readFile(file);
  if (sourceRevision(before) !== expectedRevision) return refuse(before);
  const { mode } = await fs.stat(file);
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.roqer-${randomBytes(6).toString('hex')}.tmp`);
  let renamed = false;
  try {
    const handle = await fs.open(temp, 'wx', mode & 0o777);
    try {
      await handle.writeFile(content, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    // Checked again just before the rename: an editor may have saved meanwhile.
    const latest = await fs.readFile(file);
    if (sourceRevision(latest) !== expectedRevision) return refuse(latest);
    await fs.rename(temp, file);
    renamed = true;
    return { ok: true };
  } finally {
    if (!renamed) await fs.rm(temp, { force: true });
  }
}
