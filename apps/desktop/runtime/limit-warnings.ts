import { formatResetTime, LIMIT_WARNING_PERCENT, usageWindowLabel } from "../shared/provider-limits";
import { DEFAULT_LIMIT_ID, parseCodexRateLimitSnapshot } from "./codex-limits";

/**
 * A plan's usage window that is close to its limit, from what the client
 * reported during a run. A client that reaches the limit ends the turn with
 * its own message, which already says when it resets; this is the warning
 * before that.
 */
export type LimitWarning = Readonly<{
  /** The window's name, such as "5-hour" or "Weekly". */
  window: string;
  /** How much of it is used, when the client reported a share Roqer can read. */
  usedPercent: number | null;
  /** When it resets, in epoch milliseconds, when reported. */
  resetsAt: number | null;
}>;

/** Says once per run and window, on the run's status line, that a plan is close to a limit. */
export class LimitWarnings {
  private readonly said = new Set<string>();

  constructor(
    private readonly provider: string,
    private readonly status: (label: string, detail: string) => void,
    private readonly now: () => number = Date.now,
  ) {}

  warn(warning: LimitWarning): void {
    if (this.said.has(warning.window)) return;
    this.said.add(warning.window);
    const used = warning.usedPercent === null ? "" : `: ${Math.round(warning.usedPercent)}% used`;
    const now = this.now();
    const resets = warning.resetsAt !== null && warning.resetsAt > now
      ? `, resets ${formatResetTime(warning.resetsAt, now)}`
      : "";
    this.status(
      `Close to your ${this.provider} usage limit`,
      `${warning.window} limit${used}${resets}. The run stops if the limit is reached.`,
    );
  }
}

/**
 * The windows an `account/rateLimits/updated` notification puts close to
 * their limit. Only the bucket ordinary use is metered in counts; a window
 * already full is left to the error Codex ends the turn with.
 */
export function codexLimitWarnings(rateLimits: unknown): LimitWarning[] {
  const snapshot = parseCodexRateLimitSnapshot(rateLimits);
  if (snapshot === null || (snapshot.limitId !== null && snapshot.limitId !== DEFAULT_LIMIT_ID)) return [];
  return snapshot.windows
    .filter((window) => window.usedPercent >= LIMIT_WARNING_PERCENT && window.usedPercent < 100)
    .map((window) => ({ window: usageWindowLabel(window.windowMinutes), usedPercent: window.usedPercent, resetsAt: window.resetsAt }));
}

const CLAUDE_WINDOWS: Readonly<Record<string, string>> = {
  five_hour: "5-hour",
  seven_day: "Weekly",
  seven_day_opus: "Weekly Opus",
  seven_day_sonnet: "Weekly Sonnet",
  seven_day_overage_included: "Weekly",
  overage: "Extra usage",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The warning in a Claude Code `rate_limit_event`, when Claude Code itself
 * says the plan is close (`allowed_warning`). Its utilization is not shown:
 * the SDK does not document its scale, and a wrong percentage is worse than
 * none.
 */
export function claudeLimitWarning(info: unknown): LimitWarning | null {
  if (!isRecord(info) || info.status !== "allowed_warning") return null;
  const resetsAt = typeof info.resetsAt === "number" && Number.isFinite(info.resetsAt) && info.resetsAt > 0
    // Seconds, as in the rate-limit headers it comes from; milliseconds are accepted too.
    ? info.resetsAt < 1e12 ? info.resetsAt * 1000 : info.resetsAt
    : null;
  const window = typeof info.rateLimitType === "string" ? CLAUDE_WINDOWS[info.rateLimitType] ?? "Plan" : "Plan";
  return { window, usedPercent: null, resetsAt };
}
