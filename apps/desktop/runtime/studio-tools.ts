import { BLENDER_OPERATION } from "../shared/blender";
import { AUDITED_AFTER_LABEL, UI_AUDIT_TITLE } from "../shared/completion";
import { CAPTURE_MOMENTS_OPERATION, GATEWAY_TOOL_RISK, isGatewayOperation, UPLOAD_ASSETS_OPERATION } from "../shared/gateway-operations";
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
import {
  ANIMATION_ALL_CHECKS_PASSED, ANIMATION_CHECKED_AS_GAIT, ANIMATION_GAIT_CHECKS_LABEL, ANIMATION_MOTION_CHECKS_LABEL,
  ANIMATION_DESCRIBED_BY_BAKE, ANIMATION_DESCRIBED_BY_LABEL, MODEL_STATE_WIRED, modelStateLabel,
  ANIMATION_BOXES_LABEL, ANIMATION_NAME_LABEL, ANIMATION_PLAYED_FROM_LABEL, ANIMATION_PLAYED_PUBLISHED, ANIMATION_PREVIEW_TITLE, ANIMATION_RIG_LABEL, animationSlotLabel, RIG_RANGE_SHEET_TITLE,
  BLENDER_MODEL_LABEL, BLENDER_PREVIEW_TITLE, MAX_EVIDENCE_SUBJECT_CHARS, MODEL_MOVED_BY_GAME, MODEL_MOVED_BY_LABEL,
  MODEL_MOVED_BY_VERIFY, MODEL_WHILE_MOVING_LABEL, MODEL_WHILE_STANDING_LABEL, SCREENSHOT_VIEW_LABEL, SCREENSHOT_VIEW_PLAYTEST,
  type RunChange, type RunEvidence, type RunMetadata,
} from "../shared/run-events";
import {
  isModelPreviewId, MODEL_OBJECTS_LABEL, MODEL_SIZE_LABEL, MODEL_TRIANGLES_LABEL,
} from "../shared/model-preview";
import type { McpToolImage, McpToolOutcome } from "./mcp-types";
import type { PlannerContext } from "./run-engine";
import type { SkillLibrary } from "./skill-library";
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
const STRUCTURED_MUTATIONS = new Set(["set_properties", "build_instances", "animation"]);

function pluginRefused(outcome: McpToolOutcome): boolean {
  return isRecord(outcome.data) && typeof outcome.data.error === "string";
}

/** Operations that hand Studio a block of Luau to run, whatever it does. */
const LUAU_EXECUTION = new Set(["execute_luau", "eval_server_runtime", "eval_client_runtime", CAPTURE_MOMENTS_OPERATION]);

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
 * The operations whose signatures the tool guide carries.
 *
 * The `operation` enum names every tool the server has, but a bare name is not
 * something a model can call correctly, and spelling all of them out would put
 * the whole catalog in front of the model on every turn. So the guide
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
  // Not `animation`: its guide below names each action's arguments where they
  // are used, which the bare signature of its many optional ones did not.
  "insert_asset",
  "solo_playtest",
  "get_runtime_logs",
  "selection",
  "capture_screenshot",
  CAPTURE_MOMENTS_OPERATION,
  "inspect_ui",
  "interact_ui",
  "execute_luau",
  "get_roblox_docs",
  "upload_asset",
  UPLOAD_ASSETS_OPERATION,
];

/**
 * The most of a tool description Claude Code passes on: it cuts an MCP tool's
 * description to its first 2,048 characters, silently. Everything the model
 * needs beyond a short summary is therefore in `studioToolGuide`, which every
 * provider receives in its developer instructions.
 */
export const MAX_TOOL_DESCRIPTION_CHARS = 2_048;

export function studioToolDescription(): string {
  return [
    "Call the connected Roblox Studio through Roqer, which validates risk, routes the selected instance, asks the user when required, and bounds the result.",
    "A rejected action is returned as a normal tool result. Do not repeat the same effective action; choose a permitted alternative or explain the limitation.",
    "Pass {operation, arguments}. The arguments of the operations a run leans on, and the rules for using them, are in the developer instructions under <roblox-studio-tool>; read them before a first call.",
    "To read any operation's schema, call it with {help: true} as its only argument: that is answered locally, never reaches Studio, and is not a failed call.",
  ].join("\n");
}

/**
 * How to use `roblox_studio`: the signatures of the operations an ordinary run
 * walks and the rules that keep its writes reviewable and verified.
 *
 * Too long for a tool description (see `MAX_TOOL_DESCRIPTION_CHARS`), so it
 * travels in the developer instructions of every provider instead.
 */
export function studioToolGuide(): string {
  const signatures = DOCUMENTED_OPERATIONS
    .map((operation) => toolSignature(operation))
    .filter((signature): signature is string => signature !== undefined);
  return [
    `Every operation below is called through the ${STUDIO_TOOL_NAME} tool as {operation, arguments}.`,
    "Important operations and arguments:",
    ...signatures,
    "Other operations in the enum are called the same way. To read one's schema first, call it with {help: true} as its only argument: that is answered locally, never reaches Studio, and is not a failed call. Calling with arguments that do not fit also returns the schema.",
    "Always read a script and its sourceRevision before changing it, except one that is still empty, such as a script build_instances just created: omit expectedRevision and Roqer checks it is empty and supplies the revision. Roqer automatically reads back every successful script mutation and tells you whether its reported revision was verified; that is the check, so do not read a script again only to confirm a write.",
    `To write a skill's Lua template unchanged, pass template (its skill path, e.g. ${TEMPLATE_EXAMPLE}) instead of source: Roqer writes the file itself, so do not load a template you are not changing, and never retype one. A script that already holds it exactly is left alone.`,
    "A script write whose source will not compile still lands, and its result carries syntaxError {line, message}: fix that line before playtesting. syntaxCheck: 'unavailable' means the source was not checked. Only syntax is judged, not types or member names.",
    "When one script needs several exact edits, send them as one edit_script_batch rather than several edit_script_lines calls: each separate write costs its own approval, revision, and read-back, and every write after the first is resolved against source you can no longer describe.",
    "Never write a script's source inside execute_luau; that call is refused before it runs. Create the instance there when nothing structured can, then write its body with set_script_source: only the structured script operations produce the diff the user reviews and the read-back that verifies the write.",
    "Build geometry and other instances with build_instances rather than execute_luau. For edits to existing physical 3D build geometry, prefer a bounded build_instances set under the smallest containing build root; reserve set_properties for non-build properties or cases the build operation cannot express. Each step is {op: 'create'|'clone'|'set'|'remove', id?, className?, source?, parent?, target?, name?, properties?, position?: [x, y, z], rotation?: [x, y, z] degrees, transforms?: [{position?, rotation?, scale?}], tags?, attributes?}. create needs className; clone needs source and makes one copy per transform; set and remove need target. Refer to an earlier step's instance as \"$id\". A transform's rotation sets the clone's pivot orientation outright; a Model build_instances creates gets an upright pivot, but a template from elsewhere keeps its own, so read its pivot before turning clones of it. Color3 is [r, g, b] from 0 to 1. A CFrame is {position, rotation?} in those forms. Every parent and target stays inside path, the whole batch applies or none of it does, and it is one Studio undo step. path may be a service itself (game.ReplicatedStorage, game.Lighting) for a batch that only adds: create, clone, and set on what it made. To delete a whole build root, such as a preview marker's, send {op: 'remove', target: <its path>} as the batch's only step.",
    // Every recorded world run aimed its screenshots by writing the camera in
    // execute_luau, which is classed irreversible and so asks the user outside
    // Full auto, although this read operation frames a view deterministically.
    // A live shop passed its own screenshot review with titles under their badges,
    // text over button edges and a row past the end of its scroll.
    "After creating or changing interface (anything under StarterGui), start a playtest and call inspect_ui {mode: 'audit'} on the client. Roqer does not verify the run until an audit after the last interface change reports no problems: fix what it names (text_obscured, text_straddles_edge, content_beyond_scroll, text_overflow) and audit again.",
    "To aim a screenshot, call selection {action: 'view', path, from, angleY, padding} before capture_screenshot (from: azimuth degrees, 0 = +X, 90 = +Z; angleY: elevation, -89 to 89; padding: distance scale, above 0, at most 10); it is a read needing no approval. Do not move the camera with execute_luau. For comparable before and after views, frame the same stable container (the zone or build root, not the part being changed, whose bounds move) with the same from, angleY and padding.",
    "Animate characters with animation, never a KeyframeSequence in execute_luau; first load_skill {name: 'roblox-animation-vfx', resource: 'references/character-animation.md'} and adapt its tested recipes. animation: {name, rig: 'R15' or a Model's path, loop?, priority?, easing?, keyframes: [{time, easing?, joints}]}, first at time 0; joints maps Root, Waist, Neck, Left/Right Shoulder, Elbow, Wrist, Hip, Knee, Ankle to one of aim: [right, up, forward] + bendToward? (shoulders, hips), bend: degrees (elbows, knees), rotation: [x, y, z] degrees about the parent part; position? (Root, studs). Key moved joints at time 0; a joint turns at most 90° between keys. Flow: check {animation, locomotion?: true for gaits, grounded?} (free; fix what fails) → build {animation, parent} → publish {path, display_name?} (asks first; place owner only) → wire {slot, animation_id} (expected_id to replace) → playtest → verify {animation, animation_id?, slot?}. An NPC's or creature's Model plays its own: rig {model, stock: R15|R6, position?} makes a stock NPC whose loader holds Roblox's defaults; wire {model, slot: idle|walk|run, animation_id, expected_id?, ground_speed: the gait's check groundSpeed}; in a playtest, verify {model} watches its script move it, and position walks it there. With no Open Cloud key, verify with just animation and say publishing needs a key. Rebuild with expected_revision; waive only intended failures.",
    "For seeded bulk placement, build_instances accepts one sole step {op:'scatter', name, zone:{min:[x,z],max:[x,z]}, density:countPer10000SquareStuds, seed, templates:[{source,weight,kit?}], ground:[path], raycast:{top,bottom}, rotation?:[minYaw,maxYaw], scale?:[min,max], spacing?, avoid?:[{tag,distance}], maxSlope?, replace?, parent?, tags?, attributes?, id?}. Ground and templates must already exist. The named scatter group is replaced only with replace:true and matching ownership; the entire replacement is undoable. Requested count is floor(area*density/10000), limited to 1-1000. Footprints stay inside the rectangle and clear of tagged bounds. Inspect returned scatter.requested/placed/attempts: blocked ground can produce fewer placements. Same seed reproduces only with unchanged inputs and scene. Load roblox-building references/scatter.md for details.",
  ].join("\n");
}

