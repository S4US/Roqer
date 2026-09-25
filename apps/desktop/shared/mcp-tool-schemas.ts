/**
 * The Roblox Studio MCP tool catalog, condensed to what a model needs to call
 * an operation correctly: its purpose, its arguments, their types, which are
 * required, and the values an enumerated argument accepts.
 *
 * GENERATED FILE — do not edit by hand. Run
 * `npm run generate:tool-schemas -w apps/desktop` after changing
 * `packages/core/src/tools/definitions.ts`;
 * `shared/mcp-tool-schemas.test.ts` fails while the two disagree.
 *
 * `shared/mcp-tool-help.ts` renders these into the signatures the tool
 * description carries and the schema Roqer replies with when a call's
 * arguments do not fit.
 */

export type ToolParameterSchema = {
  readonly name: string;
  /** JSON Schema type, with arrays rendered as e.g. `string[]`. */
  readonly type: string;
  readonly required: boolean;
  /** Present only for string enumerations, which are the ones worth showing. */
  readonly enumValues?: readonly string[];
  /** The server's declared minimum string length, when it declares one. */
  readonly minLength?: number;
  /** The server's default, as JSON text. */
  readonly defaultValue?: string;
  readonly description?: string;
};

export type ToolArgumentRequirement = {
  /** Conditions that select this JSON Schema branch. */
  readonly when: readonly {
    readonly name: string;
    readonly enumValues: readonly string[];
  }[];
  /** Arguments required by the selected branch. */
  readonly required: readonly string[];
};

export type ToolSchema = {
  readonly description: string;
  readonly parameters: readonly ToolParameterSchema[];
  readonly requirements?: readonly ToolArgumentRequirement[];
};

/** sha256 of `packages/core/src/tools/definitions.ts` with LF newlines. */
export const TOOL_DEFINITIONS_DIGEST = "dc720f9d6aea17a83422fa0aaea3acbab2d21bab7c8e80b1db75637a2d1db2e1";

