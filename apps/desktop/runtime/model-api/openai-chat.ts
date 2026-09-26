import {
  TransientTurnError,
  UnusableToolCallError,
  type TurnToolCall,
  type TurnEvent,
  type TurnRequest,
  type TurnStopReason,
  type TurnUsage,
} from "./turn-contract";

import type { TurnTransport } from "../agent-loop";
import {
  assembledToolCall, DEFAULT_REQUEST_TIMEOUT_MS, endpointRefusal, endpointUrl, fetchWithin, frameData, interruptedStream,
  isRecord, MAX_TOOL_ARGUMENT_CHARACTERS, MAX_TOOL_CALLS_PER_TURN, messageKey, oversizedToolCall, readErrorBody,
  serverSentFrames, streamFailure, tooManyToolCalls, turnKey, usableCallId,
} from "./http";

/**
 * A turn against an endpoint speaking the OpenAI chat-completions format:
 * OpenAI itself, OpenRouter, DeepSeek, Groq, Together, and the local servers
 * (Ollama, LM Studio, vLLM, LiteLLM) that imitate it.
 *
 * Began as a port of the retired hosted gateway's adapter, with the changes a user's own
 * endpoint needs: no key for a local server, a reasoning effort only for a
 * model the user said takes one, and tolerance for the ways local servers
 * stream tool calls differently from OpenAI.
 */

export type OpenAiChatOptions = Readonly<{
  baseUrl: string;
  apiKey: string | null;
  /** The connection's name, for messages. */
  label: string;
  /** Whether to send the run's reasoning effort. */
  reasoning: boolean;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}>;

type UserContentPart =
  | Readonly<{ type: "text"; text: string }>
  | Readonly<{ type: "image_url"; image_url: Readonly<{ url: string }> }>;

type JsonRecord = Record<string, unknown>;

type ChatToolCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
  extra_content?: JsonRecord;
}>;

type ChatMessage =
  | Readonly<{ role: "system"; content: string }>
  | Readonly<{ role: "user"; content: string | readonly UserContentPart[] }>
  | Readonly<{
    role: "assistant";
    content: string | null;
    tool_calls?: readonly ChatToolCall[];
    reasoning_content?: string;
    reasoning_details?: readonly JsonRecord[];
  }>
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

/**
 * The fields a model's reasoning comes back in, each of which some endpoint
 * requires to be sent back with the assistant turn that produced it:
 *
 * - `reasoning_content`: DeepSeek, from V3.2, refuses a request that carries
 *   tools unless every earlier turn's reasoning comes back ("Missing
 *   reasoning_content"), and vLLM and llama.cpp read it the same way.
 * - `reasoning_details`: OpenRouter's structured reasoning, which carries
 *   Anthropic's signed thinking and Gemini's thought signatures through it.
 * - `extra_content`: on a tool call, where Google's own OpenAI-compatible
 *   endpoint puts a Gemini 3 thought signature, without which the next turn
 *   is refused.
 */
type ReplayedField = "reasoning_content" | "reasoning_details" | "extra_content";

/**
 * A 400 that names one of those fields as one the endpoint does not accept.
 * A strict server that has never heard of it says so, and the turn is sent
 * again without it; one that says it is missing is asking for it, not refusing it.
 */
function refusedField(body: string, sent: ReadonlySet<ReplayedField>): ReplayedField | undefined {
  if (!/not permitted|not allowed|unrecognized|unknown|unexpected|extra (?:input|field)|additional propert|should not/i.test(body)) {
    return undefined;
  }
  const named: ReadonlyArray<readonly [ReplayedField, RegExp]> = [
    ["reasoning_content", /reasoning_content/],
    ["reasoning_details", /reasoning_details/],
    ["extra_content", /extra_content|thought_signature/],
  ];
  return named.find(([field, pattern]) => sent.has(field) && pattern.test(body))?.[0];
}

/** One turn's reasoning as the endpoint streamed it, kept to be sent back with the turn. */
type ProducedTurn = Readonly<{
  /** The turn's text and calls as the loop records its message. */
  key: string;
  reasoningContent: string;
  reasoningDetails: readonly JsonRecord[];
  /** Each call's `extra_content`, by call id. */
  extraContent: ReadonlyMap<string, JsonRecord>;
}>;

/**
 * Add one streamed `reasoning_details` fragment to what has arrived so far.
 *
 * OpenRouter streams a reasoning block a few words at a time, each fragment
 * naming the block by `index`. A signed block is valid only whole, so the
 * fragments are joined back into one entry per block before anything is sent
 * back: their text, summary, data and signature concatenated in order, and
 * every other field taken from whichever fragment carried it.
 */
