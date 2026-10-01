// A rig read from a model: a Parts dog rigged by hand with Motor6Ds, as the
// creature spike built one (tests/creature-spike.mjs), animated with
// `rotation` and no declarations. Every check it has nothing to judge by says
// so, and a pose means the same whichever way the model's joint frames turn.
import { inflateSync } from 'zlib';
import { drawnParts, meshParts } from '../animation/box-rig.js';
import { MAX_CELL_WIDTH, renderContactSheet, type ContactSheet } from '../animation/contact-sheet.js';
import { checkMotion } from '../animation/motion-checks.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import { MAX_RIG_JOINTS, MAX_WELDED_PARTS, R15_REST_HEIGHT, rigFromModel, type ModelRigReading, type ModelRigWeldedPart } from '../animation/model-rig.js';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { renderRigGlb } from '../animation/rig-glb.js';
import type { Rig } from '../animation/rig.js';
import { cf, IDENTITY, LEG_ROOTS, motor, partsDog, type CF, type V } from './fixtures/parts-dog.js';

/** The dog, with parts or joints replaced. */
const dog = (overrides: Partial<ModelRigReading> = {}): ModelRigReading => ({ ...partsDog(), ...overrides });
const LEGS = LEG_ROOTS;

/** C0 or C1 for a part standing upright at `at`: the pivot's offset from it, unturned. */
const offset = (pivot: V, at: V, turn: number[] = IDENTITY) => [pivot[0] - at[0], pivot[1] - at[1], pivot[2] - at[2], ...turn];

function rigOf(reading: unknown): Rig {
  const result = rigFromModel(reading);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.rig;
}

function errorsOf(reading: unknown): string[] {
  const result = rigFromModel(reading);
  if (result.ok) throw new Error('the reading was accepted');
  return result.errors;
}

