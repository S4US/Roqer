/**
 * The turn contract Roqer's own agent loop speaks: what one model turn is
 * asked (instructions, conversation, tools) and the events a transport
 * streams back. The Custom provider's adapters in this folder translate it to
 * and from OpenAI-compatible and Anthropic endpoints.
 *
 * It began as the wire contract with a hosted gateway that no longer exists;
 * the bounds and validators are kept because they are what the loop and its
 * tests hold a turn to.
 */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(record).every((key) => allowed.has(key));
}

export function isBoundedString(value: unknown, maximum: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum) return false;
  return !Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
}

/**
 * Text that may be empty -- a model can emit an empty block -- but never
 * unbounded. Tab, newline, and carriage return are content here rather than
 * control characters: instructions, tool descriptions, script source, and model
 * prose are all multi-line, so rejecting them would refuse every real one. That
 * is not hypothetical; the first genuine turn built against this contract was
 * refused by a validator that treated a newline as control.
 */
export function isMultilineText(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length <= maximum &&
    !Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    });
}

/** The same rule, for a field that must actually say something. */
export function isRequiredMultilineText(value: unknown, maximum: number): value is string {
  return isMultilineText(value, maximum) && value.length > 0;
}

export function isOpaqueId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value);
}

export const TURN_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type TurnReasoningEffort = typeof TURN_REASONING_EFFORTS[number];

export function isTurnReasoningEffort(value: unknown): value is TurnReasoningEffort {
  return typeof value === "string" &&
    TURN_REASONING_EFFORTS.includes(value as TurnReasoningEffort);
}

/**
 * A model id, which is not an opaque id: aggregators name the vendor and the
 * model (`openai/gpt-5.6-luna`), so `/` is part of the identifier rather than
 * a path separator. It is still bounded to
 * one segment shape so an id can never carry a scheme, host, or traversal.
 */
export function isTurnModelId(value: unknown): value is string {
  return isBoundedString(value, 128) && /^[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(value);
}

/**
 * One model turn: the conversation, the tool definitions, and the agent
 * definition the loop sends, and, as events, what the model said and asks for.
 * A transport is stateless per request and never executes a tool.
 */

export const MAX_TURN_MESSAGES = 200;
export const MAX_TURN_CONTENT_BLOCKS = 64;
export const MAX_TURN_TOOLS = 64;
export const MAX_TURN_TEXT = 1_000_000;
export const MAX_TURN_INSTRUCTIONS = 200_000;
export const MAX_TURN_JSON = 65_536;
export const MAX_TURN_OUTPUT_TOKENS = 200_000;

/**
 * The image formats every vision-capable model behind the aggregator accepts.
 * Deliberately short: a format one provider decodes and another rejects would
 * fail at the model rather than at this boundary, where the caller can still be
 * told what to send instead.
 */
export const TURN_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;

export type TurnImageMediaType = typeof TURN_IMAGE_MEDIA_TYPES[number];

/**
 * Per-image and per-request image bounds.
 *
 * The contract caps a whole turn request at 4 MB, so these leave room for the
 * conversation, the instructions, and the tool schemas that travel beside the
 * pictures. A caller that wants to send more should downscale first: past
 * roughly 1568 pixels on the long edge no provider gains detail, it only pays
 * for it.
 */
export const MAX_TURN_IMAGES = 4;
export const MAX_TURN_IMAGE_BASE64 = 1_400_000;

export type TurnToolCall = Readonly<{
  id: string;
  name: string;
  /** A decoded object rather than a provider-specific JSON string. */
  arguments: Readonly<Record<string, unknown>>;
}>;

export type TurnContent =
  | Readonly<{ kind: "text"; text: string }>
  /**
   * A picture supplied by the desktop, as standard base64 without a data-URL
   * prefix. This can be a user attachment or a local tool result such as a
   * Studio screenshot.
   *
   * Only a user turn may carry one. The model describes what it sees in prose;
   * it never sends an image back, so an assistant turn holding one could only
   * have been forged by the caller.
   */
  | Readonly<{ kind: "image"; mediaType: TurnImageMediaType; data: string }>
  | Readonly<{ kind: "tool-call"; call: TurnToolCall }>
  | Readonly<{ kind: "tool-result"; callId: string; content: string; failed: boolean }>;

export type TurnMessage = Readonly<{
  role: "user" | "assistant";
  content: readonly TurnContent[];
}>;

export type TurnTool = Readonly<{
  name: string;
  description: string;
  parameters: Readonly<Record<string, unknown>>;
}>;

export type TurnRequest = Readonly<{
  /** One desktop run; shared by every model turn in that run. */
  runId: string;
  /** One logical model turn; reused only when retrying this exact request. */
  turnId: string;
  modelId: string;
  reasoningEffort: TurnReasoningEffort;
  instructions: Readonly<{ system: string; developer?: string }>;
  tools: readonly TurnTool[];
  messages: readonly TurnMessage[];
  maxOutputTokens?: number;
}>;

export type TurnUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  /**
   * The part of `inputTokens` the provider served from its prefix cache, when
   * it reports one. Kept as a subset rather than subtracted from `inputTokens`
   * so the raw prompt size stays visible: a cached prefix is billed at a small
   * fraction, and charging the raw figure against a token limit would make that
   * limit bind far earlier than the cost justifies.
   */
  cachedInputTokens?: number;
}>;

