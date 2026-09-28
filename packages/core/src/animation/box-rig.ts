// The R15 rig as boxes, one per part, sized as the stock rig's parts are.
// Both the contact sheet and the 3D preview draw it: the model sees the same
// figure the user plays back.

import { R15_RIG, type Rig } from './r15-rig.js';

export type Rgb = readonly [number, number, number];

/** Left limbs blue and right limbs orange, so a gait's phase reads at a glance. */
export function partColor(part: string): Rgb {
  if (part === 'Head') return [214, 218, 224];
  if (part === 'UpperTorso' || part === 'LowerTorso') return [112, 122, 142];
  const left = part.startsWith('Left');
  const tip = part.endsWith('Hand') || part.endsWith('Foot');
  if (left) return tip ? [44, 96, 184] : [72, 132, 224];
  return tip ? [204, 108, 36] : [238, 144, 62];
}

/** The parts drawn: every part but the HumanoidRootPart, which Roblox hides. */
export function drawnParts(rig: Rig = R15_RIG): string[] {
  return Object.keys(rig.parts).filter((part) => part !== rig.rootPart);
}

/** Where the ground is, in the HumanoidRootPart's frame. */
export function groundHeight(rig: Rig = R15_RIG): number {
  return -(rig.hipHeight + rig.parts[rig.rootPart][1] / 2);
}
