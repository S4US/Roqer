import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";

import type { McpToolImage } from "./mcp-types";

/**
 * A loopback MCP server that exposes a bounded set of Roqer tools.
 *
 * Providers that speak MCP rather than a private tool protocol — Claude Code is
 * the first — get their Studio access through here. The server is deliberately
 * tiny: tools only, no resources, prompts, or server-initiated messages. It
 * exists so a provider process can reach `PlannerContext.call` without ever
 * reaching the Roblox MCP bridge itself, which is what keeps policy, approvals,
 * and the bridge credential inside Roqer.
 *
 * Every request must carry the bearer token minted for this instance, the
 * listener is bound to 127.0.0.1, and any request carrying an `Origin` header
 * is refused, so a page in a browser on the same machine cannot drive it.
 */

type JsonRecord = Record<string, unknown>;

/** Pinned rather than echoed: this server implements exactly this revision. */
const PROTOCOL_VERSION = "2025-06-18";
const MAX_BODY_BYTES = 1024 * 1024;

export type WorkbenchMcpTool = {
  name: string;
  description: string;
  inputSchema: JsonRecord;
};

export type WorkbenchMcpToolResult = { ok: boolean; text: string; images?: readonly McpToolImage[] };

export type WorkbenchMcpServerOptions = {
  tools: readonly WorkbenchMcpTool[];
  /**
   * Runs the tool. A rejection is reported to the model as a tool error rather
   * than a transport failure, so the model can recover or explain.
   */
  invoke: (name: string, args: JsonRecord) => Promise<WorkbenchMcpToolResult>;
};

export type WorkbenchMcpServerHandle = {
  /** The endpoint to hand a provider, e.g. http://127.0.0.1:54321/mcp */
  url: string;
  /** Bearer token the provider must send on every request. */
  token: string;
  close(): Promise<void>;
};

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function tokenMatches(header: string | undefined, token: string): boolean {
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(token);
  // timingSafeEqual throws on a length mismatch, which would itself leak length.
  if (supplied.length !== expected.length) return false;
  return timingSafeEqual(supplied, expected);
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("The MCP request body was too large."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function send(response: ServerResponse, status: number, payload?: JsonRecord): void {
  if (payload === undefined) {
    response.writeHead(status);
    response.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  response.writeHead(status, { "content-type": "application/json", "content-length": String(body.length) });
  response.end(body);
}

/** Start the server. Resolves once it is listening and ready for a provider. */
export async function startWorkbenchMcpServer(
  options: WorkbenchMcpServerOptions,
): Promise<WorkbenchMcpServerHandle> {
  if (options.tools.length === 0 || options.tools.length > 8) {
    throw new Error("Roqer MCP must expose between one and eight tools.");
  }
  const tools = new Map(options.tools.map((tool) => [tool.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("Roqer MCP tool names must be unique.");
  const token = randomBytes(32).toString("base64url");
  const sockets = new Set<import("node:net").Socket>();

  const server: Server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, { error: "Malformed MCP request." });
      else response.end();
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // A browser page is the only thing that sends Origin. A provider process
    // does not, so refusing it costs nothing and blocks DNS rebinding.
    if (request.headers.origin !== undefined) {
      send(response, 403, { error: "Cross-origin requests are not allowed." });
      return;
    }
    if (!tokenMatches(request.headers.authorization, token)) {
      send(response, 401, { error: "Unauthorized." });
      return;
    }
    const path = (request.url ?? "").split("?")[0];
    if (path !== "/mcp") {
      send(response, 404, { error: "Not found." });
      return;
    }
    if (request.method !== "POST") {
      // No server-initiated stream: clients must not hold a GET open for one.
      response.writeHead(405, { allow: "POST" });
      response.end();
      return;
    }

    const body = await readBody(request);
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    if (!isRecord(message)) {
      send(response, 400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } });
      return;
    }

    const id = message.id;
    if (id === undefined || id === null) {
      // A notification, such as notifications/initialized. Nothing to answer.
      send(response, 202);
      return;
    }

    const method = typeof message.method === "string" ? message.method : "";
    const params = isRecord(message.params) ? message.params : {};

    if (method === "initialize") {
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "studio-workbench", title: "Roqer", version: "0.0.1" },
        },
      });
      return;
    }

    if (method === "ping") {
      send(response, 200, { jsonrpc: "2.0", id, result: {} });
      return;
    }

    if (method === "tools/list") {
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          tools: options.tools.map((tool) => ({
            name: tool.name, description: tool.description, inputSchema: tool.inputSchema,
          })),
        },
      });
      return;
    }

    if (method === "tools/call") {
      if (typeof params.name !== "string" || !tools.has(params.name)) {
        send(response, 200, {
          jsonrpc: "2.0",
          id,
          error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
        });
        return;
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      let result: WorkbenchMcpToolResult;
      try {
        result = await options.invoke(params.name, args);
      } catch (error) {
        result = { ok: false, text: error instanceof Error ? error.message : String(error) };
      }
      send(response, 200, {
        jsonrpc: "2.0",
        id,
        result: {
          content: [
            { type: "text", text: result.text },
            ...(result.images ?? []).map((image) => ({
              type: "image",
              data: image.data,
              mimeType: image.mediaType,
            })),
          ],
          isError: !result.ok,
        },
      });
      return;
    }

    send(response, 200, {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo | null;
  if (!address) {
    server.close();
    throw new Error("The Roqer MCP server could not be started.");
  }

  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    close: () => new Promise<void>((resolve) => {
      // Providers keep the connection alive, so idle sockets are destroyed
      // rather than waited on; otherwise close() never settles.
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      server.close(() => resolve());
    }),
  };
}
