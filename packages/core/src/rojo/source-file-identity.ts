import * as fs from 'fs';
import * as path from 'path';

interface PathIdentity {
  path: string;
  dev: bigint;
  ino: bigint;
  birthtimeNs: bigint;
}

export interface SourceFileIdentity {
  file: PathIdentity;
  directories: PathIdentity[];
}

const changed = () => new Error('The Rojo source file path changed; read the script before retrying.');
const fingerprint = (file: string, stat: fs.BigIntStats): PathIdentity => ({ path: file, dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs });
const matches = (expected: PathIdentity, actual: fs.BigIntStats) =>
  expected.dev === actual.dev && expected.ino === actual.ino && expected.birthtimeNs === actual.birthtimeNs;

/** Capture this while ownership is checked, before any asynchronous planning or lock wait. */
export function captureSourceFileIdentity(realFile: string): SourceFileIdentity {
  const file = fs.lstatSync(realFile, { bigint: true });
  if (!file.isFile() || file.isSymbolicLink()) throw changed();
  const directories: PathIdentity[] = [];
  let directory = path.dirname(realFile);
  for (;;) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw changed();
    directories.push(fingerprint(directory, stat));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return { file: fingerprint(realFile, file), directories };
}

export async function assertSourceDirectories(identity: SourceFileIdentity): Promise<void> {
  for (const directory of identity.directories) {
    const current = await fs.promises.lstat(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !matches(directory, current)) throw changed();
  }
}

export async function assertSourceFileIdentity(identity: SourceFileIdentity, requestedFile: string, requireFileIdentity: boolean): Promise<void> {
  await assertSourceDirectories(identity);
  const current = await fs.promises.lstat(identity.file.path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || (requireFileIdentity && !matches(identity.file, current)) ||
      await fs.promises.realpath(requestedFile) !== identity.file.path) throw changed();
}

/** No event-loop yield between the last identity checks and the OS rename. */
export function assertSourceFileIdentitySync(identity: SourceFileIdentity, requestedFile: string): void {
  for (const directory of identity.directories) {
    const current = fs.lstatSync(directory.path, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink() || !matches(directory, current)) throw changed();
  }
  const current = fs.lstatSync(identity.file.path, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || !matches(identity.file, current) ||
      fs.realpathSync.native(requestedFile) !== identity.file.path) throw changed();
}
