// Structural changes on a Rojo-linked place (new scripts and models,
// removals, renames, moves): build_instances and set_properties with Studio
// faked at the plugin boundary (the plan the plugin's planOnly mode returns,
// and what Studio holds once Rojo has delivered the files) and a real temp
// Rojo project on disk. The sourcemap is generated from that disk
// with the subset of Rojo's sync rules this fixture uses, so the read-back
// check sees the files the build actually wrote; tests/rojo-sourcemap-fixture.mjs
// checks the same layouts against a real `rojo sourcemap`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { RojoIntegration, type PlannedLive, type PlannedNode, type PlannedTop } from '../rojo/index.js';
import { parseInstancePath } from '../rojo/instance-path.js';
import { sourceRevision } from '../rojo/source-revision.js';
import { RobloxStudioTools } from '../tools/index.js';

type Call = { endpoint: string; data: Record<string, unknown> };
type Node = { name: string; className: string; filePaths?: string[]; children?: Node[] };
const body = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0].text!);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const SCRIPT_FILE = /^(.*?)(\.server|\.client)?\.luau$/;

/** A directory as Rojo snapshots it, for the rules this fixture uses. */
function snapshotDir(root: string, dir: string, name: string, legacy: boolean): Node {
  // emitLegacyScripts false makes .client a Script (RunContext Client) rather than a LocalScript.
  const client = legacy ? 'LocalScript' : 'Script';
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const rel = (file: string) => path.relative(root, path.join(dir, file)).split(path.sep).join('/');
  const init = entries.find((entry) => /^init(\.server|\.client)?\.luau$/.test(entry.name));
  const meta = entries.find((entry) => entry.name === 'init.meta.json');
  let className = 'Folder';
  const filePaths: string[] = [];
  if (init) {
    className = init.name.includes('.server') ? 'Script' : init.name.includes('.client') ? client : 'ModuleScript';
    filePaths.push(rel(init.name));
  } else if (meta) {
    className = JSON.parse(fs.readFileSync(path.join(dir, meta.name), 'utf8')).className ?? 'Folder';
    filePaths.push(rel(meta.name));
  }
  const children: Node[] = [];
  for (const entry of entries) {
    if (entry === init || entry === meta) continue;
    if (entry.isDirectory()) children.push(snapshotDir(root, path.join(dir, entry.name), entry.name, legacy));
    else if (entry.name.endsWith('.rbxm')) {
      // This fixture's model files are JSON naming their root's class, standing in for Studio's binary.
      const model = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8')) as { className: string };
      children.push({ name: entry.name.slice(0, -'.rbxm'.length), className: model.className, filePaths: [rel(entry.name)] });
    } else {
      const match = SCRIPT_FILE.exec(entry.name);
      if (!match) continue;
      const fileClass = match[2] === '.server' ? 'Script' : match[2] === '.client' ? client : 'ModuleScript';
      const meta = entries.find((other) => other.name === `${match[1]}.meta.json`);
      children.push({ name: match[1], className: fileClass, filePaths: [rel(entry.name), ...(meta ? [rel(meta.name)] : [])] });
    }
  }
  return { name, className, ...(filePaths.length ? { filePaths } : {}), children };
}

function sourcemapOf(root: string, omit: (node: Node) => boolean = () => false): Node {
  const legacy = JSON.parse(fs.readFileSync(path.join(root, 'default.project.json'), 'utf8')).emitLegacyScripts !== false;
  const prune = (node: Node): Node => ({ ...node, children: (node.children ?? []).filter((child) => !omit(child)).map(prune) });
  return prune({ name: 'Fixture', className: 'DataModel', filePaths: ['default.project.json'], children: [
    snapshotDir(root, path.join(root, 'src'), 'ServerScriptService', legacy),
    { name: 'ReplicatedStorage', className: 'ReplicatedStorage', children: [{ name: 'Inline', className: 'Folder', children: [] }] },
  ] });
}

const PROJECT = {
  name: 'Fixture',
  tree: {
    $className: 'DataModel',
    ServerScriptService: { $path: 'src' },
    ReplicatedStorage: { $className: 'ReplicatedStorage', Inline: { $className: 'Folder' } },
  },
};

const top = (parentPath: string, node: PlannedNode, extra: Partial<PlannedTop> = {}): PlannedTop =>
  ({ parentPath, parentUnique: true, nameTaken: false, node, ...extra });

