import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface SourceWriteOwner {
  version: 1;
  host: string;
  pid: number;
  startedAt: string;
  token: string;
}
export type ProcessIdentity = { status: 'running'; startedAt: string } | { status: 'missing' } | { status: 'unknown' };
const hostIdentity = () => `${process.platform}:${os.hostname()}`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/**
 * The start identity of a writer that could not observe its own process (a
 * Windows host whose PowerShell is blocked or in Constrained Language Mode).
 * It still saves, but another writer takes over its stale lease only once its
 * PID is gone; a live PID stays unverifiable, so that fails closed.
 */
const UNVERIFIED = `${process.platform}:unverified`;
const isUnverified = (startedAt: string) => /^(win32|linux|darwin):unverified$/u.test(startedAt);
const validStartedAt = (value: string) => /^win32:[1-9]\d*$/u.test(value) || /^linux:[0-9a-f-]{36}:\d+$/u.test(value) ||
  /^darwin:[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(value) || isUnverified(value);
let selfStartedAt: string | undefined;
/** Until when a failed self observation is not retried, so a blocked PowerShell does not cost every save a spawn. */
let selfUnverifiedUntil = 0;
const SELF_RETRY_MS = 60_000;

/** Windows FILETIME, Linux boot-id/start ticks, or macOS UTC ps start time. */
export function observeSourceWriteProcess(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unknown' };
  if (pid === process.pid && selfStartedAt) return { status: 'running', startedAt: selfStartedAt };
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot;
      if (!systemRoot || !path.isAbsolute(systemRoot)) return { status: 'unknown' };
      const interpreter = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      if (!path.isAbsolute(interpreter)) return { status: 'unknown' };
      const script = `$ErrorActionPreference = 'Stop'; try { $p = [System.Diagnostics.Process]::GetProcessById(${pid}); [Console]::Write($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()) } catch [System.ArgumentException] { [Console]::Write('missing') } catch { [Console]::Write('unknown') }`;
      const result = execFileSync(interpreter, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 4096 }).trim();
      if (result === 'missing') return { status: 'missing' };
      return /^[1-9]\d*$/u.test(result) ? { status: 'running', startedAt: `win32:${result}` } : { status: 'unknown' };
    }
    if (process.platform === 'linux') {
      let stat: string;
      try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        return code === 'ENOENT' || code === 'ESRCH' ? { status: 'missing' } : { status: 'unknown' };
      }
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/u);
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      return /^\d+$/u.test(fields[19] ?? '') && /^[0-9a-f-]{36}$/u.test(boot)
        ? { status: 'running', startedAt: `linux:${boot}:${fields[19]}` } : { status: 'unknown' };
    }
    if (process.platform === 'darwin') {
      const result = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, maxBuffer: 4096, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } }).trim();
      return result ? { status: 'running', startedAt: `darwin:${result}` } : { status: 'unknown' };
    }
  } catch (error) {
    if (process.platform === 'darwin' && (error as { status?: number }).status === 1) return { status: 'missing' };
  }
  return { status: 'unknown' };
}

/** Forgets this process's observed identity; for tests that change what the OS boundary answers. */
export function resetSourceWriteSelfIdentity(): void {
  selfStartedAt = undefined;
  selfUnverifiedUntil = 0;
}

/** This process's start identity as owner records carry it: observed once, or unverified when it cannot be. */
function selfIdentity(): string {
  if (selfStartedAt) return selfStartedAt;
  if (Date.now() < selfUnverifiedUntil) return UNVERIFIED;
  const identity = observeSourceWriteProcess(process.pid);
  if (identity.status === 'running') {
    selfStartedAt = identity.startedAt;
    return selfStartedAt;
  }
  // Coordinating with other writers needs this identity; saving alone does not.
  selfUnverifiedUntil = Date.now() + SELF_RETRY_MS;
  return UNVERIFIED;
}

export function newSourceWriteOwner(): SourceWriteOwner {
  return { version: 1, host: hostIdentity(), pid: process.pid, startedAt: selfIdentity(), token: randomUUID() };
}

/** Whether an owner record names this very process (whatever request made it). */
export function isOwnSourceWriteOwner(owner: SourceWriteOwner): boolean {
  return owner.host === hostIdentity() && owner.pid === process.pid && owner.startedAt === selfIdentity();
}

export function sourceWriteOwnerStatus(owner: SourceWriteOwner, identity?: ProcessIdentity): 'gone' | 'alive' | 'unknown' {
  if (owner.host !== hostIdentity()) return 'unknown';
  const observed = identity ?? observeSourceWriteProcess(owner.pid);
  if (observed.status === 'unknown') return 'unknown';
  if (observed.status === 'missing') return 'gone';
  // An unverified owner whose PID is running cannot be told from a PID reuse: fail closed.
  if (isUnverified(owner.startedAt)) return 'unknown';
  return observed.startedAt !== owner.startedAt ? 'gone' : 'alive';
}

export const sameSourceWriteOwner = (a: SourceWriteOwner, b: SourceWriteOwner) =>
  a.token === b.token && a.host === b.host && a.pid === b.pid && a.startedAt === b.startedAt;

