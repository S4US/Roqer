import assert from "node:assert/strict";
import test from "node:test";
import type { McpToolOutcome } from "./mcp-types";
import { MAX_DETAIL_CHARS, MAX_SUMMARY_CHARS, compactValue, summarizeToolOutcome } from "./result-summary";

function outcome(partial: Partial<McpToolOutcome>): McpToolOutcome {
  return {
    ok: true,
    data: undefined,
    text: "",
    httpStatus: 200,
    durationMs: 1,
    ...partial,
  };
}

test("compactValue truncates long output with an elision note", () => {
  // Deliberately not base64-alphabet-only (spaces, punctuation) so this
  // exercises truncation rather than the binary-blob replacement.
  const long = "The quick brown fox jumps over the lazy dog. ".repeat(50);
  const rendered = compactValue(long, 200);
  assert.ok(rendered.length <= 200, `expected <= 200 chars, got ${rendered.length}`);
  assert.match(rendered, /… \(\+\d+ more characters\)$/);
  assert.ok(rendered.startsWith('"The quick brown fox'));
});

test("compactValue leaves short values untouched", () => {
  assert.equal(compactValue({ a: 1 }), JSON.stringify({ a: 1 }));
});

test("compactValue elides arrays longer than 10 entries", () => {
  const items = Array.from({ length: 15 }, (_, i) => i);
  const rendered = compactValue(items, MAX_DETAIL_CHARS);
  const parsed = JSON.parse(rendered) as unknown[];
  assert.equal(parsed.length, 11);
  assert.deepEqual(parsed.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.equal(parsed[10], "… (5 more)");
});

test("compactValue keeps every array entry when asked to", () => {
  const items = Array.from({ length: 15 }, (_, i) => i);
  const rendered = compactValue(items, MAX_DETAIL_CHARS, { maxArrayEntries: Infinity });
  assert.deepEqual(JSON.parse(rendered), items);
});

test("compactValue replaces base64-looking blobs with a byte count placeholder", () => {
  // 400 'A' characters is valid base64 alphabet and a multiple of 4.
  const blob = "A".repeat(400);
  const rendered = compactValue({ image: blob }, MAX_DETAIL_CHARS);
  assert.ok(!rendered.includes(blob), "raw blob must not appear in the rendered output");
  assert.match(rendered, /<binary, \d+ bytes>/);
});

test("compactValue leaves short base64-shaped strings alone", () => {
  const short = "QUJDRA=="; // "ABCD" base64, well under the threshold
  const rendered = compactValue({ token: short }, MAX_DETAIL_CHARS);
  assert.ok(rendered.includes(short));
});

test("summarizeToolOutcome reports the error code and message on failure", () => {
  const result = summarizeToolOutcome("set_script_source", outcome({
    ok: false,
    httpStatus: 200,
    errorCode: "source_revision_conflict",
    message: "Source changed since it was last read.",
    data: { success: false, errorCode: "source_revision_conflict", expectedRevision: "a", actualRevision: "b" },
  }));
  assert.match(result.summary, /set_script_source/);
  assert.match(result.summary, /source_revision_conflict/);
  assert.match(result.summary, /Source changed since it was last read\./);
  assert.ok(result.summary.length <= MAX_SUMMARY_CHARS);
  assert.ok(result.detail && result.detail.includes("expectedRevision"));
});

test("summarizeToolOutcome highlights instance counts", () => {
  const result = summarizeToolOutcome("get_connected_instances", outcome({
    data: { instanceCount: 3, instances: [{ instanceId: "a" }, { instanceId: "b" }, { instanceId: "c" }] },
  }));
  assert.equal(result.summary, "get_connected_instances: 3 instances");
});

test("summarizeToolOutcome keeps the revision fingerprint out of the one-line summary", () => {
  const result = summarizeToolOutcome("get_script_source", outcome({
    data: { source: "print('hi')\nprint('there')", sourceRevision: "sr1:13:abcd1234" },
  }));
  assert.equal(result.summary, "get_script_source: 2 lines of source");
  // Still auditable: the fingerprint stays in the detail the card can expand.
  assert.ok(result.detail?.includes("sr1:13:abcd1234"));
});

test("summarizeToolOutcome reports a write that returned only a revision", () => {
  const result = summarizeToolOutcome("set_script_source", outcome({
    data: { sourceRevision: "sr1:13:abcd1234" },
  }));
  assert.equal(result.summary, "set_script_source: source revision recorded");
});

test("summarizeToolOutcome highlights a results array length", () => {
  const result = summarizeToolOutcome("search_objects", outcome({
    data: { results: [1, 2, 3, 4] },
  }));
  assert.equal(result.summary, "search_objects: 4 results");
});

test("summarizeToolOutcome highlights a summary total/succeeded/failed shape", () => {
  const result = summarizeToolOutcome("find_and_replace_in_scripts", outcome({
    data: { summary: { total: 10, succeeded: 9, failed: 1 } },
  }));
  assert.equal(result.summary, "find_and_replace_in_scripts: total 10, succeeded 9, failed 1");
});

test("summarizeToolOutcome falls back to a compacted rendering for unknown shapes", () => {
  const result = summarizeToolOutcome("get_place_info", outcome({
    data: { placeId: 123, placeName: "Test Place" },
  }));
  assert.match(result.summary, /^get_place_info: /);
  assert.match(result.summary, /placeId/);
});

test("summarizeToolOutcome handles success with no data", () => {
  const result = summarizeToolOutcome("solo_playtest", outcome({ data: undefined }));
  assert.equal(result.summary, "solo_playtest succeeded");
  assert.equal(result.detail, undefined);
});
