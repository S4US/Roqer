import assert from "node:assert/strict";
import test from "node:test";

import type { McpServerView } from "../shared/mcp-servers";
import type { ToolRisk } from "../shared/policy";
import {
  argumentsFromText, emptyMcpDraft, isMcpDraftDirty, mcpDraftFrom, mcpDraftFromPreset, MCP_SERVER_PRESETS, mcpSaveRequest, mcpServerDetail, mcpToolRows, withReadOnlyHints, type McpDraft,
} from "./mcp-server-settings";

test("Meshy quick setup requires a key and saves the official server with encrypted-secret input", () => {
  const draft = mcpDraftFromPreset(MCP_SERVER_PRESETS[0]);
  assert.equal(mcpSaveRequest(draft).ok, false);
  const row = draft.secrets.stdio[0];
  const ready = { ...draft, secrets: { ...draft.secrets, stdio: [{ ...row, value: "test-api-key" }] } };
  const request = mcpSaveRequest(ready);
  assert.equal(request.ok, true);
  if (!request.ok) return;
  assert.deepEqual(request.save, { name: "meshy", enabled: true, transport: "stdio", command: "npx", args: ["-y", "@meshy-ai/meshy-mcp-server"], newTools: "trust", toolRisk: {}, secrets: [{ name: "MESHY_API_KEY", value: "test-api-key" }] });
  assert.equal(isMcpDraftDirty(draft, undefined), true);
  assert.equal(mcpDraftFromPreset(MCP_SERVER_PRESETS[0]).secrets.stdio[0].value, "");
});

test("ElevenLabs quick setup uses canonical OAuth endpoint without keys or automatic tool permissions", () => {
  const draft = mcpDraftFromPreset(MCP_SERVER_PRESETS[1]);
  const result = mcpSaveRequest(draft);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.save, { name: "elevenlabs", enabled: true, transport: "http", url: "https://api.us.elevenlabs.io/v1/mcp", auth: "oauth", newTools: "trust", toolRisk: {}, secrets: [] });
});

const stdioServer = (changes: Partial<McpServerView> = {}): McpServerView => ({
  id: "mcp-abcd1234",
  name: "github",
  enabled: true,
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
  newTools: "review",
  toolRisk: { search_issues: "read" },
  secretNames: ["GITHUB_TOKEN", "GITHUB_HOST"],
  ...changes,
});

const httpServer = (changes: Partial<McpServerView> = {}): McpServerView => ({
  id: "mcp-efgh5678",
  name: "docs",
  enabled: true,
  transport: "http",
  url: "https://example.com/mcp",
  newTools: "trust",
  toolRisk: {},
  secretNames: ["Authorization"],
  ...changes,
});

function requestOf(draft: McpDraft) {
  const request = mcpSaveRequest(draft);
  assert.ok(request.ok, request.ok ? "" : request.message);
  return request.save;
}

test("arguments are one per line, without blank lines or the space around them", () => {
  assert.deepEqual(argumentsFromText("-y\r\n  @scope/pkg  \n\n C:\\Users\\me\\My Files \n"), ["-y", "@scope/pkg", "C:\\Users\\me\\My Files"]);
  assert.deepEqual(argumentsFromText(""), []);
});

test("an untouched saved server sends its secrets by name only, so every saved value is kept", () => {
  const save = requestOf(mcpDraftFrom(stdioServer()));
  assert.deepEqual(save.secrets, [{ name: "GITHUB_TOKEN" }, { name: "GITHUB_HOST" }]);
  assert.equal(save.id, "mcp-abcd1234");
  assert.deepEqual(save.args, ["-y", "@modelcontextprotocol/server-github"]);
  assert.equal(isMcpDraftDirty(mcpDraftFrom(stdioServer()), stdioServer()), false);
});

test("a new value replaces a saved secret, a removed row is left out, and a new row carries its value", () => {
  const draft = mcpDraftFrom(stdioServer());
  const [token] = draft.secrets.stdio;
  const edited: McpDraft = {
    ...draft,
    secrets: { ...draft.secrets, stdio: [{ ...token, value: " ghp_new " }, { key: "n", name: "LOG_LEVEL", value: "debug", saved: false }] },
  };
  assert.deepEqual(requestOf(edited).secrets, [{ name: "GITHUB_TOKEN", value: "ghp_new" }, { name: "LOG_LEVEL", value: "debug" }]);
  assert.equal(isMcpDraftDirty(edited, stdioServer()), true);
});

test("a half-filled new secret says what is missing, and an empty one is ignored", () => {
  const draft = mcpDraftFrom(stdioServer());
  const withRow = (name: string, value: string): McpDraft => ({
    ...draft, secrets: { ...draft.secrets, stdio: [...draft.secrets.stdio, { key: "n", name, value, saved: false }] },
  });
  assert.deepEqual(mcpSaveRequest(withRow("API_KEY", "")), { ok: false, message: "Enter a value for API_KEY." });
  assert.deepEqual(mcpSaveRequest(withRow("", "secret")), { ok: false, message: "Give each environment variable a name." });
  assert.deepEqual(requestOf(withRow("", "")).secrets, [{ name: "GITHUB_TOKEN" }, { name: "GITHUB_HOST" }]);
});

