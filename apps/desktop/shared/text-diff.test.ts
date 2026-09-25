import assert from "node:assert/strict";
import test from "node:test";

import { boundedCode, diffText } from "./text-diff";

/** The lines a diff actually changed, without the surrounding context. */
function changedLines(text: string): string[] {
  return text.split("\n").filter((line) => line.startsWith("+") || line.startsWith("-"));
}

test("identical files produce no diff at all", () => {
  assert.equal(diffText("local x = 1\n", "local x = 1\n"), null);
});

test("one changed line is one removal and one addition", () => {
  const diff = diffText("local a = 1\nlocal b = 2\n", "local a = 1\nlocal b = 3\n");
  assert.ok(diff);
  assert.deepEqual(changedLines(diff.text), ["-local b = 2", "+local b = 3"]);
  assert.equal(diff.addedLines, 1);
  assert.equal(diff.removedLines, 1);
  assert.equal(diff.truncated, false);
});

test("an inserted line is an addition with no removal", () => {
  const diff = diffText("a\nb", "a\nnew\nb");
  assert.ok(diff);
  assert.deepEqual(changedLines(diff.text), ["+new"]);
  assert.equal(diff.addedLines, 1);
  assert.equal(diff.removedLines, 0);
});

test("context lines keep their leading space so a marker is never ambiguous", () => {
  const diff = diffText("keep\ndrop", "keep");
  assert.ok(diff);
  assert.equal(diff.text, " keep\n-drop");
});

test("a line that itself starts with a minus is still marked, not mistaken", () => {
  const diff = diffText("x = 1", "-- disabled\nx = 1");
  assert.ok(diff);
  // The added comment carries the add marker; its own leading dashes follow it.
  assert.deepEqual(changedLines(diff.text), ["+-- disabled"]);
});

test("unchanged runs far from any change are elided rather than shown", () => {
  const before = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
  const after = before.replace("line 20", "line 20 changed");
  const diff = diffText(before, after);
  assert.ok(diff);
  assert.match(diff.text, /@@ \d+ unchanged lines @@/);
  // Three lines of context each side of the one change, and nothing else.
  assert.ok(diff.text.split("\n").length < 15, diff.text);
});

/** Every line the old file had is either shown or accounted for by a fold. */
function accountsForEveryLine(text: string, oldLineCount: number): boolean {
  const rows = text.split("\n");
  const folded = [...text.matchAll(/@@ (\d+) unchanged lines? @@/g)]
    .reduce((total, match) => total + Number(match[1]), 0);
  const shown = rows.filter((row) => row.startsWith(" ") || row.startsWith("-")).length;
  return folded + shown === oldLineCount;
}

const numbered = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `local line${index} = ${index}`);

test("a one-line replacement is shown inside the code around it", () => {
  const before = numbered(5);
  const after = [...before];
  after[2] = "local line2 = 30";
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  // Context either side, so the change reads as part of a file, not as a pair
  // of coloured lines.
  assert.deepEqual(diff.text.split("\n"), [
    " local line0 = 0",
    " local line1 = 1",
    "-local line2 = 2",
    "+local line2 = 30",
    " local line3 = 3",
    " local line4 = 4",
  ]);
});

test("a multi-line insertion stays one hunk with context on both sides", () => {
  const before = numbered(8);
  const after = [...before.slice(0, 4), "-- new", "local added = true", "return added", ...before.slice(4)];
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  assert.deepEqual(changedLines(diff.text), ["+-- new", "+local added = true", "+return added"]);
  assert.equal(diff.addedLines, 3);
  assert.equal(diff.removedLines, 0);
  assert.ok(!diff.text.includes("@@"), diff.text);
  assert.ok(accountsForEveryLine(diff.text, 8), diff.text);
});

test("a multi-line deletion stays one hunk with context on both sides", () => {
  const before = numbered(8);
  const after = [...before.slice(0, 3), ...before.slice(6)];
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  assert.deepEqual(changedLines(diff.text), ["-local line3 = 3", "-local line4 = 4", "-local line5 = 5"]);
  assert.equal(diff.removedLines, 3);
  assert.ok(accountsForEveryLine(diff.text, 8), diff.text);
});

test("two edits far apart become two hunks with the file between them folded", () => {
  const before = numbered(60);
  const after = [...before];
  after[5] = "local line5 = 500";
  after[50] = "local line50 = 5000";
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  const folds = [...diff.text.matchAll(/@@ (\d+) unchanged lines? @@/g)];
  assert.equal(folds.length, 2);
  // Both edits keep their own context, and each survives as its own hunk.
  assert.deepEqual(changedLines(diff.text), [
    "-local line5 = 5", "+local line5 = 500",
    "-local line50 = 50", "+local line50 = 5000",
  ]);
  // The first five lines are too few to be worth hiding, so they are shown.
  assert.equal(diff.text.split("\n")[0], " local line0 = 0");
  assert.ok(accountsForEveryLine(diff.text, 60), diff.text);
});

test("a gap too short to be worth folding is shown rather than announced", () => {
  const before = numbered(20);
  const after = [...before];
  after[3] = "local line3 = 300";
  after[12] = "local line12 = 1200";
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  assert.ok(!diff.text.includes("@@"), diff.text);
  assert.ok(accountsForEveryLine(diff.text, 20), diff.text);
});

test("a large file keeps only the edited regions, and the folds account for the rest", () => {
  const before = numbered(300);
  const after = [...before];
  after[150] = "local line150 = 15000";
  const diff = diffText(before.join("\n"), after.join("\n"));
  assert.ok(diff);
  assert.equal(diff.truncated, false);
  const rows = diff.text.split("\n");
  assert.equal(rows.length, 10);
  assert.deepEqual([rows[0], rows[rows.length - 1]], ["@@ 147 unchanged lines @@", "@@ 146 unchanged lines @@"]);
  assert.ok(accountsForEveryLine(diff.text, 300), diff.text);
});

test("a long diff is cut off and says so", () => {
  const before = Array.from({ length: 60 }, (_, index) => `old ${index}`).join("\n");
  const after = Array.from({ length: 60 }, (_, index) => `new ${index}`).join("\n");
  const diff = diffText(before, after, 10);
  assert.ok(diff);
  assert.equal(diff.truncated, true);
  assert.match(diff.text, /@@ diff truncated @@$/);
  assert.equal(diff.text.split("\n").length, 11);
});

test("a file too long to diff is refused rather than diffed slowly", () => {
  const before = Array.from({ length: 1_500 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(diffText(before, `${before}\nextra`), null);
});

test("an empty file gaining content is all additions", () => {
  const diff = diffText("", "print('hi')");
  assert.ok(diff);
  assert.deepEqual(changedLines(diff.text), ["-", "+print('hi')"]);
});

test("boundedCode leaves a short file exactly as it was", () => {
  const source = "local x = 1\nreturn x";
  assert.deepEqual(boundedCode(source), { code: source, truncated: false });
});

test("boundedCode cuts a long file and reports that it did", () => {
  const source = Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n");
  const bounded = boundedCode(source, 10);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.code.split("\n").length, 10);
});

test("boundedCode also caps by characters, not just lines", () => {
  const bounded = boundedCode("x".repeat(500), 400, 100);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.code.length, 100);
});
