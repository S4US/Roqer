// The core half of the `animation` tool: everything that needs no Studio.
//
// A pose description is compiled and its motion checked here, before anything
// reaches the plugin. `check` stops there. `build` then has the plugin preview
// the compiled sequence on a temporary dummy, or on a copy of the model whose
// rig it was written for, and `verifyPlayback` compares the joints Studio
// produced with the model the checks measured; only a sequence that plays as
// checked is written.
//
// R15 and R6 are built in; a model's rig is read from Studio first
// (model-rig.ts) and handed to each step here.

import { compilePoseAnimation, type KeyframeSequenceDescription } from './pose-compiler.js';
import { buildTracks, degreesBetween, frameFromComponents, jointParentFrame, sampleTrack } from './motion.js';
import { checkMotion, type MotionCheckId, type MotionCheckResult, type MotionReport } from './motion-checks.js';
import type { Rig } from './rig.js';
import { rigFor } from './rigs.js';

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

/**
 * Validates the tool's own arguments, compiles the animation and checks its
 * motion, on R15 or R6 as the animation names, or on `model`, a rig read from
 * the model the animation names.
 */
export function prepareAnimation(
  animation: unknown,
  options: { locomotion?: unknown; grounded?: unknown; waive?: unknown },
  model?: Rig,
): PrepareResult {
  const errors: string[] = [];
  if (options.locomotion !== undefined && typeof options.locomotion !== 'boolean') {
    errors.push('locomotion: must be true or false');
  }
  if (options.grounded !== undefined && typeof options.grounded !== 'boolean') {
    errors.push('grounded: must be true or false');
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
  const compiled = compilePoseAnimation(animation, model);
  if (!compiled.ok) errors.push(...compiled.errors);
  if (errors.length > 0 || !compiled.ok) return { ok: false, errors };

  const report = checkMotion(
    compiled.sequence,
    { locomotion: options.locomotion === true, grounded: options.grounded === true },
    model ?? rigFor(compiled.sequence.rig),
  );
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
    rig: sequence.rig,
    duration: sequence.duration,
    keyframes: sequence.keyframes.length,
    loop: sequence.loop,
    priority: sequence.priority,
    joints: sequence.joints,
    ...(sequence.markerCount > 0 ? { markers: sequence.markerCount } : {}),
    ...(sequence.inBetweenCount > 0 ? { inBetweens: sequence.inBetweenCount } : {}),
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
export function verifyPlayback(sequence: KeyframeSequenceDescription, samples: unknown, rig: Rig = rigFor(sequence.rig)): PlaybackCheck {
  const fail = (reason: string): PlaybackCheck => ({ verified: false, samples: 0, maxDegrees: 0, maxStuds: 0, reason });
  if (!Array.isArray(samples) || samples.length === 0) return fail('Studio returned no preview samples');
  const tracks = buildTracks(sequence);
  // A weapon grip is compared only when the animation moves it.
  const joints = rig.joints.filter((joint) => !joint.optional || sequence.joints.includes(joint.name));
  let maxDegrees = 0;
  let maxStuds = 0;
  let worst: PlaybackCheck['worst'];
  for (const sample of samples as PreviewSample[]) {
    if (typeof sample?.time !== 'number' || typeof sample.transforms !== 'object' || sample.transforms === null) {
      return fail('Studio returned a malformed preview sample');
    }
    for (const joint of joints) {
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

/**
 * The states a model's loader plays by how fast the model moves: the slots
 * `wire` and `verify` take with a model rather than a character.
 */
export const MODEL_STATES = ['idle', 'walk', 'run'] as const;
export type ModelState = (typeof MODEL_STATES)[number];
/** The fastest ground speed a gait may be wired with, in studs a second. */
export const MAX_GROUND_SPEED = 200;

/**
 * How far a model's loader slows or speeds a gait to keep pace with the
 * model: the loader's own SLOWEST and FASTEST, in the plugin's
 * MODEL_LOADER_SOURCE.
 */
export const LOADER_PACE = { slowest: 0.5, fastest: 2 } as const;

/** One tenth-of-a-second sample of a model in a playtest, as the plugin takes it. */
export interface MovementSample {
  t: number;
  /** moving and standing while the plugin walks it; watching while something else moves it. */
  phase: string;
  /** Horizontal studs a second. */
  speed: number;
  /** The loader's track with the most weight, by animation ID, or false. */
  playing: string | false;
  /** That track's playback speed. */
  pace?: number;
}

/** What a model's loader holds: an animation ID and a ground speed per state. */
export interface LoaderStates {
  unchanged: boolean;
  ids: Partial<Record<ModelState, string>>;
  speeds: Partial<Record<ModelState, number>>;
}

export interface MovementCheck {
  verified: boolean;
  mode: 'walked' | 'watched';
  reached?: boolean;
  /** Counts of what the loader played, over the samples that judge each. */
  moving: { samples: number; averageSpeed?: number; played: Record<string, number> };
  standing: { samples: number; played: Record<string, number> };
  /** How the gait kept pace, when its ground speed is known. */
  pace?: { state: ModelState; groundSpeed: number; averageSpeed: number; needed: number; played: number; kept: boolean };
  notes?: string[];
  reason?: string;
}

/**
 * Studs a second at or above which a model is moving, and at or below which it
 * stands. The plugin's watch ends by the same speeds.
 */
export const MOVING_SPEED = 1;
export const STANDING_SPEED = 0.2;
/** A cross-fade and a Humanoid's start or stop: samples this soon after a change do not judge. */
const SETTLING_SECONDS = 0.4;
/** Share of the judging samples that must show the state expected. */
const MAJORITY = 0.8;
/** How far the played pace may be from the one needed. */
const PACE_TOLERANCE = 0.25;
/** Room for floating point, so 0.6 - 0.2 is 0.4 and 4.4 / 2.2 is 2. */
const EPSILON = 1e-9;

function roundTo(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Whether a model's loader played the right state as it moved and stood: its
 * walk or run while it moved, its idle while it stood, and a gait at the
 * model's pace over the ground speed it was written for. Samples soon after
 * the model starts or stops are left out, since the loader cross-fades.
 */
export function judgeMovement(observation: unknown, loader: unknown): MovementCheck {
  const record = typeof observation === 'object' && observation !== null ? observation as Record<string, unknown> : {};
  const mode = record.mode === 'watched' ? 'watched' : 'walked';
  const reached = typeof record.reached === 'boolean' ? record.reached : undefined;
  const empty = (): MovementCheck['moving'] => ({ samples: 0, played: {} });
  const fail = (reason: string, partial: Partial<MovementCheck> = {}): MovementCheck => ({
    verified: false, mode, ...(reached === undefined ? {} : { reached }), moving: empty(), standing: { samples: 0, played: {} }, ...partial, reason,
  });
  const states = typeof loader === 'object' && loader !== null ? loader as LoaderStates : undefined;
  if (!states || typeof states.ids !== 'object' || states.ids === null) {
    return fail('the model has no RoqerModelAnimate loader: wire its idle, walk or run first');
  }
  const samples = Array.isArray(record.samples) ? record.samples as MovementSample[] : [];
  if (samples.some((sample) => typeof sample?.t !== 'number' || typeof sample.speed !== 'number' || !Number.isFinite(sample.speed))) {
    return fail('the playtest returned a malformed sample');
  }
  const stateOf = new Map<string, ModelState>();
  for (const state of MODEL_STATES) {
    const id = states.ids[state];
    if (typeof id === 'string' && !stateOf.has(id)) stateOf.set(id, state);
  }
  const played = (sample: MovementSample) => (sample.playing === false ? 'nothing' : stateOf.get(sample.playing) ?? 'something else');

  // Which samples judge moving and which standing, leaving out the settling after each change.
  const moving: MovementSample[] = [];
  const standing: MovementSample[] = [];
  let current: 'moving' | 'standing' | undefined;
  let since = 0;
  for (const sample of samples) {
    const kind = sample.speed >= MOVING_SPEED && sample.phase !== 'standing' ? 'moving'
      : sample.speed <= STANDING_SPEED && sample.phase !== 'moving' ? 'standing'
        : undefined;
    if (kind === undefined) continue;
    if (kind !== current) {
      current = kind;
      since = sample.t;
    }
    if (sample.t - since < SETTLING_SECONDS - EPSILON) continue;
    (kind === 'moving' ? moving : standing).push(sample);
  }
  const counts = (list: MovementSample[]) => {
    const tally: Record<string, number> = {};
    for (const sample of list) tally[played(sample)] = (tally[played(sample)] ?? 0) + 1;
    return tally;
  };
  const averageSpeed = moving.length === 0 ? undefined : roundTo(moving.reduce((sum, sample) => sum + sample.speed, 0) / moving.length, 2);
  const result: MovementCheck = {
    verified: true,
    mode,
    ...(reached === undefined ? {} : { reached }),
    moving: { samples: moving.length, ...(averageSpeed === undefined ? {} : { averageSpeed }), played: counts(moving) },
    standing: { samples: standing.length, played: counts(standing) },
  };
  const notes: string[] = [];
  const reasons: string[] = [];

  const gaits = (['walk', 'run'] as const).filter((state) => typeof states.ids[state] === 'string');
  if (moving.length < 3) {
    reasons.push(mode === 'walked'
      ? 'it hardly moved: MoveTo found no way to the position, or something held it'
      : 'it did not move while it was watched; walk it with position');
  } else if (gaits.length === 0) {
    reasons.push('no walk or run is wired, so nothing played while it moved');
  } else {
    const gaitShare = moving.filter((sample) => gaits.includes(played(sample) as 'walk' | 'run')).length / moving.length;
    if (gaitShare < MAJORITY) {
      reasons.push(`its ${gaits.join(' or ')} played for ${Math.round(gaitShare * 100)}% of the time it moved; it needs ${Math.round(MAJORITY * 100)}%`);
    }
  }

  if (standing.length < 3) {
    reasons.push(mode === 'walked' ? 'it never stood still after the walk' : 'it never stood still while it was watched');
  } else if (typeof states.ids.idle === 'string') {
    const idleShare = standing.filter((sample) => played(sample) === 'idle').length / standing.length;
    if (idleShare < MAJORITY) {
      reasons.push(`its idle played for ${Math.round(idleShare * 100)}% of the time it stood; it needs ${Math.round(MAJORITY * 100)}%`);
    }
  } else {
    notes.push('no idle is wired, so it stands in its rest pose');
    const stillGaits = standing.filter((sample) => gaits.includes(played(sample) as 'walk' | 'run')).length / standing.length;
    if (stillGaits > 1 - MAJORITY) reasons.push('a gait kept playing while it stood');
  }

  for (const gait of gaits) {
    if (typeof states.speeds[gait] !== 'number' && moving.some((sample) => played(sample) === gait)) {
      notes.push(`its ${gait} has no ground speed, so the loader plays it at its own pace and its feet may slide`);
    }
  }
  // The pace of the gait that played most while it moved, when its ground speed is
  // known: a model that both walked and ran is paced by one of them, not their mix.
  const [pacedGait] = gaits
    .filter((gait) => typeof states.speeds[gait] === 'number')
    .map((gait) => ({ gait, samples: moving.filter((sample) => played(sample) === gait && typeof sample.pace === 'number') }))
    .sort((a, b) => b.samples.length - a.samples.length);
  if (pacedGait && pacedGait.samples.length >= 3) {
    const { gait: state, samples: paced } = pacedGait;
    const groundSpeed = states.speeds[state] as number;
    const speed = paced.reduce((sum, sample) => sum + sample.speed, 0) / paced.length;
    const needed = speed / groundSpeed;
    const expected = Math.min(LOADER_PACE.fastest, Math.max(LOADER_PACE.slowest, needed));
    const playedPace = paced.reduce((sum, sample) => sum + (sample.pace as number), 0) / paced.length;
    const tooFast = needed > LOADER_PACE.fastest + EPSILON;
    const tooSlow = needed < LOADER_PACE.slowest - EPSILON;
    const kept = !tooFast && !tooSlow && Math.abs(playedPace - expected) <= PACE_TOLERANCE + EPSILON;
    result.pace = { state, groundSpeed, averageSpeed: roundTo(speed, 2), needed: roundTo(needed, 2), played: roundTo(playedPace, 2), kept };
    if (tooFast || tooSlow) {
      const limit = (tooFast ? LOADER_PACE.fastest : LOADER_PACE.slowest) * groundSpeed;
      reasons.push(`it moved at ${roundTo(speed, 1)} studs a second, but its ${state} is written for ${groundSpeed}, and the loader plays a gait ${tooFast ? 'at most twice' : 'at least half'} as fast, so its feet slide: make a ${tooFast ? 'faster' : 'slower'} ${state}, or move it ${tooFast ? 'at most' : 'at least'} ${roundTo(limit, 1)} studs a second (a Humanoid moves at its WalkSpeed)`);
    } else if (!kept) {
      reasons.push(`the loader played its ${state} at ${roundTo(playedPace, 2)} times its speed where the model's pace needed ${roundTo(needed, 2)}`);
    }
  }

  if (notes.length > 0) result.notes = notes;
  if (reasons.length > 0) {
    result.verified = false;
    result.reason = reasons.join('; ');
  }
  return result;
}

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
export function verifyLivePlayback(sequence: KeyframeSequenceDescription, samples: unknown, rig: Rig = rigFor(sequence.rig)): PlaybackCheck {
  const fail = (reason: string): PlaybackCheck => ({ verified: false, samples: 0, maxDegrees: 0, maxStuds: 0, reason });
  if (!Array.isArray(samples) || samples.length === 0) return fail('the playtest returned no samples');
  const tracks = buildTracks(sequence);
  const keyed = rig.joints.filter((joint) => sequence.joints.includes(joint.name));
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
        return fail(joint.optional
          ? `the character has no Motor6D moving ${joint.childPart}; equip the prop rigged with one (see the animation skill's Props section) before verifying`
          : `the character reported no joint for ${joint.childPart}`);
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

export interface PreviewProp {
  /** The prop's part, which the motor moves. */
  part: string;
  /** The body part the motor hangs from. */
  parent: string;
  /** C0 as CFrame components, unless the dummy's attachment gives it. */
  c0: number[];
  attachment?: string;
}

/**
 * The prop motors a preview dummy needs: one for each held or worn prop the
 * animation moves, built as the game builds it.
 */
export function previewProps(sequence: KeyframeSequenceDescription, rig: Rig = rigFor(sequence.rig)): PreviewProp[] {
  return rig.joints
    .filter((joint) => joint.optional && sequence.joints.includes(joint.name))
    .map((joint) => {
      const c0 = jointParentFrame(joint);
      return {
        part: joint.childPart,
        parent: joint.parentPart,
        c0: [...c0.p, ...c0.r],
        ...(joint.attachment ? { attachment: joint.attachment } : {}),
      };
    });
}

/**
 * What a result says about a rig read from a model: the joints a pose may key,
 * parents first; the one that takes a position; what its declarations named;
 * how its distance limits were scaled; and what the reading noted.
 */
export function describeRig(rig: Rig, notes: readonly string[] = []) {
  const named = (record: Readonly<Record<string, unknown>>) => Object.keys(record);
  return {
    path: rig.name,
    ...(rig.revision ? { revision: rig.revision } : {}),
    joints: rig.joints.map((joint) => joint.name),
    position: rig.rootJoint ?? false,
    ...(rig.feet.length > 0 ? { feet: rig.feet } : {}),
    ...(named(rig.limbs).length > 0 ? { limbs: named(rig.limbs) } : {}),
    ...(named(rig.hinges).length > 0 ? { hinges: named(rig.hinges) } : {}),
    ranged: rig.joints.filter((joint) => rig.limits[joint.name] !== undefined && rig.limits[joint.name] !== 'free').map((joint) => joint.name),
    ...(rig.scale ? { scale: `${round(rig.scale.factor, 2)} times R15's distance limits, from ${rig.scale.basis}` } : {}),
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** How far the range sheet turns each joint, in degrees. */
export const RANGE_SHEET_TURN = 30;

/**
 * A rig's range sheet, as a pose description: every joint but the root's at
 * rest, then turned a little each way about X and about Z, so a pivot in the
 * wrong place shows as a piece swinging off the body rather than about its
 * end. Nothing checks it; it is only drawn.
 */
export function rangeSheetAnimation(rig: Rig) {
  const turned = rig.joints.filter((joint) => joint.name !== rig.rootJoint && !joint.optional);
  const every = (rotation: [number, number, number]) => Object.fromEntries(turned.map((joint) => [joint.name, { rotation }]));
  const t = RANGE_SHEET_TURN;
  return {
    name: 'RangeSheet',
    rig: rig.name,
    easing: { style: 'Linear' },
    keyframes: [
      { time: 0, name: 'rest', joints: every([0, 0, 0]) },
      { time: 0.5, name: `every joint +${t} about X`, joints: every([t, 0, 0]) },
      { time: 1, name: `every joint -${t} about X`, joints: every([-t, 0, 0]) },
      { time: 1.5, name: `every joint +${t} about Z`, joints: every([0, 0, t]) },
      { time: 2, name: `every joint -${t} about Z`, joints: every([0, 0, -t]) },
    ],
  };
}

/** Poses in a compiled sequence, placeholders included: what a read-back must find. */
export function expectedCounts(sequence: KeyframeSequenceDescription) {
  return { keyframes: sequence.keyframes.length, poses: sequence.poseCount, markers: sequence.markerCount };
}
