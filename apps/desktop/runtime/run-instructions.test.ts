import assert from "node:assert/strict";
import test from "node:test";
import { runDeveloperInstructions, USER_LINKS, WEB_SEARCH_OFF, WEB_SEARCH_ON } from "./run-instructions";

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

test("the run settings say a link the user gave can be opened, whether web search is on or off", () => {
  for (const webSearch of [false, true]) {
    const settings = runDeveloperInstructions("BASE", false, webSearch);
    const block = settings.slice(settings.indexOf("<run-settings>"), settings.indexOf("</run-settings>"));
    assert.ok(block.includes(USER_LINKS));
  }
  assert.match(USER_LINKS, /open_link/);
  assert.match(WEB_SEARCH_OFF, /other than a link the user gave/);
});
