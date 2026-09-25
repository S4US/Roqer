import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_TURN_IMAGE_BASE64,
  MAX_TURN_IMAGES,
  MAX_TURN_MESSAGES,
  MAX_TURN_TEXT,
  TURN_EVENT_KINDS,
  estimateTurnInputTokens,
  estimateTurnOutputTokens,
  isUnknownTurnEventKind,
  isTurnEvent,
  isTurnRequest,
  isTurnUsage,
  type TurnMessage,
  type TurnRequest,
} from "./turn-contract";

const REQUEST: TurnRequest = {
  runId: "run_123",
  turnId: "turn_1",
  modelId: "starter-model",
  reasoningEffort: "low",
  instructions: { system: "You build Roblox experiences.", developer: "Prefer structured operations." },
  tools: [{
    name: "studio",
    description: "Call one Roblox Studio operation.",
    parameters: { type: "object", properties: { operation: { type: "string" } } },
  }],
  messages: [
    { role: "user", content: [{ kind: "text", text: "Add a sprint to the player." }] },
    {
      role: "assistant",
      content: [
        { kind: "text", text: "Reading the character script." },
        { kind: "tool-call", call: { id: "call_1", name: "studio", arguments: { operation: "get_script_source" } } },
      ],
    },
    {
      role: "user",
      content: [{ kind: "tool-result", callId: "call_1", content: "1: local x = 1", failed: false }],
    },
  ],
};

function withMessages(messages: readonly unknown[]): unknown {
  return { ...REQUEST, messages };
}

test("a complete turn request with history, tool calls, and results validates", () => {
  assert.equal(isTurnRequest(REQUEST), true);
  assert.equal(isTurnRequest({ ...REQUEST, instructions: { system: "Only a system prompt." } }), true);
  assert.equal(isTurnRequest({ ...REQUEST, tools: [] }), true);
  assert.equal(isTurnRequest({ ...REQUEST, maxOutputTokens: 4_096 }), true);
});

test("instructions, tool descriptions, and content may span lines", () => {
  // Every real agent definition, tool description, and script excerpt is
  // multi-line; treating a newline as a forbidden control character would
  // refuse every genuine turn while accepting only toy ones.
  assert.equal(isTurnRequest({
    ...REQUEST,
    instructions: {
      system: "You build Roblox experiences.\n\nAlways read before writing.",
      developer: "Prefer structured operations.\n\n<run-settings>\nPlaytesting is enabled.\n</run-settings>",
    },
    tools: [{
      name: "studio",
      description: "Call one Studio operation.\nImportant operations:\n- get_script_source(path)\n- set_script_source(path, source)",
      parameters: { type: "object" },
    }],
    messages: [{
      role: "user",
      content: [{ kind: "text", text: "Fix this:\n\n1: local x = 1\n2: print(x)" }],
    }],
  }), true);

  // A genuine control character is still refused.
  assert.equal(isTurnRequest({
    ...REQUEST,
    instructions: { system: "You build\u0000Roblox experiences." },
  }), false);
  assert.equal(isTurnRequest({ ...REQUEST, instructions: { system: "" } }), false);
  assert.equal(isTurnRequest({
    ...REQUEST,
    tools: [{ name: "studio", description: "", parameters: {} }],
  }), false);
});

test("a client cannot forge the other side of a tool exchange", () => {
  // A tool result is something the caller observed, so it may not arrive as
  // assistant content; a tool call is something the model did.
  assert.equal(isTurnRequest(withMessages([{
    role: "assistant",
    content: [{ kind: "tool-result", callId: "call_1", content: "done", failed: false }],
  }])), false);
  assert.equal(isTurnRequest(withMessages([{
    role: "user",
    content: [{ kind: "tool-call", call: { id: "call_1", name: "studio", arguments: {} } }],
  }])), false);
});

test("turn requests are bounded in every dimension a caller controls", () => {
  const message: TurnMessage = { role: "user", content: [{ kind: "text", text: "hi" }] };
  assert.equal(isTurnRequest(withMessages([])), false);
  assert.equal(isTurnRequest(withMessages(
    Array.from({ length: MAX_TURN_MESSAGES + 1 }, () => message),
  )), false);
  assert.equal(isTurnRequest(withMessages([{
    role: "user",
    content: [{ kind: "text", text: "x".repeat(MAX_TURN_TEXT + 1) }],
  }])), false);
  assert.equal(isTurnRequest({
    ...REQUEST,
    instructions: { system: "x".repeat(200_001) },
  }), false);
  assert.equal(isTurnRequest({
    ...REQUEST,
    tools: [{ name: "studio", description: "a", parameters: { blob: "x".repeat(65_536) } }],
  }), false);
  assert.equal(isTurnRequest({ ...REQUEST, maxOutputTokens: 0 }), false);
  assert.equal(isTurnRequest({ ...REQUEST, maxOutputTokens: 1.5 }), false);
});

