import { AUDITED_AFTER_LABEL, UI_AUDIT_TITLE } from "../shared/completion";
import { isKnownTool, TOOL_RISK } from "../shared/mcp-tools";
import {
  argumentTypeProblems,
  looksLikeArgumentError,
  requiredArgumentProblems,
  restoreArgumentTypes,
  toolSchemaHint,
  toolSignature,
  type ArgumentProblem,
} from "../shared/mcp-tool-help";
import { boundedCode, diffDeletedRange, diffText, normalizeNewlines } from "../shared/text-diff";
import type { RunChange, RunEvidence } from "../shared/run-events";
import type { McpToolImage, McpToolOutcome } from "./mcp-types";
import type { PlannerContext } from "./run-engine";
import { compactValue, truncateText } from "./result-summary";

/**
 * The single Studio tool every model provider sees, and the bookkeeping that
 * turns its results into run evidence.
 *
 * Providers differ in how a tool call reaches Roqer — Codex sends a
 * server-to-client JSON-RPC request, Claude Code calls an MCP server — but what
 * the model is allowed to ask for, how the result is compacted, and what counts
 * as a verified change must not. Keeping all of that here means a fix to the
 * verification rules lands in every provider at once.
 */

type JsonRecord = Record<string, unknown>;

export const STUDIO_TOOL_NAME = "roblox_studio";

const SCRIPT_MUTATIONS = new Set([
  "set_script_source",
  "edit_script_lines",
  "edit_script_batch",
  "insert_script_lines",
  "delete_script_lines",
]);

/** What a card says a mutation did, in place of the raw operation name. */
const MUTATION_SUMMARY: Readonly<Record<string, string>> = {
  set_script_source: "Replaced the script source in Studio.",
  edit_script_lines: "Edited lines of the script in Studio.",
  edit_script_batch: "Applied several edits to the script in one transaction.",
  insert_script_lines: "Inserted lines into the script in Studio.",
  delete_script_lines: "Deleted lines from the script in Studio.",
};

/**
 * Structured writes whose success is only what the plugin says it is.
 *
 * The plugin refuses a batch it cannot apply by answering with an `error` field
 * rather than a failed request. `McpClient` already reads that as a failure;
 * this check keeps it one for any caller whose outcome did not come through
 * the client. A refused write changed nothing, and recording it as a verified
 * change would be exactly the false success the change cards exist to prevent.
 */
const STRUCTURED_MUTATIONS = new Set(["set_properties", "build_instances"]);

function pluginRefused(outcome: McpToolOutcome): boolean {
  return isRecord(outcome.data) && typeof outcome.data.error === "string";
}

/** Operations that hand Studio a block of Luau to run, whatever it does. */
const LUAU_EXECUTION = new Set(["execute_luau", "eval_server_runtime", "eval_client_runtime"]);

/**
 * Luau that writes a script body.
 *
 * Running arbitrary Luau is how an agent creates an instance the tool surface
 * has no structured operation for, and that is legitimate. Putting a script's
 * *source* in it is not: the diff the user reads and the read-back that
 * verifies a write are both built from the structured script operations, so a
 * body assigned inside a Luau block reaches Studio with nothing shown and
 * nothing checked — the change is real and invisible, which is the one
 * combination this interface must not produce.
 *
 * Matching text rather than parsing Luau will miss an assignment built out of
 * string concatenation, and will occasionally flag a line that only mentions
 * the property. Both are acceptable: the note it produces is advice on the way
 * back from a call that already succeeded, never a refusal.
 */
const SOURCE_WRITE_IN_LUAU = /\.Source\s*=[^=]|\bSetSource\b/;

const SOURCE_WRITE_REFUSAL = [
  "This code assigns a script's Source, so it was not run.",
  "Script bodies must go through set_script_source: only the structured script operations produce the diff the user reviews and the read-back that verifies the write. Source assigned inside arbitrary Luau reaches Studio with the user shown nothing.",
  "Split it: run the Luau that creates or finds the instances, leaving Source alone, then call set_script_source {instancePath, source} once per script.",
].join("\n");

const MAX_MODEL_RESULT_CHARS = 24_000;
const MAX_EVIDENCE_LINES = 12;
const MAX_EVIDENCE_LINE_CHARS = 1_000;
const MAX_VERIFICATION_REASON_CHARS = 500;
const MAX_OBSERVATION_DETAIL_CHARS = 1_000;

type ScriptSnapshot = { source?: string; revision?: string; startLine?: number; complete?: boolean };

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  return isRecord(value) && typeof value[key] === "number" ? value[key] : undefined;
}

/**
 * The operations whose signatures the tool description carries.
 *
 * The `operation` enum names every tool the server has, but a bare name is not
 * something a model can call correctly, and spelling all of them out would put
 * the whole catalog in front of the model on every turn. So the description
 * documents the build-inspect-playtest loop an ordinary run walks, and every
 * other operation is discovered the cheap way: call it, and a call whose
 * arguments do not fit comes back with that operation's schema attached.
 */
const DOCUMENTED_OPERATIONS = [
  "get_connected_instances",
  "get_place_info",
  "get_project_structure",
  "search_objects",
  "grep_scripts",
  "get_instance_properties",
  "get_script_source",
  "set_script_source",
  "edit_script_lines",
  "edit_script_batch",
  "insert_script_lines",
  "delete_script_lines",
  "set_properties",
  "build_instances",
  "insert_asset",
  "solo_playtest",
  "get_runtime_logs",
  "selection",
  "capture_screenshot",
  "inspect_ui",
  "interact_ui",
  "execute_luau",
  "get_roblox_docs",
  "upload_asset",
];

