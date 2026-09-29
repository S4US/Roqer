// Easing styles and directions, and how far between two keys each one puts a
// joint, as Studio plays them. Both the pose compiler and the motion model
// read these, so they live apart from either.

export const POSE_EASING_STYLES = ['Linear', 'Constant', 'Elastic', 'Cubic', 'Bounce', 'CubicV2'] as const;
export const POSE_EASING_DIRECTIONS = ['In', 'Out', 'InOut'] as const;

export type PoseEasingStyle = (typeof POSE_EASING_STYLES)[number];
export type PoseEasingDirection = (typeof POSE_EASING_DIRECTIONS)[number];

// The "In" shape of each style; Out and InOut are derived from it.
function easeIn(style: PoseEasingStyle, t: number): number {
  switch (style) {
    case 'Linear':
      return t;
    case 'Cubic':
    case 'CubicV2':
      return t * t * t;
    case 'Bounce':
      return 1 - bounceOut(1 - t);
    case 'Elastic':
      return elasticIn(t, 0.3);
    case 'Constant':
      return t < 1 ? 0 : 1;
  }
}

function elasticIn(t: number, period: number): number {
  if (t === 0 || t === 1) return t;
  return -(2 ** (10 * (t - 1))) * Math.sin(((t - 1 - period / 4) * 2 * Math.PI) / period);
}

function bounceOut(t: number): number {
  if (t < 1 / 2.75) return 7.5625 * t * t;
  if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75;
  if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375;
  return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375;
}

/**
 * How far between two keys a joint is at fraction t of the segment, as Studio
 * plays it (measured by tests/animation-calibration.mjs):
 * - The legacy Cubic style has In and Out swapped relative to CubicV2 and
 *   TweenService, which is why CubicV2 exists.
 * - Constant snaps to the next key: at once for In, halfway for InOut, and at
 *   the next key for Out.
 * - Elastic InOut uses a longer period (0.45) than In and Out (0.3).
 * - Bounce InOut plays the In shape in both halves: 0 to 0.5, then 0.5 to 1.
 */
export function easeAlpha(style: PoseEasingStyle, direction: PoseEasingDirection, t: number): number {
  if (style === 'Constant') {
    if (direction === 'In') return t > 0 ? 1 : 0;
    if (direction === 'InOut') return t >= 0.5 ? 1 : 0;
    return 0;
  }
  const effective = style === 'Cubic' && direction !== 'InOut' ? (direction === 'In' ? 'Out' : 'In') : direction;
  if (effective === 'In') return easeIn(style, t);
  if (effective === 'Out') return 1 - easeIn(style, 1 - t);
  if (style === 'Bounce') {
    return t < 0.5 ? easeIn(style, t * 2) / 2 : 0.5 + easeIn(style, t * 2 - 1) / 2;
  }
  const shape = style === 'Elastic' ? (u: number) => elasticIn(u, 0.45) : (u: number) => easeIn(style, u);
  return t < 0.5 ? shape(t * 2) / 2 : 1 - shape((1 - t) * 2) / 2;
}
