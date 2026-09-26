import assert from "node:assert/strict";
import test from "node:test";

import type { TurnEvent, TurnRequest } from "./turn-contract";
import { ContextOverflowError, TransientTurnError } from "./turn-contract";

import { AnthropicMessagesTurns, usesThinkingBudget } from "./anthropic-messages";
import { retryAfterMs } from "./http";
import { OpenAiChatTurns } from "./openai-chat";

type Sent = { url: string; headers: Record<string, string>; body: Record<string, unknown> };

/** A fetch that answers each request with the next scripted stream and records what it was sent. */
function endpoint(streams: ReadonlyArray<{ frames?: readonly string[]; status?: number; body?: string }>) {
  const sent: Sent[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(url),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    const script = streams[sent.length - 1];
    assert.ok(script, `no scripted response ${sent.length}`);
    if (script.status !== undefined && script.status !== 200) return new Response(script.body ?? "", { status: script.status });
    // CRLF framing, as some local servers send it.
    const text = (script.frames ?? []).map((frame) => `data: ${frame}\r\n\r\n`).join("");
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(text));
        controller.close();
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
}

const REQUEST: TurnRequest = {
  runId: "run-1",
  turnId: "run-1:turn:1",
  modelId: "some/model",
  reasoningEffort: "high",
  instructions: { system: "SYSTEM", developer: "DEVELOPER" },
  tools: [{ name: "roblox_studio", description: "Studio", parameters: { type: "object" } }],
  messages: [{ role: "user", content: [{ kind: "text", text: "Build a shop" }] }],
};

