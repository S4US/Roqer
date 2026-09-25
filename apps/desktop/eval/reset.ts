/**
 * Deterministic place reset.
 *
 * A benchmark is only a benchmark if every arm starts from the same place, and
 * a Roblox place accumulates whatever the last run did to it. So each task owns
 * one subtree, and a reset destroys that subtree and rebuilds it from the
 * task's seed before the agent is allowed near it.
 *
 * Reset runs through the same `execute_luau` operation an agent would use,
 * deliberately: if the bridge cannot be trusted to build the fixture, its
 * results about the agent are not worth reading either.
 */

import type { McpToolCaller, McpToolOutcome } from "../runtime/mcp-types";
import { EVAL_ROOT, type EvalTask } from "./tasks";

const RESET_TIMEOUT_MS = 30_000;

export class EvalResetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalResetError";
  }
}

/** Wrap task Luau so `root` is the freshly created folder in every fixture. */
function seedProgram(seed: string): string {
  return `
local ServerStorage = game:GetService("ServerStorage")
local existing = ServerStorage:FindFirstChild("WorkbenchEval")
if existing then existing:Destroy() end

local StarterGui = game:GetService("StarterGui")
for _, name in ipairs({ "WorkbenchEvalShop", "WorkbenchEvalPurchase" }) do
  local gui = StarterGui:FindFirstChild(name)
  if gui then gui:Destroy() end
end

local root = Instance.new("Folder")
root.Name = "WorkbenchEval"
root.Parent = ServerStorage
${seed}
return { ok = true, root = root:GetFullName() }
`.trim();
}

function probeProgram(probe: string): string {
  return `
local ServerStorage = game:GetService("ServerStorage")
local root = ServerStorage:FindFirstChild("WorkbenchEval")
if not root then return { missing = true } end
${probe}
`.trim();
}

async function runLuau(
  caller: McpToolCaller,
  source: string,
  instanceId: string | null,
): Promise<McpToolOutcome> {
  return caller.callTool(
    "execute_luau",
    { code: source, ...(instanceId ? { instance_id: instanceId } : {}) },
    { timeoutMs: RESET_TIMEOUT_MS },
  );
}

/** Destroy and rebuild the task's fixture. Throws if the place is unusable. */
export async function resetPlace(
  caller: McpToolCaller,
  task: EvalTask,
  instanceId: string | null,
): Promise<void> {
  const outcome = await runLuau(caller, seedProgram(task.seed), instanceId);
  if (!outcome.ok) {
    throw new EvalResetError(
      `Could not seed ${task.id} at ${EVAL_ROOT}: ${outcome.message ?? outcome.errorCode ?? "Studio rejected the reset"}`,
    );
  }
}

/**
 * Read the task's fixture back after the run.
 *
 * A failed probe is not a failed task — it means the harness could not see the
 * place — so it is reported as an error rather than silently scored as a miss.
 */
export async function probePlace(
  caller: McpToolCaller,
  task: EvalTask,
  instanceId: string | null,
): Promise<unknown> {
  const outcome = await runLuau(caller, probeProgram(task.probe), instanceId);
  if (!outcome.ok) {
    throw new EvalResetError(
      `Could not probe ${task.id}: ${outcome.message ?? outcome.errorCode ?? "Studio rejected the probe"}`,
    );
  }
  return luauReturnValue(outcome.data);
}

/** The value a Luau program returned, from any shape the bridge reports it in. */
export function luauReturnValue(data: unknown): unknown {
  // The bridge has returned the Luau result three different ways, and reading
  // the wrong one is not a visible error: the probe succeeds, the oracle finds
  // none of the fields it asked for, and the task is scored as though the agent
  // destroyed the fixture. T1 was reported as "The Target part is gone" while
  // the probe in the same trajectory said `found: true`, red, and
  // non-collidable -- a correct run failed on the reader rather than the work.
  //
  // So all three shapes are accepted: `result`, the current `returnValue` as a
  // JSON string, and the bare data object.
  if (data === null || typeof data !== "object") return data;
  if ("result" in data) return (data as { result: unknown }).result;
  const returned = (data as { returnValue?: unknown }).returnValue;
  if (typeof returned === "string") {
    try {
      return JSON.parse(returned) as unknown;
    } catch {
      // A probe that returned a plain string rather than a table. Handing back
      // the string is more useful to an oracle than throwing the value away.
      return returned;
    }
  }
  return data;
}
