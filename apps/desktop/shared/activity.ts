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
  // Roqer's own operation: frames of a clip the user attached to the chat.
  read_reference_clip: "read",
  // Roqer's own operation: a page at a link the user gave.
  open_user_link: "read",

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
  // Roqer's own operation: several upload_asset calls in one.
  upload_assets: "edit",
  animation: "edit",
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
  // Roqer's own operations, not Studio tools.
  run_blender_script: "run",
  generate_image: "run",
  capture_moments: "run",
  // A call to one of the user's MCP servers is left out: what it does is the
  // server's, so it reads as "run", the conservative default.
  list_mcp_tools: "read",
  list_uploads: "read",
};

/**
 * How a tool call reads. An unclassified tool is treated as "run" — the same
 * conservative direction `riskForTool` takes, so an operation this table has
 * not caught up with is never described as a harmless read.
 */
export function activityKind(tool: string, target: string | null = null): ToolActivityKind {
  if (tool === "upload_asset" && target === "status") return "read";
  // An animation summary starts with its action; checking reads nothing but writes nothing either.
  if (tool === "animation" && target?.startsWith("check ")) return "read";
  if (tool === "animation" && target?.startsWith("verify ")) return "run";
  return Object.prototype.hasOwnProperty.call(KIND_BY_TOOL, tool) ? KIND_BY_TOOL[tool] : "run";
}

/** Tools this table classifies. Exported so the drift test can compare sets. */
export function classifiedTools(): string[] {
  return Object.keys(KIND_BY_TOOL);
}

/**
 * An instance path as a reader refers to it: its name and what holds it. A row
 * cuts a long title off at its end, which for a path is the part that names the
 * thing, and `game` at the start distinguishes nothing. The full path stays in
 * the step's details.
 */
export function shortTarget(target: string): string {
  if (!target.startsWith("game.") || target.length <= 5) return target;
  return target.slice(5).split(".").slice(-2).join(".");
}

/** Longest finding shown on a row; anything longer belongs in the details. */
export const MAX_FINDING_CHARS = 48;
/** A failure's reason is the one finding worth room: it wraps, and the rest is in the details. */
export const MAX_FAILURE_CHARS = 180;

/** "1 results" is how the host counts; a row says it properly. */
function singularCount(text: string): string {
  const match = /^1 (\w+)$/.exec(text);
  if (match === null) return text;
  const noun = match[1];
  return `1 ${noun.endsWith("ies") ? `${noun.slice(0, -3)}y` : noun.endsWith("s") ? noun.slice(0, -1) : noun}`;
}

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

  let failure = false;
  if (text.startsWith("failed (")) {
    const separator = text.indexOf("): ");
    text = separator === -1 ? text : text.slice(separator + 3).trim();
    failure = true;
  }
  // A failure reads by its reason: not the operation that raised it, and not
  // where in the plugin's source it was raised.
  const raised = /^[\w-]+ failed(?: \([^)]*\))?: /.exec(text);
  if (raised !== null) { text = text.slice(raised[0].length); failure = true; }
  text = text.replace(/^[\w./-]*\.[\w./-]+:\d+: /, "").trim();

  if (text === "" || text === "succeeded") return null;
  // Compacted JSON is the raw payload, not a finding anyone can read.
  if (/[{}[\]]/.test(text)) return null;
  const limit = failure ? MAX_FAILURE_CHARS : MAX_FINDING_CHARS;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : singularCount(text);
}

/**
 * Calls whose kind's verb would misdescribe them: what they do, in both tenses.
 * "Ran eval_client_runtime" says nothing, and "Edited insert_asset" says less.
 */
