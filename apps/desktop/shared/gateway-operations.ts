import type { ToolRisk } from "./policy";
import type { ToolSchema } from "./mcp-tool-schemas";

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

/**
 * Captures run Luau the model wrote, in Studio or in a playtest client, so
 * they confirm exactly as `execute_luau` and `eval_client_runtime` do.
 */
export const GATEWAY_TOOL_RISK: Readonly<Record<string, ToolRisk>> = {
  [CAPTURE_MOMENTS_OPERATION]: "irreversible",
};

/** The most moments one call captures: each is an image the model reads. */
export const MAX_CAPTURE_MOMENTS = 8;

export const GATEWAY_SCHEMAS: Readonly<Record<string, ToolSchema>> = {
  [CAPTURE_MOMENTS_OPERATION]: {
    description: "Use to see a playing effect at several moments in one call: runs code that starts it, then holds it at each time and captures the viewport. Aim the camera with selection first.",
    parameters: [
      { name: "code", type: "string", required: true, minLength: 1, description: "Luau that starts the effect and stores its handle in a global, e.g. _G.vfx = require(game.ReplicatedStorage.VFX.Emit).play(template, cframe). The handle needs a time field (effect seconds) and setTimeScale(scale); stop() is called after the last capture when it has one." },
      { name: "times", type: "number[]", required: true, description: `Effect seconds to capture, ascending, 1-${MAX_CAPTURE_MOMENTS} of them.` },
      { name: "runtime", type: "string", required: false, enumValues: ["edit", "client"], defaultValue: "\"edit\"", description: "Where code runs: edit (the edit viewport) or client (a running playtest's client, whose camera is the player's view)." },
      { name: "target", type: "string", required: false, description: "Client peer when runtime is client; defaults to client-1." },
      { name: "handle", type: "string", required: false, defaultValue: "\"vfx\"", description: "Name of the global holding the handle." },
      { name: "hold", type: "boolean", required: false, defaultValue: "true", description: "Hold each moment still while capturing. Pass false for trails: a held trail loses its segments, so it keeps playing at slow speed instead." },
      { name: "slow", type: "number", required: false, description: "Playback speed for the last stretch before each moment, 0.01-1; the rest plays at normal speed. Default 0.1, or 0.04 when hold is false." },
      { name: "sheet", type: "boolean", required: false, defaultValue: "true", description: "Return the frames tiled into one image, two to a row at half width, which costs about what two frames do. Pass false for each frame at full size, when small detail matters or for the final look from the player's camera." },
    ],
  },
};

export function isGatewayOperation(operation: string): boolean {
  return Object.prototype.hasOwnProperty.call(GATEWAY_TOOL_RISK, operation);
}