test("switching transport never sends one transport's saved secrets as the other's", () => {
  const draft = mcpDraftFrom(stdioServer());
  const switched: McpDraft = { ...draft, transport: "http", url: "https://example.com/mcp" };
  const save = requestOf(switched);
  assert.deepEqual(save.secrets, []);
  assert.equal(save.command, undefined);
  assert.equal(save.args, undefined);
  // Switching back finds the saved rows as they were.
  assert.deepEqual(requestOf({ ...switched, transport: "stdio" }).secrets, [{ name: "GITHUB_TOKEN" }, { name: "GITHUB_HOST" }]);
});

test("the shared parser's message reaches the page, and an http URL comes back normalized", () => {
  const bad = mcpSaveRequest({ ...emptyMcpDraft(), name: "GitHub", command: "npx" });
  assert.equal(bad.ok, false);
  assert.match(bad.ok ? "" : bad.message, /short name/);
  assert.equal(requestOf(mcpDraftFrom(httpServer({ url: "https://example.com/" }))).url, "https://example.com/");
  assert.equal(requestOf({ ...mcpDraftFrom(httpServer()), url: " https://EXAMPLE.com " }).url, "https://example.com/");
});

test("a risk changed and changed back is not a change", () => {
  const saved = stdioServer({ toolRisk: { b_tool: "mutation", a_tool: "read" } });
  const draft = mcpDraftFrom(saved);
  const rest = Object.fromEntries(Object.entries(draft.toolRisk).filter(([name]) => name !== "b_tool"));
  const reverted: McpDraft = { ...draft, toolRisk: { ...rest, b_tool: "mutation" } };
  assert.equal(isMcpDraftDirty(reverted, saved), false);
  assert.equal(isMcpDraftDirty({ ...draft, toolRisk: rest }, saved), true);
});

test("a new server is only worth asking about once something is typed", () => {
  assert.equal(isMcpDraftDirty(emptyMcpDraft(), undefined), false);
  assert.equal(isMcpDraftDirty({ ...emptyMcpDraft(), transport: "http" }, undefined), false);
  assert.equal(isMcpDraftDirty({ ...emptyMcpDraft(), command: "npx" }, undefined), true);
});

test("tool rows list what the test found, in the server's order, then saved choices it did not list", () => {
  // Built from entries: as a literal key, TypeScript reads `constructor` as Object's own.
  const toolRisk: Record<string, ToolRisk> = Object.fromEntries<ToolRisk>([["zeta", "irreversible"], ["read_file", "read"], ["constructor", "mutation"]]);
  const rows = mcpToolRows(
    [{ name: "write_file", description: "Writes", destructiveHint: true }, { name: "read_file", description: "Reads", readOnlyHint: true }],
    toolRisk,
  );
  assert.deepEqual(rows.map((row) => [row.name, row.risk, row.listed !== undefined]), [
    ["write_file", undefined, true],
    ["read_file", "read", true],
    ["constructor", "mutation", false],
    ["zeta", "irreversible", false],
  ]);
  // Before a test, the saved choices alone; a name like "constructor" is not mistaken for a choice.
  assert.deepEqual(mcpToolRows([{ name: "constructor", description: "" }], {}).map((row) => row.risk), [undefined]);
  assert.deepEqual(mcpToolRows(null, { a: "read" }).map((row) => row.name), ["a"]);
});

test("a server's row says what it runs or calls, and only the exceptions after that", () => {
  assert.equal(mcpServerDetail(stdioServer()), "npx -y @modelcontextprotocol/server-github · 1 tool set");
  assert.equal(mcpServerDetail(httpServer({ enabled: false })), "https://example.com/mcp · off");
  const long = mcpServerDetail(stdioServer({ toolRisk: {}, args: ["x".repeat(200)] }));
  assert.equal(long.length, 80);
  assert.ok(long.endsWith("…"));
});

test("Set to Read takes only the tools the server calls read-only, and keeps every choice already made", () => {
  const listed = [
    { name: "list_agents", description: "", readOnlyHint: true },
    { name: "get_voice", description: "", readOnlyHint: true },
    { name: "delete_agent", description: "", destructiveHint: true },
    { name: "text_to_speech", description: "" },
  ];
  const result = withReadOnlyHints(listed, { get_voice: "irreversible" });
  assert.deepEqual(result, { toolRisk: { get_voice: "irreversible", list_agents: "read" }, applied: 1 });
  assert.equal(withReadOnlyHints(null, {}).applied, 0, "nothing before a test has listed the tools");
});

test("an OAuth URL server saves its sign-in choice and client ID, and a program server never does", () => {
  const draft: McpDraft = { ...emptyMcpDraft(), name: "elevenlabs", transport: "http", url: "https://api.us.elevenlabs.io/v1/mcp", oauth: true, oauthClientId: " my-app " };
  const request = mcpSaveRequest(draft);
  assert.equal(request.ok, true);
  if (request.ok) {
    assert.equal(request.save.auth, "oauth");
    assert.equal(request.save.oauthClientId, "my-app");
  }
  const program = mcpSaveRequest({ ...draft, transport: "stdio", command: "npx" });
  assert.equal(program.ok && program.save.auth, undefined);
});
