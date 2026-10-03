import { CAPTURE_MOMENTS_OPERATION, MAX_CAPTURE_MOMENTS } from "../shared/gateway-operations";
import { timeoutForTool } from "../shared/mcp-tools";
import { isClipId } from "../shared/reference-clip";
import type { CropBox } from "./clip-analysis";
import type { ClipManifest } from "./clip-store";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";
import { frameEffectTime, missingClip, nearestFrame, type ChatClips } from "./reference-clip";
import { frameLabel } from "./sheet-labels";

/**
 * `capture_moments`: a playing effect, seen at several moments, in one call.
 *
 * Checking an effect by eye used to take the model three calls a moment: hold
 * it at a time, capture, resume. Every model call re-reads the whole
 * conversation, so a run that looked at sixteen moments spent about forty
 * calls on it, each one more expensive than the last. Here the model sends the
 * code that starts the effect and the times it wants, and Roqer walks the
 * moments itself through the same bridge calls.
 *
 * It also sees what holding cannot. A trail ages in real time while its effect
 * is held, so a held frame shows no trail; with `hold: false` the effect keeps
 * playing slowly through each capture instead.
 */

/** Real seconds one wait may take: under the bridge's 30 s budget for the call that waits. */
const MAX_WAIT_SECONDS = 20;
/** Waits one moment may take before it is captured wherever the clock got to. */
const MAX_WAITS_PER_MOMENT = 4;
/** Real seconds with the clock standing still before a wait gives up: the effect has ended. */
const STALLED_SECONDS = 1.5;
/**
 * Real seconds of the approach to each moment that are played at slow speed.
 * The rest of the way is played at normal speed, so a late moment costs its
 * own length in real time rather than that length divided by the slow speed:
 * at 0.04x, 1.2 s of effect is 30 s of waiting, past the bridge's budget.
 * Slowing down only for the last stretch keeps the stop precise and lets a
 * trail be drawn at the speed it is captured at.
 */
const SLOW_APPROACH_SECONDS = 1.5;
/**
 * Effect seconds before a moment that a trail capture (`hold: false`) plays
 * at slow speed, at most. A trail segment keeps the lifetime it was drawn
 * with, so the segments drawn at normal speed are gone within half a second of
 * real time, and only what was drawn slowly survives into the frame. The
 * approach covers the longest trail lifetime seen in the studied effects
 * (0.85 s), so the whole visible trail is drawn at the speed it is captured
 * at. It is also kept within one wait (`slow` x `MAX_WAIT_SECONDS`): the emit
 * module caps a slowed trail's lifetime at 20 s of real time, so nothing drawn
 * earlier than that would still show.
 */
const TRAIL_APPROACH_SECONDS = 0.9;
/** Milliseconds of a call's budget kept for the last screenshot, stopping the effect and tiling. */
const BUDGET_RESERVE_MS = 20_000;
const MAX_CODE_CHARS = 20_000;
const MAX_TIME_SECONDS = 60;
const HANDLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/**
 * Real seconds the effect is held at its start while its textures load.
 *
 * A texture fetched for the first time takes a moment to arrive, and an
 * uploaded one always is the first time: the explosion run's first capture
 * after its upload missed layers in its early frames and had to be taken
 * again, a whole call and a whole image for nothing. Holding the effect while
 * `ContentProvider` loads what it uses costs a few seconds instead. Kept well
 * under one wait so it never eats the budget the moments need.
 */
const PRELOAD_SECONDS = 10;

type Moment = { requested: number; reached?: number; short?: "ended" | "waited"; image?: number; note?: string };

/** Where to aim the edit camera before the effect starts, as `selection` view takes it. */
export type CaptureView = Readonly<{ path: string; from?: number; angleY?: number; padding?: number }>;

/** A reference clip to pair the moments with, and the clip's time for each, in effect seconds. */
export type CaptureReference = Readonly<{ clip: string; times?: readonly number[] }>;

