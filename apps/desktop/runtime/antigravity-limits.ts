import type { ProviderLimits, UsageWindow } from "../shared/provider-limits";
import { LimitsCache, type LimitsReport } from "./limits-cache";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The plan windows the meter shows, by the `window` name `/usage` gives them. */
const WINDOW_MINUTES: Readonly<Record<string, number>> = {
  "5h": 5 * 60,
  weekly: 7 * 24 * 60,
};

function usageWindow(value: unknown): UsageWindow | null {
  if (!isRecord(value) || typeof value.window !== "string") return null;
  const minutes = WINDOW_MINUTES[value.window];
  const remaining = value.remaining_fraction;
  if (minutes === undefined || typeof remaining !== "number" || !Number.isFinite(remaining)) return null;
  const resetsAt = typeof value.reset_time === "string" ? Date.parse(value.reset_time) : Number.NaN;
  return {
    usedPercent: Math.min(100, Math.max(0, (1 - remaining) * 100)),
    windowMinutes: minutes,
    resetsAt: Number.isFinite(resetsAt) && resetsAt > 0 ? resetsAt : null,
  };
}

/**
 * Read the five-hour and weekly windows from `agy`'s `/usage` answer.
 *
 * Antigravity meters groups of models separately: Gemini models share one
 * pair of windows, the Claude and GPT models it also offers share another.
 * The meter cannot name a group, so it shows the first one `agy` lists, which
 * is the Gemini group Roqer's Antigravity runs default to. Anything in a shape
 * this reader does not know reads as nothing rather than as a guess.
 */
export function parseAntigravityUsage(value: unknown): LimitsReport | null {
  if (!isRecord(value) || !Array.isArray(value.groups)) return null;
  const group = value.groups.find(isRecord);
  if (group === undefined || !Array.isArray(group.buckets)) return null;
  const windows = group.buckets
    .map(usageWindow)
    .filter((window): window is UsageWindow => window !== null)
    .sort((a, b) => (a.windowMinutes ?? 0) - (b.windowMinutes ?? 0));
  // `agy` reports what is left, not a verdict; a spent window shows as full.
  return windows.length === 0 ? null : { windows, limitReached: false };
}

export type AntigravityUsageSource = { readUsage(): Promise<unknown> };

/** Reading usage starts `agy`, which asks Google, so it is done at most every few minutes. */
const READ_INTERVAL_MS = 5 * 60_000;

/** The Antigravity plan's usage limits, as `agy`'s `/usage` reports them. */
export class AntigravityLimitsTracker {
  private readonly cache: LimitsCache<LimitsReport>;

  constructor(options: { source: AntigravityUsageSource; now?: () => number; readIntervalMs?: number }) {
    const { source } = options;
    this.cache = new LimitsCache({
      intervalMs: options.readIntervalMs ?? READ_INTERVAL_MS,
      ...(options.now === undefined ? {} : { now: options.now }),
      fetch: async () => parseAntigravityUsage(await source.readUsage()),
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