async function collect(stream: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const json = (value: unknown) => JSON.stringify(value);

test("an OpenAI-compatible turn streams prose and a tool call, keyless for a local server", async () => {
  const { fetch, sent } = endpoint([{
    frames: [
      json({ choices: [{ delta: { content: "Looking" } }] }),
      // Ollama-style: no index, no id, arguments as an object, and `stop` for a tool turn.
      json({ choices: [{ delta: { tool_calls: [{ function: { name: "roblox_studio", arguments: { operation: "get_place_info" } } }] } }] }),
      json({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      json({ usage: { prompt_tokens: 100, completion_tokens: 20 } }),
      "[DONE]",
    ],
  }]);
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:11434/v1", apiKey: null, label: "Ollama", reasoning: false, fetch });

  const events = await collect(turns.streamTurn(REQUEST, new AbortController().signal));

  assert.deepEqual(events, [
    { kind: "delta", text: "Looking" },
    { kind: "tool-call", call: { id: "call-1", name: "roblox_studio", arguments: { operation: "get_place_info" } } },
    { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 100, outputTokens: 20 } },
  ]);
  assert.equal(sent[0].url, "http://localhost:11434/v1/chat/completions");
  assert.equal(sent[0].headers.authorization, undefined, "no key, no header");
  assert.equal("reasoning_effort" in sent[0].body, false, "no effort for a model that takes none");
  assert.deepEqual((sent[0].body.messages as unknown[]).slice(0, 2), [
    { role: "system", content: "SYSTEM" },
    { role: "system", content: "DEVELOPER" },
  ]);
});

test("an OpenAI-compatible turn sends the key and effort, and the right output field per host", async () => {
  const done = { frames: [json({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }), "[DONE]"] };
  const { fetch, sent } = endpoint([done, done]);
  const options = { apiKey: "sk-test-1234567890", label: "Endpoint", reasoning: true, maxOutputTokens: 4_000, fetch };
  await collect(new OpenAiChatTurns({ ...options, baseUrl: "https://api.openai.com/v1" }).streamTurn(REQUEST, new AbortController().signal));
  await collect(new OpenAiChatTurns({ ...options, baseUrl: "https://openrouter.ai/api/v1" }).streamTurn(REQUEST, new AbortController().signal));

  assert.equal(sent[0].headers.authorization, "Bearer sk-test-1234567890");
  assert.equal(sent[0].body.reasoning_effort, "high");
  assert.equal(sent[0].body.max_completion_tokens, 4_000);
  assert.equal(sent[1].body.max_tokens, 4_000);
  assert.equal("max_completion_tokens" in sent[1].body, false);
});

test("a model that could not form its tool call is reported as that, not as an empty answer", async () => {
  // OpenRouter's shape for Gemini's MALFORMED_FUNCTION_CALL: an ordinary finish
  // reason, no content, and the provider's own reason beside it.
  const { fetch } = endpoint([
    { frames: [json({ choices: [{ delta: {}, finish_reason: "stop", native_finish_reason: "MALFORMED_FUNCTION_CALL" }] }), "[DONE]"] },
    { frames: [json({ choices: [{ delta: {}, finish_reason: "error", native_finish_reason: "MALFORMED_FUNCTION_CALL" }] }), "[DONE]"] },
    { frames: [json({ choices: [{ delta: {}, finish_reason: "error", native_finish_reason: "OTHER" }] }), "[DONE]"] },
    { frames: [json({ choices: [{ delta: { content: "Done." }, finish_reason: "stop", native_finish_reason: "STOP" }] }), "[DONE]"] },
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "sk-test-1234567890", label: "OpenRouter", reasoning: false, fetch });
  const run = () => collect(turns.streamTurn(REQUEST, new AbortController().signal));

  assert.deepEqual(await run(), [{ kind: "completed", stopReason: "malformed-tool-call" }]);
  assert.deepEqual(await run(), [{ kind: "completed", stopReason: "malformed-tool-call" }]);
  await assert.rejects(run, /OpenRouter ended the turn with an error from the model's provider \(OTHER\)/);
  assert.deepEqual(await run(), [{ kind: "delta", text: "Done." }, { kind: "completed", stopReason: "end" }]);
});

test("a refused request says why in the endpoint's words, with the key redacted", async () => {
  const key = "sk-test-1234567890";
  const { fetch } = endpoint([{ status: 401, body: json({ error: { message: `Incorrect API key provided: ${key}` } }) }]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://api.openai.com/v1", apiKey: key, label: "OpenAI", reasoning: false, fetch });
  await assert.rejects(
    () => collect(turns.streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => {
      assert.match(error.message, /^OpenAI returned status 401: Incorrect API key provided: \[key\]\. Check the API key in Settings\.$/);
      assert.equal(error.message.includes(key), false);
      return true;
    },
  );
});

test("a cancelled turn ends quietly, so the planner reports the cancellation it already knows", async () => {
  const controller = new AbortController();
  controller.abort();
  const { fetch, sent } = endpoint([]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://api.openai.com/v1", apiKey: null, label: "OpenAI", reasoning: false, fetch });
  assert.deepEqual(await collect(turns.streamTurn(REQUEST, controller.signal)), []);
  assert.equal(sent.length, 0);
});

/**
 * A turn once asked for 8,192 tokens and let thinking have 7,168 of them, so
 * the model had about a thousand left to write a UI builder in and was cut off
 * every time. Thinking now never takes more than half of the cap.
 */
test("thinking never leaves an Anthropic turn too little room to answer", async () => {
  const done = { frames: [json({ type: "message_delta", delta: { stop_reason: "end_turn" } }), json({ type: "message_stop" })] };
  const { fetch, sent } = endpoint([done, done, done]);
  const turn = (maxOutputTokens: number | undefined, effort: TurnRequest["reasoningEffort"]) =>
    collect(new AnthropicMessagesTurns({
      baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch,
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    }).streamTurn({ ...REQUEST, reasoningEffort: effort }, new AbortController().signal));

  await turn(8_192, "high");
  await turn(undefined, "medium");
  await turn(1_500, "high");
  assert.deepEqual(sent[0].body.thinking, { type: "enabled", budget_tokens: 4_096 });
  assert.deepEqual(sent[1].body.thinking, { type: "enabled", budget_tokens: 10_000 });
  // Below Anthropic's smallest budget, the turn runs without thinking rather than without an answer.
  assert.equal("thinking" in sent[2].body, false);
});

test("an Anthropic turn authenticates with x-api-key, caches the prefix, and replays its thinking", async () => {
  const toolTurn = [
    json({ type: "message_start", message: { usage: { input_tokens: 50, cache_read_input_tokens: 400, output_tokens: 1 } } }),
    json({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }),
    json({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Plan the shop." } }),
    json({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-1" } }),
    json({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "roblox_studio", input: {} } }),
    json({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"operation\":" } }),
    json({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"get_place_info\"}" } }),
    json({ type: "content_block_stop", index: 1 }),
    json({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 30 } }),
    json({ type: "message_stop" }),
  ];
  const answerTurn = [
    json({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    json({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }),
    json({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }),
    json({ type: "message_stop" }),
  ];
  const { fetch, sent } = endpoint([{ frames: toolTurn }, { frames: answerTurn }]);
  const turns = new AnthropicMessagesTurns({
    baseUrl: "https://api.anthropic.com/v1", apiKey: "sk-ant-1234567890", label: "Anthropic", reasoning: true, fetch,
  });

  const first = await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  assert.deepEqual(first, [
    // The thinking block's start, its text, and its signature: progress, with nothing to show.
    { kind: "reasoning" },
    { kind: "reasoning" },
    { kind: "reasoning" },
    { kind: "tool-call", call: { id: "toolu_1", name: "roblox_studio", arguments: { operation: "get_place_info" } } },
    { kind: "completed", stopReason: "tool-use", usage: { inputTokens: 450, outputTokens: 30, cachedInputTokens: 400 } },
  ]);
  assert.equal(sent[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent[0].headers["x-api-key"], "sk-ant-1234567890");
  assert.equal(sent[0].headers["anthropic-version"], "2023-06-01");
  assert.equal(sent[0].headers.authorization, undefined);
  // Room for thinking and a whole builder script: thinking takes at most half,
  // so a 10,000-token tool call still fits after it.
  assert.equal(sent[0].body.max_tokens, 32_000);
  assert.deepEqual(sent[0].body.thinking, { type: "enabled", budget_tokens: 16_000 });
  assert.deepEqual(sent[0].body.system, [{ type: "text", text: "SYSTEM\n\nDEVELOPER", cache_control: { type: "ephemeral" } }]);

  // The next turn answers the tool call; Anthropic requires the thinking that
  // preceded it, signature intact, or it refuses the request.
  const next: TurnRequest = {
    ...REQUEST,
    turnId: "run-1:turn:2",
    messages: [
      ...REQUEST.messages,
      { role: "assistant", content: [{ kind: "tool-call", call: first[3].kind === "tool-call" ? first[3].call : { id: "", name: "", arguments: {} } }] },
      { role: "user", content: [{ kind: "tool-result", callId: "toolu_1", content: "Place1", failed: false }] },
    ],
  };
  assert.deepEqual(await collect(turns.streamTurn(next, new AbortController().signal)), [
    { kind: "delta", text: "Done." },
    { kind: "completed", stopReason: "end" },
  ]);
  const messages = sent[1].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  assert.deepEqual(messages[1].content, [
    { type: "thinking", thinking: "Plan the shop.", signature: "sig-1" },
    { type: "tool_use", id: "toolu_1", name: "roblox_studio", input: { operation: "get_place_info" } },
  ]);
  assert.deepEqual(messages[2].content, [
    { type: "tool_result", tool_use_id: "toolu_1", content: "Place1", is_error: false, cache_control: { type: "ephemeral" } },
  ]);
});

test("an Anthropic turn answers every call before any screenshot, so a capture mid-turn is not refused", async () => {
  // The live failure: capture_screenshot, get_runtime_logs and a playtest stop
  // in one turn went out as [result, image, result, result], and Routera
  // refused it because the calls after the image were "without tool_result".
  const { fetch, sent } = endpoint([{ frames: [
    json({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }),
    json({ type: "message_stop" }),
  ] }]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://routera.example/v1", apiKey: null, label: "Routera", reasoning: false, fetch });
  const call = (id: string, operation: string) => ({ kind: "tool-call" as const, call: { id, name: "roblox_studio", arguments: { operation } } });
  await collect(turns.streamTurn({
    ...REQUEST,
    messages: [
      ...REQUEST.messages,
      { role: "assistant", content: [call("toolu_shot", "capture_screenshot"), call("toolu_logs", "get_runtime_logs"), call("toolu_stop", "solo_playtest")] },
      { role: "user", content: [
        { kind: "tool-result", callId: "toolu_shot", content: "Screenshot 2248x932", failed: false },
        { kind: "image", mediaType: "image/jpeg", data: "QUJD" },
        { kind: "tool-result", callId: "toolu_logs", content: "1 entry", failed: false },
        { kind: "tool-result", callId: "toolu_stop", content: "Playtest stopped.", failed: false },
        { kind: "text", text: "Also make the buttons bigger." },
      ] },
    ],
  }, new AbortController().signal));

  const messages = sent[0].body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
  const answer = messages[2].content;
  assert.deepEqual(answer.map((block) => block.type), ["tool_result", "tool_result", "tool_result", "text", "image", "text"]);
  assert.deepEqual(answer.slice(0, 3).map((block) => block.tool_use_id), ["toolu_shot", "toolu_logs", "toolu_stop"]);
  assert.equal(answer[3].text, "Image returned by tool call toolu_shot:");
  assert.equal(answer[5].text, "Also make the buttons bigger.");
  // The user's own attached image carries no call label.
  const attached = await (async () => {
    const endpointTwo = endpoint([{ frames: [json({ type: "message_delta", delta: { stop_reason: "end_turn" } }), json({ type: "message_stop" })] }]);
    const plain = new AnthropicMessagesTurns({ baseUrl: "https://routera.example/v1", apiKey: null, label: "Routera", reasoning: false, fetch: endpointTwo.fetch });
    await collect(plain.streamTurn({ ...REQUEST, messages: [{ role: "user", content: [
      { kind: "text", text: "Match this" }, { kind: "image", mediaType: "image/png", data: "QUJD" },
    ] }] }, new AbortController().signal));
    return (endpointTwo.sent[0].body.messages as Array<{ content: Array<Record<string, unknown>> }>)[0].content;
  })();
  assert.deepEqual(attached.map((block) => block.type), ["text", "image"]);
});

/** An Anthropic stream for one turn: each block in order, then the stop. */
function anthropicTurn(blocks: ReadonlyArray<Record<string, unknown>>, stop = "tool_use"): string[] {
  const frames: string[] = [];
  blocks.forEach((block, index) => {
    if (block.type === "thinking") {
      frames.push(json({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } }));
      frames.push(json({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: block.thinking } }));
      frames.push(json({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: block.signature } }));
    } else if (block.type === "text") {
      frames.push(json({ type: "content_block_start", index, content_block: { type: "text", text: "" } }));
      frames.push(json({ type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } }));
    } else {
      frames.push(json({ type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: "roblox_studio", input: {} } }));
      frames.push(json({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json(block.input) } }));
    }
    frames.push(json({ type: "content_block_stop", index }));
  });
  frames.push(json({ type: "message_delta", delta: { stop_reason: stop }, usage: { output_tokens: 1 } }));
  frames.push(json({ type: "message_stop" }));
  return frames;
}

/** The loop's own record of an assistant turn: its text, then its calls. */
function assistantMessage(text: string, calls: ReadonlyArray<Readonly<{ id: string; input: Record<string, unknown> }>>): TurnRequest["messages"][number] {
  return {
    role: "assistant",
    content: [
      ...(text.length > 0 ? [{ kind: "text" as const, text }] : []),
      ...calls.map((call) => ({ kind: "tool-call" as const, call: { id: call.id, name: "roblox_studio", arguments: call.input } })),
    ],
  };
}

function results(...ids: string[]): TurnRequest["messages"][number] {
  return { role: "user", content: ids.map((id) => ({ kind: "tool-result" as const, callId: id, content: `result ${id}`, failed: false })) };
}

type SentMessage = { role: string; content: Array<Record<string, unknown>> };
const sentMessages = (sent: Sent) => sent.body.messages as SentMessage[];

test("a current Claude model is asked to think adaptively, at the run's effort, never with a budget", async () => {
  // Claude from 4.7 on refuses a thinking budget outright, so a budget made
  // every turn of a run with reasoning on fail.
  const done = { frames: anthropicTurn([{ type: "text", text: "ok" }], "end_turn") };
  const { fetch, sent } = endpoint([done, done, done]);
  const options = { baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", fetch };
  await collect(new AnthropicMessagesTurns({ ...options, reasoning: true })
    .streamTurn({ ...REQUEST, modelId: "claude-opus-5-5", reasoningEffort: "high" }, new AbortController().signal));
  await collect(new AnthropicMessagesTurns({ ...options, reasoning: true })
    .streamTurn({ ...REQUEST, modelId: "claude-haiku-4-5", reasoningEffort: "high" }, new AbortController().signal));
  await collect(new AnthropicMessagesTurns({ ...options, reasoning: false })
    .streamTurn({ ...REQUEST, modelId: "claude-opus-5-5", reasoningEffort: "none" }, new AbortController().signal));

  assert.deepEqual(sent[0].body.thinking, { type: "adaptive" });
  assert.deepEqual(sent[0].body.output_config, { effort: "high" });
  // An older model knows only the budget.
  assert.deepEqual(sent[1].body.thinking, { type: "enabled", budget_tokens: 16_000 });
  assert.equal("output_config" in sent[1].body, false);
  // With reasoning off nothing about thinking is sent at all.
  assert.equal("thinking" in sent[2].body, false);
  assert.equal("output_config" in sent[2].body, false);
});

test("which Claude models take a thinking budget is read from the model's name", () => {
  const budget = [
    "claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-sonnet-4-20250514", "claude-opus-4-1",
    "claude-3-7-sonnet-20250219", "anthropic/claude-sonnet-4.5", "anthropic.claude-opus-4-1-20250805-v1:0",
    // Not Claude: an endpoint imitating Anthropic's API, built against the budget.
    "deepseek-chat", "some/model",
  ];
  const adaptive = [
    "claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-7", "claude-opus-5-5", "claude-sonnet-5",
    "claude-fable-5-1", "anthropic/claude-opus-4.8", "us.anthropic.claude-opus-5", "claude-latest",
  ];
  for (const model of budget) assert.equal(usesThinkingBudget(model), true, model);
  for (const model of adaptive) assert.equal(usesThinkingBudget(model), false, model);
});

test("an endpoint that refuses how thinking was asked for is asked the other way, and keeps that answer", async () => {
  // A proxy can name a model anything, so the name is only a first guess.
  const { fetch, sent } = endpoint([
    { status: 400, body: json({ type: "error", error: { type: "invalid_request_error", message: "thinking.type.enabled is not supported for this model. Use thinking.type.adaptive and output_config.effort." } }) },
    { frames: anthropicTurn([{ type: "text", text: "ok" }], "end_turn") },
    { frames: anthropicTurn([{ type: "text", text: "ok" }], "end_turn") },
  ]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://proxy.example/v1", apiKey: null, label: "Proxy", reasoning: true, fetch });
  await collect(turns.streamTurn({ ...REQUEST, modelId: "house-model" }, new AbortController().signal));
  await collect(turns.streamTurn({ ...REQUEST, modelId: "house-model" }, new AbortController().signal));

  assert.equal(sent[0].body.thinking !== undefined && (sent[0].body.thinking as { type: string }).type, "enabled");
  assert.deepEqual(sent[1].body.thinking, { type: "adaptive" });
  assert.deepEqual(sent[2].body.thinking, { type: "adaptive" }, "the next turn does not ask the wrong way again");
});

test("a refusal that is not about thinking is reported, not retried with another shape", async () => {
  const { fetch, sent } = endpoint([
    { status: 400, body: json({ type: "error", error: { type: "invalid_request_error", message: "messages: roles must alternate" } }) },
  ]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch });
  await assert.rejects(
    () => collect(turns.streamTurn({ ...REQUEST, modelId: "claude-opus-5-5" }, new AbortController().signal)),
    (error: Error) => !(error instanceof TransientTurnError) && /roles must alternate/.test(error.message),
  );
  assert.equal(sent.length, 1);
});

test("every Anthropic turn goes back exactly as it was produced, thinking in its place among the calls", async () => {
  // Current models interleave thinking between tool calls, and read a turn's
  // thinking only when it comes back unchanged. Sending back only the latest
  // turn's thinking also rewrote the one before it on every request, which
  // spent the prompt cache on everything after it.
  const first = [
    { type: "thinking", thinking: "Check the shop.", signature: "sig-a" },
    { type: "text", text: "Reading the shop." },
    { type: "tool_use", id: "toolu_1", input: { operation: "get_place_info" } },
    { type: "thinking", thinking: "Then the logs.", signature: "sig-b" },
    { type: "tool_use", id: "toolu_2", input: { operation: "get_runtime_logs" } },
  ];
  const second = [
    { type: "thinking", thinking: "Fix it.", signature: "sig-c" },
    { type: "tool_use", id: "toolu_3", input: { operation: "set_properties" } },
  ];
  const { fetch, sent } = endpoint([
    { frames: anthropicTurn(first) },
    { frames: anthropicTurn(second) },
    { frames: anthropicTurn([{ type: "text", text: "Done." }], "end_turn") },
  ]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch });
  const request = { ...REQUEST, modelId: "claude-opus-5-5" };
  const signal = new AbortController().signal;

  const a1 = assistantMessage("Reading the shop.", [{ id: "toolu_1", input: { operation: "get_place_info" } }, { id: "toolu_2", input: { operation: "get_runtime_logs" } }]);
  const a2 = assistantMessage("", [{ id: "toolu_3", input: { operation: "set_properties" } }]);
  await collect(turns.streamTurn(request, signal));
  await collect(turns.streamTurn({ ...request, messages: [...REQUEST.messages, a1, results("toolu_1", "toolu_2")] }, signal));
  await collect(turns.streamTurn({
    ...request, messages: [...REQUEST.messages, a1, results("toolu_1", "toolu_2"), a2, results("toolu_3")],
  }, signal));

  const replayed = sentMessages(sent[2]);
  assert.deepEqual(replayed[1].content, [
    { type: "thinking", thinking: "Check the shop.", signature: "sig-a" },
    { type: "text", text: "Reading the shop." },
    { type: "tool_use", id: "toolu_1", name: "roblox_studio", input: { operation: "get_place_info" } },
    { type: "thinking", thinking: "Then the logs.", signature: "sig-b" },
    { type: "tool_use", id: "toolu_2", name: "roblox_studio", input: { operation: "get_runtime_logs" } },
  ]);
  assert.deepEqual(replayed[3].content, [
    { type: "thinking", thinking: "Fix it.", signature: "sig-c" },
    { type: "tool_use", id: "toolu_3", name: "roblox_studio", input: { operation: "set_properties" } },
  ]);
  // The prefix the second request sent is repeated byte for byte by the third.
  assert.deepEqual(sentMessages(sent[1]).slice(0, 2), replayed.slice(0, 2));
});

test("thinking is not sent back into history that changed after it was produced", async () => {
  // Folding, elided tool output, and dropped screenshots all rewrite earlier
  // messages. A turn's thinking is bound to what preceded it, so after such an
  // edit the turns produced before the edited message keep their thinking, the
  // ones produced after it go back without it, and a turn produced once the
  // edit was in place keeps its own.
  const turn = (thinking: string, id: string, operation: string) => ({
    frames: anthropicTurn([{ type: "thinking", thinking, signature: `sig-${id}` }, { type: "tool_use", id, input: { operation } }]),
  });
  const { fetch, sent } = endpoint([
    turn("One.", "toolu_1", "a"),
    turn("Two.", "toolu_2", "b"),
    turn("Three.", "toolu_3", "c"),
    turn("Four.", "toolu_4", "d"),
    { frames: anthropicTurn([{ type: "text", text: "Done." }], "end_turn") },
  ]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch });
  const request = { ...REQUEST, modelId: "claude-opus-5-5" };
  const signal = new AbortController().signal;
  const a1 = assistantMessage("", [{ id: "toolu_1", input: { operation: "a" } }]);
  const a2 = assistantMessage("", [{ id: "toolu_2", input: { operation: "b" } }]);
  const a3 = assistantMessage("", [{ id: "toolu_3", input: { operation: "c" } }]);
  const a4 = assistantMessage("", [{ id: "toolu_4", input: { operation: "d" } }]);
  const elided: TurnRequest["messages"][number] = {
    role: "user", content: [{ kind: "tool-result", callId: "toolu_2", content: "[Roqer elided this earlier result]", failed: false }],
  };
  const history = (...messages: TurnRequest["messages"]) => ({ ...request, messages: [...REQUEST.messages, ...messages] });

  await collect(turns.streamTurn(request, signal));
  await collect(turns.streamTurn(history(a1, results("toolu_1")), signal));
  await collect(turns.streamTurn(history(a1, results("toolu_1"), a2, results("toolu_2")), signal));
  // The second turn's result is elided before the fourth request.
  await collect(turns.streamTurn(history(a1, results("toolu_1"), a2, elided, a3, results("toolu_3")), signal));
  await collect(turns.streamTurn(history(a1, results("toolu_1"), a2, elided, a3, results("toolu_3"), a4, results("toolu_4")), signal));

  const assistantTypes = (index: number) => sentMessages(sent[index]).filter((message) => message.role === "assistant")
    .map((message) => message.content.map((block) => block.type));
  assert.deepEqual(assistantTypes(3), [
    ["thinking", "tool_use"], // produced before the edited result, which it never saw
    ["thinking", "tool_use"], // likewise: the elided result answers this turn's call
    ["tool_use"], // produced after the elided result, so its prefix changed
  ]);
  assert.deepEqual(assistantTypes(4), [
    ["thinking", "tool_use"],
    ["thinking", "tool_use"],
    ["tool_use"],
    ["thinking", "tool_use"], // produced with the edit already in place
  ]);
});

test("after a fold, the turns kept go back without their thinking and nothing folded is remembered", async () => {
  // A fold replaces the oldest exchanges with a summary and keeps the latest
  // ones verbatim. Their thinking was produced with the full history in front
  // of it, so it cannot go back after the summary.
  const turn = (id: string) => ({
    frames: anthropicTurn([{ type: "thinking", thinking: id, signature: `sig-${id}` }, { type: "tool_use", id, input: { operation: id } }]),
  });
  const { fetch, sent } = endpoint([turn("toolu_1"), turn("toolu_2"), turn("toolu_3"), turn("toolu_4")]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch });
  const request = { ...REQUEST, modelId: "claude-opus-5-5" };
  const signal = new AbortController().signal;
  const a = (id: string) => assistantMessage("", [{ id, input: { operation: id } }]);
  const summary: TurnRequest["messages"][number] = { role: "user", content: [{ kind: "text", text: "[Roqer folded 2 earlier messages]" }] };

  await collect(turns.streamTurn(request, signal));
  await collect(turns.streamTurn({ ...request, messages: [...REQUEST.messages, a("toolu_1"), results("toolu_1")] }, signal));
  await collect(turns.streamTurn({
    ...request, messages: [...REQUEST.messages, a("toolu_1"), results("toolu_1"), a("toolu_2"), results("toolu_2")],
  }, signal));
  // The first exchange is folded into a summary before the fourth request.
  await collect(turns.streamTurn({
    ...request, messages: [...REQUEST.messages, summary, a("toolu_2"), results("toolu_2"), a("toolu_3"), results("toolu_3")],
  }, signal));

  const assistants = sentMessages(sent[3]).filter((message) => message.role === "assistant");
  assert.deepEqual(assistants.map((message) => message.content.map((block) => block.type)), [["tool_use"], ["tool_use"]]);
  assert.deepEqual(assistants.map((message) => message.content[0].id), ["toolu_2", "toolu_3"]);
});

test("thinking the endpoint says belongs to another conversation is dropped and the turn sent again", async () => {
  // Anthropic's documented recovery: send the history again without thinking.
  const { fetch, sent } = endpoint([
    { frames: anthropicTurn([{ type: "thinking", thinking: "One.", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", input: { operation: "a" } }]) },
    { status: 400, body: json({ type: "error", error: { type: "invalid_request_error", message: "messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation." } }) },
    { frames: anthropicTurn([{ type: "text", text: "Done." }], "end_turn") },
  ]);
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: true, fetch });
  const request = { ...REQUEST, modelId: "claude-opus-5-5" };
  const a1 = assistantMessage("", [{ id: "toolu_1", input: { operation: "a" } }]);

  await collect(turns.streamTurn(request, new AbortController().signal));
  const events = await collect(turns.streamTurn({ ...request, messages: [...REQUEST.messages, a1, results("toolu_1")] }, new AbortController().signal));

  assert.deepEqual(events.at(-1), { kind: "completed", stopReason: "end" });
  assert.deepEqual(sentMessages(sent[1])[1].content.map((block) => block.type), ["thinking", "tool_use"]);
  assert.deepEqual(sentMessages(sent[2])[1].content.map((block) => block.type), ["tool_use"]);
});

/** A fetch whose stream is written by `write`, which may pause, stop, or fail it. */
function streamingEndpoint(write: (controller: ReadableStreamDefaultController<Uint8Array>, signal: AbortSignal) => Promise<void>) {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const signal = init!.signal!;
    return new Response(new ReadableStream<Uint8Array>({
      async start(controller) {
        signal.addEventListener("abort", () => controller.error(new DOMException("This operation was aborted", "AbortError")), { once: true });
        try {
          await write(controller, signal);
        } catch {
          // The stream was already failed from outside.
        }
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
}

const encode = (frame: string) => new TextEncoder().encode(`data: ${frame}\n\n`);
const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("a turn still streaming after the request timeout is not cut off", async () => {
  // The timeout once ran from the request to the end of the stream, and ended
  // every turn longer than ten minutes mid-sentence.
  const fetch = streamingEndpoint(async (controller, signal) => {
    for (let index = 0; index < 8 && !signal.aborted; index += 1) {
      await sleep(25);
      controller.enqueue(encode(json({ choices: [{ delta: { content: "x" } }] })));
    }
    controller.enqueue(encode(json({ choices: [{ delta: {}, finish_reason: "stop" }] })));
    controller.enqueue(encode("[DONE]"));
    controller.close();
  });
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, requestTimeoutMs: 100, fetch });
  const events = await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  assert.equal(events.filter((event) => event.kind === "delta").length, 8);
  assert.deepEqual(events.at(-1), { kind: "completed", stopReason: "end" });
});

test("a stream that goes silent past the timeout is ended with a message that says so", async () => {
  const fetch = streamingEndpoint(async (controller) => {
    controller.enqueue(encode(json({ choices: [{ delta: { content: "x" } }] })));
    await sleep(500);
  });
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, requestTimeoutMs: 60, fetch });
  await assert.rejects(
    () => collect(turns.streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => !(error instanceof TransientTurnError) && /Local sent nothing for 0 seconds partway through the turn/.test(error.message),
  );
});

test("an endpoint that never starts answering is reported as not answering in time", async () => {
  const fetch = (async (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(new DOMException("This operation was aborted", "AbortError")), { once: true });
  })) as typeof globalThis.fetch;
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, requestTimeoutMs: 30, fetch });
  await assert.rejects(() => collect(turns.streamTurn(REQUEST, new AbortController().signal)), /Local did not answer within 0 seconds\./);
});

test("a connection dropped partway through a turn is transient, and a cancelled one ends quietly", async () => {
  const dropping = streamingEndpoint(async (controller) => {
    controller.enqueue(encode(json({ choices: [{ delta: { content: "x" } }] })));
    await sleep(5);
    controller.error(new TypeError("terminated"));
  });
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, fetch: dropping });
  await assert.rejects(
    () => collect(turns.streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => error instanceof TransientTurnError && error.message === "Local's connection dropped partway through the turn.",
  );

  const run = new AbortController();
  const held = streamingEndpoint(async (controller) => {
    controller.enqueue(encode(json({ choices: [{ delta: { content: "x" } }] })));
    await sleep(5);
    run.abort();
  });
  const cancelled = new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, fetch: held });
  assert.deepEqual(await collect(cancelled.streamTurn(REQUEST, run.signal)), [{ kind: "delta", text: "x" }]);
});