export type CaptureMomentsArgs = Readonly<{
  code: string;
  times: readonly number[];
  runtime: "edit" | "client";
  target?: string;
  handle: string;
  hold: boolean;
  slow: number;
  sheet: boolean;
  view?: CaptureView;
  reference?: CaptureReference;
}>;

/** The reference argument, checked against the moments, or why it cannot be used. */
function parseReference(value: unknown, times: readonly number[]): CaptureReference | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return "reference must be an object such as {clip, times}.";
  const { clip, times: clipTimes } = value as Record<string, unknown>;
  if (!isClipId(clip)) return "reference.clip must be a clip's id, exactly as its attachment gave it (12 hexadecimal characters).";
  if (clipTimes === undefined || clipTimes === null) return { clip };
  if (!Array.isArray(clipTimes) || clipTimes.length !== times.length ||
    !clipTimes.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0)) {
    return `reference.times must list one effect second of the clip for each of the ${times.length} moments, or be left out to use the same times.`;
  }
  return { clip, times: clipTimes as number[] };
}

/** The view argument, checked, or why it cannot be used. */
function parseView(value: unknown, runtime: string): CaptureView | string | undefined {
  if (value === undefined || value === null) return undefined;
  if (runtime === "client") return "view aims the edit camera; with runtime client the frames are the player's own view, so leave view out.";
  if (typeof value !== "object" || Array.isArray(value)) return "view must be an object such as {path, from, angleY, padding}.";
  const { path, from, angleY, padding } = value as Record<string, unknown>;
  if (typeof path !== "string" || path === "") return "view.path must name the instance to frame, such as the effect's marker part.";
  const numbers = { from, angleY, padding };
  for (const [name, entry] of Object.entries(numbers)) {
    if (entry !== undefined && (typeof entry !== "number" || !Number.isFinite(entry))) return `view.${name} must be a number.`;
  }
  return {
    path,
    ...(from === undefined ? {} : { from: from as number }),
    ...(angleY === undefined ? {} : { angleY: angleY as number }),
    ...(padding === undefined ? {} : { padding: padding as number }),
  };
}

/**
 * Tiles frames into one image, `columns` to a row, or undefined when it
 * cannot. The host supplies it, since decoding images needs Electron; without
 * one, frames go back one image each. A frame may be cropped first, and a
 * tile may carry a label.
 */
export type ContactSheet = (
  images: readonly McpToolImage[],
  columns: number,
  options?: Readonly<{ crops?: readonly (CropBox | undefined)[]; labels?: readonly string[]; wide?: boolean }>,
) => Promise<McpToolImage | undefined>;

/** Frames to a row on a contact sheet: two show each frame at half the width it would have sent alone (1000 pixels on a wide viewport). */
const SHEET_COLUMNS = 2;

