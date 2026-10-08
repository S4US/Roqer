import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport, type Tool, type Transport } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import type { ResolvedCustomMcpConnection } from "./custom-mcp-store";
import type { McpCallOptions, McpToolCaller, McpToolOutcome } from "./mcp-types";
import { parseCustomMcpToolIdentity } from "../shared/custom-mcp-identity";

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_TOOLS = 128;
const MAX_CATALOG_CHARS = 512_000;
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 24_000;

export function customMcpConnectionKey(value: ResolvedCustomMcpConnection): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Refuse redirects and bound JSON and SSE bodies before the SDK parses them. */
const boundedFetch: typeof fetch = async (input, init) => {
  const signal = init?.method === "DELETE"
    ? AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(2_000)]) : init?.signal;
  const response = await fetch(input, { ...init, signal, redirect: "error" });
  if (!response.body) return response;
  const reader = response.body.getReader();
  let bytes = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) { controller.close(); return; }
        bytes += item.value.byteLength;
        if (bytes > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new Error("The MCP response exceeded 10 MiB.");
        }
        controller.enqueue(item.value);
      } catch (error) { controller.error(error); }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

type Session = { client: Client; transport: Transport; tools: Map<string, Tool> };
export type CustomMcpCatalog = { server: string; name: string; tools: Array<{ name: string; description?: string }>; message?: string };

/** Run-scoped protocol clients. Nothing in this class grants tool permissions. */
export class CustomMcpManager implements McpToolCaller {
  readonly key: string;
  private readonly connections: Map<string, ResolvedCustomMcpConnection>;
  private readonly sessions = new Map<string, Promise<Session>>();
  private readonly clients = new Set<Client>();
  private readonly lifetime = new AbortController();
  private readonly isCurrent: (id: string, key: string) => Promise<boolean>;
  private readonly secrets: readonly string[];

  constructor(options: {
    connections: readonly ResolvedCustomMcpConnection[];
    isCurrent?: (id: string, key: string) => Promise<boolean>;
  }) {
    this.connections = new Map(options.connections.filter((value) => value.connection.enabled).map((value) => [value.connection.id, value]));
    this.key = [...this.connections.values()].map(customMcpConnectionKey).join(":");
    this.isCurrent = options.isCurrent ?? (async () => true);
    this.secrets = [...this.connections.values()].flatMap((value) => [
      ...Object.values(value.environment), ...Object.values(value.headers),
      ...Object.values(value.headers).flatMap((header) => /^Bearer\s+(.+)$/i.exec(header)?.slice(1) ?? []),
    ]).filter(Boolean).sort((a, b) => b.length - a.length);
  }

  get enabled(): boolean { return this.connections.size > 0; }

  private redact(value: string): string {
    for (const secret of this.secrets) value = value.split(secret).join("[redacted]");
    return value;
  }

  private safeJson(value: unknown): string {
    return JSON.stringify(value, (_key, item: unknown) => typeof item === "string" ? this.redact(item) : item);
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
  }

  private async current(id: string, signal?: AbortSignal): Promise<ResolvedCustomMcpConnection> {
    this.signal(signal).throwIfAborted();
    const value = this.connections.get(id);
    if (!value || !await this.isCurrent(id, customMcpConnectionKey(value))) {
      throw new Error("This MCP connection changed or was disabled. Start a new run to use its current settings.");
    }
    this.signal(signal).throwIfAborted();
    return value;
  }

  private async session(id: string, signal?: AbortSignal): Promise<Session> {
    const value = await this.current(id, signal);
    let pending = this.sessions.get(id);
    if (!pending) {
      pending = this.open(value, this.signal(signal));
      this.sessions.set(id, pending);
      void pending.catch(() => { if (this.sessions.get(id) === pending) this.sessions.delete(id); });
    }
    const session = await pending;
    await this.current(id, signal);
    return session;
  }

