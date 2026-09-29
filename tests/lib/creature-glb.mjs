// The articulated creature tests/creature-spike.mjs uploads for its seventh
// question, and the judgement of what Roblox gave back for it.
//
// The creature is built the way the creature plan's Blender recipe builds one:
// each moving piece its own node, its origin at the joint it turns about, and
// the node tree the rig, so a front leg in two segments is a chain three deep.
// An origin away from its piece's middle is what lets the spike see whether
// Roblox keeps a node's origin as the MeshPart's pivot or re-centres it.

/**
 * The pieces in glTF's axes, as Blender exports a model built facing -Y: Y up,
 * the front toward +Z, the creature's left toward +X. Sizes and positions are in
 * studs; the feet stand on Y 0. Every piece touches its parent, and its origin
 * lies inside or on both.
 */
export const CREATURE_PIECES = [
  { name: 'Body', parent: null, origin: [0, 2.2, 0], center: [0, 2.2, 0], size: [2, 1.2, 4] },
  { name: 'Head', parent: 'Body', origin: [0, 2.6, 2], center: [0, 3, 2.6], size: [1.2, 1.2, 1.4] },
  { name: 'FrontLeftUpper', parent: 'Body', origin: [0.7, 1.6, 1.4], center: [0.7, 1.2, 1.4], size: [0.5, 0.8, 0.5] },
  { name: 'FrontLeftLower', parent: 'FrontLeftUpper', origin: [0.7, 0.8, 1.4], center: [0.7, 0.4, 1.4], size: [0.45, 0.8, 0.45] },
  { name: 'FrontRight', parent: 'Body', origin: [-0.7, 1.6, 1.4], center: [-0.7, 0.8, 1.4], size: [0.5, 1.6, 0.5] },
  { name: 'HindLeft', parent: 'Body', origin: [0.7, 1.6, -1.4], center: [0.7, 0.8, -1.4], size: [0.5, 1.6, 0.5] },
  { name: 'HindRight', parent: 'Body', origin: [-0.7, 1.6, -1.4], center: [-0.7, 0.8, -1.4], size: [0.5, 1.6, 0.5] },
  { name: 'Tail', parent: 'Body', origin: [0, 2.5, -1.9], center: [0, 2.5, -2.7], size: [0.3, 0.3, 1.6] },
];

/** A piece's mesh is named apart from its node, so the spike can tell which name Roblox uses. */
export const meshName = (piece) => `${piece.name}Geometry`;

/**
 * A point in glTF's axes as Roblox places it: half a turn about Y, as Roqer's
 * Blender guide measured (Blender (x, y, z) arrives at (-x, z, y), and Blender's
 * glTF export writes (x, z, -y)).
 */
export const robloxAxes = ([x, y, z]) => [-x, y, -z];

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

// Each face of a box: its outward normal and the two axes across it, with
// u x v = n, so corners walked (-u-v, +u-v, +u+v, -u+v) wind counter-clockwise
// seen from outside, as glTF expects.
const FACES = [
  { n: [1, 0, 0], u: [0, 1, 0], v: [0, 0, 1] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [0, 0, 1], v: [1, 0, 0] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [0, 1, 0], v: [1, 0, 0] },
];
const CORNERS = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** A flat-shaded box of `size` centred on `center`: 24 corners and 12 triangles. */
function box(center, size) {
  const half = size.map((value) => value / 2);
  const positions = [];
  const normals = [];
  const indices = [];
  for (const { n, u, v } of FACES) {
    const base = positions.length / 3;
    for (const [su, sv] of CORNERS) {
      for (let axis = 0; axis < 3; axis += 1) {
        positions.push(center[axis] + (n[axis] + su * u[axis] + sv * v[axis]) * half[axis]);
      }
      normals.push(...n);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return { positions, normals, indices };
}

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
    this.bufferViews.push({ buffer: 0, byteOffset: this.length, byteLength: bytes.length, target });
    this.chunks.push(bytes);
    this.length += bytes.length;
    return this.bufferViews.length - 1;
  }

  vectors(values, withBounds) {
    const bytes = Buffer.alloc(values.length * 4);
    values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
    const accessor = { bufferView: this.view(bytes, ARRAY_BUFFER), componentType: FLOAT, count: values.length / 3, type: 'VEC3' };
    if (withBounds) {
      const axes = [0, 1, 2].map((axis) => values.filter((_value, index) => index % 3 === axis));
      // The float32 values, so the bounds hold exactly what the buffer does.
      accessor.min = axes.map((list) => Math.fround(Math.min(...list)));
      accessor.max = axes.map((list) => Math.fround(Math.max(...list)));
    }
    this.accessors.push(accessor);
    return this.accessors.length - 1;
  }

  indices(values) {
    const bytes = Buffer.alloc(values.length * 2);
    values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2));
    this.accessors.push({ bufferView: this.view(bytes, ELEMENT_ARRAY_BUFFER), componentType: UNSIGNED_SHORT, count: values.length, type: 'SCALAR' });
    return this.accessors.length - 1;
  }

  buffer() {
    const padding = (4 - (this.length % 4)) % 4;
    return Buffer.concat([...this.chunks, Buffer.alloc(padding)]);
  }
}

