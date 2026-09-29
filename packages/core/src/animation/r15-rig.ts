// The stock R15 rig as Studio builds it, measured on Studio 0.740.19 by the
// second animation spike run (docs/animation-plan.md, "Live results"). The
// dummy came from CreateHumanoidModelFromDescription with a default
// HumanoidDescription; every joint was an AnimationConstraint.

export type Vec3 = readonly [number, number, number];
/** A rotation, row-major, as CFrame components 4 to 12. */
export type Rotation = readonly [number, number, number, number, number, number, number, number, number];

export const IDENTITY_ROTATION: Rotation = [1, 0, 0, 0, 1, 0, 0, 0, 1];

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
  /**
   * The joint frame's rotation in the parent part (Motor6D.C0's rotation);
   * the identity when absent, as on every body joint of the stock R15 rig.
   */
  parentRotation?: Rotation;
  /** The joint frame's rotation in the child part (Motor6D.C1's rotation). */
  childRotation?: Rotation;
  /**
   * A joint a character has only while it holds something, such as the
   * weapon grip. It is previewed and verified only when an animation keys it.
   */
  optional?: boolean;
  /**
   * For a prop: the attachment in the parent part whose CFrame the game uses
   * as the motor's C0. Without one, C0 is parentOffset and parentRotation.
   */
  attachment?: string;
}

export interface Rig {
  name: 'R15' | 'R6';
  rootPart: string;
  hipHeight: number;
  /** The ground's height in the HumanoidRootPart's frame, in studs. */
  ground: number;
  /** The parts that stand on the ground, left then right. */
  feet: readonly [string, string];
  /** The joints that swing the legs, left then right. */
  hips: readonly [string, string];
  /** The part the body's shadow is drawn under. */
  body: string;
  /**
   * The limbs `aimAt` reaches with, by the joint at their root (a shoulder or
   * hip): the hinge that bends them, if any, and the point that lands on the
   * target, in the last part's frame (the hinge's child, or the joint's own).
   */
  limbs: Readonly<Record<string, { hinge?: string; end: Vec3; foot?: string; hand?: Vec3 }>>;
  /**
   * Where a drawn stand-in's box sits in its part, when not at its centre:
   * the weapon's blade runs out of the fist rather than through it.
   */
  drawOffsets?: Readonly<Record<string, Vec3>>;
  /**
   * Motion checks that cannot judge this rig yet, by check id, with why. They
   * are reported as skipped, never as passed.
   */
  uncheckedChecks?: Readonly<Record<string, string>>;
  /** Part sizes in studs (x, y, z). */
  parts: Readonly<Record<string, Vec3>>;
  /** Joints ordered parent before child. */
  joints: readonly RigJoint[];
}

/** Rx(-90°): the grip attachment's frame in the hand, its +Y out of the fist toward the character's front at rest. */
export const GRIP_ROTATION: Rotation = [1, 0, 0, 0, 0, 1, 0, -1, 0];

/** Rx(100°): the sheath's frame at the hip, its +Y running back and a little down at rest. */
export const SHEATH_ROTATION: Rotation = [1, 0, 0, 0, -0.173648, -0.984808, 0, 0.984808, -0.173648];

/**
 * The weapon: a Motor6D from the hand to a part named BodyAttach that the
 * weapon's other parts are welded to, with C0 at the hand's RightGripAttachment
 * and C1 the identity. Roblox's own RightGrip weld cannot be animated, so a
 * game swaps in this motor when the weapon is equipped.
 */
export const WEAPON_PART = 'BodyAttach';
/** A 4-stud stand-in blade, for previews: along BodyAttach's +Y, from just below the fist. */
export const WEAPON_STAND_IN_SIZE: Vec3 = [0.15, 4, 0.35];
export const WEAPON_STAND_IN_OFFSET: Vec3 = [0, 1.6, 0];

/** The off hand's prop, as the weapon is the right hand's: a second blade, a shield, a held sheath. */
export const OFF_HAND_PART = 'OffHandAttach';

/**
 * A sheath worn at the left hip: a Motor6D from the lower torso (R6: the
 * torso) to a part named SheathAttach at the sheath's mouth, whose C0 the
 * game sets to the rig's constant. The sheath runs along SheathAttach's +Y.
 */
export const SHEATH_PART = 'SheathAttach';
/** A 3.8-stud stand-in sheath, for previews: along SheathAttach's +Y from its mouth. */
export const SHEATH_STAND_IN_SIZE: Vec3 = [0.25, 3.8, 0.4];
export const SHEATH_STAND_IN_OFFSET: Vec3 = [0, 1.9, 0];

/** Stand-ins for every prop, where their boxes sit in their parts. */
export const PROP_DRAW_OFFSETS: Readonly<Record<string, Vec3>> = {
  [WEAPON_PART]: WEAPON_STAND_IN_OFFSET,
  [OFF_HAND_PART]: WEAPON_STAND_IN_OFFSET,
  [SHEATH_PART]: SHEATH_STAND_IN_OFFSET,
};

export const R15_RIG: Rig = {
  name: 'R15',
  rootPart: 'HumanoidRootPart',
  hipHeight: 2.19,
  ground: -(2.19 + 2 / 2),
  feet: ['LeftFoot', 'RightFoot'],
  hips: ['LeftHip', 'RightHip'],
  body: 'LowerTorso',
  // The wrist and the ankle: an ankle stands 0.26 studs above the ground.
  limbs: {
    // An arm's hand: the hand's centre with the wrist straight, which grip holds on the weapon.
    LeftShoulder: { hinge: 'LeftElbow', end: [0, -0.532, 0], hand: [0, -0.664, 0] },
    RightShoulder: { hinge: 'RightElbow', end: [0, -0.532, 0] },
    // A leg's aimAt also keys its ankle, to lay the foot flat.
    LeftHip: { hinge: 'LeftKnee', end: [0, -0.596, 0], foot: 'LeftAnkle' },
    RightHip: { hinge: 'RightKnee', end: [0, -0.596, 0], foot: 'RightAnkle' },
  },
  drawOffsets: PROP_DRAW_OFFSETS,
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
    [WEAPON_PART]: WEAPON_STAND_IN_SIZE,
    [OFF_HAND_PART]: WEAPON_STAND_IN_SIZE,
    [SHEATH_PART]: SHEATH_STAND_IN_SIZE,
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
    // RightGripAttachment's position is not in the spike's measurements; the
    // live animation suite compares it with the dummy's. Only the preview's
    // drawing depends on it: Studio's playback is compared joint by joint.
    { name: 'Weapon', parentPart: 'RightHand', childPart: WEAPON_PART, parentOffset: [0, -0.15, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'RightGripAttachment' },
    { name: 'OffHand', parentPart: 'LeftHand', childPart: OFF_HAND_PART, parentOffset: [0, -0.15, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'LeftGripAttachment' },
    { name: 'Sheath', parentPart: 'LowerTorso', childPart: SHEATH_PART, parentOffset: [-1, 0, 0], childOffset: [0, 0, 0], parentRotation: SHEATH_ROTATION, optional: true },
  ],
};
