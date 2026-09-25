import type { RunChange } from "../shared/run-events";

/**
 * How long a model may go without semantic progress before it is treated as
 * stalled.
 *
 * A transport's own bound measures whether the connection is alive, not
 * whether the model is getting anywhere: a provider that keeps the socket open
 * and says nothing passes it forever, which is how a stuck run held the app's
 * single run slot open until someone noticed and pressed stop. On a connected
 * subscription the cost is worse than the slot, because the provider may be
 * counting the time against the user's own allowance.
 *
 * Generous on purpose: a long reasoning turn at high effort is ordinary and
 * must not be cut off. This is the interval after which nothing arriving stops
 * meaning "thinking" and starts meaning "stuck".
 */
export const DEFAULT_STALL_MS = 300_000;

export type ProgressWatchdog = Readonly<{
  /** Aborts when the run is cancelled or the model stalls; `stalled` tells them apart. */
  signal: AbortSignal;
  /** Called for every sign of progress; restarts the interval. */
  progressed: () => void;
  /**
   * Suspend the clock while Roqer, not the model, is the one working: a tool
   * call, an approval, or a question waiting on the user. Returns the release,
   * which restarts the interval once nothing holds it. Holds nest.
   */
  hold: () => () => void;
  stop: () => void;
  readonly stalled: boolean;
}>;

/**
 * Watch a model for progress, aborting `signal` if none arrives in `stallMs`
 * while nothing holds the clock.
 *
 * The run's own cancellation is chained in so a stopped run still tears the
 * stream down through one signal.
 */
export function watchProgress(runSignal: AbortSignal, stallMs: number = DEFAULT_STALL_MS): ProgressWatchdog {
  const controller = new AbortController();
  let stalled = false;
  let holds = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancelRun = () => controller.abort();
  runSignal.addEventListener("abort", cancelRun, { once: true });

  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const stop = () => {
    stopped = true;
    clear();
    runSignal.removeEventListener("abort", cancelRun);
  };
  const progressed = () => {
    clear();
    if (stopped || holds > 0 || controller.signal.aborted) return;
    // Deliberately referenced: while a model is working the watchdog may be the
    // only thing pending, and it is exactly what should keep the loop alive
    // then. `stop` clears it, so it never outlives the work it watches.
    timer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallMs);
  };
  const hold = () => {
    holds += 1;
    clear();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      progressed();
    };
  };
  if (runSignal.aborted) controller.abort();
  else progressed();

  return {
    signal: controller.signal,
    progressed,
    hold,
    stop,
    get stalled() {
      return stalled;
    },
  };
}

/**
 * What a stall means for the run, which depends entirely on whether anything
 * has been changed yet.
 *
 * Before the first mutation nothing is half-done, so asking again is simply
 * asking again. Afterwards it is not: the changes that landed are real and
 * stay, and a repeat of the original request would be a second attempt at work
 * that is partly finished. Roqer does not restart a turn by itself — a silent
 * retry would spend the same turn twice — so the honest move is to say which
 * situation this is and let the person decide.
 */
export function describeStall(seconds: number, changes: readonly RunChange[]): string {
  const applied = changes.length;
  if (applied === 0) {
    return `The model stopped responding for ${seconds} seconds while the connection stayed open, so Roqer ended the turn. Nothing was changed in Studio, so asking again is safe.`;
  }
  const targets = [...new Set(changes.map((change) => change.target))];
  const named = targets.slice(0, 3).join(", ");
  const rest = targets.length - Math.min(targets.length, 3);
  return `The model stopped responding for ${seconds} seconds while the connection stayed open, so Roqer ended the turn. `
    + `${applied} change${applied === 1 ? "" : "s"} had already been applied and ${applied === 1 ? "is" : "are"} left in place `
    + `(${named}${rest > 0 ? `, and ${rest} more` : ""}). Ask again to continue from the current state rather than repeating the original request.`;
}
