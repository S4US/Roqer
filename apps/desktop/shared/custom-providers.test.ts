import assert from "node:assert/strict";
import test from "node:test";

import {
  customModelKey,
  defaultCustomReasoningEffort,
  isCustomConnectionView,
  isCustomReasoningEffortList,
  normalizeCustomBaseUrl,
  parseCustomConnectionSave,
  parseCustomModelKey,
} from "./custom-providers";

test("a base URL is HTTPS, or plain HTTP only on this computer or the local network", () => {
  assert.deepEqual(normalizeCustomBaseUrl("https://openrouter.ai/api/v1/"), { ok: true, baseUrl: "https://openrouter.ai/api/v1" });
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:1234/v1", "http://192.168.1.20:8000/v1", "http://[::1]:8080/v1"]) {
    assert.equal(normalizeCustomBaseUrl(local).ok, true, local);
  }
  // Anywhere else, plain HTTP would carry the prompt and the key in the clear.
  const insecure = normalizeCustomBaseUrl("http://api.example.com/v1");
  assert.equal(insecure.ok, false);
  assert.match(insecure.ok ? "" : insecure.message, /Use HTTPS/);
  // A key in the URL would be stored unencrypted and shown back to the renderer.
  assert.equal(normalizeCustomBaseUrl("https://user:secret@api.example.com/v1").ok, false);
  assert.equal(normalizeCustomBaseUrl("https://api.example.com/v1?key=secret").ok, false);
  assert.equal(normalizeCustomBaseUrl("ftp://api.example.com").ok, false);
});

test("a model key splits at the connection, so model ids with colons survive", () => {
  const key = customModelKey("conn-abcd1234", "qwen2.5-coder:32b");
  assert.deepEqual(parseCustomModelKey(key), { connectionId: "conn-abcd1234", modelId: "qwen2.5-coder:32b" });
  assert.deepEqual(parseCustomModelKey("conn-abcd1234:deepseek/deepseek-chat"),
    { connectionId: "conn-abcd1234", modelId: "deepseek/deepseek-chat" });
  assert.equal(parseCustomModelKey("gpt-5"), null);
  assert.equal(parseCustomModelKey("conn-abcd1234:has space"), null);
  // Within the run request's 100-character model field.
  assert.ok(customModelKey("conn-abcd1234", "m".repeat(80)).length <= 100);
});

test("a save request is checked field by field and comes back normalized", () => {
  const parsed = parseCustomConnectionSave({
    name: " OpenRouter ",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1/",
    models: [{ id: "deepseek/deepseek-chat", displayName: "DeepSeek", images: false, efforts: [], contextWindow: 64_000 }],
    apiKey: " sk-or-123 ",
  });
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.save : undefined, {
    name: "OpenRouter",
    format: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [{ id: "deepseek/deepseek-chat", displayName: "DeepSeek", images: false, efforts: [], contextWindow: 64_000 }],
    apiKey: "sk-or-123",
  });

  const base = { name: "Local", format: "openai", baseUrl: "http://localhost:11434/v1", models: [] };
  assert.equal(parseCustomConnectionSave({ ...base, apiKey: null }).ok, true, "null removes the key");
  assert.equal(parseCustomConnectionSave(base).ok, true, "absent keeps the key");
  const tooSmall = parseCustomConnectionSave({
    ...base, models: [{ id: "tiny", displayName: "Tiny", images: false, efforts: [], contextWindow: 4_096 }],
  });
  assert.match(tooSmall.ok ? "" : tooSmall.message, /context window of at least 16,000/);
  const duplicate = parseCustomConnectionSave({
    ...base,
    models: [
      { id: "a", displayName: "A", images: false, efforts: [] },
      { id: "a", displayName: "A again", images: false, efforts: [] },
    ],
  });
  assert.match(duplicate.ok ? "" : duplicate.message, /only be added once/);
  assert.equal(parseCustomConnectionSave({ ...base, format: "gemini" }).ok, false);
  assert.equal(parseCustomConnectionSave({ ...base, apiKey: "has a space" }).ok, false);
  assert.equal(parseCustomConnectionSave({ ...base, extra: true }).ok, false);
});

test("the renderer's view says whether a key is saved and never carries one", () => {
  const view = {
    id: "conn-abcd1234", name: "OpenAI", format: "openai", baseUrl: "https://api.openai.com/v1", models: [], hasKey: true,
  };
  assert.equal(isCustomConnectionView(view), true);
  assert.equal(isCustomConnectionView({ ...view, apiKey: "sk-live" }), false);
  assert.equal(isCustomConnectionView({ ...view, hasKey: undefined }), false);
});

test("a model's efforts are known levels, each once, lowest first", () => {
  assert.equal(isCustomReasoningEffortList([]), true);
  assert.equal(isCustomReasoningEffortList(["none", "minimal", "low", "medium", "high", "xhigh", "max"]), true);
  assert.equal(isCustomReasoningEffortList(["high", "low"]), false, "out of order");
  assert.equal(isCustomReasoningEffortList(["low", "low"]), false, "repeated");
  assert.equal(isCustomReasoningEffortList(["ultra"]), false, "not a level an endpoint takes");
  assert.equal(isCustomReasoningEffortList("low"), false);

  const save = parseCustomConnectionSave({
    name: "Anthropic", format: "anthropic", baseUrl: "https://api.anthropic.com/v1",
    models: [{ id: "claude", displayName: "Claude", images: true, efforts: ["low", "medium", "high", "xhigh", "max"] }],
  });
  assert.equal(save.ok, true);
  // The flag the levels replaced is refused rather than silently dropped.
  assert.equal(parseCustomConnectionSave({
    name: "Old", format: "openai", baseUrl: "https://x.example/v1",
    models: [{ id: "m", displayName: "M", images: true, reasoning: true }],
  }).ok, false);

  assert.equal(defaultCustomReasoningEffort([]), undefined);
  assert.equal(defaultCustomReasoningEffort(["low", "medium", "max"]), "medium");
  assert.equal(defaultCustomReasoningEffort(["minimal", "high"]), "high");
  assert.equal(defaultCustomReasoningEffort(["low", "high"]), "low");
});
