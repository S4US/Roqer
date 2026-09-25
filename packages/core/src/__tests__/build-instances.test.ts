import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild, type Plugin } from 'esbuild';
import { BridgeService } from '../bridge-service.js';
import { RobloxStudioTools } from '../tools/index.js';

/**
 * The plugin's build handler, run against a small in-memory stand-in for the
 * DataModel. The stand-in models only what the handler relies on: parenting,
 * cloning, tags, attributes, pivots, and a part's CFrame and Size, which is
 * enough to observe the guarantees that matter — nothing reaches the live tree
 * before every step has been prepared, a failure while applying is rolled
 * back, and every write stays inside the build root.
 */

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

class Vector3 {
  constructor(readonly X = 0, readonly Y = 0, readonly Z = 0) {}
  mul(factor: number) { return new Vector3(this.X * factor, this.Y * factor, this.Z * factor); }
  div(factor: number) { return new Vector3(this.X / factor, this.Y / factor, this.Z / factor); }
}

/** Translation plus Euler orientation: all the handler composes is `position * rotation`. */
class CFrame {
  readonly Position: Vector3;
  constructor(x: number | Vector3 = 0, y = 0, z = 0, readonly orientation: [number, number, number] = [0, 0, 0]) {
    this.Position = x instanceof Vector3 ? x : new Vector3(x, y, z);
  }
  static fromOrientation(x: number, y: number, z: number) { return new CFrame(0, 0, 0, [x, y, z]); }
  get Rotation() { return new CFrame(0, 0, 0, this.orientation); }
  mul(other: CFrame) {
    return new CFrame(
      this.Position.X + other.Position.X, this.Position.Y + other.Position.Y, this.Position.Z + other.Position.Z,
      other.orientation,
    );
  }
  // Tests that read bounds place parts unrotated.
  get RightVector() { return new Vector3(1, 0, 0); }
  get UpVector() { return new Vector3(0, 1, 0); }
  get LookVector() { return new Vector3(0, 0, -1); }
}

const PART_CLASSES = new Set(['Part', 'WedgePart']);
const CREATABLE = new Set(['Model', 'Folder', 'Part', 'WedgePart', 'Script', 'StringValue']);

class FakeInstance {
  Name: string;
  Archivable = true;
  CFrame = new CFrame();
  Size = new Vector3(4, 1, 2);
  Value: unknown = undefined;
  Color: unknown = undefined;
  Material = 'Plastic';
  Anchored = false;
  CanCollide = true;
  CanTouch = true;
  CanQuery = true;
  CastShadow = true;
  destroyed = false;
  pivot = new CFrame();
  scale = 1;
  private parent: FakeInstance | undefined;
  readonly children: FakeInstance[] = [];
  readonly tags = new Set<string>();
  readonly attributes = new Map<string, unknown>();

  constructor(readonly ClassName: string, name?: string) {
    this.Name = name ?? ClassName;
  }

  get Parent() { return this.parent; }
  set Parent(value: FakeInstance | undefined) {
    if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = value;
    if (value) value.children.push(this);
  }

  IsA(name: string) {
    return name === this.ClassName || (name === 'BasePart' && PART_CLASSES.has(this.ClassName));
  }
  IsDescendantOf(ancestor: FakeInstance) {
    for (let current = this.parent; current; current = current.parent) if (current === ancestor) return true;
    return false;
  }
  GetDescendants(): FakeInstance[] {
    return this.children.flatMap((child) => [child, ...child.GetDescendants()]);
  }
  GetChildren(): FakeInstance[] { return [...this.children]; }
  Clone(): FakeInstance | undefined {
    if (!this.Archivable) return undefined;
    const copy = new FakeInstance(this.ClassName, this.Name);
    copy.CFrame = this.CFrame;
    copy.Size = this.Size;
    copy.pivot = this.pivot;
    copy.explicitPivot = this.explicitPivot;
    copy.Value = this.Value;
    copy.Color = this.Color;
    copy.Material = this.Material;
    copy.Anchored = this.Anchored;
    copy.CanCollide = this.CanCollide;
    copy.CanTouch = this.CanTouch;
    copy.CanQuery = this.CanQuery;
    copy.CastShadow = this.CastShadow;
    for (const tag of this.tags) copy.tags.add(tag);
    for (const [name, value] of this.attributes) copy.attributes.set(name, value);
    for (const child of this.children) child.Clone()!.Parent = copy;
    return copy;
  }
  Destroy() { this.Parent = undefined; this.destroyed = true; }
  AddTag(tag: string) { this.tags.add(tag); }
  HasTag(tag: string) { return this.tags.has(tag); }
  RemoveTag(tag: string) { this.tags.delete(tag); }
  SetAttribute(name: string, value: unknown) {
    if (value === undefined) this.attributes.delete(name);
    else this.attributes.set(name, value);
  }
  GetAttribute(name: string) { return this.attributes.get(name); }
  /** Whether anything has set this model's pivot, as opposed to Studio choosing one. */
  explicitPivot = false;
  PivotTo(frame: CFrame) { this.pivot = frame; this.explicitPivot = true; }
  /**
   * A model nobody has pivoted gets Studio's choice: here the centre of its
   * first part, turned like its largest part. That is how the recorded village
   * run's tree template came to have a pivot tilted 45°.
   */
  GetPivot() {
    if (this.ClassName !== 'Model' || this.explicitPivot) return this.pivot;
    const parts = this.GetDescendants().filter((item) => item.IsA('BasePart'));
    if (parts.length === 0) return this.pivot;
    const volume = (part: FakeInstance) => part.Size.X * part.Size.Y * part.Size.Z;
    const largest = parts.reduce((best, part) => volume(part) > volume(best) ? part : best);
    return new CFrame(parts[0].CFrame.Position, 0, 0, largest.CFrame.orientation);
  }
  get WorldPivot() { return this.GetPivot(); }
  set WorldPivot(frame: CFrame) { this.pivot = frame; this.explicitPivot = true; }
  FindFirstChildWhichIsA(className: string, recursive = false) {
    return (recursive ? this.GetDescendants() : this.children).find((item) => item.IsA(className));
  }
  ScaleTo(scale: number) { this.scale = scale; }
  GetScale() { return this.scale; }
}

