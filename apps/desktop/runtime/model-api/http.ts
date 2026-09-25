/**
 * Transport pieces shared by the adapters that talk to a user's own model
 * endpoint: Server-Sent Event framing, and turning a refused request into a
 * message the user can act on.
 *
 * The endpoint and the key are the user's own, so the endpoint's own
 * explanation of a refusal is shown to them, with the key redacted in case the
 * endpoint echoed it.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;
export const MAX_TOOL_CALLS_PER_TURN = 64;
export const MAX_TOOL_ARGUMENT_CHARACTERS = 262_144;
const MAX_ERROR_BODY_CHARACTERS = 4_000;
const MAX_ERROR_MESSAGE_CHARACTERS = 300;

/**
 * Split a byte stream into complete Server-Sent Event frames without unbounded
 * buffering. Line endings are normalized first: a local server that frames
 * with CRLF is still speaking SSE.
 */
export async function* serverSentFrames(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBufferedChars: number,
): AsyncGenerator<string, void, undefined> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (signal.aborted) return;
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

/** Why the endpoint refused a request, in words the user can act on. */
export async function refusalMessage(response: Response, label: string, apiKey: string | null): Promise<string> {
  let body = "";
  try {
    body = (await response.text()).slice(0, MAX_ERROR_BODY_CHARACTERS);
  } catch {
    // An unreadable body still leaves the status to report.
  }
  const detail = redact(errorDetail(body), apiKey).slice(0, MAX_ERROR_MESSAGE_CHARACTERS);
  const explained = detail ? `: ${detail}${/[.!?]$/.test(detail) ? "" : "."}` : ".";
  return `${label} returned status ${response.status}${explained}${statusHint(response.status)}`;
}

/** An error the endpoint reported inside the stream, after it had accepted the request. */
export function streamErrorMessage(error: unknown, label: string, apiKey: string | null): string {
  const text = typeof error === "string"
    ? error
    : isRecord(error) && typeof error.message === "string" ? error.message : "";
  const detail = redact(text, apiKey).slice(0, MAX_ERROR_MESSAGE_CHARACTERS);
  return `${label} reported an error during the turn${detail ? `: ${detail}` : "."}`;
}

export function endpointUrl(baseUrl: string, relative: string): string {
  return new URL(relative, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
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
 * Fetch with the run's cancellation and an overall timeout. Resolves to
 * `undefined` when the run was cancelled, so the caller ends quietly and the
 * planner reports the cancellation or stall it already knows about.
 */
export async function fetchWithin(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  timeoutMs: number,
  label: string,
): Promise<{ response: Response; cancellation: AbortController; dispose: () => void } | undefined> {
  const cancellation = new AbortController();
  const abort = () => cancellation.abort();
  if (signal.aborted) return undefined;
  signal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, timeoutMs);
  const dispose = () => {
    clearTimeout(timeout);
    signal.removeEventListener("abort", abort);
  };
  try {
    const response = await fetchImpl(url, { ...init, signal: cancellation.signal });
    return { response, cancellation, dispose };
  } catch {
    dispose();
    if (signal.aborted) return undefined;
    if (cancellation.signal.aborted) throw new Error(`${label} did not answer within ${Math.round(timeoutMs / 1_000)} seconds.`);
    throw new Error(`${label} could not be reached at ${new URL(url).origin}. Check the base URL, and that the server is running.`);
  }
}
