import { resolveMcpAuthToken } from "./auth-token";
import {
  McpEndpointError,
  type McpCallOptions,
  type McpHealth,
  type McpInstance,
  type McpToolCaller,
  type McpToolImage,
  type McpToolOutcome,
} from "./mcp-types";

/**
 * Talks to the MCP server's plain HTTP surface (packages/core/src/http-server.ts):
 * `GET /health` with no auth, and `POST /mcp/<tool>` with a JSON argument body
 * and an `X-MCP-Auth` header. There is no JSON-RPC envelope and no session
 * handshake, so this client is intentionally a thin, defensive HTTP wrapper
 * rather than a generic MCP protocol client.
 */

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_HEALTH_TIMEOUT_MS = 2000;
const MAX_TOOL_IMAGES = 4;
// capture_screenshot caps encoded bytes at 6 MiB. Standard base64 expands
// that to at most 8 MiB, which keeps this parser aligned with the local MCP
// transport while still refusing an unbounded response from a bad endpoint.
const MAX_TOOL_IMAGE_BASE64 = 8 * 1024 * 1024;
const TOOL_IMAGE_MEDIA_TYPES = new Set<McpToolImage["mediaType"]>([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/** Throws McpEndpointError when the value is not an http loopback URL. */
export function normalizeEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new McpEndpointError(`"${value}" is not a valid URL.`);
  }
  if (url.protocol !== "http:") {
    throw new McpEndpointError(`MCP endpoint must use http:, got "${url.protocol}" in "${value}".`);
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) {
    throw new McpEndpointError(`MCP endpoint must be a loopback address, got "${url.hostname}" in "${value}".`);
  }
  return url;
}

export type McpClientOptions = {
  endpoint: string;
  /** Defaults to resolveMcpAuthToken(). Pass explicitly in tests. */
  authToken?: string;
  /** Per-call timeout, default 20000. Health uses healthTimeoutMs, default 2000. */
  timeoutMs?: number;
  healthTimeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * What to say about a request that never got an answer.
 *
 * Node's fetch reports every transport failure as "fetch failed" and keeps the
 * reason on `cause`. The reason is the whole message: "nothing is listening"
 * and "the connection was cut" are different situations, and a run record
 * that says "fetch failed" for both tells the reader nothing about either.
 */
export function describeRequestFailure(error: unknown, endpoint: string): string {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const code = isRecord(cause) && typeof cause.code === "string" ? cause.code : undefined;
  switch (code) {
    case "ECONNREFUSED":
      return `Nothing is listening at ${endpoint}.`;
    case "ECONNRESET":
    case "EPIPE":
    case "UND_ERR_SOCKET":
      return `The connection to ${endpoint} was closed before it answered.`;
    default: {
      const message = cause instanceof Error ? cause.message : "";
      return message.length === 0 || message === "fetch failed"
        ? `The request to ${endpoint} failed.`
        : message;
    }
  }
}

function isToolImage(
  value: unknown,
): value is Record<string, unknown> & { data: string; mimeType: McpToolImage["mediaType"] } {
  if (!isRecord(value) || value.type !== "image" || typeof value.data !== "string" ||
    typeof value.mimeType !== "string" || !TOOL_IMAGE_MEDIA_TYPES.has(value.mimeType as McpToolImage["mediaType"])) {
    return false;
  }
  return value.data.length > 0 && value.data.length <= MAX_TOOL_IMAGE_BASE64 &&
    value.data.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.data);
}

function isValidInstance(value: unknown): value is McpInstance {
  return (
    isRecord(value) &&
    typeof value.instanceId === "string" &&
    typeof value.role === "string" &&
    typeof value.placeId === "number" &&
    typeof value.isRunning === "boolean" &&
    (value.placeName === undefined || typeof value.placeName === "string") &&
    (value.dataModelName === undefined || typeof value.dataModelName === "string") &&
    (value.pluginVersion === undefined || typeof value.pluginVersion === "string")
  );
}

type ComposedSignal = {
  signal: AbortSignal;
  /** True once the timeout (rather than the caller) triggered the abort. */
  didTimeout: () => boolean;
  cleanup: () => void;
};