/** The call's arguments, checked, or why they cannot run. */
export function parseCaptureMoments(args: Record<string, unknown>): CaptureMomentsArgs | string {
  const { code, times, runtime = "edit", target, handle = "vfx", hold = true, slow, sheet = true } = args;
  if (typeof code !== "string" || code.trim() === "") return "code must be the Luau that starts the effect.";
  if (code.length > MAX_CODE_CHARS) return `code is ${code.length} characters; keep it under ${MAX_CODE_CHARS}: start the effect from a module rather than inlining it.`;
  if (!Array.isArray(times) || times.length === 0 || times.length > MAX_CAPTURE_MOMENTS) {
    return `times must list 1-${MAX_CAPTURE_MOMENTS} effect seconds.`;
  }
  if (!times.every((time) => typeof time === "number" && Number.isFinite(time) && time >= 0 && time <= MAX_TIME_SECONDS)) {
    return `every time must be a number of effect seconds from 0 to ${MAX_TIME_SECONDS}.`;
  }
  if (times.some((time, index) => index > 0 && time <= (times[index - 1] as number))) return "times must be in ascending order, with no repeats.";
  if (runtime !== "edit" && runtime !== "client") return "runtime must be edit or client.";
  if (target !== undefined && (typeof target !== "string" || target === "")) return "target must name a client peer, such as client-1.";
  if (typeof handle !== "string" || !HANDLE_NAME.test(handle)) return "handle must be a plain global name, such as vfx.";
  if (typeof hold !== "boolean") return "hold must be true or false.";
  if (typeof sheet !== "boolean") return "sheet must be true or false.";
  const speed = slow === undefined ? (hold ? 0.1 : 0.04) : slow;
  if (typeof speed !== "number" || !Number.isFinite(speed) || speed < 0.01 || speed > 1) return "slow must be a playback speed from 0.01 to 1.";
  const view = parseView(args.view, runtime);
  if (typeof view === "string") return view;
  const reference = parseReference(args.reference, times as number[]);
  if (typeof reference === "string") return reference;
  return {
    code,
    times: times as number[],
    runtime,
    ...(runtime === "client" ? { target: typeof target === "string" ? target : "client-1" } : {}),
    handle,
    hold,
    slow: speed,
    sheet,
    ...(view === undefined ? {} : { view }),
    ...(reference === undefined ? {} : { reference }),
  };
}

/**
 * Luau that holds the effect where it is and waits, for at most
 * `PRELOAD_SECONDS`, for everything under its root to load: "loaded",
 * "loading" when the wait ran out, or "no-root" for a handle that does not
 * say what it is playing. The first moment's playback sets the speed again.
 */
export function preloadLuau(handle: string): string {
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) ~= "table" or type(h.setTimeScale) ~= "function" then return "no-handle" end`,
    "local root = h.root",
    `if typeof(root) ~= "Instance" then return "no-root" end`,
    "if h.finished ~= true then h:setTimeScale(0) end",
    `local ContentProvider = game:GetService("ContentProvider")`,
    "local done = false",
    "task.spawn(function()",
    "\tpcall(function() ContentProvider:PreloadAsync({ root }) end)",
    "\tdone = true",
    "end)",
    "local started = os.clock()",
    `while not done and os.clock() - started < ${PRELOAD_SECONDS} do task.wait() end`,
    `return done and "loaded" or "loading"`,
  ].join("\n");
}

/**
 * Luau that plays the effect on to `time`, at normal speed until the last
 * stretch and at `slow` for it, holds it there when asked, and says where it
 * got to and why it stopped: "done", "stalled" (the clock stood still, so the
 * effect has ended) or "capped" (this call's wait ran out first).
 */
export function momentLuau(handle: string, time: number, slow: number, hold: boolean): string {
  const trail = Math.min(TRAIL_APPROACH_SECONDS, slow * MAX_WAIT_SECONDS);
  const approach = Math.round(Math.max(slow * SLOW_APPROACH_SECONDS, hold ? 0 : trail) * 1000) / 1000;
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) ~= "table" or type(h.setTimeScale) ~= "function" then return "no-handle" end`,
    `local target = ${time}`,
    "local function clock() return tonumber(h.time) or 0 end",
    // A finished handle has put back what it changed (an effect played in
    // place restores its emitters and trails); scaling it again would undo that.
    "local function scale(speed) if h.finished ~= true then h:setTimeScale(speed) end end",
    // An effect that has ended stops its clock; waiting on for the full cap would only cost time.
    "local started, last, moved = os.clock(), clock(), os.clock()",
    "local function playTo(stop, speed)",
    "\tscale(speed)",
    `\twhile clock() < stop and h.finished ~= true and os.clock() - started < ${MAX_WAIT_SECONDS} and os.clock() - moved < ${STALLED_SECONDS} do`,
    "\t\ttask.wait()",
    "\t\tlocal now = clock()",
    "\t\tif now ~= last then last, moved = now, os.clock() end",
    "\tend",
    "end",
    `if clock() < target - ${approach} then playTo(target - ${approach}, 1) end`,
    `playTo(target, ${slow})`,
    ...(hold ? ["scale(0)"] : []),
    `local status = clock() >= target and "done" or ((h.finished == true or os.clock() - moved >= ${STALLED_SECONDS}) and "stalled" or "capped")`,
    `return string.format("%.3f|%s", clock(), status)`,
  ].join("\n");
}