function mergeReasoningDetail(details: JsonRecord[], fragment: JsonRecord): void {
  const index = fragment.index;
  const target = typeof index === "number"
    ? details.find((entry) => entry.index === index)
    : details.at(-1)?.type === fragment.type && fragment.type !== "reasoning.encrypted" ? details.at(-1) : undefined;
  if (target === undefined) {
    details.push({ ...fragment });
    return;
  }
  for (const [field, value] of Object.entries(fragment)) {
    if (typeof value === "string" && ["text", "summary", "data", "signature"].includes(field)) {
      target[field] = typeof target[field] === "string" ? `${target[field] as string}${value}` : value;
    } else if (value !== undefined && value !== null && target[field] === undefined) {
      target[field] = value;
    }
  }
}

/**
 * Where OpenAI-compatible servers stream a model's reasoning: `reasoning_content`
 * (DeepSeek, vLLM, LM Studio, llama.cpp), `reasoning` (OpenRouter, Ollama), and
 * OpenRouter's structured `reasoning_details`.
 */
function carriesReasoning(delta: Record<string, unknown>): boolean {
  const text = (value: unknown) => typeof value === "string" && value.length > 0;
  return text(delta.reasoning_content) || text(delta.reasoning) ||
    (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length > 0);
}

/** Provider-native finish reasons that mean the model tried to call a tool and could not form the call. */
const MALFORMED_NATIVE_REASONS = /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL/i;

type PendingToolCall = { id: string; name: string; arguments: string; extra?: JsonRecord };

function stopReason(value: unknown): TurnStopReason {
  switch (value) {
    case "tool_calls":
    case "function_call":
      return "tool-use";
    case "length":
      return "max-output";
    case "content_filter":
      return "refusal";
    default:
      return "end";
  }
}

function usageOf(value: unknown): TurnUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.prompt_tokens;
  const outputTokens = value.completion_tokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return undefined;
  if ((inputTokens as number) < 0 || (outputTokens as number) < 0) return undefined;
  const details = value.prompt_tokens_details;
  const cached = isRecord(details) ? details.cached_tokens : undefined;
  return Number.isSafeInteger(cached) && (cached as number) >= 0 && (cached as number) <= (inputTokens as number)
    ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number, cachedInputTokens: cached as number }
    : { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

/** What to send back with one assistant turn, found from the turn as the loop recorded it. */
type AssistantReplay = (message: TurnRequest["messages"][number]) => Readonly<{
  reasoningContent?: string;
  reasoningDetails?: readonly JsonRecord[];
  extraContent: (callId: string) => JsonRecord | undefined;
}>;

function requestMessages(request: TurnRequest, replay: AssistantReplay): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: request.instructions.system }];
  if (request.instructions.developer !== undefined) {
    messages.push({ role: "system", content: request.instructions.developer });
  }
  for (const message of request.messages) {
    if (message.role === "user") {
      const text = message.content.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
      const images = message.content.flatMap((block) => block.kind === "image"
        ? [{ type: "image_url" as const, image_url: { url: `data:${block.mediaType};base64,${block.data}` } }]
        : []);
      // Tool results are their own wire messages and come before the prose
      // that shares a turn with them.
      for (const block of message.content) {
        if (block.kind === "tool-result") {
          messages.push({ role: "tool", tool_call_id: block.callId, content: block.content || "(no output)" });
        }
      }
      if (images.length > 0) {
        messages.push({ role: "user", content: [...(text.length > 0 ? [{ type: "text" as const, text }] : []), ...images] });
      } else if (text.length > 0) {
        messages.push({ role: "user", content: text });
      }
      continue;
    }
    const text = message.content.flatMap((block) => block.kind === "text" ? [block.text] : []).join("\n");
    const replayed = replay(message);
    const toolCalls = message.content.flatMap((block): ChatToolCall[] => {
      if (block.kind !== "tool-call") return [];
      const extra = replayed.extraContent(block.call.id);
      return [{
        id: block.call.id,
        type: "function",
        function: { name: block.call.name, arguments: JSON.stringify(block.call.arguments) },
        ...(extra === undefined ? {} : { extra_content: extra }),
      }];
    });
    messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
      ...(replayed.reasoningContent === undefined ? {} : { reasoning_content: replayed.reasoningContent }),
      ...(replayed.reasoningDetails === undefined ? {} : { reasoning_details: replayed.reasoningDetails }),
    });
  }
  return messages;
}

/**
 * OpenAI's reasoning models refuse `max_tokens` and want
 * `max_completion_tokens`; most other servers only know `max_tokens`. The
 * endpoint's host decides, because nothing in the request can.
 */
function outputLimitField(baseUrl: string): "max_completion_tokens" | "max_tokens" {
  return new URL(baseUrl).hostname === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
}

