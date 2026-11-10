import assert from "node:assert/strict";
import test from "node:test";

import { isProjectInstructions, MAX_PROJECT_INSTRUCTIONS_CHARS, normalizeProjectInstructions } from "./project-instructions";

test("project instructions are trimmed text within the bound, and nothing else", () => {
  assert.equal(normalizeProjectInstructions("  Use Knit.\nUI goes in StarterGui/HUD.\t "), "Use Knit.\nUI goes in StarterGui/HUD.");
  assert.equal(normalizeProjectInstructions("x".repeat(MAX_PROJECT_INSTRUCTIONS_CHARS)), "x".repeat(MAX_PROJECT_INSTRUCTIONS_CHARS));
  assert.equal(normalizeProjectInstructions("x".repeat(MAX_PROJECT_INSTRUCTIONS_CHARS + 1)), null, "over the bound is refused, never cut short");
  assert.equal(normalizeProjectInstructions("   "), null);
  assert.equal(normalizeProjectInstructions("bell\u0007"), null);
  assert.equal(normalizeProjectInstructions(42), null);
  assert.equal(isProjectInstructions("Use Knit."), true);
  assert.equal(isProjectInstructions(" Use Knit."), false, "a stored value is already normalized");
  assert.equal(isProjectInstructions(""), false, "none is stored as absent, not as empty text");
});
