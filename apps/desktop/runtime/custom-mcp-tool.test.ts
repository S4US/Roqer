import assert from "node:assert/strict";
import test from "node:test";
import { CustomMcpManager } from "./custom-mcp-manager";
import { runCustomMcpTool } from "./custom-mcp-tool";
import { startWorkbenchMcpServer } from "./workbench-mcp-server";
import type { PlannerContext } from "./run-engine";

test("gateway resolves discovered external names through the policy call boundary", async () => {
  const server = await startWorkbenchMcpServer({
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    invoke: async () => { throw new Error("Gateway must not bypass policy"); },
  });
  const manager = new CustomMcpManager({ connections: [{
    connection: { id: "test", name: "Test", transport: "http", url: server.url, enabled: true },
    environment: {}, headers: { Authorization: `Bearer ${server.token}` },
  }] });
  let calls = 0;
  const context = { signal: new AbortController().signal, status() {}, async call(tool: string, args: unknown) {
    calls++; assert.equal(tool, "custom_mcp/test/echo"); assert.deepEqual(args, { instance_id: "remote" });
    return { ok: true, text: "Approved result", data: {}, durationMs: 1, httpStatus: 200 };
  } } as unknown as PlannerContext;
  try {
    assert.equal((await runCustomMcpTool(context, manager, { action: "list" })).ok, true);
    assert.equal((await runCustomMcpTool(context, manager, { action: "describe", server: "test", tool: "echo" })).ok, true);
    assert.equal(calls, 0);
    const result = await runCustomMcpTool(context, manager, { action: "call", server: "test", tool: "echo", arguments: { instance_id: "remote" } });
    assert.equal(result.text, "Approved result"); assert.equal(calls, 1);
    await assert.rejects(runCustomMcpTool(context, manager, { action: "call", server: "test", tool: "missing", arguments: {} }));
    assert.equal(calls, 1);
    await assert.rejects(runCustomMcpTool(context, manager, { action: "call", server: "test", tool: "echo", arguments: [] }));
  } finally { await manager.close(); await server.close(); }
});
