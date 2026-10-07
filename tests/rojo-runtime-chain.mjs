/** Real Rojo CLI, files, HTTP client and Roqer runtime; the Studio peer is SIMULATED. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BridgeService, createHttpServer, RobloxStudioTools } from '../packages/core/dist/index.js';
import { RojoScriptProject } from '../packages/core/dist/rojo-project.js';
import { McpClient } from '../apps/desktop/runtime/mcp-client.ts';
import { RunSession } from '../apps/desktop/runtime/run-engine.ts';
import { createStudioToolRunner } from '../apps/desktop/runtime/studio-tools.ts';

const executable = process.env.ROBLOX_STUDIO_ROJO_EXECUTABLE || 'rojo';
const version = execFileSync(executable, ['--version'], { encoding: 'utf8', windowsHide: true }).trim();
const root = await mkdtemp(path.join(tmpdir(), 'roqer-rojo-runtime-'));
const file = path.join(root, 'Main.server.luau');
const projectFile = path.join(root, 'default.project.json');
const instanceId = 'SIMULATED-rojo-runtime';
const instancePath = 'game.ServerScriptService.Main';
const original = Buffer.from('\uFEFFlocal value = "before"\r\nprint(value)\r\n');
await writeFile(file, original);
await writeFile(projectFile, JSON.stringify({ name: 'RoqerRuntimeFixture', tree: {
  $className: 'DataModel', ServerScriptService: { $className: 'ServerScriptService', Main: { $path: 'Main.server.luau' } },
} }));
let studioSource = original.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
const revision = () => `SIMULATED:${createHash('sha256').update(studioSource).digest('hex')}`;
const dispatchedStarts = [];
const bridge = new BridgeService();
bridge.resolveTarget = ({ instance_id }) => ({ ok: true, mode: 'single', targetInstanceId: instance_id ?? instanceId, targetRole: 'edit' });
bridge.sendRequest = async (endpoint, data, targetId, role) => {
  assert.equal(targetId, instanceId);
  assert.equal(role, 'edit');
  if (endpoint === '/api/get-script-source') return { instancePath, instanceRef: 'SIMULATED-ref-main', className: 'Script', source: studioSource, revision: revision() };
  if (endpoint === '/api/check-script-source') {
    assert.equal(data.expectedRevision, revision());
    return { instancePath, instanceRef: 'SIMULATED-ref-main' };
  }
  if (endpoint === '/api/start-playtest') {
    dispatchedStarts.push(endpoint);
    // Do not manufacture runtime peers, execution, or a successful playtest.
    return { success: false, error: 'SIMULATED_start_dispatched', message: 'SIMULATED Studio start boundary reached; no live execution.' };
  }
  throw new Error(`Unexpected simulated Studio request ${endpoint}`);
};
const project = new RojoScriptProject({ projectFile, instanceId, executable, backupDirectory: path.join(root, 'backups') });
const app = createHttpServer(new RobloxStudioTools(bridge, project), bridge, undefined, undefined, { authToken: 'fixture-token' });
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const client = new McpClient({ endpoint, authToken: 'fixture-token' });
const calls = [];
const events = [];
const caller = { async callTool(tool, args, options) {
  const outcome = await client.callTool(tool, args, options);
  calls.push({ tool, args, outcome });
  return outcome;
} };
const lastData = () => calls.at(-1)?.outcome.data;
let counter = 0;
async function run(name, body, duringApproval) {
  let finished = false;
  let approvalError;
  const session = new RunSession({ caller,
    request: { runId: `simulated-${++counter}`, projectId: 'fixture', chatId: 'fixture', prompt: name,
      conversation: { messages: [], truncated: false }, approvalMode: 'Ask first', autoPlaytest: false,
      endpoint, instanceId, provider: 'custom', model: null, effort: 'medium' },
    planner: { id: 'deterministic-acceptance-fixture', async run(context) {
      await body(createStudioToolRunner(context));
      finished = true;
      return name;
    } },
    emit(event) {
      events.push(event);
      if (event.type !== 'approval-requested') return;
      assert.equal(event.proposal.arguments.instance_id, instanceId);
      assert.ok(['edit_script_lines', 'delete_script_lines', 'solo_playtest'].includes(event.proposal.tool));
      void Promise.resolve().then(() => duringApproval?.(event)).then(() => {
        session.resolveApproval(event.callId, 'approved');
      }).catch((error) => { approvalError = error; session.resolveApproval(event.callId, 'rejected'); });
    },
  });
  await session.execute();
  if (approvalError) throw approvalError;
  assert.ok(finished, `${name}: planner assertions failed (inspect recorded events)`);
}
try {
  let written;
  await run('write through diff, approval and verification', async (tool) => {
    assert.equal((await tool('get_script_source', { instancePath })).ok, true);
    assert.equal(lastData().filePath, file);
    assert.equal(lastData().syncStatus, 'synced');
    assert.equal((await tool('edit_script_lines', { instancePath, old_string: '"before"', new_string: '"after"' })).ok, true);
    written = calls.findLast((call) => call.tool === 'edit_script_lines').outcome.data;
    assert.deepEqual(await readFile(written.backupPath), original);
    assert.deepEqual(await readFile(file), Buffer.from('\uFEFFlocal value = "after"\r\nprint(value)\r\n'));
    assert.equal(lastData().revision, written.revision);
    assert.equal(lastData().syncStatus, 'pending');
  });
  const change = events.find((event) => event.type === 'change')?.change;
  assert.ok(change?.diff?.includes('-local value = "before"'));
  assert.ok(change?.diff?.includes('+local value = "after"'));
  assert.ok(events.some((event) => event.type === 'approval-resolved' && event.decision === 'approved' && event.automatic === false));
  assert.ok(events.some((event) => event.type === 'evidence' && event.evidence.kind === 'verification' && event.evidence.passed === false));
  await run('a new run cannot start the unsynchronized copy', async (tool) => {
    assert.equal((await tool('solo_playtest', { action: 'start', mode: 'run' })).ok, false);
    assert.equal(lastData().errorCode, 'rojo_sync_pending');
  });
  assert.equal(dispatchedStarts.length, 0);
  studioSource = (await readFile(file, 'utf8')).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  await run('approval cannot authorize a stale synchronization check', async (tool) => {
    await tool('get_script_source', { instancePath });
    assert.equal(lastData().syncStatus, 'synced');
    assert.equal((await tool('solo_playtest', { action: 'start', mode: 'run' })).ok, false);
    assert.equal(lastData().errorCode, 'rojo_sync_pending');
  }, () => writeFile(file, 'local value = "approval-window"\nprint(value)\n'));
  assert.equal(dispatchedStarts.length, 0);
  studioSource = await readFile(file, 'utf8');
  await run('an internal diff read cannot authorize conflict retries', async (tool) => {
    await tool('get_script_source', { instancePath, line_range: '2' });
    const seen = lastData().revision;
    const external = '-- external insertion\n' + studioSource;
    await writeFile(file, external);
    studioSource = external;
    for (let i = 0; i < 2; i++) {
      assert.equal((await tool('delete_script_lines', { instancePath, line_range: '2' })).ok, false);
      assert.equal(lastData().errorCode, 'source_revision_conflict');
      assert.equal(calls.at(-1).args.expectedRevision, seen);
      assert.equal(await readFile(file, 'utf8'), external);
    }
  });
  await run('synchronization permits dispatch again', async (tool) => {
    await tool('get_script_source', { instancePath });
    assert.equal(lastData().syncStatus, 'synced');
    await tool('solo_playtest', { action: 'start', mode: 'run' });
    assert.equal(lastData().error, 'SIMULATED_start_dispatched');
  });
  assert.equal(dispatchedStarts.length, 1);
  console.log(JSON.stringify({ passed: true, studioPeer: 'SIMULATED', liveSync: false, livePlaytest: false,
    rojo: version, instanceId, instancePath, file, endpoint, previousRevision: written.previousRevision,
    writtenRevision: written.revision, backupBytesMatch: true, approvalEvents: events.filter((event) => event.type === 'approval-requested').length,
    checks: ['HTTP + runtime diff/approval/verification', 'pending survives new run', 'recheck after approval', 'stale retry preserves external bytes', 'resync permits dispatch'] }, null, 2));
  if (process.env.ROQER_ROJO_RUNTIME_EVIDENCE) await writeFile(process.env.ROQER_ROJO_RUNTIME_EVIDENCE, JSON.stringify({ studioPeer: 'SIMULATED', calls, events }, null, 2) + '\n');
} finally {
  await app.cleanup();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
