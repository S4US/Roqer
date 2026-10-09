// Real subprocess/filesystem coverage. IPC orders source reads; it does not
// replace compareAndWrite, the lock library, reads, writes, fsync, or rename.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_WRITE_LOCK_STALE_MS, sourceWriteLockPath } from '../packages/core/dist/rojo/file-write-lock.js';
import { sourceRevision } from '../packages/core/dist/rojo/source-revision.js';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'roqer write processes '));
const project = path.join(root, 'project');
const home = path.join(root, 'private-home');
const before = 'print("base")\n';
const revision = sourceRevision(before);
const children = new Set();
const reports = [];
await fs.mkdir(project);

function worker(file, content, pause = false) {
  const child = fork(fileURLToPath(new URL('./lib/rojo-write-worker.mjs', import.meta.url)), [file, revision, content, typeof pause === 'string' ? pause : pause ? 'pause' : 'continue'], {
    windowsHide: true,
    env: { ...process.env, HOME: home, USERPROFILE: home },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    execArgv: [],
  });
  children.add(child);
  let stderr = '';
  const messages = [];
  const waiters = new Set();
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const completion = new Promise((resolve) => child.once('close', (code, signal) => {
    children.delete(child);
    resolve({ code, signal });
    for (const check of waiters) check();
  }));
  child.on('message', (message) => {
    messages.push(message);
    for (const check of waiters) check();
  });
  function wait(kind) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Worker ${child.pid} timed out waiting for ${kind}: ${stderr}`)), 10_000);
      function finish(error, message) {
        clearTimeout(timer);
        waiters.delete(check);
        if (error) reject(error); else resolve(message);
      }
      function check() {
        const error = messages.find((message) => message.kind === 'error');
        const found = messages.find((message) => message.kind === kind);
        if (found) finish(undefined, found);
        else if (error) finish(new Error(error.error));
        else if (child.exitCode !== null || child.signalCode !== null) finish(new Error(`Worker exited before ${kind}: ${stderr}`));
      }
      waiters.add(check);
      check();
    });
  }
  return { child, wait, completion, messages };
}

async function repairOwnedGuard(event) {
  assert.equal(children.size, 0, 'every test writer must have exited before manual recovery');
  const relative = path.relative(home, event.guard);
  assert.ok(relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
  const current = await fs.lstat(event.guard, { bigint: true });
  assert.equal(current.isSymbolicLink(), false);
  assert.equal(String(current.dev), event.dev);
  assert.equal(String(current.ino), event.ino);
  assert.equal(String(current.birthtimeNs), event.birthtimeNs);
  await fs.rm(event.guard, { recursive: true });
}

async function compete(label, file, alias) {
  await fs.writeFile(file, before);
  const a = worker(file, 'print("A")\n', true);
  await a.wait('beforeCommit');
  const b = worker(alias, 'print("B")\n');
  await b.wait('blocked'); // Actual mkdir returned EEXIST while A owns the lock.
  assert.equal((await b.wait('error')).errorCode, 'ELOCKED');
  assert.deepEqual(await b.completion, { code: 1, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  a.child.send({ kind: 'release' });
  const first = await a.wait('done');
  const retry = worker(alias, 'print("B")\n');
  const second = await retry.wait('done');
  assert.deepEqual(first.outcome, { ok: true });
  assert.deepEqual(second.outcome, { ok: false, actualRevision: sourceRevision('print("A")\n'), actual: 'print("A")\n' });
  assert.equal(await fs.readFile(file, 'utf8'), 'print("A")\n');
  assert.deepEqual(await Promise.all([a.completion, retry.completion]), [{ code: 0, signal: null }, { code: 0, signal: null }]);
  reports.push({ label, pids: [a.child.pid, b.child.pid, retry.child.pid], busyRefused: true, outcomes: [first.outcome, second.outcome] });
}

try {
  const file = path.join(project, '主脚本 & spaces.server.luau');
  await compete('same file', file, file);
  const aliasDirectory = path.join(root, 'project-alias');
  await fs.symlink(project, aliasDirectory, process.platform === 'win32' ? 'junction' : 'dir');
  await compete('realpath alias', file, path.join(aliasDirectory, path.basename(file)));
  if (process.platform === 'win32') await compete('case alias', file, file.toUpperCase());

  await fs.writeFile(file, before);
  const other = path.join(project, 'Other.luau');
  await fs.writeFile(other, before);
  const a = worker(file, 'print("A")\n', true);
  await a.wait('beforeCommit');
  const b = worker(other, 'print("B")\n');
  assert.deepEqual((await b.wait('done')).outcome, { ok: true });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.equal(await fs.readFile(other, 'utf8'), 'print("B")\n');
  a.child.send({ kind: 'release' });
  await a.wait('done');
  assert.deepEqual(await Promise.all([a.completion, b.completion]), [{ code: 0, signal: null }, { code: 0, signal: null }]);
  reports.push({ label: 'different files do not block each other', pids: [a.child.pid, b.child.pid] });

  await fs.writeFile(file, before);
  const frozen = worker(file, 'print("frozen")\n', 'freeze');
  await frozen.wait('frozenCommit');
  // No timestamp or lock-directory changes. Cross the real production stale
  // threshold while the first OS process is alive and paused after all checks.
  await new Promise((resolve) => setTimeout(resolve, SOURCE_WRITE_LOCK_STALE_MS + 1000));
  const contender = worker(file, 'print("contender")\n');
  assert.equal((await contender.wait('error')).errorCode, 'ELOCKED');
  assert.deepEqual(await contender.completion, { code: 1, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  // The freeze still has about 14s to run; the ordinary message timeout is 10s.
  const frozenDone = await Promise.race([
    new Promise((resolve) => frozen.child.once('message', (message) => resolve(message))),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Frozen owner did not resume')), 20_000)),
  ]);
  assert.equal(frozenDone.kind, 'done');
  assert.deepEqual(frozenDone.outcome, { ok: true });
  assert.deepEqual(await frozen.completion, { code: 0, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), 'print("frozen")\n');
  reports.push({ label: 'live owner paused beyond stale stays exclusive', pids: [frozen.child.pid, contender.child.pid], busyRefused: true });

  await fs.writeFile(file, before);
  const interruptedPublication = worker(file, 'print("interrupted")\n', 'pause-guard');
  const publicationGuard = await interruptedPublication.wait('guardCreated');
  interruptedPublication.child.kill('SIGKILL');
  await interruptedPublication.completion;
  const guardContender = worker(file, 'print("guard contender")\n');
  assert.equal((await guardContender.wait('error')).errorCode, 'EGUARDBUSY');
  assert.deepEqual(await guardContender.completion, { code: 1, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  await repairOwnedGuard(publicationGuard);
  reports.push({ label: 'hard kill after guard mkdir fails closed; manual recovery only after confirmed exit', pids: [interruptedPublication.child.pid, guardContender.child.pid], guardBusyRefused: true, manualRecovery: true });

  await fs.writeFile(file, before);
  const crashed = worker(file, 'print("crashed")\n', true);
  await crashed.wait('beforeCommit');
  // Kill only this retained child, after it has acquired its test-file lease.
  crashed.child.kill('SIGKILL');
  await crashed.completion;
  const canonical = await fs.realpath(file);
  const relativeLock = path.relative(os.homedir(), sourceWriteLockPath(canonical));
  const lockPath = path.join(home, relativeLock);
  const staleLock = await fs.stat(lockPath).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (staleLock) {
    // Wait for the production stale threshold; do not alter its timestamps.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, staleLock.mtimeMs + SOURCE_WRITE_LOCK_STALE_MS + 100 - Date.now())));
  }
  assert.equal(await fs.readFile(file, 'utf8'), before);
  const oldOwnerBytes = await fs.readFile(path.join(lockPath, 'owner.json'));
  const interruptedRecovery = worker(file, 'print("interrupted recovery")\n', 'pause-recovery-guard');
  const recoveryGuard = await interruptedRecovery.wait('guardCreated');
  interruptedRecovery.child.kill('SIGKILL');
  await interruptedRecovery.completion;
  const recoveryContender = worker(file, 'print("recovery contender")\n');
  assert.equal((await recoveryContender.wait('error')).errorCode, 'EGUARDBUSY');
  assert.deepEqual(await recoveryContender.completion, { code: 1, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), before);
  assert.deepEqual(await fs.readFile(path.join(lockPath, 'owner.json')), oldOwnerBytes);
  await repairOwnedGuard(recoveryGuard);
  reports.push({ label: 'hard kill during stale recovery preserves source/owner and leaves a manual guard', pids: [interruptedRecovery.child.pid, recoveryContender.child.pid], guardBusyRefused: true, manualRecovery: true });
  const successor = worker(file, 'print("recovered")\n');
  assert.deepEqual((await successor.wait('done')).outcome, { ok: true });
  assert.deepEqual(await successor.completion, { code: 0, signal: null });
  assert.equal(await fs.readFile(file, 'utf8'), 'print("recovered")\n');
  await assert.rejects(fs.stat(lockPath), { code: 'ENOENT' });
  reports.push({ label: 'forced process exit and stale-lock recovery', pids: [crashed.child.pid, successor.child.pid], waitedForStale: staleLock !== undefined });
  console.log(JSON.stringify({ node: process.version, platform: process.platform, passed: reports.length, reports }, null, 2));
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map((child) => new Promise((resolve) => child.once('close', resolve))));
  // All paths and junctions are contained in this script's mkdtemp fixture.
  await fs.rm(root, { recursive: true, force: true });
}
