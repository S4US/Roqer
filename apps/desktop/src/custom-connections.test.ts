import assert from "node:assert/strict";
import test from "node:test";

import type { CustomConnectionView } from "../shared/custom-providers";
import { endpointDetail } from "./custom-connections";

const endpoint = (changes: Partial<CustomConnectionView>): CustomConnectionView => ({
  id: "conn-1",
  name: "OpenRouter",
  format: "openai",
  baseUrl: "https://openrouter.ai/api/v1",
  models: [{ id: "google/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", images: true, efforts: [] }],
  hasKey: true,
  ...changes,
});

test("an endpoint's row names its host and models, and a missing key only when one is needed", () => {
  assert.equal(endpointDetail(endpoint({})), "openrouter.ai · 1 model");
  assert.equal(endpointDetail(endpoint({ models: [] })), "openrouter.ai · no models yet");
  // A saved key is the normal state, so only its absence is said.
  assert.equal(endpointDetail(endpoint({ hasKey: false })), "openrouter.ai · 1 model · no key");
  // A server on this computer takes no key, so its absence is not a problem.
  assert.equal(endpointDetail(endpoint({ hasKey: false, baseUrl: "http://localhost:11434/v1" })), "localhost:11434 · 1 model");
});
