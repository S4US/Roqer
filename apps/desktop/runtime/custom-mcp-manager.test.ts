import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CustomMcpManager, withCustomMcp } from "./custom-mcp-manager";
import { startWorkbenchMcpServer } from "./workbench-mcp-server";
import { customMcpToolIdentity } from "../shared/custom-mcp-identity";
import type { ResolvedCustomMcpConnection } from "./custom-mcp-store";

test("HTTP MCP discovery and calls use configured authentication and preserve external arguments", async () => {
  const server = await startWorkbenchMcpServer({
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    invoke: async (_tool, args) => ({ ok: true, text: JSON.stringify(args) }),
  });
  const connection: ResolvedCustomMcpConnection = {
    connection: { id: "test", name: "Test", enabled: true, transport: "http", url: server.url },
    headers: { Authorization: `Bearer ${server.token}` }, environment: {},
  };
  const manager = new CustomMcpManager({ connections: [connection] });
  try {
    const listed = await manager.list();
    assert.equal(listed[0]?.tools[0]?.name, "echo");
    assert.equal((await manager.describe("test", "echo")).inputSchema.type, "object");
    const result = await manager.callTool(customMcpToolIdentity("test", "echo"), { instance_id: "outside", value: "hello" });
    assert.equal(result.ok, true);
    assert.deepEqual(JSON.parse(result.text), { instance_id: "outside", value: "hello" });
    assert.equal(JSON.stringify(listed).includes(server.token), false);
  } finally { await manager.close(); await server.close(); }
});

test("changing a connection revokes an already discovered tool before dispatch", async () => {
  let current = true;
  let calls = 0;
  const server = await startWorkbenchMcpServer({
    tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
    invoke: async () => { calls++; return { ok: true, text: "ok" }; },
  });
  const manager = new CustomMcpManager({ connections: [{
    connection: { id: "test", name: "Test", enabled: true, transport: "http", url: server.url },
    environment: {}, headers: { Authorization: `Bearer ${server.token}` },
  }], isCurrent: async () => current });
  try {
    assert.equal((await manager.list())[0]?.tools[0]?.name, "echo"); current = false;
    const result = await manager.callTool(customMcpToolIdentity("test", "echo"), {});
    assert.equal(result.ok, false);
    assert.equal(calls, 0);
  } finally { await manager.close(); await server.close(); }
});

test("stdio MCP discovers and calls a real subprocess and refuses undiscovered tools", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "roqer-custom-mcp-"));
  const script = path.join(directory, "server.mjs");
  await fs.writeFile(script, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line); if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
 m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:
 {content:[{type:'text',text:JSON.stringify(m.params.arguments)}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
});`);
  const manager = new CustomMcpManager({ connections: [{
    connection: { id: "local", name: "Local", enabled: true, transport: "stdio", command: process.execPath, args: [script] },
    headers: {}, environment: {},
  }] });
  try {
    assert.equal((await manager.list())[0]?.tools[0]?.name, "echo");
    assert.equal((await manager.callTool(customMcpToolIdentity("local", "echo"), { text: "hello world" })).text, '{"text":"hello world"}');
    assert.equal((await manager.callTool(customMcpToolIdentity("local", "missing"), {})).ok, false);
    let studioCalls = 0;
    const routed = withCustomMcp({ async callTool() { studioCalls++; throw new Error("Studio reached"); } }, manager);
    assert.equal((await routed.callTool(customMcpToolIdentity("local", "echo"), {})).ok, true);
    assert.equal(studioCalls, 0);
    await manager.close();
    assert.equal((await manager.callTool(customMcpToolIdentity("local", "echo"), {})).ok, false);
  } finally { await manager.close(); await fs.rm(directory, { recursive: true, force: true }); }
});

test("cancellation aborts an in-flight HTTP tool without replaying it", async () => {
  let calls = 0;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const server = await startWorkbenchMcpServer({
    tools: [{ name: "wait", description: "Wait", inputSchema: { type: "object" } }],
    invoke: async () => { calls++; entered(); return new Promise(() => {}); },
  });
  const manager = new CustomMcpManager({ connections: [{
    connection: { id: "test", name: "Test", enabled: true, transport: "http", url: server.url },
    headers: { Authorization: `Bearer ${server.token}` }, environment: {},
  }] });
  const controller = new AbortController();
  try {
    const result = manager.callTool(customMcpToolIdentity("test", "wait"), {}, { signal: controller.signal });
    await started; controller.abort();
    assert.equal((await result).errorCode, "aborted");
    assert.equal(calls, 1);
  } finally { await manager.close(); await server.close(); }
});

test("tool errors remain errors and configured secrets never enter returned text or structured data", async () => {
  const secret = "private-credential-12345";
  const server = await startWorkbenchMcpServer({
    tools: [{ name: "fail", description: "Failure", inputSchema: { type: "object" } }],
    invoke: async () => ({ ok: false, text: `Access denied with ${secret}` }),
  });
  const manager = new CustomMcpManager({ connections: [{
    connection: { id: "test", name: "Test", enabled: true, transport: "http", url: server.url },
    headers: { Authorization: `Bearer ${server.token}` }, environment: { TOKEN: secret },
  }] });
  try {
    const result = await manager.callTool(customMcpToolIdentity("test", "fail"), {});
    assert.equal(result.ok, false);
    assert.equal(result.text, "Access denied with [redacted]");
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally { await manager.close(); await server.close(); }
});
