// The Parts dog of parts-dog.ts before it is rigged, as the plugin reads a
// model's pieces for rig's build form: every part where it stands in the world,
// no joints, and the call that joins them. Its legs have knees; wedge ears and a
// ball nose ride on its head. It may stand anywhere, turned about the vertical.
import type { PiecesReading, RigBuildJoint } from '../../animation/rig-build.js';
import { LEG_ROOTS, type V } from './parts-dog.js';

/** The dog's frame: where its body's centre stands, turned `turn` degrees about Y. */
export function dogFrame(at: V = [0, 2.2, 0], turn = 0) {
  const a = (turn * Math.PI) / 180;
  const [c, s] = [Math.cos(a), Math.sin(a)];
  const r = [c, 0, s, 0, 1, 0, -s, 0, c];
  const place = (v: V): V => [at[0] + r[0] * v[0] + r[2] * v[2], at[1] + v[1], at[2] + r[6] * v[0] + r[8] * v[2]];
  return { r, place, cframe: (v: V) => [...place(v), ...r] };
}

export function dogPieces(options: { at?: V; turn?: number } = {}): PiecesReading {
  const frame = dogFrame(options.at, options.turn);
  const parts: PiecesReading['parts'] = [
    { name: 'Body', cframe: frame.cframe([0, 0, 0]), size: [2, 1.2, 4] },
    { name: 'Head', cframe: frame.cframe([0, 0.8, -2.6]), size: [1.2, 1.2, 1.4] },
    { name: 'Tail', cframe: frame.cframe([0, 0.3, 2.7]), size: [0.3, 0.3, 1.6] },
    { name: 'LeftEar', cframe: frame.cframe([-0.4, 1.65, -2.4]), size: [0.3, 0.5, 0.3], shape: 'Wedge' },
    { name: 'RightEar', cframe: frame.cframe([0.4, 1.65, -2.4]), size: [0.3, 0.5, 0.3], shape: 'Wedge' },
    { name: 'Nose', cframe: frame.cframe([0, 0.7, -3.4]), size: [0.4, 0.4, 0.4], shape: 'Ball' },
  ];
  for (const [leg, [x, y, z]] of Object.entries(LEG_ROOTS)) {
    parts.push({ name: `${leg}Upper`, cframe: frame.cframe([x, y - 0.4, z]), size: [0.5, 0.8, 0.5] });
    parts.push({ name: `${leg}Lower`, cframe: frame.cframe([x, y - 1.2, z]), size: [0.5, 0.8, 0.5] });
  }
  return {
    path: 'game.Workspace.Dog',
    revision: 'rp1:pieces',
    pivot: frame.cframe([0, 0, 0]),
    parts,
    joints: [],
    welds: [],
    controllers: [],
  };
}

/** The joints that rig the dog: the neck, hips, knees and tail at their pivots, the ears and nose with the head. */
export function dogJoints(options: { at?: V; turn?: number } = {}): RigBuildJoint[] {
  const frame = dogFrame(options.at, options.turn);
  const joints: RigBuildJoint[] = [
    { part: 'Head', parent: 'Body', pivot: frame.place([0, 0.4, -2]), name: 'Neck', with: ['LeftEar', 'RightEar', 'Nose'] },
  ];
  for (const [leg, [x, y, z]] of Object.entries(LEG_ROOTS)) {
    joints.push({ part: `${leg}Upper`, parent: 'Body', pivot: frame.place([x, y, z]), name: leg });
    joints.push({ part: `${leg}Lower`, parent: `${leg}Upper`, pivot: frame.place([x, y - 0.8, z]), name: `${leg}Knee` });
  }
  joints.push({ part: 'Tail', parent: 'Body', pivot: frame.place([0, 0.3, 1.9]) });
  return joints;
}
