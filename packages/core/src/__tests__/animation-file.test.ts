// An animation baked in Blender reaches the tool as a file (docs/creature-plan.md,
// step 8): the pose description is read from it and checked as one given
// inline is, and the skeleton it was made on is compared with the rig's, so
// rotations made on a body of another shape are refused rather than played.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, test } from '@jest/globals';
import { BridgeService } from '../bridge-service.js';
import { rigFromModel } from '../animation/model-rig.js';
import { compilePoseAnimation } from '../animation/pose-compiler.js';
import { RobloxStudioTools } from '../tools/index.js';
import { skinnedSnake, SNAKE_BONES } from './fixtures/skinned.js';

const body = (result: { content: { text?: string }[] }) => JSON.parse(result.content[0].text!);

function written(name: string, contents: string): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'roqer-animation-file-')), name);
  fs.writeFileSync(file, contents);
  return file;
}

const wave = {
  name: 'Wave', rig: 'R15', loop: false,
  keyframes: [
    { time: 0, joints: { RightShoulder: { rotation: [0, 0, 0] } } },
    { time: 0.5, joints: { RightShoulder: { rotation: [0, 0, 60] } } },
  ],
};

describe('animation_file', () => {
  const tools = () => new RobloxStudioTools(new BridgeService());

  test('is read in place of animation, and checked as one given inline is', async () => {
    const file = written('Wave.animation.json', JSON.stringify(wave));
    const fromFile = body(await tools().animation({ action: 'check', animation_file: file }));
    const inline = body(await tools().animation({ action: 'check', animation: wave }));
    expect(fromFile.valid).toBe(true);
    expect(fromFile.animation).toEqual(inline.animation);
    expect(fromFile.checks).toEqual(inline.checks);
    // What is wrong in the file is reported as it would be inline.
    const bad = written('Bad.animation.json', JSON.stringify({ ...wave, keyframes: [{ time: 0, joints: { Elbow: { rotation: [0, 0, 0] } } }] }));
    expect(body(await tools().animation({ action: 'check', animation_file: bad })).errors.join('\n')).toMatch(/Elbow/);
  });

  test('must be a pose description\'s own file, alone, for an action that takes one', async () => {
    const file = written('Wave.animation.json', JSON.stringify(wave));
    await expect(tools().animation({ action: 'check', animation_file: file, animation: wave })).rejects.toThrow(/animation or animation_file, not both/);
    await expect(tools().animation({ action: 'publish', animation_file: file })).rejects.toThrow(/goes with check, build or verify/);
    await expect(tools().animation({ action: 'check', animation_file: 'Wave.animation.json' })).rejects.toThrow(/absolute path/);
    await expect(tools().animation({ action: 'check', animation_file: written('notes.json', '{}') })).rejects.toThrow(/named \*\.animation\.json/);
    await expect(tools().animation({ action: 'check', animation_file: path.join(os.tmpdir(), 'none', 'Gone.animation.json') })).rejects.toThrow(/could not be read/);
    await expect(tools().animation({ action: 'check', animation_file: written('Text.animation.json', 'not json') })).rejects.toThrow(/does not hold JSON/);
    await expect(tools().animation({ action: 'check', animation_file: written('List.animation.json', '[1, 2]') })).rejects.toThrow(/one pose description/);
  });
});

describe('an animation\'s skeleton', () => {
  const read = rigFromModel(skinnedSnake({ version: 1, limits: Object.fromEntries(SNAKE_BONES.slice(1).map((name) => [name, { turn: 60 }])) }));
  if (!read.ok) throw new Error(read.errors.join('\n'));
  const rig = read.rig;
  // Each bone a stud ahead of the one before: toward -Z in the body's axes.
  const skeleton = (change: Record<string, unknown> = {}) => ({
    ...Object.fromEntries(SNAKE_BONES.slice(1).map((name, index) => [name, { parent: SNAKE_BONES[index], offset: [0, 0, -1] }])),
    ...change,
  });
  const animation = (bones: Record<string, unknown>) => ({
    name: 'Bend', rig: rig.name, loop: false, skeleton: bones,
    keyframes: [{ time: 0, joints: { Bone004: { rotation: [0, 0, 0] } } }, { time: 1, joints: { Bone004: { rotation: [0, 30, 0] } } }],
  });
  const errors = (bones: Record<string, unknown>) => {
    const result = compilePoseAnimation(animation(bones), rig);
    return result.ok ? [] : result.errors;
  };

  test('that is the rig\'s compiles, within a tolerance of where each joint stands', () => {
    expect(errors(skeleton())).toEqual([]);
    expect(errors(skeleton({ Bone005: { parent: 'Bone004', offset: [0, 0.03, -1.02] } }))).toEqual([]);
    // A joint with no parent given is only checked to exist.
    expect(errors({ Bone000: {} })).toEqual([]);
  });

  test('of another shape is refused, naming each joint that differs', () => {
    expect(errors(skeleton({ Bone005: { parent: 'Bone004', offset: [0, 0, -1.5] } }))[0])
      .toBe('skeleton: the animation was made on a rig that is not this one: Bone005 stands [0, 0, -1.5] from Bone004 there and [0, 0, -1] here. Animate the model that was uploaded, or upload and rig this one again');
    expect(errors(skeleton({ Bone005: { parent: 'Bone002', offset: [0, 0, -1] } }))[0]).toMatch(/Bone005 hangs from Bone002 there and from Bone004 here/);
    expect(errors(skeleton({ Fin: { parent: 'Bone004', offset: [0, 1, 0] } }))[0]).toMatch(/Fin is not a joint of game\.Workspace\.SkinnedSnake/);
    // More than five are counted, not listed.
    const all = skeleton(Object.fromEntries(SNAKE_BONES.slice(1).map((name, index) => [name, { parent: SNAKE_BONES[index], offset: [0, 0, -2] }])));
    expect(errors(all)[0]).toMatch(/; and 2 more\. Animate the model/);
  });

  test('that is malformed says how', () => {
    expect(errors('bones' as unknown as Record<string, unknown>)[0]).toMatch(/skeleton: must be an object of joint name/);
    expect(errors({ Bone005: { parent: 'Bone004', offset: [0, 'one', 0] } })[0]).toMatch(/skeleton\.Bone005\.offset: must be \[x, y, z\]/);
  });
});
