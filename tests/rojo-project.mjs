/** Real Rojo CLI + real files; the Studio peer is simulated. Never launches Studio or connects to rojo serve. */
import assert from 'node:assert/strict';
import { execFileSync, fork } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RojoScriptProject } from '../packages/core/dist/rojo-project.js';

const executable = process.env.ROBLOX_STUDIO_ROJO_EXECUTABLE || 'rojo';
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const root = await mkdtemp(path.join(tmpdir(), 'roqer-rojo-cli-'));
const workers = [];

function workerEvent(child, type) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error(`Rojo worker did not report ${type}`)); }, 12000);
    const message = (value) => { if (value.type === type) { cleanup(); resolve(value); } };
    const exited = () => { cleanup(); reject(new Error(`Rojo worker exited before ${type}`)); };
    const cleanup = () => { clearTimeout(timer); child.off('message', message); child.off('exit', exited); };
    child.on('message', message);
    child.once('exit', exited);
    child.once('error', reject);
  });
}
try {
  const files = {
    'src/server/Main.server.luau': 'return 1\n',
    'src/server/Ignored.server.luau': 'return "ignored"\n',
    'src/shared/init.luau': 'return {}\n',
    'src/shared/Types.luau': 'export type Value = number\nreturn {}\n',
    'src/shared/Library/Body.luau': 'return "library"\n',
    'src/shared/Data.json': '{"answer":42}',
  };
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  await writeFile(path.join(root, 'src/shared/Library/default.project.json'), JSON.stringify({ name: 'Library', tree: { $path: 'Body.luau' } }));
  const projectFile = path.join(root, 'default.project.json');
  await writeFile(projectFile, JSON.stringify({
    name: 'RoqerRojoFixture', globIgnorePaths: ['**/Ignored.server.luau'], tree: {
      $className: 'DataModel',
      ServerScriptService: { $className: 'ServerScriptService', $path: 'src/server' },
      ReplicatedStorage: { $className: 'ReplicatedStorage', Shared: { $path: 'src/shared' } },
    },
  }));
  const expected = [
    ['game.ServerScriptService.Main', 'Script', 'src/server/Main.server.luau'],
    ['game.ReplicatedStorage.Shared', 'ModuleScript', 'src/shared/init.luau'],
    ['game.ReplicatedStorage.Shared.Types', 'ModuleScript', 'src/shared/Types.luau'],
    ['game.ReplicatedStorage.Shared.Library', 'ModuleScript', 'src/shared/Library/Body.luau'],
  ];
  const project = new RojoScriptProject({ projectFile, instanceId: 'fixture', executable, backupDirectory: path.join(root, 'host-backups') });
  const mutateEndpoints = [];
  for (const [instancePath, className, name] of expected) {
    let studioSource = files[name];
    const peer = async (endpoint) => {
      if (endpoint === '/api/get-script-source') return { instancePath, instanceRef: instancePath, className, revision: 'studio', source: studioSource };
      if (endpoint === '/api/check-script-source') return { instancePath, instanceRef: instancePath };
      mutateEndpoints.push(endpoint);
      throw new Error(`Unexpected Studio mutation: ${endpoint}`);
    };
    const read = await project.handle('/api/get-script-source', { instancePath }, 'edit', peer);
    assert.equal(read.filePath, path.join(root, name), JSON.stringify(read));
    assert.equal(read.syncStatus, 'synced');
    const updated = files[name] + '-- edited on disk\n';
    const write = await project.handle('/api/set-script-source', { instancePath, source: updated, expectedRevision: read.revision }, 'edit', peer);
    assert.equal(write.success, true, JSON.stringify(write));
    assert.equal(write.fileVerified, true);
    assert.equal(await readFile(write.backupPath, 'utf8'), files[name]);
    assert.equal(await readFile(path.join(root, name), 'utf8'), updated);
    studioSource = updated;
    const readback = await project.handle('/api/get-script-source', { instancePath }, 'edit', peer);
    assert.equal(readback.revision, write.revision);
    assert.equal(readback.syncStatus, 'synced');
    const stale = await project.handle('/api/set-script-source', { instancePath, source: 'return "stale"', expectedRevision: read.revision }, 'edit', peer);
    assert.equal(stale.errorCode, 'source_revision_conflict');
  }
  const generated = await project.handle('/api/get-script-source', { instancePath: 'game.ReplicatedStorage.Shared.Data' }, 'edit', async () => ({
    instancePath: 'game.ReplicatedStorage.Shared.Data', instanceRef: 'data', className: 'ModuleScript', revision: 'studio', source: 'return {answer = 42}',
  }));
  assert.equal(generated.errorCode, 'rojo_mapping_unavailable');
  let ignoredFallback = false;
  await project.handle('/api/get-script-source', { instancePath: 'game.ServerScriptService.Ignored' }, 'edit', async (_endpoint, data) => {
    if (data.startLine === undefined) ignoredFallback = true;
    return { instancePath: 'game.ServerScriptService.Ignored', instanceRef: 'ignored', className: 'Script', revision: 'studio', source: files['src/server/Ignored.server.luau'] };
  });
  assert.equal(ignoredFallback, true, 'Rojo globIgnorePaths must remain authoritative');
  assert.deepEqual(mutateEndpoints, []);
  // Two real OS processes must contend on the same filesystem lease, not just one in-memory queue.
  const mainFile = path.join(root, 'src/server/Main.server.luau');
  const before = await readFile(mainFile, 'utf8');
  const current = await project.handle('/api/get-script-source', { instancePath: 'game.ServerScriptService.Main' }, 'edit', async () => ({
    instancePath: 'game.ServerScriptService.Main', instanceRef: 'main', className: 'Script', revision: 'studio', source: before,
  }));
  const spawnWorker = (hold, source) => {
    const child = fork(new URL('./lib/rojo-write-worker.mjs', import.meta.url), [projectFile, path.join(root, 'host-backups'), current.revision, hold, source], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    workers.push(child);
    return child;
  };
  const first = spawnWorker('hold', 'return "first writer"\n');
  const firstResult = workerEvent(first, 'result');
  void firstResult.catch(() => undefined); // A failed setup may end this worker before the result is awaited.
  await workerEvent(first, 'checking');
  const second = spawnWorker('write', 'return "second writer"\n');
  const secondResult = await workerEvent(second, 'result');
  assert.equal(secondResult.result.errorCode, 'rojo_write_locked');
  first.send('release');
  assert.equal((await firstResult).result.success, true);
  assert.equal(await readFile(mainFile, 'utf8'), 'return "first writer"\n');
  console.log(`Passed with ${version}: real sourcemaps, server/module/init/nested scripts, ignore rules, disk writes/readback, recovery copies, stale revisions, generated-source refusal, and two OS processes sharing a write lease. Studio was simulated; live synchronization is not covered.`);
} finally {
  for (const child of workers) if (child.exitCode === null) child.kill();
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('roqer-rojo-cli-')) throw new Error('Unsafe fixture cleanup path');
  await rm(root, { recursive: true, force: true });
}
