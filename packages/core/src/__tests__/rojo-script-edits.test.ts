// Script edits on a Rojo-linked place: a tool-flow test with Studio faked at
// the plugin boundary (same stub pattern as rig-tool.test.ts) and a real temp
// Rojo project on disk, so _scriptWrite's plan/write/sync-wait pipeline runs
// against an actual file instead of a mock of one.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { RojoIntegration } from '../rojo/index.js';
import { sourceRevision } from '../rojo/source-revision.js';
import { RobloxStudioTools } from '../tools/index.js';

type Call = { endpoint: string; data: Record<string, unknown> };
const body = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0].text!);
const sourcemap = { name: 'Game', className: 'DataModel', children: [
  { name: 'ServerScriptService', className: 'ServerScriptService', children: [
    { name: 'Main', className: 'Script', filePaths: ['src/Main.server.luau'] },
    { name: 'Gen', className: 'ModuleScript', filePaths: ['Packages/_Index/x/init.lua'] },
  ] },
] };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

async function setup(fileText: string, options: { studioText?: string; studioAfter?: string[]; link?: boolean; preWriteText?: string } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer edit ')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'Packages', '_Index', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'default.project.json'), '{"name":"Fixture","tree":{"$className":"DataModel"}}');
  fs.writeFileSync(path.join(root, 'src', 'Main.server.luau'), fileText);
  fs.writeFileSync(path.join(root, 'Packages', '_Index', 'x', 'init.lua'), 'return {}');
  const file = path.join(root, 'src', 'Main.server.luau');
  const studioText = options.studioText ?? fileText;
  const after = [...(options.studioAfter ?? [])];
  const tools = new RobloxStudioTools(new BridgeService());
  const calls: Call[] = [];
  const nameOf = (instancePath: unknown) => String(instancePath).split('.').at(-1)!;
  const answers: Record<string, (data: Record<string, unknown>) => unknown> = {
    '/api/edit-script-lines': (data) => {
      const name = nameOf(data.instancePath);
      const source = studioText.replace(String(data.old_string), String(data.new_string));
      const plan = { planned: true, instancePath: `game.ServerScriptService.${name}`, instanceRef: 'ref:1', className: name === 'Gen' ? 'ModuleScript' : 'Script', uniquePath: true, previousRevision: sourceRevision(studioText), revision: sourceRevision(source), source };
      return data.planOnly ? plan : { success: true, instancePath: plan.instancePath, previousRevision: plan.previousRevision, revision: plan.revision };
    },
    '/api/get-script-source': () => {
      // Before the write lands on disk this answers the pre-write recheck
      // (and, on a failed write, the post-failure conflict read) with
      // preWriteText if given, else studioText unchanged. Once the file on
      // disk differs from what it started as, the write has happened, so
      // later calls (the sync-wait poll) draw from studioAfter instead.
      const writeLanded = fs.readFileSync(file, 'utf8') !== fileText;
      const text = writeLanded
        ? (after.length > 0 ? after.shift()! : studioText)
        : (options.preWriteText ?? studioText);
      return { instancePath: 'game.ServerScriptService.Main', className: 'Script', revision: sourceRevision(text), source: text, lineCount: 1 };
    },
    '/api/find-and-replace-in-scripts': (data) => ({ dryRun: data.dryRun, changes: [{ instancePath: 'game.ServerScriptService.Main', replacements: 1 }] }),
  };
  (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
    calls.push({ endpoint, data });
    return answers[endpoint](data);
  };
  (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'place:1';
  tools.rojo = new RojoIntegration({
    run: async (args) => (args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(sourcemap)),
    ignored: async () => new Set(),
    probe: async () => ({ reachable: false }),
  });
  if (options.link !== false) await tools.manageInstance({ action: 'link_project', project: path.join(root, 'default.project.json') });
  return { tools, calls, file };
}

const studioWrites = (calls: Call[]) => calls.filter((call) => call.endpoint === '/api/edit-script-lines' && call.data.planOnly !== true);

describe('script edits on a Rojo-linked place', () => {
  test('unlinked: requests are exactly as before', async () => {
    const { tools, calls } = await setup('local x = 1\n', { link: false });
    await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2');
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/edit-script-lines']);
    expect(calls[0].data.planOnly).toBeUndefined();
  });

  test('file-backed: plans, writes the file, and reports synced', async () => {
    const { tools, calls, file } = await setup('local x = 1\n', { studioAfter: ['local x = 2\n'] });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 2\n');
    expect(result).toMatchObject({ success: true, saved: { file: path.join('src', 'Main.server.luau'), sync: 'synced' }, revision: sourceRevision('local x = 2\n') });
    expect(result.source).toBeUndefined();
    expect(studioWrites(calls)).toEqual([]);
  });

  test('Rojo not delivering: file saved, sync pending, Studio never written', async () => {
    const { tools, calls, file } = await setup('local x = 1\n');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 2\n');
    expect(result.saved).toEqual({ file: path.join('src', 'Main.server.luau'), sync: 'pending' });
    expect(result.hint).toMatch(/rojo serve/);
    expect(studioWrites(calls)).toEqual([]);
  }, 15_000);

  test('Studio changing on its own after the write is diverged', async () => {
    const { tools } = await setup('local x = 1\n', { studioAfter: ['someone typed\n'] });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(result.saved.sync).toBe('diverged');
  });

  test('file and Studio disagree: rojo_conflict, nothing written anywhere', async () => {
    const { tools, calls, file } = await setup('local x = 1 -- edited on disk\n', { studioText: 'local x = 1\n' });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(result).toMatchObject({ errorCode: 'rojo_conflict', file: path.join('src', 'Main.server.luau') });
    expect(result.differing.firstLine).toBe(1);
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 1 -- edited on disk\n');
    expect(studioWrites(calls)).toEqual([]);
    // A5: the conflict message gives the two real options and names neither a
    // Rojo button nor command, since Rojo cannot copy Studio's text back.
    expect(result.error).toBe(
      `${path.join('src', 'Main.server.luau')} and the script in Studio differ, so neither was changed. ` +
      'To keep the file, reconnect the Rojo plugin so Studio takes the file, then retry. ' +
      "To keep Studio's version, copy its text into the file, then retry. " +
      'Rojo cannot copy Studio\'s text back to the file.'
    );
  });

  test('a CRLF file whose LF form matches Studio: write succeeds, stays CRLF, synced', async () => {
    const { tools, calls, file } = await setup('local x = 1\r\n', { studioText: 'local x = 1\n', studioAfter: ['local x = 2\n'] });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 2\r\n');
    expect(result).toMatchObject({ success: true, saved: { file: path.join('src', 'Main.server.luau'), sync: 'synced' } });
    expect(studioWrites(calls)).toEqual([]);
  });

  test('a CRLF file that genuinely differs from Studio is still a conflict', async () => {
    const { tools, file } = await setup('local x = 1 -- disk\r\n', { studioText: 'local x = 1\n' });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(result.errorCode).toBe('rojo_conflict');
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 1 -- disk\r\n');
  });

  test('get_script_source: a CRLF file whose LF form matches Studio reports fileMatchesStudio true', async () => {
    const { tools } = await setup('local x = 1\r\n', { studioText: 'local x = 1\n' });
    const result = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(result).toMatchObject({ file: path.join('src', 'Main.server.luau'), persistence: 'file', fileMatchesStudio: true });
  });

  test('generated file is refused', async () => {
    const { tools, calls } = await setup('x');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Gen', 'x', 'y'));
    expect(result.errorCode).toBe('rojo_generated');
    expect(studioWrites(calls)).toEqual([]);
    // A3: the reason ends in a period before "Nothing was changed." (no run-on).
    expect(result.error).toBe(`${path.join('Packages', '_Index', 'x', 'init.lua')} is a package or build output, not source. Nothing was changed.`);
  });

  test('studio-only script writes Studio and says so', async () => {
    const { tools, calls } = await setup('local x = 1\n');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Other', 'x = 1', 'x = 2'));
    expect(result).toMatchObject({ success: true, persistence: 'studio_only' });
    expect(result.persistenceNote).toMatch(/studio only/i);
    expect(studioWrites(calls)).toHaveLength(1);
  });

  test('get_script_source names the file and whether it matches Studio', async () => {
    const { tools } = await setup('local x = 1\n');
    const result = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(result).toMatchObject({ file: path.join('src', 'Main.server.luau'), persistence: 'file', fileMatchesStudio: true });
  });

  test('get_script_source keeps the plugin\'s own note alongside Rojo\'s persistence note', async () => {
    const { tools } = await setup('local x = 1\n');
    (tools as unknown as { _callSingle: unknown })._callSingle = async () => ({
      instancePath: 'game.ServerScriptService.Other',
      className: 'Script',
      revision: 'rev1',
      source: 'x',
      lineCount: 1,
      note: 'truncated at 500 lines',
    });
    const result = body(await tools.getScriptSource('game.ServerScriptService.Other'));
    expect(result.note).toBe('truncated at 500 lines');
    expect(result.persistenceNote).toMatch(/studio only/i);
  });

  test('a Studio edit mid-resolve-window is caught before the write, not lost', async () => {
    const { tools, calls, file } = await setup('local x = 1\n', { preWriteText: 'local x = 1 -- changed in studio\n' });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(result).toMatchObject({ errorCode: 'rojo_conflict', file: path.join('src', 'Main.server.luau') });
    expect(result.studioRevision).toBe(sourceRevision('local x = 1 -- changed in studio\n'));
    expect(result.fileRevision).toBe(sourceRevision('local x = 1\n'));
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 1\n');
    expect(studioWrites(calls)).toEqual([]);
    // A5: both conflict sites use the same message.
    expect(result.error).toBe(
      `${path.join('src', 'Main.server.luau')} and the script in Studio differ, so neither was changed. ` +
      'To keep the file, reconnect the Rojo plugin so Studio takes the file, then retry. ' +
      "To keep Studio's version, copy its text into the file, then retry. " +
      'Rojo cannot copy Studio\'s text back to the file.'
    );
  });

  test('find_and_replace touching a file-backed script is refused', async () => {
    const { tools, calls } = await setup('local x = 1\n');
    const result = body(await tools.findAndReplaceInScripts('x', 'y', {}));
    expect(result.errorCode).toBe('rojo_bulk_edit_refused');
    expect(calls.filter((call) => call.endpoint === '/api/find-and-replace-in-scripts').every((call) => call.data.dryRun === true)).toBe(true);
  });

  test('find_and_replace guard: a RojoError while resolving ownership is reported, not thrown', async () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer far ')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'default.project.json'), '{"name":"Fixture","tree":{"$className":"DataModel"}}');
    fs.writeFileSync(path.join(root, 'src', 'Main.server.luau'), 'local x = 1\n');
    const tools = new RobloxStudioTools(new BridgeService());
    const calls: Call[] = [];
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
      calls.push({ endpoint, data });
      if (endpoint === '/api/find-and-replace-in-scripts') {
        return { dryRun: data.dryRun, changes: [{ instancePath: 'game.ServerScriptService.Main', replacements: 1 }] };
      }
      throw new Error(`unexpected call to ${endpoint}`);
    };
    (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'place:1';
    let sourcemapCalls = 0;
    let clock = 0;
    tools.rojo = new RojoIntegration({
      run: async (args) => {
        if (args[0] === '--version') return 'Rojo 7.6.1';
        sourcemapCalls += 1;
        // Succeeds once, for link_project; the guard's later resolve forces a
        // fresh read (via the clock below outrunning the read cache) and
        // gets this rejection instead, as if the project vanished meanwhile.
        if (sourcemapCalls === 1) return JSON.stringify(sourcemap);
        throw new Error('rojo sourcemap failed: the project is gone');
      },
      ignored: async () => new Set(),
      probe: async () => ({ reachable: false }),
      now: () => (clock += 20_000),
    });
    await tools.manageInstance({ action: 'link_project', project: path.join(root, 'default.project.json') });

    const result = body(await tools.findAndReplaceInScripts('x', 'y', {}));
    expect(result.errorCode).toBe('rojo_link_invalid');
    // A3: the reason gets a period before "Nothing was changed." (no run-on).
    expect(result.error).toBe('rojo sourcemap failed: rojo sourcemap failed: the project is gone. Nothing was changed.');
    expect(calls.filter((call) => call.endpoint === '/api/find-and-replace-in-scripts').every((call) => call.data.dryRun === true)).toBe(true);
  });

  test('_rojoLinkFor finds the link by an id the place is equivalent to', () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const link = { instanceId: 'place:1', projectFile: '/x/default.project.json', root: '/x', projectName: 'X', rojoVersion: '7.6.1', port: 34872 };
    tools.rojo = {
      hasLinks: () => true,
      linkFor: (id?: string) => (id === 'place:1' ? link : undefined),
    } as unknown as RojoIntegration;
    (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'anon:xyz';
    (tools as unknown as { bridge: unknown }).bridge = {
      getEquivalentInstanceIds: (id: string) => (id === 'anon:xyz' ? ['anon:xyz', 'place:1'] : [id]),
    };
    expect((tools as unknown as { _rojoLinkFor: (id?: string) => unknown })._rojoLinkFor()).toBe(link);
  });

  test('link_project without project, and unlink_project', async () => {
    const { tools } = await setup('x');
    expect(body(await tools.manageInstance({ action: 'link_project' })).errorCode).toBe('rojo_link_invalid');
    expect(body(await tools.manageInstance({ action: 'unlink_project' }))).toMatchObject({ unlinked: true });
    expect(tools.rojo.hasLinks()).toBe(false);
  });

  // Root ignores permission bits, so a read-only directory would not make the
  // write fail; skip there rather than report a false pass or a flaky one.
  (process.getuid?.() === 0 ? test.skip : test)('file write failure: the plan still runs, but the write errors and Studio is never applied', async () => {
    const { tools, calls, file } = await setup('local x = 1\n');
    const dir = path.dirname(file);
    // Read-only directory: the existing file is still readable (so ownership
    // still resolves to 'file'), but compareAndWrite cannot create its temp
    // file there, so the write itself rejects.
    fs.chmodSync(dir, 0o500);
    try {
      const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
      expect(result.errorCode).toBe('rojo_write_failed');
      expect(result.file).toBe(path.join('src', 'Main.server.luau'));
      expect(studioWrites(calls)).toEqual([]);
    } finally {
      fs.chmodSync(dir, 0o755);
    }
  });
});
