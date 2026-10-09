import * as fs from 'fs';
import nativeFs from 'fs';
import os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import lockfile from 'proper-lockfile';
import { compareAndWrite } from '../rojo/file-write.js';
import { sourceWriteLockPath } from '../rojo/file-write-lock.js';
import { captureSourceFileIdentity } from '../rojo/source-file-identity.js';
import { differingLines } from '../rojo/conflict.js';
import { sourceRevision } from '../rojo/source-revision.js';
import { stubWindowsProcessObserver } from './rojo-process-observer-fixture.js';
import { waitForStudio } from '../rojo/sync-wait.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer write '));
  jest.spyOn(os, 'homedir').mockReturnValue(path.join(dir, 'private-home'));
  stubWindowsProcessObserver();
});
afterEach(() => { jest.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });
const leftovers = () => fs.readdirSync(dir).filter((name) => name.includes('.roqer-'));

describe('compareAndWrite', () => {
  test('refuses an atomic replacement with identical normalized text', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const approved = captureSourceFileIdentity(fs.realpathSync.native(file));
    const replacement = path.join(dir, 'replacement.luau');
    fs.writeFileSync(replacement, 'old\r\n');
    fs.renameSync(replacement, file);
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n', approved)).rejects.toThrow('path changed');
    expect(fs.readFileSync(file, 'utf8')).toBe('old\r\n');
    expect(leftovers()).toEqual([]);
  });
  test('refuses a junction replacing the approved directory before locking', async () => {
    const source = path.join(dir, 'source');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    const file = path.join(source, 'Main.luau');
    fs.writeFileSync(file, 'old\n');
    fs.writeFileSync(path.join(outside, 'Main.luau'), 'old\n');
    const approved = captureSourceFileIdentity(fs.realpathSync.native(file));
    fs.renameSync(source, `${source}.retired`);
    fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n', approved)).rejects.toThrow('path changed');
    expect(fs.readFileSync(path.join(outside, 'Main.luau'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(path.join(`${source}.retired`, 'Main.luau'), 'utf8')).toBe('old\n');
  });
  test('rechecks approved directories after waiting for the lease', async () => {
    const source = path.join(dir, 'source');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    const file = path.join(source, 'Main.luau');
    fs.writeFileSync(file, 'old\n');
    fs.writeFileSync(path.join(outside, 'Main.luau'), 'old\n');
    const approved = captureSourceFileIdentity(fs.realpathSync.native(file));
    const lock = lockfile.lock.bind(lockfile);
    jest.spyOn(lockfile, 'lock').mockImplementation(async (target, options) => {
      const release = await lock(target, options);
      fs.renameSync(source, `${source}.retired`);
      fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
      return release;
    });
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n', approved)).rejects.toThrow('path changed');
    expect(fs.readFileSync(path.join(outside, 'Main.luau'), 'utf8')).toBe('old\n');
  });
  test('does not commit or clean a temp-name sentinel through a replacement junction', async () => {
    const source = path.join(dir, 'source');
    const outside = path.join(dir, 'outside');
    fs.mkdirSync(source);
    fs.mkdirSync(outside);
    const file = path.join(source, 'Main.luau');
    fs.writeFileSync(file, 'old\n');
    fs.writeFileSync(path.join(outside, 'Main.luau'), 'old\n');
    const read = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    let sentinel = '';
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof read>) => {
      const bytes = await read(...args);
      if (args[0] === file && ++reads === 2) {
        const temporary = fs.readdirSync(source).find((name) => name.includes('.roqer-'))!;
        fs.renameSync(source, `${source}.retired`);
        fs.symlinkSync(outside, source, process.platform === 'win32' ? 'junction' : 'dir');
        sentinel = path.join(outside, temporary);
        fs.writeFileSync(sentinel, 'do not remove');
      }
      return bytes;
    });
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).rejects.toThrow('path changed');
    expect(fs.readFileSync(path.join(outside, 'Main.luau'), 'utf8')).toBe('old\n');
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('do not remove');
    expect(fs.readFileSync(path.join(`${source}.retired`, 'Main.luau'), 'utf8')).toBe('old\n');
  });
  test('serializes concurrent writes in the same process', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const outcomes = await Promise.allSettled(['A\n', 'B\n'].map((text) => compareAndWrite(file, sourceRevision('old\n'), text)));
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled' && outcome.value.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected' && outcome.reason.code === 'ELOCKED')).toHaveLength(1);
    const winner = fs.readFileSync(file, 'utf8');
    expect(['A\n', 'B\n']).toContain(winner);
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'retry\n')).resolves.toMatchObject({ actual: winner, actualRevision: sourceRevision(winner) });
    expect(leftovers()).toEqual([]);
  });
  test('refuses an external edit made during the temporary write', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const read = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof read>) => {
      if (args[0] === file && ++reads === 2) fs.writeFileSync(file, 'external\n');
      return read(...args);
    });
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).resolves.toMatchObject({ ok: false, actual: 'external\n' });
    expect(fs.readFileSync(file, 'utf8')).toBe('external\n');
    expect(leftovers()).toEqual([]);
  });
  test('lost lease refuses the commit and preserves the target', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const lock = lockfile.lock.bind(lockfile);
    let compromised: ((error: Error) => unknown) | undefined;
    jest.spyOn(lockfile, 'lock').mockImplementation(async (target, options) => {
      compromised = options?.onCompromised;
      return lock(target, options);
    });
    const read = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof read>) => {
      const bytes = await read(...args);
      if (args[0] === file && ++reads === 2) compromised?.(new Error('test lease lost'));
      return bytes;
    });
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).rejects.toThrow('test lease lost');
    expect(fs.readFileSync(file, 'utf8')).toBe('old\n');
    expect(leftovers()).toEqual([]);
  });
  test('reports a saved edit even if releasing the lock then fails', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const lockPath = sourceWriteLockPath(fs.realpathSync.native(file));
    const rmdir = nativeFs.rmdirSync;
    const attempted: string[] = [];
    jest.spyOn(nativeFs, 'rmdirSync').mockImplementation(((directory: fs.PathLike, ...args: unknown[]) => {
      attempted.push(String(directory));
      if (String(directory) === lockPath) throw Object.assign(new Error('test release failure'), { code: 'EIO' });
      return Reflect.apply(rmdir, nativeFs, [directory, ...args]);
    }) as typeof nativeFs.rmdirSync);
    const outcome = await compareAndWrite(file, sourceRevision('old\n'), 'new\n');
    expect(attempted).toContain(lockPath);
    expect(outcome).toMatchObject({ ok: true, lockReleaseWarning: expect.stringContaining('test release failure') });
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(leftovers()).toEqual([]);
  });
  test('does not commit or delete a replacement lease directory', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    const lockPath = sourceWriteLockPath(fs.realpathSync.native(file));
    const read = fs.promises.readFile.bind(fs.promises);
    let reads = 0;
    jest.spyOn(fs.promises, 'readFile').mockImplementation(async (...args: Parameters<typeof read>) => {
      const bytes = await read(...args);
      if (args[0] === file && ++reads === 2) {
        fs.renameSync(lockPath, `${lockPath}.retired`);
        fs.mkdirSync(lockPath);
      }
      return bytes;
    });
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).rejects.toThrow('lock was lost');
    expect(fs.statSync(lockPath).isDirectory()).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('old\n');
    expect(leftovers()).toEqual([]);
  });
  test('writes when the file is what Studio has', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'old\n');
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(file, 'utf8')).toBe('new\n');
    expect(leftovers()).toEqual([]);
  });
  test('refuses a file that changed, and leaves it alone', async () => {
    const file = path.join(dir, 'Main.server.luau');
    fs.writeFileSync(file, 'user edit\n');
    await expect(compareAndWrite(file, sourceRevision('old\n'), 'new\n')).resolves.toMatchObject({ ok: false, actualRevision: sourceRevision('user edit\n'), actual: 'user edit\n' });
    expect(fs.readFileSync(file, 'utf8')).toBe('user edit\n');
    expect(leftovers()).toEqual([]);
  });
  test('a CRLF file is compared and written as Studio sees it, but stays CRLF on disk', async () => {
    const file = path.join(dir, 'Crlf.luau');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    // expectedRevision and content are LF, as the plugin computes and plans them.
    await expect(compareAndWrite(file, sourceRevision('a\nb\n'), 'a\nB\n')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(file)).toEqual(Buffer.from('a\r\nB\r\n'));
  });
  test('a BOM is kept on rewrite', async () => {
    const file = path.join(dir, 'Bom.luau');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    fs.writeFileSync(file, Buffer.concat([bom, Buffer.from('a\n')]));
    await expect(compareAndWrite(file, sourceRevision('a\n'), 'b\n')).resolves.toEqual({ ok: true });
    expect(fs.readFileSync(file)).toEqual(Buffer.concat([bom, Buffer.from('b\n')]));
  });
  test('a CRLF file that genuinely differs from Studio is refused, reported as Studio would see it', async () => {
    const file = path.join(dir, 'Crlf.luau');
    fs.writeFileSync(file, 'a\r\nuser edit\r\n');
    await expect(compareAndWrite(file, sourceRevision('a\nb\n'), 'a\nB\n')).resolves.toMatchObject({
      ok: false,
      actualRevision: sourceRevision('a\nuser edit\n'),
      actual: 'a\nuser edit\n',
    });
    expect(fs.readFileSync(file)).toEqual(Buffer.from('a\r\nuser edit\r\n'));
  });
  (process.platform === 'win32' ? test.skip : test)('keeps the file mode', async () => {
    const file = path.join(dir, 'Mode.luau');
    fs.writeFileSync(file, 'x');
    fs.chmodSync(file, 0o640);
    await compareAndWrite(file, sourceRevision('x'), 'y');
    expect(fs.statSync(file).mode & 0o777).toBe(0o640);
  });
  test('rejects when the target is missing, and leaves no temporary file', async () => {
    const file = path.join(dir, 'Missing.luau');
    await expect(compareAndWrite(file, sourceRevision('x'), 'y')).rejects.toThrow();
    expect(leftovers()).toEqual([]);
  });
});

