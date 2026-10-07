import { mcpServerMessage, type McpServerState } from "../shared/mcp-server";
import type { StudioStatus } from "../shared/studio-status";

/**
 * What Roqer can say about its own connection to Studio, as text to paste.
 *
 * A report of Studio not connecting used to depend on the person finding
 * `bridge.log` in a data folder nothing in the app named, and then trimming it
 * by hand. This is that file's recent end with the facts around it -- the
 * version, the bridge's state, what the bridge reported about Studio -- put
 * together in one place, so "Copy diagnostics" is all a report needs.
 *
 * It is built in the main process and goes straight to the clipboard. The
 * user's home folder is replaced with `~` everywhere in it: the bridge names
 * the file it read its auth token from, and that path carries the Windows
 * account name, which a public issue has no use for. Place names are left out
 * for the same reason: which session is which role says enough.
 *
 * Free of Electron so it can be tested; main.ts gathers the facts.
 */

/** Enough of the log to cover a failed start or a playtest, and no more. */
export const DIAGNOSTICS_LOG_LINES = 200;
export const DIAGNOSTICS_LOG_CHARS = 48_000;

export type DiagnosticsFacts = Readonly<{
  generatedAt: Date;
  appVersion: string;
  packaged: boolean;
  /** The operating system, as one line: platform, release, architecture. */
  system: string;
  versions: Readonly<{ electron?: string; chrome?: string; node?: string }>;
  bridge: McpServerState;
  studio: StudioStatus;
  /** Everything `bridge.log` holds; only its end is used. Empty when there is none. */
  bridgeLog: string;
  home: string;
}>;

export function composeDiagnostics(facts: DiagnosticsFacts): string {
  const versions = [
    facts.versions.electron && `Electron ${facts.versions.electron}`,
    facts.versions.chrome && `Chrome ${facts.versions.chrome}`,
    facts.versions.node && `Node ${facts.versions.node}`,
  ].filter((entry): entry is string => typeof entry === "string" && entry !== "");
  const lines = [
    `Roqer diagnostics, ${facts.generatedAt.toISOString()}`,
    "",
    `Roqer ${facts.appVersion} (${facts.packaged ? "installed" : "development build"}) on ${facts.system}`,
    ...(versions.length > 0 ? [versions.join(" · ")] : []),
    "",
    ...bridgeLines(facts.bridge),
    ...studioLines(facts.studio),
  ];

  if (facts.bridge.kind === "failed" && facts.bridge.detail !== undefined && facts.bridge.detail.trim() !== "") {
    lines.push("", "What the bridge last said before it failed:", ...fenced(facts.bridge.detail.trimEnd()));
  }

  const tail = logTail(facts.bridgeLog, DIAGNOSTICS_LOG_LINES, DIAGNOSTICS_LOG_CHARS);
  if (tail.text === "") {
    lines.push("", "bridge.log is empty or could not be read.");
  } else {
    const heading = tail.omitted ? `The last ${tail.lines} lines of bridge.log:` : "bridge.log:";
    lines.push("", heading, ...fenced(tail.text));
  }

  return redactHome(`${lines.join("\n")}\n`, facts.home);
}

function bridgeLines(state: McpServerState): string[] {
  switch (state.kind) {
    case "running":
    case "adopted": {
      const lines = [`Studio bridge: ${state.kind === "running" ? "running" : "adopted (started outside Roqer)"} at ${state.endpoint}`];
      if (state.pluginUpdated === true) lines.push("Studio plugin: replaced on this launch; a Studio that was already open runs the old one until restarted");
      if (state.pluginProblem !== undefined) lines.push(`Studio plugin: not installed: ${state.pluginProblem}`);
      return lines;
    }
    case "failed":
      return [`Studio bridge: failed: ${state.message}`];
    case "starting":
    case "stopped":
      return [`Studio bridge: ${state.kind} (${mcpServerMessage(state)})`];
  }
}

function studioLines(status: StudioStatus): string[] {
  const version = status.serverVersion === undefined ? "" : `, bridge version ${status.serverVersion}`;
  const lines = [`Studio: ${status.message} (${status.kind}) at ${status.endpoint}${version}`];
  const sessions = status.instances ?? [];
  if (status.kind === "connected" || status.kind === "bridge-only") {
    lines.push(sessions.length === 0
      ? "Sessions: none"
      : `Sessions: ${sessions.map((session) => `${session.role}${session.isRunning ? " (playing)" : ""}`).join(", ")}`);
  }
  return lines;
}

/**
 * The end of a log: its last `maxLines` lines, cut further from the front if
 * those are longer than `maxChars`. A line is never split.
 */
export function logTail(text: string, maxLines: number, maxChars: number): { text: string; lines: number; omitted: boolean } {
  const all = text.split(/\r?\n/);
  while (all.length > 0 && all[all.length - 1] === "") all.pop();
  let kept = all.slice(Math.max(0, all.length - maxLines));
  let chars = kept.reduce((total, line) => total + line.length + 1, 0);
  while (kept.length > 1 && chars > maxChars) {
    chars -= kept[0].length + 1;
    kept = kept.slice(1);
  }
  return { text: kept.join("\n"), lines: kept.length, omitted: kept.length < all.length };
}

/**
 * A fenced block for Markdown, with a fence longer than any run of backticks
 * inside it, so a log line cannot close it early on GitHub.
 */
function fenced(text: string): string[] {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [`${fence}text`, text, fence];
}

/**
 * The home folder, written `~`, however it is spelled: as Windows writes it,
 * with forward slashes, or escaped inside JSON. Case is ignored, as Windows
 * ignores it in paths. Only the whole folder name matches, so another
 * account's folder that merely starts the same way is left as it is.
 */
export function redactHome(text: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, "");
  if (trimmed.length < 3) return text;
  const spellings = new Set([
    trimmed,
    trimmed.replace(/\\/g, "/"),
    trimmed.replace(/\\/g, "\\\\"),
  ]);
  let redacted = text;
  // Longest first, so the escaped spelling is not half-replaced by the plain one.
  for (const spelling of [...spellings].sort((left, right) => right.length - left.length)) {
    redacted = redacted.replace(new RegExp(`${escapeRegExp(spelling)}(?![\\w.-])`, "gi"), "~");
  }
  return redacted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