test("busy, overloaded, and failing endpoints are transient; refusals and spent accounts are not", async () => {
  const { fetch } = endpoint([
    { status: 529, body: json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }) },
    { status: 429, body: json({ error: { message: "Rate limit reached", type: "requests" } }) },
    { status: 503, body: "upstream unavailable" },
    { status: 429, body: json({ error: { message: "You exceeded your current quota.", code: "insufficient_quota" } }) },
    { status: 400, body: json({ error: { message: "bad request" } }) },
    { status: 401, body: json({ error: { message: "bad key" } }) },
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://api.example.com/v1", apiKey: null, label: "Endpoint", reasoning: false, fetch });
  const outcome = async () => {
    try {
      await collect(turns.streamTurn(REQUEST, new AbortController().signal));
      return "completed";
    } catch (error) {
      return error instanceof TransientTurnError ? "transient" : "permanent";
    }
  };
  const outcomes = [];
  for (let index = 0; index < 6; index += 1) outcomes.push(await outcome());
  assert.deepEqual(outcomes, ["transient", "transient", "transient", "permanent", "permanent", "permanent"]);
});

test("the wait an endpoint asks for is read from retry-after-ms, seconds, or a date", () => {
  const now = Date.parse("2026-09-26T12:00:00Z");
  assert.equal(retryAfterMs(new Headers({ "retry-after-ms": "1500", "retry-after": "9" }), now), 1_500);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "2" }), now), 2_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "Sat, 26 Sep 2026 12:00:30 GMT" }), now), 30_000);
  assert.equal(retryAfterMs(new Headers({ "retry-after": "soon" }), now), undefined);
  assert.equal(retryAfterMs(new Headers(), now), undefined);
});