describe('waitForStudio', () => {
  const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
  test('synced when Studio reaches the new revision', async () => {
    const reads = ['old', 'old', 'new'];
    await expect(waitForStudio(async () => reads.shift(), 'old', 'new', clock())).resolves.toBe('synced');
  });
  test('pending after the timeout', async () => {
    await expect(waitForStudio(async () => 'old', 'old', 'new', clock())).resolves.toBe('pending');
  });
  test('diverged when Studio moves somewhere else', async () => {
    const reads = ['old', 'someone typed'];
    await expect(waitForStudio(async () => reads.shift(), 'old', 'new', clock())).resolves.toBe('diverged');
  });
  test('a failed read counts as not yet synced', async () => {
    const reads: (string | undefined)[] = [undefined, 'new'];
    await expect(waitForStudio(async () => reads.shift(), 'old', 'new', clock())).resolves.toBe('synced');
  });
  test('readRevision that rejects once then resolves new becomes synced', async () => {
    let callCount = 0;
    const readRevision = async () => {
      callCount++;
      if (callCount === 1) throw new Error('read failed');
      return 'new';
    };
    await expect(waitForStudio(readRevision, 'old', 'new', clock())).resolves.toBe('synced');
  });
});

describe('differingLines', () => {
  test('shows only the lines that differ, from the first one', () => {
    expect(differingLines('a\nb\nc\nd', 'a\nB\nC\nd')).toEqual({ firstLine: 2, file: ['b', 'c'], studio: ['B', 'C'], truncated: false });
  });
  test('caps each side', () => {
    const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
    const result = differingLines(big, '', 40);
    expect(result.file).toHaveLength(40);
    expect(result.truncated).toBe(true);
  });
  test('caps each line\'s length, with a mark that it was cut', () => {
    const longLine = 'x'.repeat(250);
    const result = differingLines(longLine, '');
    expect(result.file[0]).toBe(`${'x'.repeat(200)}…`);
    expect(result.file[0].length).toBe(201);
  });
  test('a short line is left exactly as it was', () => {
    expect(differingLines('short', '').file[0]).toBe('short');
  });
  test('a real difference at line 4 of a 6-line file is reported as line 4', () => {
    const file = 'a\nb\nc\nfile-four\ne\nf\n';
    const studio = 'a\nb\nc\nstudio-four\ne\nf\n';
    expect(differingLines(file, studio).firstLine).toBe(4);
  });
  test('texts that are identical line-by-line do not report a line past the end', () => {
    // Observed on Windows before line-ending normalization: a CRLF file whose
    // content matched Studio line-for-line still reported firstLine one past
    // the last line, with empty file/studio arrays.
    const result = differingLines('a\nb\nc\n', 'a\nb\nc\n');
    expect(result.firstLine).toBeLessThanOrEqual(3);
  });
});
