import {
  CLIP_ID_PATTERN,
  effectSeconds,
  formatClipTime,
  isClipId,
  REFERENCE_CLIP_OPERATION,
  REFERENCE_CLIP_TOOL_NAME,
  selectionEffectSeconds,
} from "../shared/reference-clip";
import { describeClipAnalysis, type CropBox } from "./clip-analysis";
import type { ClipManifest } from "./clip-store";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";
import { frameLabel } from "./sheet-labels";
import { MalformedToolCallError } from "./studio-tools";

type JsonRecord = Record<string, unknown>;

/**
 * `reference_clip`: a closer look at a clip the user attached.
 *
 * The attachment itself carries a sheet or two of frames chosen by Roqer. When
 * the model needs a stretch of the clip at its own frame rate (how an impact
 * frame builds, how fast a ring grows), it asks here for a span, and Roqer
 * tiles the stored frames in it into one labelled image. It reads only frames
 * Roqer stored for this chat, so it is classified as a read.
 */

/** The most frames one call shows: four rows of four, as one image. */
export const MAX_REFERENCE_FRAMES = 16;
const DEFAULT_REFERENCE_FRAMES = 8;

/** Tiles frames into one labelled image, cropped to `crop`; undefined when it cannot. */
export type ClipSheetComposer = (
  frames: readonly Buffer[],
  options: Readonly<{ columns: number; labels: readonly string[]; crop?: CropBox }>,
) => Promise<McpToolImage | undefined>;

/** Where a run reads its chat's clips. */
export type ClipSource = Readonly<{
  list(): Promise<readonly ClipManifest[]>;
  read(id: string): Promise<ClipManifest | undefined>;
  frame(manifest: ClipManifest, index: number): Promise<Buffer>;
}>;

/** Frames to a row for `count` frames: square-ish, at most four across. */
export function sheetColumns(count: number): number {
  if (count <= 1) return 1;
  if (count <= 4) return 2;
  if (count <= 9) return 3;
  return 4;
}

/** A stored frame's effect time. */
export function frameEffectTime(manifest: ClipManifest, index: number): number {
  return effectSeconds(manifest.frames[index] as number, manifest.selection);
}

/** The stored frames whose effect time lies within `from`-`to`, inclusive. */
export function framesBetween(manifest: ClipManifest, from: number, to: number): number[] {
  const indexes: number[] = [];
  manifest.frames.forEach((_, index) => {
    const time = frameEffectTime(manifest, index);
    if (time >= from - 0.0005 && time <= to + 0.0005) indexes.push(index);
  });
  return indexes;
}

/** `count` of `indexes`, spread evenly from the first to the last; all of them when there are no more. */
export function spread(indexes: readonly number[], count: number): number[] {
  if (indexes.length <= count) return [...indexes];
  if (count <= 1) return [indexes[0] as number];
  const picked = new Set<number>();
  for (let slot = 0; slot < count; slot++) picked.add(indexes[Math.round((slot * (indexes.length - 1)) / (count - 1))] as number);
  return [...picked];
}

/** The stored frame nearest an effect time. */
export function nearestFrame(manifest: ClipManifest, time: number): number {
  let best = 0;
  manifest.frames.forEach((_, index) => {
    if (Math.abs(frameEffectTime(manifest, index) - time) < Math.abs(frameEffectTime(manifest, best) - time)) best = index;
  });
  return best;
}

/** Frames a second, as stored, over the stretch `indexes` covers. */
function storedRate(manifest: ClipManifest, indexes: readonly number[]): number | undefined {
  if (indexes.length < 2) return undefined;
  const span = frameEffectTime(manifest, indexes[indexes.length - 1] as number) - frameEffectTime(manifest, indexes[0] as number);
  return span > 0 ? (indexes.length - 1) / span : undefined;
}

export type ClipSheetPlan = Readonly<{ title: string; indexes: readonly number[] }>;