export class OpenAiChatTurns implements TurnTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private calls = 0;
  /** This run's turns that streamed reasoning, oldest first. */
  private produced: ProducedTurn[] = [];
  /** Fields this endpoint refused; they are not sent again for the rest of the run. */
  private readonly refused = new Set<ReplayedField>();

  constructor(private readonly options: OpenAiChatOptions) {
    this.endpoint = endpointUrl(options.baseUrl, "chat/completions");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * The request, with every earlier turn's reasoning sent back where it was
   * produced. Turns are matched in order by what the loop kept of them, the way
   * the Anthropic transport matches its own; a turn older than the oldest one
   * still in the conversation was folded away and is forgotten.
   */
  private body(request: TurnRequest): { body: JsonRecord; sent: ReadonlySet<ReplayedField> } {
    const maxOutput = request.maxOutputTokens ?? this.options.maxOutputTokens;
    const sent = new Set<ReplayedField>();
    let next = 0;
    let firstMatched: number | undefined;
    const replay: AssistantReplay = (message) => {
      const key = messageKey(message);
      let index = next;
      while (index < this.produced.length && this.produced[index].key !== key) index += 1;
      if (index >= this.produced.length) return { extraContent: () => undefined };
      next = index + 1;
      firstMatched ??= index;
      const turn = this.produced[index];
      const offer = (field: ReplayedField, present: boolean): boolean => {
        if (!present || this.refused.has(field)) return false;
        sent.add(field);
        return true;
      };
      return {
        ...(offer("reasoning_content", turn.reasoningContent.length > 0) ? { reasoningContent: turn.reasoningContent } : {}),
        ...(offer("reasoning_details", turn.reasoningDetails.length > 0) ? { reasoningDetails: turn.reasoningDetails } : {}),
        extraContent: (callId) => {
          const extra = turn.extraContent.get(callId);
          return offer("extra_content", extra !== undefined) ? extra : undefined;
        },
      };
    };
    const messages = requestMessages(request, replay);
    if (firstMatched !== undefined && firstMatched > 0) this.produced = this.produced.slice(firstMatched);
    return { body: {
      model: request.modelId,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(maxOutput === undefined ? {} : { [outputLimitField(this.options.baseUrl)]: maxOutput }),
      ...(this.options.reasoning ? { reasoning_effort: request.reasoningEffort } : {}),
      ...(request.tools.length === 0 ? {} : {
        tools: request.tools.map((tool) => ({
          type: "function",
          function: { name: tool.name, description: tool.description, parameters: tool.parameters },
        })),
      }),
    }, sent };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    for (;;) {
      const { body, sent } = this.body(request);
      const opened = await fetchWithin(this.fetchImpl, this.endpoint, {
        method: "POST",
        headers: {
          ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
          "content-type": "application/json",
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
      }, signal, this.timeoutMs, label);
      if (opened === undefined) return;
      const { response, cancellation, dispose } = opened;
      try {
        if (!response.ok || response.body === null) {
          const refusal = await readErrorBody(response);
          const field = response.status === 400 || response.status === 422 ? refusedField(refusal, sent) : undefined;
          if (field !== undefined) {
            // A server that does not know the field; each is dropped once, so
            // this ends after at most three tries.
            this.refused.add(field);
            continue;
          }
          throw endpointRefusal(response, refusal, label, apiKey);
        }
        try {
          yield* this.readStream(response.body, cancellation.signal, signal, opened.alive);
        } catch (error) {
          const failure = interruptedStream(error, opened, signal, this.timeoutMs, label);
          if (failure === undefined) return;
          throw failure;
        }
        return;
      } finally {
        dispose();
      }
    }
  }

  private async *readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    runSignal: AbortSignal,
    alive: () => void,
  ): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    const pending = new Map<number, PendingToolCall>();
    let reason: TurnStopReason | undefined;
    let usage: TurnUsage | undefined;
    let done = false;
    let produced = false;
    let nativeReason: string | undefined;
    let relayError = false;
    let text = "";
    let reasoningContent = "";
    const reasoningDetails: JsonRecord[] = [];

    for await (const frame of serverSentFrames(body, signal, MAX_TOOL_ARGUMENT_CHARACTERS * 4, alive)) {
      const data = frameData(frame);
      if (data === "[DONE]") {
        done = true;
        break;
      }
      if (data === undefined) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw new Error(`${label} sent a response Roqer could not read.`);
      }
      if (!isRecord(payload)) continue;
      if (payload.error !== undefined && payload.error !== null) {
        throw streamFailure(payload.error, label, apiKey);
      }
      const reported = usageOf(payload.usage);
      if (reported !== undefined) usage = reported;
      const choice = Array.isArray(payload.choices) ? payload.choices[0] : undefined;
      if (!isRecord(choice)) continue;
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        reason = stopReason(choice.finish_reason);
        if (choice.finish_reason === "error") relayError = true;
      }
      // OpenRouter normalises the finish reason and keeps the provider's own
      // here; Gemini's failed tool call only shows up in this field.
      if (typeof choice.native_finish_reason === "string") nativeReason = choice.native_finish_reason;
      const delta = isRecord(choice.delta) ? choice.delta : undefined;
      if (delta === undefined) continue;
      // Reasoning text is never shown: splicing a model's thinking into the
      // reply would publish it as though it were written for the user. That it
      // is arriving is still reported, because a model reasoning for minutes is
      // working, and without this the loop would read it as stalled.
      if (carriesReasoning(delta)) {
        produced = true;
        if (typeof delta.reasoning_content === "string") reasoningContent += delta.reasoning_content;
        if (Array.isArray(delta.reasoning_details)) {
          for (const fragment of delta.reasoning_details) if (isRecord(fragment)) mergeReasoningDetail(reasoningDetails, fragment);
        }
        yield { kind: "reasoning" };
      }
      if (typeof delta.content === "string" && delta.content.length > 0) {
        produced = true;
        text += delta.content;
        yield { kind: "delta", text: delta.content };
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        produced = true;
        this.accumulate(pending, delta.tool_calls);
      }
    }
    if (runSignal.aborted) return;

    const calls: TurnToolCall[] = [];
    const extraContent = new Map<string, JsonRecord>();
    for (const call of pending.values()) {
      this.calls += 1;
      const completed = assembledToolCall(label, usableCallId(call.id, `call-${this.calls}`), call.name, call.arguments, reason);
      if (completed instanceof UnusableToolCallError) throw completed;
      calls.push(completed);
      if (call.extra !== undefined) extraContent.set(completed.id, call.extra);
    }
    // A model that could not form its tool call ends looking like a finished
    // turn with nothing in it. Said as what it is, so the loop can ask for a
    // smaller call instead of reporting that the model had no answer.
    if (calls.length === 0 && nativeReason !== undefined && MALFORMED_NATIVE_REASONS.test(nativeReason)) {
      reason = "malformed-tool-call";
    } else if (calls.length === 0 && relayError) {
      // A relay passing on its upstream provider's failure; the next attempt
      // may well be routed to one that answers.
      throw new TransientTurnError(`${label} ended the turn with an error from the model's provider${nativeReason === undefined ? "" : ` (${nativeReason.slice(0, 80)})`}.`);
    }
    // Some local servers report `stop` for a turn that asked for tools.
    if (calls.length > 0 && (reason === undefined || reason === "end")) reason = "tool-use";
    if (reason === undefined && done) reason = "end";
    // A stream that stopped without saying it was finished was cut off, and a
    // turn that was cut off is simply asked for again.
    if (reason === undefined) {
      throw new TransientTurnError(produced
        ? `${label} ended the answer without saying it was finished.`
        : `${label} closed the connection before the model produced anything.`);
    }
    if (reasoningContent.length > 0 || reasoningDetails.length > 0 || extraContent.size > 0) {
      this.produced.push({ key: turnKey(text, calls), reasoningContent, reasoningDetails, extraContent });
    }
    for (const call of calls) yield { kind: "tool-call", call };
    yield usage === undefined ? { kind: "completed", stopReason: reason } : { kind: "completed", stopReason: reason, usage };
  }

  /**
   * Tool calls stream as indexed fragments. A fragment without an index is
   * placed by what it carries: one naming a function starts a new call, and
   * anything else continues the last one, which is how servers that omit the
   * index stream them.
   */
  private accumulate(pending: Map<number, PendingToolCall>, fragments: readonly unknown[]): void {
    for (const fragment of fragments) {
      if (!isRecord(fragment)) continue;
      const call = isRecord(fragment.function) ? fragment.function : undefined;
      const names = call !== undefined && typeof call.name === "string" && call.name.length > 0;
      const index = typeof fragment.index === "number" && Number.isSafeInteger(fragment.index)
        ? fragment.index
        : names ? pending.size : Math.max(0, pending.size - 1);
      if (!pending.has(index) && pending.size >= MAX_TOOL_CALLS_PER_TURN) {
        throw tooManyToolCalls(this.options.label);
      }
      const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id.length > 0) current.id = fragment.id;
      // Gemini's thought signature, on Google's own OpenAI-compatible endpoint.
      if (isRecord(fragment.extra_content)) current.extra = fragment.extra_content;
      if (call !== undefined) {
        if (names) current.name = call.name as string;
        // Most servers stream arguments as a string; a few send the object whole.
        const args = typeof call.arguments === "string"
          ? call.arguments
          : isRecord(call.arguments) ? JSON.stringify(call.arguments) : "";
        if (current.arguments.length + args.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
          throw oversizedToolCall(this.options.label, current.name);
        }
        current.arguments += args;
      }
      pending.set(index, current);
    }
  }
}