/** Luau that ends the effect, so nothing it made is left in the place. */
export function stopLuau(handle: string): string {
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) == "table" and type(h.stop) == "function" then pcall(h.stop, h) end`,
    `_G[${JSON.stringify(handle)}] = nil`,
    `return "stopped"`,
  ].join("\n");
}

function failure(text: string, started: number, images: readonly McpToolImage[] = []): McpToolOutcome {
  return { ok: false, data: undefined, text, httpStatus: 200, durationMs: Date.now() - started, ...(images.length > 0 ? { images } : {}) };
}

function returned(outcome: McpToolOutcome): string {
  const data = outcome.data;
  if (typeof data === "object" && data !== null) {
    for (const key of ["returnValue", "result"]) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === "string") return value;
    }
  }
  return outcome.text;
}

/**
 * The moments beside a reference clip's frames at the matching times, as one
 * image: for each moment, the clip's frame (cropped to where the clip changes)
 * then Studio's, labelled R and S with the pair's number and time, two pairs
 * to a row. Undefined when the clip's frames cannot be read or tiled; the
 * moments then go back on their own.
 */
async function pairWithReference(
  parsed: CaptureMomentsArgs & { reference: CaptureReference },
  manifest: ClipManifest,
  moments: readonly Moment[],
  images: readonly McpToolImage[],
  references: ChatClips,
  contactSheet: ContactSheet,
): Promise<{ sheet: McpToolImage; lines: Map<Moment, string> } | undefined> {
  const tiles: McpToolImage[] = [];
  const labels: string[] = [];
  const crops: (CropBox | undefined)[] = [];
  const lines = new Map<Moment, string>();
  for (const moment of moments) {
    if (moment.image === undefined) continue;
    const at = parsed.reference.times?.[parsed.times.indexOf(moment.requested)] ?? moment.requested;
    const index = nearestFrame(manifest, at);
    const clipTime = frameEffectTime(manifest, index);
    // A time past either end of the clip shows its nearest frame, and says so.
    const last = frameEffectTime(manifest, manifest.frames.length - 1);
    const outside = at > last + 0.02 ? ` (the clip ends at ${last.toFixed(2)} s; its last frame is shown)` : "";
    const frame = await references.frame(manifest, index);
    const pair = lines.size + 1;
    tiles.push({ data: frame.toString("base64"), mediaType: "image/jpeg" }, images[moment.image - 1] as McpToolImage);
    labels.push(frameLabel(pair, clipTime, "R"), frameLabel(pair, moment.reached ?? moment.requested, "S"));
    crops.push(manifest.analysis.crop, undefined);
    lines.set(moment, `pair ${pair}, beside the clip at ${clipTime.toFixed(2)} s${outside}`);
  }
  if (lines.size === 0) return undefined;
  const sheet = await contactSheet(tiles, lines.size === 1 ? 2 : 4, { labels, crops, wide: true });
  return sheet === undefined ? undefined : { sheet, lines };
}

export async function captureMoments(
  args: Record<string, unknown>,
  options: McpCallOptions,
  studio: StudioCaller,
  contactSheet?: ContactSheet,
  references?: ChatClips,
): Promise<McpToolOutcome> {
  const started = Date.now();
  const parsed = parseCaptureMoments(args);
  if (typeof parsed === "string") return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: ${parsed}`, started);
  // A clip to compare with is found before anything starts in Studio, so a
  // wrong id costs nothing but this answer.
  let manifest: ClipManifest | undefined;
  if (parsed.reference !== undefined) {
    if (references === undefined) {
      return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: this chat holds no reference clips to compare with. Leave reference out.`, started);
    }
    manifest = await references.read(parsed.reference.clip);
    if (manifest === undefined) return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: ${await missingClip(references, parsed.reference.clip)}`, started);
  }
  const runner = parsed.runtime === "client" ? "eval_client_runtime" : "execute_luau";
  // Clean-up runs even after a cancel, so it is the one call without the run's signal.
  const run = (code: string, cleanup = false) => {
    const runArgs = { code, ...(parsed.target === undefined ? {} : { target: parsed.target }) };
    return studio(runner, runArgs, { ...(cleanup ? {} : { signal: options.signal }), timeoutMs: timeoutForTool(runner, runArgs) });
  };

  if (parsed.view !== undefined) {
    // The same read a separate selection call makes, without a model turn of its own.
    const viewArgs = { action: "view", ...parsed.view };
    const aimed = await studio("selection", viewArgs, { signal: options.signal, timeoutMs: timeoutForTool("selection", viewArgs) });
    if (!aimed.ok) return failure(`Aiming the camera at ${parsed.view.path} failed, so nothing was started or captured: ${aimed.message ?? aimed.text}`, started);
  }

  const start = await run(parsed.code);
  if (!start.ok) {
    // It may have failed after making something, so the effect is ended either way.
    await run(stopLuau(parsed.handle), true).catch(() => undefined);
    return failure(`The code that starts the effect failed, so nothing was captured: ${start.message ?? start.text}`, started);
  }

  // A failed or unanswered preload only costs the frames it would have
  // filled in, so the moments are captured either way.
  const preload = await run(preloadLuau(parsed.handle)).catch(() => undefined);
  const stillLoading = preload?.ok === true && returned(preload).trim() === "loading";

  // The whole call stays inside the budget the engine gave it, with room left
  // for the last screenshot and for stopping the effect.
  const deadline = started + (options.timeoutMs ?? timeoutForTool(CAPTURE_MOMENTS_OPERATION)) - BUDGET_RESERVE_MS;
  const canWait = () => Date.now() + MAX_WAIT_SECONDS * 1000 <= deadline;
  const moments: Moment[] = [];
  const images: McpToolImage[] = [];
  const skipped: number[] = [];
  let stopped: string | undefined;
  try {
    for (const time of parsed.times) {
      if (options.signal?.aborted) throw new Error("Run was cancelled.");
      if (!canWait()) {
        skipped.push(time);
        continue;
      }
      const moment: Moment = { requested: time };
      moments.push(moment);
      // A wait that ran out of its call's budget carries on in another call, up to a limit.
      let reply = "";
      let failed: McpToolOutcome | undefined;
      for (let attempt = 0; attempt < MAX_WAITS_PER_MOMENT; attempt++) {
        const step = await run(momentLuau(parsed.handle, time, parsed.slow, parsed.hold));
        reply = returned(step).trim();
        if (!step.ok) failed = step;
        if (!step.ok || !reply.endsWith("|capped") || !canWait()) break;
      }
      if (failed !== undefined || reply === "no-handle") {
        stopped = failed !== undefined
          ? `Moving to ${time} s failed: ${failed.message ?? failed.text}`
          : `_G.${parsed.handle} is not a handle with setTimeScale after the code ran; store the effect's handle there.`;
        break;
      }
      const value = Number(reply.split("|")[0]);
      if (Number.isFinite(value) && value >= 0) {
        moment.reached = value;
        // A handle whose clock stopped, or that the waits outran, is captured anyway, and said so.
        if (value + 0.005 < time) moment.short = reply.endsWith("|capped") ? "waited" : "ended";
      }
      const shot = await studio("capture_screenshot", {}, { signal: options.signal, timeoutMs: timeoutForTool("capture_screenshot") });
      const image = shot.ok ? shot.images?.[0] : undefined;
      if (image === undefined) {
        moment.note = `capture failed: ${shot.message ?? shot.text}`.slice(0, 300);
        continue;
      }
      images.push(image);
      moment.image = images.length;
    }
  } finally {
    // Always end the effect, so its clones and a held clock are not left behind.
    await run(stopLuau(parsed.handle), true).catch(() => undefined);
  }

  // A sheet of up to eight frames costs the model about what two frames do, so the frames go as one unless asked otherwise.
  let delivered = images;
  let tiled = false;
  let paired: Map<Moment, string> | undefined;
  let pairingNote: string | undefined;
  if (parsed.reference !== undefined && manifest !== undefined && references !== undefined && contactSheet !== undefined && images.length > 0) {
    const comparison = await pairWithReference({ ...parsed, reference: parsed.reference }, manifest, moments, images, references, contactSheet)
      .catch(() => undefined);
    if (comparison === undefined) {
      pairingNote = "Roqer could not pair the frames with the clip's, so they come back on their own.";
    } else {
      delivered = [comparison.sheet];
      paired = comparison.lines;
    }
  }
  if (paired === undefined && parsed.sheet && contactSheet !== undefined && images.length > 1) {
    const sheet = await contactSheet(images, SHEET_COLUMNS).catch(() => undefined);
    if (sheet !== undefined) {
      delivered = [sheet];
      tiled = true;
    }
  }
  const lines = moments.map((moment) => {
    const at = moment.reached === undefined ? "" : `, at ${moment.reached.toFixed(3)} s`;
    const short = moment.short === "ended"
      ? ` (the clock stopped short of ${moment.requested} s: the effect had ended)`
      : moment.short === "waited"
        ? ` (still short of ${moment.requested} s when the waiting ran out)`
        : "";
    const picture = moment.image === undefined
      ? moment.note ?? "not captured"
      : paired?.get(moment) ?? `${tiled ? "frame" : "image"} ${moment.image}`;
    return `- ${moment.requested} s${at}${short}: ${picture}`;
  });
  const how = parsed.hold ? "held still for each capture" : `kept playing at ${parsed.slow}x through each capture, so a frame may run a little past its time`;
  const layout = paired !== undefined
    ? `Each moment is paired with reference clip ${manifest!.id} in one image, two pairs to a row, left to right then top to bottom: the clip's frame at the matching time (labelled R${manifest!.analysis.crop === undefined ? "" : ", cropped to where the clip changes"}), then Studio's (labelled S), each label carrying the pair's number and time. Compare each pair for when it starts, peaks and fades, its size against the frame, its colours and its shape; the clip was filmed from its own camera, so compare proportions rather than position.`
    : tiled
      ? `The frames are tiled into one image, ${SHEET_COLUMNS} to a row, left to right then top to bottom. For one frame at full size, call again with sheet: false and just that time.`
      : "The images follow in this order:";
  const text = [
    `Captured ${images.length} of ${parsed.times.length} moments, ${how}. ${layout}`,
    ...(pairingNote === undefined ? [] : [pairingNote]),
    ...(stillLoading ? [`Its textures were still loading after ${PRELOAD_SECONDS} s, so early frames may be missing layers; if they are, capture again.`] : []),
    ...lines,
    ...(skipped.length === 0 ? [] : [`Not captured, because this call's time ran out first: ${skipped.map((time) => `${time} s`).join(", ")}. Capture them in another call.`]),
    ...(stopped === undefined ? [] : [stopped]),
    "Roqer stopped the effect afterwards.",
  ].join("\n");
  if (images.length === 0) return failure(text, started);
  return {
    ok: stopped === undefined,
    data: { moments, ...(paired === undefined ? {} : { comparedWith: manifest!.id }) },
    text,
    images: delivered,
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}