/**
 * The sheets an attached clip is sent with: an overview of the effect, and a
 * close-up of its build-up when the overview skips frames there.
 *
 * The overview spreads sixteen frames over the stretch where the clip changes
 * (the whole selection when nothing was measured, or the camera moves), so
 * every frame shows the effect rather than the quiet either side. The
 * close-up shows the start through the fall to half at the stored rate, up to
 * eight frames: the fast part a spread of sixteen is most likely to step over.
 */
export function planClipSheets(manifest: ClipManifest): ClipSheetPlan[] {
  const all = manifest.frames.map((_, index) => index);
  const { analysis } = manifest;
  let overviewSpan = all;
  if (analysis.active && !analysis.cameraMoves && analysis.onset !== undefined && analysis.end !== undefined) {
    const length = analysis.end - analysis.onset;
    const pad = Math.max(length * 0.1, 0.05);
    const active = framesBetween(manifest, analysis.onset - pad, analysis.end + pad);
    if (active.length >= 2) overviewSpan = active;
  }
  const overview = spread(overviewSpan, MAX_REFERENCE_FRAMES);
  const sheets: ClipSheetPlan[] = [{ title: "overview", indexes: overview }];
  if (analysis.active && !analysis.cameraMoves && analysis.onset !== undefined && analysis.half !== undefined) {
    const attack = framesBetween(manifest, analysis.onset, analysis.half);
    const unseen = attack.filter((index) => !overview.includes(index));
    if (unseen.length >= 3) sheets.push({ title: "close-up of the start", indexes: spread(attack, DEFAULT_REFERENCE_FRAMES) });
  }
  return sheets;
}

/** The labels a sheet of these stored frames carries: its number on the sheet and effect time. */
export function sheetLabels(manifest: ClipManifest, indexes: readonly number[]): string[] {
  return indexes.map((index, position) => frameLabel(position + 1, frameEffectTime(manifest, index)));
}

/** How the frames of a sheet are described in text, beside the picture. */
export function describeSheet(manifest: ClipManifest, indexes: readonly number[], cropped: boolean): string {
  const first = frameEffectTime(manifest, indexes[0] as number);
  const last = frameEffectTime(manifest, indexes[indexes.length - 1] as number);
  const span = framesBetween(manifest, first, last);
  const rate = storedRate(manifest, span);
  const every = span.length === indexes.length ? "every stored frame there" : `spread evenly over the ${span.length} stored frames there`;
  return [
    `${indexes.length === 1 ? "1 frame" : `${indexes.length} frames`} at ${first.toFixed(2)}${indexes.length > 1 ? `-${last.toFixed(2)}` : ""} s,`,
    `${every}${rate === undefined ? "" : ` (stored at about ${Math.round(rate)} a second)`}.`,
    `Tiled ${sheetColumns(indexes.length)} to a row, left to right then top to bottom, each labelled with its number and effect time${cropped ? ", and cropped to where the clip changes" : ""}.`,
  ].join(" ");
}

/** One sheet sent with an attachment: what it shows, and its place among the message's images. */
export type SentSheet = Readonly<{ plan: ClipSheetPlan; image: number; cropped: boolean }>;

/**
 * What the model is told about an attached clip: what it is and which part
 * was chosen, how the images with the message show it, what Roqer measured,
 * and how to look closer or compare. `sheets` is empty when this sign-in
 * cannot read images; the measurements still go.
 */
