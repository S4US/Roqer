import type { ToolRisk } from "./policy";

/**
 * Risk classification for every public Roblox Studio MCP tool.
 *
 * The MCP server splits its tools into `read` and `write`. That split is the
 * right boundary for the server, but Roqer needs a third level: a small set
 * of write tools escape Studio's undo stack, spend the user's Roblox account
 * resources, run arbitrary code, or rewrite many scripts at once. Those are
 * `irreversible` and always require an explicit confirmation, whatever
 * execution mode is selected.
 *
 * `shared/mcp-tools.test.ts` re-derives the server's own tool list from
 * `packages/core/src/tools/definitions.ts` and fails if this table drifts: a
 * tool added to the MCP surface without a risk entry, a removed tool left
 * behind, or a server `write` tool downgraded to `read` here.
 */
export const TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  // -- Inspection --------------------------------------------------------
  get_place_info: "read",
  search_objects: "read",
  get_instance_properties: "read",
  get_project_structure: "read",
  get_script_source: "read",
  get_attributes: "read",
  selection: "read",
  grep_scripts: "read",
  get_simulation_state: "read",
  get_device_simulator_state: "read",
  get_runtime_logs: "read",
  // Reads, unless a path argument puts a file on the user's disk or reads one
  // from it; `riskForTool` rates those calls higher.
  capture_script_profiler: "read",
  capture_micro_profiler: "read",
  get_connected_instances: "read",
  search_assets: "read",
  get_asset_details: "read",
  get_asset_thumbnail: "read",
  preview_asset: "read",
  capture_screenshot: "read",
  inspect_ui: "read",
  get_memory_breakdown: "read",
  get_scene_analysis: "read",
  get_roblox_skills: "read",
  get_roblox_docs: "read",

  // -- Ordinary, recoverable project edits -------------------------------
  set_properties: "mutation",
  // Removes as well as builds, but only inside its own root, and the whole
  // batch is one ChangeHistory step, so Studio's undo reverses it.
  build_instances: "mutation",
  set_script_source: "mutation",
  edit_script_lines: "mutation",
  edit_script_batch: "mutation",
  insert_script_lines: "mutation",
  delete_script_lines: "mutation",
  insert_asset: "mutation",
  solo_playtest: "mutation",
  multiplayer_playtest: "mutation",
  breakpoints: "mutation",
  set_network_profile: "mutation",
  reset_simulation_state: "mutation",
  set_device_simulator: "mutation",
  capture_device_matrix: "mutation",
  interact_ui: "mutation",
  simulate_mouse_input: "mutation",
  simulate_keyboard_input: "mutation",
  // The MCP surface calls this a read because it does not touch the place, but
  // it writes a file to the user's disk, which Read only mode should not do.
  export_rbxm: "mutation",

  // -- Always confirm ----------------------------------------------------
  // Arbitrary Luau, in Studio or in a live runtime VM.
  execute_luau: "irreversible",
  eval_server_runtime: "irreversible",
  eval_client_runtime: "irreversible",
  // Launches and closes Studio processes; closing can discard unsaved work.
  manage_instance: "irreversible",
  // Publishes to, or spends resources on, the user's Roblox account.
  upload_asset: "irreversible",
  generate_model: "irreversible",
  // Injects unreviewed third-party content, which may include scripts.
  import_rbxm: "irreversible",
  // Rewrites many scripts in one call.
  find_and_replace_in_scripts: "irreversible",
};

/**
 * Operations Roqer runs itself on this machine rather than sending to the
 * Studio bridge. They travel through the run engine exactly as Studio calls do
 * -- classified, approved, cancelled -- but they are not part of the
 * MCP surface, so they are kept out of `TOOL_RISK` and its drift tests, and
 * out of the `roblox_studio` operation list.
 */
export const LOCAL_TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  // Model-written Python in the user's own Blender, with their permissions.
  run_blender_script: "irreversible",
};

/**
 * An own-property check, not `tool in TOOL_RISK` and not a truthiness test on
 * the lookup: names inherited from `Object.prototype` — "constructor",
 * "toString" — would otherwise resolve to a value and be treated as known.
 */
export function isKnownTool(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_RISK, tool);
}

/** A Studio tool or one of Roqer's own local operations: something the risk tables classify. */
export function isClassifiedTool(tool: string): boolean {
  return isKnownTool(tool) || Object.prototype.hasOwnProperty.call(LOCAL_TOOL_RISK, tool);
}

/** Profiler arguments that name a file on the user's disk rather than anything in Studio. */
const PROFILER_FILE_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  capture_script_profiler: ["output_path"],
  capture_micro_profiler: ["output_path", "summary_output_path", "baseline_path"],
};

/**
 * Risk of a tool call. Unknown tools are treated as irreversible so that a tool
 * added to the MCP server before this table catches up can never run
 * unattended.
 */
