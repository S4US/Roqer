import assert from "node:assert/strict";
import test from "node:test";

import {
  isCustomMcpCheckResult,
  isCustomMcpSettingsResult,
  normalizeCustomMcpSave,
} from "./custom-mcp";

const STDIO = { name: " Files ", enabled: true, transport: "stdio", command: " node ", args: ["server.js"] };
const HTTP = { name: "Remote", enabled: false, transport: "http", url: "https://mcp.example/tools" };

test("save requests normalize display fields and preserve write-only secret values", () => {
  assert.deepEqual(normalizeCustomMcpSave({
    ...STDIO, environment: { TOKEN: " secret " }, headers: null,
  }), {
    name: "Files", enabled: true, transport: "stdio", command: "node", args: ["server.js"],
    environment: { TOKEN: " secret " }, headers: null,
  });
  assert.deepEqual(normalizeCustomMcpSave({ ...STDIO, args: undefined }), {
    name: "Files", enabled: true, transport: "stdio", command: "node", args: [],
  });
  assert.deepEqual(normalizeCustomMcpSave({ ...HTTP, url: " https://mcp.example/tools " }), HTTP);
});

test("HTTP endpoints allow TLS or loopback and refuse plaintext network addresses and inline credentials", () => {
  for (const url of ["http://localhost:8000/mcp", "http://127.0.0.1:8000/mcp", "http://127.3.4.5/mcp", "http://[::1]:8000/mcp"]) {
    assert.equal(normalizeCustomMcpSave({ ...HTTP, url }).url, url);
  }
  for (const url of ["http://10.0.0.1/mcp", "http://192.168.1.1/mcp", "http://mcp.example/mcp", "ftp://localhost/mcp",
    "https://name:secret@mcp.example/mcp", "https://mcp.example/mcp#fragment", "https://mcp.example/mcp#",
    "https://mcp.example/\npath"]) {
    assert.throws(() => normalizeCustomMcpSave({ ...HTTP, url }), /URL|HTTPS|credentials|fragment|address/i, url);
  }
});

test("malformed commands, mixed transports and oversized payloads are refused", () => {
  for (const payload of [
    { ...STDIO, command: " " }, { ...STDIO, command: "node\nother" }, { ...STDIO, args: "server.js" },
    { ...STDIO, args: ["bad\0argument"] }, { ...STDIO, args: Array(65).fill("a") },
    { ...STDIO, command: "n".repeat(1_025) }, { ...STDIO, name: "n".repeat(61) },
    { ...STDIO, enabled: "yes" }, { ...STDIO, transport: "sse" }, { ...STDIO, url: HTTP.url },
    { ...HTTP, command: "node" }, { ...HTTP, args: [] }, { ...HTTP, extra: true },
    { ...HTTP, url: `https://mcp.example/${"a".repeat(2_048)}` }, { ...STDIO, id: "bad/id" },
  ]) assert.throws(() => normalizeCustomMcpSave(payload), Error);
});

test("null and sparse argument arrays cannot become malformed saved configurations", () => {
  assert.throws(() => normalizeCustomMcpSave({ ...STDIO, args: null }), /arguments/i);
  assert.throws(() => normalizeCustomMcpSave({ ...STDIO, args: new Array(2) }), /arguments/i);
});

test("secret maps reject prototype keys, malformed names, header injection and size overflow", () => {
  for (const payload of [
    { ...STDIO, environment: JSON.parse('{"__proto__":"secret"}') },
    { ...STDIO, environment: { constructor: "secret" } },
    { ...STDIO, environment: { "BAD-NAME": "secret" } },
    { ...STDIO, environment: { TOKEN: 5 } },
    { ...STDIO, environment: { TOKEN: "bad\0value" } },
    { ...STDIO, environment: { TOKEN: "a".repeat(4_097) } },
    { ...HTTP, headers: { "Bad Header": "secret" } },
    { ...HTTP, headers: { Authorization: "Bearer token\r\nInjected: value" } },
    { ...HTTP, headers: { Authorization: "a", authorization: "b" } },
    { ...HTTP, headers: { prototype: "secret" } },
    { ...HTTP, headers: Array(2).fill("value") },
  ]) assert.throws(() => normalizeCustomMcpSave(payload), /environment|header|secret/i);
});

test("result guards accept bounded redacted views and reject secrets and malformed check results", () => {
  const view = {
    id: "mcp-abcd1234", name: "Files", enabled: true, transport: "stdio", command: "node", args: [],
    environmentKeys: ["TOKEN"], headerKeys: [],
  };
  assert.equal(isCustomMcpSettingsResult({ ok: true, connections: [view] }), true);
  assert.equal(isCustomMcpSettingsResult({ ok: false, message: "Unavailable" }), true);
  for (const result of [
    { ok: true, connections: [{ ...view, environment: { TOKEN: "secret" } }] },
    { ok: true, connections: [{ ...view, encryptedEnvironment: "ciphertext" }] },
    { ok: true, connections: [{ ...view, environmentKeys: ["__proto__"] }] },
    { ok: true, connections: Array(17).fill(view) },
    { ok: true, connections: new Array(1) },
    { ok: true, connections: [view, view] },
    { ok: false, message: 5 },
  ]) assert.equal(isCustomMcpSettingsResult(result), false);
  assert.equal(isCustomMcpCheckResult({ ok: true, tools: 0, message: "Connected" }), true);
  assert.equal(isCustomMcpCheckResult({ ok: false, message: "Failed" }), true);
  for (const tools of [-1, 1.5, Infinity, "2"]) {
    assert.equal(isCustomMcpCheckResult({ ok: true, tools, message: "Connected" }), false);
  }
  assert.equal(isCustomMcpCheckResult({ ok: true, message: "Connected" }), false);
});