export function clipAttachmentText(manifest: ClipManifest, size: number, sheets: readonly SentSheet[], imagesSent: boolean): string {
  const { selection } = manifest;
  const all = manifest.frames.map((_, index) => index);
  const rate = storedRate(manifest, all);
  const lines = [
    `FILE: ${manifest.name}`,
    `SIZE: ${size} bytes`,
    `CONTENT: A video clip the user attached as a reference. No model reads video, so Roqer read it as frames. Clip id: ${manifest.id}.`,
    `Selection: ${selectionEffectSeconds(selection).toFixed(2)} s of effect time, from ${formatClipTime(selection.start)} to ${formatClipTime(selection.end)} of the ${manifest.duration.toFixed(2)} s clip.`,
    ...(selection.slow === 1
      ? []
      : [`The user says the clip plays ${selection.slow} times slower than real time, so every time here is real effect time: ${selection.slow} s of the clip is 1 s of the effect.`]),
    `Times are effect seconds from the start of the selection. Roqer stored ${manifest.frames.length} frames${rate === undefined ? "" : ` (about ${Math.round(rate)} a second)`}.`,
  ];
  if (imagesSent) {
    for (const sheet of sheets) {
      lines.push(`Image ${sheet.image} of this message, ${sheet.plan.title}: ${describeSheet(manifest, sheet.plan.indexes, sheet.cropped)}`);
    }
  } else {
    lines.push("Its frames were not sent: this sign-in cannot read images. Say so rather than guessing what the clip shows.");
  }
  lines.push(...describeClipAnalysis(manifest.analysis));
  lines.push(
    `To see any stretch frame by frame, call reference_clip with clip "${manifest.id}" and the effect seconds you want. To compare an effect you build with it, pass reference {"clip": "${manifest.id}"} to capture_moments: Roqer shows the clip's frames beside Studio's at the same moments.`,
    "If it shows a visual effect, load roblox-animation-vfx references/vfx-reference.md before building it.",
  );
  return lines.join("\n");
}

/** A clip as the attachment text and a missing-clip answer name it. */
export function clipSummary(manifest: ClipManifest): string {
  const length = (manifest.selection.end - manifest.selection.start) / manifest.selection.slow;
  return `${manifest.id} (${JSON.stringify(manifest.name)}, ${length.toFixed(2)} s, ${manifest.frames.length} frames)`;
}

export function referenceClipToolDefinition(): Readonly<{ name: typeof REFERENCE_CLIP_TOOL_NAME; description: string; inputSchema: JsonRecord }> {
  return {
    name: REFERENCE_CLIP_TOOL_NAME,
    description: [
      "Look closer at a video clip the user attached to this chat as a reference.",
      "Returns the clip's frames between two times as one image, in order, each labelled with its number and time: use it to see a fast moment frame by frame (a flash building, an impact, a ring growing, a fade), at up to the rate Roqer stored the clip at.",
      "Times are effect seconds from the start of the user's selection, as the clip's attachment gives them; a clip the user marked as slowed is already converted to real speed.",
      "Frames are cropped to where the clip changes unless crop is full.",
      "To compare an effect in Studio with the clip at the same moments, pass reference to capture_moments instead.",
    ].join(" "),
    inputSchema: {
      type: "object",
      properties: {
        clip: { type: "string", pattern: CLIP_ID_PATTERN, description: "The clip's id, as its attachment gave it." },
        from: { type: "number", minimum: 0, description: "The first effect second to show." },
        to: { type: "number", minimum: 0, description: "The last effect second to show." },
        count: {
          type: "integer",
          minimum: 1,
          maximum: MAX_REFERENCE_FRAMES,
          description: `How many frames to spread evenly from from to to; default ${DEFAULT_REFERENCE_FRAMES}. Fewer come back when the span holds fewer stored frames.`,
        },
        crop: { type: "string", enum: ["effect", "full"], description: "effect (the default) crops to where the clip changes; full shows the whole frame." },
      },
      required: ["clip", "from", "to"],
      additionalProperties: false,
    },
  };
}

