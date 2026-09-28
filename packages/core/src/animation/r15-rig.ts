// The stock R15 rig as Studio builds it, measured on Studio 0.740.19 by the
// second animation spike run (docs/animation-plan.md, "Live results"). The
// dummy came from CreateHumanoidModelFromDescription with a default
// HumanoidDescription; every joint was an AnimationConstraint.

export type Vec3 = readonly [number, number, number];

export interface RigJoint {
  /** The joint's name in the rig, e.g. "RightShoulder". */
  name: string;
  parentPart: string;
  /** The part a pose on this joint moves. Keyframe poses are named after it. */
  childPart: string;
  /** The joint's attachment position in the parent part, in studs. */
  parentOffset: Vec3;
  /** The joint's attachment position in the child part, in studs. */
  childOffset: Vec3;
}

export interface Rig {
  rootPart: string;
  hipHeight: number;
  /** Part sizes in studs (x, y, z). */
  parts: Readonly<Record<string, Vec3>>;
  /** Joints ordered parent before child. Every attachment rotation is the identity. */
  joints: readonly RigJoint[];
}

export const R15_RIG: Rig = {
  rootPart: 'HumanoidRootPart',
  hipHeight: 2.19,
  parts: {
    HumanoidRootPart: [2, 2, 1],
    LowerTorso: [1.99, 0.4, 1],
    UpperTorso: [1.94, 1.7, 1],
    Head: [1.16, 1.18, 1.16],
    LeftUpperArm: [1, 1.24, 1],
    LeftLowerArm: [1, 1.12, 1],
    LeftHand: [0.98, 0.32, 1.03],
    RightUpperArm: [1, 1.24, 1],
    RightLowerArm: [1, 1.12, 1],
    RightHand: [0.98, 0.32, 1.03],
    LeftUpperLeg: [0.99, 1.36, 0.97],
    LeftLowerLeg: [0.99, 1.3, 0.97],
    LeftFoot: [1.01, 0.31, 1],
    RightUpperLeg: [0.99, 1.36, 0.97],
    RightLowerLeg: [0.99, 1.3, 0.97],
    RightFoot: [1.01, 0.31, 1],
  },
  joints: [
    { name: 'Root', parentPart: 'HumanoidRootPart', childPart: 'LowerTorso', parentOffset: [0, -1, 0], childOffset: [0, -0.2, 0] },
    { name: 'Waist', parentPart: 'LowerTorso', childPart: 'UpperTorso', parentOffset: [0, 0.2, 0], childOffset: [0, -0.849, 0] },
    { name: 'Neck', parentPart: 'UpperTorso', childPart: 'Head', parentOffset: [0, 0.849, 0], childOffset: [0, -0.576, 0] },
    { name: 'LeftShoulder', parentPart: 'UpperTorso', childPart: 'LeftUpperArm', parentOffset: [-0.972, 0.598, 0], childOffset: [0.501, 0.419, 0] },
    { name: 'LeftElbow', parentPart: 'LeftUpperArm', childPart: 'LeftLowerArm', parentOffset: [0, -0.355, 0], childOffset: [0, 0.275, 0] },
    { name: 'LeftWrist', parentPart: 'LeftLowerArm', childPart: 'LeftHand', parentOffset: [0, -0.532, 0], childOffset: [0, 0.132, 0] },
    { name: 'RightShoulder', parentPart: 'UpperTorso', childPart: 'RightUpperArm', parentOffset: [0.972, 0.598, 0], childOffset: [-0.501, 0.419, 0] },
    { name: 'RightElbow', parentPart: 'RightUpperArm', childPart: 'RightLowerArm', parentOffset: [0, -0.355, 0], childOffset: [0, 0.275, 0] },
    { name: 'RightWrist', parentPart: 'RightLowerArm', childPart: 'RightHand', parentOffset: [0, -0.532, 0], childOffset: [0, 0.132, 0] },
    { name: 'LeftHip', parentPart: 'LowerTorso', childPart: 'LeftUpperLeg', parentOffset: [-0.5, -0.2, 0], childOffset: [0, 0.471, 0] },
    { name: 'LeftKnee', parentPart: 'LeftUpperLeg', childPart: 'LeftLowerLeg', parentOffset: [0, -0.449, 0], childOffset: [0, 0.413, 0] },
    { name: 'LeftAnkle', parentPart: 'LeftLowerLeg', childPart: 'LeftFoot', parentOffset: [0, -0.596, 0], childOffset: [0, 0.106, 0] },
    { name: 'RightHip', parentPart: 'LowerTorso', childPart: 'RightUpperLeg', parentOffset: [0.5, -0.2, 0], childOffset: [0, 0.471, 0] },
    { name: 'RightKnee', parentPart: 'RightUpperLeg', childPart: 'RightLowerLeg', parentOffset: [0, -0.449, 0], childOffset: [0, 0.413, 0] },
    { name: 'RightAnkle', parentPart: 'RightLowerLeg', childPart: 'RightFoot', parentOffset: [0, -0.596, 0], childOffset: [0, 0.106, 0] },
  ],
};