/** A new tree's model file as this fixture writes it: JSON naming the root's class. */
const fakeRbxm = (className: string) => Buffer.from(JSON.stringify({ className })).toString('base64');

/** The plan with every script-free tree a save would serialize given its fake .rbxm, as the plugin does when asked. */
function serialized(node: PlannedNode, serializable: boolean): PlannedNode {
  const hasScript = (current: PlannedNode): boolean =>
    ['Script', 'LocalScript', 'ModuleScript'].includes(current.className) || (current.children ?? []).some(hasScript);
  const scripts = hasScript(node);
  return {
    ...node,
    ...(serializable && !scripts ? { rbxm: fakeRbxm(node.className) } : {}),
    ...(node.children ? { children: node.children.map((child) => serialized(child, scripts)) } : {}),
  };
}

async function setup(options: {
  tops?: PlannedTop[];
  live?: PlannedLive[];
  liveChanges?: number;
  /** The plan set_properties' planOnly returns. */
  properties?: Record<string, unknown>;
  link?: boolean;
  delivers?: boolean;
  files?: Record<string, string>;
  project?: Record<string, unknown>;
  omit?: (node: Node) => boolean;
} = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer new ')));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'default.project.json'), JSON.stringify(options.project ?? PROJECT));
  fs.writeFileSync(path.join(root, 'src', 'Main.server.luau'), 'print(1)\n');
  for (const [file, text] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  const tops = options.tops ?? [];
  const tools = new RobloxStudioTools(new BridgeService());
  const calls: Call[] = [];
  // Rojo "delivers" a file once it exists on disk: the script then reads back
  // with the file's revision, at the path Rojo's sourcemap gives it.
  const nodeIn = (instancePath: string): Node | undefined => {
    const segments = parseInstancePath(instancePath) ?? [];
    let node: Node | undefined = sourcemapOf(root);
    for (const segment of segments) node = node?.children?.find((child) => child.name === segment);
    return node;
  };
  const scriptAt = (instancePath: string): string | undefined => {
    const file = nodeIn(instancePath)?.filePaths?.find((entry) => entry.endsWith('.luau'));
    return file ? fs.readFileSync(path.join(root, file), 'utf8') : undefined;
  };
  // Before anything is saved, Studio holds what the files held then.
  const delivered = () => options.delivers !== false;
  const studioAt = (instancePath: string) => (delivered() ? nodeIn(instancePath) : initial.get(instancePath));
  const initial = new Map<string, Node | undefined>();
  const answers: Record<string, (data: Record<string, unknown>) => unknown> = {
    '/api/build-instances': (data) => (data.planOnly
      ? {
        planned: true, path: data.path, createdRoot: false,
        added: data.serialize ? tops.map((planned) => ({ ...planned, node: serialized(planned.node, true) })) : tops,
        live: options.live ?? [], liveChanges: options.liveChanges ?? (options.live ?? []).length,
        created: tops.length, cloned: 0, updated: 0, removed: (options.live ?? []).filter((live) => live.op === 'remove').length,
      }
      : { path: data.path, created: tops.length, cloned: 0, updated: 0, removed: 0, undoable: true }),
    '/api/set-properties': (data) => (data.planOnly
      ? { planned: true, ...options.properties }
      : { instancePath: data.instancePath, summary: { total: 1, succeeded: 1, failed: 0 } }),
    '/api/get-script-source': (data) => {
      const text = delivered() ? scriptAt(String(data.instancePath)) : undefined;
      return text === undefined ? { error: `Instance not found: ${data.instancePath}` } : { revision: sourceRevision(text), source: text };
    },
    '/api/instance-properties': (data) => {
      const node = studioAt(String(data.instancePath));
      return node ? { instancePath: data.instancePath, className: node.className, properties: {} } : { error: `Instance not found: ${data.instancePath}` };
    },
  };
  (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
    calls.push({ endpoint, data });
    return answers[endpoint](data);
  };
  (tools as unknown as { _resolveInstanceId: unknown })._resolveInstanceId = () => 'place:1';
  tools.rojo = new RojoIntegration({
    run: async (args) => (args[0] === '--version' ? 'Rojo 7.7.0' : JSON.stringify(sourcemapOf(root, options.omit))),
    ignored: async () => new Set(),
    probe: async () => ({ reachable: false }),
  });
  if (options.link !== false) await tools.manageInstance({ action: 'link_project', project: path.join(root, 'default.project.json') });
  for (const live of options.live ?? []) initial.set(live.path, nodeIn(live.path));
  if (typeof options.properties?.path === 'string') initial.set(options.properties.path, nodeIn(options.properties.path));
  const studioBuilds = () => calls.filter((call) => (call.endpoint === '/api/build-instances' || call.endpoint === '/api/set-properties') && call.data.planOnly !== true);
  const listing = () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else files.push(path.relative(root, full).split(path.sep).join('/'));
      }
    };
    walk(path.join(root, 'src'));
    return files.sort();
  };
  return { tools, calls, root, studioBuilds, listing };
}