const TOOL_ACTION: Readonly<Record<string, readonly [present: string, past: string]>> = {
  eval_client_runtime: ["Running code on the client", "Ran code on the client"],
  eval_server_runtime: ["Running code on the server", "Ran code on the server"],
  capture_screenshot: ["Taking a screenshot", "Took a screenshot"],
  insert_asset: ["Inserting an asset", "Inserted an asset"],
  import_rbxm: ["Importing a model file", "Imported a model file"],
  export_rbxm: ["Exporting a model file", "Exported a model file"],
  generate_model: ["Generating a model", "Generated a model"],
  manage_instance: ["Changing an instance", "Changed an instance"],
  set_network_profile: ["Setting the network profile", "Set the network profile"],
  reset_simulation_state: ["Resetting the simulation", "Reset the simulation"],
  set_device_simulator: ["Setting the device simulator", "Set the device simulator"],
  capture_device_matrix: ["Capturing device screenshots", "Captured device screenshots"],
  interact_ui: ["Using the interface", "Used the interface"],
  simulate_mouse_input: ["Using the mouse", "Used the mouse"],
  simulate_keyboard_input: ["Pressing a key", "Pressed a key"],
};

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
  get_simulation_state: "the simulation state",
  get_device_simulator_state: "the device simulator state",
  capture_script_profiler: "the script profiler",
  capture_micro_profiler: "the micro profiler",
  get_asset_details: "an asset's details",
  get_asset_thumbnail: "an asset's thumbnail",
  preview_asset: "an asset preview",
  get_roblox_skills: "the Roblox guides",
  get_roblox_docs: "the Roblox docs",
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
  animation: "an animation",
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
  if (Object.prototype.hasOwnProperty.call(TOOL_ACTION, tool)) return TOOL_ACTION[tool][past ? 1 : 0];
  if ((tool === "solo_playtest" || tool === "multiplayer_playtest") && target === "start") return past ? "Started a playtest" : "Starting a playtest";
  if ((tool === "solo_playtest" || tool === "multiplayer_playtest") && target === "stop") return past ? "Stopped the playtest" : "Stopping the playtest";
  if (tool === "get_runtime_logs" && target !== null) return past ? `Read output from ${target}` : `Reading output from ${target}`;
  // With a path, this is pointing Studio's camera at something, which reads nothing.
  if (tool === "selection" && target === "get") return past ? "Read your selection" : "Reading your selection";
  if (tool === "selection" && target !== null && target.startsWith("game.")) return past ? `Framed ${shortTarget(target)} in Studio` : `Framing ${shortTarget(target)} in Studio`;
  if (tool === "upload_asset" && target === "status") return `${verb} upload status`;
  if (tool === "upload_asset" && target === "upload") return past ? "Uploaded an asset" : "Uploading an asset";
  if (tool === "upload_assets") return past ? "Uploaded assets" : "Uploading assets";
  if (tool === "list_uploads") return past ? "Listed earlier uploads" : "Listing earlier uploads";
  if (tool === "run_blender_script") return past ? "Modeled in Blender" : "Modeling in Blender";
  if (tool === "generate_image") return past ? "Generated images" : "Generating images";
  if (tool === "capture_moments") return past ? "Captured an effect at several moments" : "Capturing an effect at several moments";
  if (tool === "read_reference_clip") return past ? "Looked closer at the reference clip" : "Looking closer at the reference clip";
  if (tool === "list_mcp_tools") {
    const where = target === null ? "your MCP servers" : target.split("/")[0];
    return past ? `Listed tools on ${where}` : `Listing tools on ${where}`;
  }
  if (tool === "open_user_link") return past ? `Read ${target ?? "a link you gave"}` : `Reading ${target ?? "a link you gave"}`;
  if (tool === "download_mcp_file") return past ? "Downloaded a file an MCP server made" : "Downloading a file an MCP server made";
  if (tool === "call_mcp_tool") {
    if (target === null) return past ? "Used an MCP tool" : "Using an MCP tool";
    return past ? `Used ${target}` : `Using ${target}`;
  }
  if (tool === "animation") {
    if (target?.startsWith("build ")) return past ? "Built an animation" : "Building an animation";
    if (target?.startsWith("publish ")) return past ? "Published an animation" : "Publishing an animation";
    if (target?.startsWith("wire ")) return past ? "Wired an animation" : "Wiring an animation";
    if (target?.startsWith("rig ")) return past ? "Made an NPC" : "Making an NPC";
    // A model's verify summary names the model "in the playtest"; a character's names its animation.
    if (target?.startsWith("verify ") && target.includes(" in the playtest")) {
      return past ? "Verified a model in the playtest" : "Verifying a model in the playtest";
    }
    if (target?.startsWith("verify ")) return past ? "Verified an animation in the playtest" : "Verifying an animation in the playtest";
    // The tool refuses an action it does not have, so the call is no check.
    if (target?.startsWith("unknown action")) return past ? "Called the animation tool" : "Calling the animation tool";
    return past ? "Checked an animation" : "Checking an animation";
  }
  if (target === null) return `${verb} ${toolPhrase(tool)}`;
  if (kind === "search") {
    // A search's identifying argument is a query, not a path: unquoted it reads
    // as a place, and a query with nothing to read in it ("." , "*") says less
    // than naming what was searched.
    const query = target.trim();
    // A search scoped to an instance is summarised by where it looked.
    if (query.startsWith("game.")) return `${verb} ${shortTarget(query)}`;
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
