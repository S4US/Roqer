import assert from "node:assert/strict";
import test from "node:test";

import {
  blockPreview, characterCount, composedMessage, isLongPaste, lineCount, LONG_PASTE_CHARACTERS, LONG_PASTE_LINES, textSize,
} from "./composer-text";

test("a paste is folded only once it is long by characters or by lines", () => {
  assert.equal(isLongPaste("Make the kart drift harder."), false);
  assert.equal(isLongPaste("x".repeat(LONG_PASTE_CHARACTERS)), true);
  assert.equal(isLongPaste("x".repeat(LONG_PASTE_CHARACTERS - 1)), false);
  assert.equal(isLongPaste(Array.from({ length: LONG_PASTE_LINES }, () => "a").join("\n")), true);
  assert.equal(isLongPaste(Array.from({ length: LONG_PASTE_LINES - 1 }, () => "a").join("\n")), false);
});

test("what is sent is every block in the order shown, then what was typed, and nothing else", () => {
  const spec = "Shop screen\n\nTabs: Featured, Karts, Boosts.";
  assert.equal(
    composedMessage([{ id: "a", text: spec }, { id: "b", text: "  Second paste\n" }], "Build the shop from this spec."),
    `${spec}\n\nSecond paste\n\nBuild the shop from this spec.`,
  );
  // A block alone is a whole message; an empty composer is none.
  assert.equal(composedMessage([{ id: "a", text: spec }], "   "), spec);
  assert.equal(composedMessage([], "  "), "");
  // The inside of a block is never touched.
  assert.equal(composedMessage([{ id: "a", text: "a\n\n\n\nb" }], ""), "a\n\n\n\nb");
});

test("a block says how big it is and what it starts with", () => {
  assert.equal(lineCount(""), 0);
  assert.equal(lineCount("one\r\ntwo\nthree"), 3);
  assert.equal(textSize("one\ntwo"), "2 lines · 7 characters");
  assert.equal(textSize("x"), "1 line · 1 character");
  assert.equal(blockPreview("\n\n  Shop screen: currencies  \nmore"), "Shop screen: currencies");
  assert.equal(blockPreview("x".repeat(200), 10), `${"x".repeat(9)}…`);
});

test("a long message's size reads compactly", () => {
  assert.equal(characterCount(1), "1 character");
  assert.equal(characterCount(940), "940 characters");
  assert.equal(characterCount(9_431), "9.4k characters");
  assert.equal(characterCount(12_000), "12k characters");
});