const build = (tools: RobloxStudioTools, root = 'game.ServerScriptService') =>
  tools.buildInstances(root, [{ op: 'create', className: 'ModuleScript', name: 'Util' }]).then(body);

describe('new scripts on a Rojo-linked place', () => {
  test('unlinked: the build is the one plugin call it always was', async () => {
    const { tools, calls } = await setup({ link: false });
    await build(tools);
    expect(calls.map((call) => call.endpoint)).toEqual(['/api/build-instances']);
    expect(calls[0].data.planOnly).toBeUndefined();
  });

  test('a new script in a project folder is saved as a file and delivered by Rojo, never built in Studio', async () => {
    const { tools, studioBuilds, listing } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '', id: 'util' })],
    });
    const result = await build(tools);
    expect(listing()).toEqual(['src/Main.server.luau', 'src/Util.luau']);
    expect(result).toMatchObject({
      success: true,
      undoable: false,
      saved: { files: [path.join('src', 'Util.luau')], sync: 'synced' },
      ids: { util: 'game.ServerScriptService.Util' },
    });
    expect(studioBuilds()).toEqual([]);
  });

  test('scripts with children become a folder with an init file, Folders and Models become folders', async () => {
    const { tools, root, listing } = await setup({
      tops: [
        top('game.ServerScriptService', { name: 'Combat', className: 'Folder', children: [
          { name: 'Damage', className: 'Script', runContext: 'Legacy', source: 'print("hit")\r\n', children: [
            { name: 'Config', className: 'ModuleScript', source: 'return {}' },
          ] },
          { name: 'Hud', className: 'LocalScript', runContext: 'Legacy', source: '' },
        ] }),
        top('game.ServerScriptService', { name: 'Npc', className: 'Model', children: [
          { name: 'Brain', className: 'Script', runContext: 'Legacy', source: '' },
        ] }),
      ],
    });
    const result = await build(tools);
    expect(result.saved.sync).toBe('synced');
    expect(listing()).toEqual([
      'src/Combat/Damage/Config.luau',
      'src/Combat/Damage/init.server.luau',
      'src/Combat/Hud.client.luau',
      'src/Main.server.luau',
      'src/Npc/Brain.server.luau',
      'src/Npc/init.meta.json',
    ]);
    // Rojo delivers LF, so the source is saved with LF.
    expect(fs.readFileSync(path.join(root, 'src/Combat/Damage/init.server.luau'), 'utf8')).toBe('print("hit")\n');
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src/Npc/init.meta.json'), 'utf8'))).toEqual({ className: 'Model' });
  });

  test('Rojo not delivering: the files stay saved, sync is pending, Studio is never built', async () => {
    const { tools, studioBuilds, listing } = await setup({
      delivers: false,
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' })],
    });
    const result = await build(tools);
    expect(result.saved).toEqual({
      files: [path.join('src', 'Util.luau')],
      sync: 'pending',
      // What a later read must show for the build to count as delivered.
      scripts: [{ path: 'game.ServerScriptService.Util', revision: sourceRevision('') }],
    });
    expect(result.hint).toMatch(/rojo serve/);
    expect(listing()).toContain('src/Util.luau');
    expect(studioBuilds()).toEqual([]);
  }, 15_000);

  test('a script going somewhere the project has no folder is built in Studio, and says so', async () => {
    const { tools, studioBuilds, listing } = await setup({
      tops: [
        top('game.Workspace', { name: 'Door', className: 'Script', runContext: 'Legacy', source: '' }),
        top('game.ReplicatedStorage.Inline', { name: 'Mod', className: 'ModuleScript', source: '' }),
      ],
    });
    const result = await build(tools, 'game.Workspace');
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistence).toBe('studio_only');
    expect(result.persistenceNote).toMatch(/Workspace is not in the Rojo project/);
    expect(result.persistenceNote).toMatch(/ReplicatedStorage\.Inline is written out in the project file/);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('a build somewhere the project has no folder, with no scripts, is built in Studio with nothing added', async () => {
    let rojoRuns = 0;
    const { tools, studioBuilds } = await setup({
      tops: [top('game.Workspace', { name: 'Marker', className: 'Part' })],
    });
    tools.rojo = Object.assign(tools.rojo, { run: async () => { rojoRuns += 1; throw new Error('rojo is gone'); } });
    const result = await build(tools, 'game.Workspace');
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistence).toBeUndefined();
    expect(result.undoable).toBe(true);
    // Only the project file was read; Rojo itself never ran.
    expect(rojoRuns).toBe(0);
  });

  test('a new model in a project folder is saved as one .rbxm, serialized only once it is known to go there', async () => {
    const { tools, calls, root, studioBuilds, listing } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Marker', className: 'Model', children: [{ name: 'Part', className: 'Part' }] })],
    });
    const result = await build(tools);
    expect(listing()).toEqual(['src/Main.server.luau', 'src/Marker.rbxm']);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src', 'Marker.rbxm'), 'utf8'))).toEqual({ className: 'Model' });
    expect(result).toMatchObject({ success: true, undoable: false, saved: { files: [path.join('src', 'Marker.rbxm')], sync: 'synced' } });
    expect(calls.filter((call) => call.endpoint === '/api/build-instances').map((call) => call.data.serialize === true))
      .toEqual([false, true]);
    expect(studioBuilds()).toEqual([]);
  });

  test('a container of scripts keeps its scripts as files, with its other children as model files', async () => {
    const { tools, root, listing } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Gun', className: 'Tool', children: [
        { name: 'Handle', className: 'Part' },
        { name: 'Fire', className: 'LocalScript', runContext: 'Legacy', source: '' },
      ] })],
    });
    expect((await build(tools)).saved.sync).toBe('synced');
    expect(listing()).toEqual(['src/Gun/Fire.client.luau', 'src/Gun/Handle.rbxm', 'src/Gun/init.meta.json', 'src/Main.server.luau']);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'src/Gun/init.meta.json'), 'utf8'))).toEqual({ className: 'Tool' });
  });

  test('an unreadable project file never blocks a build it has no part in, and says what it could not save', async () => {
    const { tools, studioBuilds, root } = await setup({
      tops: [top('game.Workspace', { name: 'Marker', className: 'Part' })],
    });
    fs.writeFileSync(path.join(root, 'default.project.json'), '{ not json');
    const result = await build(tools, 'game.Workspace');
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistenceNote).toMatch(/default\.project\.json could not be read as JSON, so Marker is not saved to the Rojo project/);
  });

  test('a rollback that cannot take everything back out names what is left, and claims no clean undo', async () => {
    let root = '';
    const { tools, listing } = await setup({
      omit: (node) => {
        // Someone saves into the new folder between the write and the read-back.
        if (node.name === 'Kit' && root) fs.writeFileSync(path.join(root, 'src', 'Kit', 'theirs.txt'), 'keep me');
        return node.name === 'Kit';
      },
      tops: [top('game.ServerScriptService', { name: 'Kit', className: 'Folder', children: [{ name: 'A', className: 'ModuleScript', source: '' }] })],
    }).then((ready) => { root = ready.root; return ready; });
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_unsupported');
    expect(result.leftovers).toEqual([path.join('src', 'Kit')]);
    // A running rojo serve may have carried the change and its undo into Studio, so no clean "nothing changed" is claimed.
    expect(result.error).toMatch(/could not be put back; fix it by hand\. A running rojo serve may already have carried the change/);
    expect(result.studioMayHaveChanged).toBe(true);
    expect(listing()).toEqual(['src/Kit/theirs.txt', 'src/Main.server.luau']);
  });

  test('new scripts mixed with Studio-only changes are refused, nothing changed', async () => {
    const { tools, studioBuilds, listing } = await setup({
      live: [{ op: 'set', path: 'game.Workspace.Door', className: 'Part', uniquePath: true, descendants: 0, scripts: [], properties: ['Color'] }],
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' })],
    });
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_unsupported');
    expect(result.error).toMatch(/send the project changes in a call of their own\. Nothing was changed\.$/);
    expect(studioBuilds()).toEqual([]);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('refuses names and collisions Rojo could not keep apart, nothing written', async () => {
    const cases: Array<[PlannedTop, RegExp, Record<string, string>?]> = [
      [top('game.ServerScriptService', { name: 'Main', className: 'ModuleScript', source: '' }), /already has a child named Main/],
      // On disk only, such as a stale meta file: still a collision.
      [top('game.ServerScriptService', { name: 'Stale', className: 'ModuleScript', source: '' }), /Stale\.meta\.json would collide/, { 'src/Stale.meta.json': '{}' }],
      [top('game.ServerScriptService', { name: 'util', className: 'ModuleScript', source: '' }), /collide/, { 'src/Util/init.luau': '' }],
      [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' }, { nameTaken: true }), /already has a child named Util/],
      [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' }, { parentUnique: false }), /ambiguous/],
      [top('game.ServerScriptService', { name: 'init', className: 'ModuleScript', source: '' }), /init/],
      [top('game.ServerScriptService', { name: 'Tool.server', className: 'ModuleScript', source: '' }), /\.server ending/],
      [top('game.ServerScriptService', { name: 'A/B', className: 'ModuleScript', source: '' }), /character/],
      [top('game.ServerScriptService', { name: 'Tagged', className: 'ModuleScript', source: '', extras: ['tags'] }), /tags that Roqer cannot save/],
      [top('game.ServerScriptService', { name: 'Off', className: 'Script', runContext: 'Legacy', disabled: true, source: '' }), /disabled/],
      [top('game.ServerScriptService', { name: 'Client', className: 'Script', runContext: 'Client', source: '' }), /RunContext Client/],
      // A container of scripts becomes a folder, which cannot carry what was set on it.
      [top('game.ServerScriptService', { name: 'Kit', className: 'Tool', extras: ['properties'], children: [
        { name: 'S', className: 'Script', runContext: 'Legacy', source: '' },
      ] }), /Kit has properties/],
      [top('game.ServerScriptService', { name: 'Big', className: 'Model', rbxmError: 'too large to plan' }), /could not be serialized as a model file: too large/],
    ];
    for (const [planned, pattern, files] of cases) {
      const { tools, studioBuilds, listing } = await setup({ tops: [planned], files });
      const result = await build(tools);
      expect({ name: planned.node.name, code: result.errorCode }).toEqual({ name: planned.node.name, code: 'rojo_unsupported' });
      expect(result.error).toMatch(pattern);
      expect(result.error).toMatch(/Nothing was changed\.$/);
      expect(studioBuilds()).toEqual([]);
      expect(listing()).toEqual(['src/Main.server.luau', ...Object.keys(files ?? {})].sort());
    }
  });

  test('emitLegacyScripts false: a LocalScript is refused and a Script picks its suffix from RunContext', async () => {
    const project = { ...PROJECT, emitLegacyScripts: false };
    const refused = await setup({ project, tops: [top('game.ServerScriptService', { name: 'Hud', className: 'LocalScript', runContext: 'Legacy', source: '' })] });
    expect((await build(refused.tools)).error).toMatch(/emitLegacyScripts/);
    const saved = await setup({ project, tops: [top('game.ServerScriptService', { name: 'Hud', className: 'Script', runContext: 'Client', source: '' })] });
    expect((await build(saved.tools)).saved.files).toEqual([path.join('src', 'Hud.client.luau')]);
  });

  test('a project with syncRules is refused: the file name cannot be known', async () => {
    const { tools, listing } = await setup({
      project: { ...PROJECT, syncRules: [{ pattern: '*.legacy.luau', use: 'legacyServerScript' }] },
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' })],
    });
    expect((await build(tools)).error).toMatch(/syncRules/);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('Rojo not reading the new file as planned takes it back out', async () => {
    const { tools, studioBuilds, listing } = await setup({
      omit: (node) => node.name === 'Util',
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' })],
    });
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_unsupported');
    expect(result.error).toMatch(/^Rojo did not read the project files as planned \(it lists no single ServerScriptService\.Util\), so every file was put back\. A running rojo serve may already have carried the change/);
    expect(result.studioMayHaveChanged).toBe(true);
    expect(listing()).toEqual(['src/Main.server.luau']);
    expect(studioBuilds()).toEqual([]);
  });

  test('a script already on disk under another file mid-batch fails the write and leaves nothing behind', async () => {
    const { tools, root, listing } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Kit', className: 'Folder', children: [
        { name: 'A', className: 'ModuleScript', source: '' },
      ] })],
    });
    // Created between the plan and the write, as an editor saving at that moment would.
    const original = tools.rojo.applyStructure.bind(tools.rojo);
    tools.rojo.applyStructure = async (link, change) => {
      fs.mkdirSync(path.join(root, 'src', 'Kit'));
      fs.writeFileSync(path.join(root, 'src', 'Kit', 'A.luau'), 'mine');
      return original(link, change);
    };
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_write_failed');
    expect(listing()).toEqual(['src/Kit/A.luau', 'src/Main.server.luau']);
    expect(fs.readFileSync(path.join(root, 'src', 'Kit', 'A.luau'), 'utf8')).toBe('mine');
  });
});

