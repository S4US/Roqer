import { TransientTurnError, type TurnMessage, type TurnToolCall } from "./turn-contract";

/**
 * Transport pieces shared by the adapters that talk to a user's own model
 * endpoint: Server-Sent Event framing, turning a refused request into a
 * message the user can act on, and telling a failure worth another attempt
 * from one that would only repeat.
 *
 * The endpoint and the key are the user's own, so the endpoint's own
 * explanation of a refusal is shown to them, with the key redacted in case the
 * endpoint echoed it.
 */

/** The longest an endpoint may send nothing: before it answers, and between chunks after. See `fetchWithin`. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const MAX_TOOL_CALLS_PER_TURN = 64;
export const MAX_TOOL_ARGUMENT_CHARACTERS = 262_144;
const MAX_ERROR_BODY_CHARACTERS = 4_000;
const MAX_ERROR_MESSAGE_CHARACTERS = 300;

/**
 * A stream that failed while it was being read: the connection reset, or it
 * was aborted. The transport that owns it knows which, and says so in its own
 * words; this only keeps the read failure apart from the transport's own
 * errors, which arrive through the same `for await`.
 */
export class StreamReadError extends Error {
  constructor(cause: unknown) {
    super("The model endpoint's stream could not be read.", { cause });
    this.name = "StreamReadError";
  }
}

/**
 * Split a byte stream into complete Server-Sent Event frames without unbounded
 * buffering. Line endings are normalized first: a local server that frames
 * with CRLF is still speaking SSE. `onChunk` hears every chunk that arrives,
 * which is what keeps an idle bound from ending a stream that is still flowing.
 */
export async function* serverSentFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBufferedChars: number,
  onChunk?: () => void,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throw new StreamReadError(error);
      }
      const { done, value } = chunk;
      if (done) break;
      if (signal.aborted) return;
      onChunk?.();
      buffered += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      if (buffered.length > maxBufferedChars) throw new Error("The model endpoint sent an oversized event.");
      let boundary = buffered.indexOf("\n\n");
      while (boundary !== -1) {
        yield buffered.slice(0, boundary);
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf("\n\n");
      }
    }
    if (buffered.trim().length > 0) yield buffered;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** The `data:` lines of one SSE frame, joined; `undefined` for a frame with none. */
export function frameData(frame: string): string | undefined {
  const lines = frame.split("\n").filter((line) => line.startsWith("data:"));
  if (lines.length === 0) return undefined;
  return lines.map((line) => line.slice(5).trimStart()).join("\n");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Remove the key from text an endpoint sent back, in case it quoted the request. */
export function redact(text: string, apiKey: string | null): string {
  let result = text;
  if (apiKey !== null && apiKey.length >= 8) result = result.split(apiKey).join("[key]");
  return Array.from(result, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("").trim();
}

/** The human part of an error body: `error.message`, `error` as a string, `message`, or the text itself. */
export function errorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (isRecord(parsed)) {
      const error = parsed.error;
      if (typeof error === "string") return error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof parsed.message === "string") return parsed.message;
      if (typeof parsed.detail === "string") return parsed.detail;
    }
  } catch {
    // Not JSON: the text itself is the best explanation available.
  }
  return body;
}

function statusHint(status: number): string {
  if (status === 401 || status === 403) return " Check the API key in Settings.";
  if (status === 404) return " Check the base URL and the model id in Settings.";
  if (status === 429) return " The endpoint is rate limiting this key; wait and try again.";
  return "";
}

/** The start of a refused request's body, which is all any message needs. */
export async function readErrorBody(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, MAX_ERROR_BODY_CHARACTERS);
  } catch {
    // An unreadable body still leaves the status to report.
    return "";
  }
}

/** Why the endpoint refused a request, from its status and the body already read. */
export function describeRefusal(status: number, body: string, label: string, apiKey: string | null): string {
  const detail = redact(errorDetail(body), apiKey).slice(0, MAX_ERROR_MESSAGE_CHARACTERS);
  const explained = detail ? `: ${detail}${/[.!?]$/.test(detail) ? "" : "."}` : ".";
  return `${label} returned status ${status}${explained}${statusHint(status)}`;
}