function createInstance(className: string) {
  if (!CREATABLE.has(className)) throw new Error(`Unable to create an Instance of type "${className}"`);
  return new FakeInstance(className);
}

type World = {
  game: FakeInstance;
  workspace: FakeInstance;
  storage: FakeInstance;
};

function newWorld(): World {
  const game = new FakeInstance('DataModel', 'game');
  const workspace = new FakeInstance('Workspace');
  const storage = new FakeInstance('ServerStorage');
  workspace.Parent = game;
  storage.Parent = game;
  return { game, workspace, storage };
}

function pathOf(instance: FakeInstance): string {
  const names: string[] = [];
  for (let current: FakeInstance | undefined = instance; current && current.ClassName !== 'DataModel'; current = current.Parent) {
    names.unshift(current.Name);
  }
  return ['game', ...names].join('.');
}

function find(world: World, instancePath: string): FakeInstance | undefined {
  const [head, ...segments] = instancePath.split('.');
  if (head !== 'game') return undefined;
  let current: FakeInstance | undefined = world.game;
  for (const segment of segments) current = current?.children.find((child) => child.Name === segment);
  return current;
}

/**
 * The stand-in for Utils.samePropertyValue, with its tolerances for the values
 * these tests write: numbers as Studio stores them (32-bit floats) and vectors
 * component by component. Everything else must match exactly.
 */
function samePropertyValue(actual: unknown, requested: unknown): boolean {
  const sameNumber = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
  if (typeof actual === 'number' && typeof requested === 'number') return sameNumber(actual, requested);
  if (actual instanceof Vector3 && requested instanceof Vector3) {
    return sameNumber(actual.X, requested.X) && sameNumber(actual.Y, requested.Y) && sameNumber(actual.Z, requested.Z);
  }
  return actual === requested;
}

function utilsFor(world: World) {
  return {
    samePropertyValue,
    resolveInstance: (instancePath: string) => find(world, instancePath),
    getInstancePath: pathOf,
    getInstanceReference: (instance: FakeInstance) => `ref:${pathOf(instance)}`,
    convertPropertyValue: (_instance: unknown, _property: string, value: unknown) =>
      Array.isArray(value) && value.length === 3 ? new Vector3(value[0], value[1], value[2]) : value,
    resolveParentAndName: (instancePath: string) => {
      const segments = instancePath.split('.');
      if (segments.length < 3) return {};
      return { parent: find(world, segments.slice(0, -1).join('.')), name: segments[segments.length - 1] };
    },
  };
}

type Recording = { beginRecording: jest.Mock; finishRecording: jest.Mock };
type BuildResult = Record<string, any>;