export function riskForTool(tool: string, args?: Record<string, unknown>): ToolRisk {
  // Reading a durable Roblox operation cannot publish or mutate anything. The
  // upload action remains irreversible and keeps its normal confirmation.
  if (tool === "upload_asset" && args?.action === "status") return "read";
  // A profiler capture only reads Studio, but a path argument has it write a
  // file anywhere on the user's disk, or read one, so Read only mode refuses it
  // and Ask first asks, as for `export_rbxm`.
  if (Object.prototype.hasOwnProperty.call(PROFILER_FILE_ARGUMENTS, tool)
    && PROFILER_FILE_ARGUMENTS[tool].some((name) => args?.[name] !== undefined)) {
    return "mutation";
  }
  if (isKnownTool(tool)) return TOOL_RISK[tool];
  return Object.prototype.hasOwnProperty.call(LOCAL_TOOL_RISK, tool) ? LOCAL_TOOL_RISK[tool] : "irreversible";
}

/**
 * How long Roqer waits for one tool call, in milliseconds.
 *
 * A client budget shorter than the server's own is the worst of both worlds:
 * the call is abandoned before the MCP server can finish it, and the agent is
 * told "the request timed out" instead of the reason Studio actually gave. So
 * every budget here is the server-side worst case plus margin, never less.
 *
 * The bridge to the Studio plugin times out a request after 30s, which is what
 * the default covers. The tools listed below wait on something longer than one
 * plugin round trip — a playtest booting, a Studio process launching, six
 * device captures in a row — and each is sized from the wait the server itself
 * performs. `capture_screenshot` is the largest surprise: a play-mode capture
 * is two bridge calls (capture on the client, read the pixels back on edit),
 * so its floor is twice the bridge timeout before any encoding.
 */
export const DEFAULT_TOOL_TIMEOUT_MS = 35_000;

const TOOL_TIMEOUT_MS: Readonly<Record<string, number>> = {
  // Client capture + edit-side read, each a full bridge round trip, plus the
  // Luau-side base64 of a whole viewport and the JPEG re-encode here.
  capture_screenshot: 75_000,
  // Up to six device profiles, each applied, settled, captured and read back.
  capture_device_matrix: 180_000,
  // action=start waits up to 60s for the runtime peers to report ready.
  solo_playtest: 90_000,
  multiplayer_playtest: 90_000,
  // Launching Studio waits up to 120s for the plugin to connect.
  manage_instance: 150_000,
  // Round trips to Roblox's generation service, not just to the plugin.
  generate_model: 60_000,
  // The bridge polls Roblox for up to 60s before returning a durable pending
  // operation that the model can check later.
  upload_asset: 75_000,
  // The script's own limit (at most 200s) plus Roqer's inspection of up to
  // three exported models (30s each); the worker enforces both itself.
  run_blender_script: 300_000,
};

/**
 * Headroom over a wait the caller asked for. The tool's own timeout starts
 * inside Studio, so the call is always longer than the wait it contains: queue
 * time, the response trip, and the result being read back all sit outside it.
 */
const CALLER_TIMEOUT_MARGIN_MS = 15_000;

/**
 * Nothing waits longer than this, whatever the arguments say. `generate_model`
 * caps `timeout_ms` at 300000 server-side; a call that outlives that is hung,
 * and holding the run open on it helps no one.
 */
const MAX_TOOL_TIMEOUT_MS = 315_000;

/**
 * The wait a caller asked for, in milliseconds, or undefined.
 *
 * Tools spell it two ways — `timeout` in seconds (the playtests) and
 * `timeout_ms` (`manage_instance`, `generate_model`) — and a model is free to
 * pass either a longer or a shorter one than the default.
 */
function callerRequestedTimeoutMs(args: Record<string, unknown> | undefined): number | undefined {
  if (args === undefined) return undefined;
  const ms = args.timeout_ms;
  if (typeof ms === "number" && Number.isFinite(ms) && ms > 0) return ms;
  const seconds = args.timeout;
  if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return undefined;
}

/** The call budget for one tool invocation, arguments included. */
export function timeoutForTool(tool: string, args?: Record<string, unknown>): number {
  const base = Object.prototype.hasOwnProperty.call(TOOL_TIMEOUT_MS, tool)
    ? TOOL_TIMEOUT_MS[tool]
    : DEFAULT_TOOL_TIMEOUT_MS;
  const requested = callerRequestedTimeoutMs(args);
  const budget = requested === undefined ? base : Math.max(base, requested + CALLER_TIMEOUT_MARGIN_MS);
  return Math.min(budget, MAX_TOOL_TIMEOUT_MS);
}

/** Arguments that best identify what a call is about, most specific first. */
const IDENTIFYING_ARGUMENTS = [
  "instancePath",
  "instanceRef",
  "path",
  "query",
  "pattern",
  "name",
  "action",
  "target",
  "mode",
];

/** One-line human summary of a proposed call, shown in the activity timeline. */
export function summarizeToolCall(tool: string, args: Record<string, unknown>): string {
  // A Blender job's only argument is its script, which is no summary.
  if (tool === "run_blender_script") return tool;
  for (const key of IDENTIFYING_ARGUMENTS) {
    const value = args[key];
    if (typeof value === "string" && value !== "") {
      return `${tool} · ${truncate(value, 72)}`;
    }
  }
  return tool;
}

export function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}