/** The creature as one self-contained GLB: a node per piece, parented as the rig is. */
export function articulatedCreatureGlb(pieces = CREATURE_PIECES) {
  const binary = new Binary();
  const indexOf = new Map(pieces.map((piece, index) => [piece.name, index]));
  const byName = new Map(pieces.map((piece) => [piece.name, piece]));
  const meshes = pieces.map((piece) => {
    // In the node's own frame: the box's centre relative to the node's origin.
    const local = piece.center.map((value, axis) => value - piece.origin[axis]);
    const shape = box(local, piece.size);
    return {
      name: meshName(piece),
      primitives: [{
        attributes: { POSITION: binary.vectors(shape.positions, true), NORMAL: binary.vectors(shape.normals, false) },
        indices: binary.indices(shape.indices),
        material: 0,
      }],
    };
  });
  const nodes = pieces.map((piece, index) => {
    const parent = piece.parent === null ? undefined : byName.get(piece.parent);
    const children = pieces.filter((other) => other.parent === piece.name).map((other) => indexOf.get(other.name));
    return {
      name: piece.name,
      mesh: index,
      // A node sits at its origin relative to its parent's origin; nothing turns.
      translation: piece.origin.map((value, axis) => value - (parent ? parent.origin[axis] : 0)),
      ...(children.length > 0 ? { children } : {}),
    };
  });
  const bytes = binary.buffer();
  const json = {
    asset: { version: '2.0', generator: 'Roqer creature spike' },
    scene: 0,
    scenes: [{ name: 'SpikeCreature', nodes: pieces.filter((piece) => piece.parent === null).map((piece) => indexOf.get(piece.name)) }],
    nodes,
    meshes,
    materials: [{ name: 'SpikeGrey', pbrMetallicRoughness: { baseColorFactor: [0.62, 0.6, 0.58, 1], metallicFactor: 0, roughnessFactor: 0.9 } }],
    accessors: binary.accessors,
    bufferViews: binary.bufferViews,
    buffers: [{ byteLength: bytes.length }],
  };
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
  return Buffer.concat([header, textHeader, text, binaryHeader, bytes]);
}

/** Studs two positions may differ by and still be the same place. */
const NEAR = 0.05;

/** Classes that join two parts, or stand for a joint as a bone does. */
const JOINT_CLASSES = new Set(['Motor6D', 'Motor', 'Weld', 'ManualWeld', 'Snap', 'Glue', 'WeldConstraint', 'AnimationConstraint', 'Bone']);

const difference = (a, b) => a.map((value, axis) => value - b[axis]);
const distance = (a, b) => Math.hypot(...difference(a, b));
const isVector = (value) => Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === 'number');
const round = (value) => Math.round(value * 1000) / 1000;

/**
 * What an insert of the uploaded creature came back as, judged against the
 * pieces: which MeshPart is which piece (by its node's name, its mesh's name,
 * or its size when that is unique), whether the sizes, the layout and the
 * origins survived, and how the parts are nested.
 *
 * `readback` is the spike's Luau readout of the folder the insert went into:
 * `top`, its children; `items`, its parts, joints, bones, controllers, models
 * and folders, each with class, name and parent, for a part its size,
 * position, pivot and axes, and for a joint the parts it joins and where it is;
 * `counted`, every other descendant counted by class and parent; and
 * `overflow`, how many listable descendants did not fit in `items`.
 */