export function studioToolDescription(): string {
  const signatures = DOCUMENTED_OPERATIONS
    .map((operation) => toolSignature(operation))
    .filter((signature): signature is string => signature !== undefined);
  return [
    "Call the connected Roblox Studio through Roqer. Roqer validates risk, routes the selected instance, asks the user when required, and returns a bounded result.",
    "A rejected action is returned as a normal tool result. Do not repeat the same effective action; choose a permitted alternative or explain the limitation.",
    "Important operations and arguments:",
    ...signatures,
    "Other operations in the enum are called the same way. To read one's schema first, call it with {help: true} as its only argument: that is answered locally, never reaches Studio, and is not a failed call. Calling with arguments that do not fit also returns the schema.",
    "Always read a script and its sourceRevision before changing it. Roqer automatically reads back every successful script mutation and tells you whether its reported revision was verified.",
    "When one script needs several exact edits, send them as one edit_script_batch rather than several edit_script_lines calls: each separate write costs its own approval, revision, and read-back, and every write after the first is resolved against source you can no longer describe.",
    "Never write a script's source inside execute_luau; that call is refused before it runs. Create the instance there when nothing structured can, then write its body with set_script_source: only the structured script operations produce the diff the user reviews and the read-back that verifies the write.",
    "Build geometry and other instances with build_instances rather than execute_luau. For edits to existing physical 3D build geometry, prefer a bounded build_instances set under the smallest containing build root; reserve set_properties for non-build properties or cases the build operation cannot express. Each step is {op: 'create'|'clone'|'set'|'remove', id?, className?, source?, parent?, target?, name?, properties?, position?: [x, y, z], rotation?: [x, y, z] degrees, transforms?: [{position?, rotation?, scale?}], tags?, attributes?}. create needs className; clone needs source and makes one copy per transform; set and remove need target. Refer to an earlier step's instance as \"$id\". A transform's rotation sets the clone's pivot orientation outright; a Model this tool creates gets an upright pivot, but a template from elsewhere keeps its own, so read its pivot before turning clones of it. Color3 is [r, g, b] from 0 to 1. Every parent and target stays inside path, the whole batch applies or none of it does, and it is one Studio undo step.",
    // Every recorded world run aimed its screenshots by writing the camera in
    // execute_luau, which is classed irreversible and so asks the user outside
    // Full auto, although this read operation frames a view deterministically.
    // A live shop passed its own screenshot review with titles under their badges,
    // text over button edges and a row past the end of its scroll.
    "After creating or changing interface (anything under StarterGui), start a playtest and call inspect_ui {mode: 'audit'} on the client. Roqer does not verify the run until an audit after the last interface change reports no problems: fix what it names (text_obscured, text_straddles_edge, content_beyond_scroll, text_overflow) and audit again.",
    "To aim a screenshot, call selection {action: 'view', path, from, angleY, padding} before capture_screenshot (from is the azimuth in degrees, 0 = +X, 90 = +Z; angleY the elevation, -89 to 89; padding the distance scale, above 0 and at most 10); it is a read that needs no approval. Do not move the camera with execute_luau. For comparable before and after views, frame the same stable container (the zone or build root, not the part being changed, whose bounds move) with the same from, angleY and padding.",
    "For seeded bulk placement, build_instances accepts one sole step {op:'scatter', name, zone:{min:[x,z],max:[x,z]}, density:countPer10000SquareStuds, seed, templates:[{source,weight,kit?}], ground:[path], raycast:{top,bottom}, rotation?:[minYaw,maxYaw], scale?:[min,max], spacing?, avoid?:[{tag,distance}], maxSlope?, replace?, parent?, tags?, attributes?, id?}. Ground and templates must already exist. The named scatter group is replaced only with replace:true and matching ownership; the entire replacement is undoable. Requested count is floor(area*density/10000), limited to 1-1000. Footprints stay inside the rectangle and clear of tagged bounds. Inspect returned scatter.requested/placed/attempts: blocked ground can produce fewer placements. Same seed reproduces only with unchanged inputs and scene. Load roblox-building references/scatter.md for details.",
  ].join("\n");
}

