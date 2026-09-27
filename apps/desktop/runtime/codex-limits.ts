import { NO_LIMITS, type ProviderLimits, type UsageWindow } from "../shared/provider-limits";
import type { AppServerNotification } from "./codex-app-server";

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** One of Codex's rate-limit buckets, reduced to what Roqer shows. */
export type CodexLimitSnapshot = Readonly<{
  limitId: string | null;
  windows: readonly UsageWindow[];
  limitReached: boolean;
}>;

function usageWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value) || typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return null;
  const minutes = value.windowDurationMins;
  const resetsAt = value.resetsAt;
  return {
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    windowMinutes: Number.isSafeInteger(minutes) && (minutes as number) > 0 ? minutes as number : null,
    // Codex reports Unix seconds.
    resetsAt: Number.isSafeInteger(resetsAt) && (resetsAt as number) > 0 ? (resetsAt as number) * 1000 : null,
  };
}

/**
 * Read one `RateLimitSnapshot` from the Codex app-server protocol: a primary
 * and a secondary window (in practice the five-hour and the weekly limit),
 * and whether the backend says a limit was reached. Anything unreadable is
 * dropped rather than guessed.
 */
export function parseCodexRateLimitSnapshot(value: unknown): CodexLimitSnapshot | null {
  if (!isRecord(value)) return null;
  const windows = [usageWindow(value.primary), usageWindow(value.secondary)]
    .filter((window): window is UsageWindow => window !== null);
  if (windows.length === 0) return null;
  return {
    limitId: typeof value.limitId === "string" && value.limitId !== "" ? value.limitId : null,
    windows,
    limitReached: typeof value.rateLimitReachedType === "string",
  };
}

export type CodexLimitsSource = {
  request(method: string, params?: unknown): Promise<unknown>;
  subscribe(listener: (notification: AppServerNotification) => void): () => void;
};

/** The bucket Codex meters ordinary use in, which the meter shows. */
export const DEFAULT_LIMIT_ID = "codex";

/** How often the backend is asked, at most; updates Codex pushes arrive in between. */
const READ_INTERVAL_MS = 60_000;

/**
 * The ChatGPT plan's Codex usage limits, from the app-server Roqer already
 * runs. It asks with `account/rateLimits/read` at most once a minute and takes
 * the `account/rateLimits/updated` notifications Codex sends after each turn,
 * so a meter polled from the interface costs almost nothing.
 */
export class CodexLimitsTracker {
  private readonly source: CodexLimitsSource;
  private readonly now: () => number;
  private readonly readIntervalMs: number;
  private latest: (CodexLimitSnapshot & { observedAt: number }) | null = null;
  private lastAttemptAt = Number.NEGATIVE_INFINITY;
  private reading: Promise<void> | null = null;
  private generation = 0;

  constructor(options: { source: CodexLimitsSource; now?: () => number; readIntervalMs?: number }) {
    this.source = options.source;
    this.now = options.now ?? Date.now;
    this.readIntervalMs = options.readIntervalMs ?? READ_INTERVAL_MS;
    this.source.subscribe((notification) => this.onNotification(notification));
  }

  async read(): Promise<ProviderLimits> {
    if (this.now() - this.lastAttemptAt >= this.readIntervalMs) {
      this.reading ??= this.fetch().finally(() => { this.reading = null; });
      await this.reading;
    }
    const latest = this.latest;
    if (latest === null) return NO_LIMITS;
    return { kind: "reported", observedAt: latest.observedAt, windows: latest.windows, limitReached: latest.limitReached };
  }

  /** Drop what is known, because the account may have changed. */
  forget(): void {
    this.generation += 1;
    this.latest = null;
    this.lastAttemptAt = Number.NEGATIVE_INFINITY;
  }

  private async fetch(): Promise<void> {
    const generation = this.generation;
    this.lastAttemptAt = this.now();
    let result: unknown;
    try {
      // `null`, not `{}`: releases before the method took parameters accept only that.
      result = await this.source.request("account/rateLimits/read", null);
    } catch {
      // Signed out, an older Codex without the method, or the backend is down.
      // What was last reported stays, with the time it was reported.
      return;
    }
    if (generation !== this.generation || !isRecord(result)) return;
    const snapshot = parseCodexRateLimitSnapshot(result.rateLimits);
    if (snapshot === null) return;
    this.latest = {
      ...snapshot,
      // The backend's own verdict on ordinary use outranks the snapshot's.
      limitReached: snapshot.limitReached || result.ordinaryUsageAllowed === false,
      observedAt: this.now(),
    };
  }

  private onNotification(notification: AppServerNotification): void {
    if (notification.method !== "account/rateLimits/updated") return;
    const snapshot = parseCodexRateLimitSnapshot(notification.params.rateLimits);
    if (snapshot === null) return;
    // Codex also meters some models in buckets of their own; only the bucket
    // the meter shows may replace it.
    const current = this.latest;
    const shown = current?.limitId ?? DEFAULT_LIMIT_ID;
    if (snapshot.limitId !== null && snapshot.limitId !== shown) return;
    this.latest = { ...snapshot, limitId: snapshot.limitId ?? current?.limitId ?? null, observedAt: this.now() };
  }
}
