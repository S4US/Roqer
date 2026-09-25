import { TOOL_RISK, isKnownTool } from "./mcp-tools";
import type { RunEvidence } from "./run-events";

/**
 * The vocabulary of the activity layer.
 *
 * A conversation shows two layers: the answer, and how it was reached. This
 * module owns the second one's words. A reader scanning what the agent did
 * should see a handful of verbs — searching, reading, editing, running,
 * verifying — not forty MCP operation names, so every tool is classified into
 * one of them here and nothing downstream invents its own phrasing.
 *
 * `activity.test.ts` fails if a tool in `TOOL_RISK` has no classification, so
 * a new MCP operation cannot quietly fall back to a generic label.
 */

/** What a tool call does, from the reader's point of view. */
export type ToolActivityKind = "search" | "read" | "edit" | "run";

/** Every entry the activity layer can show, including non-tool entries. */
export type ActivityKind = ToolActivityKind | "verify" | "inspect" | "note";

/**
 * The stage of the run a step belongs to.
 *
 * Phases are what the activity layer groups by: a run that reads eight places in
 * the project is one thing happening, not eight, and the reader should be able
 * to see that as one line and open it when they want the eight. Deriving the
 * phase from the kind means a tool added to `KIND_BY_TOOL` tomorrow lands in a
 * sensible group without touching this file again.
 */
export type ActivityPhase =
  | "connect" | "explore" | "scripts" | "edit" | "run" | "verify" | "note";

const KIND_BY_TOOL: Readonly<Record<string, ToolActivityKind>> = {
  // -- Looking for something ---------------------------------------------
  search_objects: "search",
  search_assets: "search",
  grep_scripts: "search",

  // -- Reading state -----------------------------------------------------
  get_place_info: "read",
  get_instance_properties: "read",
  get_project_structure: "read",
  get_script_source: "read",
  get_attributes: "read",
  selection: "read",
  get_simulation_state: "read",
  get_device_simulator_state: "read",
  get_runtime_logs: "read",
  capture_script_profiler: "read",
  capture_micro_profiler: "read",
  get_connected_instances: "read",
  get_asset_details: "read",
  get_asset_thumbnail: "read",
  preview_asset: "read",
  capture_screenshot: "read",
  inspect_ui: "read",
  get_memory_breakdown: "read",
  get_scene_analysis: "read",
  get_roblox_skills: "read",
  get_roblox_docs: "read",

  // -- Changing the project ----------------------------------------------
  set_properties: "edit",
  build_instances: "edit",
  set_script_source: "edit",
  edit_script_lines: "edit",
  edit_script_batch: "edit",
  insert_script_lines: "edit",
  delete_script_lines: "edit",
  find_and_replace_in_scripts: "edit",
  insert_asset: "edit",
  import_rbxm: "edit",
  export_rbxm: "edit",
  upload_asset: "edit",
  generate_model: "edit",
  breakpoints: "edit",

  // -- Making something happen -------------------------------------------
  solo_playtest: "run",
  multiplayer_playtest: "run",
  execute_luau: "run",
  eval_server_runtime: "run",
  eval_client_runtime: "run",
  manage_instance: "run",
  set_network_profile: "run",
  reset_simulation_state: "run",
  set_device_simulator: "run",
  capture_device_matrix: "run",
  interact_ui: "run",
  simulate_mouse_input: "run",
  simulate_keyboard_input: "run",
  // Roqer's own local operation, not a Studio tool.
  run_blender_script: "run",
};

/**
 * How a tool call reads. An unclassified tool is treated as "run" — the same
 * conservative direction `riskForTool` takes, so an operation this table has
 * not caught up with is never described as a harmless read.
 */
export function activityKind(tool: string, target: string | null = null): ToolActivityKind {
  if (tool === "upload_asset" && target === "status") return "read";
  return Object.prototype.hasOwnProperty.call(KIND_BY_TOOL, tool) ? KIND_BY_TOOL[tool] : "run";
}

/** Tools this table classifies. Exported so the drift test can compare sets. */
export function classifiedTools(): string[] {
  return Object.keys(KIND_BY_TOOL);
}

/**
 * Reads that are about something other than the project itself, so they do not
 * fall into the same group as walking the tree. Everything else takes the phase
 * its kind implies.
 */
