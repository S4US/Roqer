// The skinned creature tests/skinned-spike.mjs uploads, and the judgement of
// what Roblox gave back for it.
//
// The creature is a snake: one mesh, a square tube along its length, skinned
// to a chain of bones the way Blender exports an armature. Blender's bones
// point along their own +Y, so the root joint carries the rotation that lays
// +Y along the snake, and every child sits one bone's length up its parent's
// +Y with no rotation of its own. That rest rotation is what lets the spike
// see whether Roblox keeps a bone's axes or resets them to the world's.

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

/** The snake's length along glTF's Z, its section's half width, and the height of its middle. */
export const SNAKE_LENGTH = 8;
const HALF = 0.4;
const HEIGHT = 1;

export const boneName = (index) => `Bone${String(index).padStart(3, '0')}`;
export const SNAKE_MESH = 'SnakeGeometry';
export const SNAKE_NODE = 'Snake';

/**
 * A point in glTF's axes as Roblox places it: half a turn about Y, as the
 * creature spike measured.
 */
export const robloxAxes = ([x, y, z]) => [-x, y, -z];

class Binary {
  chunks = [];
  length = 0;
  bufferViews = [];
  accessors = [];

  view(bytes, target) {
    const padding = (4 - (this.length % 4)) % 4;
    if (padding > 0) {
      this.chunks.push(Buffer.alloc(padding));
      this.length += padding;
    }
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, ...(target ? { target } : {}) });
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this.bufferViews.length - 1;
  }

  floats(values, type, width, { bounds = false, target = ARRAY_BUFFER } = {}) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    const accessor = { bufferView: this.view(bytes, target), componentType: FLOAT, count: values.length / width, type };
    if (bounds) {
      const axes = Array.from({ length: width }, (_unused, axis) => values.filter((_value, index) => index % width === axis));
      accessor.min = axes.map((list) => Math.fround(Math.min(...list)));
      accessor.max = axes.map((list) => Math.fround(Math.max(...list)));
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  shorts(values, type, width, target) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
    this.accessors.push({ bufferView: this.view(bytes, target), componentType: UNSIGNED_SHORT, count: values.length / width, type });
    return this.accessors.length - 1;
  }

  buffer() {
    const padding = (4 - (this.length % 4)) % 4;
    return Buffer.concat([...this.chunks, Buffer.alloc(padding)]);
  }
}

/**
 * The weights of one vertex at `along` (0 at the tail's end, 1 at the head's)
 * on a chain of `bones`: the `influences` bones whose middles are nearest,
 * weighted by nearness and summing to 1. With two influences this is the
 * linear blend between the two bones a vertex lies between.
 */
export function vertexWeights(along, bones, influences) {
  const t = along * bones - 0.5;
  if (influences <= 2) {
    const a = Math.min(Math.max(Math.floor(t), 0), bones - 1);
    const b = Math.min(a + 1, bones - 1);
    const share = a === b ? 0 : Math.min(Math.max(t - a, 0), 1);
    return share === 0 ? [[a, 1]] : share === 1 ? [[b, 1]] : [[a, 1 - share], [b, share]];
  }
  const nearest = Array.from({ length: bones }, (_unused, index) => [index, 1 / (1 + (t - index) ** 2)])
    .sort((left, right) => right[1] - left[1])
    .slice(0, Math.min(influences, bones));
  const total = nearest.reduce((sum, [, weight]) => sum + weight, 0);
  return nearest.map(([index, weight]) => [index, weight / total]);
}

/**
 * The snake as one self-contained GLB, and what it holds.
 *
 * `bones` is the length of the chain; `influences` how many bones weigh on a
 * vertex (up to 4 in JOINTS_0, up to 8 with JOINTS_1); `blenderAxes` lays each
 * bone's +Y along the snake as Blender's exporter does, where false leaves
 * every joint unrotated.
 */
