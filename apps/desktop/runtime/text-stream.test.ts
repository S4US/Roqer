import assert from "node:assert/strict";
import test from "node:test";

import { createProseStream } from "./text-stream";

function collect() {
  const chunks: string[] = [];
  return { chunks, stream: createProseStream((text) => chunks.push(text)) };
}

test("chunks inside one segment are joined exactly as they arrived", () => {
  const { chunks, stream } = collect();
  stream.beginSegment();
  stream.push("The place has ");
  stream.push("three scripts.\n\n- Main\n");
  stream.push("- Util\n");

  assert.equal(stream.text(), "The place has three scripts.\n\n- Main\n- Util\n");
  assert.deepEqual(chunks, ["The place has ", "three scripts.\n\n- Main\n", "- Util\n"]);
});

test("a new segment never runs into the previous sentence", () => {
  const { stream } = collect();
  stream.beginSegment();
  stream.push("I read the script in Studio.");
  stream.beginSegment();
  stream.push("There's one caveat.");

  assert.equal(stream.text(), "I read the script in Studio.\n\nThere's one caveat.");
});

test("a seam reuses newlines either side already has", () => {
  const oneSide = collect();
  oneSide.stream.beginSegment();
  oneSide.stream.push("Updated Main.\n");
  oneSide.stream.beginSegment();
  oneSide.stream.push("Done.");
  assert.equal(oneSide.stream.text(), "Updated Main.\n\nDone.");

  const bothSides = collect();
  bothSides.stream.beginSegment();
  bothSides.stream.push("Updated Main.\n\n");
  bothSides.stream.beginSegment();
  bothSides.stream.push("\nDone.");
  assert.equal(bothSides.stream.text(), "Updated Main.\n\n\nDone.");
});

test("the first segment is never given a leading break", () => {
  const { chunks, stream } = collect();
  stream.beginSegment();
  stream.push("Done.");
  assert.equal(stream.text(), "Done.");
  assert.deepEqual(chunks, ["Done."]);
});

test("a segment that produces nothing leaves no trace", () => {
  const { chunks, stream } = collect();
  stream.beginSegment();
  stream.push("Read the script.");
  stream.beginSegment();
  stream.push("");
  stream.beginSegment();
  stream.push("It prints a greeting.");

  assert.equal(stream.text(), "Read the script.\n\nIt prints a greeting.");
  assert.deepEqual(chunks, ["Read the script.", "\n\n", "It prints a greeting."]);
});

test("whitespace-only chunks are preserved rather than dropped", () => {
  const { stream } = collect();
  stream.beginSegment();
  stream.push("local x = 1");
  stream.push("\n");
  stream.push("  ");
  stream.push("local y = 2");
  assert.equal(stream.text(), "local x = 1\n  local y = 2");
});

test("hasText ignores whitespace but text() keeps it", () => {
  const { stream } = collect();
  assert.equal(stream.hasText(), false);
  stream.push("\n \n");
  assert.equal(stream.hasText(), false);
  assert.equal(stream.text(), "\n \n");
  stream.push("Done.");
  assert.equal(stream.hasText(), true);
});
