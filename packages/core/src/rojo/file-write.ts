import { randomBytes } from 'crypto';
import { promises as fs, renameSync } from 'fs';
import * as path from 'path';
import { acquireSourceWriteLock, sourceWriteLockPath } from './file-write-lock.js';
import { sourceRevision } from './source-revision.js';
import { assertSourceDirectories, assertSourceFileIdentity, assertSourceFileIdentitySync, captureSourceFileIdentity, type SourceFileIdentity } from './source-file-identity.js';
import { detectFormat, toFileBytes, toStudioText } from './text-format.js';

export type WriteOutcome =
  | { ok: true; lockReleaseWarning?: string }
  | { ok: false; actualRevision: string; actual: string; lockReleaseWarning?: string };

/** What a caller is told when the lease could not be released yet: the outcome stands, and where the lease is. */
function releaseWarning(saved: boolean, error: unknown, lockPath: string): string {
  const code = (error as NodeJS.ErrnoException)?.code;
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').slice(0, 300);
  return `${saved ? 'The file was saved' : 'Nothing was written'}, but releasing its write lock failed${code ? ` (${code})` : ''}; `
    + 'Roqer keeps retrying for about a minute. If later saves of this file still report the lease busy, confirm no Roqer bridge is writing it, then delete the lease folder. '
    + `Lease: ${lockPath}. Detail: ${message}`;
}

/**
 * Replaces a source file only if it still holds the revision the caller
 * compared against, through a temporary file in the same folder and a rename,
 * so the file is never left half-written. A shared lease serializes Roqer
 * writers from the first read through rename. External editors do not take
 * that lease; a save after the final read can still race the rename.
 * Rojo delivers a file to Studio with its BOM stripped and CRLF folded to LF,
 * so the comparison (both before writing and on the re-check before rename)
 * is against the file normalized that same way; `content` is the plugin's
 * planned LF source, written back in the file's own BOM and line-ending
 * style. The `{ok:false}` outcome's `actualRevision`/`actual` describe the
 * file as Studio would see it, normalized the same way. Rejects with an Error
 * when the file cannot be read, stat'ed, written or renamed (for example
 * deleted meanwhile, or locked on Windows). A failure to release the lease
 * after a successful rename is reported on the successful outcome, never as
 * an unapplied edit.
 */
export async function compareAndWrite(file: string, expectedRevision: string, content: string, approvedIdentity?: SourceFileIdentity): Promise<WriteOutcome> {
  const identity = approvedIdentity ?? captureSourceFileIdentity(await fs.realpath(file));
  const realFile = identity.file.path;
  const lease = await acquireSourceWriteLock(realFile);
  let failed = false;
  let outcome: WriteOutcome | undefined;
  let lockReleaseWarning: string | undefined;
  try {
    await lease.assertHeld();
    outcome = await compareAndWriteLocked(realFile, expectedRevision, content, async (requireFileIdentity) => {
      await assertSourceFileIdentity(identity, file, requireFileIdentity);
      await lease.assertHeld();
    }, (temporary) => {
      // An asynchronous rename can remain queued after a lease is lost.
      // Keep the final checks and rename in one synchronous commit path.
      assertSourceFileIdentitySync(identity, file);
      lease.assertHeldSync();
      renameSync(temporary, realFile);
    }, () => assertSourceDirectories(identity));
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    try {
      await lease.release();
    } catch (error) {
      // A saved edit stays saved and a refusal stays a refusal; only the lease
      // is left to clean, which the lock keeps retrying. A failed write keeps
      // its own error, the one the caller needs.
      if (!failed && outcome) lockReleaseWarning = releaseWarning(outcome.ok, error, sourceWriteLockPath(realFile));
    }
  }
  return lockReleaseWarning ? { ...outcome!, lockReleaseWarning } : outcome!;
}

async function compareAndWriteLocked(file: string, expectedRevision: string, content: string, assertHeld: (requireFileIdentity: boolean) => Promise<void>, commit: (temporary: string) => void, assertCleanupDirectory: () => Promise<void>): Promise<WriteOutcome> {
  const refuse = (bytes: Buffer): WriteOutcome => {
    const studioText = toStudioText(bytes);
    return { ok: false, actualRevision: sourceRevision(studioText), actual: studioText };
  };
  await assertHeld(false);
  const before = await fs.readFile(file);
  if (sourceRevision(toStudioText(before)) !== expectedRevision) return refuse(before);
  await assertHeld(true);
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
    await assertHeld(false);
    const latest = await fs.readFile(file);
    if (sourceRevision(toStudioText(latest)) !== expectedRevision) return refuse(latest);
    commit(temp);
    renamed = true;
    return { ok: true };
  } finally {
    if (!renamed) {
      // A directory moved by another process may now be a junction/symlink.
      // Do not unlink a same-named file through that replacement path.
      await assertCleanupDirectory();
      await fs.rm(temp, { force: true });
    }
  }
}