export function studioToolInputSchema(): JsonRecord {
  return {
    type: "object",
    properties: {
      operation: { type: "string", enum: Object.keys(TOOL_RISK) },
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["operation", "arguments"],
    additionalProperties: false,
  };
}

/** An argument object a model wrote out as JSON text, read back; anything else as it came. */
function argumentObject(value: unknown): unknown {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

/**
 * Validate the `{operation, arguments}` envelope a model supplied. Throws so
 * every provider reports the same message back to the model.
 *
 * Values a model wrote as JSON text are read back into the types the operation
 * declares here, before anything else sees the call, so the risk check, the
 * approval, the Studio request, and the run record all describe the same
 * arguments. See `restoreArgumentTypes`.
 */
export function parseStudioToolInput(value: unknown): { operation: string; args: JsonRecord } {
  const args = isRecord(value) ? argumentObject(value.arguments) : undefined;
  if (!isRecord(value) || typeof value.operation !== "string" || !isRecord(args)) {
    throw new Error("roblox_studio requires an operation and argument object.");
  }
  if (!isKnownTool(value.operation)) throw new Error(`Unknown Roblox Studio operation: ${value.operation}`);
  return { operation: value.operation, args: restoreArgumentTypes(value.operation, args) };
}

/**
 * The schema to attach to a failed call, or nothing.
 *
 * A call that never reached the server failed for a reason no schema explains,
 * and neither does a missing script or a revision conflict. Only a rejection
 * that reads like the arguments themselves were wrong earns the schema, which
 * is the difference between the model correcting itself on the next call and
 * guessing again.
 */
function argumentHint(operation: string, outcome: McpToolOutcome): string | undefined {
  if (outcome.ok || outcome.httpStatus === 0) return undefined;
  const message = outcome.message ?? outcome.text;
  if (!message || !looksLikeArgumentError(message)) return undefined;
  return toolSchemaHint(operation);
}

export function studioToolResultText(operation: string, outcome: McpToolOutcome): string {
  const hint = argumentHint(operation, outcome);
  // The hint is part of the reply the model reads, so it comes out of the same
  // budget rather than pushing the result over it.
  const budget = hint === undefined
    ? MAX_MODEL_RESULT_CHARS
    : Math.max(0, MAX_MODEL_RESULT_CHARS - hint.length - 2);
  const body = modelResultBody(operation, outcome, budget);
  return hint === undefined ? body : `${body}\n\n${hint}`;
}

const SOURCE_SEPARATOR = "\n\nsource:\n";

/**
 * Operations whose largest array is in time order, oldest first.
 *
 * When one of these does not fit, the entries worth keeping are the last ones:
 * a log read cut from the end kept the start of the buffer and lost the error
 * the model was looking for, which is nearly always the most recent line.
 */
const NEWEST_LAST: ReadonlySet<string> = new Set(["get_runtime_logs"]);

/** How to reach what a trimmed result left out, where there is something better to say than "narrow it". */
const NARROWING_HINT: Readonly<Record<string, string>> = {
  get_runtime_logs: "Pass tail, filter, or since to read a different window.",
  grep_scripts: "Narrow it with path, classFilter, or a more specific pattern to see the rest.",
  search_objects: "Use a more specific query to see the rest.",
};

/** The top-level array of a payload that takes the most room, if there is one. */
function largestArrayField(payload: JsonRecord): string | undefined {
  let largest: string | undefined;
  let largestSize = 0;
  for (const [key, value] of Object.entries(payload)) {
    if (!Array.isArray(value) || value.length === 0) continue;
    const size = JSON.stringify(value)?.length ?? 0;
    if (size > largestSize) {
      largest = key;
      largestSize = size;
    }
  }
  return largest;
}

function describeTrim(operation: string, field: string, kept: number, total: number, newestLast: boolean): string {
  const omitted = total - kept;
  const shown = newestLast ? `the newest ${kept}` : `the first ${kept}`;
  const left = `${omitted} ${newestLast ? "older " : ""}${omitted === 1 ? "entry was" : "entries were"}`;
  const hint = NARROWING_HINT[operation] ?? "Narrow the request to see the rest.";
  return `data.${field} shows ${shown} of ${total} entries; ${left} left out to fit the result budget. ${hint}`;
}

/**
 * Render an envelope within the budget, cutting by structure rather than by
 * character.
 *
 * Cutting serialized JSON at a character count leaves text that no longer
 * parses, drops whatever fields came after the big array — a log read's
 * `nextSince` cursor, a search's `count` — and gives no sign of what went. So
 * an envelope that does not fit has its largest array shortened instead, from
 * the end or, for time-ordered results, from the start, and says so in a
 * `truncated` field ahead of the data. Only a payload with no array to shorten,
 * or one still too large with that array empty, falls back to a plain cut.
 */
function fitEnvelope(
  operation: string,
  payload: unknown,
  envelope: (payload: unknown, truncated?: string) => JsonRecord,
  budget: number,
): string {
  const render = (value: JsonRecord) => compactValue(value, Number.POSITIVE_INFINITY, { maxArrayEntries: Infinity });
  const whole = render(envelope(payload));
  if (whole.length <= budget) return whole;

  const field = isRecord(payload) ? largestArrayField(payload) : undefined;
  if (field === undefined) return truncateText(whole, budget);
  const record = payload as JsonRecord;
  const entries = record[field] as unknown[];
  const newestLast = NEWEST_LAST.has(operation);
  const trimmed = (kept: number) => render(envelope(
    { ...record, [field]: newestLast ? entries.slice(entries.length - kept) : entries.slice(0, kept) },
    describeTrim(operation, field, kept, entries.length, newestLast),
  ));

  const empty = trimmed(0);
  if (empty.length > budget) return truncateText(empty, budget);
  // The whole array did not fit, so the answer is below its length. Each probe
  // is checked against the budget, so the count this settles on always fits.
  let kept = 0;
  let high = entries.length - 1;
  while (kept < high) {
    const mid = Math.ceil((kept + high) / 2);
    if (trimmed(mid).length <= budget) kept = mid;
    else high = mid - 1;
  }
  return trimmed(kept);
}

/**
 * The result as the model reads it: the envelope as JSON, and a script's source
 * after it as plain text.
 *
 * Source inside JSON is escaped — every newline a `\n`, every quote a `\"` —
 * which costs tokens on every line and hands the model text to un-escape before
 * it can quote an `old_string` back exactly. So a payload carrying `source` has
 * it lifted out and appended verbatim, with the rest of the payload (revision,
 * range, line count) still in the JSON above it. Arrays are not cut to a count
 * here; the character budget is what bounds a result the model reads.
 */
function modelResultBody(operation: string, outcome: McpToolOutcome, budget: number): string {
  const data = outcome.data;
  const source = isRecord(data) && typeof data.source === "string" ? data.source : undefined;
  const envelope = (payload: unknown, truncated?: string): JsonRecord => ({
    operation,
    ok: outcome.ok,
    ...(truncated === undefined ? {} : { truncated }),
    data: payload,
    text: outcome.text || undefined,
    errorCode: outcome.errorCode,
    message: outcome.message,
  });
  const header = fitEnvelope(
    operation,
    source === undefined ? data : { ...(data as JsonRecord), source: undefined },
    envelope,
    budget,
  );
  if (source === undefined) return header;
  const room = budget - header.length - SOURCE_SEPARATOR.length;
  if (room <= 0) return header;
  return `${header}${SOURCE_SEPARATOR}${truncateText(source, room)}`;
}

function appendModelNote(text: string, note: string | undefined): string {
  if (!note) return text;
  const separator = "\n\n";
  const available = MAX_MODEL_RESULT_CHARS - separator.length - note.length;
  if (available <= 0) return note.slice(0, MAX_MODEL_RESULT_CHARS);
  const body = text.length <= available ? text : `${text.slice(0, Math.max(0, available - 1))}…`;
  return `${body}${separator}${note}`;
}

function boundedVerificationReason(value: string): string {
  return value.length <= MAX_VERIFICATION_REASON_CHARS
    ? value
    : `${value.slice(0, MAX_VERIFICATION_REASON_CHARS - 1)}…`;
}

function evidenceLines(source: string | undefined, startLine = 1): string[] | undefined {
  return source?.split("\n").slice(0, MAX_EVIDENCE_LINES).map((line, index) => {
    const numbered = `${startLine + index}: ${line}`;
    return numbered.length <= MAX_EVIDENCE_LINE_CHARS
      ? numbered
      : `${numbered.slice(0, MAX_EVIDENCE_LINE_CHARS - 1)}…`;
  });
}

type ObservationEvidence = Omit<RunEvidence, "id" | "taskId" | "afterChangeId">;

const MAX_AUDIT_ISSUE_LINES = 12;

/**
 * An audit is a pass/fail check, not an observation: it passes only when the
 * audit ran and found nothing, and it lists what it found, so the completion
 * gate can hold a run whose interface still has measured defects.
 */
function auditEvidence(data: unknown): ObservationEvidence | undefined {
  const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const audit = record(record(data)?.audit);
  if (audit === undefined) return undefined;
  const issues = Array.isArray(audit.issues) ? audit.issues.map(record).filter((item) => item !== undefined) : [];
  const ran = audit.success === true;
  const lines = issues.slice(0, MAX_AUDIT_ISSUE_LINES).map((item) =>
    `${String(item.code ?? "issue")}: ${String(item.path ?? item.ref ?? "?")}`);
  if (issues.length > MAX_AUDIT_ISSUE_LINES) lines.push(`…and ${issues.length - MAX_AUDIT_ISSUE_LINES} more`);
  return {
    kind: "inspection",
    requirement: "visual",
    title: UI_AUDIT_TITLE,
    passed: ran && issues.length === 0,
    detail: !ran ? "The audit could not inspect the live interface." : issues.length === 0 ? "No layout problems found." : `${issues.length} layout problem(s) found.`,
    ...(lines.length > 0 ? { lines } : {}),
    metadata: [{ label: "Problems", value: String(issues.length) }],
  };
}

/** Evidence supplied by observable Studio operations, never inferred by the model. */
function observationEvidence(
  operation: string,
  args: JsonRecord,
  outcome: McpToolOutcome,
): ObservationEvidence | undefined {
  if (!outcome.ok) return undefined;
  const target = typeof args.target === "string" ? args.target : undefined;
  const detailSource = outcome.data !== undefined ? outcome.data : outcome.text || undefined;
  const detail = detailSource === undefined
    ? undefined
    : compactValue(detailSource, MAX_OBSERVATION_DETAIL_CHARS);

  switch (operation) {
    case "get_runtime_logs":
      return {
        kind: "logs",
        requirement: "runtime",
        title: target ? `Runtime logs (${target})` : "Runtime logs",
        passed: true,
        detail,
      };
    case "capture_screenshot":
      return {
        kind: "screenshot",
        requirement: "visual",
        title: target ? `Studio screenshot (${target})` : "Studio screenshot",
        passed: true,
        detail,
        metadata: outcome.images?.length
          ? [{ label: "Images returned", value: String(outcome.images.length) }]
          : undefined,
      };
    case "inspect_ui": {
      const audit = args.mode === "audit" ? auditEvidence(outcome.data) : undefined;
      if (audit !== undefined) return audit;
      return {
        kind: "inspection",
        requirement: "visual",
        title: target ? `Interface (${target})` : "Interface",
        passed: true,
        detail,
      };
    }
    case "interact_ui":
      return {
        kind: "interaction",
        requirement: "interaction",
        title: target ? `Interface (${target})` : "Interface",
        passed: true,
        detail,
      };
    case "solo_playtest":
    case "multiplayer_playtest": {
      const action = typeof args.action === "string" ? args.action : "updated";
      return {
        kind: "playtest",
        title: `${operation === "solo_playtest" ? "Solo" : "Multiplayer"} playtest ${action}`,
        passed: true,
        detail,
      };
    }
    default:
      return undefined;
  }
}

/**
 * Strip the line numbers a script read comes back wearing.
 *
 * `get_script_source` answers with a listing — "12: local x = 1" — because
 * that is what a model reads and counts against best. It is not the file. Diff
 * it against source a model wrote and every single line differs, so a
 * three-line change renders as the whole script deleted and re-added, with
 * "+52 −27" on a 26-line file to match.
 *
 * The numbering is deterministic, so it is removed only when every line
 * carries exactly the number it should. Anything else is returned untouched:
 * a payload this does not recognise is far more likely to be raw source than a
 * file worth mangling on a guess.
 */
function stripLineNumbers(source: string, startLine: number): string {
  const lines = source.split("\n");
  const stripped: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const prefix = `${startLine + index}: `;
    if (!lines[index].startsWith(prefix)) return source;
    stripped.push(lines[index].slice(prefix.length));
  }
  return stripped.join("\n");
}

function snapshotFromOutcome(outcome: McpToolOutcome): ScriptSnapshot {
  if (!isRecord(outcome.data)) return {};
  const startLine = typeof outcome.data.startLine === "number" ? outcome.data.startLine : 1;
  const endLine = numberField(outcome.data, "endLine");
  const lineCount = numberField(outcome.data, "lineCount");
  return {
    // Normalised on the way in, so every offset, match and diff downstream is
    // measured against one newline convention, and unnumbered, so they are all
    // measured against the file rather than against its listing.
    source: typeof outcome.data.source === "string"
      ? stripLineNumbers(normalizeNewlines(outcome.data.source), startLine)
      : undefined,
    revision: typeof outcome.data.sourceRevision === "string"
      ? outcome.data.sourceRevision
      : typeof outcome.data.revision === "string" ? outcome.data.revision : undefined,
    startLine,
    // Whether a read is the whole script is a question about coverage, so it is
    // answered with the range the read came back with rather than with the flag
    // saying a range was asked for: a read that reached the last line is the
    // whole file even when the server calls it partial, and one that stopped
    // short is not even when it started at line 1. A read the server did not
    // shorten carries no range at all, and is the whole file by that absence.
    complete: startLine === 1 && outcome.data.truncated !== true &&
      (endLine === undefined || lineCount === undefined || endLine >= lineCount),
  };
}

function countLines(value: string | undefined): number | undefined {
  return value === undefined ? undefined : value.split("\n").length;
}

function lineRange(value: unknown): { startLine: number; endLine: number } | undefined {
  if (typeof value !== "string") return undefined;
  const match = value.match(/^\s*(\d+)\s*(?:[-:]\s*(\d+)\s*)?$/);
  if (!match) return undefined;
  const startLine = Number(match[1]);
  const endLine = Number(match[2] ?? match[1]);
  return startLine >= 1 && endLine >= startLine ? { startLine, endLine } : undefined;
}

function lineAtOffset(source: string, offset: number, sourceStartLine: number): number {
  return sourceStartLine + source.slice(0, offset).split("\n").length - 1;
}

/**
 * Where an edit's `old_string` sits in the source that was read.
 *
 * A model's `line_range` is a hint rather than a guarantee: it drifts by a line
 * whenever the range it read and the range it edited disagree. So the anchor is
 * used to choose between real occurrences instead of to demand one at an exact
 * offset, and a single occurrence is trusted with or without an anchor. Only a
 * genuinely ambiguous edit — several occurrences and nothing to choose between
 * them — gives up, because placing the change on the wrong lines would show it
 * against code it never touched.
 */
function matchOffsetOf(
  source: string,
  needle: string,
  anchor: number | undefined,
  sourceStartLine: number,
): number | undefined {
  if (needle.length === 0) return undefined;
  const offsets: number[] = [];
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) offsets.push(at);
  if (offsets.length === 0) return undefined;
  if (offsets.length === 1) return offsets[0];
  if (anchor === undefined) return undefined;
  const anchored = offsetAtLine(source, anchor, sourceStartLine);
  if (anchored === undefined) return undefined;
  return offsets.reduce((best, offset) =>
    Math.abs(offset - anchored) < Math.abs(best - anchored) ? offset : best);
}

