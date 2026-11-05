import { BrowserWindow, session as electronSession, type DesktopCapturerSource } from "electron";
import path from "node:path";

import type { ClipFrame } from "../runtime/clip-source";
import {
  MAX_PLAYTEST_RECORDING_SECONDS, PLAYTEST_RECORDING_BITS_PER_SECOND, PLAYTEST_RECORDING_EDGE, PLAYTEST_RECORDING_FRAME_RATE, PLAYTEST_SHEET_EDGE,
} from "../runtime/playtest-recording";
import { MAX_EVIDENCE_CLIP_BYTES } from "../shared/evidence-clip";

/**
 * Roqer's playtest recorder: a hidden window that records one other window
 * through Chromium's own screen capture and encoder, owned and driven by the
 * main process the way the clip decoder is.
 *
 * The page asks for a display capture; the main process answers that request
 * with the Studio window it found, and no other source can be chosen, since
 * the window has no picker and the request handler reads only the source set
 * here. The page answers with numbers, failure codes and base64, checked here,
 * so nothing seen on the recorded screen reaches anyone as text.
 *
 * One recording at a time. The window closes after a minute unused and is
 * made again when needed; a request that hangs closes it and starts afresh.
 */

export class PlaytestRecordError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PlaytestRecordError";
  }
}

const MESSAGES: Readonly<Record<string, string>> = {
  busy: "Roqer is already recording a playtest.",
  denied: "The window could not be captured on this computer.",
  "no-track": "The window capture gave no picture.",
  unsupported: "This computer's Chromium cannot encode WebM video.",
  "not-recording": "No playtest was being recorded.",
  "bad-request": "Roqer asked the recorder for something it could not do.",
  failed: "The recorder could not start.",
  timeout: "The recorder did not answer in time.",
  crashed: "The recorder stopped while recording.",
};

const IDLE_CLOSE_MS = 60_000;
const CALL_TIMEOUT_MS = 20_000;
/** Bytes of the recording read from the page per call, so no answer is very large. */
const TAKE_BYTES = 4 * 1024 * 1024;
/** How often the page keeps a sample frame, and how many at most: four a second for the longest recording. */
const SAMPLE_EVERY_MS = 250;
const MAX_SAMPLES = Math.ceil(MAX_PLAYTEST_RECORDING_SECONDS * 1000 / SAMPLE_EVERY_MS) + 4;
const MAX_FRAME_BASE64 = 6 * 1024 * 1024;

export type RecordingMeta = Readonly<{ bytes: number; durationSeconds: number; width: number; height: number; samples: number }>;