test("malformed models, efforts, tools, and unknown fields are refused", () => {
  assert.equal(isTurnRequest({ ...REQUEST, runId: "not a run id" }), false);
  assert.equal(isTurnRequest({ ...REQUEST, turnId: "" }), false);
  assert.equal(isTurnRequest({ ...REQUEST, reasoningEffort: "extreme" }), false);
  assert.equal(isTurnRequest({ ...REQUEST, modelId: "not a model id" }), false);
  assert.equal(isTurnRequest({ ...REQUEST, temperature: 0.7 }), false);
  assert.equal(isTurnRequest({ ...REQUEST, instructions: { system: "ok", extra: "no" } }), false);
  assert.equal(isTurnRequest({ ...REQUEST, tools: [{ name: "Studio", description: "a", parameters: {} }] }), false);
  // Two tools of the same name would make a call ambiguous.
  assert.equal(isTurnRequest({
    ...REQUEST,
    tools: [
      { name: "studio", description: "a", parameters: {} },
      { name: "studio", description: "b", parameters: {} },
    ],
  }), false);
  assert.equal(isTurnRequest(withMessages([{ role: "system", content: [{ kind: "text", text: "hi" }] }])), false);
  assert.equal(isTurnRequest(withMessages([{ role: "user", content: [{ kind: "thinking", text: "hi" }] }])), false);
});

test("stream events accept only the gateway's own shapes", () => {
  assert.equal(isTurnEvent({ kind: "delta", text: "Adding sprint." }), true);
  assert.equal(isTurnEvent({ kind: "delta", text: "" }), true);
  assert.equal(isTurnEvent({
    kind: "tool-call",
    call: { id: "call_1", name: "studio", arguments: { operation: "set_script_source" } },
  }), true);
  assert.equal(isTurnEvent({
    kind: "completed",
    stopReason: "tool-use",
    usage: { inputTokens: 1_200, outputTokens: 80 },
  }), true);
  assert.equal(isTurnEvent({ kind: "failed", code: "cancelled", message: "The turn was cancelled." }), true);

  // A provider that reported no usage says so rather than reporting zero.
  assert.equal(isTurnEvent({ kind: "completed", stopReason: "tool-use" }), true);
  assert.equal(isTurnEvent({ kind: "completed", stopReason: "done", usage: { inputTokens: 1, outputTokens: 1 } }), false);
  assert.equal(isTurnEvent({ kind: "completed", stopReason: "end", usage: { inputTokens: -1, outputTokens: 0 } }), false);
  assert.equal(isTurnEvent({ kind: "failed", code: "boom", message: "x" }), false);
  assert.equal(isTurnEvent({ kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } }), false);
  assert.equal(isTurnEvent({ kind: "tool-call", call: { id: "call_1", name: "studio" } }), false);
  assert.equal(isTurnUsage({ inputTokens: -1, outputTokens: 0 }), false);
  assert.equal(isTurnUsage({ inputTokens: 0, outputTokens: 0, costUsd: 1 }), false);
});

test("an event kind this build has never heard of is told apart from a broken one", () => {
  // The point of the distinction: a client may skip the first and must refuse
  // the second, and both fail `isTurnEvent` identically.
  assert.equal(isUnknownTurnEventKind({ kind: "retrying", waitMs: 3_000 }), true);
  assert.equal(isUnknownTurnEventKind({ kind: "usage", usage: { inputTokens: 1, outputTokens: 1 } }), true);

  for (const kind of TURN_EVENT_KINDS) {
    assert.equal(isUnknownTurnEventKind({ kind }), false, `${kind} is ours`);
  }
  // A kind we own that arrived malformed is a broken service, not a newer one.
  assert.equal(isUnknownTurnEventKind({ kind: "delta", text: 12 }), false);
  assert.equal(isUnknownTurnEventKind({ kind: "failed", code: "boom", message: "x" }), false);

  // Nothing without a named kind is forward compatibility; it is just garbage.
  assert.equal(isUnknownTurnEventKind({ text: "hello" }), false);
  assert.equal(isUnknownTurnEventKind({ kind: 7 }), false);
  assert.equal(isUnknownTurnEventKind(null), false);
  assert.equal(isUnknownTurnEventKind(["delta"]), false);
});

