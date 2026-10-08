// `--rojo-project`/ROQER_ROJO_PROJECT: an MCP client with no UI for
// link_project can still get a Rojo-linked place, by naming a default
// project when the server starts. Core links it lazily, on the first call
// that would otherwise need a link, same fixture pattern as
// rojo-script-edits.test.ts (a real temp Rojo project on disk, Studio faked
// at the plugin boundary).
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
  ] },
] };

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

function makeProject(fileText: string) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer default-project ')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'default.project.json'), '{"name":"Fixture","tree":{"$className":"DataModel"}}');
  fs.writeFileSync(path.join(root, 'src', 'Main.server.luau'), fileText);
  return { root, projectFile: path.join(root, 'default.project.json'), file: path.join(root, 'src', 'Main.server.luau') };
}

/** A RobloxStudioTools wired like rojo-script-edits.test.ts's fixture, but
 * never pre-linked: the test decides whether to pass this fixture's own
 * project file as the default. */
function setup(fileText: string, options: { useDefault?: boolean; studioAfter?: string[]; resolvedId?: string } = {}) {
  const { root, projectFile, file } = makeProject(fileText);
  const studioText = fileText;
  const after = [...(options.studioAfter ?? [])];
  const tools = new RobloxStudioTools(new BridgeService(), { rojoProject: options.useDefault ? projectFile : undefined });
  const calls: Call[] = [];
  const answers: Record<string, (data: Record<string, unknown>) => unknown> = {
    '/api/edit-script-lines': (data) => {
      const source = studioText.replace(String(data.old_string), String(data.new_string));
      const plan = { planned: true, instancePath: 'game.ServerScriptService.Main', instanceRef: 'ref:1', className: 'Script', uniquePath: true, previousRevision: sourceRevision(studioText), revision: sourceRevision(source), source };
      return data.planOnly ? plan : { success: true, instancePath: plan.instancePath, previousRevision: plan.previousRevision, revision: plan.revision };
    },
    '/api/get-script-source': () => {
      const writeLanded = fs.readFileSync(file, 'utf8') !== fileText;
      const text = writeLanded ? (after.length > 0 ? after.shift()! : studioText) : studioText;
      return { instancePath: 'game.ServerScriptService.Main', className: 'Script', revision: sourceRevision(text), source: text, lineCount: 1 };
    },
    '/api/find-and-replace-in-scripts': (data) => ({ dryRun: data.dryRun, changes: [{ instancePath: 'game.ServerScriptService.Main', replacements: 1 }] }),
  };
  (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
    calls.push({ endpoint, data });
    return answers[endpoint](data);
  };
  const resolvedId = options.resolvedId ?? 'place:1';
  (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => resolvedId;
  let linkCalls = 0;
  const baseRojo = new RojoIntegration({
    run: async (args) => (args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(sourcemap)),
    ignored: async () => new Set(),
    probe: async () => ({ reachable: false }),
  });
  const trackedLink = baseRojo.link.bind(baseRojo);
  tools.rojo = Object.assign(baseRojo, {
    link: (instanceId: string, projectPath: string) => { linkCalls += 1; return trackedLink(instanceId, projectPath); },
  });
  return { tools, calls, file, root, projectFile, linkCalls: () => linkCalls };
}

describe('--rojo-project default link', () => {
  test('lazy link on first script write', async () => {
    const { tools, calls, file } = setup('local x = 1\n', { useDefault: true, studioAfter: ['local x = 2\n'] });
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 2\n');
    expect(result).toMatchObject({ success: true, saved: { file: path.join('src', 'Main.server.luau') } });
    expect(tools.rojo.hasLinks()).toBe(true);
    expect(calls.some((call) => call.endpoint === '/api/edit-script-lines')).toBe(true);
  });

  test('lazy link on first script read', async () => {
    const { tools } = setup('local x = 1\n', { useDefault: true });
    const result = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(result).toMatchObject({ file: path.join('src', 'Main.server.luau'), persistence: 'file' });
    expect(tools.rojo.hasLinks()).toBe(true);
  });

  test('no second link attempt after success', async () => {
    const { tools, linkCalls } = setup('local x = 1\n', { useDefault: true });
    await tools.getScriptSource('game.ServerScriptService.Main');
    await tools.getScriptSource('game.ServerScriptService.Main');
    await tools.getScriptSource('game.ServerScriptService.Main');
    expect(linkCalls()).toBe(1);
  });

  test('error surfaced once then plain unlinked behaviour', async () => {
    const { root } = makeProject('local x = 1\n');
    const missing = path.join(root, 'missing.project.json');
    const tools = new RobloxStudioTools(new BridgeService(), { rojoProject: missing });
    (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'place:1';
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string) => {
      if (endpoint === '/api/get-script-source') {
        return { instancePath: 'game.ServerScriptService.Main', className: 'Script', revision: 'rev1', source: 'x', lineCount: 1 };
      }
      throw new Error(`unexpected call to ${endpoint}`);
    };

    const first = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(first.errorCode).toBe('rojo_link_invalid');
    expect(typeof first.error).toBe('string');

    const second = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(second.errorCode).toBeUndefined();
    expect(second.error).toBeUndefined();
    expect(second.persistenceNote).toBeUndefined();
    expect(tools.rojo.hasLinks()).toBe(false);
  });

  test('not applied when another instance already holds the project', async () => {
    const { projectFile } = makeProject('local x = 1\n');
    const tools = new RobloxStudioTools(new BridgeService(), { rojoProject: projectFile });
    tools.rojo = new RojoIntegration({
      run: async (args) => (args[0] === '--version' ? 'Rojo 7.6.1' : JSON.stringify(sourcemap)),
      ignored: async () => new Set(),
      probe: async () => ({ reachable: false }),
    });
    // The call's own target (no instance_id passed) resolves to place:2;
    // place:1 is a different, already-connected place that holds the link.
    (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId =
      (instance_id?: string) => instance_id ?? 'place:2';
    // Another place already holds the default project directly.
    await tools.manageInstance({ action: 'link_project', instance_id: 'place:1', project: projectFile });

    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string) => {
      if (endpoint === '/api/get-script-source') {
        return { instancePath: 'game.ServerScriptService.Main', className: 'Script', revision: 'rev1', source: 'x', lineCount: 1 };
      }
      throw new Error(`unexpected call to ${endpoint}`);
    };

    const result = body(await tools.getScriptSource('game.ServerScriptService.Main'));
    expect(result.errorCode).toBeUndefined();
    expect(result.error).toBeUndefined();
    expect(result.persistence).toBeUndefined();
    expect(tools.rojo.linkFor('place:2')).toBeUndefined();
  });

  test('no effect when unset', async () => {
    const { tools, calls, file } = setup('local x = 1\n');
    const result = body(await tools.editScriptLines('game.ServerScriptService.Main', 'x = 1', 'x = 2'));
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/edit-script-lines']);
    expect(calls[0].data.planOnly).toBeUndefined();
    expect(result.success).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe('local x = 1\n');
    expect(tools.rojo.hasLinks()).toBe(false);
  });

  test('find_and_replace guard also links lazily and surfaces a default-link failure', async () => {
    const { root } = makeProject('local x = 1\n');
    const missing = path.join(root, 'missing.project.json');
    const tools = new RobloxStudioTools(new BridgeService(), { rojoProject: missing });
    (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'place:1';
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
      if (endpoint === '/api/find-and-replace-in-scripts') {
        return { dryRun: data.dryRun, changes: [{ instancePath: 'game.ServerScriptService.Main', replacements: 1 }] };
      }
      throw new Error(`unexpected call to ${endpoint}`);
    };
    const result = body(await tools.findAndReplaceInScripts('x', 'y', {}));
    expect(result.errorCode).toBe('rojo_link_invalid');
  });
});