/** Why the endpoint refused a request, in words the user can act on. */
export async function refusalMessage(response: Response, label: string, apiKey: string | null): Promise<string> {
  return describeRefusal(response.status, await readErrorBody(response), label, apiKey);
}

/**
 * Statuses that say "not now" rather than "not this": a timeout, a conflict,
 * a rate limit, and the server-side failures, including Anthropic's 529
 * "overloaded". 501 and 505 are excluded because they describe the request
 * itself, which another attempt would send unchanged.
 */
export function isTransientStatus(status: number): boolean {
  if (status === 408 || status === 409 || status === 425 || status === 429) return true;
  return status >= 500 && status <= 599 && status !== 501 && status !== 505;
}

/**
 * A 429 that is a spent balance rather than a busy endpoint. Waiting does not
 * refill an account, so this one goes straight to the user.
 */
const EXHAUSTED_ACCOUNT = /insufficient_quota|billing|credit balance|payment required/i;

/** How long the endpoint asked the client to wait, from `retry-after-ms` or `retry-after`. */
export function retryAfterMs(headers: Headers, now: number = Date.now()): number | undefined {
  const milliseconds = Number(headers.get("retry-after-ms"));
  if (headers.has("retry-after-ms") && Number.isFinite(milliseconds) && milliseconds >= 0) return milliseconds;
  const value = headers.get("retry-after");
  if (value === null || value.trim() === "") return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1_000 : undefined;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * The error for a request the endpoint refused, already read: transient when
 * another attempt could succeed, an ordinary error when it would not.
 */
export function endpointRefusal(
  response: Response,
  body: string,
  label: string,
  apiKey: string | null,
): Error {
  const message = describeRefusal(response.status, body, label, apiKey);
  if (!isTransientStatus(response.status) || EXHAUSTED_ACCOUNT.test(body)) return new Error(message);
  const wait = retryAfterMs(response.headers);
  return new TransientTurnError(message, wait === undefined ? {} : { retryAfterMs: wait });
}

/**
 * Whether an error an endpoint reported inside its stream is worth another
 * attempt: overloaded, rate limited, or a server-side failure, named by type or
 * by status code, as Anthropic and OpenRouter each report it.
 */
export function isTransientStreamError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = error.code ?? error.status;
  if (typeof code === "number") return isTransientStatus(code);
  const kind = [error.type, error.code].filter((value) => typeof value === "string").join(" ");
  return /overloaded|rate_limit|server_error|api_error|timeout|unavailable|internal/i.test(kind);
}

/** An error the endpoint reported inside the stream, after it had accepted the request. */
export function streamErrorMessage(error: unknown, label: string, apiKey: string | null): string {
  const text = typeof error === "string"
    ? error
    : isRecord(error) && typeof error.message === "string" ? error.message : "";
  const detail = redact(text, apiKey).slice(0, MAX_ERROR_MESSAGE_CHARACTERS);
  return `${label} reported an error during the turn${detail ? `: ${detail}` : "."}`;
}

/** The same error, transient when the endpoint said it was busy or failing rather than refusing. */
export function streamFailure(error: unknown, label: string, apiKey: string | null): Error {
  const message = streamErrorMessage(error, label, apiKey);
  return isTransientStreamError(error) ? new TransientTurnError(message) : new Error(message);
}

