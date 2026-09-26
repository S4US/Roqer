import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveMcpAuthToken } from "./auth-token";
import { describeRequestFailure, McpClient, normalizeEndpoint } from "./mcp-client";
import { McpEndpointError } from "./mcp-types";

// ---------------------------------------------------------------------------
// Test server helpers
// ---------------------------------------------------------------------------

type CapturedRequest = { headers: http.IncomingHttpHeaders; body: unknown };

function startServer(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void): Promise<{
  server: http.Server;
  endpoint: string;
}> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo | null;
      if (address === null) {
        reject(new Error("failed to bind test server"));
        return;
      }
      resolve({ server, endpoint: `http://127.0.0.1:${address.port}` });
    });
  });
}

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => {
    // Some tests deliberately never respond; drop any open sockets so close()
    // does not hang waiting for a connection that will never finish.
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

function readBody(req: http.IncomingMessage): Promise<CapturedRequest> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      resolve({ headers: req.headers, body });
    });
  });
}

function respondJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

// ---------------------------------------------------------------------------
// callTool: response shapes
// ---------------------------------------------------------------------------

test("callTool parses a bare structured payload as data", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, { source: "print('hi')", sourceRevision: "sr1:1:abc" });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("get_script_source", { instance_id: "x" });
    assert.equal(outcome.ok, true);
    assert.deepEqual(outcome.data, { source: "print('hi')", sourceRevision: "sr1:1:abc" });
    assert.equal(outcome.text, "");
    assert.equal(outcome.httpStatus, 200);
  } finally {
    await closeServer(server);
  }
});

test("callTool parses an envelope response, joining text blocks and lifting structuredContent", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, {
      content: [
        { type: "text", text: "line one" },
        { type: "text", text: "line two" },
      ],
      structuredContent: { foo: "bar" },
    });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("search_objects", {});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, "line one\nline two");
    assert.deepEqual(outcome.data, { foo: "bar" });
  } finally {
    await closeServer(server);
  }
});

test("callTool preserves validated MCP image blocks for the model", async () => {
  const image = Buffer.from("studio screenshot").toString("base64");
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, {
      content: [
        { type: "text", text: "Screenshot 800x600" },
        { type: "image", data: image, mimeType: "image/jpeg" },
        { type: "image", data: image, mimeType: "image/svg+xml" },
        { type: "image", data: "not base64", mimeType: "image/png" },
      ],
    });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("capture_screenshot", {});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.text, "Screenshot 800x600");
    assert.deepEqual(outcome.images, [{ data: image, mediaType: "image/jpeg" }]);
  } finally {
    await closeServer(server);
  }
});

test("callTool treats isError: true at HTTP 200 as a failure", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, { content: [{ type: "text", text: "boom" }], isError: true });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("execute_luau", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.httpStatus, 200);
    assert.equal(outcome.text, "boom");
  } finally {
    await closeServer(server);
  }
});

test("callTool lifts errorCode/message from a structured success:false payload", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, {
      success: false,
      errorCode: "source_revision_conflict",
      message: "Source changed since it was last read.",
      expectedRevision: "sr1:1:aaa",
      actualRevision: "sr1:2:bbb",
    });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("set_script_source", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, "source_revision_conflict");
    assert.equal(outcome.message, "Source changed since it was last read.");
    assert.equal((outcome.data as { actualRevision: string }).actualRevision, "sr1:2:bbb");
  } finally {
    await closeServer(server);
  }
});

test("callTool treats a plugin's bare {error} payload as a failure", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, { error: "Parent instance not found: game.Workspace.GoKart" });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("insert_asset", { assetId: 1, parentPath: "game.Workspace.GoKart" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, "Parent instance not found: game.Workspace.GoKart");
  } finally {
    await closeServer(server);
  }
});

test("callTool reads why from a failure the tool marked itself, as an upload Roblox refused", async () => {
  // Unwrapped to a bare object, this read as a successful upload: the run
  // record said ok, and the model guessed at the cause.
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, {
      content: [],
      structuredContent: { path: "operations/op-1", done: true, error: { code: "Internal", message: "Unknown Error" }, status: "failed" },
      isError: true,
    });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("upload_asset", { action: "status", operationId: "op-1" });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, "Unknown Error");
    assert.equal((outcome.data as { status: string }).status, "failed");
  } finally {
    await closeServer(server);
  }
});

test("callTool leaves an error field alone when the payload says it succeeded", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, { success: true, error: "a warning the tool chose to report" });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("get_place_info", {});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.message, undefined);
  } finally {
    await closeServer(server);
  }
});