function offsetAtLine(source: string, line: number, sourceStartLine: number): number | undefined {
  if (line < sourceStartLine) return undefined;
  let currentLine = sourceStartLine;
  let offset = 0;
  while (currentLine < line) {
    const newline = source.indexOf("\n", offset);
    if (newline < 0) return undefined;
    offset = newline + 1;
    currentLine += 1;
  }
  return offset;
}

/**
 * Replay a batch of edits against the source they were written against.
 *
 * Deliberately the same rules the plugin applies: every `old_string` is located
 * in the untouched source, overlapping edits are refused, and the result is
 * built forwards so no offset shifts under a later edit. If any edit cannot be
 * placed the whole replay is abandoned, because a diff missing one of the edits
 * the user is approving is worse than no diff at all.
 */
function applyBatchEdits(
  beforeSource: string,
  sourceStartLine: number,
  edits: unknown,
): string | undefined {
  if (!Array.isArray(edits) || edits.length === 0) return undefined;
  const resolved: Array<{ start: number; end: number; replacement: string }> = [];
  for (const entry of edits) {
    if (!isRecord(entry)) return undefined;
    const oldString = typeof entry.old_string === "string" ? normalizeNewlines(entry.old_string) : undefined;
    const newString = typeof entry.new_string === "string" ? normalizeNewlines(entry.new_string) : undefined;
    if (oldString === undefined || newString === undefined) return undefined;
    const anchor = lineRange(entry.line_range)?.startLine;
    const offset = matchOffsetOf(beforeSource, oldString, anchor, sourceStartLine);
    if (offset === undefined) return undefined;
    resolved.push({ start: offset, end: offset + oldString.length, replacement: newString });
  }

  resolved.sort((left, right) => left.start - right.start);
  for (let index = 1; index < resolved.length; index += 1) {
    if (resolved[index].start < resolved[index - 1].end) return undefined;
  }

  let result = "";
  let cursor = 0;
  for (const edit of resolved) {
    result += beforeSource.slice(cursor, edit.start) + edit.replacement;
    cursor = edit.end;
  }
  return result + beforeSource.slice(cursor);
}