export function studioToolInputSchema(): JsonRecord {
  return {
    type: "object",
    properties: {
      operation: { type: "string", enum: [...Object.keys(TOOL_RISK), ...Object.keys(GATEWAY_TOOL_RISK)] },
      arguments: { type: "object", additionalProperties: true },
    },
    required: ["operation", "arguments"],
    additionalProperties: false,
  };
}

/**
 * A tool call whose shape is wrong: the model's mistake to correct on its next
 * call, never a reason to end the run. Providers answer it as an ordinary
 * failed tool result; anything else thrown at that boundary is a host failure.
 */
export class MalformedToolCallError extends Error {
  override readonly name = "MalformedToolCallError";
}

/**
 * How many malformed calls in a row a run answers before it ends. Each one is
 * answered with what was wrong, so a model that can correct itself does so on
 * the next call; one that sends the same broken shape again and again is not
 * converging, and would otherwise spend the user's allowance until stopped.
 */
export const MAX_CONSECUTIVE_MALFORMED_CALLS = 3;

export function malformedCallsEndRun(lastMessage: string): Error {
  return new Error(`The model sent ${MAX_CONSECUTIVE_MALFORMED_CALLS} malformed tool calls in a row, so the run stopped. The last one: ${lastMessage}`);
}

/**
 * JSON text with the raw line breaks and tabs inside its strings escaped.
 *
 * A model that writes an argument object out as text often leaves a Luau
 * body's newlines raw inside its strings. JSON forbids those characters there
 * and they can mean nothing but themselves, so escaping them changes no value;
 * it only lets the text parse. Characters outside strings are left alone.
 */
function escapeRawControlCharacters(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (const character of text) {
    if (inString && !escaped && (character === "\n" || character === "\r" || character === "\t")) {
      result += character === "\n" ? "\\n" : character === "\r" ? "\\r" : "\\t";
      continue;
    }
    result += character;
    if (escaped) escaped = false;
    else if (inString && character === "\\") escaped = true;
    else if (character === "\"") inString = !inString;
  }
  return result;
}

type ArgumentReading = { value: unknown; parseError?: string };

/** An argument object a model wrote out as JSON text, read back; anything else as it came. */
function argumentObject(value: unknown): ArgumentReading {
  if (typeof value !== "string" || !value.trim().startsWith("{")) return { value };
  try {
    return { value: JSON.parse(value) as unknown };
  } catch (error) {
    try {
      return { value: JSON.parse(escapeRawControlCharacters(value)) as unknown };
    } catch {
      return { value, parseError: error instanceof Error ? error.message : String(error) };
    }
  }
}

const ENVELOPE_RULE = `${STUDIO_TOOL_NAME} requires an operation and argument object.`;
const ENVELOPE_SHAPE = "Call it as {operation: \"<name>\", arguments: {...}}, with every argument of the operation inside arguments.";
const MAX_LISTED_STRAY_KEYS = 8;

/** What was wrong with an envelope, in words the model can act on. */
function envelopeProblem(value: unknown, reading: ArgumentReading | undefined): string {
  if (!isRecord(value)) return "The call was not an object.";
  if (typeof value.operation !== "string" || value.operation === "") {
    return "operation is missing; it must name one operation as a string.";
  }
  const stray = Object.keys(value).filter((key) => key !== "operation" && key !== "arguments");
  if (value.arguments === undefined || value.arguments === null) {
    if (stray.length === 0) return `arguments is missing; send arguments: {} when ${value.operation} needs none.`;
    const listed = stray.slice(0, MAX_LISTED_STRAY_KEYS).map((key) => truncateText(key, 60)).join(", ");
    const more = stray.length > MAX_LISTED_STRAY_KEYS ? ` and ${stray.length - MAX_LISTED_STRAY_KEYS} more` : "";
    return `arguments is missing, and ${listed}${more} arrived beside operation; move ${stray.length === 1 ? "it" : "them"} inside arguments.`;
  }
  if (reading?.parseError !== undefined) {
    return `arguments arrived as text that is not valid JSON (${truncateText(reading.parseError, 200)}); send the object itself, not a string.`;
  }
  if (typeof value.arguments === "string") return "arguments arrived as text, not an object; send the object itself.";
  if (Array.isArray(value.arguments)) return "arguments arrived as an array; it must be an object of named arguments.";
  return `arguments arrived as a ${typeof value.arguments}; it must be an object of named arguments.`;
}

/**
 * Validate the `{operation, arguments}` envelope a model supplied. Throws a
 * `MalformedToolCallError` so every provider reports the same message back to
 * the model, saying what arrived wrong rather than only what the rule is.
 *
 * Values a model wrote as JSON text are read back into the types the operation
 * declares here, before anything else sees the call, so the risk check, the
 * approval, the Studio request, and the run record all describe the same
 * arguments. See `restoreArgumentTypes`.
 */