export const TOOL_SCHEMAS: Readonly<Record<string, ToolSchema>> = {
  breakpoints: {
    description: "Use to trace script execution with breakpoints or logpoints.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["set", "remove", "clear", "list"], description: "Operation; set/remove need location; clear targets MCP entries." },
      { name: "clear_all", type: "boolean", required: false, description: "With clear, also remove user-created breakpoints." },
      { name: "script_path", type: "string", required: false, description: "Script path; required for set and remove." },
      { name: "line", type: "number", required: false, description: "1-based line for set or remove." },
      { name: "enabled", type: "boolean", required: false, description: "Initial enabled state; defaults to true." },
      { name: "condition", type: "string", required: false, description: "Luau condition for set." },
      { name: "log_message", type: "string", required: false, description: "Luau expressions to log; quote literal text." },
      { name: "continue_execution", type: "boolean", required: false, description: "Continue after hit; defaults true; false needs a resumer." },
      { name: "target", type: "string", required: false, description: "Edit, server, or client-N; defaults to edit." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  build_instances: {
    description: "Use to build, edit, remove, or scatter instances atomically under one root.",
    parameters: [
      { name: "path", type: "string", required: true, description: "Build root; created if missing." },
      { name: "operations", type: "object[]", required: true, description: "Steps; all apply or none do." },
      { name: "instance_id", type: "string", required: false, description: "Connected place." },
    ],
  },
  capture_device_matrix: {
    description: "Use to compare viewport screenshots across up to six device settings.",
    parameters: [
      { name: "entries", type: "object[]", required: true, description: "Ordered device settings to capture." },
      { name: "target", type: "string", required: false, description: "Edit or one client-N; not server or all-clients." },
      { name: "format", type: "string", required: false, enumValues: ["jpeg", "png"], description: "Image format; defaults to jpeg. png is lossless." },
      { name: "quality", type: "number", required: false, description: "JPEG quality 1-100; defaults to 92. Ignored for png." },
      { name: "settleSeconds", type: "number", required: false, description: "Delay per capture in seconds; defaults to 0.3." },
      { name: "restoreAfter", type: "boolean", required: false, description: "Restore a preset afterward; custom devices cannot be restored." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  capture_micro_profiler: {
    description: "Use to profile engine and game frame time on a live peer.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Running server or client-N; edit is invalid." },
      { name: "duration_ms", type: "number", required: false, defaultValue: "1000", description: "Capture length in ms." },
      { name: "focus", type: "string", required: false, enumValues: ["all", "script", "physics", "render", "network", "jobs"], defaultValue: "\"all\"", description: "Subsystem filter." },
      { name: "filter", type: "string", required: false, description: "Case-insensitive timer or group substring." },
      { name: "max_timers", type: "number", required: false, defaultValue: "20", description: "Returned timer limit." },
      { name: "max_groups", type: "number", required: false, defaultValue: "20", description: "Returned group limit; each group includes hot timers." },
      { name: "max_timers_per_group", type: "number", required: false, defaultValue: "5", description: "Nested timers per group; 0 omits them." },
      { name: "max_related_timers", type: "number", required: false, defaultValue: "3", description: "Parent, child, and thread rows per timer; 0 omits them." },
      { name: "min_total_us", type: "number", required: false, defaultValue: "0", description: "Minimum inclusive_us after other filters." },
      { name: "include_idle", type: "boolean", required: false, description: "Include idle timers; defaults to false." },
      { name: "include_gpu", type: "boolean", required: false, description: "Include GPU events; defaults to false." },
      { name: "max_events", type: "number", required: false, defaultValue: "250000", description: "LibMP event inspection limit." },
      { name: "frame_window", type: "number", required: false, defaultValue: "240", description: "Trailing frames to analyze." },
      { name: "output_path", type: "string", required: false, description: "Raw snapshot file; the response stays summarized." },
      { name: "summary_output_path", type: "string", required: false, description: "Summary JSON file with its comparison index." },
      { name: "baseline_path", type: "string", required: false, description: "Summary file used as the baseline." },
      { name: "baseline", type: "object", required: false, description: "Inline summary used as the baseline." },
      { name: "baseline_label", type: "string", required: false, description: "Baseline comparison label." },
      { name: "current_label", type: "string", required: false, description: "Current comparison label." },
      { name: "max_comparison_rows", type: "number", required: false, defaultValue: "20", description: "Rows returned per comparison section." },
      { name: "include_comparison_index", type: "boolean", required: false, description: "Return the full comparison index; defaults to false." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  capture_screenshot: {
    description: "Use to capture the Studio viewport or map input coordinates.",
    parameters: [
      { name: "format", type: "string", required: false, enumValues: ["jpeg", "png"], description: "Format; jpeg is smaller, png lossless; default jpeg." },
      { name: "quality", type: "number", required: false, description: "JPEG quality 1-100; defaults to 92. Ignored for png." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  capture_script_profiler: {
    description: "Use to find Luau CPU hotspots on a running server or client.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Running server or client-N; edit is invalid." },
      { name: "duration_ms", type: "number", required: false, defaultValue: "1000", description: "Capture length in ms." },
      { name: "frequency", type: "number", required: false, defaultValue: "1000", description: "Samples per second." },
      { name: "max_functions", type: "number", required: false, defaultValue: "20", description: "Returned function and debug-label limit." },
      { name: "min_total_us", type: "number", required: false, defaultValue: "0", description: "Minimum function TotalDuration in microseconds." },
      { name: "filter", type: "string", required: false, description: "Case-insensitive function name or source substring." },
      { name: "include_native", type: "boolean", required: false, description: "Include native frames; defaults to false." },
      { name: "include_plugin", type: "boolean", required: false, description: "Include plugin frames; defaults to false." },
      { name: "output_path", type: "string", required: false, description: "Raw JSON file; the response returns only its path." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  delete_script_lines: {
    description: "Use to remove a known inclusive line range from one script.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Canonical path of the script." },
      { name: "line_range", type: "string", required: true, description: "Inclusive \"N-M\" or \"N\" range; open ends are invalid." },
      { name: "expectedRevision", type: "string", required: false, description: "Read revision; refuses the edit if the script changed." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  edit_script_batch: {
    description: "Use for several exact, non-overlapping replacements in one script, applied as one transaction.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Canonical path of the script." },
      { name: "instanceRef", type: "string", required: false, description: "Opaque ref; overrides path." },
      { name: "edits", type: "object[]", required: true, description: "Each {old_string, new_string, line_range?}; all applied together or none." },
      { name: "expectedRevision", type: "string", required: true, description: "Read revision; refuses the batch if the script changed." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  edit_script_lines: {
    description: "Use for an exact, localized replacement in one script.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Canonical path of the script." },
      { name: "old_string", type: "string", required: true, description: "Exact text; must be unique unless line_range is set." },
      { name: "new_string", type: "string", required: true, description: "Replacement source text." },
      { name: "line_range", type: "string", required: false, description: "Line where old_string starts, or \"N-M\" covering it." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  eval_client_runtime: {
    description: "Use to run Luau in a live client VM with its require cache.",
    parameters: [
      { name: "code", type: "string", required: true, description: "Luau code; return a value to include it in the result." },
      { name: "target", type: "string", required: false, description: "Client peer; defaults to client-1." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  eval_server_runtime: {
    description: "Use to run Luau in the live server VM with its require cache.",
    parameters: [
      { name: "code", type: "string", required: true, description: "Luau code; return a value to include it in the result." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  execute_luau: {
    description: "Use for custom Studio traversal, edits, or peer execution.",
    parameters: [
      { name: "code", type: "string", required: true, description: "Luau code to execute." },
      { name: "target", type: "string", required: false, description: "Execution peer; defaults to edit." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  export_rbxm: {
    description: "Use to save selected DataModel instances as a local .rbxm file.",
    parameters: [
      { name: "instance_paths", type: "string[]", required: true, description: "Canonical instance paths to serialize." },
      { name: "output_path", type: "string", required: true, description: "Absolute .rbxm output path." },
      { name: "target", type: "string", required: false, enumValues: ["edit", "server"], description: "Source DataModel; defaults to edit. server reads live state." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  find_and_replace_in_scripts: {
    description: "Use to preview or apply one replacement across scripts.",
    parameters: [
      { name: "pattern", type: "string", required: true, description: "Literal text or Lua pattern." },
      { name: "replacement", type: "string", required: true, description: "Replacement; Lua patterns support %1, %2, and so on." },
      { name: "caseSensitive", type: "boolean", required: false, description: "Literal match casing; patterns require true." },
      { name: "usePattern", type: "boolean", required: false, description: "Use Lua patterns; requires caseSensitive." },
      { name: "path", type: "string", required: false, description: "Canonical subtree to search." },
      { name: "classFilter", type: "string", required: false, enumValues: ["Script", "LocalScript", "ModuleScript"], description: "Script class to include." },
      { name: "dryRun", type: "boolean", required: false, description: "Preview without edits; defaults to false." },
      { name: "maxReplacements", type: "number", required: false, description: "Replacement safety cap; defaults to 1000." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  generate_model: {
    description: "Use to stage a Roblox model from text or an image.",
    parameters: [
      { name: "prompt", type: "string", required: false, description: "Generation prompt; required without an image." },
      { name: "image_path", type: "string", required: false, description: "Local PNG; excludes other image inputs." },
      { name: "image_base64", type: "string", required: false, description: "PNG base64; image/png required; single source." },
      { name: "image_mime_type", type: "string", required: false, enumValues: ["image/png"], description: "MIME type; required with image_base64." },
      { name: "image_asset_id", type: "number", required: false, description: "Roblox image ID; excludes other image inputs." },
      { name: "schema", type: "string", required: false, enumValues: ["Body1", "Car5"], defaultValue: "\"Body1\"", description: "Part layout; Body1 is one mesh, Car5 is five vehicle parts." },
      { name: "schema_groups", type: "string[]", required: false, description: "Custom part names; excludes schema." },
      { name: "name", type: "string", required: false, description: "Generated Model name in __MCPGeneratedModels." },
      { name: "size", type: "object", required: false, description: "Requested size; generation may vary." },
      { name: "max_triangles", type: "number", required: false, description: "Triangle cap; lower values are more faceted." },
      { name: "generate_textures", type: "boolean", required: false, description: "Generate textures; defaults to true." },
      { name: "timeout_ms", type: "number", required: false, defaultValue: "120000", description: "Bridge timeout in ms." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_asset_details: {
    description: "Use to inspect a shortlisted Creator Store asset.",
    parameters: [
      { name: "assetId", type: "number", required: true, description: "Roblox asset ID." },
    ],
  },
  get_asset_thumbnail: {
    description: "Use when an asset thumbnail would help with visual review.",
    parameters: [
      { name: "assetId", type: "number", required: true, description: "Roblox asset ID." },
      { name: "size", type: "string", required: false, enumValues: ["150x150", "420x420", "768x432"], description: "Thumbnail dimensions; defaults to 420x420." },
    ],
  },
  get_attributes: {
    description: "Use to inspect every attribute on one instance.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Canonical path of the instance." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_connected_instances: {
    description: "Use to discover connected places and the roles available in each.",
    parameters: [],
  },
  get_device_simulator_state: {
    description: "Use to inspect device simulation or list device presets.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Edit or client peer; defaults to edit. Servers are invalid." },
      { name: "deviceId", type: "string", required: false, description: "Built-in preset to inspect." },
      { name: "includeDeviceList", type: "boolean", required: false, description: "Include built-in presets; defaults to true." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_instance_properties: {
    description: "Use to inspect properties.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Target path." },
      { name: "instanceRef", type: "string", required: false, description: "Opaque ref; overrides path." },
      { name: "excludeSource", type: "boolean", required: false, description: "Omit Source text." },
      { name: "instance_id", type: "string", required: false, description: "Connected place." },
    ],
  },
  get_memory_breakdown: {
    description: "Use to compare memory categories across Studio peers.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Edit, server, client-N, or all; defaults to all." },
      { name: "tags", type: "string[]", required: false, description: "DeveloperMemoryTag filter; unknown tags return zero." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_place_info: {
    description: "Use when you need the current place's identity or settings.",
    parameters: [
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_project_structure: {
    description: "Use to inspect a subtree.",
    parameters: [
      { name: "path", type: "string", required: false, description: "Root; defaults to Workspace." },
      { name: "maxDepth", type: "number", required: false, description: "Depth; defaults to 3." },
      { name: "scriptsOnly", type: "boolean", required: false, description: "Only scripts." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_roblox_docs: {
    description: "Use to read official Roblox engine or Luau references.",
    parameters: [
      { name: "name", type: "string", required: true, description: "Exact engine or Luau reference name; case-sensitive." },
      { name: "doc_type", type: "string", required: false, enumValues: ["classes", "enums", "datatypes", "libraries", "globals"], description: "Reference category; defaults to classes." },
      { name: "section", type: "string", required: false, description: "Level-two heading to return." },
    ],
  },
  get_roblox_skills: {
    description: "Use to read installed Roblox Studio Assistant skills.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["list", "get"], description: "List skills or get one document." },
      { name: "name", type: "string", required: false, description: "Listed skill name; required for get." },
    ],
  },
  get_runtime_logs: {
    description: "Use to read recent Studio output from edit, server, or client peers.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Log buffer: edit, server, client-N, or all; all deduplicates." },
      { name: "since", type: "number", required: false, description: "Sequence floor; reuse returned nextSince values for later reads." },
      { name: "tail", type: "number", required: false, description: "Last N entries after filtering." },
      { name: "filter", type: "string", required: false, description: "Literal message substring applied before tail." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_scene_analysis: {
    description: "Use to attribute scene cost across instances and content.",
    parameters: [
      { name: "mode", type: "string", required: false, enumValues: ["all", "instance_composition", "script_memory", "unparented_instances", "triangle_composition", "animation_memory", "audio_memory"], description: "Analysis mode; defaults to all." },
      { name: "target", type: "string", required: false, description: "Edit, server, client-N, or all; defaults to all." },
      { name: "topN", type: "number", required: false, description: "Flattened entries per mode; defaults to 10." },
      { name: "raw", type: "boolean", required: false, description: "Include full nested result trees; defaults to false." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  get_script_source: {
    description: "Use to read script source.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Script path." },
      { name: "instanceRef", type: "string", required: false, description: "Opaque ref; overrides path." },
      { name: "line_range", type: "string", required: false, description: "Lines: N, N-M, N-, or -M." },
      { name: "instance_id", type: "string", required: false, description: "Connected place." },
    ],
  },
  get_simulation_state: {
    description: "Use to inspect current network and device simulation.",
    parameters: [
      { name: "include", type: "string", required: false, enumValues: ["network", "deviceSimulator", "both"], description: "State group; defaults to both." },
      { name: "target", type: "string", required: false, description: "Edit or client scope; servers are invalid." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  grep_scripts: {
    description: "Use to locate text or Lua pattern matches across script sources.",
    parameters: [
      { name: "pattern", type: "string", required: true, minLength: 1, description: "Literal text, or a Lua pattern when usePattern is true. To list scripts instead, use get_project_structure with scriptsOnly." },
      { name: "caseSensitive", type: "boolean", required: false, description: "Literal match casing; patterns are always case-sensitive." },
      { name: "usePattern", type: "boolean", required: false, description: "Use Lua patterns with top-level | alternation; not PCRE." },
      { name: "contextLines", type: "number", required: false, description: "Lines before and after each match; defaults to 0." },
      { name: "maxResults", type: "number", required: false, description: "Total match limit; defaults to 100." },
      { name: "maxResultsPerScript", type: "number", required: false, description: "Match limit per script." },
      { name: "filesOnly", type: "boolean", required: false, description: "Return only script paths; defaults to false." },
      { name: "path", type: "string", required: false, description: "Canonical subtree to search." },
      { name: "classFilter", type: "string", required: false, enumValues: ["Script", "LocalScript", "ModuleScript"], description: "Script class to include." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  import_rbxm: {
    description: "Use to load a local, remote, or inline .rbxm under a chosen parent.",
    parameters: [
      { name: "source", type: "object", required: true, description: "Exactly one path, URL, or base64 source; URLs cap at 50 MiB." },
      { name: "parent_path", type: "string", required: true, description: "Canonical parent path for imported instances." },
      { name: "target", type: "string", required: false, enumValues: ["edit", "server"], description: "Destination DataModel; defaults to edit. server uses live state." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  insert_asset: {
    description: "Use to sanitize and insert a Creator Store asset into a Studio place.",
    parameters: [
      { name: "assetId", type: "number", required: true, description: "Roblox asset ID to insert." },
      { name: "parentPath", type: "string", required: false, description: "Canonical parent; defaults to game.Workspace." },
      { name: "position", type: "object", required: false, description: "World position for the inserted asset." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  insert_script_lines: {
    description: "Use to add source after a known line in one script.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Canonical path of the script." },
      { name: "afterLine", type: "number", required: false, description: "Line to insert after; 0 means before line 1." },
      { name: "newContent", type: "string", required: true, description: "Source text to insert." },
      { name: "expectedRevision", type: "string", required: false, description: "Read revision; refuses the edit if the script changed." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  inspect_ui: {
    description: "Use to inspect or audit semantic UI rendered by a live playtest client.",
    parameters: [
      { name: "mode", type: "string", required: false, enumValues: ["inspect", "audit", "snapshot"], description: "Result mode; defaults to inspect." },
      { name: "root", type: "object", required: false, description: "Optional PlayerGui subtree root." },
      { name: "visible_only", type: "boolean", required: false, description: "Return only effectively visible elements." },
      { name: "max_depth", type: "number", required: false, description: "Traversal depth; defaults to 8." },
      { name: "max_nodes", type: "number", required: false, description: "Element limit; defaults to 250." },
      { name: "include_text", type: "boolean", required: false, description: "Include text content; defaults to true." },
      { name: "include_styles", type: "boolean", required: false, description: "Include compact colors and font metadata." },
      { name: "target", type: "string", required: false, description: "Live client-N role; defaults to the first client." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  interact_ui: {
    description: "Use to interact with semantic UI on a live playtest client.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["click", "focus", "type", "scroll_into_view", "set_scroll"], description: "Semantic interaction to perform." },
      { name: "selector", type: "object", required: true, description: "Fields compose and must resolve one PlayerGui element." },
      { name: "text", type: "string", required: false, description: "Text to send for the type action." },
      { name: "canvas_position", type: "object", required: false, description: "Canvas coordinates for set_scroll." },
      { name: "target", type: "string", required: false, description: "Live client-N role; defaults to the first client." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  manage_instance: {
    description: "Use to manage Studio processes or list place revisions.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["launch", "authorize", "complete", "close", "status", "list_place_versions"], description: "Operation; authorize and complete only resume identity launches." },
      { name: "source", type: "string", required: false, enumValues: ["baseplate", "local_file", "published_place", "place_revision"], description: "Launch source; local_file needs path, published needs place_id." },
      { name: "local_place_file", type: "string", required: false, description: ".rbxl or .rbxlx path; required for local_file." },
      { name: "place_id", type: "number", required: false, description: "Place ID; required for published sources and version listing." },
      { name: "place_version", type: "number", required: false, description: "Revision number; required for place_revision." },
      { name: "require_process_identity", type: "boolean", required: false, description: "Require PID attestation and explicit authorization." },
      { name: "wait_for_connection", type: "boolean", required: false, description: "Wait for instance_id; false returns launch_id." },
      { name: "timeout_ms", type: "number", required: false, description: "Plugin timeout in ms; default 120000; ignored in identity mode." },
      { name: "studio_working_directory", type: "string", required: false, description: "Studio process working directory; isolates relative plugin folders per launch." },
      { name: "max_page_size", type: "number", required: false, description: "Versions per page; clamped to 1-50, default 10." },
      { name: "page_token", type: "string", required: false, description: "Prior list_place_versions page token." },
      { name: "instance_id", type: "string", required: false, description: "Connected instance for close or status; excludes launch_id." },
      { name: "launch_id", type: "string", required: false, description: "Launch for close or status; excludes instance_id." },
    ],
  },
  multiplayer_playtest: {
    description: "Use to run or inspect a multi-client Studio playtest.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["start", "status", "add_players", "leave_client", "end"], description: "Lifecycle action to run." },
      { name: "numPlayers", type: "number", required: false, description: "Client count for start or add_players; 1-8." },
      { name: "target", type: "string", required: false, description: "Client for leave_client; defaults to client-1." },
      { name: "testArgs", type: "unknown", required: false, description: "JSON value exposed through GetTestArgs on server and clients." },
      { name: "value", type: "unknown", required: false, description: "JSON value returned by end to the edit process." },
      { name: "timeout", type: "number", required: false, description: "Wait in seconds; defaults to 30." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  preview_asset: {
    description: "Use to inspect an asset's hierarchy and media without inserting it.",
    parameters: [
      { name: "assetId", type: "number", required: true, description: "Roblox asset ID to preview." },
      { name: "includeProperties", type: "boolean", required: false, defaultValue: "false", description: "Include properties in displayed nodes." },
      { name: "maxDepth", type: "number", required: false, defaultValue: "4", description: "Displayed depth; result caps at 100 nodes, but all are scanned." },
      { name: "includeAudio", type: "boolean", required: false, defaultValue: "true", description: "Return inline audio; needs asset:read and never writes files." },
      { name: "maxAudioPreviews", type: "number", required: false, defaultValue: "3", description: "Inline audio limit; byte caps still apply." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  reset_simulation_state: {
    description: "Use to clear network and device simulation state.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Edit or client scope; servers are invalid." },
      { name: "network", type: "boolean", required: false, description: "Reset network simulation; defaults to true." },
      { name: "deviceSimulator", type: "boolean", required: false, description: "Stop device simulation; defaults to true." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  search_assets: {
    description: "Use to find public Creator Store assets by type or keyword.",
    parameters: [
      { name: "assetType", type: "string", required: true, enumValues: ["Audio", "Model", "Decal", "Image", "Particle", "VFX", "Plugin", "MeshPart", "Video", "FontFamily"], description: "Asset type; Image maps to Decal, Particle and VFX to Model." },
      { name: "query", type: "string", required: false, description: "Terms; Particle and VFX add an effect suffix." },
      { name: "maxResults", type: "number", required: false, description: "Result limit; defaults to 25." },
      { name: "sortBy", type: "string", required: false, enumValues: ["Relevance", "Trending", "Top", "AudioDuration", "CreateTime", "UpdatedTime", "Ratings"], description: "Sort order; defaults to Relevance." },
      { name: "robloxCreatedOnly", type: "boolean", required: false, defaultValue: "false", description: "Only Roblox-created assets; defaults to false." },
    ],
  },
  search_objects: {
    description: "Use to find instances by name, class, or property value.",
    parameters: [
      { name: "query", type: "string", required: true, description: "Text, class, or property value to match." },
      { name: "searchType", type: "string", required: false, enumValues: ["name", "class", "property"], description: "Field to search; defaults to name." },
      { name: "propertyName", type: "string", required: false, description: "Property to search when searchType is property." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  selection: {
    description: "Use to get, set, open, or frame Studio context.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["get", "set", "open", "view"], description: "Open shows a script; view frames a 3D target." },
      { name: "paths", type: "string[]", required: false, description: "Set needs paths; empty clears in set mode." },
      { name: "mode", type: "string", required: false, enumValues: ["set", "add", "remove"], defaultValue: "\"set\"", description: "How set applies paths." },
      { name: "path", type: "string", required: false, minLength: 1, description: "Open and view need an instance path." },
      { name: "from", type: "number", required: false, description: "View azimuth: 0 +X, 90 +Z." },
      { name: "padding", type: "number", required: false, defaultValue: "1", description: "View distance scale." },
      { name: "angleY", type: "number", required: false, description: "View elevation in degrees." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID if multiple are open." },
    ],
  },
  set_device_simulator: {
    description: "Use to manage device simulation in edit or a playtest client.",
    parameters: [
      { name: "target", type: "string", required: false, description: "Edit, client-N, or all-clients; defaults to edit." },
      { name: "deviceId", type: "string", required: false, description: "Built-in device preset ID." },
      { name: "orientation", type: "string", required: false, description: "ScreenOrientation enum name." },
      { name: "resolution", type: "object", required: false, description: "Resolution override after the preset." },
      { name: "pixelDensity", type: "number", required: false, description: "Positive density override after the preset." },
      { name: "scalingMode", type: "string", required: false, description: "DeviceSimulatorScalingMode enum name." },
      { name: "stopSimulation", type: "boolean", required: false, description: "Stop simulation; excludes other simulator settings." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  set_network_profile: {
    description: "Use to simulate client latency, jitter, or packet loss.",
    parameters: [
      { name: "profile", type: "string", required: true, enumValues: ["great", "good", "poor", "custom"], description: "Network preset; custom requires overrides." },
      { name: "target", type: "string", required: false, description: "Client peer or all-clients; defaults to client-1." },
      { name: "overrides", type: "object", required: false, description: "NetworkSettings fields that override or define the profile." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  set_properties: {
    description: "Use to set properties atomically.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Target path." },
      { name: "instanceRef", type: "string", required: false, description: "Opaque ref; overrides path." },
      { name: "properties", type: "object", required: true, description: "New values." },
      { name: "instance_id", type: "string", required: false, description: "Connected place." },
    ],
  },
  set_script_source: {
    description: "Use to replace full script source safely.",
    parameters: [
      { name: "instancePath", type: "string", required: true, description: "Script path." },
      { name: "instanceRef", type: "string", required: false, description: "Opaque ref; overrides path." },
      { name: "source", type: "string", required: true, description: "Replacement source." },
      { name: "expectedRevision", type: "string", required: true, description: "Read revision." },
      { name: "instance_id", type: "string", required: false, description: "Connected place." },
    ],
  },
  simulate_keyboard_input: {
    description: "Use to send key presses or text to a live playtest client.",
    parameters: [
      { name: "keyCode", type: "string", required: false, description: "Enum.KeyCode name; omit when using text." },
      { name: "action", type: "string", required: false, enumValues: ["press", "release", "tap"], description: "Key action; tap presses, waits, and releases. Defaults to tap." },
      { name: "duration", type: "number", required: false, description: "Tap hold in seconds; defaults to 0.1." },
      { name: "text", type: "string", required: false, description: "Text for the focused TextBox; excludes keyCode and action." },
      { name: "target", type: "string", required: false, description: "Peer; prefers a running client, then edit." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  simulate_mouse_input: {
    description: "Use to click the live playtest viewport at known pixel coordinates.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["click", "mouseDown", "mouseUp"], description: "Mouse action; click performs down, then up." },
      { name: "x", type: "number", required: true, description: "Viewport pixel X coordinate." },
      { name: "y", type: "number", required: true, description: "Viewport pixel Y coordinate." },
      { name: "button", type: "string", required: false, enumValues: ["Left", "Right", "Middle"], description: "Mouse button; defaults to Left." },
      { name: "target", type: "string", required: false, description: "Peer; prefers a running client, then edit." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  solo_playtest: {
    description: "Use to start, stop, or inspect a single-player Studio playtest.",
    parameters: [
      { name: "action", type: "string", required: true, enumValues: ["start", "stop", "status"], description: "Lifecycle action to run." },
      { name: "mode", type: "string", required: false, enumValues: ["play", "run"], description: "Required for action=\"start\"." },
      { name: "timeout", type: "number", required: false, description: "Wait in seconds; start defaults to 60 and stop to 15." },
      { name: "instance_id", type: "string", required: false, description: "Connected place ID; required with multiple places." },
    ],
  },
  upload_asset: {
    description: "Use to upload a local asset or check a previous upload operation.",
    parameters: [
      { name: "action", type: "string", required: false, enumValues: ["upload", "status"], defaultValue: "\"upload\"", description: "Upload a file, or check a returned operation ID." },
      { name: "operationId", type: "string", required: false, minLength: 1, description: "Returned operation ID; required for status." },
      { name: "filePath", type: "string", required: false, description: "Absolute local file path; required for upload." },
      { name: "assetType", type: "string", required: false, enumValues: ["Audio", "Decal", "Model", "Animation", "Video"], description: "Upload type; required for upload and must match the file." },
      { name: "displayName", type: "string", required: false, description: "Asset name; required for upload, at most 50 characters." },
      { name: "description", type: "string", required: false, description: "Asset description; defaults to empty." },
      { name: "userId", type: "string", required: false, description: "Creator user ID; overrides the environment default." },
      { name: "groupId", type: "string", required: false, description: "Creator group ID; overrides userId and environment defaults." },
      { name: "instance_id", type: "string", required: false, description: "Place for Decal image-ID lookup." },
    ],
    requirements: [
      { when: [{ name: "action", enumValues: ["upload"] }], required: ["filePath", "assetType", "displayName"] },
      { when: [{ name: "action", enumValues: ["status"] }], required: ["action", "operationId"] },
    ],
  },
};