/**
 * The code a script mutation produced, as the artifact card should show it.
 *
 * A full-source write is diffed against the source that was read beforehand,
 * which is the only place both versions exist. A line edit carries its own
 * before and after, so it is diffed even when the whole file was never read.
 * When neither is possible the new source is shown as-is, and when even that
 * is unavailable — a delete, an insert of lines that were not supplied — the
 * card falls back to its summary alone.
 */
function changeArtifact(
  operation: string,
  args: JsonRecord,
  before: ScriptSnapshot | undefined,
): Pick<RunChange, "diff" | "code" | "language" | "truncated" | "addedLines" | "removedLines" | "oldStartLine" | "newStartLine"> {
  const language = "lua";
  const beforeSource = before?.source;
  // The model's strings arrive in whatever convention it writes; the source they
  // are matched and spliced against is normalised, so these must be too.
  const text = (value: unknown): string | undefined =>
    typeof value === "string" ? normalizeNewlines(value) : undefined;
  const newSource = text(args.source);
  const oldString = text(args.old_string);
  const newString = text(args.new_string);
  const newContent = text(args.newContent);

  if (operation === "set_script_source" && newSource !== undefined) {
    // A range read or truncated source is not the old file. Diffing it against
    // a full replacement would manufacture changes that never happened.
    const diff = beforeSource === undefined || before?.complete === false
      ? null
      : diffText(beforeSource, newSource);
    if (diff) {
      return {
        diff: diff.text,
        language,
        truncated: diff.truncated,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        oldStartLine: 1,
        newStartLine: 1,
      };
    }
    const bounded = boundedCode(newSource);
    // No diff means the script is new, unchanged, or too long to diff; the
    // line counts stay honest by describing the file rather than a delta.
    return {
      code: bounded.code,
      language,
      truncated: bounded.truncated,
      addedLines: beforeSource === undefined ? countLines(newSource) : undefined,
      newStartLine: 1,
    };
  }

  if (operation === "edit_script_batch") {
    // One transaction is one panel. Every edit is located in the source that was
    // read, exactly as the plugin locates it, so the card shows the file as the
    // batch left it rather than as a stack of separate replacements.
    const afterSource = beforeSource === undefined
      ? undefined
      : applyBatchEdits(beforeSource, before?.startLine ?? 1, args.edits);
    const diff = beforeSource !== undefined && afterSource !== undefined
      ? diffText(beforeSource, afterSource)
      : undefined;
    if (diff) {
      return {
        diff: diff.text,
        language,
        truncated: diff.truncated,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        oldStartLine: before?.startLine ?? 1,
        newStartLine: before?.startLine ?? 1,
      };
    }
    // Without the source, or with an edit this side cannot place, there is no
    // artifact that is true. The summary alone beats a diff drawn from guesses.
    return {};
  }

  if (oldString !== undefined && newString !== undefined) {
    const anchor = lineRange(args.line_range)?.startLine;
    const matchOffset = beforeSource === undefined
      ? undefined
      : matchOffsetOf(beforeSource, oldString, anchor, before?.startLine ?? 1);

    if (beforeSource !== undefined && matchOffset !== undefined) {
      const afterSource = beforeSource.slice(0, matchOffset)
        + newString
        + beforeSource.slice(matchOffset + oldString.length);
      const contextualDiff = diffText(beforeSource, afterSource);
      if (contextualDiff) {
        return {
          diff: contextualDiff.text,
          language,
          truncated: contextualDiff.truncated,
          addedLines: contextualDiff.addedLines,
          removedLines: contextualDiff.removedLines,
          oldStartLine: before?.startLine ?? 1,
          newStartLine: before?.startLine ?? 1,
        };
      }
    }

    // Diffing the arguments against each other is a last resort: it shows the
    // change with no code around it, and it is true only because the model said
    // so. When the whole script was read and does not contain `old_string`, the
    // edit did not change what it claims to have changed — an edit already
    // applied and then repeated is the usual reason — and drawing it from the
    // arguments would show one change as two panels. The summary alone is the
    // honest artifact there.
    if (beforeSource !== undefined && before?.complete === true && !beforeSource.includes(oldString)) {
      return {};
    }

    const diff = diffText(oldString, newString);
    if (diff) {
      const found = beforeSource?.indexOf(oldString);
      const startLine = anchor ?? (found !== undefined && found >= 0
        ? lineAtOffset(beforeSource ?? "", found, before?.startLine ?? 1)
        : 1);
      return {
        diff: diff.text,
        language,
        truncated: diff.truncated,
        addedLines: diff.addedLines,
        removedLines: diff.removedLines,
        oldStartLine: startLine,
        newStartLine: startLine,
      };
    }
  }

  if (operation === "insert_script_lines" && newContent !== undefined) {
    const newStartLine = (numberField(args, "afterLine") ?? 0) + 1;
    if (beforeSource !== undefined) {
      const sourceStartLine = before?.startLine ?? 1;
      const afterLine = numberField(args, "afterLine") ?? 0;
      const localInsert = afterLine === 0 && sourceStartLine === 1
        ? 0
        : afterLine - sourceStartLine + 1;
      const beforeLines = beforeSource.split("\n");
      if (localInsert >= 0 && localInsert <= beforeLines.length) {
        const insertedLines = newContent.split("\n");
        if (newContent.endsWith("\n")) insertedLines.pop();
        const afterSource = [
          ...beforeLines.slice(0, localInsert),
          ...insertedLines,
          ...beforeLines.slice(localInsert),
        ].join("\n");
        const diff = diffText(beforeSource, afterSource);
        if (diff) {
          return {
            diff: diff.text,
            language,
            truncated: diff.truncated,
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            oldStartLine: sourceStartLine,
            newStartLine: sourceStartLine,
          };
        }
      }
    }
    const bounded = boundedCode(newContent);
    return {
      code: bounded.code,
      language,
      truncated: bounded.truncated,
      addedLines: countLines(newContent),
      newStartLine,
    };
  }

  if (operation === "delete_script_lines" && beforeSource !== undefined) {
    const range = lineRange(args.line_range);
    if (range) {
      const sourceStartLine = before?.startLine ?? 1;
      const localStart = range.startLine - sourceStartLine;
      const localEnd = range.endLine - sourceStartLine;
      const lines = beforeSource.split("\n");
      if (localStart >= 0 && localEnd >= localStart && localEnd < lines.length) {
        const removed = lines.slice(localStart, localEnd + 1);
        const afterSource = [...lines.slice(0, localStart), ...lines.slice(localEnd + 1)].join("\n");
        const diff = diffText(beforeSource, afterSource);
        if (diff) {
          return {
            diff: diff.text,
            language,
            truncated: diff.truncated,
            addedLines: diff.addedLines,
            removedLines: diff.removedLines,
            oldStartLine: sourceStartLine,
            newStartLine: sourceStartLine,
          };
        }
        // Too long for the diff table, but the range already says what went,
        // so the deletion is still shown inside the code around it.
        const ranged = diffDeletedRange(beforeSource, localStart, localEnd);
        if (ranged) {
          return {
            diff: ranged.text,
            language,
            addedLines: ranged.addedLines,
            removedLines: ranged.removedLines,
            oldStartLine: sourceStartLine,
            newStartLine: sourceStartLine,
          };
        }
        return {
          diff: removed.map((line) => `-${line}`).join("\n"),
          language,
          addedLines: 0,
          removedLines: removed.length,
          oldStartLine: range.startLine,
          newStartLine: range.startLine,
        };
      }
    }
  }

  if (typeof args.new_string === "string") {
    const bounded = boundedCode(args.new_string);
    return { code: bounded.code, language, truncated: bounded.truncated, newStartLine: lineRange(args.line_range)?.startLine };
  }

  return {};
}

