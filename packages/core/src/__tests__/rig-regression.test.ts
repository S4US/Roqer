// Holds R15 and R6 to what they compiled, checked and drew to before rigs of
// any shape could be read from Studio (docs/creature-plan.md, step 3): R15 and
// R6 became built-in descriptions of the same rig everything else reads, and
// what they produce must not change.
//
// Every recipe in the skill's reference, every animation the live suite
// builds, and the errors a few bad descriptions get, are compiled, checked
// three ways, and drawn as a contact sheet and a 3D preview. Each result is
// kept as a digest in fixtures/rig-regression.json. To record an intended
// change, run this test with ROQER_UPDATE_RIG_REGRESSION=1 and say in the
// commit what changed and why.
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { inflateSync } from 'zlib';
import { renderContactSheet } from '../animation/contact-sheet.js';
import { checkMotion } from '../animation/motion-checks.js';
import { compilePoseAnimation } from '../animation/pose-compiler.js';
import { renderRigGlb } from '../animation/rig-glb.js';
import { generatedRigMeshes } from '../animation/rig-meshes.js';
import { rigFor } from '../animation/rigs.js';

const REFERENCE = 'apps/desktop/agent/skills/roblox-animation-vfx/references/character-animation.md';
const RECORD = 'packages/core/src/__tests__/fixtures/rig-regression.json';
const GAITS = new Set(['Walk', 'Run', 'WalkR6', 'MarchR6']);

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function recipes(): [string, unknown][] {
  const text = fs.readFileSync(path.join(repositoryRoot(), REFERENCE), 'utf8');
  return [...text.matchAll(/```json\r?\n([\s\S]*?)```/g)].map((match) => {
    const recipe = JSON.parse(match[1]) as { name: string };
    return [`recipe ${recipe.name}`, recipe];
  });
}

function wave(raise: number) {
  return {
    name: 'Wave',
    rig: 'R15',
    loop: true,
    keyframes: [
      { time: 0, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
      { time: 0.5, easing: { style: 'CubicV2', direction: 'InOut' }, joints: { RightShoulder: { rotation: [0, 0, raise] }, RightElbow: { rotation: [60, 0, 0] } } },
      { time: 1, joints: { RightShoulder: { rotation: [0, 0, 60] }, RightElbow: { rotation: [30, 0, 0] } } },
    ],
  };
}

const gripKey = (time: number, at: number[], turn: number) => ({
  time,
  joints: { RightShoulder: { aimAt: at, bendToward: [0, 1, 0] }, Weapon: { rotation: [turn, 0, 0] }, LeftShoulder: { grip: 0.45 } },
});

// The animations tests/animation-tool.mjs builds in Studio.
const LIVE: [string, unknown][] = [
  ['live Wave', wave(100)],
  ['live AimWave', {
    name: 'AimWave', rig: 'R15', loop: true, easing: { style: 'CubicV2', direction: 'InOut' },
    keyframes: [
      { time: 0, joints: { RightShoulder: { aim: [1, 0.3, 0.4], bendToward: [0, 1, 0] }, RightElbow: { bend: 70 } } },
      { time: 0.3, joints: { RightElbow: { bend: 115 } } },
      { time: 0.6, joints: { RightShoulder: { aim: [1, 0.3, 0.4], bendToward: [0, 1, 0] }, RightElbow: { bend: 70 } } },
    ],
  }],
  ['live Swung', {
    name: 'Swung', rig: 'R15',
    keyframes: [
      { time: 0, easing: { style: 'CubicV2', direction: 'Out' }, joints: { RightShoulder: { aim: [0, -1, 0] } } },
      { time: 0.3, joints: { RightShoulder: { aim: [0, 1, 0.5], bendToward: [0, 0, -1] } } },
    ],
  }],
  ['live Flick', {
    name: 'Flick', rig: 'R15',
    keyframes: [
      { time: 0, joints: { RightShoulder: { aim: [0, -1, 0.3] }, Weapon: { rotation: [0, 0, 0] } } },
      { time: 0.3, joints: { RightShoulder: { aim: [0, -1, 0.3] }, Weapon: { rotation: [-80, 20, 0] } } },
    ],
  }],
  ['live DrawR6', {
    name: 'DrawR6', rig: 'R6',
    keyframes: [
      { time: 0, joints: { Sheath: { rotation: [0, 0, 0] }, OffHand: { rotation: [0, 0, 0] }, Weapon: { rotation: [0, 0, 0] } } },
      { time: 0.3, joints: { Sheath: { rotation: [-20, 15, 0] }, OffHand: { rotation: [-60, 0, 0] }, Weapon: { rotation: [-90, 0, 0] } } },
    ],
  }],
  ['live MarchR6', {
    name: 'MarchR6', rig: 'R6', loop: true,
    keyframes: [
      { time: 0, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] }, Neck: { rotation: [10, 0, 0] } } },
      { time: 0.4, joints: { LeftHip: { aim: [0, -1, -0.4] }, RightHip: { aim: [0, -1, 0.4] }, Neck: { rotation: [-10, 0, 0] } } },
      { time: 0.8, joints: { LeftHip: { aim: [0, -1, 0.4] }, RightHip: { aim: [0, -1, -0.4] }, Neck: { rotation: [10, 0, 0] } } },
    ],
  }],
  ['live Planted', {
    name: 'Planted', rig: 'R15',
    keyframes: [
      { time: 0, joints: { Root: { position: [0, -0.2, 0] }, LeftHip: { aimAt: [-0.6, -2.93, 0.4] }, RightHip: { aimAt: [0.6, -2.93, -0.5] } } },
      { time: 0.4, joints: { Root: { position: [0, -0.5, -0.3], rotation: [0, 15, 0] }, LeftHip: { aimAt: [-0.6, -2.93, 0.4] }, RightHip: { aimAt: [0.6, -2.93, -0.5] } } },
    ],
  }],
  ['live TwoHanded', { name: 'TwoHanded', rig: 'R15', keyframes: [gripKey(0, [-0.2, 0.5, 0.8], 0), gripKey(0.3, [-0.2, 1.5, 0.5], 30), gripKey(0.42, [-0.2, 0, 0.8], -60)] }],
  ['live Marked', {
    name: 'Marked', rig: 'R15',
    keyframes: [
      { time: 0, joints: { RightShoulder: { aim: [0, -1, 0] } } },
      { time: 0.2, joints: {}, markers: [{ name: 'Hit', value: 'light' }] },
      { time: 0.4, joints: { RightShoulder: { aim: [0, -1, 0.6] } } },
    ],
  }],
];

