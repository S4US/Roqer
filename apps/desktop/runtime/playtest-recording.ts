import { PLAYTEST_RECORDING_LABEL } from "../shared/run-events";

/**
 * Recording a run's playtest: the parts that need no Electron.
 *
 * A screenshot cannot show motion, timing, camera feel or animation blending,
 * which are what people judge a game by. With the switch on, Roqer records the
 * Studio window from the moment a playtest the run started reports ready until
 * the run stops it, keeps the clip with the run for the user to watch, and
 * hands the model a sheet of frames spread over the recording when the stop
 * result comes back. Which window, how long, how the frames are chosen and how
 * the result reads are decided here and tested here; the window capture itself
 * lives in the main process.
 */

/** The longest one playtest is recorded; a playtest that runs on is recorded for this long from its start. */
export const MAX_PLAYTEST_RECORDING_SECONDS = 120;
/** Frames a second asked of the capture: smooth enough to judge motion, light enough to keep. */
export const PLAYTEST_RECORDING_FRAME_RATE = 30;
/** The encoder's bit rate: two minutes stay well inside the clip bound at this rate. */
export const PLAYTEST_RECORDING_BITS_PER_SECOND = 2_500_000;
/** The long side a recorded frame is kept at; Studio's window is scaled down to it. */
export const PLAYTEST_RECORDING_EDGE = 1280;
/** How many frames the model is shown of one recording, spread over its length. */
export const PLAYTEST_SHEET_FRAMES = 12;
/** The long side of each frame handed to the sheet composer. */
export const PLAYTEST_SHEET_EDGE = 640;
/** A recording shorter than this shows nothing worth a sheet: the playtest stopped at once. */
export const MIN_PLAYTEST_RECORDING_SECONDS = 0.5;

/** The Studio tools whose start and stop bound a recording. */
export const PLAYTEST_TOOLS: readonly string[] = ["solo_playtest", "multiplayer_playtest"];

export type WindowSource = Readonly<{ id: string; name: string }>;

/**
 * Which window to record: a Roblox Studio window, never Roqer's own. A
 * multiplayer playtest opens a window per player beside the server's; the
 * first player's view is the one to watch, so a window named as the server
 * comes last.
 */
export function pickStudioSource<T extends WindowSource>(sources: readonly T[]): T | undefined {
  const studio = sources.filter((source) => /roblox studio/i.test(source.name) && !/^roqer\b/i.test(source.name));
  if (studio.length === 0) return undefined;
  const ranked = [...studio].sort((a, b) => Number(/\bserver\b/i.test(a.name)) - Number(/\bserver\b/i.test(b.name)));
  return ranked[0];
}

/**
 * When to take the frames the model is shown: spread evenly over the
 * recording, each in the middle of its share, so the first is not the black
 * frame a capture starts on and the last is before the stop. At most four a
 * second, so a short playtest is not shown twelve near-identical frames.
 */
export function sheetTimes(durationSeconds: number, count = PLAYTEST_SHEET_FRAMES): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || count < 1) return [];
  const frames = Math.max(1, Math.min(count, Math.floor(durationSeconds * 4)));
  return Array.from({ length: frames }, (_, index) => Math.round(((index + 0.5) * durationSeconds / frames) * 100) / 100);
}

/** The label on each frame of the sheet: its number and its time in the recording. */
export function sheetLabels(times: readonly number[]): string[] {
  return times.map((time, index) => `${index + 1} · ${formatSeconds(time)}`);
}

export function formatSeconds(seconds: number): string {
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
  }
  return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds).toString()}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** What the host wrote about a playtest's recording into the stop result, under `RECORDING_FIELD`. */
export type PlaytestRecordingSummary = Readonly<{
  /** The WebM, inside Roqer's own data folder; the host decides whether to open it. */
  path: string;
  durationSeconds: number;
  width: number;
  height: number;
  bytes: number;
  /** The times of the frames on the sheet attached to the result, in recording seconds. */
  frames: readonly number[];
}>;

export type PlaytestRecordingSkipped = Readonly<{ skipped: "no-window" | "capture-failed" | "too-short" | "not-started" }>;

/** The field a playtest stop result carries its recording in. */
export const RECORDING_FIELD = "recording";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const SKIPPED: readonly PlaytestRecordingSkipped["skipped"][] = ["no-window", "capture-failed", "too-short", "not-started"];

/** The recording a stop result carries, checked field by field; undefined when it carries none. */
export function recordingOf(data: unknown): PlaytestRecordingSummary | PlaytestRecordingSkipped | undefined {
  if (!isRecord(data) || !isRecord(data[RECORDING_FIELD])) return undefined;
  const value = data[RECORDING_FIELD];
  if (typeof value.skipped === "string") return SKIPPED.includes(value.skipped as PlaytestRecordingSkipped["skipped"]) ? { skipped: value.skipped as PlaytestRecordingSkipped["skipped"] } : undefined;
  if (typeof value.path !== "string" || value.path === "" || !isCount(value.durationSeconds) || !isCount(value.width) || !isCount(value.height) || !isCount(value.bytes)) return undefined;
  const frames = Array.isArray(value.frames) ? value.frames.filter(isCount) : [];
  return { path: value.path, durationSeconds: value.durationSeconds, width: value.width, height: value.height, bytes: value.bytes, frames };
}

/** Why nothing was recorded, for the evidence and the model. */
export function skippedReason(skipped: PlaytestRecordingSkipped): string {
  switch (skipped.skipped) {
    case "no-window": return "Not recorded: no Roblox Studio window was found to record.";
    case "capture-failed": return "Not recorded: the window capture failed on this computer.";
    case "too-short": return "Not recorded: the playtest stopped before half a second had been captured.";
    default: return "Not recorded: the playtest was started before recording was on.";
  }
}

/** The line a playtest's evidence shows about its recording. */
export function recordingMetadata(recording: PlaytestRecordingSummary | PlaytestRecordingSkipped): { label: string; value: string } {
  if ("skipped" in recording) return { label: PLAYTEST_RECORDING_LABEL, value: skippedReason(recording) };
  return { label: PLAYTEST_RECORDING_LABEL, value: `${formatSeconds(recording.durationSeconds)} · ${recording.width}×${recording.height} · ${formatBytes(recording.bytes)}` };
}

/** What the model reads about the recording, after the stop result's own text. */
export function describeRecording(recording: PlaytestRecordingSummary | PlaytestRecordingSkipped, sheetAttached: boolean): string {
  if ("skipped" in recording) return `[Roqer recorded nothing of this playtest. ${skippedReason(recording)}]`;
  const lines = [
    `[Roqer recorded the Studio window for ${formatSeconds(recording.durationSeconds)} of this playtest (${recording.width}×${recording.height}); the user can watch the clip in the chat.`,
  ];
  if (sheetAttached && recording.frames.length > 0) {
    lines.push(`A sheet of ${recording.frames.length} frames spread over the recording is attached, each labelled with its number and time: ${recording.frames.map((time) => formatSeconds(time)).join(", ")}. Read it left to right, top to bottom, for what moved, when, and how the camera and animations behaved; a screenshot shows none of that. Frames are evidence of what was on screen, not of what the code did: read logs and state for that.]`);
  } else {
    lines.push("No frames could be read from it here; check the playtest with screenshots and logs as usual.]");
  }
  return lines.join(" ");
}
