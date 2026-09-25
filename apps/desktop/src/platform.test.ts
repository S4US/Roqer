import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModelCatalog } from "../shared/provider";
import { getProviderModels, getProviderStatus } from "./platform";

const CATALOGS: Record<"chatgpt" | "claude", ProviderModelCatalog> = {
  chatgpt: {
    models: [{
      id: "gpt-5.6-luna",
      displayName: "GPT 5.6 Luna",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    }],
    defaultModelId: "gpt-5.6-luna",
  },
  claude: {
    models: [{
      id: "opus",
      displayName: "Claude Opus",
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
    }],
    defaultModelId: "opus",
  },
};

function providerConnector(provider: keyof typeof CATALOGS) {
  return {
    status: async () => ({ kind: "signed-in" as const, message: `${provider} signed in` }),
    login: async () => ({ ok: true as const, message: `${provider} signed in` }),
    submitCode: async () => ({ ok: true as const, message: `${provider} signed in` }),
    models: async () => CATALOGS[provider],
  };
}

test("each provider reads its own catalog rather than the ChatGPT one", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      workbenchDesktop: {
        providers: {
          chatGpt: providerConnector("chatgpt"),
          claude: providerConnector("claude"),
        },
      },
    },
  });

  try {
    const status = await getProviderStatus("claude");
    const catalog = await getProviderModels("claude");
    assert.equal(status.message, "claude signed in");
    assert.equal(catalog.defaultModelId, "opus");
    assert.deepEqual(catalog.models.map((model) => model.id), ["opus"]);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
