// The recipes the desktop agent adapts are held here to what their reference
// promises: each compiles, passes every motion check that applies, and makes
// the gesture it is named for.
import fs from 'fs';
import path from 'path';
import { compilePoseAnimation, type KeyframeSequenceDescription } from '../animation/pose-compiler.js';
import { checkMotion } from '../animation/motion-checks.js';
import { buildTracks, poseRig } from '../animation/motion.js';
import { sheetTimes } from '../animation/contact-sheet.js';

const REFERENCE = 'apps/desktop/agent/skills/roblox-animation-vfx/references/character-animation.md';
const GAITS = new Set(['Walk', 'Run']);

function repositoryRoot(): string {
  const cwd = process.cwd();
  return fs.existsSync(path.join(cwd, 'studio-plugin')) ? cwd : path.resolve(cwd, '../..');
}

function recipes(): Map<string, unknown> {
  const text = fs.readFileSync(path.join(repositoryRoot(), REFERENCE), 'utf8');
  const found = new Map<string, unknown>();
  for (const match of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) {
    const recipe = JSON.parse(match[1]) as { name: string };
    found.set(recipe.name, recipe);
  }
  return found;
}

function compiled(recipe: unknown): KeyframeSequenceDescription {
  const result = compilePoseAnimation(recipe);
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.sequence;
}

/** Where a part's centre is at a time, in the HumanoidRootPart's frame. */
function at(sequence: KeyframeSequenceDescription, time: number, part: string): number[] {
  return [...poseRig(buildTracks(sequence), time).parts.get(part)!.p];
}

describe('animation recipes', () => {
  const all = recipes();

  it('are all in the reference', () => {
    expect([...all.keys()].sort()).toEqual(['Idle', 'Jump', 'Run', 'Walk', 'Wave']);
  });

  it.each([...all.keys()])('%s compiles and passes every check that applies', (name) => {
    const report = checkMotion(compiled(all.get(name)), { locomotion: GAITS.has(name) });
    const failing = report.checks.filter((check) => check.status === 'fail').map((check) => `${check.id}: ${check.detail}`);
    expect(failing).toEqual([]);
    if (GAITS.has(name)) {
      expect(report.checks.filter((check) => check.status === 'skipped')).toEqual([]);
    }
  });

  it('waves the right hand above the head, out to the side', () => {
    const wave = compiled(all.get('Wave'));
    for (const time of sheetTimes(wave)) {
      const hand = at(wave, time, 'RightHand');
      const head = at(wave, time, 'Head');
      expect(hand[1]).toBeGreaterThan(head[1]);
      expect(hand[0]).toBeGreaterThan(1);
    }
    // The forearm swings: the hand travels between the ends of the wave.
    expect(Math.abs(at(wave, 0, 'RightHand')[0] - at(wave, 0.3, 'RightHand')[0])).toBeGreaterThan(0.4);
    // The left arm stays at rest.
    expect(at(wave, 0.3, 'LeftHand')[1]).toBeLessThan(at(wave, 0.3, 'LowerTorso')[1]);
  });

  it.each(['Walk', 'Run'])('%s strides with opposite arms and legs', (name) => {
    const gait = compiled(all.get(name));
    // Forward is -Z. At the first contact the left foot leads and the left hand trails.
    expect(at(gait, 0, 'LeftFoot')[2]).toBeLessThan(at(gait, 0, 'RightFoot')[2] - 0.8);
    expect(at(gait, 0, 'LeftHand')[2]).toBeGreaterThan(at(gait, 0, 'RightHand')[2]);
    const half = gait.keyframes[2].time;
    expect(at(gait, half, 'RightFoot')[2]).toBeLessThan(at(gait, half, 'LeftFoot')[2] - 0.8);
  });

  it('throws both arms up for the jump', () => {
    const jump = compiled(all.get('Jump'));
    const end = jump.keyframes[jump.keyframes.length - 1].time;
    const head = at(jump, end, 'Head');
    expect(at(jump, end, 'LeftHand')[1]).toBeGreaterThan(head[1]);
    expect(at(jump, end, 'RightHand')[1]).toBeGreaterThan(head[1]);
  });
});