test("a rate-limited endpoint's requested wait reaches the loop", async () => {
  const fetch = (async () => new Response(json({ error: { message: "slow down" } }), {
    status: 429, headers: { "retry-after": "3" },
  })) as typeof globalThis.fetch;
  const turns = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: false, fetch });
  await assert.rejects(
    () => collect(turns.streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => error instanceof TransientTurnError && error.retryAfterMs === 3_000,
  );
});

test("errors inside a stream are transient when the endpoint was busy, and a cut stream is too", async () => {
  const anthropic = (frames: readonly string[]) => new AnthropicMessagesTurns({
    baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: false, fetch: endpoint([{ frames }]).fetch,
  });
  const openai = (frames: readonly string[]) => new OpenAiChatTurns({
    baseUrl: "https://openrouter.ai/api/v1", apiKey: null, label: "OpenRouter", reasoning: false, fetch: endpoint([{ frames }]).fetch,
  });
  const kind = async (turns: { streamTurn: AnthropicMessagesTurns["streamTurn"] }) => {
    try {
      await collect(turns.streamTurn(REQUEST, new AbortController().signal));
      return "completed";
    } catch (error) {
      return error instanceof TransientTurnError ? "transient" : "permanent";
    }
  };

  assert.equal(await kind(anthropic([json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } })])), "transient");
  assert.equal(await kind(anthropic([json({ type: "error", error: { type: "invalid_request_error", message: "no" } })])), "permanent");
  assert.equal(await kind(anthropic([json({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })])), "transient");
  assert.equal(await kind(openai([json({ error: { code: 502, message: "Provider returned error" } })])), "transient");
  assert.equal(await kind(openai([json({ choices: [{ delta: { content: "half" } }] })])), "transient");
});

