import assert from "node:assert/strict";
import test from "node:test";

import type { ProviderModelCatalog } from "../shared/provider";
import { getProviderModels, getProviderStatus, logoutProvider } from "./platform";

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
    logout: async () => ({ ok: true as const, message: `${provider} signed out` }),
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

test("signing out reaches the named provider's own connector, and needs the desktop app", async () => {
  const previousWindow = globalThis.window;
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { workbenchDesktop: { providers: { chatGpt: providerConnector("chatgpt"), claude: providerConnector("claude") } } },
    });
    assert.deepEqual(await logoutProvider("claude"), { ok: true, message: "claude signed out" });
    assert.deepEqual(await logoutProvider("chatgpt"), { ok: true, message: "chatgpt signed out" });

    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    assert.equal((await logoutProvider("claude")).ok, false);
  } finally {
    Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
  }
});
