import type { TurnImageMediaType } from "./model-api/turn-contract";

/**
 * Types shared by the Roqer MCP client and everything that calls it.
 *
 * These live apart from the client implementation so the run engine can be
 * written and tested against the interface with a fake caller, without starting
 * an MCP server or Roblox Studio.
 */

/** One connected Roblox Studio instance, as reported by the MCP server. */
export type McpInstance = {
  instanceId: string;
  role: string;
  placeId: number;
  placeName?: string;
  dataModelName?: string;
  isRunning: boolean;
  pluginVersion?: string;
};

export type McpHealth = {
  reachable: boolean;
  pluginConnected: boolean;
  endpoint: string;
  serverVersion?: string;
  instanceCount: number;
  instances: McpInstance[];
  /** Human-readable status, safe to show in the interface. */
  message: string;
};

/** A validated image content block returned by an MCP tool. */
export type McpToolImage = {
  data: string;
  mediaType: TurnImageMediaType;
};

/**
 * The result of one tool call.
 *
 * `ok` is false for transport failures, non-2xx responses, MCP `isError`
 * results, and structured payloads that report `success: false` — the run
 * engine should never have to re-derive failure from the raw body.
 */
export type McpToolOutcome = {
  ok: boolean;
  /** Structured payload when the server returned one, otherwise undefined. */
  data: unknown;
  /** Concatenated text content blocks, empty when there were none. */
  text: string;
  /** Validated image content blocks. Kept out of renderer events and persisted history. */
  images?: readonly McpToolImage[];
  /** 0 when the request never reached the server. */
  httpStatus: number;
  /** e.g. "source_revision_conflict", "unauthorized", "request_failed". */
  errorCode?: string;
  message?: string;
  durationMs: number;
};

export type McpCallOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

/** The narrow surface the run engine depends on. */
export interface McpToolCaller {
  callTool(
    tool: string,
    args: Record<string, unknown>,
    options?: McpCallOptions,
  ): Promise<McpToolOutcome>;
}

/** Raised when an endpoint is not an HTTP loopback address. */
export class McpEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpEndpointError";
  }
}