test("a connection refused outright is reported at once, and a reset one is transient", async () => {
  const failing = (code: string) => (async () => {
    throw new TypeError("fetch failed", { cause: Object.assign(new Error(code), { code }) });
  }) as typeof globalThis.fetch;
  const turns = (code: string) => new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, fetch: failing(code) });
  await assert.rejects(
    () => collect(turns("ECONNREFUSED").streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => !(error instanceof TransientTurnError) && /Local could not be reached at http:\/\/localhost:1234/.test(error.message),
  );
  await assert.rejects(
    () => collect(turns("ECONNRESET").streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => error instanceof TransientTurnError,
  );
  // Tried over IPv4 and IPv6, a refused connection arrives as one error per address.
  const bothFamilies = (async () => {
    throw new TypeError("fetch failed", {
      cause: new AggregateError([Object.assign(new Error("::1"), { code: "ECONNREFUSED" }), Object.assign(new Error("127.0.0.1"), { code: "ECONNREFUSED" })]),
    });
  }) as typeof globalThis.fetch;
  await assert.rejects(
    () => collect(new OpenAiChatTurns({ baseUrl: "http://localhost:1234/v1", apiKey: null, label: "Local", reasoning: false, fetch: bothFamilies })
      .streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => !(error instanceof TransientTurnError),
  );
});

test("reasoning an OpenAI-compatible server streams is reported as progress and never as text", async () => {
  const { fetch } = endpoint([{
    frames: [
      json({ choices: [{ delta: { reasoning_content: "Think about the shop" } }] }),
      json({ choices: [{ delta: { reasoning: "and its prices" } }] }),
      json({ choices: [{ delta: { reasoning_details: [{ type: "reasoning.encrypted", data: "x" }] } }] }),
      json({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }),
      "[DONE]",
    ],
  }]);
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:11434/v1", apiKey: null, label: "Ollama", reasoning: true, fetch });
  assert.deepEqual(await collect(turns.streamTurn(REQUEST, new AbortController().signal)), [
    { kind: "reasoning" },
    { kind: "reasoning" },
    { kind: "reasoning" },
    { kind: "delta", text: "Done." },
    { kind: "completed", stopReason: "end" },
  ]);
});

type SentChatMessage = { role: string; content: unknown; tool_calls?: Array<Record<string, unknown>>; reasoning_content?: string; reasoning_details?: unknown };
const chatMessages = (sent: Sent) => sent.body.messages as SentChatMessage[];

/** One OpenAI-compatible turn that reasons in `reasoning`, then asks for one tool call. */
function reasonedToolTurn(reasoning: readonly Record<string, unknown>[], call: Record<string, unknown>): { frames: string[] } {
  return {
    frames: [
      ...reasoning.map((delta) => json({ choices: [{ delta }] })),
      json({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", ...call, function: { name: "roblox_studio", arguments: "{\"operation\":\"get_place_info\"}" } }] } }] }),
      json({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ],
  };
}

