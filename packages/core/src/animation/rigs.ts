// The rigs the animation tool can animate, by the name a pose description gives.

import { R15_RIG, type Rig } from './r15-rig.js';
import { R6_RIG } from './r6-rig.js';

export const RIGS: ReadonlyMap<string, Rig> = new Map([['R15', R15_RIG], ['R6', R6_RIG]]);

export const RIG_NAMES = [...RIGS.keys()] as readonly string[];

/** The rig a compiled sequence was made for. */
export function rigFor(name: string): Rig {
  const rig = RIGS.get(name);
  if (!rig) throw new Error(`unknown rig ${name}`);
  return rig;
}