export type RecordingStart =
  | Readonly<{ started: true; width: number; height: number }>
  /** `detail` is the recorder's own failure code, for a log line; never shown as prose. */
  | Readonly<{ started: false; reason: "no-window" | "capture-failed"; detail?: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function failureOf(value: unknown): PlaytestRecordError | undefined {
  if (!isRecord(value) || typeof value.error !== "string") return undefined;
  const code = Object.prototype.hasOwnProperty.call(MESSAGES, value.error) ? value.error : "failed";
  return new PlaytestRecordError(code, MESSAGES[code]!);
}

function isJpeg(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export class PlaytestRecorder {
  readonly #page: string;
  #window: BrowserWindow | null = null;
  #opening: Promise<BrowserWindow> | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #idle: NodeJS.Timeout | null = null;
  #closed = false;
  #generation = 0;
  /** The window the next capture request is answered with; cleared once answered. */
  #source: DesktopCapturerSource | null = null;
  #recording = false;

  constructor(page: string) {
    this.#page = page;
  }

  /** Whether a recording is going on. */
  get recording(): boolean {
    return this.#recording;
  }

  /**
   * Start recording the window `find` returns. Resolves once the capture is
   * running, or with why it is not; never throws for the ordinary reasons.
   */
  async start(find: () => Promise<DesktopCapturerSource | undefined>): Promise<RecordingStart> {
    let source: DesktopCapturerSource | undefined;
    try {
      source = await find();
    } catch {
      source = undefined;
    }
    if (source === undefined) return { started: false, reason: "no-window" };
    try {
      return await this.#run(async (call) => {
        this.#source = source!;
        try {
          // Asking for a display capture needs a user gesture; the script is
          // run as one, which is the one place this recorder grants it.
          const answer = await call("start", [
            PLAYTEST_RECORDING_FRAME_RATE, PLAYTEST_RECORDING_BITS_PER_SECOND, MAX_PLAYTEST_RECORDING_SECONDS * 1000, MAX_EVIDENCE_CLIP_BYTES,
            PLAYTEST_RECORDING_EDGE, SAMPLE_EVERY_MS, MAX_SAMPLES, PLAYTEST_SHEET_EDGE,
          ], true);
          const failed = failureOf(answer);
          if (failed !== undefined) throw failed;
          if (!isRecord(answer) || answer.ok !== true) throw new PlaytestRecordError("failed", MESSAGES.failed!);
          this.#recording = true;
          return { started: true, width: isCount(answer.width) ? answer.width : 0, height: isCount(answer.height) ? answer.height : 0 };
        } finally {
          this.#source = null;
        }
      });
    } catch (error) {
      return { started: false, reason: "capture-failed", detail: error instanceof PlaytestRecordError ? error.code : "failed" };
    }
  }

  /** Stop recording and learn what was recorded; undefined when nothing was. The bytes and frames are read next. */
  async stop(): Promise<RecordingMeta | undefined> {
    if (!this.#recording) return undefined;
    this.#recording = false;
    try {
      return await this.#run(async (call) => {
        const answer = await call("stop", []);
        const failed = failureOf(answer);
        if (failed !== undefined) throw failed;
        if (!isRecord(answer) || !isCount(answer.size) || !isCount(answer.durationMs) || !isCount(answer.width) || !isCount(answer.height) || !isCount(answer.samples)) {
          throw new PlaytestRecordError("failed", MESSAGES.failed!);
        }
        return { bytes: answer.size, durationSeconds: answer.durationMs / 1000, width: answer.width, height: answer.height, samples: answer.samples };
      });
    } catch {
      return undefined;
    }
  }

  /** The whole recording, read in pieces; undefined when it could not be read. */
  async bytes(size: number): Promise<Buffer | undefined> {
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_EVIDENCE_CLIP_BYTES) return undefined;
    try {
      return await this.#run(async (call) => {
        const pieces: Buffer[] = [];
        for (let from = 0; from < size; from += TAKE_BYTES) {
          const answer = await call("take", [from, Math.min(TAKE_BYTES, size - from)]);
          const failed = failureOf(answer);
          if (failed !== undefined) throw failed;
          if (!isRecord(answer) || typeof answer.data !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(answer.data)) throw new PlaytestRecordError("failed", MESSAGES.failed!);
          pieces.push(Buffer.from(answer.data, "base64"));
        }
        const whole = Buffer.concat(pieces);
        if (whole.length !== size) throw new PlaytestRecordError("failed", MESSAGES.failed!);
        return whole;
      });
    } catch {
      return undefined;
    }
  }

  /** The sample frame nearest each time, as JPEG; empty when none were kept or they could not be read. */
  async frames(times: readonly number[]): Promise<ClipFrame[]> {
    if (times.length === 0) return [];
    try {
      return await this.#run(async (call) => {
        const answer = await call("frames", [times]);
        const failed = failureOf(answer);
        if (failed !== undefined) throw failed;
        if (!isRecord(answer) || !Array.isArray(answer.frames) || answer.frames.length > times.length) throw new PlaytestRecordError("failed", MESSAGES.failed!);
        return answer.frames.map((frame: unknown) => {
          if (!isRecord(frame) || !isCount(frame.time) || typeof frame.data !== "string" || frame.data.length > MAX_FRAME_BASE64 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) {
            throw new PlaytestRecordError("failed", MESSAGES.failed!);
          }
          const jpeg = Buffer.from(frame.data, "base64");
          if (!isJpeg(jpeg)) throw new PlaytestRecordError("failed", MESSAGES.failed!);
          return { time: frame.time, jpeg };
        });
      });
    } catch {
      return [];
    }
  }

  /** Forget the last recording's bytes and frames in the page. */
  async clear(): Promise<void> {
    await this.#run((call) => call("clear", [])).catch(() => undefined);
  }

  /** Stop any recording and close the window; a later request opens it again unless closed for good. */
  async close(forGood = false): Promise<void> {
    this.#closed ||= forGood;
    this.#recording = false;
    this.#generation++;
    if (this.#idle !== null) clearTimeout(this.#idle);
    this.#idle = null;
    const window = this.#window;
    this.#window = null;
    this.#opening = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  #run<T>(work: (call: (name: string, args: readonly unknown[], userGesture?: boolean) => Promise<unknown>) => Promise<T>): Promise<T> {
    const result = this.#queue.then(async () => {
      if (this.#closed) throw new PlaytestRecordError("crashed", MESSAGES.crashed!);
      if (this.#idle !== null) clearTimeout(this.#idle);
      try {
        const window = await this.#open();
        return await work((name, args, userGesture = false) => this.#call(window, name, args, userGesture));
      } finally {
        // The window stays open while it records; the idle close waits for a quiet recorder.
        if (!this.#recording) {
          this.#idle = setTimeout(() => void this.close(), IDLE_CLOSE_MS);
          this.#idle.unref();
        }
      }
    });
    this.#queue = result.catch(() => undefined);
    return result;
  }

  async #call(window: BrowserWindow, name: string, args: readonly unknown[], userGesture = false): Promise<unknown> {
    if (window.isDestroyed()) throw new PlaytestRecordError("crashed", MESSAGES.crashed!);
    // The arguments are numbers and Roqer's own lists of numbers, serialised
    // as JSON: nothing in them can close the call and start another.
    const script = `window.roqerPlaytestRecorder.${name}(...${JSON.stringify(args)})`;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        void this.close();
        reject(new PlaytestRecordError("timeout", MESSAGES.timeout!));
      }, CALL_TIMEOUT_MS);
    });
    try {
      return await Promise.race([window.webContents.executeJavaScript(script, userGesture), timeout]);
    } catch (error) {
      if (error instanceof PlaytestRecordError) throw error;
      throw new PlaytestRecordError(window.isDestroyed() ? "crashed" : "failed", window.isDestroyed() ? MESSAGES.crashed! : MESSAGES.failed!);
    } finally {
      clearTimeout(timer);
    }
  }

  #open(): Promise<BrowserWindow> {
    if (this.#window !== null && !this.#window.isDestroyed()) return Promise.resolve(this.#window);
    this.#opening ??= (async () => {
      const generation = this.#generation;
      const partition = electronSession.fromPartition("roqer-playtest-recorder", { cache: false });
      // The page may ask for one thing, a display capture, and only while a
      // start has named the window to capture; every other permission is
      // refused, as the decoder's are. Chromium asks for it as the "media"
      // permission with no media types, where a camera or microphone request
      // names its types; those are refused too.
      partition.setPermissionRequestHandler((_contents, permission, callback, details) => {
        const types = (details as { mediaTypes?: readonly string[] }).mediaTypes;
        const display = (permission as string) === "display-capture" || (permission === "media" && (types === undefined || types.length === 0));
        callback(display && this.#source !== null);
      });
      partition.setPermissionCheckHandler((_contents, permission) => (permission === "media" || (permission as string) === "display-capture") && this.#source !== null);
      // The one way a capture is granted: the window set for this start, and
      // never a picker, a screen, or audio.
      partition.setDisplayMediaRequestHandler((_request, callback) => {
        const source = this.#source;
        if (source === null) {
          callback({});
          return;
        }
        callback({ video: source, audio: undefined });
      });
      const window = new BrowserWindow({
        show: false,
        width: 320,
        height: 240,
        webPreferences: {
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          // A throttled hidden window would record at a crawl and sample nothing.
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
        if (generation === this.#generation) this.#opening = null;
        throw new PlaytestRecordError("crashed", MESSAGES.crashed!);
      }
      if (generation !== this.#generation) {
        window.destroy();
        throw new PlaytestRecordError("crashed", MESSAGES.crashed!);
      }
      this.#window = window;
      this.#opening = null;
      return window;
    })();
    return this.#opening;
  }
}
