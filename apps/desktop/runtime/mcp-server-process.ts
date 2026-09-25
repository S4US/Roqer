import type { ChildProcessWithoutNullStreams } from "node:child_process";

import type { McpServerState } from "../shared/mcp-server";

/**
 * Supervises the local MCP bridge that Roqer runs for itself.
 *
 * The bridge is what turns the desktop app into a working product: without one
 * the interface can only report that Studio is unreachable, and asking a
 * customer to run `npx robloxstudio-mcp` in a terminal is not a product. So the
 * app starts one, waits for it to answer, restarts it if it dies, and shuts it
 * down when the app quits.
 *
 * Two rules shape the design. A bridge that is already listening is adopted
 * rather than replaced, because it is almost always a developer's own session
 * and killing it would be a surprising thing for an app to do. And the process
 * is treated as untrusted for lifecycle purposes: it can fail to start, die
 * later, or hang without ever answering, and each of those has to end in a
 * state a person can read rather than in a spinner.
 *
 * Nothing here imports Electron, so the whole lifecycle is testable: the caller
 * supplies how to spawn the process and how to ask whether the bridge answers.
 */

export const HEALTH_POLL_INTERVAL_MS = 250;
/** How long a freshly spawned bridge has to answer before it is a failure. */
export const STARTUP_TIMEOUT_MS = 20_000;
/** Consecutive failed starts before Roqer stops retrying and says why. */
export const MAX_START_ATTEMPTS = 4;
/** Backoff between those attempts, in order. The last value repeats. */
export const RESTART_BACKOFF_MS: readonly number[] = [500, 1_500, 4_000];
/** How long a graceful stop is given before the process is killed. */
export const STOP_GRACE_MS = 4_000;
/**
 * A run that stayed healthy this long is treated as a success, so the next
 * crash starts its own budget. Without this, an app left open for a week would
 * spend its restarts on unrelated failures months apart and then give up.
 */
export const HEALTHY_RUN_MS = 60_000;

/**
 * What the bridge prints when it has just replaced the Studio plugin file.
 *
 * The bridge runs `--auto-install-plugin` on every launch, and its output is the
 * only channel it has back to the app. This marker is written by
 * `packages/robloxstudio-mcp/src/index.ts`; the two must stay in step.
 */
export const STUDIO_RESTART_MARKER = "[install-plugin] studio-restart-required";

/**
 * What the bridge prints when the plugin install did not happen. The reason
 * follows the marker on the same line.
 */
export const PLUGIN_PROBLEM_MARKER = "[install-plugin] plugin-install-failed:";

/** How long the one-shot plugin install is given before it is abandoned. */
export const PLUGIN_INSTALL_TIMEOUT_MS = 30_000;

/** Lines of process output kept for diagnostics. The bridge logs to stderr. */
const KEPT_LOG_LINES = 40;
const MAX_LOG_LINE_CHARACTERS = 2_000;

export type McpServerProcessOptions = Readonly<{
  /** Where the bridge is expected to listen, e.g. http://127.0.0.1:58741 */
  endpoint: string;
  /** Start the bridge. Called once per attempt; never called after `stop`. */
  spawnServer: () => ChildProcessWithoutNullStreams;
  /**
   * Install the Studio plugin and exit, without starting a server.
   *
   * Only used when an existing bridge is adopted. A bridge Roqer starts installs
   * the plugin itself as part of its launch, but an adopted one was started by
   * somebody else and may not have — and the app is useless to a customer whose
   * Studio has no plugin, however the port came to be occupied.
   */
  installPlugin?: () => ChildProcessWithoutNullStreams;
  /** True when a healthy bridge answers at the endpoint. Must not throw. */
  probe: (endpoint: string) => Promise<boolean>;
  /** Called on every state change, including the initial one. */
  onState?: (state: McpServerState) => void;
  /**
   * Called with every line the bridge writes and every note the supervisor
   * makes, in order, for a log that outlives the process. Must not throw; a
   * throw is swallowed, because a broken log is not a reason to lose the bridge.
   */
  onOutput?: (line: string) => void;
  /** Injectable for tests; defaults to a real timer. */
  delay?: (ms: number) => Promise<void>;
  /** Injectable for tests; defaults to Date.now. */
  now?: () => number;
}>;