/** One sentence clause naming what is wrong with the arguments as supplied. */
function describeProblems(problems: readonly ArgumentProblem[]): string {
  const names = (reason: ArgumentProblem["reason"]) =>
    problems.filter((problem) => problem.reason === reason).map((problem) => problem.name);
  const missing = names("missing");
  const empty = names("empty");
  const clauses: string[] = [];
  if (missing.length > 0) {
    clauses.push(`it is missing the required ${missing.length === 1 ? "argument" : "arguments"} ${missing.join(", ")}`);
  }
  if (empty.length > 0) {
    clauses.push(`${empty.join(", ")} ${empty.length === 1 ? "is required and cannot" : "are required and cannot"} be empty`);
  }
  for (const problem of problems) {
    if (problem.reason === "type") clauses.push(`${problem.name} must be ${problem.expected}, but it arrived as ${problem.received}`);
  }
  return clauses.join(", and ");
}

/** "40 × 6.5 × 40 studs" from a build's reported bounds, or nothing. */
function describeBounds(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.size) || value.size.length !== 3) return undefined;
  if (!value.size.every((axis) => typeof axis === "number" && Number.isFinite(axis))) return undefined;
  return `${value.size.join(" × ")} studs`;
}

/**
 * Record a build as one change to its root, with the plugin's read-back as the
 * evidence for it.
 *
 * The verification claims exactly what the plugin did: prepared every step
 * before touching Studio, applied the batch as one undoable step, and then
 * counted what the root actually holds. It does not claim each created value
 * was compared, because it was not.
 */
function recordBuild(context: PlannerContext, args: JsonRecord, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const root = stringField(data, "path") ?? (typeof args.path === "string" ? args.path : undefined);
  if (root === undefined) return;

  const parts = (["created", "cloned", "updated", "removed"] as const)
    .map((key) => [key, numberField(data, key) ?? 0] as const)
    .filter(([, count]) => count > 0)
    .map(([key, count]) => `${count} ${key}`);
  context.recordChange({
    kind: "instance",
    target: root,
    instanceId: context.instanceId ?? undefined,
    summary: parts.length > 0
      ? `Built in one undoable step: ${parts.join(", ")}.`
      : "Applied a build batch that changed no instances.",
  });

  const descendants = numberField(data, "descendants");
  const bounds = describeBounds(data.bounds);
  const undoable = data.undoable !== false;
  context.recordEvidence({
    kind: "verification",
    changeKind: "instance",
    title: root,
    passed: true,
    detail: "Studio checked every step before changing anything, applied the batch as a whole, and read the build root back afterwards.",
    metadata: [
      ...(descendants === undefined ? [] : [{ label: "Instances under the root", value: String(descendants) }]),
      ...(bounds === undefined ? [] : [{ label: "Bounds", value: bounds }]),
      {
        label: "Undo",
        value: undoable ? "One Studio undo step" : "Not recorded in Studio's undo history",
      },
    ],
  });
}

