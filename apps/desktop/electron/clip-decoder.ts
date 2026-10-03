import { BrowserWindow, session as electronSession } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { MAX_CLIP_FRAME_RATE, MAX_CLIP_FRAMES, type ClipSelection } from "../shared/reference-clip";

/**
 * Roqer's clip decoder: a hidden window that reads frames from a video or an
 * animated picture, owned and driven by the main process.
 *
 * Chromium already decodes the formats people record and download (H.264,
 * VP8, VP9 and AV1 in MP4, MOV, MKV and WebM, and HEVC where the graphics card
 * does), so no decoder ships with Roqer. The work happens here rather than in
 * the chat window because the chat window is the less trusted side: it never
 * holds the file, and nothing it says becomes a frame or a measurement.
 *
 * The window is sandboxed, on a session of its own that keeps nothing and
 * grants no permission, cannot navigate or open windows, and runs only its
 * own script. It answers with numbers, failure codes and JPEG bytes, which are
 * checked here; a failure is turned into Roqer's own message, so no text a
 * crafted file makes the page produce reaches the user or the model.
 *
 * One window serves every request, one request at a time. It closes after a
 * minute unused, and is made again if its renderer dies or a request hangs.
 */

export type ClipFileSource = Readonly<{ kind: "video"; path: string }>;
export type ClipImageSource = Readonly<{ kind: "image"; bytes: Buffer; mediaType: string }>;
export type ClipDecodeSource = ClipFileSource | ClipImageSource;

export type ClipInfo = Readonly<{ duration: number; width: number; height: number }>;
export type DecodedFrame = Readonly<{ time: number; jpeg: Buffer }>;

/** Why a clip could not be read, in Roqer's own words. */
export class ClipDecodeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ClipDecodeError";
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  "unsupported": "Roqer cannot play this video's format here. Export it as an MP4 (H.264) and attach that. Chromium reads H.264, VP8, VP9 and AV1; HEVC only where the graphics card decodes it, and ProRes not at all.",
  "no-video": "This file has no picture to read: attach a video with a video track.",
  "decode": "Roqer could not read frames from this video. It may be damaged, or in a format Chromium cannot decode: export it as an MP4 (H.264) and attach that.",
  "timeout": "Reading the video took too long. Try a shorter selection, or a smaller copy of the video.",
  "not-animated": "That picture has a single frame, so it is not a clip.",
  "bad-request": "Roqer asked the clip decoder for something it could not do.",
  "crashed": "The clip decoder stopped while reading the video. Try again, or export it as an MP4 (H.264) and attach that.",
};

const IDLE_CLOSE_MS = 60_000;
/** The longest one request may take beyond the playback it contains. */
const REQUEST_MARGIN_MS = 30_000;
/** Frames taken from the page per call, so no answer is very large. */
const TAKE_BATCH = 24;
/** A frame's largest base64 size: a 1280-pixel JPEG is far below it. */
const MAX_FRAME_BASE64 = 6 * 1024 * 1024;
const MAX_DURATION_SECONDS = 6 * 60 * 60;
const MAX_DIMENSION = 16_384;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

function failureOf(value: unknown): ClipDecodeError | undefined {
  if (!isRecord(value) || typeof value.error !== "string") return undefined;
  const code = Object.prototype.hasOwnProperty.call(MESSAGES, value.error) ? value.error : "decode";
  return new ClipDecodeError(code, MESSAGES[code]!);
}