const PHASE_BY_TOOL: Readonly<Record<string, ActivityPhase>> = {
  get_connected_instances: "connect",
  get_place_info: "connect",
  get_script_source: "scripts",
  grep_scripts: "scripts",
  get_runtime_logs: "verify",
  capture_screenshot: "verify",
};

const PHASE_BY_KIND: Readonly<Record<ActivityKind, ActivityPhase>> = {
  search: "explore",
  read: "explore",
  inspect: "explore",
  edit: "edit",
  run: "run",
  verify: "verify",
  note: "note",
};

/** Which stage of the run a tool call belongs to. */
export function activityPhase(tool: string, target: string | null = null): ActivityPhase {
  return Object.prototype.hasOwnProperty.call(PHASE_BY_TOOL, tool)
    ? PHASE_BY_TOOL[tool]
    : PHASE_BY_KIND[activityKind(tool, target)];
}

/** Which stage a piece of evidence belongs to. */
export function evidencePhase(kind: RunEvidence["kind"]): ActivityPhase {
  return PHASE_BY_KIND[evidenceActivityKind(kind)];
}

/**
 * What a whole phase is called once its steps are folded into one line. The
 * present tense is used while the phase is still running, so a group reads as
 * an activity in progress rather than a finished claim.
 */
const PHASE_TITLE: Readonly<Record<ActivityPhase, { present: string; past: string }>> = {
  connect: { present: "Connecting to Studio", past: "Connected to Studio" },
  explore: { present: "Understanding the project", past: "Understood the project" },
  scripts: { present: "Inspecting scripts", past: "Inspected scripts" },
  edit: { present: "Applying changes", past: "Applied changes" },
  run: { present: "Running in Studio", past: "Ran in Studio" },
  verify: { present: "Checking the result", past: "Checked the result" },
  // A run of progress notes is titled by its latest note, never by this.
  note: { present: "Working", past: "Worked" },
};

export function phaseTitle(phase: ActivityPhase, past: boolean): string {
  return past ? PHASE_TITLE[phase].past : PHASE_TITLE[phase].present;
}

/**
 * An instance path as a reader refers to it. Every path in a place begins at
 * `game`, so the prefix distinguishes nothing and costs the width that the rest
 * of the path needs. The full path stays in the step's details.
 */
export function shortTarget(target: string): string {
  return target.startsWith("game.") && target.length > 5 ? target.slice(5) : target;
}

/** Longest finding shown on a row; anything longer belongs in the details. */
export const MAX_FINDING_CHARS = 48;

/**
 * What a finished call actually learned, out of the summary the host produced.
 *
 * Host summaries lead with the operation name and fall back to compacted JSON
 * when a payload has no recognised shape. Neither belongs on the primary row —
 * "16 instances" is the finding, `get_project_structure: {"tree":…}` is debug
 * output — so a summary that is still raw returns null and stays in details.
 */
export function activityFinding(tool: string, summary: string | undefined): string | null {
  if (summary === undefined) return null;
  let text = summary.trim();
  if (text.startsWith(`${tool}: `)) text = text.slice(tool.length + 2).trim();
  else if (text.startsWith(`${tool} `)) text = text.slice(tool.length + 1).trim();

  if (text.startsWith("failed (")) {
    const separator = text.indexOf("): ");
    text = separator === -1 ? text : text.slice(separator + 3).trim();
  }

  if (text === "" || text === "succeeded") return null;
  // Compacted JSON is the raw payload, not a finding anyone can read.
  if (/[{}[\]]/.test(text)) return null;
  return text.length > MAX_FINDING_CHARS ? `${text.slice(0, MAX_FINDING_CHARS - 1).trimEnd()}…` : text;
}

const PRESENT: Readonly<Record<ActivityKind, string>> = {
  search: "Searching",
  read: "Reading",
  edit: "Editing",
  run: "Running",
  verify: "Verifying",
  inspect: "Inspecting",
  note: "",
};

const PAST: Readonly<Record<ActivityKind, string>> = {
  search: "Searched",
  read: "Read",
  edit: "Edited",
  run: "Ran",
  verify: "Verified",
  inspect: "Inspected",
  note: "",
};

/**
 * What a call with no identifying argument is about. Without this, a call like
 * `get_place_info` would have to render as its own operation name, which is
 * exactly the internal detail the activity layer exists to keep out of sight.
 */
