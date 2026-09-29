import {
  TransientTurnError,
  UnusableToolCallError,
  type TurnMessage,
  type TurnToolCall,
  type TurnEvent,
  type TurnRequest,
  type TurnStopReason,
  type TurnUsage,
} from "./turn-contract";

import type { TurnTransport } from "../agent-loop";
import {
  assembledToolCall, DEFAULT_REQUEST_TIMEOUT_MS, endpointRefusal, endpointUrl, fetchWithin, frameData, interruptedStream,
  isContextOverflow, isRecord, MAX_TOOL_ARGUMENT_CHARACTERS, MAX_TOOL_CALLS_PER_TURN, messageKey, oversizedToolCall,
  readErrorBody, serverSentFrames, streamFailure, tooManyToolCalls, turnKey, usableCallId,
} from "./http";

/**
 * A turn against an endpoint speaking OpenAI's Responses API: OpenAI itself,
 * Azure OpenAI, and the relays and local servers that imitate it.
 *
 * Nothing is kept on the server. Every request carries the whole
 * conversation with `store: false`, as the other transports do, so a turn
 * never depends on state the endpoint may have dropped. What Responses adds
 * over chat completions is reasoning that survives between turns: asked for
 * with `include: ["reasoning.encrypted_content"]`, each turn's reasoning comes
 * back as opaque items, and sent back with the turn that produced them it lets
 * a reasoning model carry its thinking across a run's tool calls instead of
 * starting cold after every result. Some OpenAI models are served only here.
 */

export type OpenAiResponsesOptions = Readonly<{
  baseUrl: string;
  apiKey: string | null;
  /** The connection's name, for messages. */
  label: string;
  /** Whether to send the run's reasoning effort, and ask for reasoning back. */
  reasoning: boolean;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}>;

type JsonRecord = Record<string, unknown>;

/**
 * The parts of a request an endpoint may refuse without the turn being wrong,
 * each dropped for the rest of the run once refused:
 *
 * - `summary`: reasoning summaries, which OpenAI gives only to verified
 *   organizations, and which are what shows a model thinking for minutes is
 *   still working.
 * - `include`: encrypted reasoning, which a model without reasoning or a server
 *   that does not keep it refuses.
 * - `replay`: earlier turns' reasoning items sent back, which a relay may not
 *   read, or an endpoint may no longer decrypt.
 */
type Optional = "summary" | "include" | "replay";

/**
 * Which optional part a 400 is about, when it names one that was sent. A
 * refusal of a replayed item is checked first: its message names encrypted
 * content too, and dropping `include` for it would lose all reasoning where
 * only the old items were at fault.
 */
function refusedOptional(body: string, sent: ReadonlySet<Optional>): Optional | undefined {
  const named: ReadonlyArray<readonly [Optional, RegExp]> = [
    ["replay", /type '?reasoning'?|reasoning item|could not be (?:verified|decrypted)|rs_[A-Za-z0-9]/i],
    ["include", /encrypted[_ ]content|\binclude\b/i],
    ["summary", /summar/i],
  ];
  return named.find(([part, pattern]) => sent.has(part) && pattern.test(body))?.[0];
}

/** One turn's output items as the endpoint produced them, kept to be sent back with the turn. */
type ProducedTurn = Readonly<{
  /** The turn's text and calls as the loop records its message. */
  key: string;
  /** The turn's items in input form, reasoning included, in the order they were produced. */
  items: readonly JsonRecord[];
}>;

/** An output item while it streams. */
type StreamItem =
  | { kind: "reasoning"; summary: JsonRecord[]; encrypted?: string }
  | { kind: "message"; text: string }
  | { kind: "call"; id: string; name: string; arguments: string; done: boolean };

function usageOf(value: unknown): TurnUsage | undefined {
  if (!isRecord(value)) return undefined;
  const inputTokens = value.input_tokens;
  const outputTokens = value.output_tokens;
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens)) return undefined;
  if ((inputTokens as number) < 0 || (outputTokens as number) < 0) return undefined;
  const details = value.input_tokens_details;
  const cached = isRecord(details) ? details.cached_tokens : undefined;
  return Number.isSafeInteger(cached) && (cached as number) >= 0 && (cached as number) <= (inputTokens as number)
    ? { inputTokens: inputTokens as number, outputTokens: outputTokens as number, cachedInputTokens: cached as number }
    : { inputTokens: inputTokens as number, outputTokens: outputTokens as number };
}