test("callTool surfaces a non-2xx response with the server's error/message", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 401, { error: "unauthorized", message: "Missing or invalid token." });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("get_place_info", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.httpStatus, 401);
    assert.equal(outcome.errorCode, "unauthorized");
    assert.equal(outcome.message, "Missing or invalid token.");
  } finally {
    await closeServer(server);
  }
});

test("callTool tolerates a non-JSON error body", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    res.writeHead(500, { "Content-Type": "text/plain" });
    res.end("internal error");
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const outcome = await client.callTool("execute_luau", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.httpStatus, 500);
    assert.equal(outcome.errorCode, "http_500");
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Headers
// ---------------------------------------------------------------------------

test("callTool sends X-MCP-Auth when a token is configured, and omits it otherwise", async () => {
  let captured: CapturedRequest | undefined;
  const { server, endpoint } = await startServer(async (req, res) => {
    captured = await readBody(req);
    respondJson(res, 200, { ok: true });
  });
  try {
    const withToken = new McpClient({ endpoint, authToken: "secret-token-123" });
    await withToken.callTool("get_place_info", {});
    assert.equal(captured?.headers["x-mcp-auth"], "secret-token-123");

    const withoutToken = new McpClient({ endpoint, authToken: undefined });
    await withoutToken.callTool("get_place_info", {});
    assert.equal(captured?.headers["x-mcp-auth"], undefined);
  } finally {
    await closeServer(server);
  }
});

test("a client built before the bridge minted its token still authenticates", async () => {
  // Roqer keeps one client per endpoint and first builds it in the startup
  // probe, which runs before any bridge exists. On a machine that has never run
  // the bridge there is no token file yet, and resolving once at construction
  // left that client unauthenticated for the life of the app: a 401 on the
  // first tool call for every new customer, behind a health check that needs no
  // auth and so reported everything as fine.
  const previousToken = process.env.ROBLOX_STUDIO_AUTH_TOKEN;
  const previousNoAuth = process.env.ROBLOX_STUDIO_NO_AUTH;
  const captured: (string | string[] | undefined)[] = [];
  const { server, endpoint } = await startServer(async (req, res) => {
    captured.push((await readBody(req)).headers["x-mcp-auth"]);
    respondJson(res, 200, { ok: true });
  });
  try {
    // Nothing to resolve yet, whatever this machine happens to have on disk.
    process.env.ROBLOX_STUDIO_NO_AUTH = "1";
    const client = new McpClient({ endpoint });
    await client.callTool("get_place_info", {});
    assert.equal(captured[0], undefined);

    // The bridge comes up and mints one. The same client picks it up.
    delete process.env.ROBLOX_STUDIO_NO_AUTH;
    process.env.ROBLOX_STUDIO_AUTH_TOKEN = "minted-after-startup";
    await client.callTool("get_place_info", {});
    assert.equal(captured[1], "minted-after-startup");

    // And having found one, it stops looking: the file is read once, not once
    // per tool call, for the whole life of a working session.
    process.env.ROBLOX_STUDIO_AUTH_TOKEN = "rotated-behind-our-back";
    await client.callTool("get_place_info", {});
    assert.equal(captured[2], "minted-after-startup");
  } finally {
    if (previousToken === undefined) delete process.env.ROBLOX_STUDIO_AUTH_TOKEN;
    else process.env.ROBLOX_STUDIO_AUTH_TOKEN = previousToken;
    if (previousNoAuth === undefined) delete process.env.ROBLOX_STUDIO_NO_AUTH;
    else process.env.ROBLOX_STUDIO_NO_AUTH = previousNoAuth;
    await closeServer(server);
  }
});

test("an explicitly named token is still honoured, including no token at all", async () => {
  // Lazy resolution must not reopen the door the explicit option closes: a test
  // or caller that says "no token" gets no token, whatever is on this machine.
  const previousToken = process.env.ROBLOX_STUDIO_AUTH_TOKEN;
  const captured: (string | string[] | undefined)[] = [];
  const { server, endpoint } = await startServer(async (req, res) => {
    captured.push((await readBody(req)).headers["x-mcp-auth"]);
    respondJson(res, 200, { ok: true });
  });
  try {
    process.env.ROBLOX_STUDIO_AUTH_TOKEN = "would-be-resolved";
    await new McpClient({ endpoint, authToken: undefined }).callTool("get_place_info", {});
    assert.equal(captured[0], undefined);
    await new McpClient({ endpoint, authToken: "named-by-the-caller" }).callTool("get_place_info", {});
    assert.equal(captured[1], "named-by-the-caller");
  } finally {
    if (previousToken === undefined) delete process.env.ROBLOX_STUDIO_AUTH_TOKEN;
    else process.env.ROBLOX_STUDIO_AUTH_TOKEN = previousToken;
    await closeServer(server);
  }
});

test("callTool never sends an Origin header", async () => {
  let captured: CapturedRequest | undefined;
  const { server, endpoint } = await startServer(async (req, res) => {
    captured = await readBody(req);
    respondJson(res, 200, { ok: true });
  });
  try {
    const client = new McpClient({ endpoint, authToken: "irrelevant" });
    await client.callTool("get_place_info", {});
    assert.equal(captured?.headers.origin, undefined);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// Timeout / cancellation
// ---------------------------------------------------------------------------

test("callTool reports errorCode: timeout when the server never responds", async () => {
  const { server, endpoint } = await startServer((req) => {
    // Never call res.end(); clean up if the client gives up.
    req.on("close", () => {});
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined, timeoutMs: 50 });
    const outcome = await client.callTool("get_place_info", {});
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, "timeout");
    assert.equal(outcome.httpStatus, 0);
  } finally {
    await closeServer(server);
  }
});

test("callTool reports errorCode: aborted when the caller cancels mid-flight", async () => {
  const { server, endpoint } = await startServer((req, res) => {
    const timer = setTimeout(() => respondJson(res, 200, { ok: true }), 500);
    req.on("close", () => clearTimeout(timer));
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined, timeoutMs: 5000 });
    const controller = new AbortController();
    const pending = client.callTool("get_place_info", {}, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    const outcome = await pending;
    assert.equal(outcome.ok, false);
    assert.equal(outcome.errorCode, "aborted");
    assert.equal(outcome.httpStatus, 0);
  } finally {
    await closeServer(server);
  }
});

// ---------------------------------------------------------------------------
// health()
// ---------------------------------------------------------------------------

test("health parses connected instances", async () => {
  const { server, endpoint } = await startServer(async (req, res) => {
    await readBody(req);
    respondJson(res, 200, {
      status: "ok",
      pluginConnected: true,
      instanceCount: 2,
      serverVersion: "1.2.3",
      instances: [
        { instanceId: "a", role: "server", placeId: 1, isRunning: true },
        { instanceId: "b", role: "client", placeId: 1, isRunning: false, placeName: "Test" },
        // Malformed entries must be dropped, not thrown on.
        { instanceId: "c" },
        "not even an object",
      ],
    });
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined });
    const health = await client.health();
    assert.equal(health.reachable, true);
    assert.equal(health.pluginConnected, true);
    assert.equal(health.serverVersion, "1.2.3");
    assert.equal(health.instances.length, 2);
    assert.equal(health.instances[1].placeName, "Test");
  } finally {
    await closeServer(server);
  }
});

test("health does not send an auth header", async () => {
  let captured: http.IncomingHttpHeaders | undefined;
  const { server, endpoint } = await startServer((req, res) => {
    captured = req.headers;
    respondJson(res, 200, { pluginConnected: false, instanceCount: 0, instances: [] });
  });
  try {
    const client = new McpClient({ endpoint, authToken: "should-not-be-sent" });
    await client.health();
    assert.equal(captured?.["x-mcp-auth"], undefined);
  } finally {
    await closeServer(server);
  }
});

test("health returns reachable: false instead of throwing when nothing is listening", async () => {
  const { server, endpoint } = await startServer((req, res) => respondJson(res, 200, {}));
  await closeServer(server);

  const client = new McpClient({ endpoint, authToken: undefined, healthTimeoutMs: 500 });
  const health = await client.health();
  assert.equal(health.reachable, false);
  assert.equal(health.pluginConnected, false);
  assert.equal(health.instanceCount, 0);
  assert.deepEqual(health.instances, []);
  assert.ok(health.message.length > 0);
});

test("health distinguishes a timeout from a plain connection failure", async () => {
  const { server, endpoint } = await startServer((req) => {
    req.on("close", () => {});
    // never respond
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined, healthTimeoutMs: 50 });
    const health = await client.health();
    assert.equal(health.reachable, false);
    assert.equal(health.message, "Connection timed out");
  } finally {
    await closeServer(server);
  }
});

