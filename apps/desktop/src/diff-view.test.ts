import assert from "node:assert/strict";
import test from "node:test";
import type { RunChange } from "../shared/run-events";
import {
  groupChangesByTarget, highlightRows, parseDiffRows, sourceRows, splitChangeGroup,
  tokenizeCodeLine, type SyntaxToken,
} from "./diff-view";

/** The tokens that carry meaning, without whitespace or punctuation. */
const named = (tokens: SyntaxToken[]): Array<[string, string]> => tokens
  .filter((token) => token.text.trim().length > 0 && token.kind !== "operator")
  .map((token) => [token.text, token.kind]);

test("compact context markers preserve old and new file line numbers", () => {
  const rows = parseDiffRows([
    "@@ 2 unchanged lines @@",
    " keep",
    "-old",
    "+new",
    " tail",
  ].join("\n"));

  assert.deepEqual(rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })), [
    { kind: "collapse", oldLine: null, newLine: null },
    { kind: "context", oldLine: 3, newLine: 3 },
    { kind: "remove", oldLine: 4, newLine: null },
    { kind: "add", oldLine: null, newLine: 4 },
    { kind: "context", oldLine: 5, newLine: 5 },
  ]);
});

test("separate old and new coordinates stay honest across folded hunks", () => {
  const rows = parseDiffRows([
    "@@ 9 unchanged lines @@",
    "-old one",
    "+new one",
    "+new two",
    " context",
    "@@ 12 unchanged lines @@",
    "-tail",
  ].join("\n"), 30, 40);

  assert.deepEqual(rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine })), [
    { kind: "collapse", oldLine: null, newLine: null },
    { kind: "remove", oldLine: 39, newLine: null },
    { kind: "add", oldLine: null, newLine: 49 },
    { kind: "add", oldLine: null, newLine: 50 },
    { kind: "context", oldLine: 40, newLine: 51 },
    { kind: "collapse", oldLine: null, newLine: null },
    { kind: "remove", oldLine: 53, newLine: null },
  ]);
});

test("new source is presented as numbered additions", () => {
  assert.deepEqual(sourceRows("local x = 1\nreturn x", 42).map((row) => [row.marker, row.oldLine, row.newLine]), [
    ["+", null, 42],
    ["+", null, 43],
  ]);
});

test("source shown because the old version was never read claims no additions", () => {
  assert.deepEqual(sourceRows("local x = 1\nreturn x", 1, false).map((row) => [row.kind, row.marker]), [
    ["context", " "],
    ["context", " "],
  ]);
});

test("Luau highlighting distinguishes syntax without changing source text", () => {
  const source = "local value = math.max(12, 'ok') -- clamp";
  const tokens = tokenizeCodeLine(source, "lua");
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(named(tokens), [
    ["local", "keyword"], ["value", "plain"], ["math", "builtin"], ["max", "call"],
    ["12", "number"], ["'ok'", "string"], ["-- clamp", "comment"],
  ]);
  assert.equal(tokenizeCodeLine("local message = `Hello {script.Name}`", "luau").map((token) => token.text).join(""), "local message = `Hello {script.Name}`");
  assert.deepEqual(tokenizeCodeLine("const value = 1", "typescript"), [{ kind: "plain", text: "const value = 1" }]);
});

test("a name is read from its position: member, call, or global", () => {
  const source = "fireball.CFrame = script.Parent:FindFirstChild(\"Hit\")";
  const tokens = tokenizeCodeLine(source, "luau");
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(named(tokens), [
    ["fireball", "plain"], ["CFrame", "property"], ["script", "builtin"], ["Parent", "property"],
    ["FindFirstChild", "call"], ["\"Hit\"", "string"],
  ]);
});

test("a comment marker inside a string is not a comment", () => {
  const source = "local url = \"https://a--b\" -- real one";
  const tokens = tokenizeCodeLine(source, "lua");
  assert.equal(tokens.map((token) => token.text).join(""), source);
  assert.deepEqual(named(tokens), [
    ["local", "keyword"], ["url", "plain"], ["\"https://a--b\"", "string"], ["-- real one", "comment"],
  ]);
});

test("a long comment keeps its colour across the lines it spans", () => {
  const rows = parseDiffRows([
    " --[==[ notes",
    " local x = 1",
    " still inside ]==]",
    " local y = 2",
  ].join("\n"));
  const tokens = highlightRows(rows, "luau");

  assert.deepEqual(tokens.map((line) => line[0].kind), ["comment", "comment", "comment", "keyword"]);
});

test("a block one side of the diff opened does not bleed into the other side", () => {
  const rows = parseDiffRows([
    "-local note = [[old",
    "+local note = \"new\"",
    " return note",
  ].join("\n"));
  const tokens = highlightRows(rows, "luau");

  // The removed line leaves a long string open on the old side only.
  assert.equal(tokens[0][tokens[0].length - 1].kind, "string");
  assert.equal(tokens[1][0].kind, "keyword");
  assert.equal(tokens[2][0].kind, "keyword");
});

test("a fold row carries the span it stands in for", () => {
  const rows = parseDiffRows(["@@ 12 unchanged lines @@", " keep", "+new"].join("\n"));

  assert.deepEqual(rows[0].hidden, { lines: 12, oldFrom: 1, oldTo: 12, newFrom: 1, newTo: 12 });
  assert.equal(rows[1].oldLine, 13);
  assert.equal(highlightRows(rows, "luau")[0].length, 0);
});

test("repeated edits to one path produce one editor panel", () => {
  const change = (id: string, target: string, addedLines: number, removedLines: number): RunChange => ({
    id,
    kind: "script-source",
    target,
    summary: "Updated source",
    addedLines,
    removedLines,
  });
  const groups = groupChangesByTarget([
    change("c1", "game.ServerScriptService.Main", 1, 1),
    change("c2", "game.ServerScriptService.Main", 2, 0),
    change("c3", "game.ReplicatedStorage.Shared", 0, 1),
  ]);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.changes.map((item) => item.id)), [["c1", "c2"], ["c3"]]);

  // The panel leads with the write that left the file as it now stands; the
  // rest are folded in behind it rather than stacked underneath it.
  const [main, shared] = groups.map(splitChangeGroup);
  assert.equal(main.latest?.id, "c2");
  assert.deepEqual(main.earlier.map((item) => item.id), ["c1"]);
  assert.equal(shared.latest?.id, "c3");
  assert.deepEqual(shared.earlier, []);
});
