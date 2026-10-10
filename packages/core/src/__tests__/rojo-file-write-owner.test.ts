import * as fs from 'fs';
import nativeFs from 'fs';
import os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
import lockfile from 'proper-lockfile';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { acquireSourceWriteLock, sourceWriteLockPath, SOURCE_WRITE_LOCK_STALE_MS } from '../rojo/file-write-lock.js';
import childProcess from 'child_process';
import { newSourceWriteOwner, observeSourceWriteProcess, readSourceWriteOwner, resetSourceWriteSelfIdentity, sourceWriteOwnerStatus, type SourceWriteOwner } from '../rojo/file-write-owner.js';
import { stubWindowsProcessObserver } from './rojo-process-observer-fixture.js';

let dir: string;
let file: string;
let lockPath: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer owner test '));
  jest.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'private-home'));
  stubWindowsProcessObserver();
  file = path.join(dir, 'Main.luau');
  fs.writeFileSync(file, 'old\n');
  lockPath = sourceWriteLockPath(fs.realpathSync.native(file));
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
function stale(owner?: SourceWriteOwner | string) {
  fs.mkdirSync(lockPath, { recursive: true });
  if (owner !== undefined) fs.writeFileSync(path.join(lockPath, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner));
  const past = new Date(Date.now() - SOURCE_WRITE_LOCK_STALE_MS - 1000);
  fs.utimesSync(lockPath, past, past);
}

