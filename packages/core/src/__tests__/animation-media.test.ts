import { inflateSync } from 'zlib';
import { roundedBox } from '../animation/box-rig.js';
import { renderContactSheet, sheetTimes } from '../animation/contact-sheet.js';
import { GLB_SAMPLE_RATE, glbSampleTimes, renderRigGlb } from '../animation/rig-glb.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { R15_RIG } from '../animation/r15-rig.js';
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
      Object.keys(R15_RIG.parts).filter((part) => part !== 'HumanoidRootPart').map((part) => `${part} mesh`).sort(),
    );
    expect(glb.json.nodes[glb.json.scenes[0].nodes[0]].rotation).toEqual([0, 1, 0, 0]);
  });

  test('samples every joint over one pass, from core’s own sampler', () => {
    const sequence = raise(false);
    const glb = parseGlb(renderRigGlb(sequence, 'Raise'));
    const [animation] = glb.json.animations;
    expect(animation.channels).toHaveLength(R15_RIG.joints.length * 2);
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
