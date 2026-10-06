import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { compareAndWrite } from '../rojo/file-write.js';
import { differingLines } from '../rojo/conflict.js';
import { sourceRevision } from '../rojo/source-revision.js';
import { waitForStudio } from '../rojo/sync-wait.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roqer write ')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });
const leftovers = () => fs.readdirSync(dir).filter((name) => name.includes('.roqer-'));

describe('compareAndWrite', () => {
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
  test('keeps CRLF bytes exactly', async () => {
    const file = path.join(dir, 'Crlf.luau');
    fs.writeFileSync(file, 'a\r\nb\r\n');
    await compareAndWrite(file, sourceRevision('a\r\nb\r\n'), 'a\r\nB\r\n');
    expect(fs.readFileSync(file)).toEqual(Buffer.from('a\r\nB\r\n'));
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
});