async function loadBuildHandlers(world: World, recording: Recording, scatterPlanner?: { planScatter: jest.Mock }) {
  const dependencyPlugin: Plugin = {
    name: 'build-instances-dependencies',
    setup(build) {
      if (scatterPlanner) {
        build.onResolve({ filter: /^\.\/ScatterPlanner$/ }, () => ({ path: 'ScatterPlanner', namespace: 'build-instances' }));
      }
      build.onResolve({ filter: /^\.\.\/Utils$/ }, () => ({ path: 'Utils', namespace: 'build-instances' }));
      build.onResolve({ filter: /^\.\.\/Recording$/ }, () => ({ path: 'Recording', namespace: 'build-instances' }));
      build.onLoad({ filter: /.*/, namespace: 'build-instances' }, (args) => ({
        contents: args.path === 'ScatterPlanner' ? 'export default globalThis.__SCATTER_PLANNER__;'
          : args.path === 'Utils'
          ? 'export default globalThis.__BUILD_UTILS__;'
          : 'export default globalThis.__BUILD_RECORDING__;',
        loader: 'js',
      }));
    },
  };
  const built = await esbuildBuild({
    entryPoints: [path.join(repositoryRoot(), 'studio-plugin/src/modules/handlers/BuildHandlers.ts')],
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    logLevel: 'silent',
    plugins: [dependencyPlugin],
  });
  const commonJsModule = { exports: {} as unknown };
  const context = vm.createContext({
    module: commonJsModule,
    exports: commonJsModule.exports,
    __BUILD_UTILS__: utilsFor(world),
    __BUILD_RECORDING__: recording,
    __SCATTER_PLANNER__: scatterPlanner,
    game: world.game,
    Instance: function Instance(className: string) { return createInstance(className); },
    CFrame,
    Vector3,
    math: {
      rad: (degrees: number) => degrees * Math.PI / 180,
      abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, huge: Infinity,
    },
    pcall: (callback: (...args: unknown[]) => unknown) => {
      try {
        return [true, callback()];
      } catch (error) {
        return [false, error];
      }
    },
    pairs: (value: Record<string, unknown>) => Object.entries(value),
    typeIs: (value: unknown, expected: string) => expected === 'table'
      ? value !== null && typeof value === 'object'
      : typeof value === expected,
    tostring: (value: unknown) => String(value),
    error: (message: unknown) => { throw new Error(String(message)); },
  });
  vm.runInContext([
    'Array.prototype.size = function() { return this.length; };',
    'String.prototype.size = function() { return this.length; };',
    // Luau's string.sub: 1-based and inclusive.
    'String.prototype.sub = function(i, j) { return this.slice(i - 1, j === undefined ? this.length : j); };',
  ].join('\n'), context);
  vm.runInContext(built.outputFiles[0].text, context);
  return commonJsModule.exports as { buildInstances: (request: Record<string, unknown>) => BuildResult };
}

function newRecording(): Recording {
  return { beginRecording: jest.fn(() => 'recording-1'), finishRecording: jest.fn() };
}

// The request and every array the stand-in returns are built in this realm, not
// the VM's, so roblox-ts's `size()` has to exist here too while these tests run.
beforeAll(() => {
  Object.defineProperty(Array.prototype, 'size', {
    value: function size(this: unknown[]) { return this.length; },
    configurable: true,
  });
});
afterAll(() => {
  delete (Array.prototype as { size?: unknown }).size;
});

