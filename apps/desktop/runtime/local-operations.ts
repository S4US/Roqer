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
 */

export type LocalOperation = (args: Record<string, unknown>, options: McpCallOptions) => Promise<McpToolOutcome>;

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
      const rest = Object.fromEntries(Object.entries(args).filter(([name]) => name !== "instance_id"));
      return local(rest, options ?? {});
    },
  };
}
