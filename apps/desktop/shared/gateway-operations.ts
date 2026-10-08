import type { ToolRisk } from "./policy";
import type { ToolParameterSchema, ToolSchema } from "./mcp-tool-schemas";

/**
 * Operations Roqer composes out of Studio tools and offers inside the
 * `roblox_studio` tool.
 *
 * A local operation such as a Blender job has its own model tool and never
 * reaches Studio. These are the other kind: they act on the run's Studio, but
 * as several bridge calls Roqer makes in a row, so one model call does what
 * would otherwise take many. Each model call re-reads the whole conversation,
 * so the calls saved are the expensive part of a run. They are classified,
 * approved and cancelled like any Studio call, and are not part of the MCP
 * surface, so the drift tests against the server's catalog leave them out.
 */

export const CAPTURE_MOMENTS_OPERATION = "capture_moments";
export const UPLOAD_ASSETS_OPERATION = "upload_assets";
export const LINK_ROJO_PROJECT_OPERATION = "link_rojo_project";

/**
 * Captures run Luau the model wrote, in Studio or in a playtest client, so
 * they confirm exactly as `execute_luau` and `eval_client_runtime` do.
 * Uploads publish files to Roblox, as `upload_asset` does. Linking a Rojo
 * project is an ordinary, recoverable project edit -- the same reason
 * `manage_instance` itself would be a `mutation` for it -- so it asks in Ask
 * first like other writes, rather than needing the explicit confirmation an
 * `irreversible` tool does.
 */
export const GATEWAY_TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  [CAPTURE_MOMENTS_OPERATION]: "irreversible",
  [UPLOAD_ASSETS_OPERATION]: "irreversible",
  [LINK_ROJO_PROJECT_OPERATION]: "mutation",
};

/** The most moments one call captures: each is an image the model reads. */
export const MAX_CAPTURE_MOMENTS = 8;

/** The most files one upload call sends: as many textures as one Blender job reads. */
export const MAX_UPLOADS = 16;

export const GATEWAY_SCHEMAS: Readonly<Record<string, ToolSchema>> = {
  [CAPTURE_MOMENTS_OPERATION]: {
    description: "Use to see a playing effect at several moments in one call: aims the camera at view, runs code that starts it, waits for its textures, then holds it at each time and captures the viewport.",
    parameters: [
      { name: "code", type: "string", required: true, minLength: 1, description: "Luau that starts the effect and stores its handle in a global, e.g. _G.vfx = require(game.ReplicatedStorage.VFX.Emit).play(template, cframe). The handle needs a time field (effect seconds) and setTimeScale(scale); stop() is called after the last capture when it has one." },
      { name: "times", type: "number[]", required: true, description: `Effect seconds to capture, ascending, 1-${MAX_CAPTURE_MOMENTS} of them.` },
      { name: "runtime", type: "string", required: false, enumValues: ["edit", "client"], defaultValue: "\"edit\"", description: "Where code runs: edit (the edit viewport) or client (a running playtest's client, whose camera is the player's view)." },
      { name: "target", type: "string", required: false, description: "Client peer when runtime is client; defaults to client-1." },
      { name: "handle", type: "string", required: false, defaultValue: "\"vfx\"", description: "Name of the global holding the handle." },
      { name: "hold", type: "boolean", required: false, defaultValue: "true", description: "Hold each moment still while capturing. Pass false for trails: a held trail loses its segments, so it keeps playing at slow speed instead." },
      { name: "slow", type: "number", required: false, description: "Playback speed for the last stretch before each moment, 0.01-1; the rest plays at normal speed. Default 0.1, or 0.04 when hold is false." },
      { name: "sheet", type: "boolean", required: false, defaultValue: "true", description: "Return the frames tiled into one image, two to a row at half width, which costs about what two frames do. Pass false for each frame at full size, when small detail matters or for the final look from the player's camera." },
      { name: "view", type: "object", required: false, description: "Edit runtime only: aim the camera first, as selection view does, with {path, from?, angleY?, padding?}, instead of a separate selection call. Leave it out to keep the current view." },
      { name: "reference", type: "object", required: false, description: "Compare with a reference clip the user attached: {clip, times?}, clip being its id and times the clip's effect seconds to match, one per moment (default: the same times). Each moment comes back beside the clip's frame at its time, in one image, whatever sheet says." },
    ],
  },
  [UPLOAD_ASSETS_OPERATION]: {
    description: "Use to upload several local files to Roblox in one call, as upload_asset does one: every texture of a finished set at once.",
    parameters: [
      { name: "uploads", type: "object[]", required: true, description: `1-${MAX_UPLOADS} files, each {filePath, assetType: 'Decal'|'Model'|'Audio'|'Animation'|'Video', displayName (at most 50 characters), description?}. Each file is uploaded on its own; the result lists every file with its assetId and, for a Decal, its imageId.` },
    ],
  },
  [LINK_ROJO_PROJECT_OPERATION]: {
    description: "Use to link the current place to a Rojo project, so script edits save to the project's files instead of staying only in Studio. Opens the same project-file picker as the Rojo pill: the user chooses the *.project.json file, or cancels. It always acts on the run's own place -- there is no path or instance_id argument of any kind; never ask the user to type a path, and point them to the Rojo pill in the header as the other way to link. A report of linked means the place is already linked -- never follow this with manage_instance link_project, which always requires a project path you do not have.",
    parameters: [],
  },
};

/**
 * Arguments Roqer accepts on a Studio operation and resolves itself, so the
 * server never sees them: each entry replaces the generated parameter of the
 * same name, or adds one.
 *
 * `set_script_source` takes a skill template in place of `source`, which
 * Roqer reads from its own skill pack: a template the model is not changing
 * cost it the whole file twice, once to load and once to retype, plus the
 * read-back it then made of its own copy. And a script that is still empty
 * needs no `expectedRevision`: Roqer reads it, and writes against the revision
 * it read only when there is nothing in it to lose.
 */
export const GATEWAY_ARGUMENTS: Readonly<Record<string, readonly ToolParameterSchema[]>> = {
  set_script_source: [
    { name: "source", type: "string", required: false, description: "Replacement source; or pass template." },
    { name: "template", type: "string", required: false, description: "Skill template Roqer writes as the source, e.g. roblox-animation-vfx/templates/vfx/emit.lua." },
    { name: "expectedRevision", type: "string", required: false, description: "Read revision; omit when the script is empty." },
  ],
};

export function isGatewayOperation(operation: string): boolean {
  return Object.prototype.hasOwnProperty.call(GATEWAY_TOOL_RISK, operation);
}