const MAIN = 'game.ServerScriptService.Main';
const MAIN_REVISION = sourceRevision('print(1)\n');
const live = (overrides: Partial<PlannedLive> & Pick<PlannedLive, 'op' | 'path' | 'className'>): PlannedLive => ({
  uniquePath: true, descendants: 0, scripts: [], properties: [], ...overrides,
});
const removeMain = () => live({ op: 'remove', path: MAIN, className: 'Script', scripts: [{ path: MAIN, revision: MAIN_REVISION }] });

describe('removals, renames and moves on a Rojo-linked place', () => {
  test('removing a file-backed script deletes its file and meta file, keeps a copy, and Rojo takes it out of Studio', async () => {
    const { tools, root, studioBuilds, listing } = await setup({ live: [removeMain()], files: { 'src/Main.meta.json': '{}' } });
    const result = await build(tools);
    expect(listing()).toEqual([]);
    expect(result).toMatchObject({ success: true, undoable: false, removed: 1, saved: { sync: 'synced' } });
    expect([...result.saved.removed].sort()).toEqual([path.join('src', 'Main.meta.json'), path.join('src', 'Main.server.luau')]);
    expect(fs.readFileSync(path.join(result.saved.backup, 'src', 'Main.server.luau'), 'utf8')).toBe('print(1)\n');
    expect(fs.existsSync(path.join(result.saved.backup, 'src', 'Main.meta.json'))).toBe(true);
    expect(studioBuilds()).toEqual([]);
    fs.rmSync(result.saved.backup, { recursive: true, force: true });
    expect(root).toBeTruthy();
  });

  test('a removal Rojo has not delivered is pending, with the files already gone', async () => {
    const { tools, listing } = await setup({ live: [removeMain()], delivers: false });
    const result = await build(tools);
    expect(result.saved.sync).toBe('pending');
    expect(listing()).toEqual([]);
    fs.rmSync(result.saved.backup, { recursive: true, force: true });
  }, 15_000);

  test('removing a script Studio holds different text for is a conflict, and nothing changes', async () => {
    const { tools, listing, studioBuilds } = await setup({
      live: [live({ op: 'remove', path: MAIN, className: 'Script', scripts: [{ path: MAIN, revision: sourceRevision('print(2)\n') }] })],
    });
    const result = await build(tools);
    expect(result).toMatchObject({ errorCode: 'rojo_conflict', file: path.join('src', 'Main.server.luau') });
    expect(result.error).toMatch(/differ, so nothing was moved or removed/);
    expect(listing()).toEqual(['src/Main.server.luau']);
    expect(studioBuilds()).toEqual([]);
  });

  test('a folder goes with everything in it only when Rojo syncs all of it', async () => {
    const folder = live({ op: 'remove', path: 'game.ServerScriptService.Lib', className: 'Folder', descendants: 1, scripts: [] });
    const refused = await setup({ live: [folder], files: { 'src/Lib/A.luau': 'return 1', 'src/Lib/README.md': 'notes' } });
    const refusal = await build(refused.tools);
    expect(refusal.error).toMatch(/also holds files Rojo does not sync \(src.Lib.README\.md\); move them out first/);
    expect(refused.listing()).toContain('src/Lib/README.md');

    const removed = await setup({ live: [folder], files: { 'src/Lib/A.luau': 'return 1', 'src/Lib/.gitkeep': '' } });
    const result = await build(removed.tools);
    expect(result.saved.removed).toEqual([path.join('src', 'Lib')]);
    expect(removed.listing()).toEqual(['src/Main.server.luau']);
    fs.rmSync(result.saved.backup, { recursive: true, force: true });
  });

  test('something written out in the project file is refused, and a Studio-only instance is removed in Studio', async () => {
    const inline = await setup({ live: [live({ op: 'remove', path: 'game.ReplicatedStorage.Inline', className: 'Folder' })] });
    expect((await build(inline.tools, 'game.ReplicatedStorage')).error).toMatch(/written out in the project file default\.project\.json; change it there/);

    const studio = await setup({ live: [live({ op: 'remove', path: 'game.Workspace.Door', className: 'Part' })] });
    const result = await build(studio.tools, 'game.Workspace');
    expect(studio.studioBuilds()).toHaveLength(1);
    expect(result.persistence).toBeUndefined();
  });

  test('renaming a file-backed script renames its file and meta file, keeping the suffix', async () => {
    const { tools, listing, studioBuilds } = await setup({
      live: [live({ op: 'set', path: MAIN, className: 'Script', name: 'Boot', scripts: [{ path: MAIN, revision: MAIN_REVISION }] })],
      files: { 'src/Main.meta.json': '{}' },
    });
    const result = await build(tools);
    expect(listing()).toEqual(['src/Boot.meta.json', 'src/Boot.server.luau']);
    expect(result.saved.sync).toBe('synced');
    expect([...result.saved.renamed].sort((a: { from: string }, b: { from: string }) => a.from.localeCompare(b.from))).toEqual([
      { from: path.join('src', 'Main.meta.json'), to: path.join('src', 'Boot.meta.json') },
      { from: path.join('src', 'Main.server.luau'), to: path.join('src', 'Boot.server.luau') },
    ]);
    expect(result.saved.backup).toBeUndefined();
    expect(studioBuilds()).toEqual([]);
  });

  test('a rename is refused when it also sets other properties, when Studio holds children the project does not, or when the name would collide', async () => {
    const cases: Array<[PlannedLive, RegExp, Record<string, string>?]> = [
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'Boot', properties: ['Disabled'], scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /rename or move it on its own/],
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'Boot', descendants: 2, scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /holds 2 instance\(s\) only Studio has/],
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'Taken', scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /already has a child named Taken in the Rojo project/, { 'src/Taken.luau': 'return 1' }],
      // On disk only, as a stale meta file: still a collision.
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'Stale', scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /Stale\.meta\.json would collide with Stale/, { 'src/Stale.meta.json': '{}' }],
      // Studio already holds a child by the new name that the project does not.
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'Boot', nameTaken: true, scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /already has a child named Boot in Studio/],
      [live({ op: 'set', path: MAIN, className: 'Script', name: 'init', scripts: [{ path: MAIN, revision: MAIN_REVISION }] }), /cannot be renamed to init/],
    ];
    for (const [planned, pattern, files] of cases) {
      const { tools, listing } = await setup({ live: [planned], files });
      const result = await build(tools);
      expect(result.error).toMatch(pattern);
      expect(listing()).toEqual(['src/Main.server.luau', ...Object.keys(files ?? {})].sort());
    }
  });

  test('a rename Rojo reads back differently is moved back', async () => {
    const { tools, listing } = await setup({
      omit: (node) => node.name === 'Boot',
      live: [live({ op: 'set', path: MAIN, className: 'Script', name: 'Boot', scripts: [{ path: MAIN, revision: MAIN_REVISION }] })],
    });
    const result = await build(tools);
    expect(result.error).toMatch(/it lists no single ServerScriptService\.Boot\), so every file was put back/);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('set_properties moves a file-backed script into another project folder, and refuses a parent with no folder', async () => {
    const moved = await setup({
      files: { 'src/Lib/.gitkeep': '' },
      properties: { path: MAIN, className: 'Script', uniquePath: true, descendants: 0, scripts: [{ path: MAIN, revision: MAIN_REVISION }], parent: 'game.ServerScriptService.Lib', parentUnique: true, properties: [] },
    });
    const result = body(await moved.tools.setProperties(MAIN, { Parent: 'game.ServerScriptService.Lib' }));
    expect(moved.listing()).toEqual(['src/Lib/.gitkeep', 'src/Lib/Main.server.luau']);
    expect(result).toMatchObject({ success: true, instancePath: 'game.ServerScriptService.Lib.Main', instanceRefReplaced: true, saved: { sync: 'synced' } });
    expect(moved.studioBuilds()).toEqual([]);

    const refused = await setup({
      properties: { path: MAIN, className: 'Script', uniquePath: true, descendants: 0, scripts: [{ path: MAIN, revision: MAIN_REVISION }], parent: 'game.Workspace', parentUnique: true, properties: [] },
    });
    const refusal = body(await refused.tools.setProperties(MAIN, { Parent: 'game.Workspace' }));
    expect(refusal.error).toMatch(/cannot move there, since the new parent has no project folder: Workspace is not in the Rojo project/);
    expect(refused.listing()).toEqual(['src/Main.server.luau']);
  });

  test('a property write that is not a rename or move goes to Studio without asking the project', async () => {
    const { tools, calls, studioBuilds } = await setup({ properties: { path: MAIN, className: 'Script', properties: ['Disabled'] } });
    await tools.setProperties(MAIN, { Disabled: true });
    expect(studioBuilds()).toHaveLength(1);
    expect(calls.filter((call) => call.endpoint === '/api/set-properties').map((call) => call.data.planOnly === true)).toEqual([true, false]);
  });

  test('an edit to something the project owns, or to an instance inside a model file, stays in Studio and says so', async () => {
    const { tools, studioBuilds } = await setup({
      files: { 'src/Tree.rbxm': JSON.stringify({ className: 'Model' }) },
      live: [
        live({ op: 'set', path: MAIN, className: 'Script', properties: ['Disabled'] }),
        live({ op: 'set', path: 'game.ServerScriptService.Tree.Leaf', className: 'Part', properties: ['Color'] }),
      ],
    });
    const result = await build(tools);
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistenceNote).toMatch(/Main comes from src.Main\.server\.luau, so property changes to it are not saved to the Rojo project/);
    expect(result.persistenceNote).toMatch(/Tree\.Leaf is inside the model file src.Tree\.rbxm/);
  });
});