const TOOL_PHRASE: Readonly<Record<string, string>> = {
  get_connected_instances: "the connected Studio instances",
  get_place_info: "the place",
  get_project_structure: "the project structure",
  get_script_source: "the script source",
  get_instance_properties: "instance properties",
  get_attributes: "attributes",
  get_runtime_logs: "the runtime logs",
  get_scene_analysis: "the scene",
  get_memory_breakdown: "the memory breakdown",
  selection: "the current selection",
  search_objects: "the project",
  search_assets: "the asset library",
  grep_scripts: "the scripts",
  capture_screenshot: "a screenshot",
  inspect_ui: "the interface",
  solo_playtest: "a solo playtest",
  multiplayer_playtest: "a multiplayer playtest",
  execute_luau: "Luau in Studio",
  set_properties: "properties",
  build_instances: "instances",
  set_script_source: "the script source",
  edit_script_lines: "script lines",
  edit_script_batch: "several parts of the script",
  insert_script_lines: "script lines",
  delete_script_lines: "script lines",
  find_and_replace_in_scripts: "across the scripts",
  upload_asset: "an asset",
};

function toolPhrase(tool: string): string {
  return Object.prototype.hasOwnProperty.call(TOOL_PHRASE, tool) ? TOOL_PHRASE[tool] : tool;
}

/**
 * The identifying argument out of a call summary, or null when the call had
 * none. `summarizeToolCall` builds summaries as `"<tool> · <value>"`, so the
 * value is recoverable without threading a second field through the event
 * schema — and a summary in any other shape simply has no target.
 */
export function activityTarget(tool: string, summary: string): string | null {
  const prefix = `${tool} · `;
  if (!summary.startsWith(prefix)) return null;
  const value = summary.slice(prefix.length);
  return value === "" ? null : value;
}

/** One line of activity: a verb and what it acted on. */
export function activityLabel(tool: string, target: string | null, past: boolean): string {
  const kind = activityKind(tool, target);
  const verb = past ? PAST[kind] : PRESENT[kind];
  if (tool === "upload_asset" && target === "status") return `${verb} upload status`;
  if (tool === "upload_asset" && target === "upload") return past ? "Uploaded an asset" : "Uploading an asset";
  if (tool === "run_blender_script") return past ? "Modeled in Blender" : "Modeling in Blender";
  if (target === null) return `${verb} ${toolPhrase(tool)}`;
  if (kind === "search") {
    // A search's identifying argument is a query, not a path: unquoted it reads
    // as a place, and a query with nothing to read in it ("." , "*") says less
    // than naming what was searched.
    const query = target.trim();
    return /[\p{L}\p{N}]/u.test(query) ? `${verb} for “${query}”` : `${verb} ${toolPhrase(tool)}`;
  }
  return `${verb} ${shortTarget(target)}`;
}

const EVIDENCE_KIND: Readonly<Record<RunEvidence["kind"], ActivityKind>> = {
  inspection: "inspect",
  verification: "verify",
  playtest: "run",
  screenshot: "read",
  logs: "read",
  interaction: "run",
};

const EVIDENCE_VERB: Readonly<Record<RunEvidence["kind"], string>> = {
  inspection: "Inspected",
  verification: "Verified",
  playtest: "Playtested",
  screenshot: "Captured",
  logs: "Collected logs from",
  interaction: "Interacted with",
};

export function evidenceActivityKind(kind: RunEvidence["kind"]): ActivityKind {
  return EVIDENCE_KIND[kind];
}

export function evidenceLabel(evidence: RunEvidence): string {
  return `${EVIDENCE_VERB[evidence.kind]} ${shortTarget(evidence.title)}`;
}

/** Heading for the disclosure that holds an evidence entry's payload. */
export function evidenceDetailLabel(kind: RunEvidence["kind"]): string {
  switch (kind) {
    case "verification":
      return "Read-back";
    case "playtest":
      return "Playtest detail";
    case "screenshot":
      return "Screenshot";
    case "logs":
      return "Logs";
    case "inspection":
      return "What was found";
    case "interaction":
      return "Interaction detail";
  }
}

/** Whether every tool the risk table knows about has a classification. */
export function unclassifiedTools(): string[] {
  return Object.keys(TOOL_RISK).filter(
    (tool) => isKnownTool(tool) && !Object.prototype.hasOwnProperty.call(KIND_BY_TOOL, tool),
  );
}