const PLACE_INFO_TURN: TurnRequest["messages"] = [
  ...REQUEST.messages,
  { role: "assistant", content: [{ kind: "tool-call", call: { id: "call_1", name: "roblox_studio", arguments: { operation: "get_place_info" } } }] },
  { role: "user", content: [{ kind: "tool-result", callId: "call_1", content: "Place1", failed: false }] },
];

const FINISHED = { frames: [json({ choices: [{ delta: { content: "Done." }, finish_reason: "stop" }] }), "[DONE]"] };

test("DeepSeek's reasoning goes back with the turn that produced it, which a request with tools requires", async () => {
  // From V3.2, DeepSeek refuses a tool-carrying request whose earlier turns come
  // back without their reasoning_content: "Missing reasoning_content".
  const { fetch, sent } = endpoint([
    reasonedToolTurn([{ reasoning_content: "The user wants " }, { reasoning_content: "the place name." }], {}),
    FINISHED,
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://api.deepseek.com/v1", apiKey: null, label: "DeepSeek", reasoning: false, fetch });
  await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  await collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal));

  const assistant = chatMessages(sent[1]).find((message) => message.role === "assistant")!;
  assert.equal(assistant.reasoning_content, "The user wants the place name.");
  assert.equal(assistant.tool_calls?.[0].id, "call_1");
  assert.equal("reasoning_content" in chatMessages(sent[0])[0], false, "nothing is invented for a turn that did not reason");
});