export function endpointUrl(baseUrl: string, relative: string): string {
  return new URL(relative, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

/**
 * How a transport recognises one of its own turns when the loop sends it back:
 * by the text and calls the loop keeps for it, which the transport produced
 * verbatim. What the loop does not keep -- reasoning, signatures -- the
 * transport records against this and restores.
 */
export function turnKey(text: string, calls: readonly TurnToolCall[]): string {
  return JSON.stringify([text, calls.map((call) => [call.id, call.name, call.arguments])]);
}

/** The same key, for an assistant message as the loop recorded it. */
export function messageKey(message: TurnMessage): string {
  const text = message.content.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
  const calls = message.content.flatMap((block) => block.kind === "tool-call" ? [block.call] : []);
  return turnKey(text, calls);
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/**
 * A tool-call id the run's contract accepts. Local servers sometimes send none,
 * or one with characters the contract refuses; either way the call gets a
 * fresh id, which is what the tool result then answers to.
 */
export function usableCallId(value: string, fallback: string): string {
  return OPAQUE_ID.test(value) ? value : fallback;
}

/**
 * Connection failures that describe the address rather than the moment: no
 * server listening there, or no such host. Another attempt a few seconds later
 * would find the same, so these are reported at once.
 */
const PERMANENT_CONNECTION_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ERR_INVALID_URL"]);

/**
 * The system error code under a failed fetch: undici wraps it as the `cause`
 * of "fetch failed", and a host tried over both IPv4 and IPv6 fails with an
 * `AggregateError` holding one error per address.
 */
function connectionCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && isRecord(current); depth += 1) {
    const code = current.code;
    if (typeof code === "string") return code;
    const errors = current.errors;
    current = Array.isArray(errors) && errors.length > 0 ? errors[0] : current.cause;
  }
  return undefined;
}

export type OpenedRequest = Readonly<{
  response: Response;
  /** Aborts the request; the run's cancellation and the timeouts both go through it. */
  cancellation: AbortController;
  /** Re-arm the idle bound. Called for every chunk of the body that arrives. */
  alive: () => void;
  /** Whether the idle bound, rather than the run, ended the request. */
  timedOut: () => boolean;
  dispose: () => void;
}>;

/**
 * Fetch with the run's cancellation and a bound on waiting.
 *
 * The bound is on silence, never on length. Until the endpoint answers it
 * limits the wait for the response to start; after that each chunk of the body
 * re-arms it, so it ends a stream that has gone quiet and never one that is
 * still arriving. It once ran from the request to the end of the stream, and
 * cut off every turn longer than ten minutes, mid-sentence, with the message
 * "This operation was aborted".
 *
 * Resolves to `undefined` when the run was cancelled, so the caller ends
 * quietly and the planner reports the cancellation or stall it already knows
 * about.
 */
export async function fetchWithin(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<OpenedRequest | undefined> {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  if (signal.aborted) return undefined;
  signal.addEventListener("abort", abort, { once: true });
  let expired = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const alive = () => {
    clearTimeout(timeout);
    if (cancellation.signal.aborted) return;
    timeout = setTimeout(() => {
      expired = true;
      cancellation.abort();
    }, timeoutMs);
  };
  const dispose = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  };
  alive();
  try {
    const response = await fetchImpl(url, { ...init, signal: cancellation.signal });
    alive();
    return { response, cancellation, alive, timedOut: () => expired, dispose };
  } catch (error) {
    dispose();
    if (signal.aborted) return undefined;
    if (expired) throw new Error(`${label} did not answer within ${Math.round(timeoutMs / 1_000)} seconds.`);
    const message = `${label} could not be reached at ${new URL(url).origin}. Check the base URL, and that the server is running.`;
    const code = connectionCode(error);
    throw code !== undefined && PERMANENT_CONNECTION_CODES.has(code)
      ? new Error(message)
      : new TransientTurnError(message, { cause: error });
  }
}

/**
 * The error for a stream that failed while it was being read, or `undefined`
 * when the run was cancelled and the caller should end quietly.
 */
export function interruptedStream(
  error: unknown,
  opened: OpenedRequest,
  runSignal: AbortSignal,
  timeoutMs: number,
  label: string,
): Error | undefined {
  if (runSignal.aborted) return undefined;
  if (!(error instanceof StreamReadError)) return error instanceof Error ? error : new Error(String(error));
  if (opened.timedOut()) {
    return new Error(`${label} sent nothing for ${Math.round(timeoutMs / 1_000)} seconds partway through the turn, so Roqer stopped waiting for it.`);
  }
  return new TransientTurnError(`${label}'s connection dropped partway through the turn.`, { cause: error.cause });
}