/**
 * Why a turn ended. "malformed-tool-call" is a model that tried to call a tool
 * and could not form the call: Gemini reports it as MALFORMED_FUNCTION_CALL,
 * with no content, and a relay such as OpenRouter passes that on only as a
 * provider-native reason beside an ordinary-looking finish.
 */
export const TURN_STOP_REASONS = ["end", "tool-use", "max-output", "refusal", "malformed-tool-call"] as const;

export type TurnStopReason = typeof TURN_STOP_REASONS[number];

export const TURN_FAILURE_CODES = [
  "upstream_error",
  "upstream_timeout",
  "quota_exhausted",
  "cancelled",
  "internal_error",
] as const;

export type TurnFailureCode = typeof TURN_FAILURE_CODES[number];

/**
 * A turn that failed in a way the same request may not fail again: the
 * endpoint was overloaded or rate limiting, answered with a server error, or
 * dropped the connection partway through.
 *
 * A transport throws this, and the agent loop sends the same turn again after a
 * pause. That is safe because a transport hands over a turn's tool calls only
 * once the whole turn has arrived, so a turn that failed has run nothing. A
 * failure the next attempt would only repeat -- a refused key, a bad model id,
 * a request the endpoint cannot read -- is an ordinary `Error` instead.
 */
export class TransientTurnError extends Error {
  /** How long the endpoint asked the client to wait before trying again, when it said. */
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: Readonly<{ retryAfterMs?: number; cause?: unknown }> = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TransientTurnError";
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Stream events. A refusal decided before the stream opens is an HTTP status,
 * not a `failed` event, so a client never has to read a body to learn it was
 * never charged.
 */
export type TurnEvent =
  | Readonly<{ kind: "delta"; text: string }>
  /**
   * The model is reasoning. It carries no text on purpose: reasoning is not
   * written for the user and never reaches the reply. What it carries is the
   * fact of progress, so a model thinking for minutes before its first word
   * is not mistaken for one that has stopped.
   */
  | Readonly<{ kind: "reasoning" }>
  | Readonly<{ kind: "tool-call"; call: TurnToolCall }>
  /** `usage` is absent when the provider did not report it; it is never invented. */
  | Readonly<{ kind: "completed"; stopReason: TurnStopReason; usage?: TurnUsage }>
  | Readonly<{ kind: "failed"; code: TurnFailureCode; message: string; usage?: TurnUsage }>;

export type TurnEventKind = TurnEvent["kind"];

/**
 * Written as a map so the union is what keeps it honest: adding a kind above
 * without adding it here does not compile, and a kind removed above cannot be
 * left behind. `TURN_EVENT_KINDS` is the reading order of the union.
 */
const TURN_EVENT_KIND_SET: Readonly<Record<TurnEventKind, true>> = {
  delta: true,
  reasoning: true,
  "tool-call": true,
  completed: true,
  failed: true,
};

export const TURN_EVENT_KINDS =
  Object.keys(TURN_EVENT_KIND_SET) as readonly TurnEventKind[];

/**
 * A frame that names a kind this build has never heard of.
 *
 * The stream is append-only by design: a later service may add an event a
 * client of this vintage has no case for, and the correct response is to skip
 * it. Refusing it instead would end the turn -- and the run above it -- over
 * something purely additive, which is the opposite of what adding it was for.
 *
 * Deliberately narrow. Only a record whose `kind` is a string and is not one of
 * ours qualifies; a known kind carrying the wrong fields is a service that
 * broke the contract, not a service that moved ahead of us, and it must still
 * be refused.
 */
export function isUnknownTurnEventKind(value: unknown): boolean {
  return isRecord(value) && typeof value.kind === "string" &&
    !TURN_EVENT_KINDS.includes(value.kind as TurnEventKind);
}

function isToolName(value: unknown): value is string {
  return isBoundedString(value, 64) && /^[a-z][a-z0-9_]*$/.test(value);
}

function isBoundedJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (!isRecord(value)) return false;
  try {
    return JSON.stringify(value).length <= MAX_TURN_JSON;
  } catch {
    return false;
  }
}