describe('build_instances plugin handler', () => {
  test('scatter atomically replaces only an owned group and rolls back a failed attach', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const template = new FakeInstance('Part', 'Tree');
    template.Parent = world.storage;
    const planner: { planScatter: jest.Mock } = { planScatter: jest.fn(() => ({ requested: 2, attempts: 3, placements: [
      { source: template, position: [4, 5, 6], rotation: [0, 90, 0], scale: 1, kit: 'Tree_A' },
      { source: template, position: [8, 5, 6], rotation: [0, 180, 0], scale: 2, kit: 'Tree_A' },
    ] })) };
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording, planner);
    const scatter = { op: 'scatter', name: 'Trees', seed: 7,
      tags: ['RoqerZone'], attributes: { RoqerZone: 'Cove', RoqerRole: 'decor' } };
    const request = (step: Record<string, unknown>) => handlers.buildInstances({ path: pathOf(root), operations: [step] });
    const first = request(scatter);
    expect(first.error).toBeUndefined();
    expect(first.scatter).toEqual({ requested: 2, placed: 2, attempts: 3 });
    expect(first.cloned).toBe(2);
    const previous = find(world, 'game.Workspace.Map.Trees')!;
    expect(previous.GetAttribute('RoqerScatterVersion')).toBe(1);
    expect(previous.HasTag('RoqerScatter')).toBe(true);
    const child = previous.children[0];
    expect(child.Name).toBe('Item_1');
    expect(child.CFrame.Position).toEqual(new Vector3(4, 5, 6));
    expect(child.GetAttribute('RoqerKit')).toBe('Tree_A');
    expect(child.GetAttribute('RoqerZone')).toBe('Cove');
    expect(request(scatter).error).toContain('already exists');
    expect(find(world, 'game.Workspace.Map.Trees')).toBe(previous);

    // A real setter failure occurs only while attaching the new live group,
    // after the old one has been removed. The old group must return intact.
    const descriptor = Object.getOwnPropertyDescriptor(FakeInstance.prototype, 'Parent')!;
    const setParent = descriptor.set!;
    Object.defineProperty(FakeInstance.prototype, 'Parent', { ...descriptor,
      set(this: FakeInstance, value: FakeInstance | undefined) {
        if (this.Name === 'Trees' && this !== previous && value === root) throw new Error('attach refused');
        setParent.call(this, value);
      },
    });
    try {
      const failed = request({ ...scatter, replace: true });
      expect(failed.error).toContain('attach refused');
      expect(failed.rolledBack).toBe(true);
      expect(root.children).toEqual([previous]);
      expect(previous.children[0]).toBe(child);
      expect(recording.finishRecording).toHaveBeenLastCalledWith('recording-1', false);
    } finally {
      Object.defineProperty(FakeInstance.prototype, 'Parent', descriptor);
    }
    const replaced = request({ ...scatter, replace: true });
    expect(replaced.error).toBeUndefined();
    expect(planner.planScatter.mock.calls.at(-1)?.[2]).toBe(previous);
    expect(replaced.removed).toBe(1);
    expect(previous.Parent).toBeUndefined();
    expect(root.children).toHaveLength(1);
    expect(root.children[0]).not.toBe(previous);
    expect(template.Parent).toBe(world.storage);
    expect(recording.finishRecording).toHaveBeenLastCalledWith('recording-1', true);
  });

  test('scatter refuses engine-clamped scale before replacing existing output', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const existing = new FakeInstance('Model', 'Trees');
    existing.Parent = root;
    existing.AddTag('RoqerScatter');
    existing.SetAttribute('RoqerScatterVersion', 1);
    const template = new FakeInstance('Part', 'Tiny');
    template.Size = new Vector3(1, 0.01, 1);
    template.Parent = world.storage;
    const clone = template.Clone.bind(template);
    template.Clone = () => {
      const result = clone()!;
      let size = result.Size;
      Object.defineProperty(result, 'Size', {
        get: () => size,
        set: (value: Vector3) => { size = new Vector3(value.X, Math.max(0.001, value.Y), value.Z); },
      });
      return result;
    };
    const planner = { planScatter: jest.fn(() => ({ requested: 1, attempts: 1, placements: [
      { source: template, position: [0, 1, 0], rotation: [0, 0, 0], scale: 0.05 },
    ] })) };
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording, planner);
    const result = handlers.buildInstances({ path: pathOf(root), operations: [
      { op: 'scatter', name: 'Trees', seed: 1, replace: true },
    ] });
    expect(result.error).toContain('clamped');
    expect(root.GetChildren()).toEqual([existing]);
    expect(recording.beginRecording).not.toHaveBeenCalled();
  });

  test('scatter refuses unowned/ambiguous groups, mixed steps and invalid decorations before sampling', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const existing = new FakeInstance('Model', 'Trees');
    existing.Parent = root;
    const planner = { planScatter: jest.fn() };
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording, planner);
    const scatter = { op: 'scatter', name: 'Trees', replace: true };
    const run = (operations: Record<string, unknown>[]) => handlers.buildInstances({ path: pathOf(root), operations });
    expect(run([scatter]).error).toContain('owned version 1');
    existing.AddTag('RoqerScatter');
    existing.SetAttribute('RoqerScatterVersion', 1);
    const duplicate = new FakeInstance('Model', 'Trees');
    duplicate.Parent = root;
    expect(run([scatter]).error).toContain('ambiguous');
    expect(run([{ op: 'create', className: 'Part' }, scatter]).error).toContain('only step');
    expect(run([{ ...scatter, name: 'Other', attributes: { nested: {} } }]).error).toContain('must be a string');
    expect(run([{ ...scatter, name: 'Other', properties: { Name: 'Renamed' } }]).error).toContain('not supported');
    expect(planner.planScatter).not.toHaveBeenCalled();
    expect(recording.beginRecording).not.toHaveBeenCalled();
    expect(root.children).toEqual([existing, duplicate]);
  });

  test('shipped world examples persist intent, reuse a kit in a fresh handler, and edit only one zone', async () => {
    // Execute the examples the agent actually receives, so a documentation
    // change cannot silently invent an unsupported batch shape.
    const reference = fs.readFileSync(path.join(repositoryRoot(),
      'apps/desktop/agent/skills/roblox-building/references/world-intent.md'), 'utf8');
    const requests = [...reference.matchAll(/```json\r?\n([\s\S]*?)\r?\n```/g)]
      .map((match) => JSON.parse(match[1]) as Record<string, unknown>);
    expect(requests).toHaveLength(4);
    const world = newWorld();
    const run = async (request: Record<string, unknown>) => {
      // Only the place persists, not the handler's batch IDs or chat context.
      const handlers = await loadBuildHandlers(world, newRecording());
      const result = handlers.buildInstances(request);
      expect(result.error).toBeUndefined();
      return result;
    };
    await run(requests[0]);
    const registry = 'game.ServerStorage.RoqerWorld';
    const readDocument = (name: string) => {
      const instance = find(world, `${registry}.${name}`)!;
      expect(instance.ClassName).toBe('StringValue');
      expect(Buffer.byteLength(String(instance.Value), 'utf8')).toBeLessThan(32 * 1024);
      const document = JSON.parse(String(instance.Value));
      expect(document.schemaVersion).toBe(1);
      return document;
    };
    const spec = readDocument('WorldSpec');
    const kit = readDocument('Kit.Cliff_A');
    const cove = readDocument('Zones.Cove');
    const ridge = readDocument('Zones.Ridge');
    expect(spec.grid).toBeGreaterThan(0);
    expect(spec.verticalStep).toBeGreaterThan(0);
    expect(kit.id).toBe('Cliff_A');
    expect(cove.id).toBe('Cove');
    expect(ridge.id).toBe('Ridge');
    const template = find(world, kit.source.path)!;
    const palette = spec.palette[kit.paletteSlots['.']];
    expect(template.Material).toBe(palette.material);
    expect(template.Color).toEqual(new Vector3(...palette.color as [number, number, number]));
    const originalRegistry = find(world, registry)!.GetDescendants().map((item) => [pathOf(item), item.Value]);

    await run(requests[1]);
    await run(requests[2]);
    const first = find(world, `${spec.buildRoot}.Zone_Cove.Cliff_01`)!;
    const second = find(world, `${spec.buildRoot}.Zone_Ridge.Cliff_01`)!;
    expect(first).not.toBe(second);
    for (const [part, zone] of [[first, cove.id], [second, ridge.id]] as const) {
      expect(part.tags).toEqual(new Set(['RoqerKit', 'RoqerZone', 'RoqerRole']));
      expect(part.GetAttribute('RoqerKit')).toBe(kit.id);
      expect(part.GetAttribute('RoqerZone')).toBe(zone);
      expect(part.GetAttribute('RoqerRole')).toBe('terrain');
      expect(part.Color).toEqual(template.Color);
      expect(part.Material).toBe(template.Material);
      expect(part.Anchored).toBe(true);
      expect(part.Size).toEqual(template.Size);
    }
    const untouchedPosition = second.CFrame;
    const untouchedSize = second.Size;
    await run(requests[3]);
    expect(first.Size).toEqual(new Vector3(32, 12, 32));
    expect(first.CFrame.Position).toEqual(new Vector3(0, 6, 0));
    expect(second.CFrame).toBe(untouchedPosition);
    expect(second.Size).toBe(untouchedSize);
    expect(template.Size).toEqual(new Vector3(32, 8, 32));
    expect(find(world, registry)!.GetDescendants().map((item) => [pathOf(item), item.Value])).toEqual(originalRegistry);

    // Separate-root metadata updates can fail after geometry succeeds. They
    // must not partially rewrite saved intent or undo the verified geometry.
    const handlers = await loadBuildHandlers(world, newRecording());
    const valueBefore = find(world, `${registry}.Zones.Cove`)!.Value;
    const rejected = handlers.buildInstances({ path: registry, operations: [
      { op: 'set', target: `${registry}.Zones.Cove`, properties: {
        Value: JSON.stringify({ ...cove, elevation: 12 }),
      } },
      { op: 'create', className: 'NotARealClass' },
    ] });
    expect(rejected.error).toBeDefined();
    expect(find(world, `${registry}.Zones.Cove`)!.Value).toBe(valueBefore);
    expect(first.Size.Y).toBe(12);
  });

  test('builds a new root, nested models, and placed parts as one committed recording', async () => {
    const world = newWorld();
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording);

    const result = handlers.buildInstances({
      path: 'game.Workspace.Island',
      operations: [
        { op: 'create', id: 'ground', className: 'Folder', name: 'Ground' },
        {
          op: 'create', className: 'Part', name: 'Top', parent: '$ground',
          properties: { Size: [40, 4, 40] }, position: [0, 2, 0],
          tags: ['RoqerRole'], attributes: { zone: 'village', level: 1 },
        },
        { op: 'create', id: 'tree', className: 'Model', name: 'Tree', tags: ['RoqerKit'] },
        { op: 'create', className: 'Part', name: 'Trunk', parent: '$tree', position: [10, 6, 10] },
      ],
    });

    expect(result.error).toBeUndefined();
    const island = find(world, 'game.Workspace.Island')!;
    expect(island.ClassName).toBe('Model');
    const top = find(world, 'game.Workspace.Island.Ground.Top')!;
    expect(top.Size).toEqual(new Vector3(40, 4, 40));
    expect(top.CFrame.Position).toEqual(new Vector3(0, 2, 0));
    expect(top.tags.has('RoqerRole')).toBe(true);
    expect(top.attributes.get('zone')).toBe('village');
    expect(find(world, 'game.Workspace.Island.Tree.Trunk')).toBeDefined();

    expect(recording.beginRecording).toHaveBeenCalledTimes(1);
    expect(recording.finishRecording).toHaveBeenCalledWith('recording-1', true);
    expect(result).toMatchObject({
      path: 'game.Workspace.Island',
      createdRoot: true,
      created: 4,
      cloned: 0,
      updated: 0,
      removed: 0,
      undoable: true,
      descendants: 4,
      classes: { Part: 2, Folder: 1, Model: 1 },
      tags: { RoqerRole: 1, RoqerKit: 1 },
      ids: { ground: 'game.Workspace.Island.Ground', tree: 'game.Workspace.Island.Tree' },
    });
    // The 40x4x40 top at y=2 and the default 4x1x2 trunk at (10, 6, 10).
    expect(result.bounds).toEqual({ min: [-20, 0, -20], max: [20, 6.5, 20], size: [40, 6.5, 40] });
  });

  test('a new root can be named by its own path before it exists', async () => {
    const world = newWorld();
    const handlers = await loadBuildHandlers(world, newRecording());

    const result = handlers.buildInstances({
      path: 'game.Workspace.Island',
      operations: [{ op: 'create', className: 'Part', name: 'Ground', parent: 'game.Workspace.Island' }],
    });

    expect(result.error).toBeUndefined();
    expect(find(world, 'game.Workspace.Island.Ground')).toBeDefined();
  });

  test('clones a template from outside the root once per transform', async () => {
    const world = newWorld();
    const kit = new FakeInstance('Folder', 'Kit');
    kit.Parent = world.storage;
    const template = new FakeInstance('Model', 'Tree_A');
    new FakeInstance('Part', 'Leaves').Parent = template;
    template.Parent = kit;
    const root = new FakeInstance('Model', 'Forest');
    root.Parent = world.workspace;
    const handlers = await loadBuildHandlers(world, newRecording());

    const result = handlers.buildInstances({
      path: 'game.Workspace.Forest',
      operations: [{
        op: 'clone',
        source: 'game.ServerStorage.Kit.Tree_A',
        tags: ['RoqerKit'],
        transforms: [
          { position: [0, 0, 0] },
          { position: [12, 0, 4], rotation: [0, 90, 0], scale: 1.5 },
          { position: [-8, 0, 20] },
        ],
      }],
    });

    expect(result.error).toBeUndefined();
    const trees = root.children;
    expect(trees).toHaveLength(3);
    expect(trees.every((tree) => tree.HasTag('RoqerKit') && tree.children.length === 1)).toBe(true);
    expect(trees[1].pivot.Position).toEqual(new Vector3(12, 0, 4));
    expect(trees[1].pivot.orientation[1]).toBeCloseTo(Math.PI / 2);
    expect(trees[1].scale).toBe(1.5);
    // The template itself is only read.
    expect(template.Parent).toBe(kit);
    expect(template.tags.size).toBe(0);
    expect(result).toMatchObject({ createdRoot: false, cloned: 3, tags: { RoqerKit: 3 }, classes: { Model: 3, Part: 3 } });
  });

  test('a model the batch creates gets an upright pivot, so clone rotation is a turn about vertical', async () => {
    const world = newWorld();
    const handlers = await loadBuildHandlers(world, newRecording());

    // The recorded failure: a diamond canopy turned (45, 0, 45) is the largest
    // part, so Studio's own pivot for the template is tilted 45°, and cloning
    // with rotation [0, 30, 0] stood every canopy square on a leaning trunk.
    const result = handlers.buildInstances({
      path: 'game.Workspace.Village',
      operations: [
        { op: 'create', id: 'tree', className: 'Model', name: 'Tree_B' },
        { op: 'create', className: 'Part', name: 'Trunk', parent: '$tree', position: [0, 3.5, 0], properties: { Size: [1, 7, 1] } },
        { op: 'create', className: 'Part', name: 'Leaves', parent: '$tree', position: [0, 9, 0], rotation: [45, 0, 45], properties: { Size: [6, 6, 6] } },
        { op: 'clone', source: '$tree', name: 'Tree_1', transforms: [{ position: [20, 8, 0], rotation: [0, 30, 0] }] },
        { op: 'create', id: 'pinned', className: 'Model', name: 'Pinned', properties: { WorldPivot: [1, 2, 3] } },
        { op: 'create', className: 'Part', name: 'Base', parent: '$pinned', rotation: [0, 0, 20] },
        { op: 'create', className: 'Model', name: 'EmptyContainer' },
      ],
    });

    expect(result.error).toBeUndefined();
    const template = find(world, 'game.Workspace.Village.Tree_B')!;
    expect(template.explicitPivot).toBe(true);
    // Studio's chosen position is kept; its tilt is not.
    expect(template.pivot.Position).toEqual(new Vector3(0, 3.5, 0));
    expect(template.pivot.orientation).toEqual([0, 0, 0]);
    // The clone copied the settled pivot before it was turned.
    const clone = find(world, 'game.Workspace.Village.Tree_1')!;
    expect(clone.pivot.orientation[0]).toBe(0);
    expect(clone.pivot.orientation[2]).toBe(0);
    expect(clone.pivot.orientation[1]).toBeCloseTo(Math.PI / 6);
    // A pivot the batch set itself, and a model with nothing in it yet, are left alone.
    // (The stand-in converts the written WorldPivot to a Vector3; Studio would make it a CFrame.)
    expect(find(world, 'game.Workspace.Village.Pinned')!.pivot).toEqual(new Vector3(1, 2, 3));
    expect(find(world, 'game.Workspace.Village.EmptyContainer')!.explicitPivot).toBe(false);
  });

  test('updates and removes live instances inside the root', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const gate = new FakeInstance('Part', 'Gate');
    gate.Parent = root;
    const rubble = new FakeInstance('Part', 'Rubble');
    rubble.Parent = root;
    const handlers = await loadBuildHandlers(world, newRecording());

    const result = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: [
        { op: 'set', target: 'game.Workspace.Map.Gate', properties: { Size: [6, 10, 1] }, tags: ['Door'], attributes: { locked: true } },
        { op: 'remove', target: 'game.Workspace.Map.Rubble' },
      ],
    });

    expect(result.error).toBeUndefined();
    expect(gate.Size).toEqual(new Vector3(6, 10, 1));
    expect(gate.HasTag('Door')).toBe(true);
    expect(gate.GetAttribute('locked')).toBe(true);
    // Removed by unparenting, which is what lets undo restore it.
    expect(rubble.Parent).toBeUndefined();
    expect(rubble.destroyed).toBe(false);
    expect(result).toMatchObject({ updated: 1, removed: 1, descendants: 1 });
  });

  test('a bad step changes nothing: no recording, no live writes, and made instances destroyed', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const gate = new FakeInstance('Part', 'Gate');
    gate.Parent = root;
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording);

    const result = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: [
        { op: 'create', className: 'Part', name: 'Wall' },
        { op: 'set', target: 'game.Workspace.Map.Gate', tags: ['Door'] },
        { op: 'create', className: 'NotARealClass' },
      ],
    });

    expect(result.error).toContain('step 3 (create)');
    expect(result.error).toContain('Nothing was changed.');
    expect(root.children).toEqual([gate]);
    expect(gate.HasTag('Door')).toBe(false);
    expect(recording.beginRecording).not.toHaveBeenCalled();
  });

  test('a failure while applying rolls back every applied change and cancels the recording', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const rubble = new FakeInstance('Part', 'Rubble');
    rubble.Parent = root;
    const sign = new FakeInstance('StringValue', 'Sign');
    sign.Value = 'old';
    sign.Parent = root;
    const stubborn = new FakeInstance('StringValue', 'Stubborn');
    stubborn.Parent = root;
    // Accepts the value during preparation's read, then refuses the write.
    Object.defineProperty(stubborn, 'Value', {
      get: () => 'fixed',
      set: () => { throw new Error('write denied'); },
    });
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording);

    const result = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: [
        { op: 'create', className: 'Part', name: 'Wall' },
        { op: 'remove', target: 'game.Workspace.Map.Rubble' },
        { op: 'set', target: 'game.Workspace.Map.Sign', properties: { Value: 'new' } },
        { op: 'set', target: 'game.Workspace.Map.Stubborn', properties: { Value: 'other' } },
      ],
    });

    expect(result.error).toContain('Applying the build failed');
    expect(result.rolledBack).toBe(true);
    expect(root.children.map((child) => child.Name).sort()).toEqual(['Rubble', 'Sign', 'Stubborn']);
    expect(sign.Value).toBe('old');
    expect(recording.finishRecording).toHaveBeenCalledWith('recording-1', false);
  });

  test('every parent and target must be inside the root', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const outside = new FakeInstance('Part', 'Baseplate');
    outside.Parent = world.workspace;
    const handlers = await loadBuildHandlers(world, newRecording());
    const attempt = (operations: unknown[], buildPath = 'game.Workspace.Map') =>
      handlers.buildInstances({ path: buildPath, operations });

    expect(attempt([{ op: 'create', className: 'Part', parent: 'game.Workspace' }]).error)
      .toContain('outside the build root');
    expect(attempt([{ op: 'remove', target: 'game.Workspace.Baseplate' }]).error)
      .toContain('outside the build root');
    expect(attempt([{ op: 'set', target: 'game.Workspace.Baseplate', properties: { Name: 'x' } }]).error)
      .toContain('outside the build root');
    expect(attempt([{ op: 'remove', target: 'game.Workspace.Map' }]).error).toContain('root itself');
    expect(attempt([{ op: 'create', className: 'Part' }], 'game.Workspace').error).toContain('is a service');
    expect(outside.Parent).toBe(world.workspace);
  });

  test('refuses script source, unknown ids, reused ids, and building into a removed instance', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    new FakeInstance('Folder', 'Old').Parent = root;
    const handlers = await loadBuildHandlers(world, newRecording());
    const attempt = (operations: unknown[]) => handlers.buildInstances({ path: 'game.Workspace.Map', operations });

    expect(attempt([{ op: 'create', className: 'Script', properties: { Source: 'print(1)' } }]).error)
      .toContain('Source cannot be set here');
    expect(attempt([{ op: 'create', className: 'Part', parent: '$missing' }]).error)
      .toContain('names no earlier step');
    expect(attempt([
      { op: 'create', id: 'a', className: 'Part' },
      { op: 'create', id: 'a', className: 'Part' },
    ]).error).toContain('already used');
    expect(attempt([
      { op: 'remove', target: 'game.Workspace.Map.Old' },
      { op: 'create', className: 'Part', parent: 'game.Workspace.Map.Old' },
    ]).error).toContain('removed earlier in this batch');
    expect(attempt([{ op: 'clone', id: 'x', source: 'game.Workspace.Map.Old', transforms: [{}, {}] }]).error)
      .toContain('give an id only to a single clone');
    expect(root.children.map((child) => child.Name)).toEqual(['Old']);
  });

  test('a number stored as a 32-bit float still counts as the value written', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const glass = new FakeInstance('Part', 'Glass');
    glass.Parent = root;
    let stored = 0;
    Object.defineProperty(glass, 'Transparency', {
      get: () => stored,
      set: (value: number) => { stored = Math.fround(value); },
    });
    const handlers = await loadBuildHandlers(world, newRecording());

    const result = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: [{ op: 'set', target: 'game.Workspace.Map.Glass', properties: { Transparency: 0.3 } }],
    });

    expect(result.error).toBeUndefined();
    expect(stored).toBe(Math.fround(0.3));
  });

  test('refuses an oversized batch before anything reaches the live tree', async () => {
    const world = newWorld();
    const root = new FakeInstance('Model', 'Map');
    root.Parent = world.workspace;
    const template = new FakeInstance('Part', 'Stone');
    template.Parent = world.storage;
    const recording = newRecording();
    const handlers = await loadBuildHandlers(world, recording);

    const tooManySteps = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: Array.from({ length: 501 }, () => ({ op: 'create', className: 'Part' })),
    });
    expect(tooManySteps.error).toContain('at most 500 operations');

    const tooManyInstances = handlers.buildInstances({
      path: 'game.Workspace.Map',
      operations: [{ op: 'clone', source: 'game.ServerStorage.Stone', transforms: Array.from({ length: 2001 }, () => ({})) }],
    });
    expect(tooManyInstances.error).toContain('at most 2000 instances');
    expect(root.children).toHaveLength(0);
    expect(recording.beginRecording).not.toHaveBeenCalled();
  });
});