const isReasoningItem = (item: JsonRecord) => item.type === "reasoning";

/**
 * A user turn as input items. Tool results are items of their own and come
 * first, answering the calls before them; the turn's prose and pictures,
 * screenshots a tool returned included, follow as one user message.
 */
function userItems(message: TurnMessage): JsonRecord[] {
  const items: JsonRecord[] = [];
  const content: JsonRecord[] = [];
  for (const block of message.content) {
    if (block.kind === "tool-result") {
      items.push({ type: "function_call_output", call_id: block.callId, output: block.content || "(no output)" });
    } else if (block.kind === "image") {
      content.push({ type: "input_image", image_url: `data:${block.mediaType};base64,${block.data}` });
    } else if (block.kind === "text" && block.text.length > 0) {
      content.push({ type: "input_text", text: block.text });
    }
  }
  if (content.length > 0) items.push({ type: "message", role: "user", content });
  return items;
}

/** An assistant turn this transport has no record of, in the plain form the loop keeps. */
function plainAssistantItems(message: TurnMessage): JsonRecord[] {
  const text = message.content.flatMap((block) => block.kind === "text" ? [block.text] : []).join("");
  const items: JsonRecord[] = text.length > 0 ? [assistantMessage(text)] : [];
  for (const block of message.content) {
    if (block.kind === "tool-call") items.push(functionCall(block.call.id, block.call.name, JSON.stringify(block.call.arguments)));
  }
  return items;
}

// Item ids are left out: with `store: false` the endpoint has nothing to look
// them up against, and the items stand on their own content.
const assistantMessage = (text: string): JsonRecord => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }] });
const functionCall = (callId: string, name: string, args: string): JsonRecord => ({ type: "function_call", call_id: callId, name, arguments: args });

export class OpenAiResponsesTurns implements TurnTransport {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly timeoutMs: number;
  private calls = 0;
  /** This run's turns that produced reasoning, oldest first. */
  private produced: ProducedTurn[] = [];
  /** Optional parts this endpoint refused; they are not sent again for the rest of the run. */
  private readonly refused = new Set<Optional>();