/**
 * What `recover` found. `restarted` is true when the bridge had gone away and a
 * replacement was started -- by this call, or by the supervisor before it was
 * asked -- and false when the endpoint answered after all.
 */
export type McpServerRecovery = Readonly<{ state: McpServerState; restarted: boolean }>;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One line for the log, saying what the supervisor now believes. */
function describeState(state: McpServerState): string {
  switch (state.kind) {
    case "stopped":
    case "starting":
      return `bridge ${state.kind}`;
    case "running":
      return `bridge running at ${state.endpoint}`;
    case "adopted":
      return `bridge adopted at ${state.endpoint}; Roqer did not start it and will not restart it`;
    case "failed":
      return `bridge failed: ${state.message}`;
  }
}

export class McpServerProcess {
  private readonly options: McpServerProcessOptions;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly now: () => number;

  private child: ChildProcessWithoutNullStreams | undefined;
  private currentState: McpServerState = { kind: "stopped" };
  private starting: Promise<McpServerState> | undefined;
  private stopping = false;
  private attempts = 0;
  private healthySince: number | undefined;
  private readonly log: string[] = [];
  /**
   * Sticky for the life of the app: once this session has replaced the plugin,
   * a Studio window opened before it is stale until it is restarted, and a
   * later bridge restart that installs nothing does not change that.
   */
  private pluginUpdated = false;
  private pluginProblem: string | undefined;

  constructor(options: McpServerProcessOptions) {
    this.options = options;
    this.delay = options.delay ?? sleep;
    this.now = options.now ?? Date.now;
  }

  get state(): McpServerState {
    return this.currentState;
  }

  /** The bridge's own recent output, for a failure message or a support log. */
  recentLog(): string {
    return this.log.join("\n");
  }