/** A completed Roblox upload as a host-owned result card. */
function completedUpload(
  args: JsonRecord,
  outcome: McpToolOutcome,
): Omit<RunChange, "id" | "taskId"> | undefined {
  if (!outcome.ok || !isRecord(outcome.data)) return undefined;
  const data = outcome.data;
  const response = isRecord(data.response) ? data.response : {};
  const assetId = stringField(data, "asset_id") ?? stringField(response, "assetId");
  if (!assetId || !/^\d+$/.test(assetId)) return undefined;
  const status = stringField(data, "status");
  if (status !== undefined && status !== "complete") return undefined;
  if (data.done === false || isRecord(data.error)) return undefined;

  const displayName = stringField(response, "displayName") ??
    (typeof args.displayName === "string" ? args.displayName : undefined);
  const assetType = stringField(response, "assetType") ??
    (typeof args.assetType === "string" ? args.assetType : undefined);
  const moderationState = stringField(data, "moderation_state") ??
    (isRecord(response.moderationResult)
      ? stringField(response.moderationResult, "moderationState")
      : undefined);
  const operationId = stringField(data, "operation_id");
  const label = displayName ? `“${displayName}”` : assetType ? `the ${assetType.toLowerCase()}` : "the asset";
  const moderation = moderationState ? ` Moderation: ${moderationState}.` : "";

  return {
    kind: "asset",
    target: `rbxassetid://${assetId}`,
    summary: `Uploaded ${label} to Roblox as asset ${assetId}.${moderation}`,
    assetId,
    assetUrl: `https://create.roblox.com/store/asset/${assetId}`,
    assetType,
    moderationState,
    operationId,
  };
}

export type StudioToolResult = {
  ok: boolean;
  text: string;
  /** Model-only media. The activity stream and persisted chat never receive these bytes. */
  images?: readonly McpToolImage[];
};

export type StudioToolRunner = (operation: string, args: JsonRecord) => Promise<StudioToolResult>;

/**
 * Run one Studio operation through the engine and record what it proves.
 *
 * The returned function is stateful on purpose: verifying a write means
 * comparing the revision a mutation reported against the revision the
 * follow-up read returns, so the reads and writes of a single run have to be
 * remembered together.
 */
