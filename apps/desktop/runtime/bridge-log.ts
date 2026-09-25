import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What the Studio bridge said, kept on disk.
 *
 * The bridge is a child process whose only channel back to the app is its
 * stderr, and the supervisor keeps the last forty lines of that in memory for
 * the failure it might have to explain. That was enough while the bridge was
 * failing to start: the lines were still there when the state turned to
 * `failed`. It was nothing at all when a bridge that had run for twenty minutes
 * died in the middle of a run -- the process was gone, the app kept going, and
 * by the time anyone asked why there was no process left to ask. This file is
 * the answer: every line the bridge writes and every transition the supervisor
 * makes, stamped and appended, in the app's data folder next to the run
 * journal.
 *
 * Bounded like the turn-timing log: trimmed from the front to half its cap once
 * it passes the cap, so an install left open for months holds the recent past
 * rather than all of it. The bridge is chatty in a quiet way -- one line every
 * few seconds while it waits for Studio -- so the size is tracked rather than
 * re-read on every line.
 */

const DEFAULT_MAX_BYTES = 1024 * 1024;

export class BridgeLog {
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly onError: ((error: Error) => void) | undefined;
  private queue: Promise<void> = Promise.resolve();
  /** Bytes on disk as of the last write; measured on the first. */
  private bytes: number | undefined;

  constructor(
    private readonly file: string,
    options: Readonly<{ maxBytes?: number; now?: () => Date; onError?: (error: Error) => void }> = {},
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  /**
   * Append one line, stamped. Never rejects: nothing about the bridge depends
   * on this file, so a full disk is reported and then let go.
   */
  write(line: string): Promise<void> {
    const entry = `${this.now().toISOString()} ${line}\n`;
    const attempt = this.queue.then(async () => {
      if (this.bytes === undefined) {
        await mkdir(dirname(this.file), { recursive: true });
        this.bytes = await stat(this.file).then((info) => info.size, () => 0);
      }
      await appendFile(this.file, entry, "utf8");
      this.bytes += Buffer.byteLength(entry, "utf8");
      if (this.bytes > this.maxBytes) await this.trim();
    });
    this.queue = attempt.catch((value: unknown) => {
      // Measured again on the next write, since the failed one may or may not
      // have landed.
      this.bytes = undefined;
      try {
        this.onError?.(value instanceof Error ? value : new Error(String(value)));
      } catch {
        // A reporter that throws must not become an unhandled rejection.
      }
    });
    return this.queue;
  }

  /** Everything written so far. For tests and for reading it back. */
  async text(): Promise<string> {
    await this.queue;
    return readFile(this.file, "utf8").catch(() => "");
  }

  /**
   * Drop the oldest lines down to half the cap. The newest line always
   * survives, however large it is.
   */
  private async trim(): Promise<void> {
    const lines = (await readFile(this.file, "utf8")).split("\n").filter((entry) => entry.length > 0);
    let bytes = lines.reduce((total, entry) => total + Buffer.byteLength(`${entry}\n`, "utf8"), 0);
    let start = 0;
    while (start < lines.length - 1 && bytes > this.maxBytes / 2) {
      bytes -= Buffer.byteLength(`${lines[start]}\n`, "utf8");
      start += 1;
    }
    await writeFile(this.file, `${lines.slice(start).join("\n")}\n`, "utf8");
    this.bytes = bytes;
  }
}
