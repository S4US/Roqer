import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { RojoScriptProject, rojoProjectConfig } from '../rojo-project.js';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';
import { createHttpServer, TOOL_HANDLERS } from '../http-server.js';
import { AddressInfo } from 'node:net';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createToolServer } from '../mcp-runtime.js';
import { getAllTools } from '../tools/definitions.js';
import { serveStdio } from '@modelcontextprotocol/server/stdio';

const target = 'game.ServerScriptService.Main';
const get = '/api/get-script-source';
const set = '/api/set-script-source';
type Value = Record<string, unknown>;

describe('Rojo existing script backend', () => {
  let root: string;
  let file: string;
  let projectFile: string;
  let mapping: Value;
  let studioSource: string;
  let check: (() => Promise<void>) | undefined;
  let calls: string[];
  let project: RojoScriptProject;

  const map = (filePaths: string[], className = 'Script'): Value => ({
    name: 'Fixture', className: 'DataModel', children: [
      { name: 'ServerScriptService', className: 'ServerScriptService', children: [{ name: 'Main', className, filePaths }] },
    ],
  });
  const studio = async (endpoint: string, data: Value): Promise<Value> => {
    calls.push(endpoint);
    if (endpoint === get) return { instancePath: target, instanceRef: 'ref-main', className: 'Script', source: studioSource, revision: 'studio-current' };
    if (endpoint === '/api/check-script-source') {
      await check?.();
      return { instancePath: target, instanceRef: 'ref-main' };
    }
    return { success: true, studioFallback: true, ...data };
  };
  const run = (endpoint: string, data: Value = {}) => project.handle(endpoint, { instancePath: target, ...data }, 'edit', studio);

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(tmpdir(), 'roqer-rojo-test-'));
    file = path.join(root, 'Main.server.luau');
    projectFile = path.join(root, 'default.project.json');
    studioSource = 'local value = 1\nreturn value\n';
    await fs.writeFile(file, studioSource);
    await fs.writeFile(projectFile, '{}');
    mapping = map([file]);
    calls = [];
    check = undefined;
    project = new RojoScriptProject({ projectFile, instanceId: 'bound', backupDirectory: path.join(root, 'host-backups') }, async () => mapping);
  });
  afterEach(async () => {
    // Only the unique fixture this test created is disposable.
    if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('roqer-rojo-test-')) throw new Error('Unsafe fixture cleanup path');
    await fs.rm(root, { recursive: true, force: true });
  });

  test('configuration requires an explicit absolute project and Studio binding', () => {
    expect(rojoProjectConfig({})).toBeUndefined();
    expect(() => rojoProjectConfig({ ROBLOX_STUDIO_ROJO_PROJECT: projectFile })).toThrow('both');
    expect(() => rojoProjectConfig({ ROBLOX_STUDIO_ROJO_PROJECT: 'default.project.json', ROBLOX_STUDIO_ROJO_INSTANCE_ID: 'bound' })).toThrow('absolute');
    expect(rojoProjectConfig({ ROBLOX_STUDIO_ROJO_PROJECT: projectFile, ROBLOX_STUDIO_ROJO_INSTANCE_ID: 'bound' })?.instanceId).toBe('bound');
    expect(project.handles(set, 'bound')).toBe(true);
    expect(project.handles(set, 'another-studio')).toBe(false);
    expect(project.handles('/api/build-instances', 'bound')).toBe(false);
  });

  test('reads disk, identifies its real file, and reports a pending Studio sync truthfully', async () => {
    await fs.writeFile(file, 'local value = 2\nreturn value\n');
    const read = await run(get);
    expect(read).toMatchObject({ sourceOrigin: 'rojo', filePath: file, syncStatus: 'pending', lineCount: 2 });
    expect(read.numberedSource).toBe('1: local value = 2\n2: return value');
    expect(read.revision).toMatch(/^rojo:[a-f0-9]{64}$/);
    expect(calls).toEqual([get]);
  });

  test('a full source write preserves BOM and CRLF and never assigns Studio Source', async () => {
    await fs.writeFile(file, '\uFEFF' + studioSource.replace(/\n/g, '\r\n'));
    const read = await run(get);
    const write = await run(set, { source: 'local value = 2\nreturn value\n', expectedRevision: read.revision });
    expect(write).toMatchObject({ success: true, method: 'rojo-file', fileVerified: true, syncStatus: 'pending' });
    expect(await fs.readFile(file, 'utf8')).toBe('\uFEFFlocal value = 2\r\nreturn value\r\n');
    expect(await fs.readFile(String(write.backupPath), 'utf8')).toBe('\uFEFFlocal value = 1\r\nreturn value\r\n');
    expect(calls).not.toContain(set);
    expect(calls).toContain('/api/check-script-source');
    expect((await fs.readdir(root)).filter((name) => name.includes('.roqer-'))).toEqual([]);
    studioSource = 'local value = 2\nreturn value\n';
    const readback = await run(get);
    expect(readback.revision).toBe(write.revision);
    expect(readback.syncStatus).toBe('synced');
  });

  test('a stale read cannot overwrite an external file edit', async () => {
    const read = await run(get);
    await fs.writeFile(file, 'return "external"\n');
    const result = await run(set, { source: 'return "agent"\n', expectedRevision: read.revision });
    expect(result.errorCode).toBe('source_revision_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('return "external"\n');
    expect(calls).not.toContain('/api/check-script-source');
  });

  test('an unsynchronized or independently edited Studio source prevents file writes', async () => {
    const read = await run(get);
    studioSource = 'return "Studio user edit"';
    const result = await run(set, { source: 'return "agent"', expectedRevision: read.revision });
    expect(result.errorCode).toBe('rojo_sync_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('local value = 1\nreturn value\n');
    expect(calls).not.toContain(set);
  });

  test('the primary holds later-run solo and multiplayer starts until an earlier file write synchronizes', async () => {
    const read = await run(get);
    const written = await run(set, { source: 'return "new source"\n', expectedRevision: read.revision });
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'resolveTarget').mockReturnValue({ ok: true, mode: 'single', targetInstanceId: 'bound', targetRole: 'edit' });
    jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => {
      if (endpoint === '/api/start-playtest' || endpoint === '/api/multiplayer-test-start') {
        calls.push(endpoint);
        return { success: false, error: 'fixture_start_dispatched' };
      }
      return studio(endpoint, data);
    });
    const tools = new RobloxStudioTools(bridge, project);
    for (const result of [await tools.soloPlaytest('start', 'run', 0, 'bound'), await tools.multiplayerPlaytest('start', 1, undefined, undefined, undefined, 0, 'bound')]) {
      expect(JSON.parse(result.content[0].text)).toMatchObject({ success: false, errorCode: 'rojo_sync_pending' });
    }
    expect(calls).not.toContain('/api/start-playtest');
    expect(calls).not.toContain('/api/multiplayer-test-start');
    studioSource = 'return "new source"\n';
    expect(await project.checkPlaytestStart('/api/start-playtest', 'bound', 'edit', studio)).toBeUndefined();
    expect((await run(get)).revision).toBe(written.revision);
    await tools.soloPlaytest('start', 'run', 0, 'bound');
    expect(calls).toContain('/api/start-playtest');
  });

  test('a change during desktop approval is rechecked at the primary start boundary', async () => {
    expect((await run(get)).syncStatus).toBe('synced');
    await fs.writeFile(file, 'return "edited while awaiting approval"\n');
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => studio(endpoint, data));
    const tools = new RobloxStudioTools(bridge, project);
    const refused = await tools.forwardProxyRequest('/api/start-playtest', { mode: 'run' }, 'bound', 'edit');
    expect(refused).toMatchObject({ success: false, errorCode: 'rojo_sync_pending', filePath: file, syncStatus: 'pending' });
    expect(calls).not.toContain('/api/start-playtest');
    expect(await fs.readFile(file, 'utf8')).toContain('edited while awaiting approval');
    expect(await project.checkPlaytestStart('/api/start-playtest', 'other', 'edit', studio)).toBeUndefined();
  });

  test('a missing previously managed mapping cannot fall back to starting a stale Studio copy', async () => {
    await run(get);
    mapping = { name: 'Fixture', className: 'DataModel', children: [] };
    const refused = await project.checkPlaytestStart('/api/multiplayer-test-start', 'bound', 'edit', studio);
    expect(refused).toMatchObject({ success: false, errorCode: 'rojo_sync_pending', instancePath: target });
    expect(calls).not.toContain('/api/multiplayer-test-start');
  });

  test('mapping changes invalidate even an identical source revision', async () => {
    const read = await run(get);
    const other = path.join(root, 'Other.server.luau');
    await fs.writeFile(other, studioSource);
    mapping = map([other]);
    const result = await run(set, { source: 'return 2', expectedRevision: read.revision });
    expect(result.errorCode).toBe('source_revision_conflict');
    expect(await fs.readFile(other, 'utf8')).toBe(studioSource);
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
  });

  test('a removed managed mapping cannot fall back to a Studio write', async () => {
    const read = await run(get);
    mapping = { name: 'Fixture', className: 'DataModel' };
    expect((await run(set, { source: 'return 2', expectedRevision: read.revision })).errorCode).toBe('rojo_mapping_unavailable');
    expect(calls).not.toContain(set);
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
  });

  test('a mixed newline file is readable but is never silently reformatted by a write', async () => {
    await fs.writeFile(file, 'local value = 1\r\nreturn value\n');
    const read = await run(get);
    expect(read.syncStatus).toBe('synced');
    expect((await run(set, { source: 'return 2', expectedRevision: read.revision })).error).toMatch(/mixed newline/);
    expect(await fs.readFile(file, 'utf8')).toBe('local value = 1\r\nreturn value\n');
  });

  test('an external edit during validation is refused and the temporary file is removed', async () => {
    const read = await run(get);
    check = async () => { await fs.writeFile(file, 'return "external"'); };
    const result = await run(set, { source: 'return 2', expectedRevision: read.revision });
    expect(result.errorCode).toBe('source_revision_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('return "external"');
    expect((await fs.readdir(root)).filter((name) => name.includes('.roqer-'))).toEqual([]);
  });

  test('an editor atomically replacing the pathname during the final file read is never overwritten through the old descriptor', async () => {
    const read = await run(get);
    let reads = 0;
    const racing = new RojoScriptProject({ ...project.config }, async () => mapping, async (name, flags, mode) => {
      const handle = await fs.open(name, flags, mode);
      const readOpened = handle.readFile.bind(handle);
      handle.readFile = (async () => {
        const bytes = await readOpened();
        if (++reads === 3) {
          const replacement = path.join(root, 'external-save.tmp');
          await fs.writeFile(replacement, 'return "external atomic save"');
          if (process.platform === 'win32') {
            // This Windows filesystem refuses renaming over an open handle.
            // Preserve its old descriptor metadata after closing it to model
            // POSIX/editor handles that remain valid after an atomic save.
            const oldStat = await handle.stat({ bigint: true });
            await handle.close();
            handle.stat = (async () => oldStat) as typeof handle.stat;
            handle.close = async () => undefined;
          }
          await fs.rename(replacement, file);
        }
        return bytes;
      }) as typeof handle.readFile;
      return handle;
    });
    const result = await racing.handle(set, { instancePath: target, source: 'return "agent"', expectedRevision: read.revision }, 'edit', studio);
    expect(result.error).toMatch(/atomically replaced during the read/);
    expect(await fs.readFile(file, 'utf8')).toBe('return "external atomic save"');
  });

  test('concurrent writes with one revision cannot both apply', async () => {
    const read = await run(get);
    const [a, b] = await Promise.all([
      run(set, { source: 'return 2', expectedRevision: read.revision }),
      run(set, { source: 'return 3', expectedRevision: read.revision }),
    ]);
    expect(a.success).toBe(true);
    expect(b.errorCode).toBe('source_revision_conflict');
    expect(await fs.readFile(file, 'utf8')).toBe('return 2');
  });

  test('separate bridge objects cannot concurrently replace the same file', async () => {
    const read = await run(get);
    let entered!: () => void;
    let unblock!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    check = async () => { entered(); await blocked; };
    const first = run(set, { source: 'return 2', expectedRevision: read.revision });
    await checking;
    const other = new RojoScriptProject({ ...project.config }, async () => mapping);
    const second = await other.handle(set, { instancePath: target, source: 'return 3', expectedRevision: read.revision }, 'edit', studio);
    unblock();
    expect(second.errorCode).toBe('rojo_write_locked');
    expect((await first).success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('return 2');
  });

  test('cancellation during Studio validation prevents the later file replacement', async () => {
    const read = await run(get);
    const controller = new AbortController();
    check = async () => { controller.abort(); };
    const result = await project.handle(set, { instancePath: target, source: 'return 2', expectedRevision: read.revision }, 'edit', studio, controller.signal);
    expect(result.errorCode).toBe('rojo_operation_cancelled');
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
    expect((await fs.readdir(root)).filter((name) => name.includes('.roqer-'))).toEqual([]);
  });

  test('a cancelled queued write cannot resume after a preceding read completes', async () => {
    const read = await run(get);
    let entered!: () => void;
    let unblock!: () => void;
    const mappingStarted = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let firstMap = true;
    const queued = new RojoScriptProject({ ...project.config }, async () => {
      if (firstMap) { firstMap = false; entered(); await blocked; }
      return mapping;
    });
    const preceding = queued.handle(get, { instancePath: target }, 'edit', studio);
    await mappingStarted;
    const controller = new AbortController();
    const write = queued.handle(set, { instancePath: target, source: 'return 2', expectedRevision: read.revision }, 'edit', studio, controller.signal);
    controller.abort();
    unblock();
    await preceding;
    expect((await write).errorCode).toBe('rojo_operation_cancelled');
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
    expect(calls).not.toContain('/api/check-script-source');
  });

  test('a file changed during the Rojo sync wait is not verified using the old snapshot', async () => {
    const read = await run(get);
    const write = await run(set, { source: 'return 2\n', expectedRevision: read.revision });
    let reads = 0;
    const delayedPeer = async (): Promise<Value> => {
      if (++reads > 1) await fs.writeFile(file, 'return 3\n');
      return { instancePath: target, instanceRef: 'ref-main', className: 'Script', source: reads > 1 ? 'return 2\n' : studioSource, revision: 'studio-current' };
    };
    const result = await project.handle(get, { instancePath: target }, 'edit', delayedPeer);
    expect(result.syncStatus).toBe('pending');
    expect(result.revision).not.toBe(write.revision);
    expect(result.numberedSource).toBe('1: return 3');
  });

  test('a directory replaced by a junction during validation cannot redirect the final replacement', async () => {
    const sourceDir = path.join(root, 'src');
    await fs.mkdir(sourceDir);
    file = path.join(sourceDir, 'Main.server.luau');
    await fs.writeFile(file, studioSource);
    mapping = map([file]);
    const read = await run(get);
    const moved = path.join(root, 'moved-src');
    check = async () => {
      await fs.rename(sourceDir, moved);
      await fs.symlink(moved, sourceDir, process.platform === 'win32' ? 'junction' : 'dir');
    };
    const result = await run(set, { source: 'return 2', expectedRevision: read.revision });
    expect(result.error).toMatch(/symlinks or junctions/);
    expect(await fs.readFile(path.join(moved, 'Main.server.luau'), 'utf8')).toBe(studioSource);
  });

  test('exact edits require the caller revision and cannot inherit another client read', async () => {
    const read = await run(get);
    expect((await run('/api/edit-script-lines', { old_string: 'value = 1', new_string: 'value = 2' })).errorCode).toBe('rojo_revision_required');
    await fs.writeFile(file, 'local value = 1\nreturn "external"\n');
    const result = await run('/api/edit-script-lines', { old_string: 'value = 1', new_string: 'value = 2', expectedRevision: read.revision });
    expect(result.errorCode).toBe('source_revision_conflict');
    expect(await fs.readFile(file, 'utf8')).toContain('"external"');
  });

  test('a batch resolves every match against one snapshot and refuses overlaps atomically', async () => {
    const read = await run(get);
    const bad = await run('/api/edit-script-batch', { expectedRevision: read.revision, edits: [
      { old_string: 'value = 1', new_string: 'value = 2' }, { old_string: 'local value', new_string: 'local other' },
    ] });
    expect(bad.error).toMatch(/overlap/i);
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
    const good = await run('/api/edit-script-batch', { expectedRevision: read.revision, edits: [
      { old_string: 'local value = 1', new_string: 'local answer = 42' }, { old_string: 'return value', new_string: 'return answer' },
    ] });
    expect(good.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('local answer = 42\nreturn answer\n');
  });

  test('insert and delete preserve line coordinates and the existing final newline', async () => {
    const read = await run(get);
    const inserted = await run('/api/insert-script-lines', { expectedRevision: read.revision, afterLine: 0, newContent: '-- header\n' });
    expect(inserted.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('-- header\n' + studioSource);
    studioSource = '-- header\n' + studioSource;
    const deleted = await run('/api/delete-script-lines', { expectedRevision: inserted.revision, startLine: 1, endLine: 1 });
    expect(deleted.success).toBe(true);
    expect(await fs.readFile(file, 'utf8')).toBe('local value = 1\nreturn value\n');
  });

  test('partial reads carry the whole file revision without presenting truncated source as complete', async () => {
    const whole = await run(get);
    const part = await run(get, { startLine: 2, endLine: 2 });
    expect(part).toMatchObject({ revision: whole.revision, isPartial: true, startLine: 2, endLine: 2, numberedSource: '2: return value' });
  });

  test.each(['class mismatch', 'multiple source files', 'generated source', 'duplicate path', 'dotted name'])('refuses %s without falling back to a Studio write', async (kind) => {
    if (kind === 'class mismatch') mapping = map([file], 'ModuleScript');
    if (kind === 'multiple source files') mapping = map([file, path.join(root, 'other.lua')]);
    if (kind === 'generated source') mapping = map([path.join(root, 'data.json')]);
    if (kind === 'duplicate path') ((mapping.children as Value[])[0].children as Value[]).push({ name: 'Main', className: 'Script', filePaths: [file] });
    if (kind === 'dotted name') mapping = { name: 'Fixture', className: 'DataModel', children: [{ name: 'ServerScriptService.Main', className: 'Script', filePaths: [file] }] };
    const result = await run(set, { source: 'return 2', expectedRevision: 'unused' });
    expect(result.errorCode).toBe('rojo_mapping_unavailable');
    expect(calls).not.toContain(set);
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
  });

  test('source paths outside the selected project are refused', async () => {
    mapping = map([path.join(root, '..', 'outside.lua')]);
    const result = await run(get);
    expect(result.error).toMatch(/outside the selected project/);
  });

  test('junctions or symlinks inside the selected project are refused', async () => {
    const directory = path.join(root, 'real');
    const link = path.join(root, 'linked');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'source.lua'), studioSource);
    await fs.symlink(directory, link, process.platform === 'win32' ? 'junction' : 'dir');
    mapping = map([path.join(link, 'source.lua')]);
    expect((await run(get)).error).toMatch(/symlinks or junctions/);
  });

  test('invalid UTF-8 is never decoded and rewritten lossily', async () => {
    await fs.writeFile(file, Buffer.from([0xff, 0xfe, 0x00]));
    expect((await run(get)).errorCode).toBe('rojo_mapping_unavailable');
  });

  test('a missing or invalid sourcemap fails closed', async () => {
    mapping = {};
    const result = await run(set, { source: 'return 2', expectedRevision: 'unused' });
    expect(result.errorCode).toBe('rojo_mapping_unavailable');
    expect(calls).not.toContain(set);
  });

  test('Studio-owned scripts retain the existing route and runtime peers cannot mutate disk', async () => {
    mapping = { name: 'Fixture', className: 'DataModel' };
    expect((await run(set, { source: 'return 2', expectedRevision: 'studio-current' })).studioFallback).toBe(true);
    const runtime = await project.handle(set, { instancePath: target, source: 'return 3' }, 'server', studio);
    expect(runtime.errorCode).toBe('rojo_edit_mode_required');
    expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
  });

  test('bulk replacement is refused before it can change managed scripts in Studio', async () => {
    expect((await run('/api/find-and-replace-in-scripts')).errorCode).toBe('rojo_bulk_write_unsupported');
    expect(calls).toEqual([]);
  });

  test('the public tools preserve file metadata, bind every private check to the selected Studio, and leave other Studios on the ordinary route', async () => {
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'resolveTarget').mockImplementation(({ instance_id }) => ({
      ok: true, mode: 'single', targetInstanceId: instance_id ?? 'bound', targetRole: 'edit',
    }));
    const sent = jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => studio(endpoint, data));
    const tools = new RobloxStudioTools(bridge, project);
    const result = JSON.parse((await tools.getScriptSource(target, undefined, undefined, 'bound')).content[0].text);
    expect(result).toMatchObject({ sourceOrigin: 'rojo', filePath: file, syncStatus: 'synced', source: '1: local value = 1\n2: return value' });
    await tools.editScriptLines(target, 'value = 1', 'value = 2', undefined, 'bound', undefined, result.revision);
    expect(await fs.readFile(file, 'utf8')).toContain('value = 2');
    expect(sent.mock.calls.every(([, , instanceId, role]) => instanceId === 'bound' && role === 'edit')).toBe(true);
    expect(sent.mock.calls.some(([endpoint]) => endpoint === '/api/check-script-source')).toBe(true);
    sent.mockClear();
    await tools.setScriptSource(target, 'ordinary Studio source', 'other', 'studio-current');
    expect(sent.mock.calls[0][0]).toBe(set);
    expect(sent.mock.calls[0][2]).toBe('other');
    expect(await fs.readFile(file, 'utf8')).toContain('value = 2');
  });

  test('a plain proxy request uses the primary file backend instead of assigning Studio Source', async () => {
    const read = await run(get);
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => studio(endpoint, data));
    const tools = new RobloxStudioTools(bridge, project);
    const app = createHttpServer(tools, bridge, undefined, undefined, { authToken: 'fixture-token' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/proxy`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Auth': 'fixture-token' },
        body: JSON.stringify({ endpoint: set, data: { instancePath: target, source: 'return 2', expectedRevision: read.revision }, targetInstanceId: 'bound', targetRole: 'edit' }),
      });
      const result = await response.json() as { response: { method: string } };
      expect(result.response.method).toBe('rojo-file');
      expect(await fs.readFile(file, 'utf8')).toBe('return 2');
      expect(calls).not.toContain(set);
    } finally { await app.cleanup(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  test('the real MCP v2 request context can read and write a mapped file without enabling native tools', async () => {
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'resolveTarget').mockReturnValue({ ok: true, mode: 'single', targetInstanceId: 'bound', targetRole: 'edit' });
    jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => studio(endpoint, data));
    const tools = new RobloxStudioTools(bridge, project);
    const definitions = getAllTools().filter((tool) => ['get_script_source', 'set_script_source'].includes(tool.name));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio((context) => createToolServer({
      config: { name: 'rojo-fixture', version: '3.0.3', tools: definitions },
      getTools: () => tools, era: context.era,
      invoke: (current, name, args) => TOOL_HANDLERS[name](current, args),
    }), { transport: serverTransport });
    const client = new Client({ name: 'rojo-fixture-client', version: '1' }, { versionNegotiation: { mode: { pin: '2026-07-28' } } });
    try {
      await client.connect(clientTransport);
      const read = (await client.callTool({ name: 'get_script_source', arguments: { instancePath: target, instance_id: 'bound' } })).structuredContent as Value;
      expect(read).toMatchObject({ sourceOrigin: 'rojo', filePath: file, syncStatus: 'synced' });
      const write = (await client.callTool({ name: 'set_script_source', arguments: { instancePath: target, source: 'return 2', expectedRevision: read.revision, instance_id: 'bound' } })).structuredContent as Value;
      expect(write).toMatchObject({ success: true, fileVerified: true, sourceOrigin: 'rojo' });
      expect(await fs.readFile(file, 'utf8')).toBe('return 2');
    } finally { await client.close(); await handle.close(); }
  });

  test('an aborted HTTP caller cannot leave a write that commits when its Studio check later returns', async () => {
    const read = await run(get);
    const bridge = new BridgeService();
    jest.spyOn(bridge, 'resolveTarget').mockReturnValue({ ok: true, mode: 'single', targetInstanceId: 'bound', targetRole: 'edit' });
    jest.spyOn(bridge, 'sendRequest').mockImplementation(async (endpoint, data) => studio(endpoint, data));
    const app = createHttpServer(new RobloxStudioTools(bridge, project), bridge, undefined, undefined, { authToken: 'fixture-token' });
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    let entered!: () => void;
    let unblock!: () => void;
    const checking = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    check = async () => { entered(); await blocked; };
    const controller = new AbortController();
    try {
      const call = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp/set_script_source`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-MCP-Auth': 'fixture-token' }, signal: controller.signal,
        body: JSON.stringify({ instancePath: target, source: 'return 2', expectedRevision: read.revision }),
      }).catch(() => undefined);
      await checking;
      controller.abort();
      await call;
      await new Promise((resolve) => setTimeout(resolve, 50)); // Let the peer's response close event reach the handler.
      unblock();
      await run(get); // Drain the project's earlier operation before observing the file.
      expect(await fs.readFile(file, 'utf8')).toBe(studioSource);
    } finally { unblock(); await app.cleanup(); await new Promise<void>((resolve) => server.close(() => resolve())); }
  });
});
