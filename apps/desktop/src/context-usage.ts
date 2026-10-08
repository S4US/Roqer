import type { ProviderId } from "../shared/provider";

/**
 * The composer's context meter: how full the model's context window was at
 * its latest response in this chat, as the provider reported it.
 *
 * Nothing here is estimated. A chat whose provider has reported nothing says
 * so rather than showing a guess, and a window the provider never named is
 * left out rather than assumed. Readings live in memory, per chat: the
 * provider's own conversation does not outlive the app, so a reading from
 * before a restart would describe a context that no longer exists.
 */

/** Past this share of the window the meter turns amber and suggests a fresh chat for new work. */
export const CONTEXT_WARNING_PERCENT = 70;
/** Past this share it turns red and counts what is left instead of what is used. */
export const CONTEXT_DANGER_PERCENT = 90;

export type ContextReading = Readonly<{
  provider: ProviderId;
  /** The model the run asked for; null when it left the choice to the provider. */
  model: string | null;
  usedTokens: number;
  /** The window's size when it was reported, else null. */
  windowTokens: number | null;
  /** When the reading arrived, in epoch milliseconds. */
  observedAt: number;
}>;

/**
 * The reading to keep after a new report. Claude Code names the window only
 * as a turn ends, so a report from the middle of a turn keeps the window the
 * same model reported before; anything else replaces the reading outright.
 */
export function nextContextReading(previous: ContextReading | undefined, next: ContextReading): ContextReading {
  if (next.windowTokens !== null || previous === undefined) return next;
  if (previous.provider !== next.provider || previous.model !== next.model) return next;
  return { ...next, windowTokens: previous.windowTokens };
}

export type ContextMeterTone = "normal" | "warning" | "danger";

export type ContextMeterView =
  | Readonly<{
    kind: "none";
    /** Said in the toolbar's tooltip and to a screen reader. */
    ariaLabel: string;
    /** The panel's whole content. */
    message: string;
  }>
  | Readonly<{
    kind: "reported";
    /** Share of the window in use, 0–100, or null when the window was not reported. */
    percent: number | null;
    tone: ContextMeterTone;
    /** The toolbar's text: "34%", "6% left", or "68.4k" when the window is unknown. */
    label: string;
    ariaLabel: string;
    /** "68.4k of 200k tokens", or "68.4k tokens" without a window. */
    summary: string;
    /** "131.6k left", or null without a window. */
    left: string | null;
    usedTokens: string;
    windowTokens: string | null;
    /** Shown once the window is filling up, with a way to start afresh. */
    advice: string | null;
    /** Who reported the numbers, when, and what the provider does as the window fills. */
    footnote: string;
  }>;

/** "950", "68.4k", "200k", "1M": short enough for the toolbar. */
export function compactTokenCount(tokens: number): string {
  const whole = Math.max(0, Math.floor(tokens));
  if (whole < 1_000) return String(whole);
  if (whole < 1_000_000) {
    const thousands = whole / 1_000;
    return `${thousands < 100 ? Number(thousands.toFixed(1)) : Math.round(thousands)}k`;
  }
  return `${Number((whole / 1_000_000).toFixed(1))}M`;
}

const REPORTERS: Record<ProviderId, string> = {
  claude: "Claude Code", chatgpt: "Codex", antigravity: "The Antigravity CLI", custom: "your endpoint",
};

/**
 * What the meter shows for the chat on screen, given the model the composer
 * would use next. A reading for some other provider or model is not shown: its
 * share is of a different window, and switching starts a new provider
 * conversation anyway.
 */
export function contextMeterView(
  reading: ContextReading | undefined,
  next: { provider: ProviderId; model: string | null },
  timeZone?: string,
): ContextMeterView {
  if (reading === undefined || reading.provider !== next.provider || reading.model !== next.model) {
    return {
      kind: "none",
      ariaLabel: "Context: nothing reported yet",
      message: reading === undefined
        ? "Nothing reported in this chat yet. The meter fills in after the model's first response."
        : "Nothing reported for this model in this chat yet. The meter fills in after its first response.",
    };
  }

  const used = reading.usedTokens;
  const window = reading.windowTokens;
  const percent = window === null ? null : Math.min(100, Math.round((used / window) * 100));
  const tone: ContextMeterTone = percent === null || percent < CONTEXT_WARNING_PERCENT
    ? "normal"
    : percent < CONTEXT_DANGER_PERCENT ? "warning" : "danger";
  const left = window === null ? null : compactTokenCount(Math.max(0, window - used));
  const label = percent === null
    ? compactTokenCount(used)
    : tone === "danger" ? `${100 - percent}% left` : `${percent}%`;
  const ariaLabel = percent === null
    ? `Context: ${compactTokenCount(used)} tokens in use, window size not reported`
    : `Context: ${percent}% used, ${left} tokens left`;

  const observed = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(reading.observedAt);
  const reporter = REPORTERS[reading.provider];
  const behaviour = reading.provider === "custom"
    ? window === null
      ? " Set this model's context window in Settings to see how full it is."
      : " The window is the size set for this model in Settings."
    : window === null
      ? ` ${reporter} has not said how large this model's window is yet.`
      : ` ${reporter} summarises older messages on its own as the window fills.`;

  return {
    kind: "reported",
    percent,
    tone,
    label,
    ariaLabel,
    summary: window === null
      ? `${compactTokenCount(used)} tokens`
      : `${compactTokenCount(used)} of ${compactTokenCount(window)} tokens`,
    left: left === null ? null : `${left} left`,
    usedTokens: used.toLocaleString("en-US"),
    windowTokens: window === null ? null : window.toLocaleString("en-US"),
    advice: tone === "danger"
      ? "Almost full. Older turns will be shortened soon, and details from early in the chat may be lost."
      : tone === "warning"
        ? "Getting full. For a new task, a fresh chat gives the model a clean context."
        : null,
    footnote: `Reported by ${reporter} at ${observed}.${behaviour}`,
  };
}