  /**
   * Bring a bridge up and resolve once its fate is known: adopted, running, or
   * failed. Concurrent callers share one attempt rather than racing to spawn
   * two servers for the same port.
   */
  async start(): Promise<McpServerState> {
    if (this.starting) return this.starting;
    if (this.currentState.kind === "running" || this.currentState.kind === "adopted") {
      return this.currentState;
    }
    this.stopping = false;
    this.attempts = 0;
    this.starting = this.supervise();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  /**
   * Stop a bridge this process started, gracefully.
   *
   * Closing stdin is the bridge's own documented shutdown path — it listens for
   * the stream to end and unwinds its Studio connections — so that is tried
   * before a signal. An adopted bridge is left alone: Roqer did not start it.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    this.starting = undefined;
    const child = this.child;
    this.child = undefined;
    if (this.currentState.kind !== "adopted") this.setState({ kind: "stopped" });
    if (!child || child.exitCode !== null || child.killed) return;

    const exited = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // A stream already torn down is not a reason to skip the kill below.
    }
    const timer = this.delay(STOP_GRACE_MS).then(() => "timeout" as const);
    if (await Promise.race([exited.then(() => "exited" as const), timer]) === "timeout") {
      try {
        child.kill();
      } catch {
        // The process is already gone; there is nothing left to stop.
      }
    }
  }

  private setState(state: McpServerState): McpServerState {
    this.currentState = state;
    this.note(describeState(state));
    this.options.onState?.(state);
    return state;
  }

  /** Something the supervisor did or saw, kept alongside the bridge's own words. */
  private note(line: string): void {
    this.record(`[roqer] ${line}`);
  }

  private record(chunk: string): void {
    for (const line of chunk.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      if (trimmed.includes(STUDIO_RESTART_MARKER)) this.notePluginUpdated();
      const problem = trimmed.indexOf(PLUGIN_PROBLEM_MARKER);
      if (problem !== -1) {
        this.notePluginProblem(trimmed.slice(problem + PLUGIN_PROBLEM_MARKER.length).trim());
      }
      const kept = trimmed.slice(0, MAX_LOG_LINE_CHARACTERS);
      this.log.push(kept);
      try {
        this.options.onOutput?.(kept);
      } catch {
        // The log is for reading later; the bridge is for now.
      }
    }
    if (this.log.length > KEPT_LOG_LINES) this.log.splice(0, this.log.length - KEPT_LOG_LINES);
  }

  /**
   * The install finishes before the bridge starts listening, so this usually
   * runs before the state becomes `running`. It can also arrive a moment after,
   * because output is delivered on its own schedule, so a state that is already
   * `running` is republished rather than left saying the wrong thing.
   */
  private notePluginUpdated(): void {
    if (this.pluginUpdated) return;
    this.pluginUpdated = true;
    // An install that succeeded answers an earlier failure, so the problem does
    // not outlive it.
    this.pluginProblem = undefined;
    this.republishPluginState();
  }

  /** A reported install failure, kept until an install succeeds. */
  private notePluginProblem(reason: string): void {
    const message = reason.length === 0 ? "The Studio plugin could not be installed." : reason;
    if (this.pluginUpdated || this.pluginProblem === message) return;
    this.pluginProblem = message.slice(0, MAX_LOG_LINE_CHARACTERS);
    this.republishPluginState();
  }

  private republishPluginState(): void {
    const state = this.currentState;
    if (state.kind !== "running" && state.kind !== "adopted") return;
    this.setState(this.withPluginState({ kind: state.kind, endpoint: state.endpoint }));
  }

  /** Attach what is known about the plugin to a `running` or `adopted` state. */
  private withPluginState(
    state: Readonly<{ kind: "running" | "adopted"; endpoint: string }>,
  ): McpServerState {
    return {
      ...state,
      ...(this.pluginUpdated ? { pluginUpdated: true as const } : {}),
      ...(this.pluginProblem === undefined ? {} : { pluginProblem: this.pluginProblem }),
    };
  }

  /**
   * Put the Studio plugin in place when Roqer did not start the bridge itself.
   *
   * Failures are recorded and then let go: an adopted bridge still works for
   * everything that does not need a newer plugin, and refusing to start the app
   * over it would be worse than saying so.
   */
  private async installPluginOnce(): Promise<void> {
    const spawnInstaller = this.options.installPlugin;
    if (spawnInstaller === undefined) return;

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnInstaller();
    } catch (error) {
      this.notePluginProblem(describe(error));
      return;
    }

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.record(chunk));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.record(chunk));

    const finished = new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.once("error", (error: Error) => {
        this.notePluginProblem(describe(error));
        resolve();
      });
    });
    const timedOut = this.delay(PLUGIN_INSTALL_TIMEOUT_MS).then(() => "timeout" as const);
    if (await Promise.race([finished.then(() => "done" as const), timedOut]) === "timeout") {
      this.notePluginProblem("Installing the Studio plugin took too long and was stopped.");
      try {
        child.kill();
      } catch {
        // Already gone; there is nothing left to stop.
      }
    }
  }

  private failure(message: string): McpServerState {
    const detail = this.recentLog();
    return this.setState(detail.length === 0
      ? { kind: "failed", message }
      : { kind: "failed", message, detail });
  }

  /** Try, in order, to adopt an existing bridge or start one of our own. */
  private async supervise(): Promise<McpServerState> {
    this.setState({ kind: "starting" });

    if (await this.options.probe(this.options.endpoint)) {
      // Whoever owns that bridge, the plugin still has to be there, and nothing
      // else in this startup would put it there.
      await this.installPluginOnce();
      return this.setState(this.withPluginState({ kind: "adopted", endpoint: this.options.endpoint }));
    }

    for (;;) {
      if (this.stopping) return this.setState({ kind: "stopped" });
      const outcome = await this.runOnce();
      if (outcome.kind !== "retry") return outcome.state;

      this.attempts += 1;
      if (this.attempts >= MAX_START_ATTEMPTS) {
        return this.failure(
          `The Studio bridge could not be started after ${MAX_START_ATTEMPTS} attempts. ${outcome.reason}`,
        );
      }
      const backoff = RESTART_BACKOFF_MS[Math.min(this.attempts - 1, RESTART_BACKOFF_MS.length - 1)];
      await this.delay(backoff);
    }
  }

  /**
   * One spawn, followed by waiting for the bridge to answer.
   *
   * Resolves `retry` when the attempt failed in a way another attempt might
   * survive, which is every failure except a deliberate stop: a port that was
   * taken a moment ago can be free now, and a process that died on startup can
   * start cleanly the second time.
   */
  private async runOnce(): Promise<
    | Readonly<{ kind: "settled"; state: McpServerState }>
    | Readonly<{ kind: "retry"; reason: string }>
  > {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.options.spawnServer();
    } catch (error) {
      return { kind: "retry", reason: describe(error) };
    }
    this.child = child;

    let ended: string | undefined;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.record(chunk));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.record(chunk));
    child.once("error", (error: Error) => {
      ended ??= describe(error);
      this.note(`the bridge process failed to run: ${describe(error)}`);
    });
    child.once("exit", (code: number | null, signal: string | null) => {
      const reason = signal === null
        ? `The bridge exited with code ${code ?? "unknown"}.`
        : `The bridge was terminated by ${signal}.`;
      ended ??= reason;
      // Written whether or not the exit was expected: when the bridge dies
      // hours later, this line and whatever it printed just before are the
      // whole account of why.
      this.note(reason);
      // Only the bridge the supervisor still holds is a loss. One it already
      // let go of -- stopped for a restart, or given up on -- exiting late must
      // not start a second recovery over the bridge that replaced it.
      if (this.child !== child) return;
      this.child = undefined;
      this.onUnexpectedExit();
    });

    const deadline = this.now() + STARTUP_TIMEOUT_MS;
    for (;;) {
      if (this.stopping) return { kind: "settled", state: this.setState({ kind: "stopped" }) };
      if (await this.options.probe(this.options.endpoint)) {
        this.healthySince = this.now();
        return {
          kind: "settled",
          state: this.setState(this.withPluginState({
            kind: "running",
            endpoint: this.options.endpoint,
          })),
        };
      }
      if (ended !== undefined) return { kind: "retry", reason: ended };
      if (this.now() >= deadline) {
        await this.stopChild(child);
        return { kind: "retry", reason: "It did not start listening in time." };
      }
      await this.delay(HEALTH_POLL_INTERVAL_MS);
    }
  }

  /**
   * A bridge that dies after it was running is restarted, because the app is
   * useless without one and the user did nothing to cause it.
   */
  private onUnexpectedExit(): void {
    if (this.stopping || this.starting) return;
    if (this.currentState.kind !== "running") return;

    this.note("the bridge stopped unexpectedly; restarting it");
    void this.restart();
  }

  /**
   * A caller found nothing listening at the endpoint. Find out what is true,
   * and bring a bridge back where one can be.
   *
   * A bridge Roqer started restarts itself when it exits, so for that case
   * this mostly waits for the restart already under way. The case it exists
   * for is the adopted bridge: Roqer holds no process for it, so when somebody
   * else's bridge goes away there is no exit to react to, and without this
   * every tool call would fail for the rest of the session while the state
   * went on saying "adopted". The endpoint is probed first, so one refused
   * connection while a live bridge was busy does not get it replaced.
   */
  async recover(): Promise<McpServerRecovery> {
    if (this.starting) return { state: await this.starting, restarted: true };
    if (this.stopping || this.currentState.kind === "stopped") {
      return { state: this.currentState, restarted: false };
    }
    if (await this.options.probe(this.options.endpoint)) {
      return { state: this.currentState, restarted: false };
    }
    // The probe took time, and an exit delivered meanwhile has its own restart.
    if (this.starting) return { state: await this.starting, restarted: true };

    this.note(this.currentState.kind === "adopted"
      ? "nothing answers at the adopted bridge's endpoint; starting a bridge of Roqer's own"
      : "nothing answers at the bridge's endpoint; restarting it");
    return { state: await this.restart(), restarted: true };
  }

  /**
   * Start over from a bridge that was running or adopted and is not now.
   *
   * A process still held -- one that closed its listener without exiting, or
   * whose exit has not been delivered yet -- is stopped first, so it cannot
   * contend for the port with its replacement. A crash after a long healthy
   * run, or the loss of a bridge that was never Roqer's, is not evidence of a
   * broken install, so neither spends the start budget.
   */
  private restart(): Promise<McpServerState> {
    const ranWell = this.healthySince !== undefined && this.now() - this.healthySince >= HEALTHY_RUN_MS;
    if (ranWell || this.currentState.kind !== "running") this.attempts = 0;
    this.healthySince = undefined;
    const child = this.child;
    this.child = undefined;
    const starting = (async () => {
      if (child !== undefined) await this.stopChild(child);
      return this.supervise();
    })();
    this.starting = starting;
    void starting.finally(() => {
      if (this.starting === starting) this.starting = undefined;
    }).catch(() => undefined);
    return starting;
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.child === child) this.child = undefined;
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // Already gone.
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