  private async open(value: ResolvedCustomMcpConnection, signal: AbortSignal): Promise<Session> {
    const { connection } = value;
    const client = new Client({ name: "roqer-custom-mcp", version: "1.0.0" }, { capabilities: {} });
    // SDK stdio uses shell:false and windowsHide:true on Windows, including npm shims.
    const transport = connection.transport === "stdio"
      ? new StdioClientTransport({ command: connection.command!, args: [...(connection.args ?? [])],
        env: { ...getDefaultEnvironment(), ...value.environment }, stderr: "ignore", maxBufferSize: MAX_RESPONSE_BYTES })
      : new StreamableHTTPClientTransport(new URL(connection.url!), {
        requestInit: { headers: value.headers }, fetch: boundedFetch,
        reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 0, initialReconnectionDelay: 0, reconnectionDelayGrowFactor: 1 },
      });
    this.clients.add(client);
    try {
      await client.connect(transport, { signal, timeout: CONNECT_TIMEOUT_MS });
      const tools = new Map<string, Tool>();
      const cursors = new Set<string>();
      let cursor: string | undefined;
      let chars = 0;
      for (let page = 0; page < 8; page++) {
        const result = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: CONNECT_TIMEOUT_MS });
        for (const tool of result.tools) {
          chars += JSON.stringify(tool).length;
          if (tools.size >= MAX_TOOLS || chars > MAX_CATALOG_CHARS || tool.name.length > 128
            || !tool.name || tools.has(tool.name) || JSON.stringify(tool.inputSchema).length > 64_000) {
            throw new Error("The MCP tool catalog is too large or contains duplicate or invalid tool names.");
          }
          tools.set(tool.name, tool);
        }
        cursor = result.nextCursor;
        if (!cursor) return { client, transport, tools };
        if (cursors.has(cursor)) throw new Error("The MCP server repeated its tool-list cursor.");
        cursors.add(cursor);
      }
      throw new Error("The MCP tool catalog exceeded eight pages.");
    } catch (error) {
      this.clients.delete(client);
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
      throw error;
    }
  }

  async list(signal?: AbortSignal): Promise<CustomMcpCatalog[]> {
    return Promise.all([...this.connections.values()].map(async ({ connection }) => {
      try {
        const session = await this.session(connection.id, signal);
        return { server: connection.id, name: connection.name, tools: [...session.tools.values()].map((tool) => ({
          name: tool.name, ...(tool.description ? { description: this.redact(tool.description).slice(0, 512) } : {}),
        })) };
      } catch (error) {
        this.signal(signal).throwIfAborted();
        return { server: connection.id, name: connection.name, tools: [], message: this.error(error) };
      }
    }));
  }

  async describe(server: string, tool: string, signal?: AbortSignal): Promise<Tool> {
    const session = await this.session(server, signal);
    const found = session.tools.get(tool);
    if (!found) throw new Error("This tool was not discovered on the selected MCP server.");
    return JSON.parse(this.safeJson(found)) as Tool;
  }

  private error(error: unknown): string {
    return this.redact(error instanceof Error ? error.message : "The MCP connection failed.").slice(0, 1_000);
  }

  async callTool(identity: string, args: Record<string, unknown>, options: McpCallOptions = {}): Promise<McpToolOutcome> {
    const started = Date.now();
    const signal = this.signal(options.signal);
    try {
      const parsed = parseCustomMcpToolIdentity(identity);
      if (!parsed) throw new Error("Invalid external MCP tool identity.");
      const session = await this.session(parsed.server, signal);
      if (!session.tools.has(parsed.tool)) throw new Error("This tool was not discovered on the selected MCP server.");
      await this.current(parsed.server, signal);
      const result = await session.client.callTool({ name: parsed.tool, arguments: args }, { signal, timeout: options.timeoutMs ?? 35_000 });
      const text = result.content.flatMap((block) => block.type === "text" ? [this.redact(block.text)] : []).join("\n").slice(0, MAX_TEXT_CHARS);
      const data: unknown = result.structuredContent === undefined ? undefined : JSON.parse(this.safeJson(result.structuredContent));
      const images = result.content.flatMap((block) => block.type === "image" && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.mimeType)
        && block.data.length <= 2 * 1024 * 1024 && block.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(block.data)
        ? [{ data: block.data, mediaType: block.mimeType as "image/png" | "image/jpeg" | "image/webp" | "image/gif" }] : []).slice(0, 4);
      const ok = result.isError !== true;
      return { ok, data, text, ...(images.length ? { images } : {}), httpStatus: 200,
        ...(ok ? {} : { errorCode: "tool_failed", message: text || "The MCP tool reported a failure." }), durationMs: Date.now() - started };
    } catch (error) {
      const message = signal.aborted ? "The MCP request was cancelled." : this.error(error);
      return { ok: false, data: undefined, text: message, message, httpStatus: 0,
        errorCode: signal.aborted ? "aborted" : "custom_mcp_failed", durationMs: Date.now() - started };
    }
  }

  async close(): Promise<void> {
    this.lifetime.abort();
    await Promise.allSettled([...this.sessions.values()].map(async (pending) => {
      const session = await pending;
      if (session.transport instanceof StreamableHTTPClientTransport) await session.transport.terminateSession();
    }));
    await Promise.allSettled([...this.clients].map((client) => client.close()));
    await Promise.allSettled([...this.sessions.values()]);
    this.clients.clear(); this.sessions.clear();
  }
}

export function withCustomMcp(caller: McpToolCaller, manager: CustomMcpManager): McpToolCaller {
  return { callTool: (tool, args, options) => parseCustomMcpToolIdentity(tool)
    ? manager.callTool(tool, args, options) : caller.callTool(tool, args, options) };
}