export function skinnedSnake({ bones = 8, influences = 2, blenderAxes = true } = {}) {
  if (!Number.isInteger(bones) || bones < 1) throw new Error('bones must be a positive whole number');
  if (!Number.isInteger(influences) || influences < 1 || influences > 8) throw new Error('influences must be 1 to 8');
  const binary = new Binary();
  const rings = Math.max(17, bones + 1);
  const corners = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]];
  const sets = influences > 4 ? 2 : 1;
  const positions = [];
  const normals = [];
  const joints = Array.from({ length: sets }, () => []);
  const weights = Array.from({ length: sets }, () => []);
  let mostInfluences = 0;
  for (let ring = 0; ring < rings; ring += 1) {
    const along = ring / (rings - 1);
    const weighted = vertexWeights(along, bones, influences);
    mostInfluences = Math.max(mostInfluences, weighted.length);
    for (const [x, y] of corners) {
      positions.push(x, HEIGHT + y, -SNAKE_LENGTH / 2 + along * SNAKE_LENGTH);
      normals.push(Math.sign(x) * Math.SQRT1_2, Math.sign(y) * Math.SQRT1_2, 0);
      for (let set = 0; set < sets; set += 1) {
        for (let slot = 0; slot < 4; slot += 1) {
          const entry = weighted[set * 4 + slot];
          joints[set].push(entry ? entry[0] : 0);
          weights[set].push(entry ? entry[1] : 0);
        }
      }
    }
  }
  const indices = [];
  for (let ring = 0; ring < rings - 1; ring += 1) {
    for (let corner = 0; corner < 4; corner += 1) {
      const a = ring * 4 + corner;
      const b = ring * 4 + ((corner + 1) % 4);
      const c = (ring + 1) * 4 + ((corner + 1) % 4);
      const d = (ring + 1) * 4 + corner;
      indices.push(a, b, c, a, c, d);
    }
  }
  const last = (rings - 1) * 4;
  indices.push(0, 3, 2, 0, 2, 1, last, last + 1, last + 2, last, last + 2, last + 3);

  // The chain: each bone's head in glTF's axes, tail end first.
  const length = SNAKE_LENGTH / bones;
  const chain = Array.from({ length: bones }, (_unused, index) => ({
    name: boneName(index),
    parent: index === 0 ? null : boneName(index - 1),
    position: [0, HEIGHT, -SNAKE_LENGTH / 2 + index * length],
  }));
  // A turn of a quarter about X lays +Y along +Z; its inverse's columns follow.
  const inverseBind = chain.flatMap(({ position: [x, y, z] }) => (blenderAxes
    ? [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, -x, -z, y, 1]
    : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -x, -y, -z, 1]));

  // Nodes: an armature holding the mesh and the root bone, as Blender writes one.
  const firstBone = 2;
  const nodes = [
    { name: 'Armature', children: [1, firstBone] },
    { name: SNAKE_NODE, mesh: 0, skin: 0 },
    ...chain.map((bone, index) => ({
      name: bone.name,
      ...(index === 0
        ? { translation: bone.position, ...(blenderAxes ? { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2] } : {}) }
        : { translation: blenderAxes ? [0, length, 0] : [0, 0, length] }),
      ...(index < bones - 1 ? { children: [firstBone + index + 1] } : {}),
    })),
  ];
  const attributes = {
    POSITION: binary.floats(positions, 'VEC3', 3, { bounds: true }),
    NORMAL: binary.floats(normals, 'VEC3', 3),
  };
  for (let set = 0; set < sets; set += 1) {
    attributes[`JOINTS_${set}`] = binary.shorts(joints[set], 'VEC4', 4, ARRAY_BUFFER);
    attributes[`WEIGHTS_${set}`] = binary.floats(weights[set], 'VEC4', 4);
  }
  const json = {
    asset: { version: '2.0', generator: 'Roqer skinned spike' },
    scene: 0,
    scenes: [{ name: 'SpikeSnake', nodes: [0] }],
    nodes,
    meshes: [{
      name: SNAKE_MESH,
      primitives: [{ attributes, indices: binary.shorts(indices, 'SCALAR', 1, ELEMENT_ARRAY_BUFFER), material: 0 }],
    }],
    skins: [{
      name: 'Armature',
      skeleton: firstBone,
      joints: chain.map((_bone, index) => firstBone + index),
      inverseBindMatrices: binary.floats(inverseBind, 'MAT4', 16, { target: null }),
    }],
    materials: [{ name: 'SpikeGreen', pbrMetallicRoughness: { baseColorFactor: [0.35, 0.55, 0.3, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    accessors: binary.accessors,
    bufferViews: binary.bufferViews,
    buffers: [{ byteLength: 0 }],
  };
  const bytes = binary.buffer();
  json.buffers[0].byteLength = bytes.length;
  let text = Buffer.from(JSON.stringify(json), 'utf8');
  const textPadding = (4 - (text.length % 4)) % 4;
  if (textPadding > 0) text = Buffer.concat([text, Buffer.alloc(textPadding, 0x20)]);
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + text.length + 8 + bytes.length, 8);
  const textHeader = Buffer.alloc(8);
  textHeader.writeUInt32LE(text.length, 0);
  textHeader.writeUInt32LE(0x4e4f534a, 4);
  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(bytes.length, 0);
  binaryHeader.writeUInt32LE(0x004e4942, 4);
  return {
    glb: Buffer.concat([header, textHeader, text, binaryHeader, bytes]),
    json,
    bones: chain,
    vertices: positions.length / 3,
    influences: mostInfluences,
    blenderAxes,
    size: [HALF * 2, HALF * 2, SNAKE_LENGTH],
  };
}

/** Studs two positions may differ by and still be the same place. */
const NEAR = 0.05;
const difference = (a, b) => a.map((value, axis) => value - b[axis]);
const distance = (a, b) => Math.hypot(...difference(a, b));
const isVector = (value) => Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number');
const round = (value) => Math.round(value * 1000) / 1000;

/**
 * What an insert of the uploaded snake came back as, judged against the
 * snake: whether its mesh is skinned, how many bones arrived, under what and
 * named how, whether they are the chain that was modelled, where they stand,
 * and which way their axes point.
 *
 * `readback` is the spike's Luau readout of the folder the insert went into:
 * `top`, its children; `meshParts`, each with its size, place, parent and
 * whether it reports a skinned mesh; `bones`, a count, the deepest nesting,
 * and the first of them listed with name, parent, world place and axes;
 * `joints` and `controllers`, what else the import came with.
 */
export function judgeSkinnedImport(readback, snake) {
  const meshParts = Array.isArray(readback?.meshParts) ? readback.meshParts : [];
  const listed = Array.isArray(readback?.bones?.listed) ? readback.bones.listed : [];
  const count = typeof readback?.bones?.count === 'number' ? readback.bones.count : listed.length;
  const finding = {
    top: Array.isArray(readback?.top) ? readback.top : [],
    meshParts: meshParts.map((part) => ({ name: part.name, parent: `${part.parent} (${part.parentClass})`, size: part.size ?? null, skinned: part.skinned ?? null })),
    skinned: meshParts.length > 0 && meshParts.every((part) => part.skinned === true),
    bonesModelled: snake.bones.length,
    bonesArrived: count,
    deepestNesting: readback?.bones?.depth ?? null,
    joints: Array.isArray(readback?.joints) ? readback.joints : [],
    controllers: Array.isArray(readback?.controllers) ? readback.controllers : [],
  };
  if (listed.length === 0) return { ...finding, names: 'no bones', hierarchy: 'no bones', positions: 'no bones', axes: 'no bones' };

  const byName = new Map(listed.map((bone) => [bone.name, bone]));
  const modelled = snake.bones.filter((bone) => byName.has(bone.name));
  const names = modelled.length === Math.min(snake.bones.length, listed.length) ? 'kept'
    : modelled.length > 0 ? `${modelled.length} of ${Math.min(snake.bones.length, listed.length)} listed bones keep their names`
      : 'changed';
  const root = byName.get(snake.bones[0].name);
  const chained = modelled.filter((bone) => bone.parent !== null && byName.get(bone.name).parent === bone.parent);
  const flat = new Set(listed.map((bone) => `${bone.parent}/${bone.parentClass}`)).size === 1;
  const hierarchy = modelled.length > 1 && chained.length === modelled.length - 1 ? 'a chain as modelled'
    : flat ? 'flat'
      : 'mixed';

  let positions = 'unknown';
  let worst;
  if (root && isVector(root.at)) {
    const placed = modelled.filter((bone) => isVector(byName.get(bone.name).at));
    const offsets = placed.map((bone) => ({
      actual: difference(byName.get(bone.name).at, root.at),
      modelled: difference(bone.position, snake.bones[0].position),
    }));
    const worstTurned = Math.max(...offsets.map((entry) => distance(entry.actual, robloxAxes(entry.modelled))));
    const worstUnturned = Math.max(...offsets.map((entry) => distance(entry.actual, entry.modelled)));
    positions = worstTurned <= NEAR ? 'kept' : worstUnturned <= NEAR ? 'kept, not turned' : 'moved';
    worst = round(Math.min(worstTurned, worstUnturned));
  }

  // A Blender bone's +Y lies along the snake, glTF's +Z, which Roblox turns to -Z.
  let axes = 'unknown';
  if (root && isVector(root.up)) {
    axes = distance(root.up, [0, 0, -1]) <= 0.02 ? 'kept: +Y along the chain'
      : distance(root.up, [0, 0, 1]) <= 0.02 ? 'kept, not turned: +Y along the chain'
        : distance(root.up, [0, 1, 0]) <= 0.02 ? "the world's: +Y up"
          : 'other';
  }
  return {
    ...finding,
    names,
    rootBoneParent: root ? `${root.parent} (${root.parentClass})` : null,
    hierarchy,
    positions,
    ...(worst !== undefined ? { worstPositionStuds: worst } : {}),
    axes,
    ...(root && isVector(root.up) ? { rootBoneUp: root.up, rootBoneRight: root.right ?? null } : {}),
  };
}

/** One line for the report's answer. */
export function describeSkinnedImport(finding) {
  if (!finding || finding.meshParts.length === 0) return 'no MeshPart arrived';
  return [
    `${finding.meshParts.length} MeshPart${finding.meshParts.length === 1 ? '' : 's'}, ${finding.skinned ? 'skinned' : 'not reported as skinned'}`,
    `${finding.bonesArrived} of ${finding.bonesModelled} bones`,
    ...(finding.bonesArrived > 0 ? [
      `names ${finding.names}`,
      `hierarchy ${finding.hierarchy}`,
      `positions ${finding.positions}`,
      `axes ${finding.axes}`,
    ] : []),
    finding.joints.length > 0 ? `${finding.joints.length} joints besides` : 'no joints besides',
    finding.controllers.length > 0 ? `under ${finding.controllers.join(' and ')}` : 'no controller',
  ].join('; ');
}

/**
 * How a sequence must be shaped to drive bones, from the turns each shape
 * left on the bones it keyed: `results` maps a shape's name to
 * `{ loaded, bones: { name: degrees } }`, and `expected` maps a bone to the
 * degrees it was keyed to.
 */
export function judgeBoneSequences(results, expected) {
  const shapes = {};
  for (const [shape, result] of Object.entries(results ?? {})) {
    if (!result || result.error || result.loaded !== true) {
      shapes[shape] = { drives: false, why: result?.error ?? 'the sequence did not load' };
      continue;
    }
    const off = Object.entries(expected).map(([bone, degrees]) => {
      const measured = result.bones?.[bone];
      return typeof measured === 'number' ? Math.abs(measured - degrees) : Infinity;
    });
    const worst = Math.max(...off);
    shapes[shape] = { drives: worst <= 1.5, worstDegrees: Number.isFinite(worst) ? round(worst) : null };
  }
  const driving = Object.entries(shapes).filter(([, shape]) => shape.drives).map(([name]) => name);
  return {
    answer: driving.length === 0 ? 'no shape tried drives the bones'
      : driving.length === Object.keys(shapes).length ? `every shape tried drives them: ${driving.join(', ')}`
        : `driven by: ${driving.join(', ')}`,
    shapes,
  };
}
