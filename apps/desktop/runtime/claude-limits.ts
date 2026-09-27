import type { ProviderLimits, UsageWindow } from "../shared/provider-limits";
import { LimitsCache, type LimitsReport } from "./limits-cache";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The plan windows the meter shows, by the name `get_usage` gives them. */
const WINDOWS: ReadonlyArray<readonly [key: string, minutes: number]> = [
  ["five_hour", 5 * 60],
  ["seven_day", 7 * 24 * 60],
];

function usageWindow(value: unknown, minutes: number): UsageWindow | null {
  if (!isRecord(value) || typeof value.utilization !== "number" || !Number.isFinite(value.utilization)) return null;
  const resetsAt = typeof value.resets_at === "string" ? Date.parse(value.resets_at) : Number.NaN;
  return {
    // Documented as a percentage, 0–100.
    usedPercent: Math.min(100, Math.max(0, value.utilization)),
    windowMinutes: minutes,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/**
 * Read the five-hour and weekly windows from Claude Code's `get_usage`
 * answer. `get_usage` is experimental, so this reads only the fields the SDK
 * documents, and anything else, including a changed shape, reads as nothing
 * rather than as a guess. Accounts the plan limits do not apply to (an API
 * key, a cloud provider) report `rate_limits_available: false`.
 *
 * The per-model weekly windows are left out: the meter has no way to name a
 * model yet.
 */
export function parseClaudeUsage(value: unknown): LimitsReport | null {
  if (!isRecord(value) || value.rate_limits_available !== true || !isRecord(value.rate_limits)) return null;
  const limits = value.rate_limits;
  const windows = WINDOWS
    .map(([key, minutes]) => usageWindow(limits[key], minutes))
    .filter((window): window is UsageWindow => window !== null);
  // Claude Code reports usage, not a verdict; a full window shows as full.
  return windows.length === 0 ? null : { windows, limitReached: false };
}

export type ClaudeUsageSource = { readUsage(): Promise<unknown> };

/**
 * Reading usage starts a Claude Code process, which asks claude.ai, so it is
 * done at most every few minutes, and only while the Settings row asks.
 */
const READ_INTERVAL_MS = 5 * 60_000;

/** The claude.ai plan's usage limits, as Claude Code's `/usage` reports them. */
export class ClaudeLimitsTracker {
  private readonly cache: LimitsCache<LimitsReport>;

  constructor(options: { source: ClaudeUsageSource; now?: () => number; readIntervalMs?: number }) {
    const { source } = options;
    this.cache = new LimitsCache({
      intervalMs: options.readIntervalMs ?? READ_INTERVAL_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
      fetch: async () => parseClaudeUsage(await source.readUsage()),
    });
  }

  read(): Promise<ProviderLimits> {
    return this.cache.read();
  }

  /** Drop what is known, because the account may have changed. */
  forget(): void {
    this.cache.forget();
  }
}
