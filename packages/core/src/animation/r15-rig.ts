// The stock R15 rig as Studio builds it, measured on Studio 0.740.19 by the
// second animation spike run (docs/animation-plan.md, "Live results"). The
// dummy came from CreateHumanoidModelFromDescription with a default
// HumanoidDescription; every joint was an AnimationConstraint.

import type { Rig, RigJointLimit, RigLimb, Rotation, Vec3 } from './rig.js';

export { IDENTITY_ROTATION, type Rig, type RigJoint, type Rotation, type Vec3 } from './rig.js';

/** Rx(-90°): the grip attachment's frame in the hand, its +Y out of the fist toward the character's front at rest. */
export const GRIP_ROTATION: Rotation = [1, 0, 0, 0, 0, 1, 0, -1, 0];

/** Rx(100°): the sheath's frame at the hip, its +Y running back and a little down at rest. */
export const SHEATH_ROTATION: Rotation = [1, 0, 0, 0, -0.173648, -0.984808, 0, 0.984808, -0.173648];

/**
 * The weapon: a Motor6D from the hand to a part named BodyAttach that the
 * weapon's other parts are welded to, with C0 at the position of the hand's
 * RightGripAttachment, turned by GRIP_ROTATION, and C1 the identity. Roblox's own RightGrip weld cannot be animated, so a
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

/** A limb that hangs at rest: `aim` points its -Y. */
export const HANGING: Vec3 = [0, -1, 0];
/** Where an arm's forearm folds as its elbow flexes: forward (-Z). */
export const ARM_FOLD: Vec3 = [0, 0, -1];
/** Where a leg's shin folds as its knee flexes: back (+Z). */
export const LEG_FOLD: Vec3 = [0, 0, 1];

/** The errors' names for a character's limbs and hinges. */
export const CHARACTER_WORDS = { limbs: 'shoulders and hips', hinges: 'elbows and knees' } as const;

/**
 * How far each R15 joint may turn. The limits let Roblox's own R15 animations
 * pass, with a margin: the live calibration run
 * (tests/animation-calibration.mjs) measured the 26 animations of the
 * default Animate script, and the animation plan's "Live results" records it.
 *
 * A turn is the largest from rest, in degrees, for joints that turn freely.
 * Anatomical; Roblox's worst: shoulder 160 (climb), hip 111 (laugh), wrist 64
 * and ankle 39 (swim), neck 56 (idle), waist 45 (laugh).
 *
 * A hinge's range is signed about X: an elbow bends the forearm forward (+X),
 * a knee bends the shin back (-X). Roblox's worst: knees -143 to 4.3 (run,
 * cheer), elbows -6.7 to 123 (jump, swim), 17° off axis (dance3).
 *
 * Root turns the whole body, and a held or worn prop turns as the game needs.
 */
export const R15_JOINT_LIMITS: Readonly<Record<string, RigJointLimit>> = {
  Root: 'free',
  Waist: { turn: 90 },
  Neck: { turn: 90 },
  LeftShoulder: { turn: 180 },
  RightShoulder: { turn: 180 },
  LeftElbow: { min: -15, max: 160, offAxis: 35 },
  RightElbow: { min: -15, max: 160, offAxis: 35 },
  LeftWrist: { turn: 100 },
  RightWrist: { turn: 100 },
  LeftHip: { turn: 150 },
  RightHip: { turn: 150 },
  LeftKnee: { min: -160, max: 10, offAxis: 35 },
  RightKnee: { min: -160, max: 10, offAxis: 35 },
  LeftAnkle: { turn: 80 },
  RightAnkle: { turn: 80 },
  Weapon: 'free',
  OffHand: 'free',
  Sheath: 'free',
};

// The wrist and the ankle: an ankle stands 0.26 studs above the ground.
const R15_LIMBS: Readonly<Record<string, RigLimb>> = {
  // An arm's hand: the hand's centre with the wrist straight, which grip holds on the weapon.
  LeftShoulder: { hinge: 'LeftElbow', end: [0, -0.532, 0], hand: [0, -0.664, 0], axis: HANGING, fold: ARM_FOLD },
  RightShoulder: { hinge: 'RightElbow', end: [0, -0.532, 0], axis: HANGING, fold: ARM_FOLD },
  // A leg's aimAt also keys its ankle, to lay the foot flat.
  LeftHip: { hinge: 'LeftKnee', end: [0, -0.596, 0], foot: 'LeftAnkle', axis: HANGING, fold: LEG_FOLD },
  RightHip: { hinge: 'RightKnee', end: [0, -0.596, 0], foot: 'RightAnkle', axis: HANGING, fold: LEG_FOLD },
};

export const R15_RIG: Rig = {
  name: 'R15',
  rootPart: 'HumanoidRootPart',
  rootJoint: 'Root',
  hipHeight: 2.19,
  ground: -(2.19 + 2 / 2),
  feet: ['LeftFoot', 'RightFoot'],
  hips: ['LeftHip', 'RightHip'],
  body: 'LowerTorso',
  limbs: R15_LIMBS,
  hinges: {
    LeftElbow: { axis: 'X', flex: 1 },
    RightElbow: { axis: 'X', flex: 1 },
    LeftKnee: { axis: 'X', flex: -1 },
    RightKnee: { axis: 'X', flex: -1 },
  },
  limits: R15_JOINT_LIMITS,
  words: CHARACTER_WORDS,
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
    // The grips' position as tests/animation-tool.mjs measured it on the
    // default dummy (0, -0.158, 0). Only the preview's drawing depends on it:
    // the game takes the attachment's, and playback is compared joint by joint.
    { name: 'Weapon', parentPart: 'RightHand', childPart: WEAPON_PART, parentOffset: [0, -0.158, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'RightGripAttachment' },
    { name: 'OffHand', parentPart: 'LeftHand', childPart: OFF_HAND_PART, parentOffset: [0, -0.158, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'LeftGripAttachment' },
    { name: 'Sheath', parentPart: 'LowerTorso', childPart: SHEATH_PART, parentOffset: [-1, 0, 0], childOffset: [0, 0, 0], parentRotation: SHEATH_ROTATION, optional: true },
  ],
};