// The multi-line text rules live in `common.ts` because the agent definition
// carries the same instructions this turn contract does, and two copies of a
// rule about what counts as a control character would be one copy too many.
const isTurnText = isMultilineText;
const isRequiredTurnText = isRequiredMultilineText;

export function isTurnToolCall(value: unknown): value is TurnToolCall {
  return isRecord(value) && hasOnlyKeys(value, ["id", "name", "arguments"]) &&
    isOpaqueId(value.id) && isToolName(value.name) && isBoundedJsonObject(value.arguments);
}

/**
 * Standard base64, rejected rather than repaired.
 *
 * The padding and length rules matter beyond tidiness: a provider that decodes
 * leniently and one that does not would otherwise disagree about what the user
 * attached, and the disagreement would surface as a model error rather than as
 * something this boundary could explain.
 */
function isBase64Image(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum &&
    value.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(value);
}

function isTurnContent(value: unknown): value is TurnContent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "text":
      return hasOnlyKeys(value, ["kind", "text"]) && isTurnText(value.text, MAX_TURN_TEXT);
    case "image":
      return hasOnlyKeys(value, ["kind", "mediaType", "data"]) &&
        (TURN_IMAGE_MEDIA_TYPES as readonly string[]).includes(value.mediaType as string) &&
        isBase64Image(value.data, MAX_TURN_IMAGE_BASE64);
    case "tool-call":
      return hasOnlyKeys(value, ["kind", "call"]) && isTurnToolCall(value.call);
    case "tool-result":
      return hasOnlyKeys(value, ["kind", "callId", "content", "failed"]) && isOpaqueId(value.callId) &&
        isTurnText(value.content, MAX_TURN_TEXT) && typeof value.failed === "boolean";
    default:
      return false;
  }
}

function isTurnMessage(value: unknown): value is TurnMessage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["role", "content"]) ||
    (value.role !== "user" && value.role !== "assistant") || !Array.isArray(value.content) ||
    value.content.length === 0 || value.content.length > MAX_TURN_CONTENT_BLOCKS ||
    !value.content.every(isTurnContent)) return false;

  // A tool call is something the model did; a tool result and an attached image
  // are things the caller supplied. Crossing them would let a client forge
  // either side of the conversation.
  const content = value.content as readonly TurnContent[];
  return value.role === "assistant"
    ? content.every((block) => block.kind !== "tool-result" && block.kind !== "image")
    : content.every((block) => block.kind !== "tool-call");
}

function isTurnTool(value: unknown): value is TurnTool {
  return isRecord(value) && hasOnlyKeys(value, ["name", "description", "parameters"]) &&
    isToolName(value.name) && isRequiredTurnText(value.description, 8_192) &&
    isBoundedJsonObject(value.parameters);
}

export function isTurnRequest(value: unknown): value is TurnRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, [
    "runId",
    "turnId",
    "modelId",
    "reasoningEffort",
    "instructions",
    "tools",
    "messages",
    "maxOutputTokens",
  ])) return false;
  if (!isOpaqueId(value.runId) || !isOpaqueId(value.turnId) ||
    !isTurnModelId(value.modelId) || !isTurnReasoningEffort(value.reasoningEffort)) return false;
  if (!isRecord(value.instructions) || !hasOnlyKeys(value.instructions, ["system", "developer"]) ||
    !isRequiredTurnText(value.instructions.system, MAX_TURN_INSTRUCTIONS) ||
    (value.instructions.developer !== undefined &&
      !isRequiredTurnText(value.instructions.developer, MAX_TURN_INSTRUCTIONS))) return false;
  if (!Array.isArray(value.tools) || value.tools.length > MAX_TURN_TOOLS ||
    !value.tools.every(isTurnTool)) return false;
  if (new Set((value.tools as readonly TurnTool[]).map((tool) => tool.name)).size !==
    value.tools.length) return false;
  if (!Array.isArray(value.messages) || value.messages.length === 0 ||
    value.messages.length > MAX_TURN_MESSAGES || !value.messages.every(isTurnMessage)) return false;
  // Bounded across the whole request, not per message: the byte ceiling that
  // protects the endpoint is a property of the request, and a caller could
  // otherwise spread an unbounded number of images over many small messages.
  const images = (value.messages as readonly TurnMessage[])
    .reduce((total, message) => total + message.content.filter((block) => block.kind === "image").length, 0);
  if (images > MAX_TURN_IMAGES) return false;
  if (value.maxOutputTokens !== undefined && (!Number.isSafeInteger(value.maxOutputTokens) ||
    (value.maxOutputTokens as number) < 1 ||
    (value.maxOutputTokens as number) > MAX_TURN_OUTPUT_TOKENS)) return false;
  return true;
}

