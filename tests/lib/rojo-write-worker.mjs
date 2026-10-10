import nativeFs, { promises as fs } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import lockfile from 'proper-lockfile';
import { compareAndWrite } from '../../packages/core/dist/rojo/file-write.js';

const [file, revision, content, pause] = process.argv.slice(2);
const read = fs.readFile.bind(fs);
const realFile = await fs.realpath(file);
if (pause === 'pause-guard' || pause === 'pause-recovery-guard') {
  const mkdirSync = nativeFs.mkdirSync.bind(nativeFs);
  let guards = 0;
  nativeFs.mkdirSync = (directory, options) => {
    const result = mkdirSync(directory, options);
    if (String(directory).endsWith('.guard') && ++guards === (pause === 'pause-guard' ? 1 : 2)) {
      const identity = nativeFs.lstatSync(directory, { bigint: true });
      process.send({ kind: 'guardCreated', pid: process.pid, guard: directory, dev: String(identity.dev), ino: String(identity.ino), birthtimeNs: String(identity.birthtimeNs) });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45_000);
    }
    return result;
  };
  syncBuiltinESMExports();
}
if (pause === 'freeze') {
  const renameSync = nativeFs.renameSync.bind(nativeFs);
  nativeFs.renameSync = (from, to) => {
    process.send({ kind: 'frozenCommit', pid: process.pid });
    // Fault injection: the holder is alive but cannot heartbeat or run JS.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 45_000);
    return renameSync(from, to);
  };
  syncBuiltinESMExports();
}
const lock = lockfile.lock.bind(lockfile);
let continueRename;
const released = new Promise((resolve) => { continueRename = resolve; });
process.on('message', (message) => { if (message?.kind === 'release') continueRename(); });
lockfile.lock = async (target, options) => {
  const fileSystem = options.fs ?? nativeFs;
  return lock(target, {
    ...options,
    onCompromised(error) {
      process.send({ kind: 'compromised', pid: process.pid });
      options.onCompromised?.(error);
    },
    fs: {
      ...fileSystem,
      mkdir(directory, callback) {
        fileSystem.mkdir(directory, (error) => {
          if (error?.code === 'EEXIST') process.send({ kind: 'blocked', pid: process.pid, lockPath: options.lockfilePath });
          callback(error);
        });
      },
    },
  });
};
let reads = 0;
fs.readFile = async (...args) => {
  const bytes = await read(...args);
  if (args[0] === realFile && ++reads === 2 && pause === 'pause') {
    // Pause after the last source read, before synchronous commit validation.
    process.send({ kind: 'beforeCommit', pid: process.pid, file: realFile });
    await released;
  }
  return bytes;
};
try {
  const outcome = await compareAndWrite(file, revision, content);
  process.send({ kind: 'done', pid: process.pid, outcome });
} catch (error) {
  process.send({ kind: 'error', pid: process.pid, errorCode: error?.code, error: String(error?.stack ?? error) });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
