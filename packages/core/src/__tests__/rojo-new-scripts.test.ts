// New scripts built on a Rojo-linked place: build_instances with Studio faked
// at the plugin boundary (the plan the plugin's planOnly mode returns) and a
// real temp Rojo project on disk. The sourcemap is generated from that disk
// with the subset of Rojo's sync rules this fixture uses, so the read-back
// check sees the files the build actually wrote; tests/rojo-sourcemap-fixture.mjs
// checks the same layouts against a real `rojo sourcemap`.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { RojoIntegration, type PlannedNode, type PlannedTop } from '../rojo/index.js';
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
    else {
      const match = SCRIPT_FILE.exec(entry.name);
      if (!match) continue;
      const fileClass = match[2] === '.server' ? 'Script' : match[2] === '.client' ? client : 'ModuleScript';
      children.push({ name: match[1], className: fileClass, filePaths: [rel(entry.name)] });
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

async function setup(options: {
  tops?: PlannedTop[];
  liveChanges?: number;
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
  const scriptAt = (instancePath: string): string | undefined => {
    const segments = instancePath.replace(/^game\./, '').split('.');
    let node: Node | undefined = sourcemapOf(root);
    for (const segment of segments) node = node?.children?.find((child) => child.name === segment);
    const file = node?.filePaths?.find((entry) => entry.endsWith('.luau'));
    return file ? fs.readFileSync(path.join(root, file), 'utf8') : undefined;
  };
  const answers: Record<string, (data: Record<string, unknown>) => unknown> = {
    '/api/build-instances': (data) => (data.planOnly
      ? { planned: true, path: data.path, createdRoot: false, added: tops, liveChanges: options.liveChanges ?? 0, created: tops.length, cloned: 0, updated: 0, removed: 0 }
      : { path: data.path, created: tops.length, cloned: 0, updated: 0, removed: 0, undoable: true }),
    '/api/get-script-source': (data) => {
      const text = options.delivers === false ? undefined : scriptAt(String(data.instancePath));
      return text === undefined ? { error: `Instance not found: ${data.instancePath}` } : { revision: sourceRevision(text), source: text };
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
  const studioBuilds = () => calls.filter((call) => call.endpoint === '/api/build-instances' && call.data.planOnly !== true);
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

  test('a batch with no scripts is built in Studio with nothing added', async () => {
    const { tools, studioBuilds } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Marker', className: 'Part' })],
    });
    const result = await build(tools);
    expect(studioBuilds()).toHaveLength(1);
    expect(result.persistence).toBeUndefined();
    expect(result.undoable).toBe(true);
  });

  test('a batch with no new scripts never asks Rojo, so a broken project cannot block it', async () => {
    const { tools, studioBuilds, root } = await setup({
      tops: [top('game.ServerScriptService', { name: 'Marker', className: 'Part' })],
    });
    fs.writeFileSync(path.join(root, 'default.project.json'), '{ not json');
    let rojoRuns = 0;
    tools.rojo = Object.assign(tools.rojo, { run: async () => { rojoRuns += 1; throw new Error('rojo is gone'); } });
    const result = await build(tools);
    expect(result.undoable).toBe(true);
    expect(studioBuilds()).toHaveLength(1);
    expect(rojoRuns).toBe(0);
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
    expect(result.error).toMatch(/could not be taken back out; delete it by hand\. Nothing was changed in Studio\.$/);
    expect(listing()).toEqual(['src/Kit/theirs.txt', 'src/Main.server.luau']);
  });

  test('new scripts mixed with Studio-only changes are refused, nothing changed', async () => {
    const { tools, studioBuilds, listing } = await setup({
      liveChanges: 1,
      tops: [top('game.ServerScriptService', { name: 'Util', className: 'ModuleScript', source: '' })],
    });
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_unsupported');
    expect(result.error).toMatch(/build_instances call of their own\. Nothing was changed\.$/);
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
      [top('game.ServerScriptService', { name: 'Kit', className: 'Folder', children: [
        { name: 'Part', className: 'Part' }, { name: 'S', className: 'Script', runContext: 'Legacy', source: '' },
      ] }), /Kit\.Part is a Part/],
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
    expect(result.error).toBe('Rojo did not read the new files as planned (it lists no single ServerScriptService.Util), so the new files were taken back out. Nothing was changed.');
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
    const original = tools.rojo.saveNew.bind(tools.rojo);
    tools.rojo.saveNew = async (link, placements) => {
      fs.mkdirSync(path.join(root, 'src', 'Kit'));
      fs.writeFileSync(path.join(root, 'src', 'Kit', 'A.luau'), 'mine');
      return original(link, placements);
    };
    const result = await build(tools);
    expect(result.errorCode).toBe('rojo_write_failed');
    expect(listing()).toEqual(['src/Kit/A.luau', 'src/Main.server.luau']);
    expect(fs.readFileSync(path.join(root, 'src', 'Kit', 'A.luau'), 'utf8')).toBe('mine');
  });
});
