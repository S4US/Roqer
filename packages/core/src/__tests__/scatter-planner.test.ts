import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { build as esbuildBuild } from 'esbuild';

// Execute the actual plugin planner. The engine stand-in provides oriented
// bounds and vertical ray/plane intersections, so geometry assertions are
// independent of the planner's placement and collision calculations.
class Vector3 {
  constructor(readonly X = 0, readonly Y = 0, readonly Z = 0) {}
  add(v: Vector3) { return new Vector3(this.X + v.X, this.Y + v.Y, this.Z + v.Z); }
  sub(v: Vector3) { return new Vector3(this.X - v.X, this.Y - v.Y, this.Z - v.Z); }
  mul(n: number) { return new Vector3(this.X * n, this.Y * n, this.Z * n); }
  div(n: number) { return this.mul(1 / n); }
  Dot(v: Vector3) { return this.X * v.X + this.Y * v.Y + this.Z * v.Z; }
  get Magnitude() { return Math.sqrt(this.Dot(this)); }
  get Unit() { return this.div(this.Magnitude); }
}

type Matrix = [number, number, number, number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 0, 1, 0, 0, 0, 1];

class CFrame {
  readonly Position: Vector3;
  constructor(x: number | Vector3 = 0, y = 0, z = 0, readonly matrix: Matrix = IDENTITY) {
    this.Position = x instanceof Vector3 ? x : new Vector3(x, y, z);
  }
  static fromOrientation(x: number, y: number, z: number) {
    const [cx, sx, cy, sy, cz, sz] = [Math.cos(x), Math.sin(x), Math.cos(y), Math.sin(y), Math.cos(z), Math.sin(z)];
    // Roblox uses YXZ orientation.
    return new CFrame(0, 0, 0, [cy * cz + sy * sx * sz, -cy * sz + sy * sx * cz, sy * cx,
      cx * sz, cx * cz, -sx, -sy * cz + cy * sx * sz, sy * sz + cy * sx * cz, cy * cx]);
  }
  static Angles(x: number, y: number, z: number) { return CFrame.fromOrientation(x, y, z); }
  get Rotation() { return new CFrame(0, 0, 0, this.matrix); }
  get RightVector() { return new Vector3(this.matrix[0], this.matrix[3], this.matrix[6]); }
  get UpVector() { return new Vector3(this.matrix[1], this.matrix[4], this.matrix[7]); }
  get LookVector() { return new Vector3(-this.matrix[2], -this.matrix[5], -this.matrix[8]); }
  VectorToWorldSpace(v: Vector3) {
    const m = this.matrix;
    return new Vector3(m[0] * v.X + m[1] * v.Y + m[2] * v.Z,
      m[3] * v.X + m[4] * v.Y + m[5] * v.Z, m[6] * v.X + m[7] * v.Y + m[8] * v.Z);
  }
  PointToWorldSpace(v: Vector3) { return this.Position.add(this.VectorToWorldSpace(v)); }
  PointToObjectSpace(v: Vector3) {
    const d = v.sub(this.Position);
    return new Vector3(d.Dot(this.RightVector), d.Dot(this.UpVector), -d.Dot(this.LookVector));
  }
  mul(other: CFrame | Vector3): CFrame | Vector3 {
    if (other instanceof Vector3) return this.PointToWorldSpace(other);
    const matrix = this.matrix.map((_v, index) => {
      const row = Math.floor(index / 3), col = index % 3;
      return [0, 1, 2].reduce((sum, k) => sum + this.matrix[row * 3 + k] * other.matrix[k * 3 + col], 0);
    }) as Matrix;
    return new CFrame(this.PointToWorldSpace(other.Position), 0, 0, matrix);
  }
  ToObjectSpace(other: CFrame) {
    const m = this.matrix;
    const inverse = new CFrame(0, 0, 0, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    return new CFrame(this.PointToObjectSpace(other.Position), 0, 0, (inverse.mul(other.Rotation) as CFrame).matrix);
  }
}

class FakeInstance {
  Parent?: FakeInstance;
  Archivable = true;
  CanQuery = true;
  CFrame = new CFrame();
  Size = new Vector3(2, 4, 2);
  readonly children: FakeInstance[] = [];
  readonly tags = new Set<string>();
  constructor(readonly ClassName: string, readonly Name: string, parent?: FakeInstance) {
    this.Parent = parent;
    parent?.children.push(this);
  }
  IsA(name: string) { return name === this.ClassName || (name === 'BasePart' && this.ClassName === 'Part'); }
  IsDescendantOf(ancestor: FakeInstance): boolean {
    return this.Parent === ancestor || (this.Parent?.IsDescendantOf(ancestor) ?? false);
  }
  GetDescendants(): FakeInstance[] { return this.children.flatMap((child) => [child, ...child.GetDescendants()]); }
  GetChildren() { return this.children; }
  GetFullName(): string { return this.Parent ? `${this.Parent.GetFullName()}.${this.Name}` : this.Name; }
  GetPivot() { return this.CFrame; }
  GetBoundingBox(): [CFrame, Vector3] { return [this.CFrame, this.Size]; }
  GetScale() { return 1; }
  HasTag(tag: string) { return this.tags.has(tag); }
}

class RaycastParams {
  FilterType = 'Include';
  FilterDescendantsInstances: FakeInstance[] = [];
  IgnoreWater = false;
  RespectCanCollide = false;
}

function fixture() {
  const game = new FakeInstance('DataModel', 'game');
  const workspace = new FakeInstance('Workspace', 'Workspace', game);
  const storage = new FakeInstance('ServerStorage', 'ServerStorage', game);
  const tree = new FakeInstance('Part', 'Tree', storage);
  const rock = new FakeInstance('Part', 'Rock', storage);
  const ground = new FakeInstance('Part', 'Ground', workspace);
  ground.Size = new Vector3(1000, 2, 1000);
  const tagged: FakeInstance[] = [];
  const raycasts: Array<{ origin: Vector3; direction: Vector3; params: RaycastParams }> = [];
  let plane = { height: 0, dx: 0, dz: 0, missing: false };
  const Raycast = (origin: Vector3, direction: Vector3, params: RaycastParams) => {
    raycasts.push({ origin, direction, params });
    if (plane.missing || !params.FilterDescendantsInstances.some((item) => ground === item || ground.IsDescendantOf(item))) return undefined;
    const height = plane.height + plane.dx * origin.X + plane.dz * origin.Z;
    const t = (height - origin.Y) / direction.Y;
    if (t < 0 || t > 1 || Math.abs(origin.X) > ground.Size.X / 2 || Math.abs(origin.Z) > ground.Size.Z / 2) return undefined;
    return { Position: new Vector3(origin.X, height, origin.Z), Normal: new Vector3(-plane.dx, 1, -plane.dz).Unit, Instance: ground };
  };
  Object.assign(workspace, { Raycast });
  const collection = { GetTagged: (tag: string) => tagged.filter((instance) => instance.tags.has(tag)) };
  Object.assign(game, { GetService: (name: string) => name === 'Workspace' ? workspace : name === 'CollectionService' ? collection : undefined });
  const resolve = (instancePath: string) => {
    const found = [game, ...game.GetDescendants()].find((instance) => instance.GetFullName() === instancePath);
    if (!found) throw new Error(`not found: ${instancePath}`);
    return found;
  };
  return { game, workspace, storage, tree, rock, ground, tagged, raycasts, resolve,
    setPlane: (value: Partial<typeof plane>) => { plane = { ...plane, ...value }; } };
}

type Placement = { source: FakeInstance; position: [number, number, number]; rotation: [number, number, number]; scale: number; kit?: string };
type Plan = { placements: Placement[]; requested: number; attempts: number };
type Planner = (step: Record<string, unknown>, resolve: (path: string) => FakeInstance, excluded?: FakeInstance) => Plan;
let bundledPlanner: string;

beforeAll(async () => {
  Object.defineProperty(Array.prototype, 'size', { value: function size(this: unknown[]) { return this.length; }, configurable: true });
  Object.defineProperty(String.prototype, 'size', { value: function size(this: string) { return this.length; }, configurable: true });
  Object.defineProperty(String.prototype, 'sub', { value: function sub(this: string, from: number, to?: number) { return this.slice(from - 1, to); }, configurable: true });
  const root = fs.existsSync(path.join(process.cwd(), 'studio-plugin')) ? process.cwd() : path.resolve(process.cwd(), '../..');
  const built = await esbuildBuild({ entryPoints: [path.join(root, 'studio-plugin/src/modules/handlers/ScatterPlanner.ts')],
    bundle: true, write: false, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  bundledPlanner = built.outputFiles[0].text;
});
afterAll(() => {
  delete (Array.prototype as { size?: unknown }).size;
  delete (String.prototype as { size?: unknown }).size;
  delete (String.prototype as { sub?: unknown }).sub;
});

function loadPlanner(world: ReturnType<typeof fixture>): Planner {
  const commonJsModule = { exports: {} as { default?: { planScatter: Planner } } };
  const context = vm.createContext({ module: commonJsModule, exports: commonJsModule.exports,
    game: world.game, workspace: world.workspace, Vector3, CFrame, RaycastParams,
    Enum: { RaycastFilterType: { Include: 'Include', Exclude: 'Exclude' } },
    math: { abs: Math.abs, min: Math.min, max: Math.max, floor: Math.floor, ceil: Math.ceil,
      sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, acos: Math.acos, pi: Math.PI, huge: Infinity,
      rad: (n: number) => n * Math.PI / 180, deg: (n: number) => n * 180 / Math.PI,
      clamp: (n: number, min: number, max: number) => Math.min(max, Math.max(min, n)) },
    typeIs: (value: unknown, expected: string) => expected === 'table' ? value !== null && typeof value === 'object' : typeof value === expected,
    pairs: (value: Record<string, unknown>) => Object.entries(value).map(([key, item]) => [Array.isArray(value) && /^\d+$/.test(key) ? Number(key) + 1 : key, item]), tostring: String,
    error: (message: unknown) => { throw new Error(String(message)); },
  });
  vm.runInContext('Array.prototype.size = function() { return this.length; }; String.prototype.size = function() { return this.length; }; String.prototype.sub = function(i, j) { return this.slice(i - 1, j); };', context);
  vm.runInContext(bundledPlanner, context);
  return commonJsModule.exports.default!.planScatter;
}

function request(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { zone: { min: [-100, -100], max: [100, 100] }, density: 37.5, seed: 421,
    templates: [{ source: 'game.ServerStorage.Tree', weight: 1, kit: 'Tree_A' }],
    ground: ['game.Workspace.Ground'], raycast: { top: 100, bottom: -100 }, ...overrides };
}

function summary(plan: Plan) {
  return plan.placements.map((p) => ({ source: p.source.Name, position: p.position, rotation: p.rotation, scale: p.scale, kit: p.kit }));
}

describe('deterministic scatter planner', () => {
  test('places exactly 150 templates, reproduces transforms across fresh planners, and changes with the seed', () => {
    const world = fixture();
    const first = loadPlanner(world)(request(), world.resolve);
    const again = loadPlanner(world)(request(), world.resolve);
    const changed = loadPlanner(world)(request({ seed: 422 }), world.resolve);
    expect(first.requested).toBe(150);
    expect(first.placements).toHaveLength(150);
    expect(summary(again)).toEqual(summary(first));
    expect(summary(changed)).not.toEqual(summary(first));
    expect(first.attempts).toBeLessThanOrEqual(3000);
    expect(world.storage.GetChildren()).toEqual([world.tree, world.rock]);
    expect(world.workspace.GetChildren()).toEqual([world.ground]);
  });

  test('weights influence template choice while carrying kit identity and bounded yaw and scale', () => {
    const world = fixture();
    const plan = loadPlanner(world)(request({ templates: [
      { source: world.tree.GetFullName(), weight: 1, kit: 'Tree_A' },
      { source: world.rock.GetFullName(), weight: 9, kit: 'Rock_B' },
    ], rotation: [-40, 75], scale: [0.5, 2] }), world.resolve);
    const rocks = plan.placements.filter((p) => p.source === world.rock);
    expect(rocks.length).toBeGreaterThan(110);
    expect(rocks.length).toBeLessThan(150);
    expect(new Set(plan.placements.map((p) => p.scale)).size).toBeGreaterThan(100);
    for (const p of plan.placements) {
      expect(p.kit).toBe(p.source === world.tree ? 'Tree_A' : 'Rock_B');
      expect(p.rotation[0]).toBe(0);
      expect(p.rotation[2]).toBe(0);
      expect(p.rotation[1]).toBeGreaterThanOrEqual(-40);
      expect(p.rotation[1]).toBeLessThanOrEqual(75);
      expect(p.scale).toBeGreaterThanOrEqual(0.5);
      expect(p.scale).toBeLessThanOrEqual(2);
    }
  });

  test('keeps every rotated and scaled corner inside the zone and grounds each template bottom', () => {
    const world = fixture();
    world.tree.Size = new Vector3(12, 9, 3);
    world.setPlane({ height: 14 });
    const plan = loadPlanner(world)(request({ density: 5, scale: [0.75, 1.5] }), world.resolve);
    for (const p of plan.placements) {
      const frame = new CFrame(...p.position).mul(CFrame.fromOrientation(0, p.rotation[1] * Math.PI / 180, 0)) as CFrame;
      let bottom = Infinity;
      for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
        const corner = frame.PointToWorldSpace(new Vector3(x * 6, y * 4.5, z * 1.5).mul(p.scale));
        expect(corner.X).toBeGreaterThanOrEqual(-100);
        expect(corner.X).toBeLessThanOrEqual(100);
        expect(corner.Z).toBeGreaterThanOrEqual(-100);
        expect(corner.Z).toBeLessThanOrEqual(100);
        bottom = Math.min(bottom, corner.Y);
      }
      expect(bottom).toBeCloseTo(14, 10);
    }
    expect(world.raycasts.length).toBeGreaterThan(0);
    for (const ray of world.raycasts) {
      expect(ray.origin.Y).toBe(100);
      expect(ray.direction).toEqual(new Vector3(0, -200, 0));
      expect(ray.params.FilterType).toBe('Include');
      expect(ray.params.FilterDescendantsInstances).toEqual([world.ground]);
    }
  });

  test('uses actual model part bounds relative to an offset pivot when grounding and containing the model', () => {
    const world = fixture();
    const model = new FakeInstance('Model', 'OffsetTree', world.storage);
    model.CFrame = new CFrame(40, 20, 80);
    const trunk = new FakeInstance('Part', 'Trunk', model);
    trunk.CFrame = new CFrame(46, 25, 80);
    trunk.Size = new Vector3(4, 10, 2);
    const plan = loadPlanner(world)(request({ density: 2, scale: [2, 2],
      templates: [{ source: model.GetFullName(), weight: 1 }], rotation: [90, 90] }), world.resolve);
    for (const p of plan.placements) {
      expect(p.position[1]).toBeCloseTo(0);
      // The model's pivot is at its bottom, six studs to one side of its trunk.
      const frame = new CFrame(...p.position).mul(CFrame.fromOrientation(0, Math.PI / 2, 0)) as CFrame;
      const trunkCenter = frame.PointToWorldSpace(new Vector3(12, 10, 0));
      expect(trunkCenter.Y - 10).toBeCloseTo(0);
      expect(Math.abs(trunkCenter.X) + 2).toBeLessThanOrEqual(100);
      expect(Math.abs(trunkCenter.Z) + 4).toBeLessThanOrEqual(100);
    }
  });

  test('rejects missing, out-of-ray-range, or over-slope ground and accepts the configured slope', () => {
    const world = fixture();
    const planner = loadPlanner(world);
    const small = request({ density: 0.25 });
    world.setPlane({ missing: true });
    expect(() => planner(small, world.resolve)).toThrow(/no valid placements/);
    world.setPlane({ missing: false, height: 101 });
    expect(() => planner(small, world.resolve)).toThrow(/no valid placements/);
    world.setPlane({ height: 0, dx: 1 });
    expect(() => planner(small, world.resolve)).toThrow(/no valid placements/);
    expect(planner({ ...small, maxSlope: 50 }, world.resolve).placements).toHaveLength(1);
  });

  test('avoids wide rotated tagged footprints with clearance, regardless of tag enumeration order', () => {
    const world = fixture();
    const road = new FakeInstance('Part', 'Road', world.workspace);
    road.Size = new Vector3(8, 2, 130);
    road.CFrame = CFrame.fromOrientation(0, Math.PI / 4, 0);
    road.tags.add('Road');
    const building = new FakeInstance('Model', 'Building', world.workspace);
    building.CFrame = new CFrame(70, 0, 70);
    building.Size = new Vector3(20, 40, 20);
    building.tags.add('Road');
    world.tagged.push(road, building);
    const step = request({ avoid: [{ tag: 'Road', distance: 5 }], spacing: 2 });
    const plan = loadPlanner(world)(step, world.resolve);
    world.tagged.reverse();
    expect(summary(loadPlanner(world)(step, world.resolve))).toEqual(summary(plan));
    const extent = (8 + 130) / (2 * Math.sqrt(2));
    for (const p of plan.placements) {
      const [x, , z] = p.position;
      const dx = Math.max(Math.abs(x) - extent, 0);
      const dz = Math.max(Math.abs(z) - extent, 0);
      expect(Math.hypot(dx, dz)).toBeGreaterThan(5 + Math.sqrt(2));
    }
    for (let i = 0; i < plan.placements.length; i++) for (let j = i + 1; j < plan.placements.length; j++) {
      const a = plan.placements[i].position, b = plan.placements[j].position;
      expect(Math.hypot(a[0] - b[0], a[2] - b[2])).toBeGreaterThan(2 + 2 * Math.sqrt(2));
    }
  });

  test('returns a truthful bounded shortfall when spacing makes the requested density impossible', () => {
    const world = fixture();
    const plan = loadPlanner(world)(request({ zone: { min: [-5, -5], max: [5, 5] }, density: 10000, spacing: 20 }), world.resolve);
    expect(plan.requested).toBe(100);
    expect(plan.placements).toHaveLength(1);
    expect(plan.attempts).toBe(2000);
  });

  test.each([0, 2147483646])('accepts boundary seed %i without entering a degenerate generator state', (seed) => {
    const world = fixture();
    const plan = loadPlanner(world)(request({ seed }), world.resolve);
    expect(plan.placements).toHaveLength(150);
    expect(new Set(plan.placements.map((p) => p.position[0])).size).toBe(150);
  });

  test('caps the largest accepted request at 20000 attempts even when only one placement fits', () => {
    const world = fixture();
    const plan = loadPlanner(world)(request({ density: 250, spacing: 1000 }), world.resolve);
    expect(plan.requested).toBe(1000);
    expect(plan.placements).toHaveLength(1);
    expect(plan.attempts).toBe(20000);
  });

  test('rejects sparse arrays and array keys that would be lost in sequence traversal', () => {
    const world = fixture();
    const planner = loadPlanner(world);
    const sparse = new Array<{ source: string; weight: number }>(3);
    sparse[0] = { source: world.tree.GetFullName(), weight: 1 };
    sparse[2] = { source: world.rock.GetFullName(), weight: 1 };
    const extended = Object.assign([{ source: world.tree.GetFullName(), weight: 1 }], { extra: true });
    expect(() => planner(request({ templates: sparse }), world.resolve)).toThrow(/dense array/);
    expect(() => planner(request({ templates: extended }), world.resolve)).toThrow(/dense array/);
    expect(world.raycasts).toHaveLength(0);
  });

  test('excludes the replaced scatter subtree from avoidance without ignoring unrelated blockers', () => {
    const world = fixture();
    const group = new FakeInstance('Folder', 'OldScatter', world.workspace);
    const old = new FakeInstance('Part', 'OldTree', group);
    old.Size = new Vector3(1000, 100, 1000);
    old.tags.add('Tree');
    world.tagged.push(old);
    const step = request({ avoid: [{ tag: 'Tree', distance: 5 }] });
    const planner = loadPlanner(world);
    expect(() => planner(step, world.resolve)).toThrow(/no valid placements/);
    expect(summary(planner(step, world.resolve, group))).toEqual(summary(planner(request(), world.resolve)));
    const unrelated = new FakeInstance('Part', 'Other', world.workspace);
    unrelated.Size = old.Size;
    unrelated.tags.add('Tree');
    world.tagged.push(unrelated);
    expect(() => planner(step, world.resolve, group)).toThrow(/no valid placements/);
  });

  test('refuses ground or source dependencies inside the group being replaced', () => {
    const world = fixture();
    const planner = loadPlanner(world);
    expect(() => planner(request(), world.resolve, world.ground)).toThrow(/ground.*overlap/);
    expect(() => planner(request(), world.resolve, world.tree)).toThrow(/templates.*overlap/);
    expect(() => planner(request({ ground: ['game.Workspace'] }), world.resolve)).toThrow(/ground roots/);
  });

  test.each([
    { seed: NaN }, { seed: Infinity }, { seed: -1 }, { seed: 1.5 }, { seed: 2147483647 },
    { density: Infinity }, { density: 0 }, { density: 251 }, { density: 0.01 },
    { spacing: -1 }, { spacing: NaN }, { maxSlope: 90 },
    { scale: [0, 1] }, { scale: [2, 1] }, { scale: [1, Infinity] },
    { rotation: [10, -10] }, { rotation: [-Number.MAX_VALUE, Number.MAX_VALUE] },
    { zone: { min: [0, 0], max: [0, 10] } }, { zone: { min: [0, NaN], max: [10, 10] } },
    { zone: { min: [0, 0, 0], max: [10, 10] } },
    { raycast: { top: 0, bottom: 1 } }, { raycast: { top: 100001, bottom: 0 } },
    { ground: [] }, { ground: Array(17).fill('game.Workspace.Ground') },
    { templates: [] }, { templates: Array(17).fill({ source: 'game.ServerStorage.Tree', weight: 1 }) },
    { templates: [{ source: 'game.ServerStorage.Tree', weight: 0 }] },
    { templates: [{ source: 'game.ServerStorage.Tree', weight: Infinity }] },
    { templates: [{ source: '$prior', weight: 1 }] },
    { avoid: Array(17).fill({ tag: 'Road', distance: 0 }) },
    { avoid: [{ tag: 'Road', distance: -1 }] }, { avoid: [{ tag: '', distance: 0 }] },
  ])('rejects malformed or oversized parameters before raycasting: %j', (invalid) => {
    const world = fixture();
    expect(() => loadPlanner(world)(request(invalid), world.resolve)).toThrow();
    expect(world.raycasts).toHaveLength(0);
  });

  test('refuses a BasePart template containing another BasePart before planning placements', () => {
    const world = fixture();
    const child = new FakeInstance('Part', 'Canopy', world.tree);
    child.CFrame = new CFrame(0, 8, 0);
    child.Size = new Vector3(12, 6, 12);
    expect(() => loadPlanner(world)(request(), world.resolve)).toThrow(/Model/);
    expect(world.raycasts).toHaveLength(0);
    expect(child.CFrame.Position).toEqual(new Vector3(0, 8, 0));
    expect(child.Size).toEqual(new Vector3(12, 6, 12));
  });

  test('refuses more than 1000 tagged obstacles and non-archivable or empty templates', () => {
    const world = fixture();
    const planner = loadPlanner(world);
    world.tree.Archivable = false;
    expect(() => planner(request(), world.resolve)).toThrow(/archivable/);
    world.tree.Archivable = true;
    const empty = new FakeInstance('Model', 'Empty', world.storage);
    expect(() => planner(request({ templates: [{ source: empty.GetFullName(), weight: 1 }] }), world.resolve)).toThrow(/at least one BasePart/);
    for (let i = 0; i < 1001; i++) {
      const obstacle = new FakeInstance('Part', `Road${i}`, world.workspace);
      obstacle.tags.add('Road');
      world.tagged.push(obstacle);
    }
    expect(() => planner(request({ avoid: [{ tag: 'Road', distance: 1 }] }), world.resolve)).toThrow(/1000 obstacles/);
    expect(world.raycasts).toHaveLength(0);
  });
});