export function parseStudioToolInput(value: unknown): { operation: string; args: JsonRecord } {
  const reading = isRecord(value) ? argumentObject(value.arguments) : undefined;
  if (!isRecord(value) || typeof value.operation !== "string" || value.operation === "" || !isRecord(reading?.value)) {
    throw new MalformedToolCallError(`${ENVELOPE_RULE} ${envelopeProblem(value, reading)} ${ENVELOPE_SHAPE}`);
  }
  if (!isKnownTool(value.operation) && !isGatewayOperation(value.operation)) {
    throw new MalformedToolCallError(`Unknown Roblox Studio operation: ${truncateText(value.operation, 120)}`);
  }
  return { operation: value.operation, args: restoreArgumentTypes(value.operation, reading.value) };
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
  get_project_structure: "Pass one of their paths, or a smaller maxDepth, to see the rest.",
};

/**
 * How many left-out entries a trim note names. A few large entries are the case
 * that needs it: one oversized subtree used to leave a tree showing only the
 * small entries before it, with nothing to say what the rest were called, so the
 * model could not ask for them. Past this many, narrowing the request is the
 * better answer, and a partial list would read as the whole of what was cut.
 */
const MAX_NAMED_OMISSIONS = 20;
const MAX_OMISSION_LABEL_CHARS = 160;

/** What to call an entry the note names: the path to ask for it by, or failing that its name. */
function entryLabel(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  const label = [entry.path, entry.instancePath, entry.name].find((value) => typeof value === "string" && value !== "");
  return typeof label === "string" ? truncateText(label, MAX_OMISSION_LABEL_CHARS) : undefined;
}

/** Every left-out entry by name, or nothing when they are too many or not all nameable. */
function omittedLabels(omitted: readonly unknown[]): string[] | undefined {
  if (omitted.length === 0 || omitted.length > MAX_NAMED_OMISSIONS) return undefined;
  const labels = omitted.map(entryLabel);
  return labels.every((label) => label !== undefined) ? labels as string[] : undefined;
}

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

function describeTrim(
  operation: string,
  field: string,
  kept: number,
  total: number,
  newestLast: boolean,
  omitted: readonly unknown[],
): string {
  const omittedCount = total - kept;
  const shown = newestLast ? `the newest ${kept}` : `the first ${kept}`;
  const left = `${omittedCount} ${newestLast ? "older " : ""}${omittedCount === 1 ? "entry was" : "entries were"}`;
  const labels = omittedLabels(omitted);
  const named = labels === undefined ? "" : `: ${labels.join(", ")}`;
  const hint = NARROWING_HINT[operation] ?? "Narrow the request to see the rest.";
  return `data.${field} shows ${shown} of ${total} entries; ${left} left out to fit the result budget${named}. ${hint}`;
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
    describeTrim(
      operation, field, kept, entries.length, newestLast,
      newestLast ? entries.slice(0, entries.length - kept) : entries.slice(kept),
    ),
  ));

  const empty = trimmed(0);
  if (empty.length > budget) return truncateText(empty, budget);
  // The whole array did not fit, so the answer is below its length. Each probe
  // is checked against the budget, so the count this settles on always fits.
  // Naming what was left out makes a shorter note for a longer kept prefix, so
  // the length is not strictly monotonic; the search can then settle a little
  // short of the longest prefix that fits, never past it.
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

/**
 * What a Blender job's preview is: the job's own output, seen before upload.
 *
 * Kept as an inspection with no requirement, so it shows in the answer without
 * counting toward the completion gate: a render of a file is not evidence of
 * anything in Studio.
 */
const BLENDER_PREVIEW_EVIDENCE: ObservationEvidence = {
  kind: "inspection",
  title: BLENDER_PREVIEW_TITLE,
  detail: "Rendered by Blender from the job's output. A Studio screenshot shows what is in the place.",
};

/** A model's file name, as the preview records it; Blender's own are far shorter. */
const MAX_MODEL_NAME_CHARS = 120;

/** What Roqer's inspection names the picture of a job that exported nothing: its scene. */
const SCENE_PICTURE_NAME = "scene.blend";

/**
 * Which Blender model a job's preview shows, across one run's jobs.
 *
 * A job that continued an earlier job's scene is a later version of that
 * job's model: the agent revising a mug continues from its first take, even
 * when the first take only sketched it in the scene and the second exported
 * `mug.glb`. A job that started from an empty scene is a new model, unless it
 * writes the same exported file as an earlier one did, which is a rebuild of
 * that model. Anything else is a model of its own, named by its job.
 */
class BlenderLineage {
  readonly #byJob = new Map<string, string>();
  readonly #byFile = new Map<string, string>();

