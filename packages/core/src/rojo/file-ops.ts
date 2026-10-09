import { promises as fsp } from 'fs';
import * as path from 'path';
import { RojoError } from './sourcemap.js';

/**
 * File changes a save to a linked Rojo project makes, applied in order and
 * undone in reverse when any of them, or the check after them, fails.
 */
export type FileOp =
  | { kind: 'mkdir'; path: string }
  /** A new file; fails if anything is already there. */
  | { kind: 'write'; path: string; content: string | Buffer }
  /** A file or folder taken out, after a copy is kept in the backup folder. */
  | { kind: 'delete'; path: string }
  /** A file or folder moved, failing if anything is already at `to`. */
  | { kind: 'rename'; from: string; to: string };

type Done =
  | { kind: 'created'; path: string }
  | { kind: 'deleted'; path: string; backup: string }
  | { kind: 'renamed'; from: string; to: string };

/**
 * File changes that could not be kept: a write failed (`rojo_write_failed`),
 * or Rojo did not read the result as planned (the code of that refusal).
 * Every change was undone except `leftovers`, absolute paths a caller must
 * name so nobody is told a clean undo happened that did not.
 */
export class ProjectFilesError extends Error {
  readonly code: string;
  /**
   * Whether any change reached the files before it was undone: a running
   * rojo serve may already have carried it, and its undo, into Studio.
   */
  applied = true;
  constructor(failure: unknown, readonly leftovers: string[], code?: string) {
    super(failure instanceof Error ? failure.message : String(failure));
    this.name = 'ProjectFilesError';
    this.code = code ?? (failure instanceof RojoError ? failure.code : 'rojo_write_failed');
  }
}

async function exists(file: string): Promise<boolean> {
  return fsp.lstat(file).then(() => true, () => false);
}

/**
 * Applies `ops` in order. A deleted file or folder is first copied under
 * `backupRoot` (keeping its path relative to `root`), so it can be put back
 * here, and by hand later. On a failure everything already done is undone and
 * the promise rejects with ProjectFilesError. Resolves with a journal for
 * undoFileOps, used when a later check refuses what was written.
 */
export async function applyFileOps(ops: FileOp[], root: string, backupRoot: string): Promise<Done[]> {
  const done: Done[] = [];
  try {
    for (const op of ops) {
      if (op.kind === 'mkdir') {
        await fsp.mkdir(op.path);
        done.push({ kind: 'created', path: op.path });
      } else if (op.kind === 'write') {
        await fsp.writeFile(op.path, op.content, { flag: 'wx' });
        done.push({ kind: 'created', path: op.path });
      } else if (op.kind === 'delete') {
        const backup = path.join(backupRoot, path.relative(root, op.path));
        await fsp.mkdir(path.dirname(backup), { recursive: true });
        if (await exists(backup)) throw new Error(`${backup} already exists`);
        try {
          // One move out of the project: rojo serve 7.7 on Windows crashes when a
          // recursive delete takes a folder's children before the folder itself.
          await fsp.rename(op.path, backup);
        } catch (error) {
          // A backup on another drive cannot be renamed into; copy and delete instead.
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
          await fsp.cp(op.path, backup, { recursive: true, errorOnExist: true, force: false });
          await fsp.rm(op.path, { recursive: true });
        }
        done.push({ kind: 'deleted', path: op.path, backup });
      } else {
        if (await exists(op.to) && op.from.toLowerCase() !== op.to.toLowerCase()) {
          throw new Error(`${path.basename(op.to)} already exists`);
        }
        await fsp.rename(op.from, op.to);
        done.push({ kind: 'renamed', from: op.from, to: op.to });
      }
    }
    return done;
  } catch (error) {
    // A delete that failed partway may have taken some of a folder: put it back from its copy too.
    const last = ops[done.length];
    const partial = last?.kind === 'delete' ? [{ kind: 'deleted' as const, path: last.path, backup: path.join(backupRoot, path.relative(root, last.path)) }] : [];
    const failure = new ProjectFilesError(error, await undoFileOps([...done, ...partial]));
    failure.applied = done.length > 0;
    throw failure;
  }
}

/**
 * Undoes a journal, newest first: removes what was created (a folder only
 * while it is empty, so nothing anyone else put there goes with it), copies
 * a deleted entry back from its backup without overwriting anything, and
 * moves a renamed entry back. Resolves with every path it could not restore.
 */
export async function undoFileOps(done: Done[]): Promise<string[]> {
  const leftovers: string[] = [];
  for (const step of [...done].reverse()) {
    if (step.kind === 'created') {
      const removed = await fsp.lstat(step.path).then(
        (stat) => (stat.isDirectory() ? fsp.rmdir(step.path) : fsp.rm(step.path)).then(() => true, () => false),
        (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
      );
      if (!removed) leftovers.push(step.path);
    } else if (step.kind === 'deleted') {
      if (!(await exists(step.backup))) continue;
      const restored = await fsp.cp(step.backup, step.path, { recursive: true, force: false, errorOnExist: false }).then(() => true, () => false);
      if (!restored) leftovers.push(step.path);
    } else {
      const back = await exists(step.from) && step.from.toLowerCase() !== step.to.toLowerCase()
        ? false
        : await fsp.rename(step.to, step.from).then(() => true, () => false);
      if (!back) leftovers.push(step.to);
    }
  }
  return leftovers;
}

/** The total size of a file, or of everything in a folder. */
export async function sizeOf(file: string): Promise<number> {
  const stat = await fsp.lstat(file);
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const entry of await fsp.readdir(file)) total += await sizeOf(path.join(file, entry));
  return total;
}

/** Every file under `dir`, recursively (absolute). */
export async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await filesUnder(full));
    else found.push(full);
  }
  return found;
}
