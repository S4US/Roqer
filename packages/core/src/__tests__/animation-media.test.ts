import { inflateSync } from 'zlib';
import { drawnParts, roundedBox } from '../animation/box-rig.js';
import { MAX_COLUMNS, renderContactSheet, sheetMoments, sheetTimes } from '../animation/contact-sheet.js';
import { GLB_SAMPLE_RATE, glbSampleTimes, renderRigGlb } from '../animation/rig-glb.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';
import { R6_RIG } from '../animation/r6-rig.js';
import { previewProps } from '../animation/animation-tool.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import { normalizeToolResult } from '../mcp-runtime.js';

function compiled(input: unknown): KeyframeSequenceDescription {
  const result = compilePoseAnimation(input);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

const raise = (loop: boolean) => compiled({
  name: 'Raise',
  rig: 'R15',
  loop,
  keyframes: [
    { time: 0, joints: { RightShoulder: { rotation: [0, 0, 0] }, Root: { position: [0, 0, 0] } } },
    { time: 1, joints: { RightShoulder: { rotation: [90, 0, 0] }, Root: { position: [0, -0.5, 0] } } },
  ],
});

/** The JSON chunk and binary chunk of a GLB, checked as the desktop's inspector checks them. */
function parseGlb(bytes: Buffer) {
  expect(bytes.readUInt32LE(0)).toBe(0x46546c67);
  expect(bytes.readUInt32LE(4)).toBe(2);
  expect(bytes.readUInt32LE(8)).toBe(bytes.length);
  const jsonLength = bytes.readUInt32LE(12);
  expect(bytes.readUInt32LE(16)).toBe(0x4e4f534a);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryOffset = 20 + jsonLength;
  expect(bytes.readUInt32LE(binaryOffset + 4)).toBe(0x004e4942);
  const binary = bytes.subarray(binaryOffset + 8, binaryOffset + 8 + bytes.readUInt32LE(binaryOffset));
  return { json, binary };
}

type GltfJson = {
  accessors: { bufferView: number; count: number; type: string }[];
  bufferViews: { byteOffset: number }[];
};

function floats(glb: { json: GltfJson; binary: Buffer }, accessor: number): number[] {
  const { bufferView, count, type } = glb.json.accessors[accessor];
  const view = glb.json.bufferViews[bufferView];
  const size = type === 'SCALAR' ? 1 : type === 'VEC3' ? 3 : 4;
  return Array.from({ length: count * size }, (_unused, index) => glb.binary.readFloatLE(view.byteOffset + index * 4));
}

describe('contact sheet', () => {
  test('shows a loop without its wrap and a one-shot with its last frame', () => {
    expect(sheetTimes(raise(true))).toEqual([0, 0.2, 0.4, 0.6, 0.8]);
    expect(sheetTimes(raise(false))).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const still = compiled({ name: 'Stand', rig: 'R15', keyframes: [{ time: 0, joints: { Neck: {} } }] });
    const sheet = renderContactSheet(still);
    expect(sheet.times).toEqual([0]);
    expect([sheet.width, sheet.height]).toEqual([172, 508]);
  });

  test('adds columns at markers, named keys and the fastest instant, which even steps miss', () => {
    const slash = compiled({
      name: 'Cut',
      rig: 'R15',
      keyframes: [
        { time: 0, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
        { time: 0.3, name: 'WindUp', joints: { RightShoulder: { rotation: [-80, 0, 0] } } },
        { time: 0.37, joints: { RightShoulder: { rotation: [10, 0, 0] } }, markers: [{ name: 'Hit' }] },
        { time: 1, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
      ],
    });
    const moments = sheetMoments(slash);
    // The even steps are 0, 0.25, 0.5, 0.75 and 1: the strike from 0.3 to 0.37 falls between them.
    expect(moments.find((moment) => moment.label === 'WindUp')).toEqual({ time: 0.3, label: 'WindUp' });
    // The strike is fastest just before the hit, so the two share a column.
    expect(moments.find((moment) => moment.label.startsWith('Hit'))).toEqual({ time: 0.37, label: 'Hit, fastest' });
    // The first and last columns stay put.
    expect(moments[0].time).toBe(0);
    expect(moments[moments.length - 1].time).toBe(1);
    expect(moments.length).toBeLessThanOrEqual(MAX_COLUMNS);
    const sheet = renderContactSheet(slash);
    expect(sheet.labels).toEqual(moments.map((moment) => moment.label));
    expect(sheet.width).toBe(172 * moments.length);
  });

  test('draws the same figure the same way every time', () => {
    const a = renderContactSheet(raise(false)).png;
    const b = renderContactSheet(raise(false)).png;
    expect(a.equals(b)).toBe(true);
    expect(a.equals(renderContactSheet(raise(true)).png)).toBe(false);
  });

  test('looks at the front below, unless the motion is a gait, which it looks at from the side', () => {
    // The encoder writes one IDAT of unfiltered rows, each behind a filter byte.
    const rows = (png: Buffer) => {
      const length = png.readUInt32BE(33);
      const data = inflateSync(png.subarray(41, 41 + length));
      const stride = 1 + 860 * 4;
      return Array.from({ length: data.length / stride }, (_unused, y) => data.subarray(y * stride, (y + 1) * stride));
    };
    const front = rows(renderContactSheet(raise(false)).png);
    const side = rows(renderContactSheet(raise(false), undefined, { locomotion: true }).png);
    const half = front.length / 2;
    expect(front.slice(0, half).every((row, y) => row.equals(side[y]))).toBe(true);
    expect(front.slice(half).every((row, y) => row.equals(side[half + y]))).toBe(false);
  });
});

describe('block rig meshes', () => {
  test('are rounded boxes of the part’s size, closed, wound outward, with unit normals', () => {
    const mesh = roundedBox([2, 1, 1], 0.2);
    const xs = mesh.positions.filter((_value, index) => index % 3 === 0);
    const ys = mesh.positions.filter((_value, index) => index % 3 === 1);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([-1, 1, -0.5, 0.5]);
    for (let index = 0; index < mesh.normals.length; index += 3) {
      expect(Math.hypot(mesh.normals[index], mesh.normals[index + 1], mesh.normals[index + 2])).toBeCloseTo(1, 6);
    }
    // Every triangle faces away from the centre: its winding agrees with its vertices' normals.
    for (let index = 0; index < mesh.indices.length; index += 3) {
      const [a, b, c] = [0, 1, 2].map((offset) => mesh.indices[index + offset]);
      const p = (i: number) => mesh.positions.slice(i * 3, i * 3 + 3);
      const [pa, pb, pc] = [p(a), p(b), p(c)];
      const u = pb.map((value, axis) => value - pa[axis]);
      const v = pc.map((value, axis) => value - pa[axis]);
      const face = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const normal = mesh.normals.slice(a * 3, a * 3 + 3);
      if (Math.hypot(...face) > 1e-9) expect(face[0] * normal[0] + face[1] * normal[1] + face[2] * normal[2]).toBeGreaterThan(0);
    }
  });
});

describe('rig GLB', () => {
  test('is one self-contained glTF 2.0 file with a rounded mesh for every part but the root', () => {
    const glb = parseGlb(renderRigGlb(raise(false), 'Raise'));
    expect(glb.json.asset.version).toBe('2.0');
    expect(glb.json.buffers).toEqual([{ byteLength: glb.binary.length }]);
    const drawn = glb.json.nodes.filter((node: { mesh?: number }) => node.mesh !== undefined);
    expect(drawn.map((node: { name: string }) => node.name).sort()).toEqual(
      drawnParts(R15_RIG).map((part) => `${part} mesh`).sort(),
    );
    expect(glb.json.nodes[glb.json.scenes[0].nodes[0]].rotation).toEqual([0, 1, 0, 0]);
  });

  test('samples every joint over one pass, from core’s own sampler', () => {
    const sequence = raise(false);
    const glb = parseGlb(renderRigGlb(sequence, 'Raise'));
    const [animation] = glb.json.animations;
    // The weapon grip is left out of an animation that does not move it.
    expect(animation.channels).toHaveLength(R15_RIG.joints.filter((joint) => !joint.optional).length * 2);
    const times = floats(glb, animation.samplers[0].input);
    expect(times).toHaveLength(GLB_SAMPLE_RATE + 1);
    expect(times).toEqual(glbSampleTimes(sequence).map((time) => Math.fround(time)));

    const shoulder = glb.json.nodes.findIndex((node: { name: string }) => node.name === 'RightShoulder');
    const rotation = animation.channels.find((channel: { target: { node: number; path: string } }) => channel.target.node === shoulder && channel.target.path === 'rotation');
    const quaternions = floats(glb, animation.samplers[rotation.sampler].output);
    // 90° about X at the end: [sin 45°, 0, 0, cos 45°].
    const last = quaternions.slice(-4);
    expect(last[0]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(last[3]).toBeCloseTo(Math.SQRT1_2, 5);

    const root = glb.json.nodes.findIndex((node: { name: string }) => node.name === 'Root');
    const moved = animation.channels.find((channel: { target: { node: number; path: string } }) => channel.target.node === root && channel.target.path === 'translation');
    const translations = floats(glb, animation.samplers[moved.sampler].output);
    // The joint's offset in the HumanoidRootPart plus the keyed half-stud drop.
    expect(translations.slice(-3).map((value) => Math.round(value * 1000) / 1000)).toEqual([0, -1.5, 0]);
  });
});

describe('held weapon', () => {
  const slash = compiled({
    name: 'Flick',
    rig: 'R15',
    keyframes: [
      { time: 0, joints: { Weapon: { rotation: [0, 0, 0] } } },
      { time: 0.5, joints: { Weapon: { rotation: [60, 0, 0] } } },
    ],
  });

  test('points the stand-in blade forward out of a hanging fist, at the grip', () => {
    const rest = poseRig(buildTracks(slash), 0);
    const hand = rest.parts.get('RightHand')!;
    const grip = rest.parts.get('BodyAttach')!;
    const tip = pointToWorld(grip, [0, 3.6, 0]);
    expect(grip.p[0]).toBeCloseTo(hand.p[0], 6);
    expect(grip.p[1]).toBeCloseTo(hand.p[1] - 0.15, 6);
    // Forward is -Z: the tip lies ahead of the hand at its height.
    expect(tip[2]).toBeCloseTo(hand.p[2] - 3.6, 6);
    expect(tip[1]).toBeCloseTo(grip.p[1], 6);
    // Turning the weapon +60° about the hand's X tilts the tip up.
    expect(pointToWorld(poseRig(buildTracks(slash), 0.5).parts.get('BodyAttach')!, [0, 3.6, 0])[1]).toBeGreaterThan(grip.p[1] + 3);
  });

  test('appears in the GLB and the sheet only when the animation moves it', () => {
    const glb = parseGlb(renderRigGlb(slash, 'Flick'));
    const names = glb.json.nodes.map((node: { name: string }) => node.name);
    expect(names).toContain('BodyAttach mesh');
    const weapon = glb.json.nodes.findIndex((node: { name: string }) => node.name === 'Weapon');
    const rotation = glb.json.animations[0].channels.find((channel: { target: { node: number; path: string } }) => channel.target.node === weapon && channel.target.path === 'rotation');
    // At rest the joint node holds C0's turn, -90° about X.
    const first = floats(glb, glb.json.animations[0].samplers[rotation.sampler].output).slice(0, 4);
    expect(first[0]).toBeCloseTo(-Math.SQRT1_2, 5);
    expect(first[3]).toBeCloseTo(Math.SQRT1_2, 5);
    expect(parseGlb(renderRigGlb(raise(false), 'Raise')).json.nodes.map((node: { name: string }) => node.name)).not.toContain('BodyAttach mesh');

    const withBlade = renderContactSheet(slash).png;
    const bladeless = renderContactSheet({ ...slash, keyframes: slash.keyframes.map((keyframe) => ({ ...keyframe, root: { ...keyframe.root, children: [] } })) }).png;
    expect(withBlade.equals(bladeless)).toBe(false);
  });
});

describe('worn and off-hand props', () => {
  test('hangs the sheath back from the left hip, and mirrors the grip in the left hand', () => {
    for (const rig of [R15_RIG, R6_RIG]) {
      const sequence = compiled({
        name: 'Props', rig: rig.name,
        keyframes: [{ time: 0, joints: { Sheath: { rotation: [0, 0, 0] }, OffHand: { rotation: [0, 0, 0] } } }],
      });
      const rest = poseRig(buildTracks(sequence), 0, rig).parts;
      const mouth = rest.get('SheathAttach')!.p;
      const end = pointToWorld(rest.get('SheathAttach')!, [0, 3.8, 0]);
      // At the left side, running back (+Z) and a little down.
      expect(mouth[0]).toBeLessThan(-0.9);
      expect(end[2] - mouth[2]).toBeGreaterThan(3.5);
      expect(end[1]).toBeLessThan(mouth[1]);
      const hand = rest.get(rig.name === 'R6' ? 'Left Arm' : 'LeftHand')!;
      const tip = pointToWorld(rest.get('OffHandAttach')!, [0, 3.6, 0]);
      expect(tip[2]).toBeLessThan(hand.p[2] - 3);
      expect(previewProps(sequence).map((prop) => prop.part).sort()).toEqual(['OffHandAttach', 'SheathAttach']);
    }
  });

  test('asks the preview dummy for exactly the props the animation moves', () => {
    const sequence = compiled({ name: 'Draw', rig: 'R6', keyframes: [{ time: 0, joints: { Sheath: { rotation: [0, 0, 0] } } }] });
    const [sheath] = previewProps(sequence);
    expect(sheath).toEqual({ part: 'SheathAttach', parent: 'Torso', c0: [-1, -0.8, 0, ...R6_RIG.joints.find((joint) => joint.name === 'Sheath')!.parentRotation!] });
    const weapon = previewProps(compiled({ name: 'Cut', rig: 'R15', keyframes: [{ time: 0, joints: { Weapon: { rotation: [0, 0, 0] } } }] }));
    expect(weapon).toEqual([expect.objectContaining({ part: 'BodyAttach', parent: 'RightHand', attachment: 'RightGripAttachment' })]);
    expect(previewProps(raise(false))).toEqual([]);
  });
});

describe('MCP results', () => {
  test('keep the viewer’s GLB for the desktop and give MCP clients the rest', () => {
    const raw = {
      content: [
        { type: 'text', text: '{"valid":true}' },
        { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
        { type: 'resource', resource: { uri: 'roqer://animation-preview.glb', mimeType: 'model/gltf-binary', blob: 'Z2xURg==' } },
      ],
    };
    const forClients = normalizeToolResult(raw, 'modern');
    expect(forClients.structuredContent).toEqual({ valid: true });
    expect(forClients.content).toEqual([{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    // The desktop's HTTP surface keeps it for the viewer.
    expect(normalizeToolResult(raw, 'modern', { keepHostOnly: true }).content).toHaveLength(2);
  });
});
