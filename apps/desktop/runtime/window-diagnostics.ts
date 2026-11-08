/**
 * What the app records about its own window, for the failures that otherwise
 * leave nothing behind: the page process crashing, the page throwing an error
 * it cannot draw past, and the main process freezing. Each of those used to
 * end in a dark, empty window with no trace anywhere but a terminal the user
 * may not have open. These helpers keep that record bounded; the main process
 * writes it to `app.log` beside `bridge.log`.
 */

/** The longest message kept from one console line. */
export const MAX_LOGGED_MESSAGE_CHARACTERS = 4_000;
/** How many errors are written per minute before the rest are only counted. */
export const MAX_LOGGED_ERRORS_PER_MINUTE = 30;

/** One console line, kept to a bounded length. */
export function boundedMessage(message: string, limit = MAX_LOGGED_MESSAGE_CHARACTERS): string {
  return message.length <= limit ? message : `${message.slice(0, limit)}… (${message.length - limit} more characters)`;
}

/**
 * Lets through at most `limit` lines a minute, so a page that throws on every
 * frame cannot fill the disk. Returns the lines to write for one message: none
 * while over the limit, and, once a new minute starts, a count of what was held
 * back before the message itself.
 */
export function createLogGate(limit = MAX_LOGGED_ERRORS_PER_MINUTE, now: () => number = Date.now): (line: string) => string[] {
  let windowStart = now();
  let written = 0;
  let held = 0;
  return (line) => {
    const time = now();
    const lines: string[] = [];
    if (time - windowStart >= 60_000) {
      if (held > 0) lines.push(`${held} more ${held === 1 ? "error was" : "errors were"} not logged in the last minute`);
      windowStart = time;
      written = 0;
      held = 0;
    }
    if (written >= limit) {
      held += 1;
      return lines;
    }
    written += 1;
    lines.push(line);
    return lines;
  };
}

/** How long the main process may go without its timer firing before it counts as frozen. */
export const EVENT_LOOP_STALL_MS = 2_000;

/**
 * Calls `onStall` with how long the main process was blocked whenever a timer
 * meant to fire every `intervalMs` arrives more than `thresholdMs` late. A
 * frozen main process stops answering the window manager, which then dims the
 * window as not responding. Returns a function that stops watching.
 */
export function watchEventLoop(options: Readonly<{
  onStall: (blockedMs: number) => void;
  intervalMs?: number;
  thresholdMs?: number;
  now?: () => number;
  schedule?: (tick: () => void, ms: number) => { stop: () => void };
}>): () => void {
  const intervalMs = options.intervalMs ?? 1_000;
  const thresholdMs = options.thresholdMs ?? EVENT_LOOP_STALL_MS;
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((tick, ms) => {
    const timer = setInterval(tick, ms);
    // Never the reason the app stays open.
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  });
  let last = now();
  const timer = schedule(() => {
    const time = now();
    const late = time - last - intervalMs;
    last = time;
    if (late > thresholdMs) options.onStall(late);
  }, intervalMs);
  return () => timer.stop();
}