/** Combines a per-call timeout with an optional caller signal into one AbortSignal. */
function composeTimeoutSignal(timeoutMs: number, callerSignal?: AbortSignal): ComposedSignal {
  const timeoutController = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    timeoutController.abort();
  }, timeoutMs);

  const signals = callerSignal ? [timeoutController.signal, callerSignal] : [timeoutController.signal];

  let signal: AbortSignal;
  let disposeListeners: () => void = () => {};

  if (typeof AbortSignal.any === "function") {
    signal = AbortSignal.any(signals);
  } else {
    const manualController = new AbortController();
    const removers: Array<() => void> = [];
    for (const source of signals) {
      if (source.aborted) {
        manualController.abort(source.reason);
        break;
      }
      const onAbort = () => manualController.abort(source.reason);
      source.addEventListener("abort", onAbort, { once: true });
      removers.push(() => source.removeEventListener("abort", onAbort));
    }
    signal = manualController.signal;
    disposeListeners = () => {
      for (const remove of removers) remove();
    };
  }

  return {
    signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      disposeListeners();
    },
  };
}

export class McpClient implements McpToolCaller {
  /** Normalized origin, e.g. "http://127.0.0.1:58741" */
  readonly endpoint: string;
  /** Present when the caller named a token, holding it even when undefined. */
  private readonly givenToken?: { readonly value: string | undefined };
  private foundToken?: string;
  private readonly timeoutMs: number;
  private readonly healthTimeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: McpClientOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint).origin;
    // An explicitly-passed key (including `authToken: undefined`) always wins,
    // even over the empty string, so tests can force "no token" deterministically
    // instead of falling through to whatever happens to be on this machine.
    this.givenToken = "authToken" in options ? { value: options.authToken } : undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? DEFAULT_HEALTH_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * The token to send, resolved when it is needed rather than when this client
   * was built.
   *
   * The bridge mints `~/.robloxstudio-mcp/auth-token` on its first run, and this
   * client only ever reads it. Resolving once in the constructor meant a client
   * built before the file existed held "no token" for the life of the app, and
   * the one client Roqer keeps per endpoint is first built by the startup probe
   * that runs before any bridge is up. On a machine that had never run the
   * bridge -- which is to say every new customer's -- that was a permanent 401
   * on the first tool call, behind a health check that needs no auth and so
   * reported everything as fine.
   *
   * Memoized once a token is actually found, so the common path reads the file
   * once. Nothing is memoized while it is missing, because missing is the state
   * the next call may find has changed.
   */
  private authToken(): string | undefined {
    if (this.givenToken !== undefined) return this.givenToken.value;
    if (this.foundToken !== undefined) return this.foundToken;
    this.foundToken = resolveMcpAuthToken().token;
    return this.foundToken;
  }

  async health(signal?: AbortSignal): Promise<McpHealth> {
    const composed = composeTimeoutSignal(this.healthTimeoutMs, signal);
    try {
      const response = await this.fetchImpl(`${this.endpoint}/health`, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: composed.signal,
      });
      if (!response.ok) {
        return this.unreachableHealth("MCP is not running");
      }
      const body: unknown = await response.json().catch(() => undefined);
      return this.parseHealth(body);
    } catch {
      return this.unreachableHealth(composed.didTimeout() ? "Connection timed out" : "MCP is not running");
    } finally {
      composed.cleanup();
    }
  }

  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: McpCallOptions = {},
  ): Promise<McpToolOutcome> {
    const timeoutMs = options.timeoutMs ?? this.timeoutMs;
    const composed = composeTimeoutSignal(timeoutMs, options.signal);
    const startedAt = Date.now();

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      const token = this.authToken();
      if (token) headers["X-MCP-Auth"] = token;

      const response = await this.fetchImpl(`${this.endpoint}/mcp/${tool}`, {
        method: "POST",
        headers,
        body: JSON.stringify(args ?? {}),
        signal: composed.signal,
      });

      const durationMs = Date.now() - startedAt;
      const rawText = await response.text();
      let body: unknown;
      try {
        body = rawText.length > 0 ? JSON.parse(rawText) : undefined;
      } catch {
        body = undefined;
      }

      if (!response.ok) {
        const errorBody = isRecord(body) ? body : undefined;
        const errorCode = typeof errorBody?.error === "string" ? errorBody.error : `http_${response.status}`;
        const message =
          typeof errorBody?.message === "string" ? errorBody.message : `Request failed with status ${response.status}.`;
        return {
          ok: false,
          data: undefined,
          text: "",
          httpStatus: response.status,
          errorCode,
          message,
          durationMs,
        };
      }

      return this.parseSuccessBody(body, response.status, durationMs);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      if (composed.didTimeout()) {
        return {
          ok: false,
          data: undefined,
          text: "",
          httpStatus: 0,
          errorCode: "timeout",
          message: `${tool} did not answer within ${Math.round(timeoutMs / 1000)}s and was given up on.`,
          durationMs,
        };
      }
      if (options.signal?.aborted || isAbortError(error)) {
        return {
          ok: false,
          data: undefined,
          text: "",
          httpStatus: 0,
          errorCode: "aborted",
          message: "Request was cancelled.",
          durationMs,
        };
      }
      return {
        ok: false,
        data: undefined,
        text: "",
        httpStatus: 0,
        errorCode: "request_failed",
        message: describeRequestFailure(error, this.endpoint),
        durationMs,
      };
    } finally {
      composed.cleanup();
    }
  }

  private parseSuccessBody(body: unknown, httpStatus: number, durationMs: number): McpToolOutcome {
    const isEnvelope = isRecord(body) && Array.isArray(body.content);
    const envelope = isEnvelope ? (body as Record<string, unknown>) : undefined;

    let text = "";
    let data: unknown;

    if (envelope) {
      const texts: string[] = [];
      const images: McpToolImage[] = [];
      for (const block of envelope.content as unknown[]) {
        if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (images.length < MAX_TOOL_IMAGES && isToolImage(block)) {
          images.push({ data: block.data, mediaType: block.mimeType });
        }
      }
      text = texts.join("\n");
      data = envelope.structuredContent;
      return this.parsedOutcome(envelope, data, text, images, httpStatus, durationMs);
    } else {
      data = body;
    }

    return this.parsedOutcome(envelope, data, text, [], httpStatus, durationMs);
  }

  private parsedOutcome(
    envelope: Record<string, unknown> | undefined,
    data: unknown,
    text: string,
    images: readonly McpToolImage[],
    httpStatus: number,
    durationMs: number,
  ): McpToolOutcome {

    let ok = true;
    let errorCode: string | undefined;
    let message: string | undefined;

    if (envelope && envelope.isError === true) {
      ok = false;
    }
    if (isRecord(data) && data.success === false) {
      ok = false;
      if (typeof data.errorCode === "string") errorCode = data.errorCode;
      if (typeof data.message === "string") message = data.message;
    }
    // The plugin's own refusals come back as a 200 whose payload is `{error}`
    // with no `success` field: a parent that does not exist, a handler that
    // threw. Read as fine, `insert_asset` into a missing parent reached the run
    // record as a successful call, and the model saw `ok: true` beside an error
    // it had to notice for itself.
    if (isRecord(data) && typeof data.error === "string" && data.success !== true) {
      ok = false;
      message ??= typeof data.message === "string" ? data.message : data.error;
    }

    return {
      ok,
      data,
      text,
      ...(images.length > 0 ? { images } : {}),
      httpStatus,
      errorCode,
      message,
      durationMs,
    };
  }

  private unreachableHealth(message: string): McpHealth {
    return {
      reachable: false,
      pluginConnected: false,
      endpoint: this.endpoint,
      instanceCount: 0,
      instances: [],
      message,
    };
  }

  private parseHealth(body: unknown): McpHealth {
    if (!isRecord(body)) return this.unreachableHealth("MCP is not running");

    const pluginConnected = body.pluginConnected === true;
    const instancesValue = body.instances;
    const rawInstances = Array.isArray(instancesValue) ? instancesValue : [];
    const instances = rawInstances.filter(isValidInstance);
    const instanceCount = typeof body.instanceCount === "number" ? body.instanceCount : instances.length;
    const serverVersion = typeof body.serverVersion === "string" ? body.serverVersion : undefined;

    return {
      reachable: true,
      pluginConnected,
      endpoint: this.endpoint,
      serverVersion,
      instanceCount,
      instances,
      message: pluginConnected ? "Connected" : "MCP is running, Studio plugin not connected",
    };
  }
}