test("OpenRouter's streamed reasoning fragments go back joined into whole blocks", async () => {
  // A signed block is valid only whole; sent back a few words at a time, its
  // signature no longer matches and the provider refuses the turn.
  const { fetch, sent } = endpoint([
    reasonedToolTurn([
      { reasoning: "Plan", reasoning_details: [{ type: "reasoning.text", text: "Plan", format: "anthropic-claude-v1", index: 0 }] },
      { reasoning: " the shop", reasoning_details: [{ type: "reasoning.text", text: " the shop", index: 0 }] },
      { reasoning_details: [{ type: "reasoning.text", signature: "sig-", index: 0 }] },
      { reasoning_details: [{ type: "reasoning.text", signature: "123", index: 0 }] },
      { reasoning_details: [{ type: "reasoning.encrypted", data: "opaque", id: "call_1", index: 1 }] },
    ], {}),
    FINISHED,
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://openrouter.ai/api/v1", apiKey: null, label: "OpenRouter", reasoning: true, fetch });
  await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  await collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal));

  const assistant = chatMessages(sent[1]).find((message) => message.role === "assistant")!;
  assert.deepEqual(assistant.reasoning_details, [
    { type: "reasoning.text", text: "Plan the shop", format: "anthropic-claude-v1", index: 0, signature: "sig-123" },
    { type: "reasoning.encrypted", data: "opaque", id: "call_1", index: 1 },
  ]);
  assert.equal("reasoning_content" in assistant, false);
});