test("callTool says nothing is listening when nothing is, rather than undici's 'fetch failed'", async () => {
  const { server, endpoint } = await startServer((req, res) => respondJson(res, 200, {}));
  await closeServer(server);

  const client = new McpClient({ endpoint, authToken: undefined, timeoutMs: 2_000 });
  const result = await client.callTool("get_place_info", {});
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, "request_failed");
  assert.equal(result.httpStatus, 0);
  // This line ends up in the run record and in front of the model; "fetch
  // failed" told neither of them which side had gone.
  assert.equal(result.message, `Nothing is listening at ${endpoint}.`);
});

test("callTool says the connection was cut when the server drops it mid-request", async () => {
  const { server, endpoint } = await startServer((req) => {
    req.socket.destroy();
  });
  try {
    const client = new McpClient({ endpoint, authToken: undefined, timeoutMs: 2_000 });
    const result = await client.callTool("get_place_info", {});
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "request_failed");
    assert.equal(result.message, `The connection to ${endpoint} was closed before it answered.`);
  } finally {
    await closeServer(server);
  }
});

test("describeRequestFailure keeps a reason it does not recognise, and replaces one that says nothing", () => {
  const endpoint = "http://127.0.0.1:58741";
  const refused = new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:58741"), { code: "ECONNREFUSED" }) });
  assert.equal(describeRequestFailure(refused, endpoint), "Nothing is listening at http://127.0.0.1:58741.");
  const odd = new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }) });
  assert.equal(describeRequestFailure(odd, endpoint), "getaddrinfo ENOTFOUND");
  assert.equal(describeRequestFailure(new TypeError("fetch failed"), endpoint), "The request to http://127.0.0.1:58741 failed.");
  assert.equal(describeRequestFailure("not even an error", endpoint), "The request to http://127.0.0.1:58741 failed.");
});

