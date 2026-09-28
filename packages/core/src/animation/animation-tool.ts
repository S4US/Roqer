// The core half of the `animation` tool: everything that needs no Studio.
//
// A pose description is compiled and its motion checked here, before anything
// reaches the plugin. `check` stops there. `build` then has the plugin preview
// the compiled sequence on a temporary dummy, and `verifyPlayback` compares the
// joints Studio produced with the model the checks measured; only a sequence
// that plays as checked is written.

import { compilePoseAnimation, type KeyframeSequenceDescription } from './pose-compiler.js';
import { buildTracks, degreesBetween, frameFromComponents, sampleTrack } from './motion.js';
import { checkMotion, type MotionCheckId, type MotionCheckResult, type MotionReport } from './motion-checks.js';
import { R15_RIG } from './r15-rig.js';

export const MOTION_CHECK_IDS: readonly MotionCheckId[] = [
  'jointLimits',
  'velocity',
  'rootDrift',
  'loopContinuity',
  'groundContact',
  'footSliding',
  'gaitSymmetry',
];

/** Samples the preview takes, spread over one pass of the animation. */
export const PREVIEW_SAMPLES = 8;
/**
 * How closely Studio's playback must match the checked model. Linear keys can
 * differ by up to 0.9° over the 90° a joint may turn between keys (see the
 * plan's calibration run), so this leaves room for that and nothing more.
 */
export const PLAYBACK_TOLERANCE = { degrees: 1.5, studs: 0.05 } as const;

export interface CompactCheck {
  id: MotionCheckId;
  status: MotionCheckResult['status'];
  detail: string;
  /** Measurements, for failed checks only. */
  measured?: Record<string, number>;
}

export interface CheckedAnimation {
  sequence: KeyframeSequenceDescription;
  report: MotionReport;
  /** Failed checks the caller did not waive. */
  failing: MotionCheckId[];
  /** Failed checks the caller waived. */
  waived: MotionCheckId[];
}

export type PrepareResult = { ok: true; value: CheckedAnimation } | { ok: false; errors: string[] };

/** Validates the tool's own arguments, compiles the animation and checks its motion. */
export function prepareAnimation(animation: unknown, options: { locomotion?: unknown; waive?: unknown }): PrepareResult {
  const errors: string[] = [];
  if (options.locomotion !== undefined && typeof options.locomotion !== 'boolean') {
    errors.push('locomotion: must be true or false');
  }
  let waive: MotionCheckId[] = [];
  if (options.waive !== undefined) {
    if (!Array.isArray(options.waive)) {
      errors.push(`waive: must be an array of check ids: ${MOTION_CHECK_IDS.join(', ')}`);
    } else {
      for (const id of options.waive) {
        if (!MOTION_CHECK_IDS.includes(id as MotionCheckId)) errors.push(`waive: unknown check "${String(id)}"; checks are ${MOTION_CHECK_IDS.join(', ')}`);
      }
      waive = options.waive.filter((id): id is MotionCheckId => MOTION_CHECK_IDS.includes(id as MotionCheckId));
    }
  }
  const compiled = compilePoseAnimation(animation);
  if (!compiled.ok) errors.push(...compiled.errors);
  if (errors.length > 0 || !compiled.ok) return { ok: false, errors };

  const report = checkMotion(compiled.sequence, { locomotion: options.locomotion === true });
  const failed = report.checks.filter((check) => check.status === 'fail').map((check) => check.id);
  return {
    ok: true,
    value: {
      sequence: compiled.sequence,
      report,
      failing: failed.filter((id) => !waive.includes(id)),
      waived: failed.filter((id) => waive.includes(id)),
    },
  };
}

/** The checks as the tool reports them: measurements only where they explain a failure. */
export function compactChecks(report: MotionReport): CompactCheck[] {
  return report.checks.map((check) => ({
    id: check.id,
    status: check.status,
    detail: check.detail,
    ...(check.status === 'fail' ? { measured: check.measured } : {}),
  }));
}

/** What the tool says about the animation itself. */
export function describeAnimation(sequence: KeyframeSequenceDescription) {
  return {
    name: sequence.name,
    duration: sequence.duration,
    keyframes: sequence.keyframes.length,
    loop: sequence.loop,
    priority: sequence.priority,
    joints: sequence.joints,
  };
}

/**
 * Times to sample the preview at: the middle of each of PREVIEW_SAMPLES equal
 * spans, so none lands on a loop's wrap or a one-shot's last frame.
 */