describe('Rojo write lease owner', () => {
  test('current owner carries the creation identity supplied by the OS boundary', () => {
    const owner = newSourceWriteOwner();
    expect(owner.pid).toBe(process.pid);
    expect(owner.startedAt.startsWith(process.platform + ':')).toBe(true);
    expect(sourceWriteOwnerStatus(owner)).toBe('alive');
  });
  test('PID reuse is distinguished from the original process', () => {
    const owner = newSourceWriteOwner();
    expect(sourceWriteOwnerStatus(owner, { status: 'running', startedAt: 'different creation identity' })).toBe('gone');
    expect(sourceWriteOwnerStatus(owner, { status: 'missing' })).toBe('gone');
    expect(sourceWriteOwnerStatus(owner, { status: 'unknown' })).toBe('unknown');
    expect(sourceWriteOwnerStatus({ ...owner, host: 'another-host' }, { status: 'missing' })).toBe('unknown');
  });
  test('a stale but live owner remains exclusive and busy fails without waiting', async () => {
    // Another live process: the parent, with the start identity the OS boundary reports for it.
    const parent = observeSourceWriteProcess(process.ppid);
    if (parent.status !== 'running') throw new Error('the parent process must be observable here');
    const owner = { ...newSourceWriteOwner(), pid: process.ppid, startedAt: parent.startedAt };
    stale(owner);
    const started = Date.now();
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'ELOCKED', message: expect.stringContaining(`Lease: ${lockPath}`) });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(readSourceWriteOwner(lockPath)).toEqual(owner);
  });
  test('a lease this process left behind is taken back once stale, but one it still holds is not', async () => {
    const held = await acquireSourceWriteLock(file);
    const past = new Date(Date.now() - SOURCE_WRITE_LOCK_STALE_MS - 1000);
    fs.utimesSync(lockPath, past, past);
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'ELOCKED' });
    await held.release();

    // A request of ours that is over, whose removal failed: same process, token no longer held.
    const orphan = newSourceWriteOwner();
    stale(orphan);
    const lease = await acquireSourceWriteLock(file);
    expect(readSourceWriteOwner(lockPath)?.token).not.toBe(orphan.token);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test('a stale lease folder left with no owner file is reclaimed', async () => {
    stale();
    const lease = await acquireSourceWriteLock(file);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test('a release that meets another writer\'s guard waits it out instead of leaving the lease behind', async () => {
    const lease = await acquireSourceWriteLock(file);
    fs.mkdirSync(`${lockPath}.guard`);
    setTimeout(() => fs.rmdirSync(`${lockPath}.guard`), 120);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test('a release blocked past its retries keeps trying in the background', async () => {
    const lease = await acquireSourceWriteLock(file);
    fs.mkdirSync(`${lockPath}.guard`);
    await expect(lease.release()).rejects.toMatchObject({ code: 'EMETADATARECOVERY' });
    expect(fs.existsSync(lockPath)).toBe(true);
    fs.rmdirSync(`${lockPath}.guard`);
    // The first background attempt runs 2 s after the in-call retries end.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(fs.existsSync(lockPath)).toBe(false);
  }, 10_000);
  test('an owner that could not verify its own start identity is reclaimed only once its process is gone', () => {
    const owner = { ...newSourceWriteOwner(), startedAt: `${process.platform}:unverified` };
    expect(readSourceWriteOwner((() => { stale(owner); return lockPath; })())).toEqual(owner);
    expect(sourceWriteOwnerStatus(owner, { status: 'missing' })).toBe('gone');
    // A running PID cannot be told from a reuse of it: fail closed.
    expect(sourceWriteOwnerStatus(owner, { status: 'running', startedAt: 'anything' })).toBe('unknown');
    expect(sourceWriteOwnerStatus(owner, { status: 'unknown' })).toBe('unknown');
  });
  test('a bridge that cannot observe its own process still gets a lease, marked unverified', async () => {
    if (process.platform !== 'win32') return;
    jest.restoreAllMocks();
    jest.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'private-home'));
    // PowerShell blocked by policy, or in Constrained Language Mode.
    jest.spyOn(childProcess, 'execFileSync').mockImplementation((() => { throw new Error('blocked by group policy'); }) as typeof childProcess.execFileSync);
    resetSourceWriteSelfIdentity();
    try {
      const lease = await acquireSourceWriteLock(file);
      expect(readSourceWriteOwner(lockPath)?.startedAt).toBe('win32:unverified');
      await lease.release();
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      resetSourceWriteSelfIdentity();
    }
  });
  test('a stale PID record with a different native start identity can be reclaimed', async () => {
    const owner = newSourceWriteOwner();
    // Model a previous process creation with the same PID. Keep the record
    // syntactically valid; the actual native lookup must see the mismatch.
    const last = owner.startedAt.at(-1)!;
    owner.startedAt = owner.startedAt.slice(0, -1) + (last === '0' ? '1' : '0');
    stale(owner);
    const lease = await acquireSourceWriteLock(file);
    expect(readSourceWriteOwner(lockPath)?.token).not.toBe(owner.token);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test.each(['broken', 'foreign'])('does not reclaim %s owner metadata', async (kind) => {
    stale(kind === 'broken' ? '{invalid' : { ...newSourceWriteOwner(), host: `${process.platform}:another-host` });
    const before = fs.existsSync(path.join(lockPath, 'owner.json')) ? fs.readFileSync(path.join(lockPath, 'owner.json')) : undefined;
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'ELOCKED' });
    expect(fs.existsSync(lockPath)).toBe(true);
    if (before) expect(fs.readFileSync(path.join(lockPath, 'owner.json'))).toEqual(before);
  });
  test('release cannot remove a changed owner token', async () => {
    const lease = await acquireSourceWriteLock(file);
    const replacement = { ...readSourceWriteOwner(lockPath)!, token: randomUUID() };
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(replacement));
    await expect(lease.release()).rejects.toMatchObject({ code: 'EMETADATARECOVERY' });
    expect(readSourceWriteOwner(lockPath)).toEqual(replacement);
  });
  test('an interrupted publication/removal guard is never guessed stale', async () => {
    fs.mkdirSync(`${lockPath}.guard`, { recursive: true });
    const past = new Date(Date.now() - SOURCE_WRITE_LOCK_STALE_MS - 1000);
    fs.utimesSync(`${lockPath}.guard`, past, past);
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'EGUARDBUSY' });
    expect(fs.existsSync(`${lockPath}.guard`)).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test.each(['guard', 'lease'])('partial %s owner publication failure removes only newly created resources and can retry', async (kind) => {
    const open = nativeFs.openSync;
    const write = nativeFs.writeFileSync;
    const handles = new Map<number, string>();
    jest.spyOn(nativeFs, 'openSync').mockImplementation(((file: fs.PathLike, ...args: unknown[]) => {
      const handle = Reflect.apply(open, nativeFs, [file, ...args]) as number;
      handles.set(handle, String(file));
      return handle;
    }) as typeof nativeFs.openSync);
    let injected = false;
    jest.spyOn(nativeFs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const ownerFile = typeof file === 'number' ? handles.get(file) : undefined;
      if (!injected && ownerFile && ownerFile === path.join(kind === 'guard' ? `${lockPath}.guard` : lockPath, 'owner.json')) {
        injected = true;
        write(file, '{partial');
        throw Object.assign(new Error('injected metadata I/O failure'), { code: 'EIO' });
      }
      return Reflect.apply(write, nativeFs, [file, ...args]);
    }) as typeof nativeFs.writeFileSync);
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'EIO' });
    expect(injected).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.existsSync(`${lockPath}.guard`)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('old\n');
    const retry = await acquireSourceWriteLock(file);
    await retry.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
  test('publication failure preserves a replaced guard and successor sentinel', async () => {
    const write = nativeFs.writeFileSync;
    const close = nativeFs.closeSync;
    let injected = false;
    let injectedHandle: number | undefined;
    jest.spyOn(nativeFs, 'closeSync').mockImplementation((handle) => {
      close(handle);
      if (handle === injectedHandle) {
        injectedHandle = undefined;
        fs.renameSync(`${lockPath}.guard`, `${lockPath}.guard.retired`);
        fs.mkdirSync(`${lockPath}.guard`);
        write(path.join(`${lockPath}.guard`, 'owner.json'), 'successor sentinel');
      }
    });
    jest.spyOn(nativeFs, 'writeFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (!injected && typeof file === 'number') {
        injected = true;
        injectedHandle = file;
        write(file, '{partial');
        throw Object.assign(new Error('injected I/O with directory replacement'), { code: 'EIO' });
      }
      return Reflect.apply(write, nativeFs, [file, ...args]);
    }) as typeof nativeFs.writeFileSync);
    await expect(acquireSourceWriteLock(file)).rejects.toMatchObject({ code: 'EMETADATARECOVERY' });
    expect(fs.readFileSync(path.join(`${lockPath}.guard`, 'owner.json'), 'utf8')).toBe('successor sentinel');
    expect(fs.readFileSync(file, 'utf8')).toBe('old\n');
  });
  test('real library heartbeat compromise can release its unchanged namespace and the live bridge can retry', async () => {
    const lock = lockfile.lock.bind(lockfile);
    let failHeartbeat = false;
    let notifyCompromised!: () => void;
    const compromised = new Promise<void>((resolve) => { notifyCompromised = resolve; });
    jest.spyOn(lockfile, 'lock').mockImplementationOnce(async (target, options) => lock(target, {
      ...options,
      update: 1000, // Unit-only acceleration of the same library transition.
      onCompromised: (error) => { options?.onCompromised?.(error); notifyCompromised(); },
      fs: {
        ...options?.fs,
        stat(target: string, callback: (error: NodeJS.ErrnoException | null, stat?: fs.Stats) => void) {
          if (failHeartbeat && target === lockPath) callback(Object.assign(new Error('injected heartbeat stat error'), { code: 'ENOENT' }));
          else nativeFs.stat(target, callback);
        },
      },
    }));
    const lease = await acquireSourceWriteLock(file);
    failHeartbeat = true;
    const timeout = setTimeout(() => notifyCompromised(), 3000);
    await compromised;
    clearTimeout(timeout);
    await expect(lease.assertHeld()).rejects.toMatchObject({ code: 'ECOMPROMISED' });
    expect(fs.existsSync(lockPath)).toBe(true);
    await lease.release();
    expect(fs.existsSync(lockPath)).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe('old\n');
    const retry = await acquireSourceWriteLock(file);
    await retry.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
