import { CAPTURE_MOMENTS_OPERATION, MAX_CAPTURE_MOMENTS } from "../shared/gateway-operations";
import { timeoutForTool } from "../shared/mcp-tools";
import type { StudioCaller } from "./local-operations";
import type { McpCallOptions, McpToolImage, McpToolOutcome } from "./mcp-types";

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

/** Real seconds one moment may wait at slow speed: under the bridge's 30s budget for the call that waits. */
const MAX_WAIT_SECONDS = 20;
/** Real seconds with the clock standing still before a wait gives up: the effect has ended. */
const STALLED_SECONDS = 1.5;
const MAX_CODE_CHARS = 20_000;
const MAX_TIME_SECONDS = 60;
const HANDLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

type Moment = { requested: number; reached?: number; short?: boolean; image?: number; note?: string };

export type CaptureMomentsArgs = Readonly<{
  code: string;
  times: readonly number[];
  runtime: "edit" | "client";
  target?: string;
  handle: string;
  hold: boolean;
  slow: number;
  sheet: boolean;
}>;

/**
 * Tiles frames into one image, `columns` to a row, or undefined when it
 * cannot. The host supplies it, since decoding images needs Electron; without
 * one, frames go back one image each.
 */
export type ContactSheet = (images: readonly McpToolImage[], columns: number) => Promise<McpToolImage | undefined>;

/** Frames to a row on a contact sheet: two keep each frame about 780 pixels wide as the model sees it. */
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
  return {
    code,
    times: times as number[],
    runtime,
    ...(runtime === "client" ? { target: typeof target === "string" ? target : "client-1" } : {}),
    handle,
    hold,
    slow: speed,
    sheet,
  };
}

/** Luau that plays the effect on to `time` at `slow`, holds it there when asked, and says where it got to. */
export function momentLuau(handle: string, time: number, slow: number, hold: boolean): string {
  return [
    `local h = _G[${JSON.stringify(handle)}]`,
    `if type(h) ~= "table" or type(h.setTimeScale) ~= "function" then return "no-handle" end`,
    `h:setTimeScale(${slow})`,
    // An effect that has ended stops its clock; waiting on for the full cap would only cost time.
    "local started, last, moved = os.clock(), tonumber(h.time) or 0, os.clock()",
    `while (tonumber(h.time) or 0) < ${time} and os.clock() - started < ${MAX_WAIT_SECONDS} and os.clock() - moved < ${STALLED_SECONDS} do`,
    "\ttask.wait()",
    "\tlocal now = tonumber(h.time) or 0",
    "\tif now ~= last then last, moved = now, os.clock() end",
    "end",
    ...(hold ? ["h:setTimeScale(0)"] : []),
    `return string.format("%.3f", tonumber(h.time) or -1)`,
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

export async function captureMoments(
  args: Record<string, unknown>,
  options: McpCallOptions,
  studio: StudioCaller,
  contactSheet?: ContactSheet,
): Promise<McpToolOutcome> {
  const started = Date.now();
  const parsed = parseCaptureMoments(args);
  if (typeof parsed === "string") return failure(`${CAPTURE_MOMENTS_OPERATION} was not run: ${parsed}`, started);
  const runner = parsed.runtime === "client" ? "eval_client_runtime" : "execute_luau";
  // Clean-up runs even after a cancel, so it is the one call without the run's signal.
  const run = (code: string, cleanup = false) => {
    const runArgs = { code, ...(parsed.target === undefined ? {} : { target: parsed.target }) };
    return studio(runner, runArgs, { ...(cleanup ? {} : { signal: options.signal }), timeoutMs: timeoutForTool(runner, runArgs) });
  };

  const start = await run(parsed.code);
  if (!start.ok) {
    // It may have failed after making something, so the effect is ended either way.
    await run(stopLuau(parsed.handle), true).catch(() => undefined);
    return failure(`The code that starts the effect failed, so nothing was captured: ${start.message ?? start.text}`, started);
  }

  const moments: Moment[] = [];
  const images: McpToolImage[] = [];
  let stopped: string | undefined;
  try {
    for (const time of parsed.times) {
      if (options.signal?.aborted) throw new Error("Run was cancelled.");
      const moment: Moment = { requested: time };
      moments.push(moment);
      const step = await run(momentLuau(parsed.handle, time, parsed.slow, parsed.hold));
      const reached = returned(step).trim();
      if (!step.ok || reached === "no-handle") {
        stopped = !step.ok
          ? `Moving to ${time} s failed: ${step.message ?? step.text}`
          : `_G.${parsed.handle} is not a handle with setTimeScale after the code ran; store the effect's handle there.`;
        break;
      }
      const value = Number(reached);
      if (Number.isFinite(value) && value >= 0) {
        moment.reached = value;
        // A handle whose clock stopped, or that the wait outran, is captured anyway, and said so.
        if (value + 0.005 < time) moment.short = true;
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

  // One tiled image costs the model about what one frame does, so the frames go as a sheet unless asked otherwise.
  let delivered = images;
  let tiled = false;
  if (parsed.sheet && contactSheet !== undefined && images.length > 1) {
    const sheet = await contactSheet(images, SHEET_COLUMNS).catch(() => undefined);
    if (sheet !== undefined) {
      delivered = [sheet];
      tiled = true;
    }
  }
  const lines = moments.map((moment) => {
    const at = moment.reached === undefined ? "" : `, at ${moment.reached.toFixed(3)} s`;
    const short = moment.short ? ` (the clock stopped short of ${moment.requested} s: the effect ended, or it needed more than ${MAX_WAIT_SECONDS} s at ${parsed.slow}x)` : "";
    const picture = moment.image === undefined ? moment.note ?? "not captured" : `${tiled ? "frame" : "image"} ${moment.image}`;
    return `- ${moment.requested} s${at}${short}: ${picture}`;
  });
  const how = parsed.hold ? "held still for each capture" : `kept playing at ${parsed.slow}x through each capture, so a frame may run a little past its time`;
  const layout = tiled
    ? `The frames are tiled into one image, ${SHEET_COLUMNS} to a row, left to right then top to bottom. For one frame at full size, call again with sheet: false and just that time.`
    : "The images follow in this order:";
  const text = [
    `Captured ${images.length} of ${parsed.times.length} moments, ${how}. ${layout}`,
    ...lines,
    ...(stopped === undefined ? [] : [stopped]),
    "Roqer stopped the effect afterwards.",
  ].join("\n");
  if (images.length === 0) return failure(text, started);
  return {
    ok: stopped === undefined,
    data: { moments },
    text,
    images: delivered,
    httpStatus: 200,
    durationMs: Date.now() - started,
  };
}
