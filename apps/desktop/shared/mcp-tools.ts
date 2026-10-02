import { GATEWAY_TOOL_RISK, isGatewayOperation } from "./gateway-operations";
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
  // build and wire write one undoable ChangeHistory step each, and replace only
  // what the caller names by revision or current ID. `riskForTool` rates check
  // and verify as reads and publish as irreversible.
  animation: "mutation",
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

/** A Studio tool, an operation Roqer composes from them, or one of its local operations: something the risk tables classify. */
export function isClassifiedTool(tool: string): boolean {
  return isKnownTool(tool) || isGatewayOperation(tool) || Object.prototype.hasOwnProperty.call(LOCAL_TOOL_RISK, tool);
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
  if (tool === "animation") {
    // Checking compiles and measures on the MCP host, reading a model's rig
    // from Studio when the animation is for one. Verifying plays a track on
    // the playtest character, or walks an NPC in the playtest, and changes
    // nothing that outlasts the playtest. Rigging makes a model: a mutation.
    if (args?.action === "check" || args?.action === "verify") return "read";
    // Uploads to the user's Roblox account, which Studio's undo cannot reverse.
    if (args?.action === "publish") return "irreversible";
  }
  // A profiler capture only reads Studio, but a path argument has it write a
  // file anywhere on the user's disk, or read one, so Read only mode refuses it
  // and Ask first asks, as for `export_rbxm`.
  if (Object.prototype.hasOwnProperty.call(PROFILER_FILE_ARGUMENTS, tool)
    && PROFILER_FILE_ARGUMENTS[tool].some((name) => args?.[name] !== undefined)) {
    return "mutation";
  }
  if (isKnownTool(tool)) return TOOL_RISK[tool];
  if (isGatewayOperation(tool)) return GATEWAY_TOOL_RISK[tool];
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
  // Publishing is an upload (up to 60s of polling) plus an export and up to
  // three read-backs; a build waits up to 10s for its preview track to load.
  animation: 120_000,
  // The script's own limit (at most 200s) plus Roqer's inspection of up to
  // three exported models (30s each); the worker enforces both itself.
  run_blender_script: 300_000,
  // Starts an effect, then up to eight waits of at most 20s at slow speed,
  // each followed by a capture; the operation bounds every step itself.
  capture_moments: 300_000,
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

/**
 * An animation call in words: the approval card shows this instead of the
 * pose description's JSON. Every field is the model's, so each is read
 * defensively and anything unexpected is simply left out.
 */
function summarizeAnimation(args: Record<string, unknown>): string {
  if (args.action === "publish") {
    const path = typeof args.path === "string" && args.path !== "" ? truncate(args.path, 80) : "an animation";
    return `animation · publish ${path} to Roblox`;
  }
  if (args.action === "rig" && args.stock === undefined) {
    const model = typeof args.model === "string" && args.model !== "" ? truncate(args.model, 60) : "a model";
    const plan = args.plan === "quadruped" ? "a quadruped" : undefined;
    const built = args.controller === "Humanoid" || args.controller === "AnimationController" ? args.controller : undefined;
    const replacing = args.replace === "importer"
      ? ", replacing the rig it was imported with"
      : typeof args.expected_revision === "string" ? ", replacing the rig rig built before" : "";
    // A controller with no joints builds around a skinned mesh, whose bones are its joints.
    if (!Array.isArray(args.joints) && built) {
      return `animation · rig ${model} around its bones${plan ? `, ${plan}` : ""}, ${built}${replacing}`;
    }
    if (!Array.isArray(args.joints)) {
      const declaring = plan ?? (typeof args.declarations === "object" && args.declarations !== null ? "declared by hand" : undefined);
      return declaring
        ? `animation · declare ${model}'s rig ${plan ? `as ${plan}` : declaring}, changing none of its joints`
        : `animation · read ${model}'s rig and draw its range sheet`;
    }
    const joints = args.joints.length;
    const controller = built ?? "a controller";
    return `animation · rig ${model}: ${joints} joint${joints === 1 ? "" : "s"}${plan ? `, ${plan}` : ""}, ${controller}${replacing}`;
  }
  if (args.action === "rig") {
    const body = args.stock === "R15" || args.stock === "R6" ? `a stock ${args.stock} NPC` : "an NPC";
    const model = typeof args.model === "string" && args.model !== "" ? truncate(args.model, 60) : "a new path";
    const feet = Array.isArray(args.position) && args.position.length === 3 && args.position.every((value) => typeof value === "number")
      ? `[${args.position.map((value) => Math.round(Number(value) * 10) / 10).join(", ")}]`
      : "the origin";
    return `animation · rig ${body} at ${model}, its feet at ${feet}, animated by a loader script`;
  }
  if (args.action === "wire") {
    const slot = typeof args.slot === "string" ? truncate(args.slot, 20) : "a slot";
    const id = typeof args.animation_id === "string" ? truncate(args.animation_id, 40) : "an animation";
    const replaces = typeof args.expected_id === "string" ? `, replacing ${truncate(args.expected_id, 40)}` : "";
    if (typeof args.model === "string" && args.model !== "") {
      const pace = typeof args.ground_speed === "number" && Number.isFinite(args.ground_speed)
        ? `, paced for ${Math.round(args.ground_speed * 100) / 100} studs a second`
        : "";
      return `animation · wire ${id} as the ${slot} of ${truncate(args.model, 60)}${pace}${replaces}`;
    }
    return `animation · wire ${id} to the ${slot} slot of every character${replaces}`;
  }
  // An action the tool does not have is refused before it does anything.
  // Summarised as a check, it read in the timeline, and on the approval card,
  // as a harmless check it never was. Named only when it is a plain word.
  if (args.action !== "check" && args.action !== "build" && args.action !== "verify") {
    if (args.action === undefined) return "animation · unknown action: none given";
    return typeof args.action === "string" && /^[A-Za-z_-]{1,20}$/.test(args.action)
      ? `animation · unknown action: ${args.action}`
      : "animation · unknown action";
  }
  const action = args.action;
  const animation = typeof args.animation === "object" && args.animation !== null && !Array.isArray(args.animation)
    ? args.animation as Record<string, unknown>
    : {};
  // A description baked in Blender is in a file: what the card can say of it is the file's name.
  const file = args.animation === undefined && typeof args.animation_file === "string" && args.animation_file !== ""
    ? truncate(args.animation_file.split(/[\\/]/).pop() ?? args.animation_file, 60)
    : undefined;
  const name = file !== undefined
    ? `the animation baked in ${file}`
    : typeof animation.name === "string" && animation.name !== "" ? truncate(animation.name, 40) : "an animation";
  // R15 goes unsaid; R6 and a model's own rig are named.
  const rig = typeof animation.rig === "string" && animation.rig !== "" && animation.rig !== "R15" ? ` for ${truncate(animation.rig, 60)}` : "";
  if (action === "verify" && typeof args.model === "string" && args.model !== "") {
    const position = Array.isArray(args.position) && args.position.length === 3 && args.position.every((value) => typeof value === "number")
      ? `, walking it to [${args.position.map((value) => Math.round(Number(value) * 10) / 10).join(", ")}]`
      : "";
    const given = args.animation !== undefined || file !== undefined;
    const played = given ? `, playing ${name} on it` : "";
    const slot = typeof args.slot === "string" && args.slot !== "" ? `, checking its ${truncate(args.slot, 20)}` : "";
    // As the tool decides: walked to a position, else watched unless an animation or a slot was asked about.
    const watched = position === "" && !given && args.slot === undefined ? ", watching it move" : "";
    return `animation · verify ${truncate(args.model, 60)} in the playtest${played}${slot}${position}${watched}`;
  }
  const keyframes = Array.isArray(animation.keyframes) ? animation.keyframes : [];
  const times = keyframes
    .map((keyframe) => (typeof keyframe === "object" && keyframe !== null ? (keyframe as Record<string, unknown>).time : undefined))
    .filter((time): time is number => typeof time === "number" && Number.isFinite(time));
  const joints = new Set<string>();
  for (const keyframe of keyframes) {
    const keyed = typeof keyframe === "object" && keyframe !== null ? (keyframe as Record<string, unknown>).joints : undefined;
    if (typeof keyed === "object" && keyed !== null && !Array.isArray(keyed)) {
      for (const joint of Object.keys(keyed)) joints.add(joint);
    }
  }
  // Waves drive joints of their own, and may be the whole animation.
  const waves = Array.isArray(animation.waves) ? animation.waves : [];
  for (const wave of waves) {
    const chain = typeof wave === "object" && wave !== null ? (wave as Record<string, unknown>).joints : undefined;
    if (Array.isArray(chain)) {
      for (const joint of chain) if (typeof joint === "string") joints.add(joint);
    }
  }
  const length = Math.max(...times, typeof animation.duration === "number" && Number.isFinite(animation.duration) ? animation.duration : 0);
  // A gait is named by its pattern; the legs it steps are the rig's to say.
  const gait = typeof animation.gait === "object" && animation.gait !== null && !Array.isArray(animation.gait)
    ? animation.gait as Record<string, unknown>
    : undefined;
  const gaitWords = gait ? [`a ${typeof gait.pattern === "string" && /^[a-z]{1,12}$/.test(gait.pattern) ? `${gait.pattern} ` : ""}gait`] : [];
  const facts = [
    ...(keyframes.length > 0 || (waves.length === 0 && !gait) ? [`${keyframes.length} keyframe${keyframes.length === 1 ? "" : "s"}`] : []),
    ...gaitWords,
    ...(waves.length > 0 ? [`${waves.length} wave${waves.length === 1 ? "" : "s"}`] : []),
    ...(length > 0 || times.length > 0 ? [`${Math.round(length * 100) / 100} s`] : []),
    ...(animation.loop === true ? ["loops"] : []),
    ...(joints.size > 0 ? [`moves ${joints.size} joint${joints.size === 1 ? "" : "s"}`] : []),
  ];
  const where = action === "build" && typeof args.parent === "string" && args.parent !== ""
    ? ` in ${truncate(args.parent, 60)}`
    : "";
  const replaces = action === "build" && typeof args.expected_revision === "string" ? ", replacing its last build" : "";
  const waived = Array.isArray(args.waive) && args.waive.length > 0
    ? `, accepting failed ${args.waive.filter((id) => typeof id === "string").join(", ")}`
    : "";
  if (file !== undefined) return `animation · ${action} ${name}${where}${replaces}${waived}`;
  return `animation · ${action} ${name}${rig}${where}: ${facts.join(", ")}${replaces}${waived}`;
}

/** One-line human summary of a proposed call, shown in the activity timeline. */
export function summarizeToolCall(tool: string, args: Record<string, unknown>): string {
  // A Blender job's only argument is its script, which is no summary.
  if (tool === "run_blender_script") return tool;
  if (tool === "animation") return summarizeAnimation(args);
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