function compiled(input: unknown, rig: Rig): KeyframeSequenceDescription {
  const result = compilePoseAnimation(input, rig);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

/** The JSON chunk of a GLB, and each accessor's values. */
function parseGlb(bytes: Buffer) {
  const jsonLength = bytes.readUInt32LE(12);
  const json = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binary = bytes.subarray(20 + jsonLength + 8);
  const values = (accessor: number): number[] => {
    const { bufferView, count, componentType } = json.accessors[accessor];
    const offset = json.bufferViews[bufferView].byteOffset;
    return Array.from({ length: count }, (_unused, index) => (componentType === 5125 ? binary.readUInt32LE(offset + index * 4) : binary.readUInt16LE(offset + index * 2)));
  };
  return { json, values };
}

/**
 * Where the figure is drawn in each cell of a sheet, in pixels from the
 * cell's corner: the pixels brighter than the dark background can be, above
 * the time labels. The shadow only darkens, so it is left out.
 */
function figureBounds(sheet: ContactSheet): { left: number; right: number; top: number; bottom: number }[] {
  const length = sheet.png.readUInt32BE(33);
  const data = inflateSync(sheet.png.subarray(41, 41 + length));
  const stride = 1 + sheet.width * 4;
  const cell = sheet.width / sheet.times.length;
  const bounds = Array.from({ length: sheet.times.length * 2 }, () => ({ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }));
  for (let y = 0; y < sheet.height; y += 1) {
    const row = Math.floor(y / (sheet.height / 2));
    const inRow = y - row * (sheet.height / 2);
    if (inRow >= 236) continue;
    for (let x = 0; x < sheet.width; x += 1) {
      if (data[y * stride + 1 + x * 4] <= 55) continue;
      const column = Math.floor(x / cell);
      const bound = bounds[row * sheet.times.length + column];
      const inCell = x - column * cell;
      bound.left = Math.min(bound.left, inCell);
      bound.right = Math.max(bound.right, inCell);
      bound.top = Math.min(bound.top, inRow);
      bound.bottom = Math.max(bound.bottom, inRow);
    }
  }
  return bounds;
}

/** A nod and a wag, looping, written with rotation only. */
const wag = (rig: Rig) => ({
  name: 'Wag',
  rig: rig.name,
  loop: true,
  keyframes: [
    { time: 0, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
    { time: 0.4, joints: { Neck: { rotation: [15, 0, 0] }, Tail: { rotation: [0, 30, 0] } } },
    { time: 0.8, joints: { Neck: { rotation: [0, 0, 0] }, Tail: { rotation: [0, -30, 0] } } },
  ],
});

describe('a rig read from a model', () => {
  it('describes a hand-rigged dog: its root joint, its body, the ground under its legs and its size', () => {
    const rig = rigOf(dog());
    expect(rig.name).toBe('game.Workspace.Dog');
    expect(rig.revision).toBe('r1');
    expect(rig.rootJoint).toBe('Root');
    expect(rig.body).toBe('Body');
    expect(rig.hidden).toEqual(['HumanoidRootPart']);
    expect(rig.ground).toBeCloseTo(-2.2, 9);
    expect(rig.feet).toEqual([]);
    expect(rig.limits).toEqual({ Root: 'free' });
    // From the soles, 2.2 studs below the root, to the top of the head, 1.4 above it.
    expect(rig.scale!.factor).toBeCloseTo(3.6 / R15_REST_HEIGHT, 9);
    expect(R15_REST_HEIGHT).toBeCloseTo(5.45, 2);
    // Parents before children, and the rest pose puts each part where the model has it.
    expect(rig.joints.map((joint) => joint.name)).toEqual(['Root', 'Neck', 'FrontLeft', 'FrontRight', 'HindLeft', 'HindRight', 'Tail']);
    const rest = poseRig(new Map(), 0, rig).parts;
    expect([...rest.get('Head')!.p].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0, 0.8, -2.6]);
    expect([...rest.get('HindRight')!.p].map((value) => Math.round(value * 1e6) / 1e6)).toEqual([0.7, -1.4, 1.4]);
  });

  it('is animated with rotation, each turn about the body\'s own axes at the joint', () => {
    const rig = rigOf(dog());
    const sequence = compiled(wag(rig), rig);
    expect(sequence.rig).toBe('game.Workspace.Dog');
    expect(sequence.joints).toEqual(['Neck', 'Tail']);
    const tracks = buildTracks(sequence);
    // The tail's tip swings to the dog's right (+X) at 0.4 s and its left at 0.
    const tip = (time: number) => pointToWorld(poseRig(tracks, time, rig).parts.get('Tail')!, [0, 0, 0.8]);
    expect(tip(0.4)[0]).toBeGreaterThan(0.7);
    expect(tip(0)[0]).toBeLessThan(-0.7);
    // The nod raises the head's front: +15° about X lifts -Z.
    const nose = pointToWorld(poseRig(tracks, 0.4, rig).parts.get('Head')!, [0, 0, -0.7]);
    expect(nose[1]).toBeGreaterThan(0.8 + 0.2);
  });

  it('says what it could not check, and passes nothing by default', () => {
    const rig = rigOf(dog());
    const sequence = compiled(wag(rig), rig);
    const status = (options: Parameters<typeof checkMotion>[1]) => Object.fromEntries(checkMotion(sequence, options, rig).checks.map((check) => [check.id, `${check.status}: ${check.detail}`]));

    const plain = status({ grounded: true });
    expect(plain.jointLimits).toBe('skipped: not checked: Neck and Tail turn with no declared range');
    expect(plain.groundContact).toBe('skipped: not checked: the rig declares no feet');
    expect(plain.velocity).toMatch(/^pass: fastest for its limit: Tail/);
    // Distances are R15's limits scaled to the dog, and say so.
    expect(plain.rootDrift).toMatch(/^pass: the body stays within 0 studs of the HumanoidRootPart and returns within 0; its limits are R15's scaled by 0\.66 for its height at rest$/);
    expect(plain.loopContinuity).toMatch(/^pass: the last pose meets the first; its limits are R15's scaled by 0\.66/);

    const gait = status({ locomotion: true });
    expect(gait.groundContact).toBe('skipped: not checked: the rig declares no feet');
    expect(gait.footSliding).toBe('skipped: not checked: the rig declares no feet');
    expect(gait.gaitSymmetry).toBe('skipped: not checked: the rig declares no pair of hips to compare');
    const report = checkMotion(sequence, { locomotion: true }, rig);
    expect(report.passed).toBe(true);
    expect(report.groundSpeed).toBeUndefined();
  });

  it('holds a joint that barely turns to nothing, so it needs no range', () => {
    const rig = rigOf(dog());
    const still = compiled({ ...wag(rig), keyframes: wag(rig).keyframes.map((keyframe) => ({ ...keyframe, joints: { ...keyframe.joints, Neck: { rotation: [0.05, 0, 0] } } })) }, rig);
    expect(checkMotion(still, {}, rig).checks.find((check) => check.id === 'jointLimits')!.detail).toBe('not checked: Tail turns with no declared range');
  });

  it('scales a distance limit it fails by, and says from what', () => {
    const rig = rigOf(dog());
    // The body slides 1.8 studs to the side: inside R15's 2, past the dog's 1.32.
    const slide = compiled({
      name: 'Slide', rig: rig.name,
      keyframes: [{ time: 0, joints: { Root: { position: [0, 0, 0] } } }, { time: 1, joints: { Root: { position: [1.8, 0, 0] } } }],
    }, rig);
    const drift = checkMotion(slide, {}, rig).checks.find((check) => check.id === 'rootDrift')!;
    expect(drift.status).toBe('fail');
    expect(drift.detail).toBe('the body moves 1.8 studs from the HumanoidRootPart at 1 s; limit 1.32; its limits are R15\'s scaled by 0.66 for its height at rest');
  });

  it('means the same pose whichever way the joint frames turn, or the parts rest', () => {
    // The tail's and its tip's motor frames turned, and the tail part itself
    // resting turned a quarter about Y, its size swapped to keep its box: the
    // parts stand where they did, and the same rotations move them the same.
    const tip = (tailAt: CF, tailSize: V, tailFrame: number[], tipFrame: number[]) => {
      const body = cf([0, 0, 0]);
      const tipAt = cf([0, 0.3, 3.8]);
      return dog({
        parts: [...dog().parts.filter((part) => part.name !== 'Tail'), { name: 'Tail', size: tailSize }, { name: 'Tip', size: [0.2, 0.2, 0.6] }],
        joints: [
          ...dog().joints.filter((joint) => joint.name !== 'Tail'),
          motor('Tail', ['Body', body], ['Tail', tailAt], cf([0, 0.3, 1.9], tailFrame)),
          motor('Tip', ['Tail', tailAt], ['Tip', tipAt], cf([0, 0.3, 3.5], tipFrame)),
        ],
      });
    };
    const quarterY = [0, 0, 1, 0, 1, 0, -1, 0, 0];
    const tiltX = [1, 0, 0, 0, 0, -1, 0, 1, 0];
    const plainRig = rigOf(tip(cf([0, 0.3, 2.7]), [0.3, 0.3, 1.6], IDENTITY, IDENTITY));
    const turnedRig = rigOf(tip(cf([0, 0.3, 2.7], quarterY), [1.6, 0.3, 0.3], tiltX, quarterY));
    expect(turnedRig.joints.find((joint) => joint.name === 'Tip')!.restRotation).toBeDefined();
    // Where the tail's far end and the tip's corners are, in each rig's own terms.
    const ends = (parts: Map<string, { p: number[]; r: number[] }>, turned: boolean) => [
      pointToWorld(parts.get('Tail')! as never, turned ? [-0.8, 0, 0] : [0, 0, 0.8]),
      pointToWorld(parts.get('Tip')! as never, [0, 0, 0.3]),
      pointToWorld(parts.get('Tip')! as never, [0.1, 0.1, -0.3]),
    ];
    const same = (a: number[][], b: number[][]) => a.forEach((point, index) => point.forEach((value, axis) => expect(b[index][axis]).toBeCloseTo(value, 6)));
    same(ends(poseRig(new Map(), 0, plainRig).parts, false), ends(poseRig(new Map(), 0, turnedRig).parts, true));
    const curl = (rig: Rig) => ({
      name: 'Curl', rig: rig.name,
      keyframes: [
        { time: 0, joints: { Tail: { rotation: [0, 0, 0] }, Tip: { rotation: [0, 0, 0] } } },
        { time: 1, joints: { Tail: { rotation: [20, 35, 0] }, Tip: { rotation: [-40, 0, 10] } } },
      ],
    });
    const plainTracks = buildTracks(compiled(curl(plainRig), plainRig));
    const turnedTracks = buildTracks(compiled(curl(turnedRig), turnedRig));
    for (const time of [0.5, 1]) {
      same(ends(poseRig(plainTracks, time, plainRig).parts, false), ends(poseRig(turnedTracks, time, turnedRig).parts, true));
    }
    // And a turn is about the body's axes: +35° about Y swings the tail's end to +X, the dog's right.
    expect(ends(poseRig(plainTracks, 1, plainRig).parts, false)[0][0]).toBeGreaterThan(0.3);
  });

  it('takes a position on its root joint only, and none on a rig whose root holds every piece', () => {
    const rig = rigOf(dog());
    expect(compilePoseAnimation({ name: 'Up', rig: rig.name, keyframes: [{ time: 0, joints: { Neck: { position: [0, 1, 0] } } }] }, rig))
      .toEqual({ ok: false, errors: ['keyframes[0].joints.Neck.position: only Root takes a position; other joints only rotate'] });
    // An importer's flat rig: every piece hangs from the root part by its own joint.
    const flat = rigOf(dog({ joints: dog().joints.map((joint) => ({ ...joint, part0: 'HumanoidRootPart' })).filter((joint) => joint.name !== 'Root'), parts: dog().parts.filter((part) => part.name !== 'Body') }));
    expect(flat.rootJoint).toBeUndefined();
    expect(compilePoseAnimation({ name: 'Up', rig: flat.name, keyframes: [{ time: 0, joints: { Neck: { position: [0, 1, 0] } } }] }, flat))
      .toEqual({ ok: false, errors: ['keyframes[0].joints.Neck.position: no one joint moves this rig\'s whole body (its HumanoidRootPart holds several), so none takes a position; joints only rotate'] });
    const nod = compiled({ name: 'Nod', rig: flat.name, keyframes: [{ time: 0, joints: { Neck: { rotation: [0, 0, 0] } } }, { time: 1, joints: { Neck: { rotation: [10, 0, 0] } } }] }, flat);
    expect(checkMotion(nod, {}, flat).checks.find((check) => check.id === 'rootDrift')!.detail)
      .toBe('not checked: no one joint moves the whole body; its HumanoidRootPart holds each piece by its own joint');
  });

  it('leaves aim, aimAt and bend to declared limbs and hinges', () => {
    const rig = rigOf(dog());
    const one = (joints: Record<string, unknown>) => compilePoseAnimation({ name: 'Bad', rig: rig.name, keyframes: [{ time: 0, joints }] }, rig);
    expect(one({ FrontLeft: { aim: [0, -1, 0.3] } })).toEqual({ ok: false, errors: ['keyframes[0].joints.FrontLeft: aim and bendToward work on declared limbs, and this rig declares none; use rotation here'] });
    expect(one({ FrontLeft: { aimAt: [0, -2, -1] } })).toEqual({ ok: false, errors: ['keyframes[0].joints.FrontLeft: aimAt works on declared limbs, and this rig declares none; use rotation here'] });
    expect(one({ FrontLeft: { bend: 30 } })).toEqual({ ok: false, errors: ['keyframes[0].joints.FrontLeft.bend: works on declared hinges, and this rig declares none; use rotation here'] });
  });

  it('only compiles for the rig it was read as', () => {
    const rig = rigOf(dog());
    expect(compilePoseAnimation(wag(rig))).toEqual({ ok: false, errors: ['rig: must be R15 or R6, or the path of a rigged Model in Studio'] });
    expect(compilePoseAnimation({ ...wag(rig), rig: 'game.Workspace.Cat' }, rig).ok).toBe(false);
  });

  it('draws the dog in a contact sheet and a 3D preview', () => {
    const rig = rigOf(dog());
    const sequence = compiled(wag(rig), rig);
    // A long body is framed in cells wider than R15's, each holding all of it
    // clear of the edges and as large as its length allows, from the front
    // three-quarter and, for a gait, from the side.
    for (const locomotion of [false, true]) {
      const sheet = renderContactSheet(sequence, undefined, { rig, locomotion });
      const cell = sheet.width / sheet.times.length;
      expect(cell).toBeGreaterThan(172);
      expect(cell).toBeLessThanOrEqual(MAX_CELL_WIDTH);
      for (const bound of figureBounds(sheet)) {
        expect(bound.left).toBeGreaterThanOrEqual(8);
        expect(bound.right).toBeLessThanOrEqual(cell - 9);
        expect(bound.top).toBeGreaterThanOrEqual(8);
        expect(bound.bottom).toBeLessThanOrEqual(236 - 9);
      }
      // The three-quarter view fills most of the cell's height.
      const [first] = figureBounds(sheet);
      expect(first.bottom - first.top).toBeGreaterThan(110);
    }
    const glb = renderRigGlb(sequence, 'Wag', undefined, rig);
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
    // Every visible part is drawn, and the hidden root is not.
    expect(json.meshes.map((mesh: { name: string }) => mesh.name).sort()).toEqual(['Body', 'FrontLeft', 'FrontRight', 'Head', 'HindLeft', 'HindRight', 'Tail']);
  });

  it('draws each part as its shape with the parts welded to it, and stands the lowest of them on the ground', () => {
    const welded: ModelRigWeldedPart[] = [
      { name: 'Snout', to: 'Head', offset: [0, -0.2, -0.9, ...IDENTITY], size: [0.8, 0.6, 0.8], shape: 'Wedge' },
      // A paw under the front left leg, whose sole is 2.2 studs down: 0.2 lower.
      { name: 'Paw', to: 'FrontLeft', offset: [0, -0.9, -0.1, ...IDENTITY], size: [0.6, 0.2, 0.8] },
      { name: 'Saddle', to: 'HumanoidRootPart', offset: [0, 0.8, 0, ...IDENTITY], size: [1.2, 0.4, 1.2], shape: 'Ball' },
    ];
    const result = rigFromModel(dog({
      parts: dog().parts.map((part) => (part.name === 'Head' ? { ...part, size: [1.4, 1.4, 1.4] as V, shape: 'Ball' as const } : part)),
      welded,
      weldedLeftOut: 3,
    }));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    const { rig, notes } = result;
    expect(notes).toEqual([`3 more welded parts are not drawn: a preview draws the ${MAX_WELDED_PARTS} largest`]);
    expect(rig.shapes).toMatchObject({ Head: 'Ball', Body: 'Block', Tail: 'Block' });
    expect(rig.attached).toEqual({
      Head: [{ part: 'Snout', offset: welded[0].offset, size: [0.8, 0.6, 0.8], shape: 'Wedge' }],
      FrontLeft: [{ part: 'Paw', offset: welded[1].offset, size: [0.6, 0.2, 0.8], shape: 'Block' }],
      HumanoidRootPart: [{ part: 'Saddle', offset: welded[2].offset, size: [1.2, 0.4, 1.2], shape: 'Ball' }],
    });
    expect(rig.ground).toBeCloseTo(-2.4, 9);
    // The hidden root is drawn as what is welded to it, and nothing of its own.
    expect(drawnParts(rig)).not.toContain('HumanoidRootPart');
    expect(meshParts(rig)).toContain('HumanoidRootPart');
    const glb = parseGlb(renderRigGlb(compiled(wag(rig), rig), 'Wag', undefined, rig));
    const vertices = (name: string) => {
      const mesh = glb.json.meshes.find((candidate: { name: string }) => candidate.name === name);
      return glb.json.accessors[mesh.primitives[0].attributes.POSITION].count;
    };
    // A ball of 11 rings of 17 with a wedge of five flat faces; a ball alone; a block's 384 with a paw's.
    expect(vertices('Head')).toBe(11 * 17 + 18);
    expect(vertices('HumanoidRootPart')).toBe(11 * 17);
    expect(vertices('FrontLeft')).toBe(384 * 2);
  });

  it('counts a mesh\'s corners in four bytes when it has more than two bytes count', () => {
    const welded = Array.from({ length: 200 }, (_unused, index): ModelRigWeldedPart => ({
      name: `Stud${index}`, to: 'Body', offset: [0, 0.7, -1.9 + index * 0.019, ...IDENTITY], size: [0.1, 0.1, 0.1],
    }));
    const rig = rigOf(dog({ welded }));
    const glb = parseGlb(renderRigGlb(compiled(wag(rig), rig), 'Wag', undefined, rig));
    const body = glb.json.meshes.find((mesh: { name: string }) => mesh.name === 'Body').primitives[0];
    const count = glb.json.accessors[body.attributes.POSITION].count;
    expect(count).toBe(384 * 201);
    expect(glb.json.accessors[body.indices].componentType).toBe(5125);
    expect(glb.values(body.indices).reduce((most, value) => Math.max(most, value), 0)).toBe(count - 1);
    // Smaller meshes keep two bytes a corner.
    const tail = glb.json.meshes.find((mesh: { name: string }) => mesh.name === 'Tail').primitives[0];
    expect(glb.json.accessors[tail.indices].componentType).toBe(5123);
  });

  it('names a repeated joint after the part it moves', () => {
    const result = rigFromModel(dog({ joints: dog().joints.map((joint) => (LEGS[joint.part1] ? { ...joint, name: 'Motor6D' } : joint)) }));
    if (!result.ok) throw new Error(result.errors.join('\n'));
    expect(result.rig.joints.map((joint) => joint.name)).toEqual(['Root', 'Neck', 'FrontLeft', 'FrontRight', 'HindLeft', 'HindRight', 'Tail']);
    expect(result.notes).toEqual(['joints named Motor6D more than once are named after the part each moves']);
  });

  it('refuses what is not one tree of uniquely named parts from its root', () => {
    const base = dog();
    expect(errorsOf(dog({ parts: [...base.parts, { name: 'Head', size: [1, 1, 1] }] })))
      .toEqual(["parts: a keyframe's poses find their parts by name, so each must be named once; these repeat: Head"]);
    expect(errorsOf(dog({ joints: [...base.joints, { ...base.joints[1], name: 'Neck2', part0: 'Tail' }] })))
      .toEqual(['joint Neck2 (Tail to Head): Head is already moved by Neck; a part may have one joint']);
    expect(errorsOf(dog({ joints: [...base.joints, { ...base.joints[0], name: 'Up', part0: 'Body', part1: 'HumanoidRootPart' }] })))
      .toEqual(['joint Up (Body to HumanoidRootPart): nothing may move the root part, HumanoidRootPart; it is where the rig hangs from']);
    // A loop of joints off to one side never reaches the root.
    expect(errorsOf(dog({
      parts: [...base.parts, { name: 'A', size: [1, 1, 1] }, { name: 'B', size: [1, 1, 1] }],
      joints: [...base.joints, { ...base.joints[1], name: 'AB', part0: 'A', part1: 'B' }, { ...base.joints[1], name: 'BA', part0: 'B', part1: 'A' }],
    }))).toEqual(['joints: AB, BA do not hang from HumanoidRootPart, directly or through other joints; a rig is one tree of joints from its root part']);
    expect(errorsOf(dog({ joints: [] }))).toEqual(['joints: the model has no Motor6D or AnimationConstraint joints, and no Bones, to animate']);
    expect(errorsOf(dog({ joints: [{ ...base.joints[1], c0: [0, 0.4, -2, 2, 0, 0, 0, 1, 0, 0, 0, 1] }, ...base.joints.slice(2)] })))
      .toEqual(['joint Neck (Body to Head): C0 and C1 must be rotations without scale']);
    expect(errorsOf(dog({ controller: 'Nothing' as 'Humanoid' })))
      .toEqual(['controller: the model needs a Humanoid or an AnimationController to play animations']);
    expect(errorsOf(dog({ parts: base.parts.map((part) => (part.name === 'Head' ? { ...part, shape: 'Cone' as 'Ball' } : part)) })))
      .toEqual(["parts: Head's shape must be one of Block, Wedge, Cylinder, Ball"]);
    const ear: ModelRigWeldedPart = { name: 'Ear', to: 'Head', offset: [0, 0.8, 0, ...IDENTITY], size: [0.3, 0.6, 0.2] };
    expect(errorsOf(dog({ welded: [{ ...ear, to: 'Hat' }] })))
      .toEqual(["welded: Ear is welded to Hat, which is not one of the rig's parts"]);
    expect(errorsOf(dog({ welded: [{ ...ear, offset: [0, 0.8, 0] }, { ...ear, shape: 'Cone' as 'Ball' }] }))).toEqual([
      'welded: Ear must name itself and the part it moves with, with its offset as a CFrame\'s 12 components and a positive size',
      "welded: Ear's shape must be one of Block, Wedge, Cylinder, Ball",
    ]);
    expect(errorsOf(dog({ parts: [...base.parts, { name: 'Bone', size: [1, 1, 1] }], welded: [{ ...ear, to: 'Bone' }] })))
      .toEqual(['welded: parts are welded to Bone, which no joint moves; a welded part must move with a part of the rig']);
    expect(errorsOf(dog({ welded: Array.from({ length: MAX_WELDED_PARTS + 1 }, () => ear) })))
      .toEqual([`welded: a reading lists at most ${MAX_WELDED_PARTS} welded parts; this one lists ${MAX_WELDED_PARTS + 1}`]);
    const many = Array.from({ length: MAX_RIG_JOINTS + 1 }, (_unused, index) => ({ name: `J${index}`, part0: 'Body', part1: `P${index}`, c0: offset([0, 0, 0], [0, 0, 0]), c1: offset([0, 0, 0], [0, 0, 0]) }));
    expect(errorsOf(dog({ parts: [...base.parts, ...many.map((joint) => ({ name: joint.part1, size: [1, 1, 1] as V }))], joints: [...base.joints, ...many] })))
      .toContain(`joints: a rig may have at most ${MAX_RIG_JOINTS} joints; this one has ${base.joints.length + many.length}`);
  });
});
