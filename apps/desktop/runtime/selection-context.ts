import type { McpCallOptions, McpToolCaller } from "./mcp-types";
import { parseBridgeSelection, type StudioSelection } from "../shared/studio-selection";

/**
 * A selection read waits this long at most. It runs while the person waits for
 * Send, or between the window's polls, so a Studio that is busy answers
 * "no selection" rather than holding the start.
 */
export const SELECTION_READ_TIMEOUT_MS = 5_000;

/**
 * Read one Studio place's selection through the bridge's `selection get`.
 *
 * Undefined when the bridge or Studio did not answer, or answered something
 * else, and never a throw: a run must start whether or not the selection could
 * be read, and a chip must simply not show.
 */
export async function readStudioSelection(
  caller: McpToolCaller,
  instanceId: string,
  options: McpCallOptions = {},
): Promise<StudioSelection | undefined> {
  let outcome;
  try {
    outcome = await caller.callTool(
      "selection",
      { action: "get", instance_id: instanceId },
      { timeoutMs: SELECTION_READ_TIMEOUT_MS, ...options },
    );
  } catch {
    return undefined;
  }
  if (!outcome.ok) return undefined;
  return parseBridgeSelection(outcome.data ?? parseText(outcome.text));
}

function parseText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
