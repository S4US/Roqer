// The classic R6 rig: six blocks moved by Motor6Ds, with no elbows, wrists,
// knees, ankles or waist. The offsets and turned frames are the Motor6D C0 and
// C1 every R6 character has had since Roblox introduced it; the live animation
// suite (tests/animation-tool.mjs) compares them with an R6 dummy's.
//
// The joints take the same names as their R15 counterparts, so a pose written
// as where the limbs point means the same on both rigs.

import {
  GRIP_ROTATION,
  OFF_HAND_PART,
  PROP_DRAW_OFFSETS,
  SHEATH_PART,
  SHEATH_ROTATION,
  SHEATH_STAND_IN_SIZE,
  WEAPON_PART,
  WEAPON_STAND_IN_SIZE,
  type Rig,
  type Rotation,
} from './r15-rig.js';

/** C0 and C1 of RootJoint and Neck: X flipped, Y and Z swapped. */
const TORSO_FRAME: Rotation = [-1, 0, 0, 0, 0, 1, 0, 1, 0];
/** C0 and C1 of the right shoulder and hip: turned 90° about Y. */
const RIGHT_FRAME: Rotation = [0, 0, 1, 0, 1, 0, -1, 0, 0];
/** C0 and C1 of the left shoulder and hip: turned -90° about Y. */
const LEFT_FRAME: Rotation = [0, 0, -1, 0, 1, 0, 1, 0, 0];

export const R6_RIG: Rig = {
  name: 'R6',
  rootPart: 'HumanoidRootPart',
  hipHeight: 0,
  // The legs hang 2 studs below a torso centred on the HumanoidRootPart.
  ground: -3,
  feet: ['Left Leg', 'Right Leg'],
  hips: ['LeftHip', 'RightHip'],
  body: 'Torso',
  // The far end of each block: the hand's end of an arm, the sole of a leg.
  limbs: {
    LeftShoulder: { end: [0, -1, 0] },
    RightShoulder: { end: [0, -1, 0] },
    LeftHip: { end: [0, -1, 0] },
    RightHip: { end: [0, -1, 0] },
  },
  drawOffsets: PROP_DRAW_OFFSETS,
  // Rigid legs cannot roll a foot flat, and the foot-sliding limit was
  // calibrated on Roblox's R15 animations only.
  uncheckedChecks: {
    footSliding: 'R6 legs are single blocks, and the foot-sliding limit is calibrated for R15 only',
  },
  parts: {
    HumanoidRootPart: [2, 2, 1],
    Torso: [2, 2, 1],
    Head: [2, 1, 1],
    'Left Arm': [1, 2, 1],
    'Right Arm': [1, 2, 1],
    'Left Leg': [1, 2, 1],
    'Right Leg': [1, 2, 1],
    [WEAPON_PART]: WEAPON_STAND_IN_SIZE,
    [OFF_HAND_PART]: WEAPON_STAND_IN_SIZE,
    [SHEATH_PART]: SHEATH_STAND_IN_SIZE,
  },
  joints: [
    { name: 'Root', parentPart: 'HumanoidRootPart', childPart: 'Torso', parentOffset: [0, 0, 0], childOffset: [0, 0, 0], parentRotation: TORSO_FRAME, childRotation: TORSO_FRAME },
    { name: 'Neck', parentPart: 'Torso', childPart: 'Head', parentOffset: [0, 1, 0], childOffset: [0, -0.5, 0], parentRotation: TORSO_FRAME, childRotation: TORSO_FRAME },
    { name: 'LeftShoulder', parentPart: 'Torso', childPart: 'Left Arm', parentOffset: [-1, 0.5, 0], childOffset: [0.5, 0.5, 0], parentRotation: LEFT_FRAME, childRotation: LEFT_FRAME },
    { name: 'RightShoulder', parentPart: 'Torso', childPart: 'Right Arm', parentOffset: [1, 0.5, 0], childOffset: [-0.5, 0.5, 0], parentRotation: RIGHT_FRAME, childRotation: RIGHT_FRAME },
    { name: 'LeftHip', parentPart: 'Torso', childPart: 'Left Leg', parentOffset: [-1, -1, 0], childOffset: [-0.5, 1, 0], parentRotation: LEFT_FRAME, childRotation: LEFT_FRAME },
    { name: 'RightHip', parentPart: 'Torso', childPart: 'Right Leg', parentOffset: [1, -1, 0], childOffset: [0.5, 1, 0], parentRotation: RIGHT_FRAME, childRotation: RIGHT_FRAME },
    { name: 'Weapon', parentPart: 'Right Arm', childPart: WEAPON_PART, parentOffset: [0, -1, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'RightGripAttachment' },
    { name: 'OffHand', parentPart: 'Left Arm', childPart: OFF_HAND_PART, parentOffset: [0, -1, 0], childOffset: [0, 0, 0], parentRotation: GRIP_ROTATION, optional: true, attachment: 'LeftGripAttachment' },
    // At the belt: the torso's bottom edge on its left side.
    { name: 'Sheath', parentPart: 'Torso', childPart: SHEATH_PART, parentOffset: [-1, -0.8, 0], childOffset: [0, 0, 0], parentRotation: SHEATH_ROTATION, optional: true },
  ],
};