test("a Gemini thought signature goes back on the tool call it came with", async () => {
  // Google's OpenAI-compatible endpoint refuses the next turn of a Gemini 3
  // tool loop when a call comes back without its signature.
  const signature = { google: { thought_signature: "sig-gemini" } };
  const { fetch, sent } = endpoint([reasonedToolTurn([], { extra_content: signature }), FINISHED]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", apiKey: null, label: "Gemini", reasoning: false, fetch });
  await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  await collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal));

  const assistant = chatMessages(sent[1]).find((message) => message.role === "assistant")!;
  assert.deepEqual(assistant.tool_calls?.[0].extra_content, signature);
});

test("a server that does not know a reasoning field gets the turn again without it, for the rest of the run", async () => {
  const { fetch, sent } = endpoint([
    reasonedToolTurn([{ reasoning_content: "Thinking." }], {}),
    { status: 400, body: json({ detail: [{ loc: ["body", "messages", 2, "reasoning_content"], msg: "Extra inputs are not permitted" }] }) },
    FINISHED,
    FINISHED,
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "http://localhost:8000/v1", apiKey: null, label: "vLLM", reasoning: false, fetch });
  await collect(turns.streamTurn(REQUEST, new AbortController().signal));
  assert.deepEqual((await collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal))).at(-1),
    { kind: "completed", stopReason: "end" });
  await collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal));

  const assistant = (index: number) => chatMessages(sent[index]).find((message) => message.role === "assistant")!;
  assert.equal(assistant(1).reasoning_content, "Thinking.");
  assert.equal("reasoning_content" in assistant(2), false);
  assert.equal("reasoning_content" in assistant(3), false, "not offered again, so no second refusal");
  assert.equal(sent.length, 4);
});

test("an endpoint asking for reasoning it did not get is reported, not answered by sending less", async () => {
  const { fetch, sent } = endpoint([
    { status: 400, body: json({ error: { message: "Missing `reasoning_content` field in the assistant message at message index 2." } }) },
  ]);
  const turns = new OpenAiChatTurns({ baseUrl: "https://api.deepseek.com/v1", apiKey: null, label: "DeepSeek", reasoning: false, fetch });
  await assert.rejects(
    () => collect(turns.streamTurn({ ...REQUEST, messages: PLACE_INFO_TURN }, new AbortController().signal)),
    /DeepSeek returned status 400: Missing `reasoning_content`/,
  );
  assert.equal(sent.length, 1);
});

test("a refusal because the conversation outgrew the model is told apart from every other refusal", async () => {
  const bodies: ReadonlyArray<readonly [string, number, string]> = [
    ["OpenAI", 400, json({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 128000 tokens. However, your messages resulted in 130211 tokens." } })],
    ["Anthropic", 400, json({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 205101 tokens > 200000 maximum" } })],
    ["llama.cpp", 400, json({ error: { type: "exceed_context_size_error", message: "the request exceeds the available context size, try increasing it" } })],
    ["Gemini", 400, json([{ error: { message: "The input token count (1100000) exceeds the maximum number of tokens allowed (1048576)." } }])],
  ];
  for (const [label, status, body] of bodies) {
    const fetch = (async () => new Response(body, { status })) as typeof globalThis.fetch;
    const turns = new OpenAiChatTurns({ baseUrl: "https://api.example.com/v1", apiKey: null, label, reasoning: false, fetch });
    await assert.rejects(
      () => collect(turns.streamTurn(REQUEST, new AbortController().signal)),
      (error: Error) => error instanceof ContextOverflowError,
      label,
    );
  }
  // Asking for more output than the model writes is not a conversation that is too long.
  const outputLimit = (async () => new Response(json({
    type: "error", error: { type: "invalid_request_error", message: "max_tokens: 200000 > 128000, which is the maximum allowed number of output tokens for claude-opus-5-5" },
  }), { status: 400 })) as typeof globalThis.fetch;
  const anthropic = new AnthropicMessagesTurns({ baseUrl: "https://api.anthropic.com/v1", apiKey: null, label: "Anthropic", reasoning: false, fetch: outputLimit });
  await assert.rejects(
    () => collect(anthropic.streamTurn(REQUEST, new AbortController().signal)),
    (error: Error) => !(error instanceof ContextOverflowError) && !(error instanceof TransientTurnError),
  );
});
