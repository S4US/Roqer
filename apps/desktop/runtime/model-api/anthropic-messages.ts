import {
  isTurnToolCall,
  type TurnToolCall,
  type TurnEvent,
  type TurnRequest,
  type TurnStopReason,
  type TurnUsage,
} from "./turn-contract";

import { DEFAULT_ANTHROPIC_MAX_OUTPUT } from "../../shared/custom-providers";
import type { TurnTransport } from "../agent-loop";
import {
  DEFAULT_REQUEST_TIMEOUT_MS, endpointUrl, fetchWithin, frameData, isRecord, MAX_TOOL_ARGUMENT_CHARACTERS,
  MAX_TOOL_CALLS_PER_TURN, refusalMessage, serverSentFrames, streamErrorMessage, usableCallId,
} from "./http";

/**
 * A turn against an endpoint speaking Anthropic's Messages API: Anthropic
 * itself, or a proxy that imitates it.
 *
 * Began as a port of the retired hosted gateway's adapter. Two things differ because this
 * talks to Anthropic directly. It authenticates with `x-api-key` and names an
 * API version. And it keeps the model's thinking blocks: with extended
 * thinking on, the API refuses a tool-result turn unless the assistant turn
 * before it is sent back with the thinking it began with, signature intact.
 */

export const ANTHROPIC_VERSION = "2023-06-01";
export { DEFAULT_ANTHROPIC_MAX_OUTPUT };
/** Anthropic's smallest thinking budget. */
const MIN_THINKING_BUDGET = 1_024;

export type AnthropicMessagesOptions = Readonly<{
  baseUrl: string;
  apiKey: string | null;
  label: string;
  reasoning: boolean;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}>;

type ThinkingBlock =
  | Readonly<{ type: "thinking"; thinking: string; signature: string }>
  | Readonly<{ type: "redacted_thinking"; data: string }>;

type ContentBlock =
  | Readonly<{ type: "text"; text: string; cache_control?: Readonly<{ type: "ephemeral" }> }>
  | Readonly<{ type: "image"; source: Readonly<{ type: "base64"; media_type: string; data: string }>; cache_control?: Readonly<{ type: "ephemeral" }> }>
  | Readonly<{ type: "tool_use"; id: string; name: string; input: Readonly<Record<string, unknown>> }>
  | Readonly<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean; cache_control?: Readonly<{ type: "ephemeral" }> }>
  | ThinkingBlock;

type AnthropicMessage = Readonly<{ role: "user" | "assistant"; content: readonly ContentBlock[] }>;

type StreamBlock =
  | { kind: "text" }
  | { kind: "tool"; id: string; name: string; arguments: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string };

function stopReason(value: unknown): TurnStopReason {
  switch (value) {
    case "tool_use":
      return "tool-use";
    case "max_tokens":
      return "max-output";
    case "refusal":
      return "refusal";
    default:
      return "end";
  }
}

function thinkingBudget(effort: string): number | undefined {
  switch (effort) {
    case "low":
      return 4_096;
    case "medium":
      return 10_000;
    case "high":
      return 24_000;
    case "xhigh":
      return 32_000;
    case "max":
    case "ultra":
      return 48_000;
    default:
      return undefined;
  }
}

/**
 * Anthropic reports cache reads and writes beside `input_tokens` rather than
 * inside it, so the raw prompt is their sum and the cache hit is the read.
 */
function usageOf(value: unknown): TurnUsage | undefined {
  if (!isRecord(value)) return undefined;
  const fresh = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!Number.isSafeInteger(fresh) || (fresh as number) < 0) return undefined;
  if (!Number.isSafeInteger(outputTokens) || (outputTokens as number) < 0) return undefined;
  const read = Number.isSafeInteger(value.cache_read_input_tokens) ? value.cache_read_input_tokens as number : 0;
  const written = Number.isSafeInteger(value.cache_creation_input_tokens) ? value.cache_creation_input_tokens as number : 0;
  return { inputTokens: (fresh as number) + read + written, outputTokens: outputTokens as number, cachedInputTokens: read };
}

