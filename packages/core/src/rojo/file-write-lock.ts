import { createHash } from 'crypto';
import { promises as fs, type BigIntStats } from 'fs';
import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { isOwnSourceWriteOwner, newSourceWriteOwner, publishSourceWriteOwner, readSourceWriteOwner, removeOwnedSourceWriteDirectory, removeNewEmptySourceWriteDirectory, sourceWritePublicationError,
  sameSourceWriteDirectory, sameSourceWriteOwner, sourceWriteOwnerStatus, withSourceWriteGuard } from './file-write-owner.js';

// Every writer uses the same policy and namespace, independent of its project,
// bridge port, worktree, or managed-instance registry override.
export const SOURCE_WRITE_LOCK_STALE_MS = 30_000;
const SOURCE_WRITE_LOCK_UPDATE_MS = 5_000;
/**
 * How long to keep retrying a release that met another writer's guard (held
 * for milliseconds) or a delete Windows briefly refused: first in the call,
 * then in the background, so a finished request never leaves its file locked.
 */
const RELEASE_RETRY_DELAYS_MS = [25, 50, 100, 200, 400, 800];
const BACKGROUND_RELEASE_DELAYS_MS = [2_000, 5_000, 10_000, 20_000, 40_000];
const RETRYABLE_RELEASE_CODES = new Set(['EGUARDBUSY', 'ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES']);

/** Owner tokens of the leases this process holds right now; one of ours not in here was left behind. */
const liveTokens = new Set<string>();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const retryable = (error: unknown) => RETRYABLE_RELEASE_CODES.has(String((error as NodeJS.ErrnoException)?.code)) ||
  RETRYABLE_RELEASE_CODES.has(String(((error as { cause?: NodeJS.ErrnoException })?.cause)?.code));

export function sourceWriteLockPath(realFile: string): string {
  const key = createHash('sha256').update(realFile).digest('hex');
  return path.join(os.homedir(), '.roqer', 'rojo-write-locks', 'v1', `${key}.lock`);
}

/** Keeps trying to remove a lease this process left behind, without holding the process open. */
function retryReleaseInBackground(removeOurs: () => void): void {
  const attempt = (index: number) => {
    if (index >= BACKGROUND_RELEASE_DELAYS_MS.length) return;
    setTimeout(() => {
      try { removeOurs(); }
      catch (error) { if (retryable(error)) attempt(index + 1); }
    }, BACKGROUND_RELEASE_DELAYS_MS[index]).unref();
  };
  attempt(0);
}