export function createStudioToolRunner(context: PlannerContext): StudioToolRunner {
  const scriptReads = new Map<string, ScriptSnapshot>();
  const changedScripts = new Map<string, string | undefined>();
  const recordedAssetIds = new Set<string>();

  const recordVerification = (
    target: string,
    expectedRevision: string | undefined,
    read: McpToolOutcome,
    automatic: boolean,
  ): string => {
    if (!read.ok) {
      // A successful write followed by a failed read leaves Studio as the only
      // authority on the resulting source. Do not build a later diff from the
      // source the model requested as though the read-back had confirmed it.
      scriptReads.delete(target);
      const reason = boundedVerificationReason(
        read.message || read.text || read.errorCode || "Studio did not return the script",
      );
      context.recordEvidence({
        kind: "verification",
        changeKind: "script-source",
        title: target,
        passed: false,
        detail: `The mutation succeeded, but Roqer could not read the script back from Studio: ${reason}`,
        metadata: expectedRevision
          ? [{ label: "Revision after write", value: expectedRevision }]
          : undefined,
      });
      return `The mutation succeeded, but ${automatic ? "automatic read-back" : "the read-back"} failed: ${reason}. Do not describe this change as verified.`;
    }

    const snapshot = snapshotFromOutcome(read);
    scriptReads.set(target, snapshot);
    const readRevision = snapshot.revision;
    const matched = expectedRevision !== undefined &&
      readRevision !== undefined &&
      expectedRevision === readRevision;
    const detail = expectedRevision === undefined
      ? "The script was read back from Studio, but the mutation did not report a source revision, so Roqer could not verify the write."
      : readRevision === undefined
        ? "The script was read back from Studio, but the read did not report a source revision, so Roqer could not verify the write."
        : matched
          ? "Read back from Studio at the revision the write reported."
          : "Read back from Studio at a different revision than the write reported, so something else changed this script.";
    context.recordEvidence({
      kind: "verification",
      changeKind: "script-source",
      title: target,
      passed: matched,
      detail,
      lines: evidenceLines(snapshot.source, snapshot.startLine),
      format: "code",
      metadata: [
        ...(expectedRevision ? [{ label: "Revision after write", value: expectedRevision }] : []),
        ...(readRevision ? [{ label: "Revision read back", value: readRevision }] : []),
      ],
    });
    // The read is the check, and it has now happened. Leaving the write pending
    // after a read that came back would re-run this on the agent's own next
    // read of the same script and file the identical failure a second time,
    // which is how one unverifiable write became two failed checks and a
    // warning that counted itself twice. A read that never arrived is the one
    // case still worth retrying, so that one stays pending.
    changedScripts.delete(target);

    return matched
      ? `Roqer ${automatic ? "automatically " : ""}read the script back and verified revision ${readRevision}.`
      : `The mutation succeeded, but ${automatic ? "automatic read-back" : "the read-back"} did not verify it. ${detail} Do not describe this change as verified.`;
  };

  /**
   * Read a script whole, however long it is.
   *
   * Studio shortens an unqualified read of a long script to its first 300
   * lines, and the two reads Roqer makes for itself are exactly the ones a
   * shortened answer is no use to: one is there to give a diff the code around
   * a change, the other to show what a write produced. An explicit range is the
   * only request the plugin will not shorten, so `1-` is how a read that must
   * see the file asks for it. The cost is the bytes of one long script over the
   * local bridge; none of it reaches the model, which reads only what it asked
   * for itself.
   */
  const readWholeScript = (target: string): Promise<McpToolOutcome> =>
    context.call("get_script_source", { instancePath: target, line_range: "1-" });

  /**
   * Make sure the whole script is known before it is written to.
   *
   * A diff can only show the code around a change if the code around it was
   * read, and an agent is free to read a single line and then edit it. That
   * leaves nothing to place the change in, so the panel degrades to a bare pair
   * of lines. Reading the file first costs one call, and only when the agent
   * has not already read it whole; it is what lets a write be shown in its
   * place in the file. A failure here is not the agent's problem: the write
   * still goes ahead and the diff falls back to whatever it can show.
   */
  const widenSourceContext = async (target: string): Promise<void> => {
    const known = scriptReads.get(target);
    if (known?.source !== undefined && known.complete === true) return;
    try {
      const read = await readWholeScript(target);
      if (!read.ok) return;
      const snapshot = snapshotFromOutcome(read);
      if (snapshot.source !== undefined) scriptReads.set(target, snapshot);
    } catch (error) {
      if (context.signal.aborted) throw error;
    }
  };

  return async function runStudioTool(operation, args) {
    // An operation's schema is a local fact. Making the model discover it by
    // sending a call it expects to fail costs a Studio round trip, an approval
    // decision on a write it did not mean yet, and a failed row in the timeline
    // that describes the model finding its footing rather than anything that
    // happened to the project. Asking is free, reaches nothing, and is not a
    // failure.
    if (args.help === true) {
      const hint = toolSchemaHint(operation);
      return {
        ok: hint !== undefined,
        text: hint ?? `No schema is published for ${operation}. It is still callable; send the arguments you believe it takes.`,
      };
    }

    // A call the server is certain to reject for a missing required argument is
    // answered here instead, with the schema. It saves a round trip to Studio,
    // and it keeps the activity timeline a record of what actually reached
    // Studio rather than of the model finding its footing.
    const problems = [...requiredArgumentProblems(operation, args), ...argumentTypeProblems(operation, args)];
    if (problems.length > 0) {
      return {
        ok: false,
        text: [
          `${operation} was not called: ${describeProblems(problems)}.`,
          toolSchemaHint(operation),
        ].filter((part): part is string => part !== undefined).join("\n\n"),
      };
    }

    // Refused before it runs, for the same reason a missing argument is: a call
    // that puts a script body into Studio without a diff or a read-back is one
    // the interface cannot honestly report, and telling the agent afterwards is
    // too late — the work is already done and it moves on. Nothing reaches
    // Studio, so there is no partial state and no failed row in the timeline;
    // the agent is handed the two calls that do the same thing properly.
    if (LUAU_EXECUTION.has(operation) && typeof args.code === "string" &&
      SOURCE_WRITE_IN_LUAU.test(args.code)) {
      return { ok: false, text: SOURCE_WRITE_REFUSAL };
    }

    const target = typeof args.instancePath === "string" ? args.instancePath : undefined;
    if (target && SCRIPT_MUTATIONS.has(operation)) await widenSourceContext(target);

    // No status line here: the activity layer already shows the call itself,
    // and a second entry saying the same thing is noise, not progress.
    const outcome = await context.call(operation, args);
    let modelNote: string | undefined;

    const observation = observationEvidence(operation, args, outcome);
    if (observation?.title === UI_AUDIT_TITLE) {
      // Which changes the audit saw, so the gate can tell an interface change made after it.
      const latest = context.changes().at(-1)?.id ?? "none";
      context.recordEvidence({ ...observation, metadata: [...(observation.metadata ?? []), { label: AUDITED_AFTER_LABEL, value: latest }] });
    } else if (observation) {
      context.recordEvidence(observation);
    }

    if (outcome.ok && operation === "get_script_source" && target) {
      const snapshot = snapshotFromOutcome(outcome);
      scriptReads.set(target, snapshot);
      if (changedScripts.has(target)) {
        const expectedRevision = changedScripts.get(target);
        modelNote = recordVerification(target, expectedRevision, outcome, false);
      }
    }

    if (outcome.ok && target && SCRIPT_MUTATIONS.has(operation)) {
      const before = scriptReads.get(target);
      const afterRevision = stringField(outcome.data, "sourceRevision") ?? stringField(outcome.data, "revision");
      context.recordChange({
        kind: "script-source",
        target,
        instanceId: context.instanceId ?? undefined,
        summary: MUTATION_SUMMARY[operation] ?? "Updated the script in Studio.",
        ...changeArtifact(operation, args, before),
        revisionBefore: before?.revision,
        revisionAfter: afterRevision,
      });
      changedScripts.set(target, afterRevision);
      // The read this diff was built from describes the script as it was before
      // this write, so it cannot be the base for the next one: a second
      // mutation would diff against the pre-edit source and replay a change
      // that already landed. A full-source write supplies its own replacement
      // snapshot; every other mutation leaves a source only Studio knows, so
      // the stale read is dropped and the next write falls back to describing
      // itself until the agent reads the script again.
      if (operation === "set_script_source" && typeof args.source === "string") {
        scriptReads.set(target, {
          source: normalizeNewlines(args.source), revision: afterRevision, startLine: 1, complete: true,
        });
      } else {
        scriptReads.delete(target);
      }

      const readback = await readWholeScript(target);
      modelNote = recordVerification(target, afterRevision, readback, true);
    }

    const refused = STRUCTURED_MUTATIONS.has(operation) && pluginRefused(outcome);

    if (outcome.ok && !refused && operation === "set_properties" && target) {
      const properties = isRecord(args.properties) ? Object.keys(args.properties).sort() : [];
      context.recordChange({
        kind: "properties",
        target,
        instanceId: context.instanceId ?? undefined,
        summary: "Properties updated atomically in Studio.",
      });
      context.recordEvidence({
        kind: "verification",
        changeKind: "properties",
        title: target,
        passed: true,
        detail: "Studio atomically assigned every requested property and immediately compared the applied values; a mismatch would have rolled the operation back.",
        metadata: properties.length > 0
          ? [{ label: "Properties verified", value: properties.join(", ") }]
          : undefined,
      });
    }

    if (outcome.ok && !refused && operation === "build_instances") {
      recordBuild(context, args, outcome);
    }

    if (operation === "upload_asset") {
      const upload = completedUpload(args, outcome);
      if (upload?.assetId && !recordedAssetIds.has(upload.assetId)) {
        recordedAssetIds.add(upload.assetId);
        context.recordChange(upload);
      }
    }

    return {
      ok: outcome.ok && !refused,
      text: appendModelNote(studioToolResultText(operation, outcome), modelNote),
      ...(outcome.images && outcome.images.length > 0 ? { images: outcome.images } : {}),
    };
  };
}
