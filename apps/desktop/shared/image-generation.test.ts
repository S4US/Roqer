import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultBackground, defaultImageBaseUrl, defaultImageModel, defaultSize, imageModelPresets, imageSourceLabel, imageSourceNeedsKey, isImageSettingsResult, isImageTestResult,
  MAX_IMAGE_KEY_CHARACTERS, parseImageSettingsSave,
} from "./image-generation";

test("each kind of image has the background and size the guidance expects", () => {
  assert.equal(defaultBackground("light"), "black");
  assert.equal(defaultBackground("matter"), "transparent");
  assert.equal(defaultBackground("icon"), "transparent");
  assert.equal(defaultBackground("decal"), "opaque");
  assert.equal(defaultBackground("tile"), "opaque");
  assert.equal(defaultSize("icon"), "512x512");
  assert.equal(defaultSize("light"), "1024x1024");
});

test("a save from the window is checked field by field and refused whole on one bad field", () => {
  assert.deepEqual(parseImageSettingsSave({ enabled: true, source: "openai-compatible", baseUrl: " http://localhost:8000/v1 ", model: "flux", apiKey: "k", quality: "high" }), {
    save: { enabled: true, source: "openai-compatible", baseUrl: "http://localhost:8000/v1", model: "flux", apiKey: "k", quality: "high" },
  });
  assert.deepEqual(parseImageSettingsSave({ apiKey: null }), { save: { apiKey: null } });
  assert.deepEqual(parseImageSettingsSave({}), { save: {} });
  for (const bad of [null, [], { enabled: "yes" }, { source: "dalle" }, { quality: "ultra" }, { model: 5 }, { apiKey: "x".repeat(MAX_IMAGE_KEY_CHARACTERS + 1) }, { baseUrl: 7 }]) {
    const parsed = parseImageSettingsSave(bad);
    assert.ok("message" in parsed, `${JSON.stringify(bad)} is refused`);
  }
});

test("the results the window accepts are checked for shape", () => {
  const settings = {
    enabled: true, source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", accountId: "", hasKey: true,
    quality: "medium", state: "ready", message: "On.",
  };
  assert.equal(isImageSettingsResult({ ok: true, settings }), true);
  assert.equal(isImageSettingsResult({ ok: true, settings: { ...settings, accountId: undefined } }), false);
  assert.equal(isImageSettingsResult({ ok: true, settings: { ...settings, state: "broken" } }), false);
  assert.equal(isImageSettingsResult({ ok: false, message: "no" }), true);
  assert.equal(isImageSettingsResult({ ok: false }), false);
  assert.equal(isImageTestResult({ ok: true, message: "fine" }), true);
  assert.equal(isImageTestResult({ ok: "yes", message: "fine" }), false);
});

test("each source has its own address and model unless the user names one, and says whether it needs a key", () => {
  assert.equal(defaultImageBaseUrl("openai"), "https://api.openai.com/v1");
  assert.equal(defaultImageBaseUrl("openrouter"), "https://openrouter.ai/api/v1");
  assert.equal(defaultImageBaseUrl("google"), "https://generativelanguage.googleapis.com/v1beta");
  assert.equal(defaultImageBaseUrl("cloudflare"), "https://api.cloudflare.com/client/v4/accounts");
  assert.equal(defaultImageBaseUrl("openai-compatible"), undefined);
  assert.equal(defaultImageModel("openrouter"), "openai/gpt-image-1");
  assert.equal(defaultImageModel("google"), "gemini-2.5-flash-image");
  assert.equal(defaultImageModel("cloudflare"), "@cf/black-forest-labs/flux-2-klein-4b");
  assert.equal(defaultImageModel("openai-compatible"), undefined);
  assert.equal(imageSourceNeedsKey("openai"), true);
  assert.equal(imageSourceNeedsKey("openrouter"), true);
  assert.equal(imageSourceNeedsKey("google"), true);
  assert.equal(imageSourceNeedsKey("cloudflare"), true);
  assert.equal(imageSourceNeedsKey("openai-compatible"), false);
  assert.equal(imageSourceLabel("openrouter"), "OpenRouter");
  assert.equal(imageSourceLabel("google"), "Google");
  assert.equal(imageSourceLabel("cloudflare"), "Cloudflare");
  assert.deepEqual(parseImageSettingsSave({ source: "openrouter" }), { save: { source: "openrouter" } });
  assert.deepEqual(parseImageSettingsSave({ source: "google" }), { save: { source: "google" } });
  assert.deepEqual(parseImageSettingsSave({ source: "cloudflare" }), { save: { source: "cloudflare" } });
});

test("Cloudflare saves an account id beside the source, and a bad one is refused", () => {
  assert.deepEqual(parseImageSettingsSave({ source: "cloudflare", accountId: " 023e105f4ecef8ad9ca31a8372d0c353 " }), {
    save: { source: "cloudflare", accountId: "023e105f4ecef8ad9ca31a8372d0c353" },
  });
  assert.deepEqual(parseImageSettingsSave({ accountId: "" }), { save: { accountId: "" } });
  for (const bad of [{ accountId: 7 }, { accountId: "has space" }, { accountId: "x".repeat(65) }]) {
    assert.ok("message" in parseImageSettingsSave(bad), `${JSON.stringify(bad)} is refused`);
  }
});

test("Cloudflare offers game-asset models to start from", () => {
  const presets = imageModelPresets("cloudflare");
  assert.deepEqual(presets.map((preset) => preset.id), [
    "@cf/black-forest-labs/flux-2-klein-4b",
    "@cf/black-forest-labs/flux-2-klein-9b",
    "@cf/black-forest-labs/flux-2-dev",
    "@cf/leonardo/lucid-origin",
    "@cf/leonardo/phoenix-1.0",
    "@cf/black-forest-labs/flux-1-schnell",
  ]);
  assert.equal(presets[0].id, defaultImageModel("cloudflare"));
  assert.deepEqual(imageModelPresets("openai"), []);
  assert.deepEqual(imageModelPresets("openai-compatible"), []);
});