  /** The subject of a finished job's model, remembering it for the jobs that follow. */
  follow(outcome: McpToolOutcome): string | undefined {
    const data = isRecord(outcome.data) ? outcome.data : {};
    const jobId = stringField(data, "jobId");
    if (jobId === undefined) return undefined;
    const continued = stringField(data, "continuedFrom");
    const file = outcome.pictured?.name;
    const exported = file !== undefined && file !== SCENE_PICTURE_NAME ? file : undefined;
    const subject = (continued === undefined ? undefined : this.#byJob.get(continued))
      ?? (exported === undefined ? undefined : this.#byFile.get(exported))
      ?? `blender-job:${jobId}`.slice(0, MAX_EVIDENCE_SUBJECT_CHARS);
    this.#byJob.set(jobId, subject);
    if (exported !== undefined && !this.#byFile.has(exported)) this.#byFile.set(exported, subject);
    return subject;
  }
}

/**
 * What a Blender job's result says about the model its preview pictures: the
 * file it was written to, the id of its 3D preview when the inspection kept
 * one, and what the inspection measured, in studs on Roblox's axes (X, then
 * Blender's up as Y, then Z).
 */
function blenderModelFacts(outcome: McpToolOutcome): Pick<ObservationEvidence, "modelPreviewId" | "metadata"> {
  const pictured = outcome.pictured;
  if (pictured === undefined) return {};
  const data = isRecord(outcome.data) ? outcome.data : {};
  const file = (Array.isArray(data.files) ? data.files : []).find((entry) => isRecord(entry) && entry.name === pictured.name);
  // Which model this is, by the file it was written to: the card shows every
  // preview of one file as versions of one model.
  const metadata: RunMetadata[] = [{ label: BLENDER_MODEL_LABEL, value: pictured.name.slice(0, MAX_MODEL_NAME_CHARS) }];
  if (isRecord(file)) {
    const size = Array.isArray(file.size) && file.size.length === 3 && file.size.every((value) => typeof value === "number" && Number.isFinite(value))
      ? file.size as number[]
      : undefined;
    if (size !== undefined) {
      metadata.push({ label: MODEL_SIZE_LABEL, value: `${[size[0], size[2], size[1]].map((value) => value.toFixed(1)).join(" × ")} studs` });
    }
    if (typeof file.triangles === "number") metadata.push({ label: MODEL_TRIANGLES_LABEL, value: file.triangles.toLocaleString("en-US") });
    if (typeof file.meshes === "number") metadata.push({ label: MODEL_OBJECTS_LABEL, value: String(file.meshes) });
  }
  return {
    ...(isModelPreviewId(pictured.modelPreviewId) ? { modelPreviewId: pictured.modelPreviewId } : {}),
    metadata,
  };
}

/** The host-made preview of the first image a call returned, if it can make one. */
async function evidencePreview(context: PlannerContext, outcome: McpToolOutcome): Promise<string | undefined> {
  const image = outcome.images?.[0];
  if (!outcome.ok || image === undefined || context.previewImage === undefined) return undefined;
  try {
    return await context.previewImage(image);
  } catch {
    return undefined;
  }
}

/**
 * Evidence supplied by observable Studio operations, never inferred by the model.
 *
 * `playtestRunning` is whether a playtest this run started is still running,
 * as far as this run's own calls say; a screenshot taken then is marked so.
 */
function observationEvidence(
  operation: string,
  args: JsonRecord,
  outcome: McpToolOutcome,
  playtestRunning = false,
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
    case "capture_screenshot": {
      const metadata = [
        ...(outcome.images?.length ? [{ label: "Images returned", value: String(outcome.images.length) }] : []),
        ...(playtestRunning ? [{ label: SCREENSHOT_VIEW_LABEL, value: SCREENSHOT_VIEW_PLAYTEST }] : []),
      ];
      return {
        kind: "screenshot",
        requirement: "visual",
        title: target ? `Studio screenshot (${target})` : "Studio screenshot",
        passed: true,
        detail,
        metadata: metadata.length > 0 ? metadata : undefined,
      };
    }
    case CAPTURE_MOMENTS_OPERATION: {
      // The first moment is the picture the card shows; the model sees them all.
      const times = Array.isArray(args.times) ? args.times.filter((time): time is number => typeof time === "number") : [];
      // Paired with a reference clip, half the picture is the clip, labelled R; the card says so.
      const compared = stringField(outcome.data, "comparedWith");
      const metadata = [
        { label: "Images returned", value: String(outcome.images?.length ?? 0) },
        ...(times.length > 0 ? [{ label: "Moments", value: times.map((time) => `${time} s`).join(", ") }] : []),
        ...(compared === undefined ? [] : [{ label: "Compared with", value: `reference clip ${compared} (its frames are labelled R)` }]),
        ...(playtestRunning ? [{ label: SCREENSHOT_VIEW_LABEL, value: SCREENSHOT_VIEW_PLAYTEST }] : []),
      ];
      return {
        kind: "screenshot",
        requirement: "visual",
        title: compared === undefined ? "Effect captured at several moments" : "Effect captured beside the reference clip",
        passed: true,
        detail: truncateText(outcome.text, MAX_OBSERVATION_DETAIL_CHARS),
        metadata,
      };
    }
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

  if (data.removedRoot === true) {
    context.recordChange({
      kind: "instance",
      target: root,
      instanceId: context.instanceId ?? undefined,
      summary: "Removed the build root and everything in it, in one undoable step.",
    });
    context.recordEvidence({
      kind: "verification",
      changeKind: "instance",
      title: root,
      passed: true,
      detail: "Studio took the build root out of the place as the batch's only step.",
      metadata: [{ label: "Undo", value: data.undoable !== false ? "One Studio undo step" : "Not recorded in Studio's undo history" }],
    });
    return;
  }

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
  // Under a service root the counts and bounds cover what the batch added, not the service.
  const serviceRoot = data.serviceRoot === true;
  context.recordEvidence({
    kind: "verification",
    changeKind: "instance",
    title: root,
    passed: true,
    detail: serviceRoot
      ? "Studio checked every step before changing anything, applied the batch as a whole, and read back what it added to the service."
      : "Studio checked every step before changing anything, applied the batch as a whole, and read the build root back afterwards.",
    metadata: [
      ...(descendants === undefined ? [] : [{ label: serviceRoot ? "Instances the batch added" : "Instances under the root", value: String(descendants) }]),
      ...(bounds === undefined ? [] : [{ label: "Bounds", value: bounds }]),
      {
        label: "Undo",
        value: undoable ? "One Studio undo step" : "Not recorded in Studio's undo history",
      },
    ],
  });
}

/** How the MCP's result opens its list of MeshParts drawn as their boxes; the metadata's label says it instead. */
const BOXES_PREFIX = "MeshParts drawn as their boxes: ";
/** The most of that list a preview's metadata keeps; the journal keeps 500 characters of a value. */
const MAX_BOXES_CHARS = 400;

/**
 * Which MeshParts a preview's sheet drew as their boxes, and why, as metadata,
 * or nothing when the result names none: `sheet` for an animation's contact
 * sheet, `rangeSheet` for a rig's.
 */
function boxesMetadata(data: JsonRecord, sheet: "sheet" | "rangeSheet"): RunMetadata[] {
  const drawn = stringField(data[sheet], "boxes");
  if (drawn === undefined || drawn.trim() === "") return [];
  const named = drawn.startsWith(BOXES_PREFIX) ? drawn.slice(BOXES_PREFIX.length) : drawn;
  return [{ label: ANIMATION_BOXES_LABEL, value: named.length <= MAX_BOXES_CHARS ? named : `${named.slice(0, MAX_BOXES_CHARS - 1)}…` }];
}

/**
 * An animation's contact sheet as a preview in the answer, with the box rig's
 * 3D preview behind it when the host could keep one. Both were drawn by the
 * MCP bridge from the compiled motion, never by the model or the renderer.
 */
async function recordAnimationPreview(context: PlannerContext, outcome: McpToolOutcome): Promise<void> {
  const data = isRecord(outcome.data) ? outcome.data : {};
  if (data.valid !== true && data.built !== true) return;
  const imageDataUrl = await evidencePreview(context, outcome);
  if (imageDataUrl === undefined) return;
  let modelPreviewId: string | undefined;
  if (outcome.modelFile !== undefined && context.storeModelPreview !== undefined) {
    modelPreviewId = await context.storeModelPreview(outcome.modelFile).catch(() => undefined);
  }
  const animation = isRecord(data.animation) ? data.animation : {};
  const checks = isRecord(data.checks) ? data.checks : {};
  const name = stringField(animation, "name") ?? "The animation";
  const rig = stringField(animation, "rig");
  const duration = numberField(animation, "duration");
  const keyframes = numberField(animation, "keyframes");
  context.recordEvidence({
    kind: "inspection",
    title: ANIMATION_PREVIEW_TITLE,
    passed: checks.passed === true,
    detail: `${name}: ${checks.passed === true ? "every motion check passed" : "a motion check failed"}${data.built === true ? ", and it was built in Studio" : ""}.`,
    imageDataUrl,
    ...(isModelPreviewId(modelPreviewId) ? { modelPreviewId } : {}),
    metadata: [
      { label: ANIMATION_NAME_LABEL, value: name },
      ...(rig === undefined ? [] : [{ label: ANIMATION_RIG_LABEL, value: rig }]),
      // Before the counts: a journal clipped for room keeps a preview's first five.
      ...boxesMetadata(data, "sheet"),
      ...(keyframes === undefined ? [] : [{ label: "Keyframes", value: String(keyframes) }]),
      ...(duration === undefined ? [] : [{ label: "Length", value: `${duration} s${animation.loop === true ? ", looping" : ""}` }]),
    ],
  });
}

/**
 * A built animation as a change card and its verification. The evidence
 * passes only when Studio's read-back matched what was compiled and its
 * preview played as the checks measured; the MCP result carries both.
 */
function recordAnimationBuild(context: PlannerContext, args: JsonRecord, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const path = stringField(data, "path");
  if (path === undefined || data.built !== true) return;
  const animation = isRecord(data.animation) ? data.animation : {};
  const readBack = isRecord(data.readBack) ? data.readBack : {};
  const playback = isRecord(data.playback) ? data.playback : {};
  const checks = isRecord(data.checks) ? data.checks : {};
  const keyframes = numberField(animation, "keyframes");
  const duration = numberField(animation, "duration");
  const facts = [
    ...(keyframes === undefined ? [] : [`${keyframes} keyframe${keyframes === 1 ? "" : "s"}`]),
    ...(duration === undefined ? [] : [`${duration} s`]),
    ...(animation.loop === true ? ["looping"] : []),
  ];
  context.recordChange({
    kind: "instance",
    target: path,
    instanceId: context.instanceId ?? undefined,
    summary: `${data.replaced === true ? "Rebuilt" : "Built"} an animation in one undoable step${facts.length > 0 ? `: ${facts.join(", ")}` : ""}.`,
  });

  const waived = Array.isArray(checks.waived) ? checks.waived.filter((id): id is string => typeof id === "string") : [];
  // The gait checks run only when the call said the motion is a gait; a walk
  // or run built without them has not had its feet checked.
  const groundContact = Array.isArray(checks.results)
    ? checks.results.find((result) => isRecord(result) && result.id === "groundContact")
    : undefined;
  const gaitChecked = isRecord(groundContact) ? groundContact.status !== "skipped" : undefined;
  const maxDegrees = numberField(playback, "maxDegrees");
  const passed = readBack.matchesCompiled === true && playback.verified === true;
  context.recordEvidence({
    kind: "verification",
    changeKind: "instance",
    title: path,
    passed,
    detail: passed
      ? "Roqer checked the motion before building. Studio played it on a temporary dummy and matched the checked model, then wrote the sequence and read it back."
      : "Studio wrote the sequence, but what it read back or played does not match what Roqer compiled and checked.",
    metadata: [
      { label: ANIMATION_MOTION_CHECKS_LABEL, value: waived.length > 0 ? `Passed, with ${waived.join(", ")} waived` : ANIMATION_ALL_CHECKS_PASSED },
      ...(gaitChecked === undefined ? [] : [{ label: ANIMATION_GAIT_CHECKS_LABEL, value: gaitChecked ? ANIMATION_CHECKED_AS_GAIT : "Not checked as a gait" }]),
      // The bridge read the description from the file the call named; only a Blender job's bake is named so.
      ...(typeof args.animation_file === "string" ? [{ label: ANIMATION_DESCRIBED_BY_LABEL, value: ANIMATION_DESCRIBED_BY_BAKE }] : []),
      ...(maxDegrees === undefined ? [] : [{ label: "Preview", value: `Within ${maxDegrees}° of the checked model` }]),
      { label: "Read back", value: readBack.matchesCompiled === true ? "Matches what was compiled" : "Differs from what was compiled" },
      { label: "Undo", value: data.undoable !== false ? "One Studio undo step" : "Not recorded in Studio's undo history" },
    ],
  });
}

/** A published animation as an asset card, verified by reading the asset back. */
function recordAnimationPublish(context: PlannerContext, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const assetId = stringField(data, "assetId");
  if (data.published !== true || !assetId || !/^\d+$/.test(assetId)) return;
  const displayName = stringField(data, "displayName");
  const moderationState = stringField(data, "moderation");
  context.recordChange({
    kind: "asset",
    target: `rbxassetid://${assetId}`,
    summary: `Published ${displayName ? `“${displayName}”` : "the animation"} to Roblox as animation ${assetId}.${moderationState ? ` Moderation: ${moderationState}.` : ""}`,
    assetId,
    assetUrl: `https://create.roblox.com/store/asset/${assetId}`,
    assetType: "Animation",
    moderationState,
  });
  const readBack = isRecord(data.readBack) ? data.readBack : {};
  const ownerCheck = stringField(data, "ownerCheck");
  context.recordEvidence({
    kind: "verification",
    changeKind: "asset",
    title: `rbxassetid://${assetId}`,
    passed: readBack.matches === true,
    detail: readBack.matches === true
      ? "Roblox served the published animation back, and it holds the motion that was built and checked."
      : "The published animation could not be confirmed to hold the motion that was built.",
    metadata: [
      ...(ownerCheck ? [{ label: "Owner", value: ownerCheck }] : []),
      { label: "Moderation", value: moderationState ?? "Unknown" },
    ],
  });
}

/** A wired slot, or a model's wired state, as a change to the loader that carries it. */
function recordAnimationWire(context: PlannerContext, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const loader = stringField(data, "loader");
  const slot = stringField(data, "slot");
  const animationId = stringField(data, "animationId");
  if (data.wired !== true || !loader || !slot || !animationId) return;
  const previous = stringField(data, "previousId");
  const model = stringField(data, "model");
  const groundSpeed = numberField(data, "groundSpeed");
  const pace = groundSpeed === undefined ? "" : ` (paced for ${groundSpeed} studs a second)`;
  context.recordChange({
    kind: "instance",
    target: loader,
    instanceId: context.instanceId ?? undefined,
    summary: model
      ? `${data.installed === true ? `Installed the animation loader in ${model} and set its` : `Set ${model}'s`} ${slot} to ${animationId}${pace}${previous ? `, replacing ${previous}` : ""}, in one undoable step.`
      : `${data.installed === true ? "Installed the animation loader and set" : "Set"} the ${slot} slot to ${animationId}${previous ? `, replacing ${previous}` : ""}, in one undoable step.`,
  });
  const matches = data.readBackMatches === true;
  context.recordEvidence({
    kind: "verification",
    changeKind: "instance",
    title: loader,
    passed: matches,
    detail: !matches
      ? `Studio read the loader back, and it does not hold what was wired: its code, or the ${model ? slot : `${slot} slot`}'s ID${model && slot !== "idle" ? " or pace" : ""}, differs.`
      : model
        ? `Studio read the loader back: its code is the fixed loader, and its ${slot} holds the new ID. Every copy of the model plays it.`
        : "Studio read the loader back: its code is the fixed loader, and the slot holds the new ID. Every character spawned from now on gets it.",
    metadata: [{ label: "Undo", value: data.undoable !== false ? "One Studio undo step" : "Not recorded in Studio's undo history" }],
  });
}

/** Items in words: "idle", "idle and walk", "idle, walk and run". */
function inWords(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** A stock NPC made by rig, as a change to the place and the read-back that confirms it. */
function recordAnimationRig(context: PlannerContext, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const model = stringField(data, "model");
  if (data.rigged !== true || !model) return;
  const rigType = stringField(data, "rigType") ?? "stock";
  const feet = Array.isArray(data.feet) && data.feet.length === 3 && data.feet.every((value) => typeof value === "number")
    ? `[${data.feet.join(", ")}]`
    : undefined;
  const states = isRecord(data.states) ? Object.keys(data.states).filter((state) => typeof (data.states as JsonRecord)[state] === "string") : [];
  const missing = Array.isArray(data.missingStates) ? data.missingStates.filter((state): state is string => typeof state === "string") : [];
  const parts = numberField(data, "parts");
  const joints = numberField(data, "joints");
  const height = numberField(data, "height");
  const walkSpeed = numberField(data, "walkSpeed");
  context.recordChange({
    kind: "instance",
    target: model,
    instanceId: context.instanceId ?? undefined,
    summary: `Made a stock ${rigType} NPC at ${model}${feet ? `, its feet at ${feet}` : ""}, with the animation loader in place of its Animate script, in one undoable step.`,
  });
  const matches = data.readBackMatches === true;
  const mismatches = Array.isArray(data.mismatches) ? data.mismatches.filter((reason): reason is string => typeof reason === "string") : [];
  const body = [
    parts === undefined ? undefined : `${parts} parts`,
    joints === undefined ? undefined : `${joints} joints`,
  ].filter((fact): fact is string => fact !== undefined);
  context.recordEvidence({
    kind: "verification",
    changeKind: "instance",
    title: model,
    passed: matches,
    detail: !matches
      ? `Studio read the NPC back, and it is not what was made: ${mismatches.length > 0 ? mismatches.join("; ") : "its rig, its place, its loader or the loader's states differ"}.`
      : `Studio read the NPC back: ${rigType === "R15" || rigType === "R6" ? `an ${rigType}` : "a stock"} body${body.length > 0 ? ` of ${inWords(body)}` : ""}${height === undefined ? "" : `, ${height} studs tall`}${feet ? `, its feet at ${feet}` : ""}, `
        + (states.length > 0 ? `whose loader plays Roblox's default ${inWords(states)}.` : "whose loader holds no animation yet."),
    metadata: [
      { label: "Undo", value: data.undoable !== false ? "One Studio undo step" : "Not recorded in Studio's undo history" },
      ...(walkSpeed === undefined ? [] : [{ label: "WalkSpeed", value: `${walkSpeed} studs a second` }]),
      ...(missing.length > 0 ? [{ label: "No default", value: inWords(missing) }] : []),
    ],
  });
}

/**
 * A creature's rig built or declared by rig: the change to the place, the
 * read-back that confirms it, and its range sheet with its 3D view. A call
 * that only read the rig records the range sheet alone.
 */
async function recordModelRig(context: PlannerContext, outcome: McpToolOutcome): Promise<void> {
  const data = isRecord(outcome.data) ? outcome.data : {};
  const model = stringField(data, "model");
  if (!model || (data.rigged !== true && data.declared !== true && data.declared !== false)) return;
  const rig = isRecord(data.rig) ? data.rig : {};
  const joints = Array.isArray(rig.joints) ? rig.joints.length : undefined;
  const plan = stringField(data, "plan");
  const readBack = isRecord(data.readBack) ? data.readBack : {};
  const mismatches = Array.isArray(readBack.mismatches) ? readBack.mismatches.filter((reason): reason is string => typeof reason === "string") : [];
  const undo = { label: "Undo", value: data.undoable !== false ? "One Studio undo step" : "Not recorded in Studio's undo history" };
  if (data.rigged === true) {
    const controller = stringField(data, "controller") ?? "a controller";
    const removed = Array.isArray(data.removed) ? data.removed.filter((item): item is string => typeof item === "string") : [];
    context.recordChange({
      kind: "instance",
      target: model,
      instanceId: context.instanceId ?? undefined,
      summary: `Rigged ${model}${joints === undefined ? "" : ` with ${joints} joints`} under ${controller === "Humanoid" ? "a Humanoid" : `an ${controller}`}${plan && plan !== "custom" ? ` as a ${plan}` : ""}${removed.length > 0 ? `, taking out ${inWords(removed)}` : ""}, in one undoable step.`,
    });
    context.recordEvidence({
      kind: "verification",
      changeKind: "instance",
      title: model,
      passed: readBack.matches === true,
      detail: readBack.matches === true
        ? `Studio read the rig back as built: ${joints === undefined ? "its joints" : `${joints} joints`}, each at its pivot, and its declarations.`
        : `Studio read the rig back, and it is not what was built: ${mismatches.length > 0 ? mismatches.join("; ") : "its joints, controller or declarations differ"}.`,
      metadata: [undo],
    });
  } else if (data.declared === true) {
    context.recordChange({
      kind: "instance",
      target: model,
      instanceId: context.instanceId ?? undefined,
      summary: `Declared ${model}'s rig${plan && plan !== "custom" ? ` as a ${plan}` : ""} in its RoqerRig attribute, changing none of its joints, in one undoable step.`,
    });
    context.recordEvidence({
      kind: "verification",
      changeKind: "instance",
      title: model,
      passed: readBack.matches === true,
      detail: readBack.matches === true ? "Studio read the declarations back as written." : "Studio read the rig back, and its declarations are not the ones written.",
      metadata: [undo],
    });
  }
  const imageDataUrl = await evidencePreview(context, outcome);
  if (imageDataUrl === undefined) return;
  let modelPreviewId: string | undefined;
  if (outcome.modelFile !== undefined && context.storeModelPreview !== undefined) {
    modelPreviewId = await context.storeModelPreview(outcome.modelFile).catch(() => undefined);
  }
  context.recordEvidence({
    kind: "inspection",
    title: RIG_RANGE_SHEET_TITLE,
    subject: model,
    detail: `${model}'s joints at rest and turned a little each way, to show where each piece turns. No check judged it.`,
    imageDataUrl,
    ...(isModelPreviewId(modelPreviewId) ? { modelPreviewId } : {}),
    metadata: [
      { label: ANIMATION_RIG_LABEL, value: model },
      ...boxesMetadata(data, "rangeSheet"),
      ...(joints === undefined ? [] : [{ label: "Joints", value: String(joints) }]),
    ],
  });
}
/** How many of a phase's judging samples played which of the loader's states. */
function playedTally(played: unknown): string {
  if (!isRecord(played)) return "Nothing sampled";
  const entries = Object.entries(played).filter((entry): entry is [string, number] => typeof entry[1] === "number");
  const total = entries.reduce((sum, [, count]) => sum + count, 0);
  if (total === 0) return "Nothing sampled";
  return entries.sort((a, b) => b[1] - a[1]).map(([state, count]) => `${state} ${Math.round((count / total) * 100)}%`).join(", ");
}

/**
 * A model's playtest verification as evidence: what its loader played while it
 * moved and while it stood, at what pace, and how a checked animation played on it.
 */
function recordModelVerify(context: PlannerContext, args: JsonRecord, data: JsonRecord): void {
  const model = stringField(data, "model") ?? String(args.model);
  const played = isRecord(data.played) ? data.played : undefined;
  const wiring = isRecord(data.wiring) ? data.wiring : undefined;
  const movement = isRecord(data.movement) ? data.movement : undefined;
  const pace = movement && isRecord(movement.pace) ? movement.pace : undefined;
  const name = isRecord(args.animation) && typeof args.animation.name === "string" ? args.animation.name : undefined;
  const reasons = [
    ...(played && played.verified !== true ? [stringField(played, "reason") ?? "the animation did not play as checked"] : []),
    ...(wiring && wiring.matches !== true ? [`its ${String(wiring.slot)} does not hold the wired ID`] : []),
    ...(movement && movement.verified !== true ? [stringField(movement, "reason") ?? "its loader did not play as it moved and stood"] : []),
  ];
  // What most of each phase's samples played, as the judge counted them.
  const mostPlayed = (phase: unknown) => {
    const tally = isRecord(phase) && isRecord(phase.played) ? Object.entries(phase.played) : [];
    const [top] = tally.filter((entry): entry is [string, number] => typeof entry[1] === "number").sort((a, b) => b[1] - a[1]);
    return top?.[0];
  };
  const moving = movement ? mostPlayed(movement.moving) : undefined;
  const standing = movement ? mostPlayed(movement.standing) : undefined;
  const facts = [
    ...(movement && moving
      ? [`its loader played its ${moving} while it moved, and ${standing === undefined || standing === "nothing" ? "nothing while it stood, leaving its rest pose" : `its ${standing} while it stood`}`]
      : []),
    ...(played ? [`${name ?? "the animation"} played on it as checked`] : []),
    ...(wiring ? [`its ${String(wiring.slot)} holds ${String(wiring.animationId)}${played ? "" : ", though how it plays was not compared"}`] : []),
  ];
  context.recordEvidence({
    kind: "playtest",
    title: `${model} in the playtest`,
    passed: data.verified === true,
    detail: data.verified === true
      ? `On the playtest server, ${facts.join(", and ")}.`
      : `Not verified: ${reasons.join("; ") || "the playtest did not show what was asked"}.`,
    metadata: [
      ...(movement ? [{ label: MODEL_MOVED_BY_LABEL, value: movement.mode === "watched" ? MODEL_MOVED_BY_GAME : MODEL_MOVED_BY_VERIFY }] : []),
      ...(movement && isRecord(movement.moving) ? [{ label: MODEL_WHILE_MOVING_LABEL, value: playedTally(movement.moving.played) }] : []),
      ...(movement && isRecord(movement.standing) ? [{ label: MODEL_WHILE_STANDING_LABEL, value: playedTally(movement.standing.played) }] : []),
      ...(pace ? [{
        label: "Pace",
        value: `${String(pace.state)} at ${String(pace.played)}× for ${String(pace.averageSpeed)} studs a second; written for ${String(pace.groundSpeed)}`,
      }] : []),
      ...(played ? [{ label: ANIMATION_PLAYED_FROM_LABEL, value: played.source === "published" ? ANIMATION_PLAYED_PUBLISHED : "A temporary clip" }] : []),
      ...(wiring ? [{ label: modelStateLabel(String(wiring.slot)), value: wiring.matches === true ? MODEL_STATE_WIRED : "Not wired" }] : []),
    ],
  });
}

/** A playtest verification as evidence: the animation played on the character as checked. */
function recordAnimationVerify(context: PlannerContext, args: JsonRecord, outcome: McpToolOutcome): void {
  const data = isRecord(outcome.data) ? outcome.data : {};
  if (typeof data.verified !== "boolean") return;
  if (typeof args.model === "string" && args.model !== "") {
    recordModelVerify(context, args, data);
    return;
  }
  const played = isRecord(data.played) ? data.played : {};
  const wiring = isRecord(data.wiring) ? data.wiring : undefined;
  const name = isRecord(args.animation) && typeof args.animation.name === "string" ? args.animation.name : "The animation";
  const maxDegrees = numberField(played, "maxDegrees");
  context.recordEvidence({
    kind: "playtest",
    title: `${name} on the playtest character`,
    passed: data.verified,
    detail: data.verified
      ? `It played on the character${wiring ? ", and its Animate slot holds the wired ID" : ""}, matching the checked motion.`
      : stringField(played, "reason") ?? (wiring && wiring.matches !== true ? "The character's Animate slot does not hold the wired ID." : "It did not play as checked."),
    metadata: [
      { label: ANIMATION_PLAYED_FROM_LABEL, value: played.source === "published" ? ANIMATION_PLAYED_PUBLISHED : "A temporary clip" },
      ...(maxDegrees === undefined ? [] : [{ label: "Largest difference", value: `${maxDegrees}°` }]),
      ...(wiring ? [{ label: animationSlotLabel(String(wiring.slot)), value: wiring.matches === true ? (wiring.playingNow === true ? "Wired, and playing now" : "Wired") : "Not wired" }] : []),
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
  return uploadChange({ assetId, displayName, assetType, moderationState, operationId });
}

/**
 * The completed uploads of an `upload_assets` call, one result card each, as
 * if each file had been sent alone. Only a file Roblox finished is a card,
 * exactly as for a single upload.
 */
function completedBatchUploads(outcome: McpToolOutcome): Array<Omit<RunChange, "id" | "taskId">> {
  const uploads = isRecord(outcome.data) && Array.isArray(outcome.data.uploads) ? outcome.data.uploads : [];
  return uploads.flatMap((upload) => {
    if (!isRecord(upload) || upload.status !== "complete") return [];
    const assetId = stringField(upload, "assetId");
    if (!assetId || !/^\d+$/.test(assetId)) return [];
    return [uploadChange({
      assetId,
      displayName: stringField(upload, "displayName"),
      assetType: stringField(upload, "assetType"),
      moderationState: stringField(upload, "moderationState"),
      operationId: stringField(upload, "operationId"),
    })];
  });
}

function uploadChange(upload: {
  assetId: string;
  displayName?: string;
  assetType?: string;
  moderationState?: string;
  operationId?: string;
}): Omit<RunChange, "id" | "taskId"> {
  const { assetId, displayName, assetType, moderationState, operationId } = upload;
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

const PLAYTEST_OPERATIONS = new Set(["solo_playtest", "multiplayer_playtest"]);

/**
 * A playtest start that waited out its timeout. The server says so only in
 * prose, under an error code that is whatever the bridge passed on, so it is
 * matched on the message; "did not answer within" is the client giving up on
 * the call itself.
 */
const PLAYTEST_START_TIMEOUT = /before timeout|did not answer within/i;

/**
 * A playtest start Studio refused outright, matched on the result's `error`.
 * The plugin now says so at once, with Studio's reason, where the start used
 * to be answered as begun and left to time out; it is the same wedge, so it
 * counts toward the same limit.
 */
const PLAYTEST_START_REFUSED = /did not start the playtest/i;

/**
 * Start timeouts or refusals in a row after which a run sends no more starts.
 *
 * Once Studio refuses a start, it refuses every start after it, each one
 * waiting out its timeout: one missile run sent five, about eight minutes and
 * ten model calls with the status checks between them, though the
 * instructions already said to try once more at most.
 */
const MAX_PLAYTEST_START_TIMEOUTS = 2;

const PLAYTEST_RECOVERY = "Ask the user to press Play and then Stop once in Studio (that cleared it in the runs studied), or finish in the edit viewport and say runtime verification is pending.";

/** Where `set_script_source {template}` is read from: Roqer's own skill pack. */
export type TemplateLibrary = Pick<SkillLibrary, "load">;

export type StudioToolRunnerOptions = Readonly<{
  /** Without it, a template write is refused and the model sends source instead. */
  templates?: TemplateLibrary;
}>;

const TEMPLATE_EXAMPLE = "roblox-animation-vfx/templates/vfx/emit.lua";

/** `<skill>/templates/<path>.lua`, split into the skill and its resource. */
function templatePath(value: string): { name: string; resource: string } | undefined {
  const [name, ...rest] = value.split("/");
  const resource = rest.join("/");
  if (!name || rest[0] !== "templates" || !resource.toLowerCase().endsWith(".lua")) return undefined;
  return { name, resource };
}

/** An optional argument the model filled with nothing, which some models send rather than leaving it out. */
const omitted = (value: unknown): boolean => value === undefined || value === null || value === "";

/** A write made ready to send, with what to tell the model about it; or the answer that ends it here. */
type PreparedWrite = { args: JsonRecord; note?: string } | { result: StudioToolResult };

/**
 * Run one Studio operation through the engine and record what it proves.
 *
 * The returned function is stateful on purpose: verifying a write means
 * comparing the revision a mutation reported against the revision the
 * follow-up read returns, so the reads and writes of a single run have to be
 * remembered together.
 */
export function createStudioToolRunner(context: PlannerContext, options: StudioToolRunnerOptions = {}): StudioToolRunner {
  const scriptReads = new Map<string, ScriptSnapshot>();
  const changedScripts = new Map<string, string | undefined>();
  const recordedAssetIds = new Set<string>();
  const blenderLineage = new BlenderLineage();
  // Whether a playtest this runner started is still running. Only this run's
  // own start and stop calls move it, so a playtest someone else started is
  // never claimed.
  let playtestRunning = false;
  // Playtest starts in a row that timed out or that Studio refused, and how
  // many questions the user had answered when they reached the limit: an
  // answer since then is how the user says they cleared it, so a start is
  // allowed again.
  let startTimeouts = 0;
  let decisionsAtLimit = 0;

  /** What a timed-out or refused start is answered with: Studio's own status, read for the model, and what to do next. */
  const afterStartTimeout = async (operation: string, failed: "timed out" | "was refused"): Promise<string> => {
    const status = await context.call(operation, { action: "status" }).catch(() => undefined);
    const data = status?.ok === true && isRecord(status.data) ? status.data : undefined;
    const roles = Array.isArray(data?.roles) ? data.roles.filter((role): role is string => typeof role === "string") : [];
    const seen = data === undefined
      ? "Roqer could not read the playtest's status afterwards."
      : data.running === true
        ? `Roqer read the playtest's status afterwards: it is running now (${roles.join(", ")}), so use it rather than starting another.`
        : `Roqer read the playtest's status afterwards: it is not running${roles.length > 0 ? ` (peers: ${roles.join(", ")})` : ""}.`;
    if (startTimeouts < MAX_PLAYTEST_START_TIMEOUTS) {
      return `${seen} A start that ${failed} may be tried once more; if that one fails too, Roqer sends no more starts in this run.`;
    }
    return `${seen} That is the second start in a row that failed (this one ${failed}), so Roqer will not send another. ${PLAYTEST_RECOVERY}`;
  };

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

  /**
   * A full-source write made ready to send: a template read into its source,
   * and an empty script's revision supplied.
   *
   * Both are resolved here, before anything else sees the call, so the
   * approval, the diff card, the run record and Studio all get the source that
   * is actually written and a revision that was actually read. A script with
   * anything in it still needs the revision the model read: only a script with
   * nothing to lose is written against the revision Roqer read itself, and
   * Studio still refuses the write if it changed in between.
   */
  const prepareSourceWrite = async (args: JsonRecord): Promise<PreparedWrite> => {
    const refuse = (reason: string): PreparedWrite => ({ result: { ok: false, text: `set_script_source was not called: ${reason}` } });
    let prepared = args;
    let note: string | undefined;
    let templateSource: string | undefined;
    const template = args.template;
    if (!omitted(template)) {
      if (typeof template !== "string") return refuse(`template must be a skill template path, such as ${TEMPLATE_EXAMPLE}.`);
      if (!omitted(args.source)) return refuse("pass source or template, not both.");
      const path = templatePath(template);
      if (path === undefined) return refuse(`template must name a Lua file in a skill's templates folder, such as ${TEMPLATE_EXAMPLE}.`);
      if (options.templates === undefined) return refuse("skill templates are not available in this run; send the source instead.");
      try {
        templateSource = normalizeNewlines((await options.templates.load(path.name, path.resource)).content);
      } catch (error) {
        return refuse(`${template} could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      prepared = { ...args, source: templateSource };
      delete prepared.template;
      note = `Roqer wrote ${template} (${countLines(templateSource)} lines) as this script's source. It has not changed, so there is no need to read it.`;
    } else if (typeof args.source !== "string") {
      return refuse(`source is required: the script's whole new text, or template for a skill template such as ${TEMPLATE_EXAMPLE}.`);
    }

    const target = typeof prepared.instancePath === "string" ? prepared.instancePath : undefined;
    if (target === undefined || !omitted(prepared.expectedRevision)) return { args: prepared, ...(note === undefined ? {} : { note }) };
    const read = await readWholeScript(target);
    if (!read.ok) {
      const reason = boundedVerificationReason(read.message || read.text || read.errorCode || "Studio did not return the script");
      return refuse(`expectedRevision was omitted, and Roqer could not read ${target} to check that it is empty: ${reason}`);
    }
    const snapshot = snapshotFromOutcome(read);
    if (snapshot.source !== undefined) scriptReads.set(target, snapshot);
    if (templateSource !== undefined && snapshot.complete === true && snapshot.source === templateSource) {
      return { result: { ok: true, text: `${target} already holds ${String(template)} exactly, so nothing was written.` } };
    }
    if (snapshot.complete !== true || snapshot.source?.trim() !== "" || snapshot.revision === undefined) {
      const how = templateSource === undefined ? "" : " (for a template, line_range \"1\" is enough)";
      return refuse(`${target} is not empty, so expectedRevision is required: read it with get_script_source${how} and pass that revision.`);
    }
    return { args: { ...prepared, expectedRevision: snapshot.revision }, ...(note === undefined ? {} : { note }) };
  };

  const runOperation = async (operation: string, args: JsonRecord): Promise<StudioToolResult> => {
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

    // Refused here once starts have kept timing out, for the same reason as a
    // malformed call: the answer is already known, and sending it again only
    // spends another timeout and another model call finding that out.
    const playtestStart = PLAYTEST_OPERATIONS.has(operation) && args.action === "start";
    if (playtestStart && startTimeouts >= MAX_PLAYTEST_START_TIMEOUTS) {
      if (context.decisions().length <= decisionsAtLimit) {
        return {
          ok: false,
          text: `${operation} was not started: ${startTimeouts} starts in a row timed out or were refused in this run, and another would only fail the same way. ${PLAYTEST_RECOVERY} If you ask the user with ask_user and they say it is cleared, a start is allowed again.`,
        };
      }
      startTimeouts = 0;
    }

    const target = typeof args.instancePath === "string" ? args.instancePath : undefined;
    if (target && SCRIPT_MUTATIONS.has(operation)) await widenSourceContext(target);

    // No status line here: the activity layer already shows the call itself,
    // and a second entry saying the same thing is noise, not progress.
    const outcome = await context.call(operation, args);
    let modelNote: string | undefined;

    if (outcome.ok && PLAYTEST_OPERATIONS.has(operation)) {
      if (args.action === "start") playtestRunning = true;
      else if (args.action === "stop" || args.action === "end") playtestRunning = false;
    }
    if (playtestStart) {
      const reason = outcome.message || stringField(outcome.data, "message") || outcome.text;
      const failed = outcome.ok
        ? undefined
        : PLAYTEST_START_TIMEOUT.test(reason)
          ? "timed out"
          : PLAYTEST_START_REFUSED.test(stringField(outcome.data, "error") ?? "") ? "was refused" : undefined;
      if (outcome.ok) {
        startTimeouts = 0;
      } else if (failed !== undefined) {
        startTimeouts += 1;
        if (startTimeouts >= MAX_PLAYTEST_START_TIMEOUTS) decisionsAtLimit = context.decisions().length;
        modelNote = await afterStartTimeout(operation, failed);
      }
    }
    const observed = observationEvidence(operation, args, outcome, playtestRunning);
    const preview = observed !== undefined || operation === BLENDER_OPERATION
      ? await evidencePreview(context, outcome)
      : undefined;
    const subject = outcome.ok && operation === BLENDER_OPERATION ? blenderLineage.follow(outcome) : undefined;
    const observation = observed !== undefined
      ? { ...observed, ...(preview === undefined ? {} : { imageDataUrl: preview }) }
      : preview !== undefined
        ? { ...BLENDER_PREVIEW_EVIDENCE, ...blenderModelFacts(outcome), ...(subject === undefined ? {} : { subject }), imageDataUrl: preview }
        : undefined;
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

    if (outcome.ok && !refused && operation === "animation") {
      if (args.action === "check" || args.action === "build") await recordAnimationPreview(context, outcome);
      if (args.action === "build") recordAnimationBuild(context, args, outcome);
      else if (args.action === "publish") recordAnimationPublish(context, outcome);
      else if (args.action === "wire") recordAnimationWire(context, outcome);
      else if (args.action === "verify") recordAnimationVerify(context, args, outcome);
      else if (args.action === "rig" && args.stock !== undefined) recordAnimationRig(context, outcome);
      else if (args.action === "rig") await recordModelRig(context, outcome);
    }

    if (operation === "upload_asset") {
      const upload = completedUpload(args, outcome);
      if (upload?.assetId && !recordedAssetIds.has(upload.assetId)) {
        recordedAssetIds.add(upload.assetId);
        context.recordChange(upload);
      }
    }

    // Read whether or not every file went up: the ones that did are on Roblox.
    if (operation === UPLOAD_ASSETS_OPERATION) {
      for (const upload of completedBatchUploads(outcome)) {
        if (!upload.assetId || recordedAssetIds.has(upload.assetId)) continue;
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

  return async function runStudioTool(operation, args) {
    if (operation !== "set_script_source" || args.help === true) return runOperation(operation, args);
    const prepared = await prepareSourceWrite(args);
    if ("result" in prepared) return prepared.result;
    const result = await runOperation(operation, prepared.args);
    return result.ok && prepared.note !== undefined
      ? { ...result, text: appendModelNote(result.text, prepared.note) }
      : result;
  };
}