export function isTurnUsage(value: unknown): value is TurnUsage {
  if (!isRecord(value) || !hasOnlyKeys(value, ["inputTokens", "outputTokens", "cachedInputTokens"])) return false;
  if (!Number.isSafeInteger(value.inputTokens) || (value.inputTokens as number) < 0) return false;
  if (!Number.isSafeInteger(value.outputTokens) || (value.outputTokens as number) < 0) return false;
  if (value.cachedInputTokens === undefined) return true;
  // A cache hit larger than the prompt it came from is not a usable figure, and
  // trusting it would report tokens as cached that were never sent.
  return Number.isSafeInteger(value.cachedInputTokens) && (value.cachedInputTokens as number) >= 0 &&
    (value.cachedInputTokens as number) <= (value.inputTokens as number);
}

export function isTurnEvent(value: unknown): value is TurnEvent {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "delta":
      return hasOnlyKeys(value, ["kind", "text"]) && isTurnText(value.text, MAX_TURN_TEXT);
    case "reasoning":
      return hasOnlyKeys(value, ["kind"]);
    case "tool-call":
      return hasOnlyKeys(value, ["kind", "call"]) && isTurnToolCall(value.call);
    case "completed":
      return hasOnlyKeys(value, ["kind", "stopReason", "usage"]) && typeof value.stopReason === "string" &&
        TURN_STOP_REASONS.includes(value.stopReason as TurnStopReason) &&
        (value.usage === undefined || isTurnUsage(value.usage));
    case "failed":
      return hasOnlyKeys(value, ["kind", "code", "message", "usage"]) && typeof value.code === "string" &&
        TURN_FAILURE_CODES.includes(value.code as TurnFailureCode) &&
        isBoundedString(value.message, 240) &&
        (value.usage === undefined || isTurnUsage(value.usage));
    default:
      return false;
  }
}

/**
 * Roughly what an attached image will cost as input.
 *
 * A provider prices an image by its pixel dimensions, which this contract
 * deliberately does not carry — decoding an image here to measure it would mean
 * parsing caller-supplied bytes in the request path. Encoded size stands in for
 * area instead, and the divisor is a round number chosen to land in the right
 * order of magnitude for a downscaled screenshot rather than a curve fitted to
 * any one provider. It is meant to be adjusted once real usage reports can be
 * compared against it, and the provider's own figure replaces it the moment the
 * turn settles.
 */
const IMAGE_BYTES_PER_TOKEN = 500;

/**
 * The characters-per-token convention both estimators here work in, named so
 * the input and output sides cannot drift apart.
 */
const CHARACTERS_PER_TOKEN = 4;

function imageTokens(base64Length: number): number {
  return Math.ceil((base64Length * 3) / 4 / IMAGE_BYTES_PER_TOKEN);
}

/**
 * Size a turn's input without a provider tokenizer. Roughly four characters per
 * token is close enough for the agent loop's telemetry; the exact figure
 * arrives from the provider's own usage report when the turn settles.
 */
export function estimateTurnInputTokens(request: TurnRequest): number {
  let characters = request.instructions.system.length + (request.instructions.developer?.length ?? 0);
  for (const tool of request.tools) {
    characters += tool.name.length + tool.description.length;
    try {
      characters += JSON.stringify(tool.parameters).length;
    } catch {
      // A tool whose schema cannot be measured is still charged for its text.
    }
  }
  // Images are priced by their own rule rather than by the characters-per-token
  // one, so they are accumulated as tokens and added at the end.
  let tokens = 0;
  for (const message of request.messages) {
    for (const block of message.content) {
      if (block.kind === "text") characters += block.text.length;
      else if (block.kind === "tool-result") characters += block.content.length;
      else if (block.kind === "image") tokens += imageTokens(block.data.length);
      else {
        characters += block.call.name.length;
        try {
          characters += JSON.stringify(block.call.arguments).length;
        } catch {
          // As above: unmeasurable arguments do not zero the estimate.
        }
      }
    }
  }
  return Math.ceil(characters / CHARACTERS_PER_TOKEN) + tokens;
}

/**
 * Size output that was delivered but never reported, from the characters that
 * reached the caller.
 *
 * A turn cancelled or broken off before the provider's terminal chunk has no
 * usage report, and the text it already streamed is output the provider will
 * still bill for. This is what stands in until a measured figure exists, so the
 * alternative is not a better estimate but a zero.
 */
export function estimateTurnOutputTokens(deliveredCharacters: number): number {
  if (!Number.isFinite(deliveredCharacters) || deliveredCharacters <= 0) return 0;
  return Math.ceil(deliveredCharacters / CHARACTERS_PER_TOKEN);
}