export function readSourceWriteOwner(directory: string): SourceWriteOwner | undefined {
  try {
    const file = path.join(directory, 'owner.json');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return undefined;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<SourceWriteOwner>;
    return owner.version === 1 && typeof owner.host === 'string' && owner.host.length <= 256 &&
      Number.isSafeInteger(owner.pid) && (owner.pid ?? 0) > 0 && typeof owner.startedAt === 'string' &&
      owner.startedAt.startsWith(owner.host.split(':')[0] + ':') && validStartedAt(owner.startedAt) && owner.startedAt.length <= 128 &&
      typeof owner.token === 'string' && UUID.test(owner.token)
      ? owner as SourceWriteOwner : undefined;
  } catch { return undefined; }
}

export const sameSourceWriteDirectory = (a: fs.BigIntStats, b: fs.BigIntStats) =>
  b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;

export function removeNewEmptySourceWriteDirectory(directory: string, identity: fs.BigIntStats): void {
  if (!sameSourceWriteDirectory(identity, fs.lstatSync(directory, { bigint: true }))) {
    throw new Error('The new metadata directory identity changed; cleanup was refused.');
  }
  // rmdir refuses non-empty directories; never delete an unknown entry.
  fs.rmdirSync(directory);
}

export function sourceWritePublicationError(directory: string, failure: unknown, cleanupFailure?: unknown, operation = 'publish'): Error {
  const problem = cleanupFailure ?? failure;
  const message = problem instanceof Error ? problem.message : String(problem);
  const problemCode = (problem as NodeJS.ErrnoException)?.code;
  return Object.assign(new Error(`Could not ${operation} Rojo lease metadata${problemCode ? ` (${problemCode})` : ''}: ${message.replace(/\s+/gu, ' ').slice(0, 120)}. ` +
    (cleanupFailure ? 'Cleanup was not completed safely. Restore I/O access; confirm all writers are stopped before recovering remaining metadata.' : 'Newly created metadata resources were removed; retry after the I/O problem is resolved.') + ` Directory: ${directory}`),
  { code: cleanupFailure ? 'EMETADATARECOVERY' : (failure as NodeJS.ErrnoException)?.code, cause: problem });
}

export function publishSourceWriteOwner(directory: string, owner: SourceWriteOwner, directoryIdentity: fs.BigIntStats): void {
  const file = path.join(directory, 'owner.json');
  let handle: number | undefined;
  let fileIdentity: fs.BigIntStats | undefined;
  let failure: unknown;
  try {
    handle = fs.openSync(file, 'wx', 0o600);
    fileIdentity = fs.fstatSync(handle, { bigint: true });
    fs.writeFileSync(handle, JSON.stringify(owner) + '\n');
  } catch (error) { failure = error; }
  finally {
    if (handle !== undefined) {
      try { fs.closeSync(handle); }
      catch (error) { failure ??= error; }
    }
  }
  if (failure) {
    if (fileIdentity) {
      const current = fs.lstatSync(file, { bigint: true });
      if (!sameSourceWriteDirectory(directoryIdentity, fs.lstatSync(directory, { bigint: true })) || !current.isFile() || current.isSymbolicLink() ||
          current.dev !== fileIdentity.dev || current.ino !== fileIdentity.ino || current.birthtimeNs !== fileIdentity.birthtimeNs) {
        throw sourceWritePublicationError(directory, failure, new Error('The created owner file changed.'));
      }
      fs.unlinkSync(file);
    }
    throw failure;
  }
}

export function removeOwnedSourceWriteDirectory(directory: string, identity: fs.BigIntStats, owner: SourceWriteOwner): void {
  const current = readSourceWriteOwner(directory);
  if (!sameSourceWriteDirectory(identity, fs.lstatSync(directory, { bigint: true })) || !current || !sameSourceWriteOwner(owner, current)) {
    throw Object.assign(new Error('The Rojo source write lease owner changed.'), { code: 'ECOMPROMISED' });
  }
  fs.unlinkSync(path.join(directory, 'owner.json'));
  fs.rmdirSync(directory);
}

/** Serializes lease-directory publication/removal; never auto-reclaim this short guard. */
export function withSourceWriteGuard<T>(directory: string, owner: SourceWriteOwner, action: () => T): T {
  const guard = `${directory}.guard`;
  try { fs.mkdirSync(guard, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw Object.assign(new Error(`The Rojo lease metadata guard is busy or interrupted at ${guard}. Retry after the writer finishes; if it persists, confirm all writers are stopped before clearing this guard.`), { code: 'EGUARDBUSY' });
  }
  let identity: fs.BigIntStats | undefined;
  let published = false;
  let failure: unknown;
  let failed = false;
  let result!: T;
  try {
    identity = fs.lstatSync(guard, { bigint: true });
    publishSourceWriteOwner(guard, owner, identity);
    published = true;
    result = action();
  } catch (error) { failure = error; failed = true; }
  finally {
    if (identity) {
      if (published) {
        try { removeOwnedSourceWriteDirectory(guard, identity, owner); }
        catch (error) {
          failure = sourceWritePublicationError(guard, failure ?? error, error);
          failed = true;
        }
      }
      else {
        let cleanupFailure: unknown;
        try { removeNewEmptySourceWriteDirectory(guard, identity); }
        catch (error) { cleanupFailure = error; }
        // Retain the actual publication error unless cleanup was unverified.
        failure = sourceWritePublicationError(guard, failure, cleanupFailure);
      }
    } else if (failure) {
      failure = sourceWritePublicationError(guard, failure, new Error('The created guard identity could not be read.'));
    }
  }
  if (failed) throw failure;
  return result;
}
