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

async function setup(fileText: string, options: { studioText?: string; studioAfter?: string[]; link?: boolean } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer edit ')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'Packages', '_Index', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'default.project.json'), '{"name":"Fixture","tree":{"$className":"DataModel"}}');
  fs.writeFileSync(path.join(root, 'src', 'Main.server.luau'), fileText);
  fs.writeFileSync(path.join(root, 'Packages', '_Index', 'x', 'init.lua'), 'return {}');
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
      const text = after.length > 0 ? after.shift()! : studioText;
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
  return { tools, calls, file: path.join(root, 'src', 'Main.server.luau') };
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
  });

  test('generated file is refused', async () => {
    const { tools, calls } = await setup('x');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Gen', 'x', 'y'));
    expect(result.errorCode).toBe('rojo_generated');
    expect(studioWrites(calls)).toEqual([]);
  });

  test('studio-only script writes Studio and says so', async () => {
    const { tools, calls } = await setup('local x = 1\n');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Other', 'x = 1', 'x = 2'));
    expect(result).toMatchObject({ success: true, persistence: 'studio_only' });
    expect(studioWrites(calls)).toHaveLength(1);
  });

  test('get_script_source names the file and whether it matches Studio', async () => {
    const { tools } = await setup('local x = 1\n');
    const result = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(result).toMatchObject({ file: path.join('src', 'Main.server.luau'), persistence: 'file', fileMatchesStudio: true });
  });

  test('find_and_replace touching a file-backed script is refused', async () => {
    const { tools, calls } = await setup('local x = 1\n');
    const result = body(await tools.findAndReplaceInScripts('x', 'y', {}));
    expect(result.errorCode).toBe('rojo_bulk_edit_refused');
    expect(calls.filter((call) => call.endpoint === '/api/find-and-replace-in-scripts').every((call) => call.data.dryRun === true)).toBe(true);
  });

  test('link_project without project, and unlink_project', async () => {
    const { tools } = await setup('x');
    expect(body(await tools.manageInstance({ action: 'link_project' })).errorCode).toBe('rojo_link_invalid');
    expect(body(await tools.manageInstance({ action: 'unlink_project' }))).toMatchObject({ unlinked: true });
    expect(tools.rojo.hasLinks()).toBe(false);
  });

  test('file write failure: the plan still runs, but the write errors and Studio is never applied', async () => {
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
