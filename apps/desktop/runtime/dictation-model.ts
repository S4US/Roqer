import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DictationModelSpec, DictationModelState } from "../shared/dictation";

/** How often a download reports its progress, at most. */
const PROGRESS_INTERVAL_MS = 250;

export type DictationModelStoreOptions = Readonly<{
  /** The folder the model is kept in; created when a download starts. */
  directory: string;
  spec: DictationModelSpec;
  /** Told whenever the state changes, progress included. */
  onChange?: (state: DictationModelState) => void;
  fetch?: typeof fetch;
  now?: () => number;
}>;

/**
 * The speech model's file on this computer: whether it is there, downloading
 * it, and removing it.
 *
 * A download is written beside the model as a `.part` file and only takes the
 * model's name once its size and SHA-256 match the published file, so a model
 * that is "ready" is always the whole, unaltered file. A download that stops
 * keeps its part, and the next one carries on from there.
 */
export class DictationModelStore {
  private readonly directory: string;
  private readonly spec: DictationModelSpec;
  private readonly onChange: (state: DictationModelState) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private downloading: { controller: AbortController; done: Promise<DictationModelState>; receivedBytes: number } | null = null;
  private failure: string | null = null;

  constructor(options: DictationModelStoreOptions) {
    this.directory = options.directory;
    this.spec = options.spec;
    this.onChange = options.onChange ?? (() => undefined);
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** Where the model is once it is ready. */
  get modelPath(): string {
    return path.join(this.directory, this.spec.file);
  }

  private get partPath(): string {
    return `${this.modelPath}.part`;
  }

  async state(): Promise<DictationModelState> {
    if (this.downloading !== null) {
      return { kind: "downloading", receivedBytes: this.downloading.receivedBytes, totalBytes: this.spec.bytes };
    }
    const size = (await fs.stat(this.modelPath).catch(() => undefined))?.size;
    if (size === this.spec.bytes) return { kind: "ready" };
    return this.failure === null ? { kind: "missing" } : { kind: "failed", message: this.failure };
  }

  /**
   * Download the model, carrying on from an earlier part when there is one.
   * Resolves with the state it ends in; a second call while one runs joins it.
   */
  download(): Promise<DictationModelState> {
    if (this.downloading !== null) return this.downloading.done;
    const controller = new AbortController();
    const entry = { controller, receivedBytes: 0, done: Promise.resolve<DictationModelState>({ kind: "missing" }) };
    this.downloading = entry;
    this.failure = null;
    entry.done = this.run(entry).then(
      () => null,
      (error: unknown) => controller.signal.aborted ? null : error instanceof Error ? error.message : String(error),
    ).then(async (failure) => {
      this.downloading = null;
      this.failure = failure === null ? null : `The speech model could not be downloaded: ${failure}`;
      const state = await this.state();
      this.onChange(state);
      return state;
    });
    return entry.done;
  }

  /** Stop a download in progress. What it fetched is kept for the next one. */
  async cancel(): Promise<DictationModelState> {
    const entry = this.downloading;
    if (entry === null) return this.state();
    entry.controller.abort();
    return entry.done;
  }

  /** Delete the model and any partial download. */
  async remove(): Promise<DictationModelState> {
    await this.cancel();
    this.failure = null;
    await fs.rm(this.modelPath, { force: true });
    await fs.rm(this.partPath, { force: true });
    const state = await this.state();
    this.onChange(state);
    return state;
  }

  private async run(entry: { controller: AbortController; receivedBytes: number }): Promise<void> {
    const { signal } = entry.controller;
    if ((await fs.stat(this.modelPath).catch(() => undefined))?.size === this.spec.bytes) return;
    await fs.mkdir(this.directory, { recursive: true });
    // A part longer than the file is not a part of it.
    let have = (await fs.stat(this.partPath).catch(() => undefined))?.size ?? 0;
    if (have > this.spec.bytes) {
      await fs.rm(this.partPath, { force: true });
      have = 0;
    }
    const hash = createHash("sha256");
    if (have > 0) {
      for await (const chunk of createReadStream(this.partPath)) hash.update(chunk as Buffer);
    }
    entry.receivedBytes = have;
    this.onChange({ kind: "downloading", receivedBytes: have, totalBytes: this.spec.bytes });

    if (have < this.spec.bytes) {
      const response = await this.fetchImpl(this.spec.url, {
        signal,
        redirect: "follow",
        headers: have > 0 ? { Range: `bytes=${have}-` } : {},
      });
      if (have > 0 && response.status === 200) {
        // The server sent the whole file instead of the rest: start over.
        await response.body?.cancel().catch(() => undefined);
        await fs.rm(this.partPath, { force: true });
        return this.run(entry);
      }
      if (!response.ok || response.body === null) throw new Error(`the server answered ${response.status}.`);
      const file = createWriteStream(this.partPath, { flags: have > 0 ? "a" : "w" });
      let lastReport = this.now();
      try {
        const reader = response.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (entry.receivedBytes + value.byteLength > this.spec.bytes) throw new Error("the server sent more than the published file holds.");
          hash.update(value);
          if (!file.write(value)) await new Promise<void>((resolve) => file.once("drain", resolve));
          entry.receivedBytes += value.byteLength;
          if (this.now() - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = this.now();
            this.onChange({ kind: "downloading", receivedBytes: entry.receivedBytes, totalBytes: this.spec.bytes });
          }
        }
      } finally {
        await new Promise<void>((resolve) => file.end(resolve));
      }
    }

    if (entry.receivedBytes !== this.spec.bytes) throw new Error("the download ended early. Start it again to carry on from where it stopped.");
    if (hash.digest("hex") !== this.spec.sha256) {
      // Nothing of it can be trusted, so nothing of it is kept.
      await fs.rm(this.partPath, { force: true });
      throw new Error("the file received is not the published model, so it was discarded.");
    }
    await fs.rename(this.partPath, this.modelPath);
  }
}
