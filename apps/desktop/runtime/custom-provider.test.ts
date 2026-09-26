import assert from "node:assert/strict";
import test from "node:test";

import type { CustomConnection, CustomConnectionView } from "../shared/custom-providers";
import { customModelCatalog, customProviderStatus, listEndpointModels, testCustomModel } from "./custom-provider";

const CONNECTION: CustomConnectionView = {
  id: "conn-abcd1234",
  name: "OpenRouter",
  format: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  hasKey: true,
  models: [
    { id: "deepseek/deepseek-chat", displayName: "DeepSeek", images: false, efforts: [] },
    { id: "openai/o4-mini", displayName: "o4 mini", images: true, efforts: ["low", "medium", "high"] },
  ],
};

test("the catalog names each model by its connection, with efforts only where the model takes one", () => {
  const catalog = customModelCatalog([CONNECTION]);
  assert.equal(catalog.defaultModelId, "conn-abcd1234:deepseek/deepseek-chat");
  assert.deepEqual(catalog.models.map((model) => [model.id, model.runsOn, model.defaultReasoningEffort]), [
    ["conn-abcd1234:deepseek/deepseek-chat", "OpenRouter", "none"],
    ["conn-abcd1234:openai/o4-mini", "OpenRouter", "medium"],
  ]);
  assert.deepEqual(catalog.models[1].supportedReasoningEfforts.map((entry) => entry.reasoningEffort), ["low", "medium", "high"]);

  // The levels are the model's own, beyond the three every model once got.
  const [claude, offOrHigh, xhighOnly] = customModelCatalog([{
    ...CONNECTION,
    models: [
      { id: "claude", displayName: "Claude", images: true, efforts: ["low", "medium", "high", "xhigh", "max"] },
      { id: "gpt", displayName: "GPT", images: true, efforts: ["none", "high"] },
      { id: "deep", displayName: "Deep", images: true, efforts: ["xhigh"] },
    ],
  }]).models;
  assert.deepEqual(claude.supportedReasoningEfforts.map((entry) => entry.reasoningEffort), ["low", "medium", "high", "xhigh", "max"]);
  assert.equal(claude.defaultReasoningEffort, "medium");
  assert.equal(offOrHigh.defaultReasoningEffort, "high", "the offered level nearest medium");
  assert.equal(xhighOnly.defaultReasoningEffort, "xhigh");

  const empty = customModelCatalog([]);
  assert.equal(empty.models.length, 0);
  assert.match(empty.message ?? "", /Add a connection/);
});

test("the provider reads as connected once there is a model to run", () => {
  assert.equal(customProviderStatus([]).kind, "signed-out");
  assert.match(customProviderStatus([{ ...CONNECTION, models: [] }]).message, /Add a model/);
  const ready = customProviderStatus([CONNECTION]);
  assert.equal(ready.kind, "signed-in");
  assert.equal(ready.message, "1 connection, 2 models");
});

function streaming(frames: readonly string[]): typeof globalThis.fetch {
  return (async () => new Response(frames.map((frame) => `data: ${frame}\n\n`).join(""), { status: 200 })) as typeof globalThis.fetch;
}

test("a connection test passes only when the model calls a tool", async () => {
  const connection: CustomConnection = CONNECTION;
  const passes = await testCustomModel({
    connection,
    model: CONNECTION.models[0],
    apiKey: "sk-or-1234567890",
    fetch: streaming([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "report_ready", arguments: "{\"ok\":true}" } }] }, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ]),
  });
  assert.deepEqual(passes, { ok: true, message: "DeepSeek answered and called a tool. It is ready to use." });

  const textOnly = await testCustomModel({
    connection,
    model: CONNECTION.models[0],
    apiKey: null,
    fetch: streaming([JSON.stringify({ choices: [{ delta: { content: "Sure!" }, finish_reason: "stop" }] }), "[DONE]"]),
  });
  assert.equal(textOnly.ok, false);
  assert.match(textOnly.message, /did not call the tool/);

  const unreachable = await testCustomModel({
    connection,
    model: CONNECTION.models[0],
    apiKey: null,
    fetch: (async () => { throw new TypeError("fetch failed"); }) as typeof globalThis.fetch,
  });
  assert.equal(unreachable.ok, false);
  assert.match(unreachable.message, /could not be reached at https:\/\/openrouter\.ai/);
});

test("a connection test sends the lowest effort the model takes, and none to a model without one", async () => {
  const sent: Array<Record<string, unknown>> = [];
  const recording = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return streaming([
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "report_ready", arguments: "{\"ok\":true}" } }] }, finish_reason: "tool_calls" }] }),
      "[DONE]",
    ])("");
  }) as typeof globalThis.fetch;
  for (const efforts of [["xhigh", "max"], []] as const) {
    const result = await testCustomModel({
      connection: CONNECTION,
      model: { id: "m", displayName: "M", images: false, efforts },
      apiKey: null,
      fetch: recording,
    });
    assert.equal(result.ok, true);
  }
  assert.equal(sent[0].reasoning_effort, "xhigh");
  assert.equal("reasoning_effort" in sent[1], false);
});

test("the endpoint's model list is read in either format, sorted and deduplicated", async () => {
  let headers: Record<string, string> = {};
  const listing = (body: unknown, status = 200) => (async (_url: unknown, init?: RequestInit) => {
    headers = (init?.headers ?? {}) as Record<string, string>;
    return new Response(JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;

  assert.deepEqual(
    await listEndpointModels(CONNECTION, "sk-or-1234567890", listing({ data: [{ id: "b/model" }, { id: "a/model" }, { id: "a/model" }, { id: "has space" }] })),
    { ok: true, modelIds: ["a/model", "b/model"] },
  );
  assert.equal(headers.authorization, "Bearer sk-or-1234567890");

  const anthropic: CustomConnection = { ...CONNECTION, format: "anthropic", baseUrl: "https://api.anthropic.com/v1" };
  assert.deepEqual(
    await listEndpointModels(anthropic, "sk-ant-1234567890", listing({ data: [{ id: "claude-sonnet-5", display_name: "Claude Sonnet 5" }] })),
    { ok: true, modelIds: ["claude-sonnet-5"] },
  );
  assert.equal(headers["x-api-key"], "sk-ant-1234567890");

  const missing = await listEndpointModels(CONNECTION, null, listing({}, 404));
  assert.match(missing.ok ? "" : missing.message, /does not list its models/);
});
