import assert from "node:assert/strict";
import { test } from "node:test";
import type { McpCallOptions, McpToolCaller, McpToolOutcome } from "./mcp-types";
import { readStudioSelection, SELECTION_READ_TIMEOUT_MS } from "./selection-context";

type Call = { tool: string; args: Record<string, unknown>; options?: McpCallOptions };

function caller(answer: () => Promise<McpToolOutcome>): { caller: McpToolCaller; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    caller: {
      callTool(tool, args, options) {
        calls.push({ tool, args, options });
        return answer();
      },
    },
  };
}

const outcome = (data: unknown, ok = true): McpToolOutcome =>
  ({ ok, data, text: data === undefined ? "" : JSON.stringify(data), httpStatus: 200, durationMs: 1 });

test("reads the selection of the given place through selection get, with a bound", async () => {
  const { caller: studio, calls } = caller(async () => outcome({
    success: true,
    selection: [{ name: "Tower", className: "Model", path: "game.Workspace.Tower", parent: "game.Workspace" }],
    count: 1,
  }));
  const selection = await readStudioSelection(studio, "anon:1");
  assert.deepEqual(selection, { items: [{ path: "game.Workspace.Tower", className: "Model" }], count: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, "selection");
  assert.deepEqual(calls[0].args, { action: "get", instance_id: "anon:1" });
  assert.equal(calls[0].options?.timeoutMs, SELECTION_READ_TIMEOUT_MS);
});

test("a caller's own options are kept, and the signal passes through", async () => {
  const controller = new AbortController();
  const { caller: studio, calls } = caller(async () => outcome({ selection: [], count: 0 }));
  await readStudioSelection(studio, "anon:1", { signal: controller.signal, timeoutMs: 100 });
  assert.equal(calls[0].options?.signal, controller.signal);
  assert.equal(calls[0].options?.timeoutMs, 100);
});

test("a failed call, a thrown call and an unexpected answer all read as no selection", async () => {
  assert.equal(await readStudioSelection(caller(async () => outcome({ error: "no edit peer" }, false)).caller, "anon:1"), undefined);
  assert.equal(await readStudioSelection(caller(async () => { throw new Error("fetch failed"); }).caller, "anon:1"), undefined);
  assert.equal(await readStudioSelection(caller(async () => outcome({ something: "else" })).caller, "anon:1"), undefined);
});

test("a legacy text-only answer is read from its JSON", async () => {
  const { caller: studio } = caller(async () => ({
    ok: true, data: undefined, text: JSON.stringify({ selection: [{ className: "Part", path: "game.Workspace.P" }], count: 1 }), httpStatus: 200, durationMs: 1,
  }));
  assert.deepEqual(await readStudioSelection(studio, "anon:1"), { items: [{ path: "game.Workspace.P", className: "Part" }], count: 1 });
});

test("an empty selection is reported as empty, not as a failure", async () => {
  const { caller: studio } = caller(async () => outcome({ success: true, selection: [], count: 0, message: "No objects selected" }));
  assert.deepEqual(await readStudioSelection(studio, "anon:1"), { items: [], count: 0 });
});
