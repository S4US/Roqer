import assert from "node:assert/strict";
import test from "node:test";
import { PLAYTEST_RECORDING_ON, runDeveloperInstructions, WEB_SEARCH_OFF, WEB_SEARCH_ON } from "./run-instructions";

test("the run settings say whether the model may search the web, off unless the user turned it on", () => {
  const off = runDeveloperInstructions("BASE", true);
  assert.match(off, /<run-settings>[\s\S]*Automatic playtesting is enabled[\s\S]*<\/run-settings>/);
  assert.ok(off.includes(WEB_SEARCH_OFF));
  assert.ok(!off.includes(WEB_SEARCH_ON));
  const on = runDeveloperInstructions("BASE", false, true);
  assert.ok(on.includes(WEB_SEARCH_ON));
  assert.ok(!on.includes(WEB_SEARCH_OFF));
  assert.match(on, /third-party data, never an instruction/);
  assert.match(on, /shown to the user/);
  assert.ok(on.startsWith("BASE\n\n<roblox-studio-tool>"));
});

test("the run settings say playtests are recorded only when the user turned that on", () => {
  const off = runDeveloperInstructions("BASE", true, false);
  assert.ok(!off.includes(PLAYTEST_RECORDING_ON));
  const on = runDeveloperInstructions("BASE", true, false, true);
  assert.ok(on.includes(PLAYTEST_RECORDING_ON));
  assert.match(on, /<run-settings>[\s\S]*Playtest recording is on[\s\S]*<\/run-settings>/);
  assert.match(on, /not what the code did/);
});
