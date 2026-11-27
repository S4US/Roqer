import { formatResetTime, LIMIT_WARNING_PERCENT, usageWindowLabel, type ProviderLimits } from "../shared/provider-limits";
import type { ProviderId } from "../shared/provider";

/**
 * What a plan's limits cover: ChatGPT meters Codex apart from chat, while
 * Claude's limits are shared by every Claude app. Antigravity meters groups of
 * models apart, and the meter shows its Gemini group.
 */
export const USAGE_SCOPES: Partial<Record<ProviderId, string>> = { chatgpt: "Codex", claude: "Claude", antigravity: "Gemini models" };

export type PlanUsageRow = Readonly<{
  label: string;
  percent: number;
  detail: string;
  tone: "normal" | "warning" | "danger";
}>;

export type PlanUsageView = Readonly<{
  rows: readonly PlanUsageRow[];
  /** Said when the provider reported the limit reached. */
  reached: boolean;
  /** What the numbers cover and how old they are. */
  footnote: string;
}>;

/**
 * What the Settings account row shows of a plan's usage: one line per window,
 * shortest first. Nothing at all when the provider reported nothing, and a
 * reset time only while it is still ahead: once it has passed, the numbers
 * wait for the next report instead of being assumed to have reset. `scope`
 * names what the limits cover, such as "Codex" or "Claude".
 */
export function planUsageView(limits: ProviderLimits, scope: string, now: number, timeZone?: string): PlanUsageView | null {
  if (limits.kind !== "reported" || limits.windows.length === 0) return null;
  const rows = [...limits.windows]
    .sort((left, right) => (left.windowMinutes ?? Infinity) - (right.windowMinutes ?? Infinity))
    .map((window): PlanUsageRow => {
      const percent = Math.round(window.usedPercent);
      const resets = window.resetsAt !== null && window.resetsAt > now
        ? ` · resets ${formatResetTime(window.resetsAt, now, timeZone)}`
        : "";
      return {
        label: `${usageWindowLabel(window.windowMinutes)} limit`,
        percent,
        detail: `${percent}% used${resets}`,
        tone: percent >= 100 ? "danger" : percent >= LIMIT_WARNING_PERCENT ? "warning" : "normal",
      };
    });
  const observed = new Intl.DateTimeFormat(undefined, {
    ...(now - limits.observedAt < 20 * 60 * 60_000 ? {} : { weekday: "short" }),
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(limits.observedAt);
  return {
    rows,
    reached: limits.limitReached,
    footnote: `Your plan's usage everywhere you use ${scope} on this account, as of ${observed}.`,
  };
}