export function judgeImport(readback, pieces = CREATURE_PIECES) {
  const items = Array.isArray(readback?.items) ? readback.items : [];
  const counted = readback?.counted && !Array.isArray(readback.counted) ? readback.counted : {};
  const overflow = typeof readback?.overflow === 'number' ? readback.overflow : 0;
  const meshParts = items.filter((item) => item?.class === 'MeshPart' && isVector(item.size) && isVector(item.position));
  const matches = pieces.map((piece) => {
    const byNode = meshParts.filter((part) => part.name === piece.name);
    const byMesh = meshParts.filter((part) => part.name === meshName(piece));
    // An axis-aligned box keeps its extents through a half turn about Y.
    const bySize = meshParts.filter((part) => distance(part.size, piece.size) <= NEAR);
    if (byNode.length === 1) return { piece, part: byNode[0], namedAfter: 'node' };
    if (byMesh.length === 1) return { piece, part: byMesh[0], namedAfter: 'mesh' };
    if (bySize.length === 1) return { piece, part: bySize[0], namedAfter: 'size only' };
    return { piece, part: undefined, namedAfter: 'not found' };
  });
  const found = matches.filter((match) => match.part !== undefined);
  const body = matches.find((match) => match.piece.parent === null);
  const reference = body?.part;
  const pieceSummary = matches.map(({ piece, part, namedAfter }) => ({
    piece: piece.name,
    part: part?.name ?? null,
    namedAfter,
    parent: part ? `${part.parent} (${part.parentClass})` : null,
    sizeMatches: part ? distance(part.size, piece.size) <= NEAR : false,
  }));
  const finding = {
    meshParts: meshParts.length,
    pieces: pieces.length,
    top: Array.isArray(readback?.top) ? readback.top : [],
    found: found.length,
    // Of the pieces recognised; one that did not arrive shows in `found` instead.
    sizesMatch: found.length > 0 && pieceSummary.filter((entry) => entry.part !== null).every((entry) => entry.sizeMatches),
    pieceSummary,
    rig: judgeRig(items, counted, found, body, reference),
    overflow,
  };
  if (!reference || found.length < 2) return { ...finding, layout: 'unknown', origins: 'unknown', hierarchy: 'unknown' };

  // Where each piece sits against the body, with and without the half turn.
  const offsets = found.map(({ piece, part }) => ({
    piece,
    part,
    actual: difference(part.position, reference.position),
    turned: robloxAxes(difference(piece.center, body.piece.center)),
    unturned: difference(piece.center, body.piece.center),
  }));
  const worstTurned = Math.max(...offsets.map((entry) => distance(entry.actual, entry.turned)));
  const worstUnturned = Math.max(...offsets.map((entry) => distance(entry.actual, entry.unturned)));
  const stacked = found.every(({ part }) => distance(part.position, reference.position) <= NEAR);
  const layout = worstTurned <= NEAR ? 'kept'
    : worstUnturned <= NEAR ? 'kept, not turned'
      : stacked ? 'stacked on one point'
        : 'lost';

  // A pivot kept at the node's origin sits where the joint is.
  const withPivots = found.filter(({ part }) => isVector(part.pivot) && isVector(part.pivotOffset));
  const worstOrigin = withPivots.length === 0 ? Infinity : Math.max(...withPivots.map(({ piece, part }) => distance(
    difference(part.pivot, reference.position),
    robloxAxes(difference(piece.origin, body.piece.center)),
  )));
  const centred = withPivots.length > 0 && withPivots.every(({ part }) => Math.hypot(...part.pivotOffset) <= 0.01);
  const origins = withPivots.length === 0 ? 'unknown'
    : layout === 'kept' && worstOrigin <= NEAR ? 'kept as pivots'
      : centred ? 'pivots at the bounds centre'
        : 'moved';

  // Nested when a piece's MeshPart hangs under its parent piece's, or under a Model named after it.
  const partOf = new Map(found.map(({ piece, part }) => [piece.name, part]));
  const nestedPieces = found.filter(({ piece, part }) => {
    if (piece.parent === null) return false;
    const parentPart = partOf.get(piece.parent);
    return part.parent === parentPart?.name || part.parent === piece.parent;
  });
  const parents = new Set(found.map(({ part }) => `${part.parent}/${part.parentClass}`));
  const hierarchy = nestedPieces.length === found.length - 1 ? 'nested as modelled'
    : parents.size === 1 ? 'flat'
      : 'mixed';

  const turnedParts = found.filter(({ part }) => isVector(part.look) && isVector(part.up)
    && (distance(part.look, [0, 0, -1]) > 0.01 || distance(part.up, [0, 1, 0]) > 0.01)).map(({ part }) => part.name);

  return {
    ...finding,
    layout,
    worstLayoutStuds: round(Math.min(worstTurned, worstUnturned)),
    origins,
    ...(Number.isFinite(worstOrigin) ? { worstOriginStuds: round(worstOrigin) } : {}),
    hierarchy,
    turnedParts,
  };
}

