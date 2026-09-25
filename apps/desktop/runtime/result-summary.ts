import type { McpToolOutcome } from "./mcp-types";

/**
 * Host-side compaction of tool results.
 *
 * MCP tool payloads can carry full script sources, large search results, or
 * base64 screenshot bytes. None of that belongs on the far side of the IPC
 * boundary or in chat history — the renderer only ever needs a sentence and,
 * optionally, a short bounded detail blob for a "show more" affordance.
 */

export const MAX_SUMMARY_CHARS = 240;
export const MAX_DETAIL_CHARS = 2000;

/** Strings at least this long are treated as candidate base64 blobs. */
const BASE64_MIN_LENGTH = 256;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
/** How many entries of an array a card shows before counting the rest. */
const MAX_DISPLAY_ARRAY_ENTRIES = 10;

export type CompactOptions = {
  /**
   * Entries kept per array, at every depth. A card wants a glance, so the
   * default is small. The model's copy passes `Infinity` and lets the character
   * budget decide instead: a search result cut to its first ten hits reads to a
   * model as the whole answer with a footnote, and it pages or guesses where the
   * budget had room for the rest.
   */
  maxArrayEntries?: number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function looksLikeBase64(value: string): boolean {
  return value.length > BASE64_MIN_LENGTH && value.length % 4 === 0 && BASE64_PATTERN.test(value);
}

function base64ByteLength(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return Math.floor((value.length * 3) / 4) - padding;
}

function prepareForDisplay(value: unknown, maxArrayEntries: number): unknown {
  if (typeof value === "string") {
    if (looksLikeBase64(value)) {
      return `<binary, ${base64ByteLength(value)} bytes>`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    const shown = value.slice(0, maxArrayEntries).map((entry) => prepareForDisplay(entry, maxArrayEntries));
    if (value.length > maxArrayEntries) {
      shown.push(`… (${value.length - maxArrayEntries} more)`);
    }
    return shown;
  }
  if (isRecord(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = prepareForDisplay(entry, maxArrayEntries);
    }
    return result;
  }
  return value;
}

/** Truncates rendered text to a budget, appending a note of how much was cut. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars <= 0) return "";

  // The note's own length depends on the digit count of how much was removed,
  // which depends on how much room the note leaves — converge in a few passes.
  let keep = Math.max(0, maxChars - 30);
  for (let i = 0; i < 4; i++) {
    const removed = text.length - keep;
    const note = `… (+${removed} more characters)`;
    const nextKeep = Math.max(0, maxChars - note.length);
    if (nextKeep === keep) break;
    keep = nextKeep;
  }

  let removed = text.length - keep;
  let note = `… (+${removed} more characters)`;
  if (keep + note.length > maxChars) {
    keep = Math.max(0, maxChars - note.length);
    removed = text.length - keep;
    note = `… (+${removed} more characters)`;
  }
  return `${text.slice(0, keep)}${note}`;
}

/** Renders a value as compact, size-bounded, single-line text. */
export function compactValue(
  value: unknown,
  maxChars: number = MAX_DETAIL_CHARS,
  options: CompactOptions = {},
): string {
  const prepared = prepareForDisplay(value, options.maxArrayEntries ?? MAX_DISPLAY_ARRAY_ENTRIES);
  let rendered: string;
  try {
    const json = JSON.stringify(prepared);
    rendered = json === undefined ? String(prepared) : json;
  } catch {
    rendered = String(prepared);
  }
  return truncateText(rendered, maxChars);
}

/** Pulls a human-meaningful highlight out of a known success payload shape. */
function describeSuccessHighlight(data: unknown): string | undefined {
  if (!isRecord(data)) return undefined;

  if (Array.isArray(data.instances) || typeof data.instanceCount === "number") {
    const count = typeof data.instanceCount === "number" ? data.instanceCount : (data.instances as unknown[]).length;
    return `${count} instance${count === 1 ? "" : "s"}`;
  }

  // A revision fingerprint identifies the call but means nothing to a reader,
  // so the row says what came back and the id stays in the expandable detail.
  if (typeof data.source === "string") {
    const lines = data.source.split("\n").length;
    return `${lines} line${lines === 1 ? "" : "s"} of source`;
  }

  if (typeof data.sourceRevision === "string") {
    return "source revision recorded";
  }

  if (Array.isArray(data.entries)) {
    return `${data.entries.length} entries`;
  }

  if (Array.isArray(data.results)) {
    return `${data.results.length} results`;
  }

  if (isRecord(data.summary)) {
    const summary = data.summary;
    const parts: string[] = [];
    if (typeof summary.total === "number") parts.push(`total ${summary.total}`);
    if (typeof summary.succeeded === "number") parts.push(`succeeded ${summary.succeeded}`);
    if (typeof summary.failed === "number") parts.push(`failed ${summary.failed}`);
    if (parts.length > 0) return parts.join(", ");
  }

  return undefined;
}

/** One-line summary of a finished tool call, plus an optional bounded detail blob. */
export function summarizeToolOutcome(tool: string, outcome: McpToolOutcome): { summary: string; detail?: string } {
  const detail = outcome.data !== undefined ? compactValue(outcome.data, MAX_DETAIL_CHARS) : undefined;

  if (!outcome.ok) {
    const code = outcome.errorCode ?? "error";
    const message = outcome.message ?? "Tool call failed.";
    const summary = truncateText(`${tool} failed (${code}): ${message}`, MAX_SUMMARY_CHARS);
    return detail ? { summary, detail } : { summary };
  }

  const highlight = describeSuccessHighlight(outcome.data);
  const summaryBody =
    highlight !== undefined
      ? `${tool}: ${highlight}`
      : outcome.data !== undefined
        ? `${tool}: ${compactValue(outcome.data, MAX_SUMMARY_CHARS)}`
        : `${tool} succeeded`;
  const summary = truncateText(summaryBody, MAX_SUMMARY_CHARS);
  return detail ? { summary, detail } : { summary };
}