export class AnthropicMessagesTurns implements TurnTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxOutput: number;
  private calls = 0;
  /**
   * The thinking the model did in its latest tool-using turn, keyed by that
   * turn's first tool call. Only the latest is kept: the API needs thinking
   * for the assistant turn a tool result answers, and ignores it on older ones.
   */
  private thinking: { callId: string; blocks: ThinkingBlock[] } | undefined;

  constructor(private readonly options: AnthropicMessagesOptions) {
    this.endpoint = endpointUrl(options.baseUrl, "messages");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxOutput = options.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT;
  }

  private messages(request: TurnRequest): AnthropicMessage[] {
    const messages = request.messages.map((message): AnthropicMessage => {
      const content: ContentBlock[] = [];
      if (message.role === "user") {
        // Anthropic reads a tool_use as answered only by a tool_result at the
        // head of the next message: one placed after an image or text counts as
        // missing, and the whole request is refused. The loop puts a screenshot
        // right after its own result, so a turn that captured and then read the
        // logs was refused, every time. Results go first, in call order; then
        // each returned image, labelled with the call it came from; then the rest.
        const rest: ContentBlock[] = [];
        let lastResult: string | undefined;
        for (const block of message.content) {
          if (block.kind === "tool-result") {
            content.push({ type: "tool_result", tool_use_id: block.callId, content: block.content || "(no output)", is_error: block.failed });
            lastResult = block.callId;
          } else if (block.kind === "image") {
            if (lastResult !== undefined) rest.push({ type: "text", text: `Image returned by tool call ${lastResult}:` });
            rest.push({ type: "image", source: { type: "base64", media_type: block.mediaType, data: block.data } });
          } else if (block.kind === "text" && block.text.length > 0) {
            lastResult = undefined;
            rest.push({ type: "text", text: block.text });
          }
        }
        content.push(...rest);
        return { role: "user", content };
      }
      const firstCall = message.content.find((block) => block.kind === "tool-call");
      if (firstCall?.kind === "tool-call" && this.thinking?.callId === firstCall.call.id) {
        content.push(...this.thinking.blocks);
      }
      for (const block of message.content) {
        if (block.kind === "tool-call") {
          content.push({ type: "tool_use", id: block.call.id, name: block.call.name, input: block.call.arguments });
        } else if (block.kind === "text" && block.text.length > 0) {
          content.push({ type: "text", text: block.text });
        }
      }
      return { role: "assistant", content };
    });
    // A cache breakpoint on the newest block: every turn re-sends the whole
    // conversation, and this lets Anthropic serve the repeated prefix from
    // cache at a fraction of the price instead of billing it again in full.
    const last = messages.at(-1);
    const tail = last?.content.at(-1);
    if (last !== undefined && tail !== undefined &&
      (tail.type === "text" || tail.type === "image" || tail.type === "tool_result")) {
      messages[messages.length - 1] = {
        ...last,
        content: [...last.content.slice(0, -1), { ...tail, cache_control: { type: "ephemeral" } }],
      };
    }
    return messages;
  }

  private body(request: TurnRequest): Record<string, unknown> {
    const system = request.instructions.developer === undefined
      ? request.instructions.system
      : `${request.instructions.system}\n\n${request.instructions.developer}`;
    const maxTokens = request.maxOutputTokens ?? this.maxOutput;
    // Thinking counts against `max_tokens`, so it may take at most half: the
    // other half is the answer and its tool calls, which is where the work is.
    const desired = this.options.reasoning ? thinkingBudget(request.reasoningEffort) : undefined;
    const budget = desired === undefined ? undefined : Math.min(desired, Math.floor(maxTokens / 2));
    const thinking = budget === undefined || budget < MIN_THINKING_BUDGET
      ? undefined
      : { type: "enabled", budget_tokens: budget };
    return {
      model: request.modelId,
      max_tokens: maxTokens,
      stream: true,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      messages: this.messages(request),
      ...(request.tools.length === 0 ? {} : {
        tools: request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters })),
      }),
      ...(thinking === undefined ? {} : { thinking }),
    };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    const opened = await fetchWithin(this.fetchImpl, this.endpoint, {
      method: "POST",
      headers: {
        ...(apiKey === null ? {} : { "x-api-key": apiKey }),
        "anthropic-version": ANTHROPIC_VERSION,
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
    const blocks = new Map<number, StreamBlock>();
    let reason: TurnStopReason | undefined;
    let usage: TurnUsage | undefined;
    let stopped = false;
    let produced = false;

    for await (const frame of serverSentFrames(body, signal, MAX_TOOL_ARGUMENT_CHARACTERS * 4)) {
      const data = frameData(frame);
      if (data === undefined) continue;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw new Error(`${label} sent a response Roqer could not read.`);
      }
      if (!isRecord(payload) || typeof payload.type !== "string") continue;
      const index = typeof payload.index === "number" ? payload.index : 0;
      if (payload.type === "error") throw new Error(streamErrorMessage(payload.error, label, apiKey));
      if (payload.type === "message_start") {
        const reported = isRecord(payload.message) ? usageOf(payload.message.usage) : undefined;
        if (reported !== undefined) usage = reported;
      } else if (payload.type === "content_block_start") {
        const block = isRecord(payload.content_block) ? payload.content_block : undefined;
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          if ([...blocks.values()].filter((entry) => entry.kind === "tool").length >= MAX_TOOL_CALLS_PER_TURN) {
            throw new Error(`${label} proposed more tool calls in one turn than Roqer accepts.`);
          }
          blocks.set(index, { kind: "tool", id: block.id, name: block.name, arguments: "" });
        } else if (block?.type === "text") {
          blocks.set(index, { kind: "text" });
        } else if (block?.type === "thinking") {
          blocks.set(index, { kind: "thinking", thinking: "", signature: "" });
        } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
          blocks.set(index, { kind: "redacted", data: block.data });
        }
      } else if (payload.type === "content_block_delta") {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        const current = blocks.get(index);
        produced = true;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          yield { kind: "delta", text: delta.text };
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && current?.kind === "tool") {
          if (current.arguments.length + delta.partial_json.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
            throw new Error(`${label} sent tool-call arguments larger than Roqer accepts.`);
          }
          current.arguments += delta.partial_json;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && current?.kind === "thinking") {
          current.thinking += delta.thinking;
        } else if (delta?.type === "signature_delta" && typeof delta.signature === "string" && current?.kind === "thinking") {
          current.signature += delta.signature;
        }
      } else if (payload.type === "message_delta") {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        if (delta?.stop_reason !== undefined && delta.stop_reason !== null) reason = stopReason(delta.stop_reason);
        const reported = usageOf(payload.usage);
        if (reported !== undefined) {
          usage = reported;
        } else if (isRecord(payload.usage) && usage !== undefined && Number.isSafeInteger(payload.usage.output_tokens)) {
          // Anthropic itself sends only the output count here; the input side
          // arrived with `message_start` and still stands.
          usage = { ...usage, outputTokens: payload.usage.output_tokens as number };
        }
      } else if (payload.type === "message_stop") {
        stopped = true;
        break;
      }
    }
    if (runSignal.aborted) return;

    const calls: TurnToolCall[] = [];
    const thinking: ThinkingBlock[] = [];
    for (const block of [...blocks.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry)) {
      if (block.kind === "thinking" && block.signature.length > 0) {
        thinking.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
      } else if (block.kind === "redacted") {
        thinking.push({ type: "redacted_thinking", data: block.data });
      } else if (block.kind === "tool") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(block.arguments.trim().length === 0 ? "{}" : block.arguments) as unknown;
        } catch {
          throw new Error(reason === "max-output"
            ? `${label} cut the model off partway through a tool call. Raise the model's max output in Settings, or ask for a smaller step.`
            : `${label} sent a tool call Roqer could not read.`);
        }
        this.calls += 1;
        const call = { id: usableCallId(block.id, `call-${this.calls}`), name: block.name, arguments: parsed };
        if (!isTurnToolCall(call)) throw new Error(`${label} sent a tool call Roqer could not read.`);
        calls.push(call);
      }
    }
    this.thinking = calls.length > 0 && thinking.length > 0 ? { callId: calls[0].id, blocks: thinking } : undefined;
    for (const call of calls) yield { kind: "tool-call", call };
    if (reason === undefined && stopped) reason = calls.length > 0 ? "tool-use" : "end";
    if (reason === undefined) {
      throw new Error(produced
        ? `${label} ended the answer without saying it was finished.`
        : `${label} closed the connection before the model produced anything.`);
    }
    yield usage === undefined ? { kind: "completed", stopReason: reason } : { kind: "completed", stopReason: reason, usage };
  }
}