describe('what a removal or rename must never take with it', () => {
  test('a removal is refused when Studio holds instances under it the project does not', async () => {
    const { tools, listing } = await setup({ live: [live({ op: 'remove', path: MAIN, className: 'Script', descendants: 2, scripts: [{ path: MAIN, revision: MAIN_REVISION }] })] });
    const result = await build(tools);
    expect(result.error).toMatch(/holds 2 instance\(s\) only Studio has, which the backup of its files would not keep/);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('a file named like the instance that Rojo does not read as it is never taken along', async () => {
    // Rojo reads no file without a type ending, so it is no part of Main and stays.
    const plain = await setup({ live: [removeMain()], files: { 'src/Main': 'notes' } });
    const removed = await build(plain.tools);
    expect(removed.saved.removed).toEqual([path.join('src', 'Main.server.luau')]);
    expect(plain.listing()).toEqual(['src/Main']);
    fs.rmSync(removed.saved.backup, { recursive: true, force: true });

    // A .txt by the same name is a second instance to Rojo (a StringValue Main): refused rather than deleted with it.
    const text = await setup({ live: [removeMain()], files: { 'src/Main.txt': 'notes' } });
    const refused = await build(text.tools);
    expect(refused.error).toMatch(/more than one file or folder in src makes ServerScriptService\.Main, so which is meant is ambiguous/);
    expect(text.listing()).toEqual(['src/Main.server.luau', 'src/Main.txt']);
  });

  test('an instance the project makes twice by one name is refused, never guessed', async () => {
    const { tools, listing } = await setup({
      files: { 'src/Util.luau': 'return 1', 'src/Util.server.luau': 'print(1)' },
      live: [live({ op: 'remove', path: 'game.ServerScriptService.Util', className: 'ModuleScript' })],
    });
    expect((await build(tools)).error).toMatch(/makes more than one instance on the path game\.ServerScriptService\.Util/);
    expect(listing()).toEqual(['src/Main.server.luau', 'src/Util.luau', 'src/Util.server.luau']);
  });

  test('a set that repeats the current name is no rename', async () => {
    const { tools, studioBuilds, listing } = await setup({
      live: [live({ op: 'set', path: MAIN, className: 'Script', name: 'Main', properties: ['Disabled'] })],
    });
    const result = await build(tools);
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistenceNote).toMatch(/property changes to it are not saved/);
    expect(listing()).toEqual(['src/Main.server.luau']);
  });

  test('a Studio read that fails never counts as the instance being gone', async () => {
    const { tools, listing } = await setup({ live: [removeMain()] });
    const original = (tools as unknown as { _callSingle: (endpoint: string, data: Record<string, unknown>) => Promise<unknown> })._callSingle;
    (tools as unknown as { _callSingle: unknown })._callSingle = async (endpoint: string, data: Record<string, unknown>) => {
      if (endpoint === '/api/instance-properties') throw new Error('Studio disconnected');
      return original(endpoint, data);
    };
    const result = await build(tools);
    expect(result.saved.sync).toBe('pending');
    expect(listing()).toEqual([]);
    fs.rmSync(result.saved.backup, { recursive: true, force: true });
  }, 15_000);
});
