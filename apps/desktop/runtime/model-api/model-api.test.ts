import assert from "node:assert/strict";
import test from "node:test";

import type { TurnEvent, TurnRequest } from "./turn-contract";

import { AnthropicMessagesTurns } from "./anthropic-messages";
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
      { role: "assistant", content: [{ kind: "tool-call", call: first[0].kind === "tool-call" ? first[0].call : { id: "", name: "", arguments: {} } }] },
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
