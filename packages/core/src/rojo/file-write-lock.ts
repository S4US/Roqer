import { createHash } from 'crypto';
import { promises as fs, type BigIntStats } from 'fs';
import * as nativeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import lockfile from 'proper-lockfile';
import { newSourceWriteOwner, publishSourceWriteOwner, readSourceWriteOwner, removeOwnedSourceWriteDirectory, removeNewEmptySourceWriteDirectory, sourceWritePublicationError,
  sameSourceWriteDirectory, sameSourceWriteOwner, sourceWriteOwnerStatus, withSourceWriteGuard } from './file-write-owner.js';

// Every writer uses the same policy and namespace, independent of its project,
// bridge port, worktree, or managed-instance registry override.
export const SOURCE_WRITE_LOCK_STALE_MS = 30_000;
const SOURCE_WRITE_LOCK_UPDATE_MS = 5_000;

export function sourceWriteLockPath(realFile: string): string {
  const key = createHash('sha256').update(realFile).digest('hex');
  return path.join(os.homedir(), '.roqer', 'rojo-write-locks', 'v1', `${key}.lock`);
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
  const busy = () => Object.assign(new Error('The Rojo write lease is busy or its owner cannot be verified. Retry after the writer finishes.'), { code: 'ELOCKED' });
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
    } else if (!currentOwner || currentIdentity.mtimeMs >= BigInt(Date.now() - SOURCE_WRITE_LOCK_STALE_MS) || sourceWriteOwnerStatus(currentOwner) !== 'gone') {
      throw busy();
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
  });
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
      try { await release(); }
      catch (error) {
        // A heartbeat/probe failure can make the library forget its lock.
        // This operation is finished. Under the metadata guard, clean only
        // the exact directory and token this request originally published.
        try { remove(lockPath); }
        catch (cleanupError) {
          if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw sourceWritePublicationError(lockPath, error, cleanupError, 'release');
          }
        }
      }
    },
  };
}
