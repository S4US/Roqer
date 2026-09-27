/**
 * A subscription plan's usage limits, as the provider's own client reported
 * them. Roqer never estimates usage: a provider that reported nothing is
 * `none`, which the interface shows as no meter at all, not as 0%.
 *
 * The numbers belong to the whole account, not to Roqer. Other apps on the
 * same account use the same windows.
 */

/** One rolling usage window, such as the five-hour or the weekly limit. */
export type UsageWindow = Readonly<{
  /** Share of the window used, 0–100. */
  usedPercent: number;
  /** The window's length in minutes, when reported. */
  windowMinutes: number | null;
  /** When the window resets, in epoch milliseconds, when reported. */
  resetsAt: number | null;
}>;

export type ProviderLimits =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "reported";
    /** When the client reported these numbers, in epoch milliseconds. */
    observedAt: number;
    windows: readonly UsageWindow[];
    /** The provider said this account cannot use its plan right now. */
    limitReached: boolean;
  }>;

export const NO_LIMITS: ProviderLimits = { kind: "none" };

const MAX_WINDOWS = 8;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTime = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function isUsageWindow(value: unknown): value is UsageWindow {
  return isRecord(value) &&
    typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent) &&
    value.usedPercent >= 0 && value.usedPercent <= 100 &&
    (value.windowMinutes === null || (Number.isSafeInteger(value.windowMinutes) && (value.windowMinutes as number) > 0)) &&
    (value.resetsAt === null || isTime(value.resetsAt));
}

export function isProviderLimits(value: unknown): value is ProviderLimits {
  if (!isRecord(value)) return false;
  if (value.kind === "none") return true;
  return value.kind === "reported" && isTime(value.observedAt) && typeof value.limitReached === "boolean" &&
    Array.isArray(value.windows) && value.windows.length <= MAX_WINDOWS && value.windows.every(isUsageWindow);
}

/** "5-hour", "Weekly": the name a window's length goes by. */
export function usageWindowLabel(minutes: number | null): string {
  if (minutes === null) return "Usage";
  if (minutes === 7 * 24 * 60) return "Weekly";
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

/**
 * When a limit resets, in the user's own time: the time alone within the next
 * day, with the weekday after that, and the date beyond a week, so a message
 * read later still says which day it meant.
 */
export function formatResetTime(resetsAt: number, now: number, timeZone?: string): string {
  const until = resetsAt - now;
  const options: Intl.DateTimeFormatOptions = until >= 0 && until < 20 * 60 * 60_000
    ? { hour: "numeric", minute: "2-digit" }
    : until >= 0 && until < 6 * 24 * 60 * 60_000
      ? { weekday: "short", hour: "numeric", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
  return new Intl.DateTimeFormat(undefined, { ...options, ...(timeZone === undefined ? {} : { timeZone }) }).format(resetsAt);
}