/** The engine operation for a `reference_clip` call. Throws so every provider reports the same message. */
export function parseReferenceClipToolInput(value: unknown): { operation: string; args: JsonRecord } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MalformedToolCallError("reference_clip requires an object with clip, from and to.");
  }
  const record = value as JsonRecord;
  if (!isClipId(record.clip)) throw new MalformedToolCallError("reference_clip clip must be a clip's id, exactly as its attachment gave it (12 hexadecimal characters).");
  const time = (name: "from" | "to") => {
    const entry = record[name];
    if (typeof entry !== "number" || !Number.isFinite(entry) || entry < 0) throw new MalformedToolCallError(`reference_clip ${name} must be a number of effect seconds, 0 or more.`);
    return entry;
  };
  const from = time("from");
  const to = time("to");
  if (to < from) throw new MalformedToolCallError("reference_clip to must not be before from.");
  const args: JsonRecord = { clip: record.clip, from, to };
  if (record.count !== undefined && record.count !== null) {
    if (!Number.isSafeInteger(record.count) || (record.count as number) < 1 || (record.count as number) > MAX_REFERENCE_FRAMES) {
      throw new MalformedToolCallError(`reference_clip count must be a whole number from 1 to ${MAX_REFERENCE_FRAMES}.`);
    }
    args.count = record.count;
  }
  if (record.crop !== undefined && record.crop !== null) {
    if (record.crop !== "effect" && record.crop !== "full") throw new MalformedToolCallError("reference_clip crop must be effect or full.");
    args.crop = record.crop;
  }
  return { operation: REFERENCE_CLIP_OPERATION, args };
}

function failure(text: string, started: number): McpToolOutcome {
  return { ok: false, data: undefined, text, message: text, httpStatus: 200, durationMs: Date.now() - started };
}

/** Why a clip is not there, and which are. */
export async function missingClip(source: ClipSource, id: unknown): Promise<string> {
  const clips = await source.list().catch(() => [] as ClipManifest[]);
  const known = clips.length === 0
    ? "This chat holds no reference clips now: Roqer clears a clip 30 days after it was last used, so ask the user to attach it again."
    : `This chat's clips, most recently used first: ${clips.slice(0, 6).map(clipSummary).join("; ")}.`;
  return `This chat has no clip ${typeof id === "string" ? id : ""}. ${known}`;
}

export async function readReferenceClip(
  args: Record<string, unknown>,
  options: McpCallOptions,
  source: ClipSource,
  compose: ClipSheetComposer,
): Promise<McpToolOutcome> {
  const started = Date.now();
  let parsed: JsonRecord;
  try {
    parsed = parseReferenceClipToolInput(args).args;
  } catch (error) {
    return failure(error instanceof Error ? error.message : "reference_clip was not valid.", started);
  }
  const manifest = await source.read(parsed.clip as string);
  if (manifest === undefined) return failure(await missingClip(source, parsed.clip), started);
  const from = parsed.from as number;
  const to = parsed.to as number;
  let span = framesBetween(manifest, from, to);
  const length = frameEffectTime(manifest, manifest.frames.length - 1);
  if (span.length === 0) {
    if (from > length) return failure(`Clip ${manifest.id} ends at ${length.toFixed(2)} s of effect time; ask for a span inside 0-${length.toFixed(2)} s.`, started);
    // A span between two stored frames shows the one nearest its middle.
    span = [nearestFrame(manifest, (from + to) / 2)];
  }
  const indexes = spread(span, (parsed.count as number | undefined) ?? DEFAULT_REFERENCE_FRAMES);
  if (options.signal?.aborted) return failure("Run was cancelled.", started);
  const frames: Buffer[] = [];
  try {
    for (const index of indexes) frames.push(await source.frame(manifest, index));
  } catch (error) {
    return failure(`The clip's frames could not be read: ${error instanceof Error ? error.message : String(error)} Ask the user to attach it again.`, started);
  }
  const crop = parsed.crop === "full" ? undefined : manifest.analysis.crop;
  const sheet = await compose(frames, { columns: sheetColumns(indexes.length), labels: sheetLabels(manifest, indexes), ...(crop === undefined ? {} : { crop }) })
    .catch(() => undefined);
  if (sheet === undefined) return failure("Roqer could not tile the clip's frames into an image.", started);
  const text = [
    `Clip ${clipSummary(manifest)}: ${describeSheet(manifest, indexes, crop !== undefined)}`,
    ...(crop === undefined ? [] : ["Pass crop: \"full\" to see the whole frame."]),
  ].join("\n");
  return {
    ok: true,
    data: { clip: manifest.id, frames: indexes.map((index) => ({ time: frameEffectTime(manifest, index) })) },
    text,
    images: [sheet],
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}
