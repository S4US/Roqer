#!/usr/bin/env node
// Live check of file-backed script edits on a Rojo-linked place
// (packages/core/src/rojo/, packages/core/src/tools/index.ts _scriptWrite).
// Needs a real `rojo serve` and a human to connect Studio's Rojo plugin to
// it; run inside the managed Studio session through `npm run test:studio:rojo`.
//
// Builds a disposable temp Rojo project with one script, links it to the
// connected place, and checks: an edit changes the file and syncs; a file
// saved with CRLF line endings keeps them through an edit; a file changed
// behind Roqer's back is a conflict that touches neither side; killing
// `rojo serve` makes an edit "pending" without ever reaching Studio; no
// `.roqer-*.tmp` write-in-progress temp file is ever visible as an instance;
// and new scripts built with build_instances are saved as files that Rojo
// alone makes in Studio, one copy each.
//
// Never touches the user's own place: everything happens in a temp project
// linked to a disposable baseplate.
//
// Set ROJO_BIN to an absolute path to a rojo executable to run a specific
// one (for example a Rokit-managed rojo.exe installed globally, since a
// Rokit shim with no rokit.toml in this script's temp project has nothing
// to run here); both the version check and the `rojo serve` this script
// spawns honor it.

import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { McpClient, assert, assertContains, runTest, waitForEditPeer } from './lib/mcp-client.mjs';

const execFileAsync = promisify(execFile);
const ROJO_BIN = process.env.ROJO_BIN || 'rojo';
const INSTANCE_PATH = 'game.ServerScriptService.RoqerRojoProbe';
const PROBE_RELATIVE_FILE = path.join('src', 'RoqerRojoProbe.server.luau');
const TMP_INSTANCE_PATTERN = /\.roqer-[0-9a-f]+\.tmp/i;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function write(root, relativePath, contents) {
  const full = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

function buildProbeProject(root, servePort) {
  write(root, PROBE_RELATIVE_FILE, 'print("probe")\n');
  write(root, 'default.project.json', JSON.stringify({
    name: 'RoqerRojoProbe',
    servePort,
    tree: {
      $className: 'DataModel',
      // Mapped to the containing folder, not the file itself, so Rojo
      // watches the whole folder (as a real project does) and case (e)'s
      // temp-file-visibility check actually exercises something: a $path
      // straight to one file would never show a sibling temp file either way.
      ServerScriptService: { $path: 'src' },
    },
  }, null, 2));
}

/** Kills a long-running child reliably, including on Windows where a plain
    kill() can leave the process (and the port it holds) behind. */
async function killReliably(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    once(child, 'exit').then(() => true),
    delay(3000).then(() => false),
  ]);
  if (exited) return;
  if (process.platform === 'win32' && child.pid) {
    await execFileAsync('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
  } else {
    child.kill('SIGKILL');
  }
}

