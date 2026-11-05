import assert from "node:assert/strict";
import test from "node:test";
import {
  defaultBackground, defaultSize, isImageSettingsResult, isImageTestResult, MAX_IMAGE_KEY_CHARACTERS, parseImageSettingsSave,
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
  const settings = { enabled: true, source: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-image-1", hasKey: true, quality: "medium", state: "ready", message: "On." };
  assert.equal(isImageSettingsResult({ ok: true, settings }), true);
  assert.equal(isImageSettingsResult({ ok: true, settings: { ...settings, state: "broken" } }), false);
  assert.equal(isImageSettingsResult({ ok: false, message: "no" }), true);
  assert.equal(isImageSettingsResult({ ok: false }), false);
  assert.equal(isImageTestResult({ ok: true, message: "fine" }), true);
  assert.equal(isImageTestResult({ ok: "yes", message: "fine" }), false);
});