const one = (rig: string, joints: Record<string, unknown>) => ({ name: 'Bad', rig, keyframes: [{ time: 0, joints }] });

// Descriptions that fail for what a rig has or lacks, whose errors name its joints.
const REFUSED: [string, unknown][] = [
  ['refused unknown joint', one('R15', { Tail: { rotation: [0, 10, 0] } })],
  ['refused R6 elbow', one('R6', { LeftElbow: { bend: 40 } })],
  ['refused part name', one('R15', { RightUpperArm: { rotation: [0, 10, 0] } })],
  ['refused aim on a neck', one('R15', { Neck: { aim: [0, 1, 0] } })],
  ['refused bend on a neck', one('R15', { Neck: { bend: 20 } })],
  ['refused aimAt on a waist', one('R15', { Waist: { aimAt: [0, 1, -1] } })],
  ['refused position on a neck', one('R15', { Neck: { position: [0, 1, 0] } })],
  ['refused grip on the right', one('R15', { RightShoulder: { grip: 0.3 } })],
  ['refused R6 grip', one('R6', { LeftShoulder: { grip: 0.3 } })],
  ['refused aimAt out of reach', one('R15', { LeftHip: { aimAt: [-0.5, -9, 0] } })],
  ['refused R6 aimAt out of reach', one('R6', { RightShoulder: { aimAt: [4, 0.5, 0] } })],
  ['refused a late key', { name: 'Bad', rig: 'R15', keyframes: [{ time: 0, joints: { Neck: { rotation: [0, 10, 0] } } }, { time: 1, joints: { Waist: { rotation: [0, 10, 0] } } }] }],
];

function digest(value: unknown): string {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value), 'utf8');
  return createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

/** A PNG's rows as drawn, whatever the deflate that packed them. */
function pixels(png: Buffer): Buffer {
  const data: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') data.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return inflateSync(Buffer.concat(data));
}

function record(input: unknown): Record<string, string> {
  const compiled = compilePoseAnimation(input);
  if (!compiled.ok) return { errors: digest(compiled.errors) };
  const { sequence } = compiled;
  const rig = rigFor(sequence.rig);
  const meshes = generatedRigMeshes(rig);
  const locomotion = GAITS.has(sequence.name);
  return {
    sequence: digest(sequence),
    checks: digest(checkMotion(sequence, {}, rig)),
    grounded: digest(checkMotion(sequence, { grounded: true }, rig)),
    locomotion: digest(checkMotion(sequence, { locomotion: true }, rig)),
    sheet: digest(pixels(renderContactSheet(sequence, meshes, { locomotion, rig }).png)),
    glb: digest(renderRigGlb(sequence, sequence.name, meshes, rig)),
  };
}

describe('R15 and R6 output', () => {
  const fixtures = [...recipes(), ...LIVE, ...REFUSED];
  const file = path.join(repositoryRoot(), RECORD);

  it('covers every recipe the reference holds', () => {
    expect(recipes().length).toBe(9);
    expect(new Set(fixtures.map(([name]) => name)).size).toBe(fixtures.length);
  });

  it('is what it was before rigs were read from Studio', () => {
    const now = Object.fromEntries(fixtures.map(([name, input]) => [name, record(input)]));
    if (process.env.ROQER_UPDATE_RIG_REGRESSION === '1') {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(now, null, 2)}\n`);
    }
    const kept = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, Record<string, string>>;
    const changed = Object.keys({ ...kept, ...now }).flatMap((name) => {
      const aspects = Object.keys({ ...kept[name], ...now[name] });
      return aspects.filter((aspect) => kept[name]?.[aspect] !== now[name]?.[aspect]).map((aspect) => `${name}: ${aspect}`);
    });
    expect(changed).toEqual([]);
  });
});
