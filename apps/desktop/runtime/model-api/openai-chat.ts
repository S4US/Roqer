import {
  isTurnToolCall,
  type TurnToolCall,
  type TurnEvent,
  type TurnRequest,
  type TurnStopReason,
  type TurnUsage,
} from "./turn-contract";

import type { TurnTransport } from "../agent-loop";
import {
  DEFAULT_REQUEST_TIMEOUT_MS, endpointUrl, fetchWithin, frameData, isRecord, MAX_TOOL_ARGUMENT_CHARACTERS,
  MAX_TOOL_CALLS_PER_TURN, refusalMessage, serverSentFrames, streamErrorMessage, usableCallId,
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

type ChatMessage =
  | Readonly<{ role: "system"; content: string }>
  | Readonly<{ role: "user"; content: string | readonly UserContentPart[] }>
  | Readonly<{
    role: "assistant";
    content: string | null;
    tool_calls?: readonly Readonly<{ id: string; type: "function"; function: Readonly<{ name: string; arguments: string }> }>[];
  }>
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

/** Provider-native finish reasons that mean the model tried to call a tool and could not form the call. */
const MALFORMED_NATIVE_REASONS = /MALFORMED_FUNCTION_CALL|UNEXPECTED_TOOL_CALL/i;

type PendingToolCall = { id: string; name: string; arguments: string };

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

function requestMessages(request: TurnRequest): ChatMessage[] {
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
    const toolCalls = message.content.flatMap((block) => block.kind === "tool-call"
      ? [{
        id: block.call.id,
        type: "function" as const,
        function: { name: block.call.name, arguments: JSON.stringify(block.call.arguments) },
      }]
      : []);
    messages.push({
      role: "assistant",
      content: text.length > 0 ? text : null,
      ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
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

  constructor(private readonly options: OpenAiChatOptions) {
    this.endpoint = endpointUrl(options.baseUrl, "chat/completions");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  private body(request: TurnRequest): Record<string, unknown> {
    const maxOutput = request.maxOutputTokens ?? this.options.maxOutputTokens;
    return {
      model: request.modelId,
      messages: requestMessages(request),
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
    };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    const opened = await fetchWithin(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: {
        ...(apiKey === null ? {} : { authorization: `Bearer ${apiKey}` }),
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(this.body(request)),
    }, signal, this.timeoutMs, label);
    if (opened === undefined) return;
    const { response, cancellation, dispose } = opened;
    try {
      if (!response.ok || response.body === null) throw new Error(await refusalMessage(response, label, apiKey));
      yield* this.readStream(response.body, cancellation.signal, signal);
    } finally {
      dispose();
    }
  }

  private async *readStream(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal,
    runSignal: AbortSignal,
  ): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    const pending = new Map<number, PendingToolCall>();
    let reason: TurnStopReason | undefined;
    let usage: TurnUsage | undefined;
    let done = false;
    let produced = false;
    let nativeReason: string | undefined;
    let relayError = false;

    for await (const frame of serverSentFrames(body, signal, MAX_TOOL_ARGUMENT_CHARACTERS * 4)) {
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
        throw new Error(streamErrorMessage(payload.error, label, apiKey));
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
      // reply would publish it as though it were written for the user.
      if (typeof delta.content === "string" && delta.content.length > 0) {
        produced = true;
        yield { kind: "delta", text: delta.content };
      }
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
        produced = true;
        this.accumulate(pending, delta.tool_calls);
      }
    }
    if (runSignal.aborted) return;

    const calls: TurnToolCall[] = [];
    for (const call of pending.values()) {
      const completed = this.completed(call);
      if (completed === undefined) {
        throw new Error(reason === "max-output"
          ? `${label} cut the model off partway through a tool call. Raise the model's max output in Settings, or ask for a smaller step.`
          : `${label} sent a tool call Roqer could not read. This model may not support tool calls well.`);
      }
      calls.push(completed);
    }
    // A model that could not form its tool call ends looking like a finished
    // turn with nothing in it. Said as what it is, so the loop can ask for a
    // smaller call instead of reporting that the model had no answer.
    if (calls.length === 0 && nativeReason !== undefined && MALFORMED_NATIVE_REASONS.test(nativeReason)) {
      reason = "malformed-tool-call";
    } else if (calls.length === 0 && relayError) {
      throw new Error(`${label} ended the turn with an error from the model's provider${nativeReason === undefined ? "" : ` (${nativeReason.slice(0, 80)})`}.`);
    }
    for (const call of calls) yield { kind: "tool-call", call };
    // Some local servers report `stop` for a turn that asked for tools.
    if (calls.length > 0 && (reason === undefined || reason === "end")) reason = "tool-use";
    if (reason === undefined && done) reason = "end";
    if (reason === undefined) {
      throw new Error(produced
        ? `${label} ended the answer without saying it was finished.`
        : `${label} closed the connection before the model produced anything.`);
    }
    yield usage === undefined ? { kind: "completed", stopReason: reason } : { kind: "completed", stopReason: reason, usage };
  }

  private completed(pending: PendingToolCall): TurnToolCall | undefined {
    let parsed: unknown;
    try {
      parsed = JSON.parse(pending.arguments.trim().length === 0 ? "{}" : pending.arguments) as unknown;
    } catch {
      return undefined;
    }
    this.calls += 1;
    const call = { id: usableCallId(pending.id, `call-${this.calls}`), name: pending.name, arguments: parsed };
    return isTurnToolCall(call) ? call : undefined;
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
        throw new Error(`${this.options.label} proposed more tool calls in one turn than Roqer accepts.`);
      }
      const current = pending.get(index) ?? { id: "", name: "", arguments: "" };
      if (typeof fragment.id === "string" && fragment.id.length > 0) current.id = fragment.id;
      if (call !== undefined) {
        if (names) current.name = call.name as string;
        // Most servers stream arguments as a string; a few send the object whole.
        const args = typeof call.arguments === "string"
          ? call.arguments
          : isRecord(call.arguments) ? JSON.stringify(call.arguments) : "";
        if (current.arguments.length + args.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
          throw new Error(`${this.options.label} sent tool-call arguments larger than Roqer accepts.`);
        }
        current.arguments += args;
      }
      pending.set(index, current);
    }
  }
}