export function previewSampleTimes(sequence: KeyframeSequenceDescription): number[] {
  if (sequence.duration === 0) return [0];
  return Array.from({ length: PREVIEW_SAMPLES }, (_unused, index) => (sequence.duration * (index + 0.5)) / PREVIEW_SAMPLES);
}

export interface PreviewSample {
  time: number;
  /** Each joint's Transform as CFrame components, by the part it moves. */
  transforms: Record<string, number[]>;
}

export interface PlaybackCheck {
  verified: boolean;
  samples: number;
  maxDegrees: number;
  maxStuds: number;
  /** Where the largest difference was, when there was one. */
  worst?: { part: string; time: number };
  reason?: string;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Compares the joints Studio produced with the model the checks measured. */
export function verifyPlayback(sequence: KeyframeSequenceDescription, samples: unknown): PlaybackCheck {
  const fail = (reason: string): PlaybackCheck => ({ verified: false, samples: 0, maxDegrees: 0, maxStuds: 0, reason });
  if (!Array.isArray(samples) || samples.length === 0) return fail('Studio returned no preview samples');
  const tracks = buildTracks(sequence);
  let maxDegrees = 0;
  let maxStuds = 0;
  let worst: PlaybackCheck['worst'];
  for (const sample of samples as PreviewSample[]) {
    if (typeof sample?.time !== 'number' || typeof sample.transforms !== 'object' || sample.transforms === null) {
      return fail('Studio returned a malformed preview sample');
    }
    for (const joint of R15_RIG.joints) {
      const actual = sample.transforms[joint.childPart];
      if (!Array.isArray(actual) || actual.length !== 12 || !actual.every(Number.isFinite)) {
        return fail(`the preview dummy reported no joint for ${joint.childPart}`);
      }
      const expected = sampleTrack(tracks.get(joint.childPart), sample.time);
      const played = frameFromComponents(actual);
      const degrees = degreesBetween(expected.r, played.r);
      const studs = Math.hypot(expected.p[0] - played.p[0], expected.p[1] - played.p[1], expected.p[2] - played.p[2]);
      if (degrees > maxDegrees) {
        maxDegrees = degrees;
        worst = { part: joint.childPart, time: round(sample.time, 3) };
      }
      maxStuds = Math.max(maxStuds, studs);
    }
  }
  const verified = maxDegrees <= PLAYBACK_TOLERANCE.degrees && maxStuds <= PLAYBACK_TOLERANCE.studs;
  return {
    verified,
    samples: samples.length,
    maxDegrees: round(maxDegrees, 2),
    maxStuds: round(maxStuds, 3),
    ...(worst && maxDegrees > 0.01 ? { worst } : {}),
    ...(verified ? {} : {
      reason: `Studio played it up to ${round(maxDegrees, 2)}° and ${round(maxStuds, 3)} studs from the checked model; the limit is ${PLAYBACK_TOLERANCE.degrees}° and ${PLAYBACK_TOLERANCE.studs} studs`,
    }),
  };
}

/**
 * Slots of Roblox's default Animate script that `wire` may fill. Each is the
 * name of a StringValue under Animate whose Animation children it plays.
 */
export const ANIMATE_SLOTS = ['idle', 'walk', 'run', 'jump', 'fall', 'climb', 'swim', 'swimidle', 'sit'] as const;
export type AnimateSlot = (typeof ANIMATE_SLOTS)[number];

/** An asset ID in any of the forms Roblox accepts, as rbxassetid://N; undefined otherwise. */
export function normalizeAnimationId(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return `rbxassetid://${value}`;
  if (typeof value !== 'string') return undefined;
  const match = /^(?:rbxassetid:\/\/|https?:\/\/www\.roblox\.com\/asset\/\?id=)?(\d{1,20})$/.exec(value.trim());
  return match && match[1] !== '0' ? `rbxassetid://${match[1]}` : undefined;
}

export interface PlaceOwner {
  creatorType: string;
  creatorId: number;
}

export type PublisherChoice =
  | { ok: true; creator: { userId?: string; groupId?: string }; ownerCheck: string }
  | { ok: false; errorCode: string; error: string };

/**
 * Who uploads the animation. It must be the place's owner, or it will not play
 * in the live game: a group place needs the group, a user place that user. An
 * unpublished place has no owner yet, so the configured creator is used and
 * the result says the place must be published under it.
 */
export function choosePublisher(place: PlaceOwner, config: { userId?: string; groupId?: string }): PublisherChoice {
  const configured = config.groupId ? `group ${config.groupId}` : config.userId ? `user ${config.userId}` : undefined;
  if (!configured) {
    return {
      ok: false,
      errorCode: 'creator_not_configured',
      error: 'No Roblox creator is configured for uploads, so nothing was uploaded. Set the creator user or group in Roqer Settings.',
    };
  }
  if (!Number.isFinite(place.creatorId) || place.creatorId <= 0) {
    return {
      ok: true,
      creator: config.groupId ? { groupId: config.groupId } : { userId: config.userId },
      ownerCheck: `The place is not published, so it has no owner yet. The animation belongs to ${configured}; publish the place under the same owner, or the animation will not play in the live game.`,
    };
  }
  const owner = place.creatorType === 'Group' ? `group ${place.creatorId}` : `user ${place.creatorId}`;
  if (owner !== configured) {
    return {
      ok: false,
      errorCode: 'owner_mismatch',
      error: `This place belongs to ${owner}, but uploads go to ${configured}. An animation plays in the live game only for its owner, so nothing was uploaded. Set the upload creator to ${owner}${place.creatorType === 'Group' ? ' with a key that can upload for the group' : ''}.`,
    };
  }
  return {
    ok: true,
    creator: place.creatorType === 'Group' ? { groupId: String(place.creatorId) } : { userId: String(place.creatorId) },
    ownerCheck: `The animation belongs to ${owner}, who owns the place.`,
  };
}

/**
 * How closely a live playtest must match. The Animator runs on its own clock
 * and blends in other tracks, so only the joints this animation keys are
 * compared, and a little more room is left than for the stepped preview.
 */
export const LIVE_PLAYBACK_TOLERANCE = { degrees: 2, studs: 0.05 } as const;

/** Compares a live playtest's keyed joints with the checked model. */
export function verifyLivePlayback(sequence: KeyframeSequenceDescription, samples: unknown): PlaybackCheck {
  const fail = (reason: string): PlaybackCheck => ({ verified: false, samples: 0, maxDegrees: 0, maxStuds: 0, reason });
  if (!Array.isArray(samples) || samples.length === 0) return fail('the playtest returned no samples');
  const tracks = buildTracks(sequence);
  const keyed = R15_RIG.joints.filter((joint) => sequence.joints.includes(joint.name));
  let maxDegrees = 0;
  let maxStuds = 0;
  let worst: PlaybackCheck['worst'];
  for (const sample of samples as PreviewSample[]) {
    if (typeof sample?.time !== 'number' || typeof sample.transforms !== 'object' || sample.transforms === null) {
      return fail('the playtest returned a malformed sample');
    }
    for (const joint of keyed) {
      const actual = sample.transforms[joint.childPart];
      if (!Array.isArray(actual) || actual.length !== 12 || !actual.every(Number.isFinite)) {
        return fail(`the character reported no joint for ${joint.childPart}`);
      }
      const expected = sampleTrack(tracks.get(joint.childPart), sample.time);
      const played = frameFromComponents(actual);
      const degrees = degreesBetween(expected.r, played.r);
      if (degrees > maxDegrees) {
        maxDegrees = degrees;
        worst = { part: joint.childPart, time: round(sample.time, 3) };
      }
      maxStuds = Math.max(maxStuds, Math.hypot(expected.p[0] - played.p[0], expected.p[1] - played.p[1], expected.p[2] - played.p[2]));
    }
  }
  const verified = maxDegrees <= LIVE_PLAYBACK_TOLERANCE.degrees && maxStuds <= LIVE_PLAYBACK_TOLERANCE.studs;
  return {
    verified,
    samples: samples.length,
    maxDegrees: round(maxDegrees, 2),
    maxStuds: round(maxStuds, 3),
    ...(worst && maxDegrees > 0.01 ? { worst } : {}),
    ...(verified ? {} : {
      reason: `the character played it up to ${round(maxDegrees, 2)}° and ${round(maxStuds, 3)} studs from the checked model; the limit is ${LIVE_PLAYBACK_TOLERANCE.degrees}° and ${LIVE_PLAYBACK_TOLERANCE.studs} studs`,
    }),
  };
}

/** Poses in a compiled sequence, placeholders included: what a read-back must find. */
export function expectedCounts(sequence: KeyframeSequenceDescription) {
  return { keyframes: sequence.keyframes.length, poses: sequence.poseCount };
}