function checkedInfo(value: unknown): ClipInfo {
  const failed = failureOf(value);
  if (failed !== undefined) throw failed;
  if (!isRecord(value)) throw new ClipDecodeError("decode", MESSAGES.decode!);
  const { duration, width, height } = value;
  if (!isFiniteNumber(duration) || duration <= 0 || duration > MAX_DURATION_SECONDS ||
    !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
    (width as number) < 1 || (height as number) < 1 || (width as number) > MAX_DIMENSION || (height as number) > MAX_DIMENSION) {
    throw new ClipDecodeError("decode", MESSAGES.decode!);
  }
  return { duration, width: width as number, height: height as number };
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function checkedFrames(value: unknown, limit: number): DecodedFrame[] {
  const failed = failureOf(value);
  if (failed !== undefined) throw failed;
  if (!isRecord(value) || !Array.isArray(value.frames) || value.frames.length > limit) throw new ClipDecodeError("decode", MESSAGES.decode!);
  return value.frames.map((frame: unknown) => {
    if (!isRecord(frame) || !isFiniteNumber(frame.time) || frame.time < 0 ||
      typeof frame.data !== "string" || frame.data.length > MAX_FRAME_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) {
      throw new ClipDecodeError("decode", MESSAGES.decode!);
    }
    const jpeg = Buffer.from(frame.data, "base64");
    if (!isJpeg(jpeg)) throw new ClipDecodeError("decode", MESSAGES.decode!);
    return { time: frame.time, jpeg };
  });
}

/** The rate a selection is kept at: as fast as the clip, at most 60, and at most `MAX_CLIP_FRAMES` in all. */
export function captureRate(selection: ClipSelection): number {
  return Math.min(MAX_CLIP_FRAME_RATE, MAX_CLIP_FRAMES / Math.max(0.05, selection.end - selection.start));
}

export class ClipDecoder {
  readonly #page: string;
  #window: BrowserWindow | null = null;
  #opening: Promise<BrowserWindow> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #idle: NodeJS.Timeout | null = null;
  #closed = false;

  /** `page`: the decoder's HTML, beside the compiled main process. */
  constructor(page: string) {
    this.#page = page;
  }

  /** How long a clip is and how large its frames are. */
  info(source: ClipDecodeSource): Promise<ClipInfo> {
    return this.#run(async (call) => checkedInfo(source.kind === "video"
      ? await call("probeVideo", [pathToFileURL(source.path).href], REQUEST_MARGIN_MS)
      : await call("probeImage", [source.bytes.toString("base64"), source.mediaType], REQUEST_MARGIN_MS)));
  }

  /** One frame at each of `times` (clip seconds), `edge` pixels on the long side: thumbnails for choosing a selection. */
  strip(source: ClipDecodeSource, times: readonly number[], edge: number): Promise<DecodedFrame[]> {
    const budget = REQUEST_MARGIN_MS + times.length * 1_000;
    return this.#run(async (call) => checkedFrames(source.kind === "video"
      ? await call("stripVideo", [pathToFileURL(source.path).href, times, edge], budget)
      : await call("stripImage", [source.bytes.toString("base64"), source.mediaType, times, edge], budget), times.length));
  }

  /**
   * Every frame of a selection, up to `captureRate` a second, `edge` pixels on
   * the long side. A video plays the selection through in real time, so this
   * takes about as long as the selection lasts.
   */
  capture(source: ClipDecodeSource, selection: ClipSelection, edge: number): Promise<Readonly<{ frames: DecodedFrame[]; nativeRate: number }>> {
    const rate = captureRate(selection);
    const playback = (selection.end - selection.start) * 1000;
    const budget = playback * 2 + REQUEST_MARGIN_MS;
    return this.#run(async (call) => {
      const started = source.kind === "video"
        ? await call("captureVideo", [pathToFileURL(source.path).href, selection.start, selection.end, edge, rate, budget - 10_000], budget)
        : await call("captureImage", [source.bytes.toString("base64"), source.mediaType, selection.start, selection.end, edge, rate], budget);
      const failed = failureOf(started);
      if (failed !== undefined) throw failed;
      if (!isRecord(started) || !Number.isSafeInteger(started.count) || (started.count as number) < 0 || !isFiniteNumber(started.nativeRate)) {
        throw new ClipDecodeError("decode", MESSAGES.decode!);
      }
      const count = Math.min(started.count as number, MAX_CLIP_FRAMES);
      const frames: DecodedFrame[] = [];
      try {
        for (let from = 0; from < count; from += TAKE_BATCH) {
          frames.push(...checkedFrames(await call("take", [from, Math.min(TAKE_BATCH, count - from)], REQUEST_MARGIN_MS), TAKE_BATCH));
        }
      } finally {
        await call("clear", [], REQUEST_MARGIN_MS).catch(() => undefined);
      }
      if (frames.length === 0) throw new ClipDecodeError("decode", MESSAGES.decode!);
      // Ascending and distinct, whatever the page sent.
      const ordered = frames.sort((a, b) => a.time - b.time).filter((frame, index, all) => index === 0 || frame.time > all[index - 1]!.time + 0.0001);
      return { frames: ordered, nativeRate: started.nativeRate };
    });
  }

  /** Close the window now; a later request opens it again unless the decoder was closed for good. */
  async close(forGood = false): Promise<void> {
    this.#closed ||= forGood;
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
    const window = this.#window;
    this.#window = null;
    this.#opening = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  /** One request at a time, each with the window open, then the idle timer restarted. */
  #run<T>(work: (call: (name: string, args: readonly unknown[], timeoutMs: number) => Promise<unknown>) => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      if (this.#closed) throw new ClipDecodeError("crashed", MESSAGES.crashed!);
      if (this.#idle !== null) clearTimeout(this.#idle);
      try {
        const window = await this.#open();
        return await work((name, args, timeoutMs) => this.#call(window, name, args, timeoutMs));
      } finally {
        this.#idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #call(window: BrowserWindow, name: string, args: readonly unknown[], timeoutMs: number): Promise<unknown> {
    if (window.isDestroyed()) throw new ClipDecodeError("crashed", MESSAGES.crashed!);
    // The arguments are numbers, Roqer's own file URLs and base64, serialised
    // as JSON: nothing in them can close the call and start another.
    const script = `window.roqerClipDecoder.${name}(...${JSON.stringify(args)})`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        // A request that hangs may have wedged the page: start again with a new one.
        void this.close();
        reject(new ClipDecodeError("timeout", MESSAGES.timeout!));
      }, timeoutMs);
    });
    try {
      return await Promise.race([window.webContents.executeJavaScript(script, false), timeout]);
    } catch (error) {
      if (error instanceof ClipDecodeError) throw error;
      throw new ClipDecodeError(window.isDestroyed() ? "crashed" : "decode", window.isDestroyed() ? MESSAGES.crashed! : MESSAGES.decode!);
    } finally {
      clearTimeout(timer);
    }
  }

  #open(): Promise<BrowserWindow> {
    if (this.#window !== null && !this.#window.isDestroyed()) return Promise.resolve(this.#window);
    this.#opening ??= (async () => {
      const partition = electronSession.fromPartition("roqer-clip-decoder", { cache: false });
      partition.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      partition.setPermissionCheckHandler(() => false);
      const window = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // Hidden windows are throttled by default, which drops most of the
          // frames a played clip presents.
          backgroundThrottling: false,
          session: partition,
          spellcheck: false,
          devTools: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("render-process-gone", () => {
        if (this.#window === window) void this.close();
      });
      try {
        await window.loadFile(path.resolve(this.#page));
      } catch {
        window.destroy();
        this.#opening = null;
        throw new ClipDecodeError("crashed", MESSAGES.crashed!);
      }
      this.#window = window;
      this.#opening = null;
      return window;
    })();
    return this.#opening;
  }
}