describe('build_instances host routing', () => {
  test('forwards the batch to the selected Studio instance', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const call = jest.spyOn(tools as any, '_callSingle').mockResolvedValue({ created: 1 });

    const result = await tools.buildInstances('game.Workspace.Island', [{ op: 'create', className: 'Part' }], 'studio-2');

    expect(call).toHaveBeenCalledWith(
      '/api/build-instances',
      { path: 'game.Workspace.Island', operations: [{ op: 'create', className: 'Part' }] },
      undefined,
      'studio-2',
    );
    expect(JSON.parse(result.content[0].text)).toEqual({ created: 1 });
  });

  test('rejects a malformed envelope without reaching Studio', async () => {
    const tools = new RobloxStudioTools(new BridgeService());
    const call = jest.spyOn(tools as any, '_callSingle');

    await expect(tools.buildInstances('', [{ op: 'create' }])).rejects.toThrow('path');
    await expect(tools.buildInstances('game.Workspace.X', [])).rejects.toThrow('non-empty array');
    await expect(tools.buildInstances('game.Workspace.X', { op: 'create' })).rejects.toThrow('non-empty array');
    await expect(tools.buildInstances('game.Workspace.X', Array.from({ length: 501 }, () => ({ op: 'create' }))))
      .rejects.toThrow('at most 500');
    expect(call).not.toHaveBeenCalled();
  });
});
