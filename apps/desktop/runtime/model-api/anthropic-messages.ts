import { createHash } from "node:crypto";

import {
  TransientTurnError,
  UnusableToolCallError,
  type TurnMessage,
  type TurnReasoningEffort,
  type TurnToolCall,
  type TurnEvent,
  type TurnRequest,
  type TurnStopReason,
  type TurnUsage,
} from "./turn-contract";

import { DEFAULT_ANTHROPIC_MAX_OUTPUT } from "../../shared/custom-providers";
import type { TurnTransport } from "../agent-loop";
import {
  assembledToolCall, DEFAULT_REQUEST_TIMEOUT_MS, endpointRefusal, endpointUrl, fetchWithin, frameData, interruptedStream,
  isRecord, MAX_TOOL_ARGUMENT_CHARACTERS, MAX_TOOL_CALLS_PER_TURN, messageKey, oversizedToolCall, readErrorBody,
  serverSentFrames, streamFailure, tooManyToolCalls, turnKey, usableCallId,
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
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; arguments: string }
  | { kind: "thinking"; thinking: string; signature: string }
  | { kind: "redacted"; data: string };

/**
 * One assistant turn exactly as the endpoint produced it, kept so it can be
 * sent back exactly.
 *
 * With thinking on, the API reads an assistant turn's thinking only when it
 * comes back unchanged, in its place among the turn's text and tool calls --
 * and on current models those interleave, so the order is part of the turn.
 * The loop records a turn more plainly, as its text and its calls, and that
 * plain form is how its message is recognised here.
 */
type ProducedTurn = Readonly<{
  /** The turn's text and calls as the loop records its message. */
  key: string;
  /** Every block the turn produced, thinking included, in the order it produced them. */
  blocks: readonly ContentBlock[];
  hasThinking: boolean;
  /** Digest of the conversation before this turn, thinking aside. */
  prefix: string;
  /** The turn whose thinking was the last sent back before this one was produced. */
  after: ProducedTurn | undefined;
}>;

/** What one rendering of a request sent back, which the turn it produces is recorded against. */
type Rendering = Readonly<{
  messages: AnthropicMessage[];
  /** Digest of the whole conversation as sent, thinking aside. */
  digest: string;
  lastReplayed: ProducedTurn | undefined;
  replayedThinking: boolean;
}>;

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

/** The effort an adaptive-thinking model is sent for each of the run's levels. */
const ADAPTIVE_EFFORT: Readonly<Partial<Record<TurnReasoningEffort, string>>> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  ultra: "max",
};

/**
 * Whether a model takes its thinking as a fixed budget rather than adaptively.
 *
 * Claude models from 4.6 on think adaptively, steered by an effort, and from
 * 4.7 on they refuse a budget outright -- so a budget sent to a current model
 * failed every turn of a run with reasoning on. Claude models before 4.6 know
 * only the budget. A model not named as Claude is behind an endpoint imitating
 * Anthropic's API, and the budget is the shape those were built to imitate.
 *
 * This is a guess from the name, and a proxy may name a model anything; the
 * endpoint's refusal of the wrong shape corrects it (see `streamTurn`).
 */
export function usesThinkingBudget(modelId: string): boolean {
  const version = /claude-(?:(?:opus|sonnet|haiku|fable|mythos)-)?(\d+)(?:[-.](\d{1,2})(?!\d))?/i.exec(modelId);
  if (version === null) return !/claude/i.test(modelId);
  const major = Number(version[1]);
  const minor = version[2] === undefined ? 0 : Number(version[2]);
  return major < 4 || (major === 4 && minor < 6);
}

/** A 400 about how thinking was asked for, which the other shape answers. */
const THINKING_SHAPE_REFUSAL = /budget_tokens|adaptive|output_config|effort/i;

/**
 * A 400 about a thinking block sent back into a conversation that is no
 * longer the one that produced it. Anthropic's documented recovery is to send
 * the conversation again without the thinking.
 */
const THINKING_BINDING_REFUSAL = /signature|different conversation/i;

