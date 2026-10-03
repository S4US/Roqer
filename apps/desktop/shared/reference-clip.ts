/**
 * A reference clip: a video or animated picture the user attaches so the agent
 * can see an effect move, as the main process, the renderer and the run all
 * see it.
 *
 * No model Roqer drives reads video, so a clip reaches the model as frames.
 * Roqer reads the frames once, when the user chooses the part of the clip to
 * send, and keeps them with the chat, so a later message can still look closer.
 *
 * Every time the model sees is effect time: seconds from the start of the
 * user's selection, with a clip the user says was slowed down played back at
 * its real speed. The helpers below are the only place the two clocks meet.
 */

/** The model-facing tool that looks closer at a clip's frames. */
export const REFERENCE_CLIP_TOOL_NAME = "reference_clip";

/** The run-engine operation a `reference_clip` call travels as. */
export const REFERENCE_CLIP_OPERATION = "read_reference_clip";

/**
 * The most clip time one selection may cover. A reference effect is a second
 * or two; ten seconds holds a wind-up, the effect and its fade with room to
 * spare, and keeps the frames Roqer reads and stores bounded.
 */
export const MAX_CLIP_SELECTION_SECONDS = 10;

/** The most frames Roqer keeps for one selection: ten seconds at 30 a second, or five at 60. */
export const MAX_CLIP_FRAMES = 300;

/** The highest frame rate Roqer keeps; a faster clip keeps every other frame or fewer. */
export const MAX_CLIP_FRAME_RATE = 60;

/** How much slower than real time a clip may say it plays. */
export const MAX_CLIP_SLOW = 16;

/** The largest video file Roqer reads from the file picker. */
export const MAX_CLIP_SOURCE_BYTES = 1024 * 1024 * 1024;

/**
 * The largest video dropped or pasted onto the composer. Its bytes cross from
 * the chat window and are copied twice on the way, so the cap is lower than a
 * picked file's; a larger video can still be attached with the paperclip.
 */
export const MAX_DROPPED_CLIP_BYTES = 256 * 1024 * 1024;

/** The largest animated picture Roqer reads as a clip. */
export const MAX_ANIMATED_IMAGE_BYTES = 24 * 1024 * 1024;

/**
 * The scheme the chat window plays an attached clip from, while the user
 * chooses the part to send. It serves only clips the attachment registry
 * issued, by their attachment id, and nothing else on disk.
 */
export const CLIP_MEDIA_SCHEME = "roqer-clip";

/** Where the chat window plays an attached clip from. */
export function clipMediaUrl(attachmentId: string): string {
  return `${CLIP_MEDIA_SCHEME}://media/${encodeURIComponent(attachmentId)}`;
}

/** A stored clip's id, as the attachment text and `reference_clip` name it. */
export const CLIP_ID_PATTERN = "^[0-9a-f]{12}$";

export function isClipId(value: unknown): value is string {
  return typeof value === "string" && new RegExp(CLIP_ID_PATTERN).test(value);
}

/** File extensions read as video, mapped to the media type the attachment records. */
export const VIDEO_EXTENSIONS: ReadonlyMap<string, string> = new Map([
  [".mp4", "video/mp4"],
  [".m4v", "video/mp4"],
  [".mov", "video/quicktime"],
  [".webm", "video/webm"],
  [".mkv", "video/x-matroska"],
]);

/** Media types the composer accepts as video when a file is dropped or pasted. */
export const ATTACHABLE_VIDEO_TYPES: ReadonlySet<string> = new Set(["video/mp4", "video/quicktime", "video/webm", "video/x-matroska"]);

/** The part of a clip the user chose, in clip seconds, and how much slower than real time it plays. */
export type ClipSelection = Readonly<{ start: number; end: number; slow: number }>;

/**
 * What an attachment records about its clip: enough to show it in the chat
 * and to know whether its frames have been read. `id` is set once they have.
 */
export type AttachmentClip = Readonly<{
  /** The clip's length in seconds. */
  duration: number;
  /** The selection, in clip seconds. */
  start: number;
  end: number;
  /** 1 for real speed; 2 for a clip played at half speed. */
  slow: number;
  /** The stored frames, once read. */
  id?: string;
  frames?: number;
}>;

/** Rounds a time to the millisecond, which is finer than any frame. */
function milliseconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Effect seconds for a time in the clip. */
export function effectSeconds(clipTime: number, selection: ClipSelection): number {
  return milliseconds((clipTime - selection.start) / selection.slow);
}

/** The time in the clip for effect seconds. */
export function clipSeconds(effectTime: number, selection: ClipSelection): number {
  return milliseconds(selection.start + effectTime * selection.slow);
}

/** How long the selection lasts in effect seconds. */
export function selectionEffectSeconds(selection: ClipSelection): number {
  return milliseconds((selection.end - selection.start) / selection.slow);
}

/** Why a selection cannot be used for a clip of `duration` seconds, or undefined when it can. */
export function selectionProblem(selection: unknown, duration: number): string | undefined {
  if (typeof selection !== "object" || selection === null || Array.isArray(selection)) return "Choose the part of the clip to send.";
  const { start, end, slow } = selection as Record<string, unknown>;
  if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)) {
    return "The selection's start and end must be times in the clip.";
  }
  if (typeof slow !== "number" || !Number.isFinite(slow) || slow < 1 || slow > MAX_CLIP_SLOW) {
    return `The clip's speed must be real time or up to ${MAX_CLIP_SLOW} times slower.`;
  }
  if (start < 0 || end > duration + 0.001) return "The selection must lie inside the clip.";
  if (end - start < 0.05) return "Select at least a twentieth of a second.";
  if (end - start > MAX_CLIP_SELECTION_SECONDS + 0.001) return `Select at most ${MAX_CLIP_SELECTION_SECONDS} seconds of the clip.`;
  return undefined;
}

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

/**
 * A selection as a saved record may hold it: its shape only. The limits a new
 * selection must meet (`selectionProblem`) can change between versions, and a
 * chat saved under the old ones must still load.
 */
export function isSavedSelection(value: unknown, duration: number): value is ClipSelection {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const { start, end, slow } = value as Record<string, unknown>;
  return isFiniteNumber(start) && isFiniteNumber(end) && isFiniteNumber(slow) &&
    start >= 0 && end > start && end <= duration + 0.001 && slow > 0;
}

/** A clip record as an attachment persists it, checked for shape rather than against today's limits. */
export function isAttachmentClip(value: unknown): value is AttachmentClip {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const clip = value as Record<string, unknown>;
  if (!isFiniteNumber(clip.duration) || clip.duration <= 0) return false;
  if (!isSavedSelection({ start: clip.start, end: clip.end, slow: clip.slow }, clip.duration)) return false;
  if (clip.id !== undefined && !isClipId(clip.id)) return false;
  if (clip.frames !== undefined && !(Number.isSafeInteger(clip.frames) && (clip.frames as number) >= 1)) return false;
  return true;
}

/** The selection a clip starts with: all of it when it fits, else its first stretch. */
export function defaultSelection(duration: number): ClipSelection {
  return { start: 0, end: milliseconds(Math.min(duration, MAX_CLIP_SELECTION_SECONDS)), slow: 1 };
}

/** "0:03.25", for a time in the clip. */
export function formatClipTime(seconds: number): string {
  const whole = Math.max(0, seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole - minutes * 60;
  return `${minutes}:${rest.toFixed(2).padStart(5, "0")}`;
}