  constructor(private readonly options: OpenAiResponsesOptions) {
    this.endpoint = endpointUrl(options.baseUrl, "responses");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.timeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  /**
   * The request, with every earlier turn's reasoning sent back where it was
   * produced. Turns are matched in order by what the loop kept of them, the way
   * the other transports match their own; a turn older than the oldest one
   * still in the conversation was folded away and is forgotten.
   */
  private body(request: TurnRequest): { body: JsonRecord; sent: ReadonlySet<Optional> } {
    const sent = new Set<Optional>();
    const replay = !this.refused.has("replay");
    const input: JsonRecord[] = [];
    let next = 0;
    let firstMatched: number | undefined;
    for (const message of request.messages) {
      if (message.role === "user") {
        input.push(...userItems(message));
        continue;
      }
      const key = messageKey(message);
      let index = next;
      while (index < this.produced.length && this.produced[index].key !== key) index += 1;
      if (index >= this.produced.length) {
        input.push(...plainAssistantItems(message));
        continue;
      }
      next = index + 1;
      firstMatched ??= index;
      const items = this.produced[index].items;
      if (replay) sent.add("replay");
      input.push(...(replay ? items : items.filter((item) => !isReasoningItem(item))));
    }
    if (firstMatched !== undefined && firstMatched > 0) this.produced = this.produced.slice(firstMatched);

    const maxOutput = request.maxOutputTokens ?? this.options.maxOutputTokens;
    const reasoning: JsonRecord = {};
    if (this.options.reasoning) {
      reasoning.effort = request.reasoningEffort;
      if (!this.refused.has("summary")) {
        reasoning.summary = "auto";
        sent.add("summary");
      }
    }
    const include = this.options.reasoning && !this.refused.has("include");
    if (include) sent.add("include");
    const instructions = request.instructions.developer === undefined
      ? request.instructions.system
      : `${request.instructions.system}\n\n${request.instructions.developer}`;
    return {
      body: {
        model: request.modelId,
        instructions,
        input,
        stream: true,
        store: false,
        ...(maxOutput === undefined ? {} : { max_output_tokens: maxOutput }),
        ...(Object.keys(reasoning).length === 0 ? {} : { reasoning }),
        ...(include ? { include: ["reasoning.encrypted_content"] } : {}),
        ...(request.tools.length === 0 ? {} : {
          // Roqer's tool schemas are not written for strict mode, which some
          // endpoints turn on when it is not said.
          tools: request.tools.map((tool) => ({
            type: "function", name: tool.name, description: tool.description, parameters: tool.parameters, strict: false,
          })),
        }),
      },
      sent,
    };
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
          const part = (response.status === 400 || response.status === 422) && !isContextOverflow(response.status, refusal)
            ? refusedOptional(refusal, sent)
            : undefined;
          if (part !== undefined) {
            // Each part is dropped once, so this ends after at most three tries.
            this.refused.add(part);
            // Without encrypted reasoning there is nothing new to send back,
            // and what was kept may be what the endpoint could not read.
            if (part === "include") this.refused.add("replay");
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
    const items = new Map<number, StreamItem>();
    let reason: TurnStopReason | undefined;
    let usage: TurnUsage | undefined;
    let refusal = false;
    let produced = false;

    /** The item at an output index, begun from what an event says of it when it is new. */
    const itemAt = (index: number, item: JsonRecord): StreamItem | undefined => {
      const existing = items.get(index);
      if (existing !== undefined) return existing;
      let begun: StreamItem | undefined;
      if (item.type === "reasoning") {
        begun = { kind: "reasoning", summary: [] };
      } else if (item.type === "message") {
        begun = { kind: "message", text: "" };
      } else if (item.type === "function_call") {
        if ([...items.values()].filter((entry) => entry.kind === "call").length >= MAX_TOOL_CALLS_PER_TURN) {
          throw tooManyToolCalls(label);
        }
        begun = {
          kind: "call",
          id: typeof item.call_id === "string" ? item.call_id : "",
          name: typeof item.name === "string" ? item.name : "",
          arguments: "",
          done: false,
        };
      }
      if (begun !== undefined) items.set(index, begun);
      return begun;
    };

    for await (const frame of serverSentFrames(body, signal, MAX_TOOL_ARGUMENT_CHARACTERS * 4, alive)) {
      const data = frameData(frame);
      if (data === undefined) continue;
      if (data === "[DONE]") break;
      let payload: unknown;
      try {
        payload = JSON.parse(data) as unknown;
      } catch {
        throw new Error(`${label} sent a response Roqer could not read.`);
      }
      if (!isRecord(payload) || typeof payload.type !== "string") continue;
      const index = typeof payload.output_index === "number" ? payload.output_index : 0;
      switch (payload.type) {
        case "error":
          // OpenAI puts the error's fields on the event; some relays nest them.
          throw streamFailure(isRecord(payload.error) ? payload.error : payload, label, apiKey);
        case "response.failed": {
          const failed = isRecord(payload.response) ? payload.response.error : undefined;
          throw streamFailure(isRecord(failed) ? failed : "The response failed.", label, apiKey);
        }
        case "response.output_item.added": {
          if (!isRecord(payload.item)) break;
          const item = itemAt(index, payload.item);
          if (item?.kind === "reasoning") {
            produced = true;
            yield { kind: "reasoning" };
          }
          break;
        }
        case "response.output_text.delta":
        case "response.refusal.delta": {
          if (typeof payload.delta !== "string" || payload.delta.length === 0) break;
          produced = true;
          if (payload.type === "response.refusal.delta") refusal = true;
          const item = itemAt(index, { type: "message" });
          if (item?.kind === "message") item.text += payload.delta;
          yield { kind: "delta", text: payload.delta };
          break;
        }
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          // Reasoning is never shown: it is not written for the user. That it
          // is arriving is still reported, so a model reasoning for minutes is
          // not read as stalled.
          produced = true;
          const characters = typeof payload.delta === "string" ? payload.delta.length : 0;
          yield characters > 0 ? { kind: "reasoning", characters } : { kind: "reasoning" };
          break;
        }
        case "response.function_call_arguments.delta": {
          if (typeof payload.delta !== "string") break;
          const item = itemAt(index, { type: "function_call" });
          if (item?.kind !== "call" || item.done) break;
          produced = true;
          if (item.arguments.length + payload.delta.length > MAX_TOOL_ARGUMENT_CHARACTERS) {
            throw oversizedToolCall(label, item.name);
          }
          item.arguments += payload.delta;
          if (payload.delta.length > 0) yield { kind: "tool-input", characters: payload.delta.length };
          break;
        }
        case "response.output_item.done": {
          if (!isRecord(payload.item)) break;
          const done = payload.item;
          const item = itemAt(index, done);
          // The finished item is the authority on what the turn produced.
          if (item?.kind === "reasoning") {
            if (Array.isArray(done.summary)) item.summary = done.summary.filter(isRecord);
            if (typeof done.encrypted_content === "string" && done.encrypted_content.length > 0) item.encrypted = done.encrypted_content;
          } else if (item?.kind === "call") {
            if (typeof done.call_id === "string") item.id = done.call_id;
            if (typeof done.name === "string") item.name = done.name;
            if (typeof done.arguments === "string") {
              if (done.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS) throw oversizedToolCall(label, item.name);
              item.arguments = done.arguments;
            }
            item.done = true;
          } else if (item?.kind === "message" && item.text.length === 0 && Array.isArray(done.content)) {
            // A server that sends the message whole, without deltas. One that
            // streamed it keeps what it streamed, which is what the loop recorded.
            const text = done.content.flatMap((part) => !isRecord(part) ? []
              : part.type === "output_text" && typeof part.text === "string" ? [part.text]
                : part.type === "refusal" && typeof part.refusal === "string" ? [part.refusal] : []).join("");
            if (text.length > 0) {
              produced = true;
              if (done.content.some((part) => isRecord(part) && part.type === "refusal")) refusal = true;
              item.text = text;
              yield { kind: "delta", text };
            }
          }
          break;
        }
        case "response.completed":
        case "response.incomplete": {
          const finished = isRecord(payload.response) ? payload.response : {};
          const reported = usageOf(finished.usage);
          if (reported !== undefined) usage = reported;
          if (payload.type === "response.completed") {
            reason = "end";
          } else {
            const details = isRecord(finished.incomplete_details) ? finished.incomplete_details : {};
            reason = details.reason === "content_filter" ? "refusal" : "max-output";
          }
          break;
        }
        default:
          break;
      }
      if (reason !== undefined) break;
    }
    if (runSignal.aborted) return;

    const calls: TurnToolCall[] = [];
    const kept: JsonRecord[] = [];
    let text = "";
    let hasReasoning = false;
    for (const item of [...items.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry)) {
      if (item.kind === "reasoning" && item.encrypted !== undefined) {
        kept.push({ type: "reasoning", summary: item.summary, encrypted_content: item.encrypted });
        hasReasoning = true;
      } else if (item.kind === "message" && item.text.length > 0) {
        kept.push(assistantMessage(item.text));
        text += item.text;
      } else if (item.kind === "call") {
        this.calls += 1;
        const call = assembledToolCall(label, usableCallId(item.id, `call-${this.calls}`), item.name, item.arguments, reason);
        if (call instanceof UnusableToolCallError) throw call;
        calls.push(call);
        kept.push(functionCall(call.id, call.name, item.arguments));
      }
    }
    // A stream that stopped without saying it was finished was cut off, and a
    // turn that was cut off is simply asked for again.
    if (reason === undefined) {
      throw new TransientTurnError(produced
        ? `${label} ended the answer without saying it was finished.`
        : `${label} closed the connection before the model produced anything.`);
    }
    // Responses has no finish reason for a turn that asks for tools; the calls say it.
    if (reason === "end" && calls.length > 0) reason = "tool-use";
    else if (reason === "end" && refusal) reason = "refusal";
    if (hasReasoning) this.produced.push({ key: turnKey(text, calls), items: kept });
    for (const call of calls) yield { kind: "tool-call", call };
    yield usage === undefined ? { kind: "completed", stopReason: reason } : { kind: "completed", stopReason: reason, usage };
  }
}