// ---------------------------------------------------------------------------
// normalizeEndpoint
// ---------------------------------------------------------------------------

test("normalizeEndpoint accepts the three loopback spellings", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:58741").origin, "http://127.0.0.1:58741");
  assert.equal(normalizeEndpoint("http://localhost:58741").origin, "http://localhost:58741");
  assert.equal(normalizeEndpoint("http://[::1]:58741").hostname, "[::1]");
});

test("normalizeEndpoint rejects https", () => {
  assert.throws(() => normalizeEndpoint("https://127.0.0.1:58741"), McpEndpointError);
});

test("normalizeEndpoint rejects a non-loopback host", () => {
  assert.throws(() => normalizeEndpoint("http://example.com:58741"), McpEndpointError);
});

test("normalizeEndpoint rejects garbage", () => {
  assert.throws(() => normalizeEndpoint("not a url at all"), McpEndpointError);
});

// ---------------------------------------------------------------------------
// auth-token resolution (env / file / disabled / missing)
// ---------------------------------------------------------------------------

async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-mcp-auth-"));
  try {
    return await run(home);
  } finally {
    await fs.rm(home, { recursive: true, force: true });
  }
}

test("resolveMcpAuthToken returns missing when there is no env token and no file", async () => {
  await withTempHome(async (home) => {
    const resolved = resolveMcpAuthToken({}, home);
    assert.deepEqual(resolved, { source: "missing" });
  });
});

test("resolveMcpAuthToken reads and trims the env token", () => {
  const resolved = resolveMcpAuthToken({ ROBLOX_STUDIO_AUTH_TOKEN: "  abc123  " }, os.tmpdir());
  assert.equal(resolved.token, "abc123");
  assert.equal(resolved.source, "env");
});

test("resolveMcpAuthToken honors ROBLOX_STUDIO_NO_AUTH over an env token", () => {
  const resolved = resolveMcpAuthToken(
    { ROBLOX_STUDIO_NO_AUTH: "true", ROBLOX_STUDIO_AUTH_TOKEN: "should-be-ignored" },
    os.tmpdir(),
  );
  assert.deepEqual(resolved, { source: "disabled" });
});

test('resolveMcpAuthToken accepts "1" for ROBLOX_STUDIO_NO_AUTH', () => {
  const resolved = resolveMcpAuthToken({ ROBLOX_STUDIO_NO_AUTH: "1" }, os.tmpdir());
  assert.equal(resolved.source, "disabled");
});

test("resolveMcpAuthToken reads the token file when no env token is set", async () => {
  await withTempHome(async (home) => {
    const dir = path.join(home, ".robloxstudio-mcp");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "auth-token"), "file-token-value\n", "utf8");

    const resolved = resolveMcpAuthToken({}, home);
    assert.equal(resolved.token, "file-token-value");
    assert.equal(resolved.source, "file");
  });
});

test("resolveMcpAuthToken prefers the env token over the file", async () => {
  await withTempHome(async (home) => {
    const dir = path.join(home, ".robloxstudio-mcp");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "auth-token"), "file-token-value", "utf8");

    const resolved = resolveMcpAuthToken({ ROBLOX_STUDIO_AUTH_TOKEN: "env-token-value" }, home);
    assert.equal(resolved.token, "env-token-value");
    assert.equal(resolved.source, "env");
  });
});

test("resolveMcpAuthToken never creates the token file", async () => {
  await withTempHome(async (home) => {
    resolveMcpAuthToken({}, home);
    const exists = await fs
      .access(path.join(home, ".robloxstudio-mcp", "auth-token"))
      .then(() => true)
      .catch(() => false);
    assert.equal(exists, false);
  });
});