test("a reported cache hit is a subset of the prompt it came from", () => {
  assert.equal(isTurnUsage({ inputTokens: 15_421, outputTokens: 180 }), true);
  assert.equal(isTurnUsage({ inputTokens: 15_421, outputTokens: 180, cachedInputTokens: 15_240 }), true);
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: 100 }), true);
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: 0 }), true);

  // A hit larger than the prompt is not a usable figure, and trusting it would
  // credit the account tokens it never sent.
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: 101 }), false);
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: -1 }), false);
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: 1.5 }), false);
  assert.equal(isTurnUsage({ inputTokens: 100, outputTokens: 1, cachedInputTokens: "12" }), false);

  assert.equal(isTurnEvent({
    kind: "completed",
    stopReason: "end",
    usage: { inputTokens: 15_421, outputTokens: 180, cachedInputTokens: 15_240 },
  }), true);
  assert.equal(isTurnEvent({
    kind: "completed",
    stopReason: "end",
    usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 11 },
  }), false);
});

test("delivered output is sized in the same characters-per-token the input is", () => {
  assert.equal(estimateTurnOutputTokens(16_000), 4_000);
  // Rounded up for the same reason the ledger rounds money up: a stream of tiny
  // cancelled turns must not each be free.
  assert.equal(estimateTurnOutputTokens(1), 1);
  // Nothing delivered is genuinely nothing, and a nonsense figure is not
  // negative output.
  assert.equal(estimateTurnOutputTokens(0), 0);
  assert.equal(estimateTurnOutputTokens(-100), 0);
  assert.equal(estimateTurnOutputTokens(Number.NaN), 0);
});

test("input size is estimated from everything the turn actually sends", () => {
  const estimate = estimateTurnInputTokens(REQUEST);
  assert.ok(estimate > 0);
  // Instructions, tool schemas, prior prose, tool calls, and tool results all
  // re-cross the wire every turn, so all of them have to be counted.
  const larger = estimateTurnInputTokens({
    ...REQUEST,
    messages: [...REQUEST.messages, {
      role: "user",
      content: [{ kind: "text", text: "y".repeat(4_000) }],
    }],
  });
  assert.equal(larger, estimate + 1_000);
  assert.ok(estimateTurnInputTokens({ ...REQUEST, tools: [] }) < estimate);
});

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("a user turn may carry an image, and an assistant turn may not", () => {
  assert.equal(isTurnRequest(withMessages([{
    role: "user",
    content: [{ kind: "text", text: "Why does this button look wrong?" }, { kind: "image", mediaType: "image/png", data: PIXEL }],
  }])), true);

  // An image in an assistant turn could only have been put there by the
  // caller, so it is refused for the same reason a forged tool result is.
  assert.equal(isTurnRequest(withMessages([
    { role: "user", content: [{ kind: "text", text: "Look at this." }] },
    { role: "assistant", content: [{ kind: "image", mediaType: "image/png", data: PIXEL }] },
  ])), false);
});

test("an image must be a known format and standard base64", () => {
  const image = (overrides: Record<string, unknown>): unknown => withMessages([{
    role: "user",
    content: [{ kind: "image", mediaType: "image/png", data: PIXEL, ...overrides }],
  }]);
  assert.equal(isTurnRequest(image({})), true);
  assert.equal(isTurnRequest(image({ mediaType: "image/svg+xml" })), false);
  assert.equal(isTurnRequest(image({ mediaType: "image/PNG" })), false);
  assert.equal(isTurnRequest(image({ data: "" })), false);
  // A data URL is the renderer's format, not the wire's.
  assert.equal(isTurnRequest(image({ data: `data:image/png;base64,${PIXEL}` })), false);
  assert.equal(isTurnRequest(image({ data: "abc" })), false);
  assert.equal(isTurnRequest(image({ data: "A".repeat(MAX_TURN_IMAGE_BASE64 + 4) })), false);
  assert.equal(isTurnRequest(image({ extra: 1 })), false);
});

test("images are bounded across the request, not merely per message", () => {
  const one = { role: "user" as const, content: [{ kind: "image" as const, mediaType: "image/png" as const, data: PIXEL }] };
  assert.equal(isTurnRequest(withMessages(Array.from({ length: MAX_TURN_IMAGES }, () => one))), true);
  assert.equal(isTurnRequest(withMessages(Array.from({ length: MAX_TURN_IMAGES + 1 }, () => one))), false);
});

test("an attached image is charged against the input estimate", () => {
  const withImage = estimateTurnInputTokens({
    ...REQUEST,
    messages: [...REQUEST.messages, {
      role: "user",
      content: [{ kind: "image", mediaType: "image/png", data: "A".repeat(400_000) }],
    }],
  });
  // A picture is not free, and it is not priced as though its base64 were prose.
  const textOnly = estimateTurnInputTokens(REQUEST);
  assert.ok(withImage > textOnly);
  assert.ok(withImage - textOnly < 400_000 / 4);
});