async function waitUntil(label, timeoutMs, pollMs, predicate) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await predicate();
    if (result) return result;
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms waiting for: ${label}`);
    }
    await delay(pollMs);
  }
}

/** Recursively searches a get_project_structure response for any instance
    name or path that looks like compareAndWrite's temp file
    (`.<name>.roqer-<hex>.tmp`), which must never be visible as an instance. */
function findTmpInstanceName(value) {
  if (typeof value === 'string') return TMP_INSTANCE_PATTERN.test(value) ? value : undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findTmpInstanceName(item);
      if (found) return found;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = findTmpInstanceName(item);
      if (found) return found;
    }
  }
  return undefined;
}

async function rojoOnPath() {
  try {
    await execFileAsync(ROJO_BIN, ['--version'], { timeout: 10_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

await runTest('Rojo-linked place saves script edits to its file', async ({ track }) => {
  if (!(await rojoOnPath())) {
    throw new Error('rojo was not found on PATH; install Rojo 7.3+ and retry. (This live suite does not skip: it is only ever invoked deliberately.)');
  }

  const client = track(new McpClient('rojo-live-sync'));
  await client.start();
  await client.initialize();
  await waitForEditPeer(client);

  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-rojo-live-')));
  const projectFile = path.join(root, 'default.project.json');
  const probeFile = path.join(root, PROBE_RELATIVE_FILE);
  let serve;
  let linked = false;
  let watching = true;
  let expectedServeExit = false;
  let tmpInstanceSeen;

  const watchForTmpInstance = (async () => {
    while (watching) {
      try {
        const structure = await client.callTool('get_project_structure', {
          path: 'game.ServerScriptService',
          maxDepth: 5,
          scriptsOnly: false,
        });
        const found = findTmpInstanceName(structure);
        if (found && !tmpInstanceSeen) tmpInstanceSeen = found;
      } catch {
        // Transient read failure is not itself a finding; keep watching.
      }
      await delay(100);
    }
  })();

  try {
    const servePort = await getFreePort();
    buildProbeProject(root, servePort);

    serve = spawn(ROJO_BIN, ['serve', 'default.project.json', '--port', String(servePort)], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const serveOutput = [];
    serve.stdout.on('data', (chunk) => serveOutput.push(String(chunk)));
    serve.stderr.on('data', (chunk) => serveOutput.push(String(chunk)));
    serve.on('exit', (code, signal) => {
      if (expectedServeExit) return; // Killed on purpose for case (d) or cleanup.
      console.warn(`  (rojo serve exited early: code=${code} signal=${signal})\n${serveOutput.join('')}`);
    });

    console.log(`\nConnect the Rojo plugin in Studio to localhost:${servePort}`);
    await waitUntil('the probe script to be synced into Studio', 120_000, 1000, async () => {
      const result = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
      return result.error ? undefined : result;
    });

    const link = await client.callTool('manage_instance', { action: 'link_project', project: projectFile });
    assert(link.linked === true, 'manage_instance link_project links the probe project');
    assert(link.scripts?.file === 1, 'the probe script is classified as file-backed');
    linked = true;

    const initial = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
    assert(initial.persistence === 'file', 'get_script_source reports the linked persistence');
    assert(initial.file === PROBE_RELATIVE_FILE, 'get_script_source reports the backing file');
    assert(initial.fileMatchesStudio === true, 'the fresh Rojo-delivered file matches Studio before any edit');

    // (a) An ordinary edit changes the file and syncs.
    const editA = await client.callTool('edit_script_lines', {
      instancePath: INSTANCE_PATH,
      old_string: 'print("probe")',
      new_string: 'print("probe-edited-a")',
    });
    assert(editA.success === true, 'edit_script_lines succeeds on a file-backed script');
    assert(editA.saved?.sync === 'synced', `the edit reports sync: synced (got ${JSON.stringify(editA.saved)})`);
    assert(editA.saved?.file === PROBE_RELATIVE_FILE, 'the result names the saved file');
    const afterA = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
    assertContains(afterA.source, 'probe-edited-a', 'Studio shows the edited text after a synced edit');

    // (b) A file saved with CRLF line endings keeps them through an edit.
    const crlfBeforeB = 'print("probe-edited-a")\r\nprint("line2")\r\n';
    fs.writeFileSync(probeFile, crlfBeforeB);
    await waitUntil('Rojo to deliver the CRLF file into Studio', 30_000, 500, async () => {
      const result = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
      return result.fileMatchesStudio === true && result.source?.includes('line2') ? result : undefined;
    });
    const editB = await client.callTool('edit_script_lines', {
      instancePath: INSTANCE_PATH,
      old_string: 'print("probe-edited-a")',
      new_string: 'print("probe-edited-b")',
    });
    assert(editB.success === true, 'edit_script_lines succeeds on a CRLF file');
    assert(editB.saved?.sync === 'synced', `the CRLF edit reports sync: synced (got ${JSON.stringify(editB.saved)})`);
    const rawAfterB = fs.readFileSync(probeFile, 'utf8');
    assert(rawAfterB.includes('probe-edited-b'), 'the file on disk carries the new text');
    assert(rawAfterB.includes('\r\n'), 'the file keeps \\r\\n line endings after the edit');
    assert(!/(?<!\r)\n/.test(rawAfterB), 'no line ending was normalized to a lone \\n');

    // (c) A file changed behind Roqer's back is a conflict; neither side
    // changes. rojo serve is still running here, so it delivers this direct
    // write into Studio on its own, racing whatever this test reads right
    // after the conflict: asserting that Studio still shows the pre-conflict
    // text would be racing that same delivery. What the feature actually
    // guarantees, with no race, is that Roqer wrote nothing: the refused
    // edit's own text was never written anywhere, so it can never show up
    // either in the file or in Studio.
    const divergentMarker = 'direct-write-should-not-apply';
    const refusedMarker = 'probe-edited-c-should-not-apply';
    const divergent = `print("${divergentMarker}")\r\nprint("line2")\r\n`;
    fs.writeFileSync(probeFile, divergent);
    const editC = await client.callTool('edit_script_lines', {
      instancePath: INSTANCE_PATH,
      old_string: 'print("probe-edited-b")',
      new_string: `print("${refusedMarker}")`,
    });
    assert(editC.error !== undefined, 'the conflicting edit fails');
    assert(editC.errorCode === 'rojo_conflict', `the conflicting edit reports rojo_conflict (got ${editC.errorCode})`);
    const fileRightAfterC = fs.readFileSync(probeFile, 'utf8');
    assert(fileRightAfterC === divergent, 'the conflict leaves the file exactly as it was written behind Roqer\'s back, Roqer wrote nothing');
    const studioRightAfterC = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
    assert(!studioRightAfterC.source?.includes(refusedMarker), 'Studio never shows the refused edit\'s text');

    // (d) below needs the file and Studio to agree before it can edit from a
    // known baseline. Rather than writing yet another variant to force that,
    // wait for Rojo to deliver the direct write this test already made, and
    // use its exact text as the next edit's baseline.
    await waitUntil('Rojo to deliver the direct write into Studio', 30_000, 500, async () => {
      const result = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
      return result.fileMatchesStudio === true && result.source?.includes(divergentMarker) ? result : undefined;
    });

    // (f) New scripts built into the project folder are saved as files, and
    // Rojo, not Roqer, makes them in Studio: exactly one copy each, with the
    // source the build gave them, and the next edit is file-backed too.
    const built = await client.callTool('build_instances', {
      path: 'game.ServerScriptService',
      operations: [
        { op: 'create', id: 'kit', className: 'Folder', name: 'RoqerRojoKit' },
        { op: 'create', className: 'ModuleScript', name: 'Made', parent: '$kit' },
        { op: 'create', className: 'Script', name: 'Runner', parent: '$kit' },
      ],
    });
    assert(built.success === true, `build_instances saves the new scripts (got ${JSON.stringify(built)})`);
    assert(built.saved?.sync === 'synced', `the build reports sync: synced (got ${JSON.stringify(built.saved)})`);
    assert(fs.existsSync(path.join(root, 'src', 'RoqerRojoKit', 'Made.luau'))
      && fs.existsSync(path.join(root, 'src', 'RoqerRojoKit', 'Runner.server.luau')), 'the new files are on disk where Rojo reads them');
    const copies = await client.callTool('execute_luau', {
      code: 'local n = 0 for _, child in game.ServerScriptService:GetChildren() do if child.Name == "RoqerRojoKit" then n += 1 end end return n',
      target: 'edit',
    });
    assert(String(copies.returnValue) === '1', `Studio holds exactly one RoqerRojoKit, not a second copy (got ${copies.returnValue})`);
    const made = await client.callTool('get_script_source', { instancePath: 'game.ServerScriptService.RoqerRojoKit.Made' });
    assert(made.persistence === 'file' && made.fileMatchesStudio === true, `the new script reads back file-backed (got ${made.persistence})`);
    const madeEdit = await client.callTool('set_script_source', {
      instancePath: 'game.ServerScriptService.RoqerRojoKit.Made',
      source: 'return "made"\n',
      expectedRevision: made.revision,
    });
    assert(madeEdit.saved?.sync === 'synced', `an edit to the new script is saved to its file (got ${JSON.stringify(madeEdit.saved)})`);

    // (d) Killing rojo serve makes an edit "pending"; Studio is never written.
    expectedServeExit = true;
    await killReliably(serve);
    serve = undefined;
    const editD = await client.callTool('edit_script_lines', {
      instancePath: INSTANCE_PATH,
      old_string: `print("${divergentMarker}")`,
      new_string: 'print("probe-edited-d-pending")',
    });
    assert(editD.success === true, 'the edit still succeeds (the file write does not need rojo serve)');
    assert(editD.saved?.sync === 'pending', `the edit reports sync: pending once rojo serve is dead (got ${JSON.stringify(editD.saved)})`);
    assert(typeof editD.hint === 'string' && editD.hint.length > 0, 'a pending sync carries a hint');
    const fileAfterD = fs.readFileSync(probeFile, 'utf8');
    assert(fileAfterD.includes('probe-edited-d-pending'), 'the file itself was saved even though Rojo cannot deliver it');
    await delay(6000);
    const studioAfterD = await client.callTool('get_script_source', { instancePath: INSTANCE_PATH });
    assertContains(studioAfterD.source, divergentMarker, 'Studio\'s source is unchanged 6s after a pending edit');

    // (e) The compareAndWrite temp file never appeared as an instance. This
    // is best-effort 100ms polling, not a guarantee: a pass does not prove
    // the temp file was never visible, only that this watcher never caught it.
    watching = false;
    await watchForTmpInstance;
    assert(tmpInstanceSeen === undefined, `no .roqer-*.tmp write-in-progress file was ever visible as an instance (saw ${tmpInstanceSeen})`);
  } finally {
    watching = false;
    await watchForTmpInstance.catch(() => {});
    expectedServeExit = true;
    await killReliably(serve);
    if (linked) {
      await client.callTool('manage_instance', { action: 'unlink_project' }).catch(() => {});
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
}).then((ok) => process.exit(ok ? 0 : 1));
