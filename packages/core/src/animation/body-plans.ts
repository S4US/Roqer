// Body plans: RoqerRig declarations filled in from the names of the pieces a
// rig joins, as R15's names say which parts are its legs (docs/creature-plan.md,
// "Declarations on the model"). The animation skill fixes each plan's names.
// A plan only fills in what the names show; declarations given with it win,
// joint by joint.

/** The plans `rig` fills declarations in from; `custom` declares only what is given. */
export const BODY_PLANS = ['quadruped', 'custom'] as const;
export type BodyPlan = (typeof BODY_PLANS)[number];

/** A joint as a plan sees it: its name and the parts it joins. */
export interface PlanJoint {
  name: string;
  parentPart: string;
  childPart: string;
}

/** RoqerRig version 1, as an object; rig-declarations.ts validates it. */
export interface RigDeclarations {
  version: 1;
  feet?: string[] | Record<string, number[][]>;
  hips?: [string, string];
  limbs?: Record<string, Record<string, unknown>>;
  hinges?: Record<string, { axis: 'X' | 'Y' | 'Z'; flex: 1 | -1 }>;
  limits?: Record<string, unknown>;
}

/**
 * A quadruped's legs, front then hind, left then right. A leg is one piece
 * (`FrontLeft`), or an upper and a lower piece (`FrontLeftUpper`,
 * `FrontLeftLower`) and optionally a foot (`FrontLeftFoot`).
 */
const QUADRUPED_LEGS = ['FrontLeft', 'FrontRight', 'HindLeft', 'HindRight'] as const;

/**
 * A lower leg folds back on a front leg and forward on a hind leg, as a
 * horse's knee and hock do; flex is the sign of the turn about X that folds it
 * (R15's knee is -1, its shin folding back).
 */
const QUADRUPED_FOLD = { Front: -1, Hind: 1 } as const;

/** Turn limits, degrees from rest: generous, since no creature animation calibrates them. */
const QUADRUPED_LIMITS = {
  leg: { turn: 120 },
  foot: { turn: 80 },
  head: { turn: 90 },
  jaw: { turn: 45 },
  tail: { turn: 90 },
} as const;

/** A lower leg's range, signed about X: up to 160° the way it folds, 10° the other. */
function foldRange(flex: 1 | -1) {
  return flex === 1 ? { min: -10, max: 160 } : { min: -160, max: 10 };
}

function quadruped(joints: readonly PlanJoint[]): RigDeclarations {
  const moving = new Map(joints.map((joint) => [joint.childPart, joint]));
  const feet: string[] = [];
  const limbs: Record<string, Record<string, unknown>> = {};
  const hinges: Record<string, { axis: 'X'; flex: 1 | -1 }> = {};
  const limits: Record<string, unknown> = {};
  for (const leg of QUADRUPED_LEGS) {
    const upper = moving.get(`${leg}Upper`) ?? moving.get(leg);
    if (!upper) continue;
    const lower = moving.get(`${leg}Lower`);
    const knee = lower && lower.parentPart === upper.childPart ? lower : undefined;
    const paw = moving.get(`${leg}Foot`);
    const foot = paw && knee && paw.parentPart === knee.childPart ? paw : undefined;
    const flex = QUADRUPED_FOLD[leg.startsWith('Front') ? 'Front' : 'Hind'];
    limbs[upper.name] = { ...(knee ? { hinge: knee.name } : {}), ...(foot ? { foot: foot.name } : {}) };
    limits[upper.name] = QUADRUPED_LIMITS.leg;
    if (knee) {
      hinges[knee.name] = { axis: 'X', flex };
      limits[knee.name] = foldRange(flex);
    }
    if (foot) limits[foot.name] = QUADRUPED_LIMITS.foot;
    feet.push((foot ?? knee ?? upper).childPart);
  }
  for (const joint of joints) {
    if (joint.childPart === 'Head') limits[joint.name] = QUADRUPED_LIMITS.head;
    else if (joint.childPart === 'Jaw') limits[joint.name] = QUADRUPED_LIMITS.jaw;
    else if (/^Tail\d*$/.test(joint.childPart)) limits[joint.name] = QUADRUPED_LIMITS.tail;
  }
  return {
    version: 1,
    ...(feet.length > 0 ? { feet } : {}),
    ...(Object.keys(limbs).length > 0 ? { limbs } : {}),
    ...(Object.keys(hinges).length > 0 ? { hinges } : {}),
    ...(Object.keys(limits).length > 0 ? { limits } : {}),
  };
}

/** What a plan declares for a rig's joints, before anything given with it. */
export function planDeclarations(plan: BodyPlan, joints: readonly PlanJoint[]): RigDeclarations {
  return plan === 'quadruped' ? quadruped(joints) : { version: 1 };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A plan's declarations with those given laid over them: feet and hips as
 * given, and limbs, hinges and limits joint by joint. What is given is not
 * checked here; the rig it makes is (rig-declarations.ts).
 */
export function mergeDeclarations(planned: RigDeclarations, given: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!given) return { ...planned };
  const merged: Record<string, unknown> = { ...planned };
  for (const [key, value] of Object.entries(given)) {
    const base = (planned as unknown as Record<string, unknown>)[key];
    merged[key] = ['limbs', 'hinges', 'limits'].includes(key) && isRecord(base) && isRecord(value) ? { ...base, ...value } : value;
  }
  return merged;
}
