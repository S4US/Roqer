import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

/**
 * A scriptable stand-in for a spawned provider CLI, used by the tests that
 * cover the Claude Code client and planner. Nothing outside a test imports it.
 */
export class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  /** Mirrors a real child: null while running, a number once it has exited. */
  exitCode: number | null = null;

  private ended = false;

  /** Write one newline-terminated protocol message, as the CLI would. */
  writeLine(value: unknown): void {
    this.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);
  }

  write(text: string): void {
    this.stdout.write(text);
  }

  kill(): boolean {
    this.killed = true;
    this.finish(null, "SIGTERM");
    return true;
  }

  /**
   * End the process. "exit" and "close" are deferred by two turns of the event
   * loop so a reader attached during the same tick still drains the output —
   * a real process's final lines are readable after it exits, too.
   */
  finish(code: number | null = 0, signal: string | null = null): void {
    if (this.ended) return;
    this.ended = true;
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => setImmediate(() => {
      this.emit("exit", code, signal);
      this.emit("close", code, signal);
    }));
  }

  asChild(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }
}