export async function acquireSourceWriteLock(realFile: string): Promise<{
  assertHeld: () => Promise<void>;
  assertHeldSync: () => void;
  release: () => Promise<void>;
}> {
  const lockPath = sourceWriteLockPath(realFile);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const owner = newSourceWriteOwner();
  let compromised: Error | undefined;
  let identity: BigIntStats | undefined;
  const sameIdentity = (current: BigIntStats) => identity !== undefined && sameSourceWriteDirectory(identity, current);
  const busy = () => Object.assign(new Error(`The Rojo write lease is busy or its owner cannot be verified. Retry after the writer finishes. Lease: ${lockPath}`), { code: 'ELOCKED' });
  const remove = (directory: string) => withSourceWriteGuard(directory, owner, () => {
    const currentIdentity = nativeFs.lstatSync(directory, { bigint: true });
    const currentOwner = readSourceWriteOwner(directory);
    if (identity) {
      if (!sameIdentity(currentIdentity)) {
        throw Object.assign(new Error('The Rojo source write lock was replaced.'), { code: 'ECOMPROMISED' });
      }
      if (!currentOwner) {
        // A previous removal may have unlinked our owner file then failed
        // rmdir. Only remove the same, now-empty directory, never an entry.
        removeNewEmptySourceWriteDirectory(directory, identity);
        return;
      }
      if (!sameSourceWriteOwner(owner, currentOwner)) {
        throw Object.assign(new Error('The Rojo source write lock owner was replaced.'), { code: 'ECOMPROMISED' });
      }
    } else {
      if (currentIdentity.mtimeMs >= BigInt(Date.now() - SOURCE_WRITE_LOCK_STALE_MS)) throw busy();
      if (!currentOwner) {
        // An owner file is published under this same guard as its directory,
        // so a stale directory with none is what a failed removal left behind.
        // rmdir refuses a directory that still holds anything, such as an
        // owner file that cannot be read.
        if (nativeFs.existsSync(path.join(directory, 'owner.json'))) throw busy();
        removeNewEmptySourceWriteDirectory(directory, currentIdentity);
        return;
      }
      // Ours, but from a request that is over: this process left it behind and may take it back.
      const orphanOfOurs = isOwnSourceWriteOwner(currentOwner) && !liveTokens.has(currentOwner.token);
      if (!orphanOfOurs && sourceWriteOwnerStatus(currentOwner) !== 'gone') throw busy();
    }
    removeOwnedSourceWriteDirectory(directory, currentIdentity, currentOwner);
  });
  const release = await lockfile.lock(realFile, {
    realpath: false, // The caller already resolved the actual source file.
    lockfilePath: lockPath,
    stale: SOURCE_WRITE_LOCK_STALE_MS,
    update: SOURCE_WRITE_LOCK_UPDATE_MS,
    // No delayed retry can survive the desktop's normal 20s call budget.
    retries: 0,
    onCompromised: (error) => { compromised = error; },
    // The library clears its heartbeat before release. Check that it is
    // removing our directory, rather than a successor's replacement lock.
    fs: {
      realpath: nativeFs.realpath,
      mkdir(directory: string, callback: (error: NodeJS.ErrnoException | null) => void) {
        try {
          withSourceWriteGuard(directory, owner, () => {
            nativeFs.mkdirSync(directory, { mode: 0o700 });
            try {
              identity = nativeFs.lstatSync(directory, { bigint: true });
              publishSourceWriteOwner(directory, owner, identity);
            } catch (error) {
              let cleanupFailure: unknown;
              if (identity) {
                try { removeNewEmptySourceWriteDirectory(directory, identity); }
                catch (cleanupError) { cleanupFailure = cleanupError; }
              } else cleanupFailure = new Error('The new lease directory identity could not be read.');
              throw sourceWritePublicationError(directory, error, cleanupFailure);
            }
          });
          callback(null);
        } catch (error) { callback(error as NodeJS.ErrnoException); }
      },
      stat: nativeFs.stat,
      utimes: nativeFs.utimes,
      rmdir(directory: string, callback: (error: NodeJS.ErrnoException | null) => void) {
        try { remove(directory); callback(null); }
        catch (error) { callback(error as NodeJS.ErrnoException); }
      },
      rmdirSync(directory: string) {
        remove(directory);
      },
    },
  }).catch((error: NodeJS.ErrnoException) => {
    // The library refuses a held, fresh lease with its own wording; say it as every other busy refusal does.
    if (error?.code === 'ELOCKED') throw busy();
    throw error;
  });
  liveTokens.add(owner.token);
  const removeOurs = () => {
    try { remove(lockPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  };
  const assertOwner = () => {
    const currentOwner = readSourceWriteOwner(lockPath);
    if (!currentOwner || !sameSourceWriteOwner(owner, currentOwner)) {
      throw Object.assign(new Error('The Rojo source write lock was lost; read the script before retrying.'), { code: 'ECOMPROMISED' });
    }
  };
  return {
    assertHeldSync() {
      if (compromised) throw compromised;
      assertOwner();
      const current = nativeFs.statSync(lockPath, { bigint: true });
      if (!sameIdentity(current) || current.mtimeMs < BigInt(Date.now() - SOURCE_WRITE_LOCK_STALE_MS)) {
        throw Object.assign(new Error('The Rojo source write lock was lost; read the script before retrying.'), { code: 'ECOMPROMISED' });
      }
    },
    async assertHeld() {
      if (compromised) throw compromised;
      assertOwner();
      const current = await fs.stat(lockPath, { bigint: true });
      if (compromised) throw compromised;
      if (!sameIdentity(current) ||
          current.mtimeMs < BigInt(Date.now() - SOURCE_WRITE_LOCK_STALE_MS)) {
        throw Object.assign(new Error('The Rojo source write lock was lost; read the script before retrying.'), { code: 'ECOMPROMISED' });
      }
    },
    async release() {
      liveTokens.delete(owner.token);
      try { await release(); }
      catch (error) {
        // A heartbeat/probe failure, another writer's guard, or a delete Windows
        // refuses for a moment can each fail the library's removal, after it has
        // already forgotten the lock. This operation is finished: under the
        // metadata guard, clean only the exact directory and token it published,
        // retrying briefly, then in the background, so the file never stays locked.
        let cleanupError: unknown;
        for (const delay of [0, ...RELEASE_RETRY_DELAYS_MS]) {
          if (delay > 0) await sleep(delay);
          try {
            removeOurs();
            return;
          } catch (failure) {
            cleanupError = failure;
            if (!retryable(failure)) break;
          }
        }
        if (retryable(cleanupError)) retryReleaseInBackground(removeOurs);
        throw sourceWritePublicationError(lockPath, error, cleanupError, 'release');
      }
    },
  };
}
