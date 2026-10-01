// The creature recipes the desktop agent adapts (the reference's fences marked
// `json creature`) are held to what the reference promises: each compiles on
// the body it names, passes every motion check that applies, and makes the
// gesture it is named for.
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from '@jest/globals';
import { prepareAnimation } from '../animation/animation-tool.js';
import { rigFromModel, type ModelRigReading } from '../animation/model-rig.js';
import { buildTracks, pointToWorld, poseRig } from '../animation/motion.js';
import type { KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import type { Rig } from '../animation/rig.js';
import { partsBeetle, partsBird, partsSnake, SNAKE_JOINTS } from './fixtures/creatures.js';
import { kneeDeclarations, partsDog } from './fixtures/parts-dog.js';

const REFERENCE = 'apps/desktop/agent/skills/roblox-animation-vfx/references/creature-animation.md';
const GAITS = new Set(['DogWalk', 'DogTrot', 'DogRun', 'BeetleWalk']);
const GROUNDED = new Set(['DogIdle']);

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function recipes(): Map<string, { name: string; rig: string }> {
  const text = fs.readFileSync(path.join(repositoryRoot(), REFERENCE), 'utf8');
  const found = new Map<string, { name: string; rig: string }>();
  for (const match of text.matchAll(/```json creature\r?\n([\s\S]*?)```/g)) {
    const recipe = JSON.parse(match[1]) as { name: string; rig: string };
    found.set(recipe.name, recipe);
  }
  return found;
}

// The dog as the quadruped plan declares it: knees, the lower legs its feet,
// and ranges on its head and tail.
const dogDeclarations = { ...kneeDeclarations(), limits: { ...(kneeDeclarations().limits as object), Neck: { turn: 90 }, Tail: { turn: 90 } } };
const BODIES: Record<string, ModelRigReading> = {
  'game.Workspace.Dog': partsDog({ knees: true, declarations: dogDeclarations }),
  'game.Workspace.Beetle': partsBeetle(),
  'game.Workspace.Snake': partsSnake(),
  'game.Workspace.Bird': partsBird(),
};

function rigOf(recipe: { rig: string }): Rig {
  const result = rigFromModel(BODIES[recipe.rig]);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.rig;
}

function checked(recipe: { name: string; rig: string }) {
  const rig = rigOf(recipe);
  const result = prepareAnimation(recipe, { locomotion: GAITS.has(recipe.name), grounded: GROUNDED.has(recipe.name) }, rig);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return { rig, ...result.value };
}

const partsAt = (sequence: KeyframeSequenceDescription, rig: Rig, time: number) => poseRig(buildTracks(sequence), time, rig).parts;

describe('creature recipes', () => {
  const all = recipes();

  it('are all in the reference', () => {
    expect([...all.keys()].sort()).toEqual(['BeetleWalk', 'DogIdle', 'DogRun', 'DogTrot', 'DogWalk', 'Slither', 'WingFlap']);
  });

  it.each([...all.keys()])('%s compiles on its body and passes every check that applies', (name) => {
    const { report } = checked(all.get(name)!);
    expect(report.checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`)).toEqual([]);
    // Every joint that moves has a declared range, so nothing goes unjudged.
    expect(report.checks.find((check) => check.id === 'jointLimits')!.status).toBe('pass');
    if (GAITS.has(name)) {
      expect(report.checks.filter((check) => check.status === 'skipped')).toEqual([]);
      expect(report.groundSpeed).toBeGreaterThan(0);
    }
  });

  it('the dog walks one foot at a time, trots on diagonals, and runs hind feet then front', () => {
    const pattern = (name: string) => checked(all.get(name)!).report.checks.find((check) => check.id === 'gaitSymmetry')!.detail.split('landing ')[1];
    expect(pattern('DogWalk')).toBe('HindLeftLower, then FrontLeftLower, then HindRightLower, then FrontRightLower');
    expect(pattern('DogTrot')).toBe('FrontLeftLower with HindRightLower, then FrontRightLower with HindLeftLower');
    expect(pattern('DogRun')).toBe('HindLeftLower, then HindRightLower, then FrontLeftLower, then FrontRightLower');
  });

  it('the dog runs faster than it trots, and trots faster than it walks', () => {
    const speed = (name: string) => checked(all.get(name)!).report.groundSpeed!;
    expect(speed('DogTrot')).toBeGreaterThan(speed('DogWalk'));
    expect(speed('DogRun')).toBeGreaterThan(speed('DogTrot'));
  });

  it('a planted foot stays within 0.05 studs of its line', () => {
    for (const name of GAITS) {
      const { sequence, rig } = checked(all.get(name)!);
      for (const foot of rig.feet) {
        const point = rig.footPoints![foot][0];
        const rest = pointToWorld(partsAt(sequence, rig, 0).get(foot)!, point)[0];
        for (let step = 0; step < 60; step += 1) {
          const [x, y] = pointToWorld(partsAt(sequence, rig, (sequence.duration * step) / 60).get(foot)!, point);
          expect(Math.abs(x - rest)).toBeLessThan(0.05);
          expect(y - rig.ground).toBeGreaterThan(-0.05);
        }
      }
    }
  });

  it('the beetle walks on two sets of three: each foot lands with the two diagonal to it', () => {
    const detail = checked(all.get('BeetleWalk')!).report.checks.find((check) => check.id === 'gaitSymmetry')!.detail;
    expect(detail.split('landing ')[1]).toBe('LeftFrontLower with RightMidLower with LeftHindLower, then RightFrontLower with LeftMidLower with RightHindLower');
  });

  it('the slither\'s wave runs from head to tail', () => {
    const { sequence, rig } = checked(all.get('Slither')!);
    // When each segment swings furthest to its right, in rig order.
    const peaks = SNAKE_JOINTS.map((_joint, index) => {
      let best = { time: 0, x: -Infinity };
      for (let step = 0; step < 150; step += 1) {
        const time = (sequence.duration * step) / 150;
        const r = partsAt(sequence, rig, time).get(`Segment${index + 1}`)!.r;
        // How far the segment's length (its Z) has swung toward +X.
        if (r[2] > best.x) best = { time, x: r[2] };
      }
      return best.time;
    });
    // Each joint turns a 0.14 cycle after the one before; a segment's heading sums the turns above it.
    const unwrapped = peaks.map((time, index) => (index > 0 && time < peaks[0] ? time + sequence.duration : time));
    for (let index = 1; index < 4; index += 1) expect(unwrapped[index]).toBeGreaterThan(unwrapped[index - 1]);
  });

  it('both wings rise and fall together, tips trailing', () => {
    const { sequence, rig } = checked(all.get('WingFlap')!);
    let highest = -Infinity;
    let lowest = Infinity;
    for (let step = 0; step < 40; step += 1) {
      const parts = partsAt(sequence, rig, (sequence.duration * step) / 40);
      const left = pointToWorld(parts.get('WingLeftTip')!, [-0.75, 0, 0]);
      const right = pointToWorld(parts.get('WingRightTip')!, [0.75, 0, 0]);
      expect(left[1]).toBeCloseTo(right[1], 4);
      expect(left[0]).toBeCloseTo(-right[0], 4);
      highest = Math.max(highest, right[1]);
      lowest = Math.min(lowest, right[1]);
    }
    expect(highest - lowest).toBeGreaterThan(2);
  });
});
