import assert from "node:assert/strict";
import test from "node:test";

import { startWorkbenchMcpServer, type WorkbenchMcpServerHandle } from "./workbench-mcp-server";

const TOOL = {
  name: "roblox_studio",
  description: "Test tool",
  inputSchema: { type: "object", properties: {}, additionalProperties: true },
};

type RpcResponse = {
  result?: {
    serverInfo?: { name: string };
    capabilities?: unknown;
    tools?: Array<{ name: string }>;
    content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
};

async function rpc(server: WorkbenchMcpServerHandle, body: unknown, token = server.token) {
  return fetch(server.url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function rpcJson(response: Response): Promise<RpcResponse> {
  return await response.json() as RpcResponse;
}

test("Roqer MCP server exposes bounded tools and routes calls by name", async () => {
  const seen: Array<{ name: string; args: Record<string, unknown> }> = [];
  const server = await startWorkbenchMcpServer({
    tools: [TOOL, { ...TOOL, name: "load_skill" }],
    invoke: async (name, args) => {
      seen.push({ name, args });
      return { ok: true, text: "{\"placeName\":\"Test\"}" };
    },
  });

  try {
    const initialize = await rpcJson(await rpc(server, { jsonrpc: "2.0", id: 0, method: "initialize", params: {} }));
    assert.equal(initialize.result?.serverInfo?.name, "studio-workbench");
    assert.deepEqual(initialize.result?.capabilities, { tools: {} });

    const list = await rpcJson(await rpc(server, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    assert.equal(list.result?.tools?.length, 2);
    assert.equal(list.result?.tools?.[0].name, "roblox_studio");

    const call = await rpcJson(await rpc(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "roblox_studio", arguments: { operation: "get_place_info", arguments: {} } },
    }));
    assert.equal(call.result?.isError, false);
    assert.equal(call.result?.content?.[0].text, "{\"placeName\":\"Test\"}");
    assert.deepEqual(seen, [{ name: "roblox_studio", args: { operation: "get_place_info", arguments: {} } }]);
  } finally {
    await server.close();
  }
});

test("Roqer MCP server returns Studio images as MCP image content", async () => {
  const image = Buffer.from("studio screenshot").toString("base64");
  const server = await startWorkbenchMcpServer({
    tools: [TOOL],
    invoke: async () => ({
      ok: true,
      text: "Screenshot 800x600",
      images: [{ data: image, mediaType: "image/jpeg" }],
    }),
  });

  try {
    const call = await rpcJson(await rpc(server, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "roblox_studio", arguments: { operation: "capture_screenshot", arguments: {} } },
    }));
    assert.deepEqual(call.result?.content, [
      { type: "text", text: "Screenshot 800x600" },
      { type: "image", data: image, mimeType: "image/jpeg" },
    ]);
  } finally {
    await server.close();
  }
});

test("Roqer MCP server reports a failed tool as a tool error, not a transport error", async () => {
  const server = await startWorkbenchMcpServer({
    tools: [TOOL],
    invoke: async () => { throw new Error("Tool \"set_script_source\" was refused: user rejected"); },
  });

  try {
    const response = await rpc(server, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "roblox_studio", arguments: {} },
    });
    assert.equal(response.status, 200);
    const body = await rpcJson(response);
    assert.equal(body.result?.isError, true);
    assert.match(body.result?.content?.[0].text ?? "", /was refused/);
  } finally {
    await server.close();
  }
});

test("Roqer MCP server refuses requests without the bearer token or from a browser", async () => {
  const server = await startWorkbenchMcpServer({
    tools: [TOOL],
    invoke: async () => ({ ok: true, text: "" }),
  });

  try {
    const unauthenticated = await fetch(server.url, { method: "POST", body: "{}" });
    assert.equal(unauthenticated.status, 401);

    const wrongToken = await rpc(server, { jsonrpc: "2.0", id: 1, method: "tools/list" }, "not-the-token");
    assert.equal(wrongToken.status, 401);

    const crossOrigin = await fetch(server.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${server.token}`,
        origin: "https://example.com",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    assert.equal(crossOrigin.status, 403);

    // There is no server-initiated stream, so a client must not hold a GET open.
    const stream = await fetch(server.url, {
      headers: { authorization: `Bearer ${server.token}` },
    });
    assert.equal(stream.status, 405);
  } finally {
    await server.close();
  }
});

test("Roqer MCP server answers notifications without a body and unknown methods with an error", async () => {
  const server = await startWorkbenchMcpServer({
    tools: [TOOL],
    invoke: async () => ({ ok: true, text: "" }),
  });

  try {
    const notification = await rpc(server, { jsonrpc: "2.0", method: "notifications/initialized" });
    assert.equal(notification.status, 202);

    const unsupported = await rpcJson(await rpc(server, { jsonrpc: "2.0", id: 7, method: "server/discover" }));
    assert.equal(unsupported.error?.code, -32601);
  } finally {
    await server.close();
  }
});