/**
 * What the import made of the node tree as a rig: the joints and controllers
 * it came with, whether a joint joins each piece to the piece it hangs from,
 * and whether the joints sit at the node origins, where the pieces turn.
 */
function judgeRig(items, counted, found, body, reference) {
  const joints = items.filter((item) => JOINT_CLASSES.has(item?.class));
  const summary = {
    joints: joints.map((joint) => ({ class: joint.class, name: joint.name, part0: joint.part0 ?? null, part1: joint.part1 ?? null })),
    controllers: items.filter((item) => item?.class === 'Humanoid' || item?.class === 'AnimationController').map((item) => item.class),
    animators: items.filter((item) => item?.class === 'Animator').length,
    initialPoseValues: Object.entries(counted)
      .filter(([key, count]) => key.endsWith(' in InitialPoses') && typeof count === 'number')
      .reduce((sum, [, count]) => sum + count, 0),
  };
  if (joints.length === 0) return { ...summary, tree: 'no joints', jointsAt: 'no joints' };

  // Each modelled pair of a piece and the piece it hangs from, and whether a
  // joint between two parts joins them. A bone joins no parts, so it is
  // judged by where it is alone.
  const partOf = new Map(found.map(({ piece, part }) => [piece.name, part.name]));
  const links = joints.filter((joint) => joint.class !== 'Bone');
  const pairs = found.filter(({ piece }) => piece.parent !== null && partOf.has(piece.parent));
  const joined = pairs.filter(({ piece, part }) => links.some((joint) => {
    const ends = [joint.part0, joint.part1];
    return ends.includes(part.name) && ends.includes(partOf.get(piece.parent));
  }));
  const tree = links.length === 0 || pairs.length === 0 ? 'unknown'
    : joined.length === pairs.length ? 'kept'
      : joined.length > 0 ? `${joined.length} of ${pairs.length} pairs joined`
        : 'not joined as modelled';

  // A joint belongs where the node origin of the piece it moves is; a bone,
  // where the origin of the node it is named after is.
  const pieceOfPart = new Map(found.map(({ piece, part }) => [part.name, piece]));
  const pieceNamed = new Map(found.map(({ piece }) => [piece.name, piece]));
  const offsets = !reference ? [] : joints.flatMap((joint) => {
    const piece = joint.class === 'Bone' ? pieceNamed.get(joint.name) : pieceOfPart.get(joint.part1);
    if (!piece || !isVector(joint.at)) return [];
    return [distance(difference(joint.at, reference.position), robloxAxes(difference(piece.origin, body.piece.center)))];
  });
  const jointsAt = offsets.length === 0 ? 'unknown'
    : offsets.every((offset) => offset <= NEAR) ? 'the modelled origins'
      : 'elsewhere';
  return { ...summary, tree, jointsAt, ...(offsets.length > 0 ? { worstJointStuds: round(Math.max(...offsets)) } : {}) };
}

/** One line for the report's answer. */
export function describeImport(finding) {
  if (!finding || finding.found === 0) return 'no piece recognised';
  const naming = new Set(finding.pieceSummary.filter((entry) => entry.part).map((entry) => entry.namedAfter));
  const rig = finding.rig;
  const kinds = [...new Set((rig?.joints ?? []).map((joint) => joint.class))];
  return [
    `${finding.meshParts} MeshParts for ${finding.pieces} pieces${finding.found < finding.pieces ? `, ${finding.found} recognised` : ''}`,
    `named after the ${[...naming].join(' or ')}`,
    finding.sizesMatch ? 'sizes kept' : 'sizes differ',
    `layout ${finding.layout}`,
    `origins ${finding.origins}`,
    `hierarchy ${finding.hierarchy}`,
    !rig || rig.joints.length === 0 ? 'no joints'
      : `${rig.joints.length} joints (${kinds.join(', ')}), tree ${rig.tree}, at ${rig.jointsAt}`
        + `${rig.controllers.length > 0 ? `, under ${rig.controllers.join(' and ')}` : ', no controller'}`,
    ...(finding.overflow > 0 ? [`${finding.overflow} parts or joints not listed`] : []),
  ].join('; ');
}
