import { MAX_DICTATION_SAMPLES, type DictationResult } from "../shared/dictation";

/** How long the transcribing process is kept after its last dictation. */
export const DICTATION_IDLE_MS = 10 * 60_000;

/** How long one transcription may take before it is given up on. */
export const DICTATION_TIMEOUT_MS = 120_000;

/** The transcribing process, as much of it as this file needs. */
export type DictationProcess = Readonly<{
  postMessage: (message: unknown) => void;
  kill: () => void;
  onMessage: (listener: (message: unknown) => void) => void;
  onExit: (listener: () => void) => void;
}>;

export type DictationTranscriberOptions = Readonly<{
  /** Starts the transcribing process (see electron/dictation-worker.ts). */
  start: () => DictationProcess;
  idleMs?: number;
  timeoutMs?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}>;

type Pending = { resolve: (result: DictationResult) => void; timeout: unknown };

/**
 * Hands recordings to the transcribing process and gives back their words.
 *
 * The process is started for the first recording and stopped after a while
 * without one, which frees the speech model's memory. A process that dies, or
 * takes too long, answers every recording waiting on it with a failure, and
 * the next recording starts a new one.
 */
export class DictationTranscriber {
  private readonly options: DictationTranscriberOptions;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private process: DictationProcess | null = null;
  /** Resolves when the process last started has exited; null before any has started. */
  private exited: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private idle: unknown = null;

  constructor(options: DictationTranscriberOptions) {
    this.options = options;
    this.setTimer = options.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
  }

  /** Whether the transcribing process is running (and the model's memory held). */
  get running(): boolean {
    return this.process !== null;
  }

  /** Transcribe 16 kHz mono samples with the model at `modelPath`. Never rejects. */
  transcribe(modelPath: string, pcm: Float32Array): Promise<DictationResult> {
    if (pcm.length === 0) return Promise.resolve({ ok: false, message: "Nothing was recorded." });
    if (pcm.length > MAX_DICTATION_SAMPLES) return Promise.resolve({ ok: false, message: "The recording is too long to transcribe." });
    let target: DictationProcess;
    try {
      target = this.ensureProcess();
    } catch (error) {
      return Promise.resolve({ ok: false, message: `Dictation could not start: ${error instanceof Error ? error.message : String(error)}` });
    }
    this.clearIdle();
    const id = this.nextId++;
    return new Promise<DictationResult>((resolve) => {
      const timeout = this.setTimer(() => {
        // A process stuck on one recording is no use to the next either.
        this.stop("Transcribing took too long and was stopped.");
      }, this.options.timeoutMs ?? DICTATION_TIMEOUT_MS);
      this.pending.set(id, { resolve, timeout });
      // A copy of exactly these samples: the buffer behind `pcm` may be larger, or shared.
      const samples = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      target.postMessage({ id, modelPath, pcm: samples });
    });
  }

  /** Stop the transcribing process now. Recordings waiting on it fail with `reason`. */
  stop(reason = "Dictation was stopped."): void {
    this.clearIdle();
    const process = this.process;
    this.process = null;
    this.failAll(reason);
    process?.kill();
  }

  /**
   * Stop the transcribing process and wait until it has gone, or `waitMs` has
   * passed. For what cannot be done while it lives: it keeps the model's file
   * open, so the file cannot be deleted under it.
   */
  async stopAndWait(reason = "Dictation was stopped.", waitMs = 3_000): Promise<void> {
    const gone = this.exited;
    this.stop(reason);
    if (gone === null) return;
    await Promise.race([gone, new Promise<void>((resolve) => { this.setTimer(resolve, waitMs); })]);
  }

  private ensureProcess(): DictationProcess {
    if (this.process !== null) return this.process;
    const started = this.options.start();
    this.process = started;
    started.onMessage((message) => {
      if (this.process !== started) return;
      this.settle(message);
    });
    let markExited: () => void = () => undefined;
    this.exited = new Promise<void>((resolve) => { markExited = resolve; });
    started.onExit(() => {
      markExited();
      if (this.process !== started) return;
      this.process = null;
      this.clearIdle();
      this.failAll("The dictation process stopped unexpectedly. Try again.");
    });
    return started;
  }

  private settle(message: unknown): void {
    if (typeof message !== "object" || message === null) return;
    const record = message as Record<string, unknown>;
    const waiting = typeof record.id === "number" ? this.pending.get(record.id) : undefined;
    if (waiting === undefined) return;
    this.pending.delete(record.id as number);
    this.clearTimer(waiting.timeout);
    waiting.resolve(record.ok === true && typeof record.text === "string"
      ? { ok: true, text: record.text }
      : { ok: false, message: `The recording could not be transcribed: ${typeof record.message === "string" ? record.message : "unknown error"}` });
    if (this.pending.size === 0) this.armIdle();
  }

  private failAll(message: string): void {
    for (const waiting of this.pending.values()) {
      this.clearTimer(waiting.timeout);
      waiting.resolve({ ok: false, message });
    }
    this.pending.clear();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idle = this.setTimer(() => {
      this.idle = null;
      if (this.pending.size === 0) this.stop();
    }, this.options.idleMs ?? DICTATION_IDLE_MS);
  }

  private clearIdle(): void {
    if (this.idle !== null) this.clearTimer(this.idle);
    this.idle = null;
  }
}
