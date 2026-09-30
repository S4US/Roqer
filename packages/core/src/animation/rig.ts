// What an animation is written for: a body's parts, the joints between them,
// and what their geometry cannot say. R15 and R6 are built in (r15-rig.ts,
// r6-rig.ts); any other rig is read from its model in Studio (model-rig.ts).
// The compiler, the checks and the previews read this description, never a
// rig's name, so every rig takes one path (docs/creature-plan.md, "Rigs read
// from Studio").

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
   * The joint frame's orientation in the body's axes at rest, when that is
   * not parentRotation: on a rig read from a model whose parts do not all
   * rest upright. A pose's rotation is written in these axes, so it means the
   * same on every rig.
   */
  restRotation?: Rotation;
  /**
   * A joint a character has only while it holds something, such as the
   * weapon grip. It is previewed and verified only when an animation keys it.
   */
  optional?: boolean;
  /**
   * For a prop: the attachment in the parent part whose Position the game
   * uses as the motor's C0 position, so the prop follows a scaled avatar's
   * hand. C0's rotation is always parentRotation: the attachments' own turn
   * differs between rigs (R15's grips are turned -90° about X, R6's are not,
   * measured by tests/animation-tool.mjs), and a prop points the same way on
   * both. Without an attachment, C0 is parentOffset and parentRotation.
   */
  attachment?: string;
}

/** An elbow or a knee: a joint that bends about one of the body's axes at rest. */
export interface RigHinge {
  axis: 'X' | 'Y' | 'Z';
  /** The sign of the turn about the axis that flexes it: R15's elbows +1, its knees -1. */
  flex: 1 | -1;
}

/**
 * A limb that `aim` points and `aimAt` reaches with, keyed by the joint at its
 * root (a shoulder or hip).
 */
export interface RigLimb {
  /** The hinge that bends it, if any. */
  hinge?: string;
  /** The point that lands on an aimAt's target, in the last part's frame (the hinge's child, or the joint's own). */
  end: Vec3;
  /** A joint aimAt also keys, to lay the foot flat. */
  foot?: string;
  /** Where grip holds a handle, when not at the end: the hand's centre with the wrist straight. */
  hand?: Vec3;
  /** The way the limb runs from its root at rest, in the body's axes: the axis `aim` points. */
  axis: Vec3;
  /**
   * Where the limb's lower half swings as its hinge flexes, in the body's
   * axes at rest, square to `axis`: a forearm folds forward (-Z), a shin back
   * (+Z). A pose with no `bendToward` folds it this way.
   */
  fold: Vec3;
}

/**
 * How far a joint may turn. `free` joints turn any way: the root, which turns
 * the whole body, and a held prop. A range is a hinge's, signed about its axis.
 */
export type RigJointLimit = 'free' | { turn: number } | { min: number; max: number; offAxis: number };

export interface Rig {
  /** R15, R6, or the path of the model the rig was read from. */
  name: string;
  /** For a rig read from Studio, the revision its joints and declarations had. */
  revision?: string;
  rootPart: string;
  /** The joint that moves the whole body and takes a pose's `position`; absent when no one joint does. */
  rootJoint?: string;
  hipHeight: number;
  /** The ground's height in the root part's frame, in studs. */
  ground: number;
  /** The parts that stand on the ground; R15 and R6 list theirs left then right. */
  feet: readonly string[];
  /** A biped's hip joints, left then right, whose swing the gait symmetry check compares. */
  hips?: readonly [string, string];
  /** The part heading and the body's shadow follow. */
  body: string;
  limbs: Readonly<Record<string, RigLimb>>;
  hinges: Readonly<Record<string, RigHinge>>;
  /** Each joint's limit; a joint without one is reported as not checked. */
  limits: Readonly<Record<string, RigJointLimit>>;
  /** How errors name the limbs and hinges: R15's "shoulders and hips" and "elbows and knees". */
  words?: { limbs: string; hinges: string };
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
  /**
   * On a rig that is not R15 or R6: the factor its distance limits are R15's
   * calibrated ones scaled by, and what it was measured from. R15 and R6 keep
   * their own limits.
   */
  scale?: { factor: number; basis: string };
  /** Parts not drawn, such as an invisible root; absent, every part but the root part is drawn. */
  hidden?: readonly string[];
  /** Part sizes in studs (x, y, z). */
  parts: Readonly<Record<string, Vec3>>;
  /** Joints ordered parent before child. */
  joints: readonly RigJoint[];
}

/** The rotation a pose on this joint is written in: its frame's orientation in the body's axes at rest. */
export function jointAxes(joint: RigJoint): Rotation | undefined {
  return joint.restRotation ?? joint.parentRotation;
}
