import type { McpCallOptions, McpToolCaller, McpToolOutcome } from "./mcp-types";

/**
 * Operations Roqer runs on this machine itself, beside the Studio bridge.
 *
 * The run engine sends every approved call to one caller. Wrapping the bridge
 * client here is what lets a local operation -- a Blender job -- go through the
 * same policy, approval, cancellation and events as a Studio call
 * without the engine knowing which is which, and without either reaching the
 * other: a local operation never touches the bridge, and the bridge never
 * sees one.
 *
 * An operation Roqer composes out of Studio calls (`capture_moments`) is the
 * one exception: it is handed `studio`, which calls the bridge at the run's
 * Studio. The call that started it was the one the user approved, so its
 * steps go to the bridge directly rather than back through the engine.
 */

/** Calls a Studio tool at the run's Studio, for an operation composed of Studio calls. */
export type StudioCaller = (tool: string, args: Record<string, unknown>, options?: McpCallOptions) => Promise<McpToolOutcome>;

export type LocalOperation = (args: Record<string, unknown>, options: McpCallOptions, studio: StudioCaller) => Promise<McpToolOutcome>;

export function withLocalOperations(
  caller: McpToolCaller,
  operations: ReadonlyMap<string, LocalOperation>,
): McpToolCaller {
  if (operations.size === 0) return caller;
  return {
    callTool(tool, args, options) {
      const local = operations.get(tool);
      if (local === undefined) return caller.callTool(tool, args, options);
      // The engine addresses every call at the run's Studio; a local operation
      // has no Studio, and the model's code should not be handed its id.
      const { instance_id: instanceId, ...rest } = args;
      const studio: StudioCaller = (name, studioArgs, studioOptions) =>
        caller.callTool(name, instanceId === undefined ? studioArgs : { ...studioArgs, instance_id: instanceId }, studioOptions);
      return local(rest, options ?? {}, studio);
    },
  };
}