function isThinking(block: ContentBlock): block is ThinkingBlock {
  return block.type === "thinking" || block.type === "redacted_thinking";
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

function userContent(message: TurnMessage): ContentBlock[] {
  // Anthropic reads a tool_use as answered only by a tool_result at the
  // head of the next message: one placed after an image or text counts as
  // missing, and the whole request is refused. The loop puts a screenshot
  // right after its own result, so a turn that captured and then read the
  // logs was refused, every time. Results go first, in call order; then
  // each returned image, labelled with the call it came from; then the rest.
  const content: ContentBlock[] = [];
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
  return [...content, ...rest];
}

/** An assistant turn this transport has no record of, in the plain form the loop keeps. */
function plainAssistantContent(message: TurnMessage): ContentBlock[] {
  const content: ContentBlock[] = [];
  for (const block of message.content) {
    if (block.kind === "tool-call") {
      content.push({ type: "tool_use", id: block.call.id, name: block.call.name, input: block.call.arguments });
    } else if (block.kind === "text" && block.text.length > 0) {
      content.push({ type: "text", text: block.text });
    }
  }
  return content;
}

export class AnthropicMessagesTurns implements TurnTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private readonly maxOutput: number;
  private calls = 0;
  /** Set on the first request from the model's name, and flipped if the endpoint refuses the shape. */
  private budgetShape: boolean | undefined;
  /** This run's assistant turns, oldest first. */
  private produced: ProducedTurn[] = [];
  /** Turns before this index are never sent back with their thinking again. */
  private strippedBefore = 0;

  constructor(private readonly options: AnthropicMessagesOptions) {
    this.endpoint = endpointUrl(options.baseUrl, "messages");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxOutput = options.maxOutputTokens ?? DEFAULT_ANTHROPIC_MAX_OUTPUT;
  }

  /**
   * The conversation as Anthropic reads it, with every earlier turn sent back
   * as it was produced.
   *
   * Every turn's thinking goes back, not only the latest: the API decides
   * which of it the model reads, and a turn that loses its thinking between
   * two requests changes the conversation's prefix, which spent the prompt
   * cache on everything after it on every turn of a run with thinking on.
   *
   * What the API does not accept is thinking sent back into a conversation
   * that has changed since it was produced. The loop bounds a long run by
   * folding old exchanges, eliding old tool output, and dropping old
   * screenshots, each of which rewrites what came before later turns. So each
   * turn is recorded with a digest of what preceded it, and its thinking goes
   * back only while that is unchanged and the thinking sent back before it is
   * still the thinking that was sent back when it was produced. A turn that
   * fails either keeps its text and calls and loses only its thinking, which is
   * what Anthropic's own guidance asks for after a history edit.
   */
  private render(request: TurnRequest, system: string, tools: unknown): Rendering {
    const hash = createHash("sha256").update(JSON.stringify([system, tools]));
    const messages: AnthropicMessage[] = [];
    let next = 0;
    let firstMatched: number | undefined;
    let lastReplayed: ProducedTurn | undefined;
    let replayedThinking = false;
    for (const message of request.messages) {
      let rendered: AnthropicMessage;
      if (message.role === "user") {
        rendered = { role: "user", content: userContent(message) };
      } else {
        const key = messageKey(message);
        let index = next;
        while (index < this.produced.length && this.produced[index].key !== key) index += 1;
        if (index >= this.produced.length) {
          rendered = { role: "assistant", content: plainAssistantContent(message) };
        } else {
          next = index + 1;
          firstMatched ??= index;
          const turn = this.produced[index];
          const replay = turn.hasThinking && index >= this.strippedBefore &&
            turn.after === lastReplayed && turn.prefix === hash.copy().digest("hex");
          if (replay) {
            lastReplayed = turn;
            replayedThinking = true;
          }
          rendered = { role: "assistant", content: replay ? turn.blocks : turn.blocks.filter((block) => !isThinking(block)) };
        }
      }
      messages.push(rendered);
      hash.update(JSON.stringify({ role: rendered.role, content: rendered.content.filter((block) => !isThinking(block)) }));
    }
    // A turn older than the oldest one still in the conversation was folded
    // away and can never be sent back again.
    if (firstMatched !== undefined && firstMatched > 0) {
      this.produced = this.produced.slice(firstMatched);
      this.strippedBefore = Math.max(0, this.strippedBefore - firstMatched);
    }
    return { messages, digest: hash.digest("hex"), lastReplayed, replayedThinking };
  }

  private thinking(request: TurnRequest, maxTokens: number): Record<string, unknown> {
    if (!this.options.reasoning) return {};
    this.budgetShape ??= usesThinkingBudget(request.modelId);
    if (!this.budgetShape) {
      const effort = ADAPTIVE_EFFORT[request.reasoningEffort];
      return effort === undefined ? {} : { thinking: { type: "adaptive" }, output_config: { effort } };
    }
    // Thinking counts against `max_tokens`, so it may take at most half: the
    // other half is the answer and its tool calls, which is where the work is.
    const desired = thinkingBudget(request.reasoningEffort);
    const budget = desired === undefined ? undefined : Math.min(desired, Math.floor(maxTokens / 2));
    return budget === undefined || budget < MIN_THINKING_BUDGET
      ? {}
      : { thinking: { type: "enabled", budget_tokens: budget } };
  }

  private body(request: TurnRequest): { body: Record<string, unknown>; rendering: Rendering; thinkingSent: boolean } {
    const system = request.instructions.developer === undefined
      ? request.instructions.system
      : `${request.instructions.system}\n\n${request.instructions.developer}`;
    const maxTokens = request.maxOutputTokens ?? this.maxOutput;
    const tools = request.tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    const rendering = this.render(request, system, tools);
    const messages = rendering.messages;
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
    const thinking = this.thinking(request, maxTokens);
    return {
      body: {
        model: request.modelId,
        max_tokens: maxTokens,
        stream: true,
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        messages,
        ...(tools.length === 0 ? {} : { tools }),
        ...thinking,
      },
      rendering,
      thinkingSent: "thinking" in thinking,
    };
  }

  async *streamTurn(request: TurnRequest, signal: AbortSignal): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    // Each of these corrects one thing the endpoint refused, once per turn.
    let reshaped = false;
    let stripped = false;
    for (;;) {
      const { body, rendering, thinkingSent } = this.body(request);
      const opened = await fetchWithin(this.fetchImpl, this.endpoint, {
        method: "POST",
        headers: {
          ...(apiKey === null ? {} : { "x-api-key": apiKey }),
          "anthropic-version": ANTHROPIC_VERSION,
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
          if (response.status === 400 && !stripped && rendering.replayedThinking && THINKING_BINDING_REFUSAL.test(refusal)) {
            // Thinking this transport believed current was not. Everything
            // recorded so far goes back without it from now on; turns
            // produced after this chain from the conversation as sent now.
            stripped = true;
            this.strippedBefore = this.produced.length;
            continue;
          }
          if (response.status === 400 && !reshaped && thinkingSent && THINKING_SHAPE_REFUSAL.test(refusal)) {
            // The model's name led to the wrong way of asking for thinking.
            reshaped = true;
            this.budgetShape = !this.budgetShape;
            continue;
          }
          throw endpointRefusal(response, refusal, label, apiKey);
        }
        try {
          yield* this.readStream(response.body, cancellation.signal, signal, opened.alive, rendering);
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
    rendering: Rendering,
  ): AsyncGenerator<TurnEvent, void, undefined> {
    const { label, apiKey } = this.options;
    const blocks = new Map<number, StreamBlock>();
    const thinkingOpen = new Set<number>();
    let reason: TurnStopReason | undefined;
    let usage: TurnUsage | undefined;
    let stopped = false;
    let produced = false;

    for await (const frame of serverSentFrames(body, signal, MAX_TOOL_ARGUMENT_CHARACTERS * 4, alive)) {
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
      if (payload.type === "error") throw streamFailure(payload.error, label, apiKey);
      if (payload.type === "ping") {
        // A keep-alive is not progress, except while the model is inside a
        // thinking block: then it is the only sign a model thinking without
        // showing its thoughts is still there.
        if (thinkingOpen.size > 0) yield { kind: "reasoning" };
      } else if (payload.type === "message_start") {
        const reported = isRecord(payload.message) ? usageOf(payload.message.usage) : undefined;
        if (reported !== undefined) usage = reported;
      } else if (payload.type === "content_block_start") {
        const block = isRecord(payload.content_block) ? payload.content_block : undefined;
        if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
          if ([...blocks.values()].filter((entry) => entry.kind === "tool").length >= MAX_TOOL_CALLS_PER_TURN) {
            throw tooManyToolCalls(label);
          }
          blocks.set(index, { kind: "tool", id: block.id, name: block.name, arguments: "" });
        } else if (block?.type === "text") {
          blocks.set(index, { kind: "text", text: "" });
        } else if (block?.type === "thinking") {
          blocks.set(index, { kind: "thinking", thinking: "", signature: "" });
          thinkingOpen.add(index);
          produced = true;
          yield { kind: "reasoning" };
        } else if (block?.type === "redacted_thinking" && typeof block.data === "string") {
          blocks.set(index, { kind: "redacted", data: block.data });
          produced = true;
          yield { kind: "reasoning" };
        }
      } else if (payload.type === "content_block_stop") {
        thinkingOpen.delete(index);
      } else if (payload.type === "content_block_delta") {
        const delta = isRecord(payload.delta) ? payload.delta : undefined;
        const current = blocks.get(index);
        produced = true;
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          if (current?.kind === "text") current.text += delta.text;
          yield { kind: "delta", text: delta.text };
        } else if (delta?.type === "input_json_delta" && typeof delta.partial_json === "string" && current?.kind === "tool") {
          if (current.arguments.length + delta.partial_json.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
            throw oversizedToolCall(label, current.name);
          }
          current.arguments += delta.partial_json;
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && current?.kind === "thinking") {
          current.thinking += delta.thinking;
          yield { kind: "reasoning" };
        } else if (delta?.type === "signature_delta" && typeof delta.signature === "string" && current?.kind === "thinking") {
          current.signature += delta.signature;
          yield { kind: "reasoning" };
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
    const kept: ContentBlock[] = [];
    let text = "";
    let hasThinking = false;
    for (const block of [...blocks.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry)) {
      if (block.kind === "thinking" && block.signature.length > 0) {
        kept.push({ type: "thinking", thinking: block.thinking, signature: block.signature });
        hasThinking = true;
      } else if (block.kind === "redacted") {
        kept.push({ type: "redacted_thinking", data: block.data });
        hasThinking = true;
      } else if (block.kind === "text" && block.text.length > 0) {
        kept.push({ type: "text", text: block.text });
        text += block.text;
      } else if (block.kind === "tool") {
        this.calls += 1;
        const call = assembledToolCall(label, usableCallId(block.id, `call-${this.calls}`), block.name, block.arguments, reason);
        if (call instanceof UnusableToolCallError) throw call;
        calls.push(call);
        kept.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
    }
    if (reason === undefined && stopped) reason = calls.length > 0 ? "tool-use" : "end";
    // A stream that stopped without saying it was finished was cut off, and a
    // turn that was cut off is simply asked for again.
    if (reason === undefined) {
      throw new TransientTurnError(produced
        ? `${label} ended the answer without saying it was finished.`
        : `${label} closed the connection before the model produced anything.`);
    }
    this.produced.push({
      key: turnKey(text, calls),
      blocks: kept,
      hasThinking,
      prefix: rendering.digest,
      after: rendering.lastReplayed,
    });
    for (const call of calls) yield { kind: "tool-call", call };
    yield usage === undefined ? { kind: "completed", stopReason: reason } : { kind: "completed", stopReason: reason, usage };
  }
}
